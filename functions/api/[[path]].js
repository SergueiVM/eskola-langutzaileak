const SESSION_COOKIE = 'eskola_session';
const SESSION_SECONDS = 60 * 60 * 24 * 7;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

function isSameOrigin(request) {
  return request.headers.get('Origin') === new URL(request.url).origin;
}

function cookieValue(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const item = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(name + '='));
  return item ? item.slice(name.length + 1) : '';
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signSession(payload, secret) {
  const data = base64url(new TextEncoder().encode(payload));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(data));
  return data + '.' + base64url(new Uint8Array(signature));
}

async function validSession(request, secret) {
  const [data, signature, extra] = cookieValue(request, SESSION_COOKIE).split('.');
  if (!data || !signature || extra) return false;
  try {
    const payload = atob(data.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - data.length % 4) % 4));
    const expires = Number(payload.split(':', 1)[0]);
    if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return false;
    const sig = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - signature.length % 4) % 4)), c => c.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, new TextEncoder().encode(data));
  } catch {
    return false;
  }
}

async function passwordMatches(candidate, expected) {
  const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [actual, wanted] = await Promise.all([digest(candidate), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ wanted[i];
  return difference === 0;
}

async function readJson(request, maxLength = 1_000_000) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) {
    return { error: json({ error: 'Formato no válido.' }, 415) };
  }
  const text = await request.text();
  if (text.length > maxLength) return { error: json({ error: 'Los datos superan el tamaño permitido.' }, 413) };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: json({ error: 'Formato no válido.' }, 400) };
  }
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 100;
}

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !Array.isArray(state.people) || !Array.isArray(state.jornadas)) return false;
  const people = new Set();
  for (const person of state.people) {
    if (!person || !validId(person.id) || typeof person.name !== 'string' || !person.name.trim() || person.name.length > 200
      || people.has(person.id)) return false;
    people.add(person.id);
  }
  const jornadas = new Set();
  const matches = new Set();
  for (const jornada of state.jornadas) {
    if (!jornada || !validId(jornada.id) || typeof jornada.name !== 'string' || !jornada.name.trim() || jornada.name.length > 200
      || jornadas.has(jornada.id) || !Array.isArray(jornada.avail) || !Array.isArray(jornada.matches)) return false;
    jornadas.add(jornada.id);
    if (jornada.avail.some(id => !people.has(id))) return false;
    for (const match of jornada.matches) {
      if (!match || !validId(match.id) || matches.has(match.id) || typeof match.date !== 'string'
        || !/^\d{4}-\d{2}-\d{2}$/.test(match.date)
        || typeof (match.time || '') !== 'string' || typeof (match.desc || '') !== 'string') return false;
      matches.add(match.id);
      for (const role of ['ref', 'mesa']) {
        const assignment = match[role];
        if (!assignment || typeof assignment.c !== 'boolean'
          || (assignment.p && !people.has(assignment.p))) return false;
      }
    }
  }
  return true;
}

async function getState(db) {
  const [people, jornadas, availabilities, matches, assignments] = await db.batch([
    db.prepare('SELECT id, name FROM people ORDER BY rowid'),
    db.prepare('SELECT id, name FROM jornadas ORDER BY rowid'),
    db.prepare('SELECT jornada_id, person_id FROM availabilities'),
    db.prepare('SELECT id, jornada_id, date, time, description FROM matches ORDER BY date, time, rowid'),
    db.prepare('SELECT match_id, role, person_id, confirmed FROM assignments'),
  ]);
  const state = {
    people: people.results.map(({ id, name }) => ({ id, name })),
    jornadas: jornadas.results.map(({ id, name }) => ({ id, name, avail: [], matches: [] })),
  };
  const jornadaById = new Map(state.jornadas.map(jornada => [jornada.id, jornada]));
  const matchById = new Map();
  for (const { jornada_id, person_id } of availabilities.results) {
    jornadaById.get(jornada_id)?.avail.push(person_id);
  }
  for (const row of matches.results) {
    const match = {
      id: row.id,
      date: row.date,
      time: row.time,
      desc: row.description,
      ref: { p: '', c: false },
      mesa: { p: '', c: false },
    };
    jornadaById.get(row.jornada_id)?.matches.push(match);
    matchById.set(row.id, match);
  }
  for (const row of assignments.results) {
    const match = matchById.get(row.match_id);
    if (match) match[row.role] = { p: row.person_id || '', c: !!row.confirmed };
  }
  return state;
}

