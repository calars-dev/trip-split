-- Trip Split — 계정 (1/2: 그릇 만들기)
--
-- 이 파일은 표와 칸, 함수만 추가한다. 접근 정책은 건드리지 않으므로 **지금 쓰는
-- 앱이 그대로 돈다.** 계정 기능이 들어간 앱을 배포한 뒤에 2/2 를 실행한다.
-- 여러 번 돌려도 안전하다.
--
-- 순서
--   ① 대시보드 Authentication → "Confirm email" 끄기          (완료)
--   ② 이 파일 실행                                            ← 지금
--   ③ reset_password 가 실제로 먹는지 확인 (아래 맨 끝 주석)
--   ④ 계정 기능이 들어간 앱 배포
--   ⑤ migration-accounts-2.sql 실행 (여기서 비로소 남의 여행이 안 보인다)

create extension if not exists pgcrypto with schema extensions;

-- ── 1. 프로필 ───────────────────────────────────────────────────────
-- 로그인은 Supabase 가 맡고(auth.users), 여기엔 사람이 보는 것만 둔다.
-- handle 은 로그인용 아이디, name 은 화면에 뜨는 이름. 보통 둘 다 "민수" 지만,
-- 흔한 이름은 먼저 가져간 사람이 있을 수 있어 아이디만 "민수2" 가 될 수 있다.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  handle     text not null unique,
  name       text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_profiles_handle_lower
  on public.profiles (lower(handle));

-- 비밀번호 찾기용 질문과 답은 **다른 표에** 둔다.
-- 같은 표에 두고 컬럼 권한으로 가리면, 나중에 누가 `select('*')` 를 쓰거나
-- insert 뒤에 `.select()` 를 붙이는 순간 "permission denied for column" 으로
-- 깨진다(RETURNING 도 SELECT 권한을 본다). 표를 나누면 그 지뢰가 없어진다.
create table if not exists public.profile_secrets (
  id          uuid primary key references public.profiles(id) on delete cascade,
  hint_q      text,
  hint_hash   text,
  hint_tries  int not null default 0,
  hint_locked timestamptz
);

alter table public.profiles        enable row level security;
alter table public.profile_secrets enable row level security;

-- 프로필은 **자기 것만** 읽는다. 남의 아이디 목록을 통째로 긁어가지 못하게.
drop policy if exists "profiles read"   on public.profiles;
drop policy if exists "profiles insert" on public.profiles;
drop policy if exists "profiles update" on public.profiles;
create policy "profiles read"   on public.profiles for select
  using (auth.uid() = id);
create policy "profiles insert" on public.profiles for insert
  with check (auth.uid() = id);
create policy "profiles update" on public.profiles for update
  using (auth.uid() = id) with check (auth.uid() = id);

-- 비밀은 본인도 읽을 필요가 없다. 오직 아래 함수들만 만진다.
drop policy if exists "secrets insert" on public.profile_secrets;
create policy "secrets insert" on public.profile_secrets for insert
  with check (auth.uid() = id);

revoke all on public.profiles        from anon, authenticated;
revoke all on public.profile_secrets from anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
grant insert on public.profile_secrets to authenticated;

-- ── 2. 아이디 중복 확인 ─────────────────────────────────────────────
-- 가입 화면에서 "이 이름 쓸 수 있나" 하나만 물으면 되므로, 표를 열어주는 대신
-- 예/아니오만 답한다.
create or replace function public.handle_available(p_handle text)
returns boolean
language sql stable security definer
set search_path = pg_temp
as $$
  select not exists (
    select 1 from public.profiles where lower(handle) = lower(btrim(p_handle))
  );
$$;
revoke all on function public.handle_available(text) from public;
grant execute on function public.handle_available(text) to anon, authenticated;

-- ── 3. 비밀번호 찾기 ────────────────────────────────────────────────
-- 이메일을 안 쓰므로 재설정 메일도 없다. 답은 해시해서만 저장한다.
create or replace function public.hint_question(p_handle text)
returns text
language sql stable security definer
set search_path = pg_temp
as $$
  select s.hint_q
    from public.profiles p join public.profile_secrets s on s.id = p.id
   where lower(p.handle) = lower(btrim(p_handle));
