-- ============================================================================
-- 0003_learn_suggestions.sql — §5.4 day-by-day chat-history learning
-- (Priority 11)
--
-- Server-written review queue: /api/learn/cron proposes candidates from the
-- prior day's chat_history; the user approves/edits/discards each one in
-- /memory. Nothing is ever auto-applied (plan §5.4, §7 #8). Approval writes
-- the real memory/skills row (via the API route, service role); the suggestion
-- row itself is only ever status-marked — no hard deletes.
-- ============================================================================

create table public.learn_suggestions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  target             text        not null check (target in ('memory', 'skill')),
  title              text        not null,
  content            text        not null,
  category           text        not null default 'general',
  status             text        not null default 'pending'
                     check (status in ('pending', 'approved', 'discarded')),
  -- Content as approved (edit-before-approve keeps the original for the diff).
  approved_content   text,
  approved_title     text,
  -- Chat quote that justified the suggestion + the day it was mined from.
  source_excerpt     text,
  day                date        not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index learn_suggestions_user_status_idx
  on public.learn_suggestions (user_id, status, created_at desc);

alter table public.learn_suggestions enable row level security;

create trigger learn_suggestions_set_updated_at before update on public.learn_suggestions
  for each row execute function public.set_updated_at();
