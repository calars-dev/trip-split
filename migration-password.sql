-- Trip Split — 여행별 비밀번호 (서버에서 막는다)
--
-- ⚠️ 앱을 먼저 배포한 뒤에 실행할 것.
--    아래에서 rooms 의 컬럼 권한을 좁히기 때문에, `select *` 를 쓰는 옛 앱은
--    이 SQL이 도는 순간 방을 못 읽는다. 새 앱은 컬럼을 명시해서 읽는다.
--
-- 설계
--   · 목록(방 이름)은 누구나 본다. 잠금 여부만 `has_pw` 로 노출한다.
--   · 멤버·지출은 올바른 키가 헤더로 와야 서버가 내준다. 비밀번호를 모르면
--     명령어로 직접 찔러도 데이터가 나오지 않는다.
--   · 비밀번호가 없는 방(`pw_hash is null`)은 지금까지처럼 누구나 열 수 있다.
--     그래서 이미 쓰던 방들이 이 SQL 하나로 잠기는 일은 없다.
--
-- 키가 오가는 방식
--   앱은 sha256(방ID + ':' + 비밀번호) 를 계산해 `x-trip-key` 헤더로 보낸다.
--   서버는 그걸 한 번 더 해시해서 저장분과 비교한다. 그래서 DB가 통째로
--   새더라도 저장된 값으로는 방을 열 수 없다. 비밀번호 원문은 기기 밖으로
--   나가지 않는다.

create extension if not exists pgcrypto with schema extensions;

-- ── 1. 칸 ───────────────────────────────────────────────────────────
alter table public.rooms add column if not exists pw_hash text;

-- 목록에 "자물쇠"를 그리기 위한 값. 해시 자체는 아래에서 권한을 뺀다.
alter table public.rooms drop column if exists has_pw;
alter table public.rooms add column has_pw boolean
  generated always as (pw_hash is not null) stored;

-- ── 2. 키 검사 ──────────────────────────────────────────────────────
-- anon 은 pw_hash 를 못 읽으므로(3번) 함수가 대신 읽는다 = security definer.
create or replace function public.room_ok(p_room text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1
    from public.rooms r
    where r.id = p_room
      and (
        r.pw_hash is null                       -- 잠그지 않은 방은 그대로 열린다
        or r.pw_hash = encode(digest(
             coalesce(
               nullif(current_setting('request.headers', true), '')::json ->> 'x-trip-key',
               ''
             ), 'sha256'), 'hex')
      )
  );
$$;

revoke all on function public.room_ok(text) from public;
grant execute on function public.room_ok(text) to anon, authenticated;

-- ── 3. 컬럼 권한: pw_hash 는 절대 밖으로 안 나간다 ──────────────────
revoke select on public.rooms from anon, authenticated;
grant select (id, name, default_currency, start_date,
              base_rate_jpy, base_rate_date, has_pw, created_at)
  on public.rooms to anon, authenticated;
grant insert, update, delete on public.rooms to anon, authenticated;

-- ── 4. 접근 정책 ────────────────────────────────────────────────────
drop policy if exists "anon all rooms"    on public.rooms;
drop policy if exists "anon all members"  on public.members;
drop policy if exists "anon all expenses" on public.expenses;
drop policy if exists "rooms read"        on public.rooms;
drop policy if exists "rooms insert"      on public.rooms;
drop policy if exists "rooms update"      on public.rooms;
drop policy if exists "rooms delete"      on public.rooms;
drop policy if exists "members by key"    on public.members;
drop policy if exists "expenses by key"   on public.expenses;

-- 방 목록은 공개. 고치거나 지우려면 키가 맞아야 한다.
create policy "rooms read"   on public.rooms for select using (true);
create policy "rooms insert" on public.rooms for insert with check (true);
create policy "rooms update" on public.rooms for update
  using (public.room_ok(id)) with check (public.room_ok(id));
create policy "rooms delete" on public.rooms for delete
  using (public.room_ok(id));

-- 내용물은 키가 맞아야 읽고 쓴다.
create policy "members by key"  on public.members  for all
  using (public.room_ok(room_id)) with check (public.room_ok(room_id));
create policy "expenses by key" on public.expenses for all
  using (public.room_ok(room_id)) with check (public.room_ok(room_id));

-- ── 5. 확인 ─────────────────────────────────────────────────────────
-- 아래가 전부 통과해야 정상이다.
do $$
declare
  n_open int;
begin
  -- 비밀번호 없는 방은 키 없이도 보여야 한다
  select count(*) into n_open from public.rooms where pw_hash is null;
  raise notice '잠기지 않은 방: % 개 (지금까지처럼 열린다)', n_open;

  if not public.room_ok((select id from public.rooms where pw_hash is null limit 1)) then
    raise exception '잠기지 않은 방이 막혔다 — 정책이 잘못됐다';
  end if;

  raise notice '검사 통과';
end $$;