$$;
revoke all on function public.hint_question(text) from public;
grant execute on function public.hint_question(text) to anon, authenticated;

-- 답이 맞으면 비밀번호를 바꿔준다. 로그인을 못 하는 상황이라 본인이 직접
-- 바꿀 수 없으므로 서버가 대신 한다. 5번 틀리면 15분 잠근다.
--
-- 공백 제거는 btrim 에 탭·개행까지 넣는다. 앱(JS)의 .trim() 은 그것들도 지우는데
-- Postgres 기본 trim 은 스페이스만 지워서, 답 끝에 개행이 붙으면 맞는 답인데도
-- 틀렸다고 나온다.
create or replace function public.reset_password(p_handle text, p_answer text, p_new_pw text)
returns text
language plpgsql volatile security definer
set search_path = pg_temp
as $$
declare
  v_id uuid; v_hash text; v_tries int; v_locked timestamptz;
  ws constant text := E' \t\n\r ';
begin
  if length(coalesce(p_new_pw, '')) < 6 then return 'short'; end if;

  select p.id, s.hint_hash, s.hint_tries, s.hint_locked
    into v_id, v_hash, v_tries, v_locked
    from public.profiles p join public.profile_secrets s on s.id = p.id
   where lower(p.handle) = lower(btrim(p_handle));

  if v_id is null or v_hash is null then return 'nohint'; end if;
  if v_locked is not null and v_locked > now() then return 'locked'; end if;

  if v_hash <> encode(extensions.digest(
       lower(btrim(p_answer, ws)) || ':' || v_id::text, 'sha256'), 'hex') then
    update public.profile_secrets
       set hint_tries  = case when hint_tries >= 4 then 0 else hint_tries + 1 end,
           hint_locked = case when hint_tries >= 4 then now() + interval '15 minutes' else hint_locked end
     where id = v_id;
    return 'wrong';
  end if;

  -- GoTrue 는 해시에 박힌 cost 를 읽어 검증하므로 bcrypt 면 로그인이 된다.
  -- 기본 cost 6 은 GoTrue 기본(10)보다 약해서 10 으로 맞춘다.
  update auth.users
     set encrypted_password = extensions.crypt(p_new_pw, extensions.gen_salt('bf', 10)),
         updated_at = now()
   where id = v_id;

  update public.profile_secrets set hint_tries = 0, hint_locked = null where id = v_id;
  return 'ok';
end $$;
revoke all on function public.reset_password(text, text, text) from public;
grant execute on function public.reset_password(text, text, text) to anon, authenticated;

-- ── 4. 기존 표에 주인 붙이기 ────────────────────────────────────────
-- members 한 줄이 곧 "그 여행에 참여한 사람" 이다. 지금은 이름만 있고 계정이
-- 없으니, 나중에 각자 로그인해서 "이 사람이 나예요" 를 고르면 여기 채워진다.
alter table public.members add column if not exists user_id uuid references auth.users(id);
alter table public.rooms   add column if not exists created_by uuid references auth.users(id);

create index if not exists idx_members_user on public.members(user_id);
create unique index if not exists idx_members_room_user
  on public.members(room_id, user_id) where user_id is not null;

-- ── 5. 확인 ─────────────────────────────────────────────────────────
do $$
begin
  perform 1 from information_schema.columns
    where table_schema='public' and table_name='members' and column_name='user_id';
  if not found then raise exception 'members.user_id 가 안 생겼다'; end if;

  -- auth.users 를 정말 고칠 수 있는지. 못 고치면 비밀번호 찾기가 조용히 죽는다.
  if not has_table_privilege(current_user, 'auth.users', 'UPDATE') then
    raise warning '이 역할(%)은 auth.users 를 못 고친다 — 비밀번호 찾기가 동작하지 않는다', current_user;
  else
    raise notice 'auth.users 수정 권한 있음 (%) — 비밀번호 찾기 가능', current_user;
  end if;

  raise notice '준비 완료 — 아직 아무것도 잠기지 않았고 앱은 그대로 돈다';
end $$;

-- ③ 확인용: 실행 후 아래를 따로 돌려 'ok' 가 나오는지 본다.
--    (테스트 계정을 앱에서 하나 만든 뒤)
--    select public.reset_password('테스트아이디', '그때 적은 답', '654321');
