-- Trip Split — 이름 고르고 생일 네 자리로 들어오기
--
-- 순서는 어느 쪽이어도 된다. 이 파일은 **아무것도 잠그지 않는다** — 칸과 함수를
-- 더하고 권한을 열기만 하므로 지금 도는 앱이 그대로 돈다. 반대로 SQL 을 먼저
-- 돌려도 새 함수를 부르는 건 새 앱뿐이라 아무 일도 일어나지 않는다.
-- (새 앱은 이 함수들이 없으면 옛 로그인 화면으로 물러난다 — test/birthday.test.js)
-- 여러 번 돌려도 안전하다.
--
-- ⚠️ migration-pot.sql 이 먼저 돌아 있어야 한다. 아래에서 is_ledger 를 보고
--    공금 칸을 사람 명단에서 빼기 때문이다.
--
-- 왜 바꾸나
--   기존은 두 단계였다 — ① 아이디와 여섯 자리로 계정을 만들고 ② 명단에서 내
--   이름을 고른다. 여행 첫날 열네 명에게 시킬 일로는 길다. 이제 한 단계다.
--   명단에서 이름을 누르고 생일 네 자리(월일)를 치면 끝.
--
-- 무엇을 맞바꿨나
--   서로 생일을 아는 사이라면 남의 자리로 들어갈 수 있다. 원래 이 앱은
--   "링크를 아는 사람은 다 고칠 수 있다"는 모델이라 새로 생긴 구멍은 아니지만,
--   "한 번 누른 자리는 아무도 못 가져간다"던 보장은 사라진다. 알고 바꾼 것이다.
--
-- 생일이 저장되는 방식
--   원문은 저장하지 않는다. sha256(멤버id + ':' + 월일) 만 남는다. 멤버 id 를
--   같이 섞으므로 생일이 같은 두 사람(예: 11.18)도 저장값이 다르고, DB 가
--   통째로 새더라도 네 자리를 되찾기 위한 표를 미리 만들어 둘 수 없다.

create extension if not exists pgcrypto with schema extensions;

-- ── 1. 칸 ───────────────────────────────────────────────────────────
-- 생일을 넣지 않은 멤버는 null 이다. 그런 자리는 이 방식으로 들어올 수 없고,
-- 예전처럼 계정을 만들어 고르는 길만 남는다(공금 같은 장부용 칸이 그렇다).
alter table public.members add column if not exists birth_hash text;

-- ── 2. 생일 확인 ────────────────────────────────────────────────────
-- anon 은 members 를 못 읽으므로 함수가 대신 본다 = security definer.
-- 예/아니오만 답한다. 해시도, 이 방에 누가 있는지도 밖으로 내보내지 않는다.
create or replace function public.birth_ok(p_room text, p_member uuid, p_birth text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1
      from public.members m
     where m.id = p_member
       and m.room_id = p_room
       and m.is_ledger = false
       and m.birth_hash is not null
       and m.birth_hash = encode(digest(p_member::text || ':' || p_birth, 'sha256'), 'hex')
  );
$$;

revoke all on function public.birth_ok(text, uuid, text) from public;
grant execute on function public.birth_ok(text, uuid, text) to anon, authenticated;

-- ── 3. 로그인 전에도 방 이름과 명단이 보이게 ────────────────────────
-- 이름을 먼저 고르는 화면이므로 계정이 없는 사람도 이 둘을 봐야 한다.
-- (링크를 아는 사람에게 방 이름과 이름 열네 개가 보인다. 그게 이 화면의 값이다.)
grant execute on function public.room_peek(text) to anon;

-- ⚠️ 기존 room_roster 는 그대로 둔다. 그건 "빈 자리"만 내주는데, 이 화면은
--    이미 자리를 가져간 사람도 보여줘야 한다. 안 그러면 폰 데이터를 지운
--    사람이 명단에서 자기 이름을 못 찾아 영영 못 들어온다. 여행 중에 이게
--    나면 손쓸 방법이 없으므로 자리 상태를 같이 내주는 함수를 따로 둔다.
--    (반환 칸이 달라 room_roster 를 고치려면 drop 부터 해야 하는데, 그러면
--     옛 앱이 도는 중에 잠깐 함수가 사라진다. 새로 만드는 편이 안전하다.)
create or replace function public.room_seats(p_room text)
returns table (id uuid, name text, taken boolean)
language sql stable security definer
set search_path = pg_temp
as $$
  select m.id, m.name, m.user_id is not null
    from public.members m
   where m.room_id = p_room
     and m.is_ledger = false          -- 공금은 사람이 아니라 장부 칸이다
     and m.birth_hash is not null     -- 생일이 없는 자리는 이 화면으로 못 들어온다
   order by m.created_at;
$$;
revoke all on function public.room_seats(text) from public;
grant execute on function public.room_seats(text) to anon, authenticated;

-- ── 4. 자리 가져가기 (생일까지 맞아야) ──────────────────────────────
-- 2번은 화면에 "생일이 맞지 않아요"를 띄우기 위한 것이고, 진짜 문지기는 여기다.
-- 2번을 건너뛰고 이 함수만 직접 불러도 생일이 틀리면 자리를 못 가져간다.
create or replace function public.claim_by_birth(p_room text, p_member uuid, p_birth text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  hit int;
begin
  if auth.uid() is null then
    return false;
  end if;

  -- 빈 자리면 가져가고, **이미 내 자리면 그대로 참이다.** 폰을 바꾸거나 브라우저
  -- 기록을 지우고 다시 들어오는 사람이 매번 여기를 지나가므로, 두 번째부터
  -- 거짓이 나오면 자기 자리에 못 들어간다. 남의 자리일 때만 거짓이다.
  update public.members m
     set user_id = auth.uid()
   where m.id = p_member
     and m.room_id = p_room
     and (m.user_id is null or m.user_id = auth.uid())
     and m.is_ledger = false
     and m.birth_hash is not null
     and m.birth_hash = encode(digest(p_member::text || ':' || p_birth, 'sha256'), 'hex');

  get diagnostics hit = row_count;
  return hit = 1;
end;
$$;

revoke all on function public.claim_by_birth(text, uuid, text) from public;
grant execute on function public.claim_by_birth(text, uuid, text) to authenticated;

-- ── 확인 ────────────────────────────────────────────────────────────
-- 생일이 들어간 자리가 몇인지 세어 본다. 시드를 돌린 뒤 14 가 나와야 한다.
--   select count(*) from public.members
--    where room_id = 'qx73ifx' and birth_hash is not null;
