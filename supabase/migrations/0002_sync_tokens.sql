-- ============================================================================
-- 0002_sync_tokens.sql
-- Scoped extension API tokens (plan §2 layer 3, §7 checklist: "Extension uses
-- separate revocable API token, scoped to sync/*").
--
-- Only SHA-256 hashes of tokens are stored; revocation is a soft state
-- (revoked_at), consistent with the no-hard-deletes convention (§3).
-- ============================================================================

create table public.sync_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  label       text        not null default 'extension',
  token_hash  text        not null unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  expires_at  timestamptz,
  revoked_at  timestamptz
);

create index sync_tokens_user_idx on public.sync_tokens (user_id);

create trigger sync_tokens_set_updated_at before update on public.sync_tokens
  for each row execute function public.set_updated_at();

alter table public.sync_tokens enable row level security;

create policy sync_tokens_owner_select on public.sync_tokens
  for select using (auth.uid() = user_id);
create policy sync_tokens_owner_insert on public.sync_tokens
  for insert with check (auth.uid() = user_id);
create policy sync_tokens_owner_update on public.sync_tokens
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy sync_tokens_owner_delete on public.sync_tokens
  for delete using (auth.uid() = user_id);
