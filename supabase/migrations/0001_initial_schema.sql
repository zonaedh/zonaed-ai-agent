-- ============================================================================
-- 0001_initial_schema.sql
-- Zonaed AI Web App — initial schema (plan §9 Step 0)
--
-- Conventions (plan §3):
--   * Dexie (IndexedDB) is the on-device source of truth; Supabase is the
--     sync/backup layer. Every syncable table carries client_id, updated_at,
--     deleted_at.
--   * No hard deletes anywhere in sync: deletion sets deleted_at only.
--   * Conflict resolution is last-write-wins by updated_at; the losing record
--     is soft-deleted (deleted_at set), never hard-deleted.
--   * RLS is enabled on every table, keyed off auth.uid() (plan §2) — the PIN
--     is a device gate only and never participates in data authorization.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- updated_at maintenance trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- tasks — CRUD + recurrence engine (plan §4 /tasks)
-- ---------------------------------------------------------------------------
create table public.tasks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  client_id     text        not null,
  title         text        not null,
  notes         text,
  due_at        timestamptz,
  recurrence    jsonb,                -- recurrence rule (RRULE-ish JSON), null = one-off
  completed     boolean     not null default false,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint tasks_user_client_unique unique (user_id, client_id),
  constraint tasks_recurrence_shape check (recurrence is null or jsonb_typeof(recurrence) = 'object')
);

create index tasks_user_updated_idx on public.tasks (user_id, updated_at desc);
create index tasks_due_idx on public.tasks (user_id, due_at) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- memory — long-term memory (plan §4 /memory, auto-learn from conversation)
-- ---------------------------------------------------------------------------
create table public.memory (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  client_id  text        not null,
  content    text        not null,
  category   text        not null default 'general',
  source     text        not null default 'manual',  -- manual | conversation | learn-review
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint memory_user_client_unique unique (user_id, client_id)
);

create index memory_user_updated_idx on public.memory (user_id, updated_at desc);
create index memory_category_idx on public.memory (user_id, category) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- knowledge — knowledge base + .md import (plan §4 /knowledge)
-- ---------------------------------------------------------------------------
create table public.knowledge (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  client_id  text        not null,
  title      text        not null,
  content    text        not null,     -- sanitized markdown
  tags       text[]      not null default '{}',
  source     text        not null default 'manual',  -- manual | md-import
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint knowledge_user_client_unique unique (user_id, client_id)
);

create index knowledge_user_updated_idx on public.knowledge (user_id, updated_at desc);


-- ---------------------------------------------------------------------------
-- chat_history — conversation log (plan §4 /chat, §5.4 learning source)
-- ---------------------------------------------------------------------------
create table public.chat_history (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  client_id  text        not null,
  session_id text        not null,
  role       text        not null check (role in ('user', 'assistant', 'system')),
  content    text        not null,
  provider   text,                     -- groq | gemini | deepseek | openrouter
  model      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint chat_history_user_client_unique unique (user_id, client_id)
);

create index chat_history_user_session_idx on public.chat_history (user_id, session_id, created_at);
create index chat_history_user_updated_idx on public.chat_history (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- skills — trigger-based skills AND uploaded .md skill files
-- (plan §5.1 + §5.3; one table supports both shapes)
-- ---------------------------------------------------------------------------
create table public.skills (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  client_id        text        not null,
  title            text        not null,
  content          text        not null,           -- sanitized markdown
  trigger_keywords text[]      not null default '{}', -- empty = always-on skill
  source           text        not null default 'upload' check (source in ('trigger', 'upload')),
  version          integer     not null default 1,  -- re-upload bumps version, never destroys (plan §5.3)
  active           boolean     not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  constraint skills_user_client_unique unique (user_id, client_id)
);

create index skills_user_updated_idx on public.skills (user_id, updated_at desc);
create index skills_triggers_idx on public.skills using gin (trigger_keywords) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- examples — user-approved few-shot golden samples (plan §5.1)
-- ---------------------------------------------------------------------------
create table public.examples (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  client_id  text        not null,
  input      text        not null,
  output     text        not null,
  context    text,                              -- when to use this example
  tags       text[]      not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint examples_user_client_unique unique (user_id, client_id)
);

create index examples_user_updated_idx on public.examples (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- settings — synced app settings (e.g. §5.4 "Learn from my chat history"
-- toggle, sync preferences). Key/value per user.
-- ---------------------------------------------------------------------------
create table public.settings (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  client_id  text        not null,
  key        text        not null,
  value      jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint settings_user_client_key_unique unique (user_id, client_id, key)
);

create index settings_user_updated_idx on public.settings (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers on every syncable table
-- ---------------------------------------------------------------------------
create trigger tasks_set_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();
create trigger memory_set_updated_at before update on public.memory
  for each row execute function public.set_updated_at();
create trigger knowledge_set_updated_at before update on public.knowledge
  for each row execute function public.set_updated_at();
create trigger chat_history_set_updated_at before update on public.chat_history
  for each row execute function public.set_updated_at();
create trigger skills_set_updated_at before update on public.skills
  for each row execute function public.set_updated_at();
create trigger examples_set_updated_at before update on public.examples
  for each row execute function public.set_updated_at();
create trigger settings_set_updated_at before update on public.settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: enabled project-wide, keyed off auth.uid() (plan §2, §9 Step 0).
-- The scoped extension sync token resolves to the same Supabase session, so
-- extension traffic is subject to these exact same policies.
-- ---------------------------------------------------------------------------
alter table public.tasks        enable row level security;
alter table public.memory       enable row level security;
alter table public.knowledge    enable row level security;
alter table public.chat_history enable row level security;
alter table public.skills       enable row level security;
alter table public.examples     enable row level security;
alter table public.settings     enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['tasks', 'memory', 'knowledge', 'chat_history', 'skills', 'examples', 'settings']
  loop
    execute format($f$
      create policy %1$s_owner_select on public.%1$s
        for select using (auth.uid() = user_id);
      create policy %1$s_owner_insert on public.%1$s
        for insert with check (auth.uid() = user_id);
      create policy %1$s_owner_update on public.%1$s
        for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
      create policy %1$s_owner_delete on public.%1$s
        for delete using (auth.uid() = user_id);
    $f$, t);
  end loop;
end;
$$;

-- NOTE on deletes: RLS delete policies exist so the out-of-MVP retention/purge
-- job (service role) can hard-delete after the grace period (plan §3). The
-- application and the sync API itself only ever set deleted_at (soft delete).

-- ---------------------------------------------------------------------------
-- grants: authenticated (incl. anonymous sign-ins) get RLS-filtered DML.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
