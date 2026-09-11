-- Trip Split — 지운 지출 되돌리기 (쓰레기통)
-- Run ONCE in Supabase: Dashboard > SQL Editor > New query > paste all > Run.
-- Safe to re-run.

-- 지금까지는 지우면 그 자리에서 영구히 없어졌다. 이제는 이 칸에 시간만 찍어두고
-- 실제로는 지우지 않는다 — 기록 화면의 🗑 에서 언제든 되돌릴 수 있다.
alter table public.expenses add column if not exists deleted_at timestamptz;
