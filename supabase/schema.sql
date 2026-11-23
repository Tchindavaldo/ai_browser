-- Supabase propre à l'agent ai_browser (distinct du Supabase « qezaly » du back-end).
-- Réglages de l'agent et coûts par tâche. Accès par la clé service (SUPABASE_SERVICE_KEY).

create table if not exists agent_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Nombre de tâches Qezaly exécutées en même temps (relu chaque minute par l'agent).
insert into agent_settings (key, value) values ('max_parallel', '10')
  on conflict (key) do nothing;

create table if not exists agent_runs (
  task_id text primary key,            -- agent_tasks.id du back-end
  order_id text,
  service text,                        -- netflix, spotify
  status text not null,                -- queued, running, waiting_mail, done, failed, cancelled
  success boolean,
  result text,
  needs_admin boolean not null default false,
  session_id text,
  steps integer,
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric(10,5),
  cost_cfa numeric(12,2),
  bytes bigint,
  queued_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists agent_runs_status on agent_runs (status);

-- Accès réservé à la clé service.
alter table agent_settings enable row level security;
alter table agent_runs enable row level security;
