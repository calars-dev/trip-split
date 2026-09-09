-- Trip Split — 실제 시각으로 갈아타기, 그리고 총무
--
-- 순서는 어느 쪽이어도 된다. 칸 두 개를 더하고 값을 채우기만 하므로 지금 도는 앱이
-- 그대로 돈다(옛 앱은 이 칸을 읽지도 쓰지도 않는다). 여러 번 돌려도 안전하다.
--
-- ── 왜 바꾸나 ───────────────────────────────────────────────────────
-- 지금까지 "언제"는 `day_index`(며칠차) + `slot`(아침/점심/밤) + `hour`(몇 시쯤)
-- 셋으로 쪼개져 있었다. 넣는 사람은 칩을 세 번 눌러야 했고, 타임라인은 시간대라는
-- 뭉툭한 칸으로만 묶여 "저녁 몇 시였더라"에 답하지 못했다. 시작일을 고치면 이미
-- 넣은 지출의 일차를 통째로 밀어야 했고(shiftDays), 자정을 넘기면 밤이 다음 날로
-- 새는 문제가 따로 있었다.
--
-- `spent_at` 하나면 이 전부가 사라진다. 며칠차는 시작일과 빼기로 나오고, 타임라인은
-- 진짜 시계 순서로 서고, 시작일을 고쳐도 지출은 제자리에 있다.
--
-- 옛 칸(day_index/slot/hour)은 **지우지 않는다.** 되돌릴 자리를 남겨두는 값이
-- 칸 세 개보다 크다.

-- ── 1. 언제 썼나 ────────────────────────────────────────────────────
alter table public.expenses add column if not exists spent_at timestamptz;

-- 기존 지출을 옮긴다. 옛 모델에는 날짜가 없고 며칠차만 있으므로, 방 시작일에
-- 며칠차를 더해 날짜를 만들고 hour 가 있으면 그 시각을, 없으면 정오를 쓴다.
-- '여행 전 준비'(day_index 0)는 시작일 이전이라는 것 말고 아는 게 없으니
-- 입력된 시각(created_at)을 그대로 쓴다 — 실제로 그때 넣은 게 맞다.
update public.expenses e
   set spent_at = case
         when e.day_index is null or e.day_index = 0 then e.created_at
         else ((r.start_date + (e.day_index - 1) * interval '1 day')
               + (coalesce(e.hour, 12) * interval '1 hour'))
              at time zone 'Asia/Seoul'
       end
  from public.rooms r
 where r.id = e.room_id
   and e.spent_at is null;

-- 방이 시작일을 안 가진 경우까지 남기지 않는다.
update public.expenses set spent_at = created_at where spent_at is null;

create index if not exists idx_expenses_spent_at on public.expenses (room_id, spent_at desc);

-- ── 2. 총무 ─────────────────────────────────────────────────────────
-- 멤버를 더하고 지우는 것, 공금을 낸 사람으로 고르는 것은 한 사람만 한다.
-- 열네 명이 각자 공금을 건드리면 장부가 아니라 낙서가 된다.
--
-- ⚠️ 이건 **화면에서 가리는 것**이지 서버가 막는 것이 아니다. 같은 방 멤버는
--    여전히 REST 로 무엇이든 쓸 수 있다. 이 앱이 처음부터 "링크를 아는 사람은 다
--    고칠 수 있다"는 모델이라 그 선은 그대로다. 실수로 누르는 것을 막을 뿐,
--    작정한 사람을 막지는 못한다.
alter table public.rooms add column if not exists manager_id uuid;

-- 이시가키: 총무는 이수형
update public.rooms r
   set manager_id = m.id
  from public.members m
 where r.id = 'qx73ifx' and m.room_id = r.id and m.name = '이수형'
   and r.manager_id is null;

-- ── 확인 ────────────────────────────────────────────────────────────
-- spent_at 이 빈 지출이 없어야 한다 (0 이 나와야 함)
--   select count(*) from public.expenses where spent_at is null;
-- 총무가 잡혔는지
--   select r.id, m.name from public.rooms r
--     join public.members m on m.id = r.manager_id where r.id = 'qx73ifx';
