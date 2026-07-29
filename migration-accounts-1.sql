-- Trip Split — 계정 (1/2: 그릇 만들기)
--
-- 이 파일은 칸과 표만 추가한다. 접근 정책은 건드리지 않으므로 **지금 쓰는 앱이
-- 그대로 돈다.** 계정 기능이 들어간 앱을 배포한 뒤에 2/2 를 실행한다.
--
-- 순서
--   ① 대시보드에서 Authentication → Email → "Confirm email" 끄기
--   ② 이 파일 실행                    ← 지금
--   ③ 계정 기능이 들어간 앱 배포
--   ④ migration-accounts-2.sql 실행 (여기서 비로소 남의 여행이 안 보이게 된다)

-- ── 1. 프로필 ───────────────────────────────────────────────────────
-- 로그인은 Supabase 가 맡고(auth.users), 여기엔 사람이 보는 것만 둔다.
-- handle 은 로그인용 아이디, name 은 화면에 뜨는 이름. 보통 둘 다 "민수" 지만,
-- 흔한 이름은 먼저 가져간 사람이 있을 수 있어서 아이디만 "민수2" 가 될 수 있다.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  handle     text not null unique,
  name       text not null,
  created_at timestamptz not null default now()
);

-- 비밀번호 찾기용 질문과 답. 이메일을 안 쓰므로 재설정 메일도 없다.
-- 답은 해시해서 넣는다(원문 저장 안 함). 소문자·앞뒤 공백은 무시해서
-- "우리집 강아지" 와 " 우리집 강아지 " 가 갈리지 않게 한다.
alter table public.profiles add column if not exists hint_q     text;
alter table public.profiles add column if not exists hint_hash  text;
alter table public.profiles add column if not exists hint_tries  int  not null default 0;
alter table public.profiles add column if not exists hint_locked timestamptz;

-- 아이디는 2~8자. 대소문자·앞뒤 공백으로 갈리지 않게 소문자로 눕혀 저장한다.
create unique index if not exists idx_profiles_handle_lower
  on public.profiles (lower(handle));

alter table public.profiles enable row level security;

-- 가입할 때 "이 아이디 쓸 수 있나"를 물어야 하므로 handle 은 누구나 읽는다.
drop policy if exists "profiles read"   on public.profiles;
drop policy if exists "profiles insert" on public.profiles;
drop policy if exists "profiles update" on public.profiles;
create policy "profiles read"   on public.profiles for select using (true);
create policy "profiles insert" on public.profiles for insert
  with check (auth.uid() = id);
create policy "profiles update" on public.profiles for update
  using (auth.uid() = id) with check (auth.uid() = id);

-- 답 해시와 시도 횟수는 아무도 못 읽는다. 질문 문구는 찾기 화면에 띄워야 하므로
-- 아래 함수로만 꺼낸다.
revoke select on public.profiles from anon, authenticated;
grant select (id, handle, name, created_at) on public.profiles to anon, authenticated;
grant insert, update on public.profiles to authenticated;

-- ── 비밀번호 찾기 ───────────────────────────────────────────────────
create extension if not exists pgcrypto with schema extensions;

-- 아이디로 질문만 꺼내온다. 없는 아이디여도 같은 모양으로 답해서
-- "이 아이디가 있는지" 를 떠보는 데 쓰이지 않게 한다.
create or replace function public.hint_question(p_handle text)
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p.hint_q from public.profiles p where lower(p.handle) = lower(trim(p_handle));
$$;
revoke all on function public.hint_question(text) from public;
grant execute on function public.hint_question(text) to anon, authenticated;

-- 답이 맞으면 비밀번호를 바꿔준다. 로그인을 못 하는 상황이라 본인이 직접
-- 바꿀 수 없으므로 서버가 대신 한다. 찍어 맞히는 걸 막으려고 5번 틀리면
-- 15분 잠근다.
create or replace function public.reset_password(p_handle text, p_answer text, p_new_pw text)
returns text
language plpgsql volatile security definer
set search_path = public, extensions, auth, pg_temp
as $$
declare
  v_id uuid; v_hash text; v_tries int; v_locked timestamptz;
begin
  if length(coalesce(p_new_pw, '')) < 6 then return 'short'; end if;

  select id, hint_hash, hint_tries, hint_locked
    into v_id, v_hash, v_tries, v_locked
    from public.profiles where lower(handle) = lower(trim(p_handle));

  if v_id is null or v_hash is null then return 'nohint'; end if;
  if v_locked is not null and v_locked > now() then return 'locked'; end if;

  if v_hash <> encode(digest(lower(trim(p_answer)) || ':' || v_id::text, 'sha256'), 'hex') then
    update public.profiles
       set hint_tries = case when hint_tries >= 4 then 0 else hint_tries + 1 end,
           hint_locked = case when hint_tries >= 4 then now() + interval '15 minutes' else hint_locked end
     where id = v_id;
    return 'wrong';
  end if;

  update auth.users
     set encrypted_password = crypt(p_new_pw, gen_salt('bf')),
         updated_at = now()
   where id = v_id;

  update public.profiles set hint_tries = 0, hint_locked = null where id = v_id;
  return 'ok';
end $$;
revoke all on function public.reset_password(text, text, text) from public;
grant execute on function public.reset_password(text, text, text) to anon, authenticated;

-- ── 2. 기존 표에 주인 붙이기 ────────────────────────────────────────
-- members 한 줄이 곧 "그 여행에 참여한 사람" 이다. 지금은 이름만 있고 계정이
-- 없으니, 나중에 각자 로그인해서 "이 사람이 나예요" 를 고르면 여기에 채워진다.
alter table public.members add column if not exists user_id uuid references auth.users(id);
alter table public.rooms   add column if not exists created_by uuid references auth.users(id);

create index if not exists idx_members_user on public.members(user_id);

-- 한 여행에서 한 계정이 두 사람일 수는 없다.
create unique index if not exists idx_members_room_user
  on public.members(room_id, user_id) where user_id is not null;

-- ── 3. 확인 ─────────────────────────────────────────────────────────
do $$
begin
  perform 1 from information_schema.columns
    where table_schema='public' and table_name='members' and column_name='user_id';
  if not found then raise exception 'members.user_id 가 안 생겼다'; end if;

  perform 1 from information_schema.tables
    where table_schema='public' and table_name='profiles';
  if not found then raise exception 'profiles 표가 안 생겼다'; end if;

  raise notice '준비 완료 — 아직 아무것도 잠기지 않았고 앱은 그대로 돈다';
end $$;