async function replaceState(db, state) {
  const people = state.people.map(({ id, name }) => ({ id, name: name.trim() }));
  const jornadas = state.jornadas.map(({ id, name }) => ({ id, name: name.trim() }));
  const availabilities = state.jornadas.flatMap(jornada => jornada.avail.map(personId => ({
    jornada_id: jornada.id, person_id: personId,
  })));
  const matches = state.jornadas.flatMap(jornada => jornada.matches.map(match => ({
    id: match.id, jornada_id: jornada.id, date: match.date, time: match.time || '', description: match.desc || '',
  })));
  const assignments = state.jornadas.flatMap(jornada => jornada.matches.flatMap(match => ['ref', 'mesa'].map(role => ({
    match_id: match.id, role, person_id: match[role].p || null, confirmed: match[role].c && !!match[role].p ? 1 : 0,
  }))));
  await db.batch([
    db.prepare('DELETE FROM assignments'),
    db.prepare('DELETE FROM availabilities'),
    db.prepare('DELETE FROM matches'),
    db.prepare('DELETE FROM jornadas'),
    db.prepare('DELETE FROM people'),
    db.prepare(`INSERT INTO people (id, name)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.name') FROM json_each(?)`).bind(JSON.stringify(people)),
    db.prepare(`INSERT INTO jornadas (id, name)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.name') FROM json_each(?)`).bind(JSON.stringify(jornadas)),
    db.prepare(`INSERT INTO availabilities (jornada_id, person_id)
      SELECT json_extract(value, '$.jornada_id'), json_extract(value, '$.person_id') FROM json_each(?)`).bind(JSON.stringify(availabilities)),
    db.prepare(`INSERT INTO matches (id, jornada_id, date, time, description)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.jornada_id'), json_extract(value, '$.date'),
        json_extract(value, '$.time'), json_extract(value, '$.description') FROM json_each(?)`).bind(JSON.stringify(matches)),
    db.prepare(`INSERT INTO assignments (match_id, role, person_id, confirmed)
      SELECT json_extract(value, '$.match_id'), json_extract(value, '$.role'), json_extract(value, '$.person_id'),
        json_extract(value, '$.confirmed') FROM json_each(?)`).bind(JSON.stringify(assignments)),
  ]);
}

function assignmentStatements(db, updates, confirmed, onlyIfUnassigned = false) {
  return updates.map(({ matchId, role, personId }) =>
    db.prepare(`INSERT INTO assignments (match_id, role, person_id, confirmed) VALUES (?, ?, ?, ?)
      ON CONFLICT(match_id, role) DO UPDATE SET person_id = excluded.person_id, confirmed = excluded.confirmed
      ${onlyIfUnassigned ? 'WHERE assignments.person_id IS NULL' : ''}`)
      .bind(matchId, role, personId || null, confirmed ? 1 : 0));
}

