-- ============================================================================
-- 0002_push_subscriptions.sql
-- Zonaed AI Web App — Web Push support (plan §4 /push, §9 Priority 10)
--
-- push_subscriptions is DEVICE-bound, not synced: it never appears in the
-- Dexie syncable tables, so the §3 soft-delete convention does not apply —
-- rows are removed when the device unsubscribes or the endpoint returns
-- 404/410. tasks.reminded_at marks the last reminder actually sent for a
-- task so the every-minute cron never double-fires.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- push_subscriptions — one row per (user, browser endpoint)
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint   text        not null,
  p256dh     text        not null,
  auth       text        not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_subscriptions_user_endpoint_unique unique (user_id, endpoint)
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

create policy "push_subscriptions_select_own" on public.push_subscriptions
  for select using (auth.uid() = user_id);
create policy "push_subscriptions_insert_own" on public.push_subscriptions
  for insert with check (auth.uid() = user_id);
create policy "push_subscriptions_delete_own" on public.push_subscriptions
  for delete using (auth.uid() = user_id);

create trigger push_subscriptions_set_updated_at before update on public.push_subscriptions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- tasks.reminded_at — set by the cron after a reminder push is delivered for
-- the current due_at; reset naturally because the query only picks rows where
-- reminded_at is null (completion/recurrence creates fresh rows).
-- ---------------------------------------------------------------------------
alter table public.tasks add column if not exists reminded_at timestamptz;