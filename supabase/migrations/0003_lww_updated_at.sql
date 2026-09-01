-- ============================================================================
-- 0003_lww_updated_at.sql
-- LWW fix (plan §3): conflict resolution is last-write-wins by updated_at, so
-- the sync engine MUST be able to write its own updated_at. The 0001 version
-- of set_updated_at() unconditionally overwrote it, which would clobber the
-- client timestamp on every synced upsert and break conflict resolution.
--
-- New rule:
--   * UPDATE where the writer did NOT supply a new updated_at (payload value
--     identical to the stored one) → bump to now() (plain app edits).
--   * UPDATE with an explicit, different updated_at → preserve it (sync push).
--   * INSERT → column default or the writer's explicit value (never null,
--     column is NOT NULL — kept as a safety net).
-- Idempotent; applies to every table using the 0001 triggers.
-- ============================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.updated_at is not distinct from old.updated_at then
    -- Ordinary update that did not carry its own timestamp: bump it.
    new.updated_at = now();
  elsif new.updated_at is null then
    new.updated_at = now();
  end if;
  -- Otherwise: the writer supplied an explicit updated_at (sync push) — keep it.
  return new;
end;
$$;
