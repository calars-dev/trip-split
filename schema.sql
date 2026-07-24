-- Trip Split — database schema
-- Run this ONCE in Supabase: Dashboard > SQL Editor > New query > paste all > Run.
-- Safe to re-run (uses IF NOT EXISTS / idempotent policy drops).

-- ── Tables ─────────────────────────────────────────────────────────
create table if not exists public.rooms (
  id               text primary key,
  name             text not null,
  default_currency text not null default 'KRW',
  base_rate_jpy    numeric,   -- last JPY->KRW rate any client fetched (offline fallback)
  base_rate_date   date,
  created_at       timestamptz not null default now()
);

create table if not exists public.members (
  id         uuid primary key default gen_random_uuid(),
  room_id    text not null references public.rooms(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id              uuid primary key default gen_random_uuid(),
  room_id         text not null references public.rooms(id) on delete cascade,
  payer_id        uuid not null references public.members(id) on delete cascade,
  amount          bigint not null,
  currency        text not null default 'KRW',
  category        text,
  note            text,
  participant_ids uuid[] not null default '{}',
  settled         boolean not null default false,  -- 현장에서 바로 정산됨 → 최종 정산에서 제외
  rate_krw        numeric,   -- KRW per 1 unit of `currency`, locked in at save time (null for KRW)
  rate_date       date,      -- business day the rate came from
  rate_source     text,      -- 'api' | 'room' | 'manual' | 'fallback'
  created_at      timestamptz not null default now()
);

create index if not exists idx_members_room  on public.members(room_id);
create index if not exists idx_expenses_room on public.expenses(room_id);

-- ── Row Level Security ─────────────────────────────────────────────
-- Link-based access model (no auth): anon key may do everything.
alter table public.rooms    enable row level security;
alter table public.members  enable row level security;
alter table public.expenses enable row level security;

drop policy if exists "anon all rooms"    on public.rooms;
drop policy if exists "anon all members"  on public.members;
drop policy if exists "anon all expenses" on public.expenses;

create policy "anon all rooms"    on public.rooms    for all using (true) with check (true);
create policy "anon all members"  on public.members  for all using (true) with check (true);
create policy "anon all expenses" on public.expenses for all using (true) with check (true);

-- ── Table privileges ───────────────────────────────────────────────
-- Tables created via the SQL editor don't auto-grant to the anon role;
-- grant explicitly so the link-based (anon) client can read/write.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.rooms, public.members, public.expenses to anon, authenticated;

-- ── Realtime ───────────────────────────────────────────────────────
-- Push live changes to every connected client.
alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.members;
alter publication supabase_realtime add table public.expenses;
