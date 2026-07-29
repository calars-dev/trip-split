-- Trip Split — 계정 (2/2: 잠그기)
--
-- ⚠️ 계정 기능이 들어간 앱을 배포한 뒤에 실행할 것. 이 파일부터는 **참여자만**
--    여행을 볼 수 있다. 데이터는 하나도 안 지운다.
--    잘못되면 migration-accounts-rollback.sql 로 되돌린다.
--
-- 왜 claim 을 RLS 가 아니라 함수로 하나
--   "아직 자리가 빈 방은 보여준다" 를 SELECT 정책에 넣으면, RLS 는 행을 거를 뿐
--   열거를 막지 못한다. 로그인만 하면 `select * from rooms` 로 빈 자리가 있는
--   방이 전부 나오고, 아무나 남의 여행에 자리를 꿰찰 수 있다. 그래서 목록은
--   철저히 "내가 낀 방" 만 보여주고, 링크로 방 ID 를 아는 사람만 아래 함수로
--   명단을 보고 자리를 잡는다. 방 ID 가 곧 초대장이다.

begin;

-- ── 내가 낀 여행인가 ────────────────────────────────────────────────
-- members 를 직접 조회하면 members 정책이 다시 이 함수를 불러 무한히 돈다.
-- security definer 라 소유자 권한으로 돌면서 RLS 를 건너뛰므로 재귀하지 않는다.
create or replace function public.in_room(p_room text)
returns boolean
language sql stable security definer
set search_path = pg_temp
as $$
  select exists (
    select 1 from public.members m
    where m.room_id = p_room and m.user_id = auth.uid()
  ) or exists (
    select 1 from public.rooms r
    where r.id = p_room and r.created_by = auth.uid()
  );
$$;
revoke all on function public.in_room(text) from public;
grant execute on function public.in_room(text) to authenticated;

-- ── 링크를 받은 사람이 명단을 보고 자리를 잡는다 ────────────────────
-- 방 ID 를 알아야만 부를 수 있다. 목록으로 훑을 수는 없다.
create or replace function public.room_roster(p_room text)
returns table (id uuid, name text)
language sql stable security definer
set search_path = pg_temp
as $$
  select m.id, m.name
    from public.members m
   where m.room_id = p_room and m.user_id is null
   order by m.created_at;
$$;
revoke all on function public.room_roster(text) from public;
grant execute on function public.room_roster(text) to authenticated;

-- 링크를 받았지만 아직 자리가 없는 사람에게 방 이름만 알려준다. RLS 로는
-- 이걸 못 한다 — 이름을 보여주는 정책은 곧 목록을 훑을 수 있게 하는 정책이다.
create or replace function public.room_peek(p_room text)
returns text
language sql stable security definer
set search_path = pg_temp
as $$
  select r.name from public.rooms r where r.id = p_room;
$$;
revoke all on function public.room_peek(text) from public;
grant execute on function public.room_peek(text) to authenticated;

-- 빈 자리 하나를 자기 것으로. 남의 자리는 못 건드린다.
create or replace function public.claim_seat(p_room text, p_member uuid)
returns boolean
language plpgsql volatile security definer
set search_path = pg_temp
as $$
declare v_ok int;
begin
  if auth.uid() is null then return false; end if;
  -- 이미 이 방에 자리가 있으면 두 개를 가질 수 없다
  if exists (select 1 from public.members
              where room_id = p_room and user_id = auth.uid()) then
    return false;
  end if;
  update public.members
     set user_id = auth.uid()
   where id = p_member and room_id = p_room and user_id is null;
  get diagnostics v_ok = row_count;
  return v_ok = 1;
end $$;
revoke all on function public.claim_seat(text, uuid) from public;
grant execute on function public.claim_seat(text, uuid) to authenticated;

