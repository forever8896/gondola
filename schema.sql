-- Portfolio Redesigner schema. Idempotent: safe to run on every boot.

-- An anonymous browser session. The cookie holds the id and an HMAC; we never trust an id without it.
CREATE TABLE IF NOT EXISTS sessions (
  id          text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now()
);

-- One request to redesign one site. Owned by exactly one session.
CREATE TABLE IF NOT EXISTS runs (
  id            text PRIMARY KEY,                 -- 128-bit random, URL-safe
  owner         text NOT NULL REFERENCES sessions(id),
  url           text NOT NULL,
  origin        text NOT NULL,
  count         int  NOT NULL,
  status        text NOT NULL DEFAULT 'queued',   -- queued|ingesting|building|done|failed
  phase_note    text,
  base_sandbox  text,
  error         text,
  cost_usd      numeric,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS runs_owner ON runs(owner, created_at DESC);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status, created_at);

-- One design (one sandbox) inside a run.
CREATE TABLE IF NOT EXISTS designs (
  id           bigserial PRIMARY KEY,
  run_id       text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  n            int  NOT NULL,
  token        text NOT NULL UNIQUE,              -- capability id used in the content-origin URL
  brief        jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'queued',    -- queued|forking|working|capturing|done|failed
  sandbox      text,
  last_action  text,
  tool_calls   int  NOT NULL DEFAULT 0,
  name         text,
  summary      text,
  palette      jsonb,
  fonts        jsonb,
  error        text,
  started_at   timestamptz,
  finished_at  timestamptz,
  UNIQUE (run_id, n)
);

-- Files of a finished design (index.html, style.css, _shot/desktop.png...).
CREATE TABLE IF NOT EXISTS design_files (
  design_id  bigint NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  path       text   NOT NULL,
  mime       text   NOT NULL,
  bytes      bytea  NOT NULL,
  PRIMARY KEY (design_id, path)
);

-- Media shared by all designs of a run (assets/...), stored once.
CREATE TABLE IF NOT EXISTS run_assets (
  run_id  text  NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path    text  NOT NULL,
  mime    text  NOT NULL,
  bytes   bytea NOT NULL,
  PRIMARY KEY (run_id, path)
);

-- Activity log, replayed to a client that (re)connects.
CREATE TABLE IF NOT EXISTS run_events (
  id          bigserial PRIMARY KEY,
  run_id      text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  design_n    int,
  text        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, id);

-- Every sandbox we create, so a crash or restart never leaves one billing.
CREATE TABLE IF NOT EXISTS sandboxes (
  id          text PRIMARY KEY,
  run_id      text REFERENCES runs(id) ON DELETE SET NULL,
  role        text NOT NULL,            -- base|fork
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- Added 2026-11-08: in-sandbox QA results ({"before": [...issues], "after": [...issues]}).
ALTER TABLE designs ADD COLUMN IF NOT EXISTS qa jsonb;

-- Added 2026-11-08: which agent model a run used (null = the server default).
ALTER TABLE runs ADD COLUMN IF NOT EXISTS model text;

-- Added 2026-11-08: live preview while a design is being built (server-only URL; never sent to browsers).
ALTER TABLE designs ADD COLUMN IF NOT EXISTS preview_url text;
ALTER TABLE designs ADD COLUMN IF NOT EXISTS live_at timestamptz;

-- Who started a run: open (any visitor) | admin (operator, not counted against DAILY_RUN_LIMIT).
ALTER TABLE runs ADD COLUMN IF NOT EXISTS funding text NOT NULL DEFAULT 'open';
CREATE INDEX IF NOT EXISTS runs_funding_day ON runs(funding, created_at);

-- Prepared ("warm") sites: a snapshotted base sandbox with the site already read, so a run can fork immediately.
-- kit_run_id is an internal run (status 'warm') that holds the extracted kit files in run_assets.
CREATE TABLE IF NOT EXISTS warm_bases (
  origin      text PRIMARY KEY,
  sandbox     text NOT NULL,
  kit_run_id  text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  photos      int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
