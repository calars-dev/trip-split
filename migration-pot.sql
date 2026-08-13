-- Trip Split — 공금(장부용 멤버) + 시각(몇 시쯤)
-- Run ONCE in Supabase: Dashboard > SQL Editor > New query > paste all > Run.
-- 여러 번 돌려도 안전하다.

-- ── 1. 장부용 멤버 ──────────────────────────────────────────────────
-- 공금은 사람이 아니라 장부의 한 칸이다. 결제자로는 고를 수 있지만
-- 나눔 대상에서는 아예 빠지고, 아무도 자기 이름으로 가져갈 수 없다.
alter table public.members
  add column if not exists is_ledger boolean not null default false;

-- ── 2. 시각 ────────────────────────────────────────────────────────
-- 며칠차·시간대만으로는 타임라인 안에서 순서가 흐릿하다. 1시간 단위면
-- "저녁 18시 → 20시"가 제자리를 찾는다. 여행 전 준비 칸은 null.
alter table public.expenses
  add column if not exists hour smallint;

-- ── 3. 초대 링크 명단에서 공금 빼기 ────────────────────────────────
-- 링크로 처음 들어온 사람에게는 서버가 명단을 직접 내려준다. 앱에서 거르는 것만으로는
-- 이 경로에 닿지 않아, 공금이 고를 수 있는 이름으로 뜬다. 누가 그걸 누르면 공금이
-- 그 사람 것이 되고 되돌릴 방법이 없다.
create or replace function public.room_roster(p_room text)
returns table (id uuid, name text)
language sql stable security definer
set search_path = pg_temp
as $$
  select m.id, m.name
    from public.members m
   where m.room_id = p_room and m.user_id is null and m.is_ledger = false
   order by m.created_at;
$$;
revoke all on function public.room_roster(text) from public;
grant execute on function public.room_roster(text) to authenticated;

-- ── 4. 값 검사 ─────────────────────────────────────────────────────
-- 0~23 밖의 값이 들어오면 타임라인 정렬이 조용히 어긋난다.
do $$
begin
  alter table public.expenses
    add constraint expenses_hour_range check (hour is null or (hour >= 0 and hour <= 23));
exception when duplicate_object then null;
end $$;
