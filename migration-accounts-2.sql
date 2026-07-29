-- Trip Split — 계정 (2/2: 잠그기)
--
-- ⚠️ 계정 기능이 들어간 앱을 배포하고, 본인이 로그인해서 교토 여행의 '수형'을
--    한 번 잡은 뒤에 실행할 것. 이 파일부터는 **참여자만** 여행을 볼 수 있다.
--    먼저 실행하면 아무도 아무것도 못 본다(데이터는 그대로 있다).
--
-- 여기서부터 방별 비밀번호(migration-password.sql)는 필요 없다. 실행했더라도
-- 아래에서 정책을 덮어쓰므로 신경 쓰지 않아도 된다.

-- ── 내가 낀 여행인가 ────────────────────────────────────────────────
-- members 를 직접 조회하면 members 정책이 다시 이 함수를 부르면서 무한히 돈다.
-- security definer 로 정책을 우회해서 한 번만 답한다.
create or replace function public.in_room(p_room text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
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

-- 아직 아무도 안 잡은 여행인가 (링크로 처음 들어와 이름을 고르는 중)
create or replace function public.room_claimable(p_room text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.members m
    where m.room_id = p_room and m.user_id is null
  );
$$;
revoke all on function public.room_claimable(text) from public;
grant execute on function public.room_claimable(text) to authenticated;

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

-- 여행: 내가 낀 것만 보인다. 링크를 받아 아직 이름을 고르는 중이면 그 방도 보인다.
create policy "rooms mine" on public.rooms for select to authenticated
  using (public.in_room(id) or public.room_claimable(id));
create policy "rooms create" on public.rooms for insert to authenticated
  with check (created_by = auth.uid());
create policy "rooms edit" on public.rooms for update to authenticated
  using (public.in_room(id)) with check (public.in_room(id));
create policy "rooms remove" on public.rooms for delete to authenticated
  using (created_by = auth.uid());          -- 만든 사람만 지운다

-- 멤버: 같은 여행에 낀 사람끼리만 보인다. 이름 고르기(claim)를 위해
--       아직 주인 없는 줄이 있는 방은 열어둔다.
create policy "members read" on public.members for select to authenticated
  using (public.in_room(room_id) or public.room_claimable(room_id));
create policy "members write" on public.members for insert to authenticated
  with check (public.in_room(room_id) or public.room_claimable(room_id));
create policy "members edit" on public.members for update to authenticated
  using (public.in_room(room_id) or public.room_claimable(room_id))
  with check (public.in_room(room_id) or public.room_claimable(room_id));
create policy "members remove" on public.members for delete to authenticated
  using (public.in_room(room_id));

-- 지출: 참여자만.
create policy "expenses all" on public.expenses for all to authenticated
  using (public.in_room(room_id)) with check (public.in_room(room_id));

-- ── 익명 접근 차단 ──────────────────────────────────────────────────
-- 로그인하지 않은 상태에서는 아무것도 안 나온다. 지금까지는 anon 키만 있으면
-- 여행 6개와 지출 50건이 통째로 나왔다.
revoke all on public.rooms, public.members, public.expenses from anon;
grant select, insert, update, delete
  on public.rooms, public.members, public.expenses to authenticated;

-- ── 확인 ────────────────────────────────────────────────────────────
do $$
declare n_unclaimed int;
begin
  select count(*) into n_unclaimed from public.members where user_id is null;
  raise notice '아직 계정에 안 붙은 멤버: % 명 (각자 로그인해서 고르면 붙는다)', n_unclaimed;
  raise notice '완료 — 이제 참여자만 볼 수 있다';
end $$;