async function applyAction(db, action) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
    return json({ error: 'Acción no válida.' }, 400);
  }
  let statements;
  switch (action.type) {
    case 'people.add':
      if (!Array.isArray(action.people) || !action.people.length || action.people.length > 100
        || action.people.some(person => !person || !validId(person.id) || typeof person.name !== 'string'
          || !person.name.trim() || person.name.length > 200)) return json({ error: 'Lista de personas no válida.' }, 400);
      statements = action.people.map(person =>
        db.prepare('INSERT INTO people (id, name) VALUES (?, ?)').bind(person.id, person.name.trim()));
      break;
    case 'person.delete':
      if (!validId(action.id)) return json({ error: 'Persona no válida.' }, 400);
      statements = [
        db.prepare('UPDATE assignments SET person_id = NULL, confirmed = 0 WHERE person_id = ?').bind(action.id),
        db.prepare('DELETE FROM availabilities WHERE person_id = ?').bind(action.id),
        db.prepare('DELETE FROM people WHERE id = ?').bind(action.id),
      ];
      break;
    case 'jornada.add':
      if (!validId(action.jornada?.id) || typeof action.jornada.name !== 'string'
        || !action.jornada.name.trim() || action.jornada.name.length > 200) return json({ error: 'Jornada no válida.' }, 400);
      statements = [db.prepare('INSERT INTO jornadas (id, name) VALUES (?, ?)').bind(action.jornada.id, action.jornada.name.trim())];
      break;
    case 'jornada.delete':
      if (!validId(action.id)) return json({ error: 'Jornada no válida.' }, 400);
      statements = [db.prepare('DELETE FROM jornadas WHERE id = ?').bind(action.id)];
      break;
    case 'availability.set':
      if (!validId(action.jornadaId) || !validId(action.personId) || typeof action.available !== 'boolean') {
        return json({ error: 'Disponibilidad no válida.' }, 400);
      }
      statements = action.available
        ? [db.prepare('INSERT OR IGNORE INTO availabilities (jornada_id, person_id) VALUES (?, ?)').bind(action.jornadaId, action.personId)]
        : [db.prepare('DELETE FROM availabilities WHERE jornada_id = ? AND person_id = ?').bind(action.jornadaId, action.personId)];
      break;
    case 'availability.setAll':
      if (!validId(action.jornadaId) || !Array.isArray(action.personIds)
        || action.personIds.length > 500 || action.personIds.some(id => !validId(id))) {
        return json({ error: 'Disponibilidades no válidas.' }, 400);
      }
      statements = [];
      for (const personId of new Set(action.personIds)) {
        statements.push(db.prepare('INSERT OR IGNORE INTO availabilities (jornada_id, person_id) VALUES (?, ?)').bind(action.jornadaId, personId));
      }
      if (!statements.length) return json({ ok: true });
      break;
    case 'match.add':
      if (!validId(action.jornadaId) || !action.match || !validId(action.match.id)
        || typeof action.match.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(action.match.date)
        || typeof (action.match.time || '') !== 'string' || typeof (action.match.desc || '') !== 'string') {
        return json({ error: 'Partido no válido.' }, 400);
      }
      statements = [
        db.prepare('INSERT INTO matches (id, jornada_id, date, time, description) VALUES (?, ?, ?, ?, ?)')
          .bind(action.match.id, action.jornadaId, action.match.date, action.match.time || '', action.match.desc || ''),
        db.prepare('INSERT INTO assignments (match_id, role, person_id, confirmed) VALUES (?, ?, NULL, 0)')
          .bind(action.match.id, 'ref'),
        db.prepare('INSERT INTO assignments (match_id, role, person_id, confirmed) VALUES (?, ?, NULL, 0)')
          .bind(action.match.id, 'mesa'),
      ];
      break;
    case 'match.delete':
      if (!validId(action.id)) return json({ error: 'Partido no válido.' }, 400);
      statements = [db.prepare('DELETE FROM matches WHERE id = ?').bind(action.id)];
      break;
    case 'assignment.set':
      if (!validId(action.matchId) || !['ref', 'mesa'].includes(action.role)
        || (action.personId !== '' && !validId(action.personId))) return json({ error: 'Asignación no válida.' }, 400);
      statements = assignmentStatements(db, [{ matchId: action.matchId, role: action.role, personId: action.personId }], !!action.personId);
      break;
    case 'assignment.confirm':
      if (!validId(action.matchId) || !['ref', 'mesa'].includes(action.role)) return json({ error: 'Asignación no válida.' }, 400);
      statements = [db.prepare('UPDATE assignments SET confirmed = 1 WHERE match_id = ? AND role = ? AND person_id IS NOT NULL')
        .bind(action.matchId, action.role)];
      break;
    case 'assignment.confirmAll':
      if (!validId(action.jornadaId)) return json({ error: 'Jornada no válida.' }, 400);
      statements = [db.prepare(`UPDATE assignments SET confirmed = 1
        WHERE person_id IS NOT NULL AND match_id IN (SELECT id FROM matches WHERE jornada_id = ?)`).bind(action.jornadaId)];
      break;
    case 'assignment.suggested':
      if (!Array.isArray(action.assignments) || action.assignments.length > 500
        || action.assignments.some(item => !item || !validId(item.matchId) || !['ref', 'mesa'].includes(item.role)
          || !validId(item.personId))) return json({ error: 'Sugerencias no válidas.' }, 400);
      if (!action.assignments.length) return json({ ok: true });
      statements = assignmentStatements(db, action.assignments, false, true);
      break;
    case 'season.clear':
      statements = [db.prepare('DELETE FROM jornadas')];
      break;
    default:
      return json({ error: 'Acción no reconocida.' }, 400);
  }
  await db.batch(statements);
  return json({ ok: true });
}

export async function onRequest({ request, env }) {
  const route = new URL(request.url).pathname;
  const method = request.method;

  if (['POST', 'PUT', 'DELETE'].includes(method) && !isSameOrigin(request)) return json({ error: 'Origen no permitido.' }, 403);

  if (route === '/api/login' && method === 'POST') {
    if (!env.APP_PASSWORD || !env.SESSION_SECRET) return json({ error: 'Faltan secretos de configuración.' }, 500);
    const parsed = await readJson(request, 10_000);
    if (parsed.error) return parsed.error;
    if (!parsed.body || typeof parsed.body.password !== 'string' || !await passwordMatches(parsed.body.password, env.APP_PASSWORD)) {
      return json({ error: 'No autorizado.' }, 401);
    }
    const payload = Math.floor(Date.now() / 1000) + SESSION_SECONDS + ':' + base64url(crypto.getRandomValues(new Uint8Array(16)));
    const token = await signSession(payload, env.SESSION_SECRET);
    return json({ ok: true }, 200, {
      'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`,
    });
  }

  if (route === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, {
      'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    });
  }

  if (!env.SESSION_SECRET) return json({ error: 'Falta el secreto de sesión.' }, 500);
  if (!await validSession(request, env.SESSION_SECRET)) return json({ error: 'No autorizado.' }, 401);
  if (!env.DB) return json({ error: 'Falta la base de datos D1.' }, 500);

  if (route === '/api/state' && method === 'GET') return json({ state: await getState(env.DB) });

  if (route === '/api/state' && method === 'PUT') {
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    if (!validateState(parsed.body)) return json({ error: 'Los datos no tienen el formato esperado.' }, 400);
    await replaceState(env.DB, parsed.body);
    return json({ ok: true });
  }

  if (route === '/api/action' && method === 'POST') {
    const parsed = await readJson(request, 100_000);
    if (parsed.error) return parsed.error;
    return applyAction(env.DB, parsed.body);
  }

  return json({ error: 'Ruta no encontrada.' }, 404);
}
