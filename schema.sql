CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0)
);

CREATE TABLE IF NOT EXISTS jornadas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0)
);

CREATE TABLE IF NOT EXISTS availabilities (
  jornada_id TEXT NOT NULL REFERENCES jornadas(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (jornada_id, person_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  jornada_id TEXT NOT NULL REFERENCES jornadas(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS assignments (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('ref', 'mesa')),
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  PRIMARY KEY (match_id, role)
);

CREATE INDEX IF NOT EXISTS matches_jornada_date_idx ON matches (jornada_id, date, time);
CREATE INDEX IF NOT EXISTS assignments_person_idx ON assignments (person_id);
