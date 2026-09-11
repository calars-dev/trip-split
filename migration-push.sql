-- Trip Split — 새 지출 알림(Web Push) 구독
--
-- 순서는 어느 쪽이어도 된다. 표 하나와 함수 둘을 더할 뿐이라 지금 도는 앱이 그대로 돈다.
-- 여러 번 돌려도 안전하다.
--
-- 누가 지출을 넣으면 같은 여행의 나머지 사람 폰에 "정원호 · ¥3,000 · 라멘" 알림이 간다.
-- 폰마다 브라우저가 만들어 준 구독(푸시 서비스 주소 + 키 두 개)을 여기 둔다.
-- 보내는 쪽은 Edge Function `notify-expense` 이고, 서비스 롤로 이 표를 읽는다.
--
-- 표에 직접 손대는 길은 없다. RLS 를 켜고 정책을 하나도 두지 않았으므로 anon·authenticated
-- 둘 다 한 줄도 못 읽고 못 쓴다. 쓰는 건 아래 함수 둘뿐이고, 함수가 호출한 사람이 그 여행에
-- 자리를 가졌는지 먼저 본다.

create table if not exists public.push_subscriptions (
  endpoint   text primary key,                                   -- 폰 하나 = 주소 하나
  room_id    text not null references public.rooms(id)   on delete cascade,
  member_id  uuid not null references public.members(id) on delete cascade,
  p256dh     text not null,
  auth_key   text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_push_room on public.push_subscriptions (room_id);
alter table public.push_subscriptions enable row level security;

-- 내 폰을 이 여행 알림에 등록한다. 자리가 없으면 거짓.
create or replace function public.save_push_subscription(
  p_room text, p_endpoint text, p_p256dh text, p_auth text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  mid uuid;
begin
  if auth.uid() is null then return false; end if;
  if p_endpoint is null or p_endpoint !~ '^https://' then return false; end if;
  -- 총무 계정에는 공금 자리도 걸려 있을 수 있다. 사람 자리를 고른다.
  select id into mid from public.members
   where room_id = p_room and user_id = auth.uid() and coalesce(is_ledger, false) = false
   limit 1;
  if mid is null then return false; end if;

  insert into public.push_subscriptions (endpoint, room_id, member_id, p256dh, auth_key)
  values (p_endpoint, p_room, mid, p_p256dh, p_auth)
  on conflict (endpoint) do update
     set room_id = excluded.room_id, member_id = excluded.member_id,
         p256dh = excluded.p256dh, auth_key = excluded.auth_key, created_at = now();
  return true;
end;
$$;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;

-- 알림 끄기. 내 자리에 걸린 구독만 지운다.
create or replace function public.delete_push_subscription(p_endpoint text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  hit int;
begin
  if auth.uid() is null then return false; end if;
  delete from public.push_subscriptions s
   using public.members m
   where s.endpoint = p_endpoint and m.id = s.member_id and m.user_id = auth.uid();
  get diagnostics hit = row_count;
  return hit > 0;
end;
$$;
grant execute on function public.delete_push_subscription(text) to authenticated;

-- ── 확인 ────────────────────────────────────────────────────────────
--   select count(*) from public.push_subscriptions;   -- 처음엔 0
