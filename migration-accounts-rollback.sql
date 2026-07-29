-- Trip Split — 계정 잠금 되돌리기 (비상용)
--
-- migration-accounts-2.sql 을 돌린 뒤 아무도 아무것도 못 보게 되면 이걸 돌린다.
-- 정책만 원래(누구나 열림)로 되돌린다. **데이터는 하나도 건드리지 않는다** —
-- profiles, members.user_id, rooms.created_by 는 그대로 남으므로, 고쳐서 다시
-- 2/2 를 돌리면 된다.

drop policy if exists "rooms mine"    on public.rooms;
drop policy if exists "rooms create"  on public.rooms;
drop policy if exists "rooms edit"    on public.rooms;
drop policy if exists "rooms remove"  on public.rooms;
drop policy if exists "members read"  on public.members;
drop policy if exists "members write" on public.members;
drop policy if exists "members edit"  on public.members;
drop policy if exists "members remove" on public.members;
drop policy if exists "expenses all"  on public.expenses;

drop policy if exists "anon all rooms"    on public.rooms;
drop policy if exists "anon all members"  on public.members;
drop policy if exists "anon all expenses" on public.expenses;

create policy "anon all rooms"    on public.rooms    for all using (true) with check (true);
create policy "anon all members"  on public.members  for all using (true) with check (true);
create policy "anon all expenses" on public.expenses for all using (true) with check (true);

grant select, insert, update, delete
  on public.rooms, public.members, public.expenses to anon, authenticated;

do $$
begin
  raise notice '되돌렸다 — 누구나 다시 열 수 있고 데이터는 그대로다';
end $$;
