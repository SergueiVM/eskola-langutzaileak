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

function validateState(state) {
  return state && typeof state === 'object' && !Array.isArray(state)
    && Array.isArray(state.people) && Array.isArray(state.jornadas);
}

export async function onRequest({ request, env }) {
  const route = new URL(request.url).pathname;
  const method = request.method;

  if (method === 'POST' && !isSameOrigin(request)) return json({ error: 'Origen no permitido.' }, 403);

  if (route === '/api/login' && method === 'POST') {
    if (!env.APP_PASSWORD || !env.SESSION_SECRET) return json({ error: 'Faltan secretos de configuración.' }, 500);
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: 'Formato no válido.' }, 415);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Formato no válido.' }, 400); }
    if (typeof body.password !== 'string' || !await passwordMatches(body.password, env.APP_PASSWORD)) {
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

  if (route === '/api/state' && method === 'GET') {
    const row = await env.DB.prepare('SELECT data FROM app_state WHERE id = 1').first();
    return json({ state: row ? JSON.parse(row.data) : { people: [], jornadas: [] } });
  }

  if (route === '/api/state' && method === 'PUT') {
    if (!isSameOrigin(request)) return json({ error: 'Origen no permitido.' }, 403);
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: 'Formato no válido.' }, 415);
    const body = await request.text();
    if (body.length > 1_000_000) return json({ error: 'Los datos superan el tamaño permitido.' }, 413);
    let state;
    try { state = JSON.parse(body); } catch { return json({ error: 'Formato no válido.' }, 400); }
    if (!validateState(state)) return json({ error: 'Los datos no tienen el formato esperado.' }, 400);
    await env.DB.prepare('INSERT INTO app_state (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .bind(JSON.stringify(state)).run();
    return json({ ok: true });
  }

  return json({ error: 'Ruta no encontrada.' }, 404);
}
