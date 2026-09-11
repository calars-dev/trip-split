-- Trip Split — 영수증 여러 장
-- Run ONCE in Supabase: Dashboard > SQL Editor > New query > paste all > Run.
-- Safe to re-run. migration-receipt.sql 위에 얹는다 — 그게 먼저 돌아 있어야 한다.

-- receipt_path(단일, 예전 칸)는 그대로 둔다. 새 칸은 그 위에 여러 장을 담는 배열이고,
-- 앱은 항상 receipt_paths[0]도 receipt_path에 같이 써서 이 칸만 읽는 옛 코드도 계속 돈다.
alter table public.expenses add column if not exists receipt_paths jsonb not null default '[]'::jsonb;