-- 링크로 처음 들어온 사람이 목록에 없는 이름으로 새로 참여할 때.
create or replace function public.join_room(p_room text, p_name text)
returns uuid
language plpgsql volatile security definer
set search_path = pg_temp
as $$
declare v_id uuid;
begin
  if auth.uid() is null then return null; end if;
  if not exists (select 1 from public.rooms where id = p_room) then return null; end if;
  select id into v_id from public.members where room_id = p_room and user_id = auth.uid();
  if v_id is not null then return v_id; end if;
  insert into public.members (room_id, name, user_id)
  values (p_room, btrim(p_name), auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.join_room(text, text) from public;
grant execute on function public.join_room(text, text) to authenticated;

-- ── 기존 방에 주인 세우기 ───────────────────────────────────────────
-- created_by 가 비어 있으면 `created_by = auth.uid()` 가 NULL 이라 영원히 참이
-- 되지 않는다. 그러면 아무도 그 방을 못 지운다. 지금 있는 6개 방은 만든 사람을
-- 알 수 없으므로, "그 방에 자리를 가진 사람이면 지울 수 있다" 로 대신한다.

-- ── 정책 갈아끼우기 ─────────────────────────────────────────────────
drop policy if exists "anon all rooms"    on public.rooms;
drop policy if exists "anon all members"  on public.members;
drop policy if exists "anon all expenses" on public.expenses;
drop policy if exists "rooms read"        on public.rooms;
drop policy if exists "rooms insert"      on public.rooms;
drop policy if exists "rooms update"      on public.rooms;
drop policy if exists "rooms delete"      on public.rooms;
drop policy if exists "members by key"    on public.members;
drop policy if exists "expenses by key"   on public.expenses;
-- 새 이름도 미리 지운다. 없으면 재실행이 "already exists" 로 죽는다.
drop policy if exists "rooms mine"     on public.rooms;
drop policy if exists "rooms create"   on public.rooms;
drop policy if exists "rooms edit"     on public.rooms;
drop policy if exists "rooms remove"   on public.rooms;
drop policy if exists "members read"   on public.members;
drop policy if exists "members write"  on public.members;
drop policy if exists "members edit"   on public.members;
drop policy if exists "members remove" on public.members;
drop policy if exists "expenses all"   on public.expenses;

create policy "rooms mine"   on public.rooms for select to authenticated
  using (public.in_room(id));
create policy "rooms create" on public.rooms for insert to authenticated
  with check (created_by = auth.uid());
create policy "rooms edit"   on public.rooms for update to authenticated
  using (public.in_room(id)) with check (public.in_room(id));
create policy "rooms remove" on public.rooms for delete to authenticated
  using (created_by = auth.uid() or (created_by is null and public.in_room(id)));

create policy "members read"  on public.members for select to authenticated
  using (public.in_room(room_id));
-- 멤버 추가는 이미 그 방에 있는 사람만. 남의 자리를 만들 수는 있어도(총무가
-- 대신 넣는 경우) 그 자리에 남의 계정을 붙일 수는 없다.
create policy "members write"  on public.members for insert to authenticated
  with check (public.in_room(room_id) and (user_id is null or user_id = auth.uid()));
create policy "members edit"   on public.members for update to authenticated
  using (public.in_room(room_id))
  with check (public.in_room(room_id) and (user_id is null or user_id = auth.uid()));
create policy "members remove" on public.members for delete to authenticated
  using (public.in_room(room_id));

create policy "expenses all" on public.expenses for all to authenticated
  using (public.in_room(room_id)) with check (public.in_room(room_id));

-- ── 익명 접근 차단 ──────────────────────────────────────────────────
-- 지금까지는 anon 키만 있으면 여행 6개와 지출 50건이 통째로 나왔다.
revoke all on public.rooms, public.members, public.expenses from anon;
grant select, insert, update, delete
  on public.rooms, public.members, public.expenses to authenticated;

commit;

-- ── 확인 ────────────────────────────────────────────────────────────
do $$
declare n int;
begin
  select count(*) into n from public.members where user_id is null;
  raise notice '아직 계정에 안 붙은 자리: % 개 (링크로 들어가 고르면 붙는다)', n;
  select count(*) into n from public.rooms r
    where not exists (select 1 from public.members m where m.room_id = r.id);
  if n > 0 then
    raise warning '멤버가 0명인 방이 % 개 — 아무도 자리를 잡을 수 없어 고아가 된다', n;
  end if;
  raise notice '완료 — 이제 참여자만 볼 수 있다';
end $$;
