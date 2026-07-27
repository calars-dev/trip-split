-- Trip Split — day/slot timeline columns
-- Run ONCE in Supabase: Dashboard > SQL Editor > New query > paste all > Run.
-- Safe to re-run: it only fills columns that are still empty.

-- ── 1. columns ─────────────────────────────────────────────────────
alter table public.rooms    add column if not exists start_date date;      -- day 1 of the trip
alter table public.expenses add column if not exists day_index  smallint;  -- 0 = before the trip
alter table public.expenses add column if not exists slot       text;      -- 아침/점심/오후/저녁/밤
alter table public.expenses add column if not exists seq        int;       -- order inside (day, slot)

create index if not exists idx_expenses_timeline
  on public.expenses(room_id, day_index, seq);

-- ── 2. seed each room's start date ─────────────────────────────────
-- Earliest expense wins. Timestamps are stored in UTC, so convert to KST
-- first — otherwise anything spent after 9pm lands on the next day.
update public.rooms r
set start_date = f.first_day
from (
  select room_id, min((created_at at time zone 'Asia/Seoul')::date) as first_day
  from public.expenses
  group by room_id
) f
where r.id = f.room_id and r.start_date is null;

-- rooms with no expenses at all: fall back to when the room was made
update public.rooms
set start_date = (created_at at time zone 'Asia/Seoul')::date
where start_date is null;

-- ── 3. backfill day/slot from when the expense was entered ─────────
-- Most expenses were typed in on the spot, so the entry time is a good
-- guess. Anything that predates the start date becomes day 0 (prep).
update public.expenses e
set day_index = greatest(0, ((e.created_at at time zone 'Asia/Seoul')::date - r.start_date) + 1),
    slot = case extract(hour from (e.created_at at time zone 'Asia/Seoul'))::int
             when  5 then '아침' when  6 then '아침' when  7 then '아침'
             when  8 then '아침' when  9 then '아침'
             when 10 then '점심' when 11 then '점심' when 12 then '점심'
             when 13 then '점심'
             when 14 then '오후' when 15 then '오후' when 16 then '오후'
             when 17 then '저녁' when 18 then '저녁' when 19 then '저녁'
             when 20 then '저녁'
             else '밤'
           end
from public.rooms r
where e.room_id = r.id and e.day_index is null;

-- Prep spending (day 0) carries no time of day — nobody remembers what time
-- they booked the flight. The app writes null there too.
update public.expenses set slot = null where day_index = 0 and slot is not null;

-- ── 4. number each (day, slot) bucket ──────────────────────────────
update public.expenses e
set seq = s.rn
from (
  select id,
         row_number() over (partition by room_id, day_index, slot
                            order by created_at) - 1 as rn
  from public.expenses
  where seq is null
) s
where e.id = s.id;
