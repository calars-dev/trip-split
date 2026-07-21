-- Migration: add "settled" flag to expenses (for on-the-spot payments
-- that should be excluded from the final settlement).
-- Run once in Supabase SQL Editor if your DB was created before this feature.
alter table public.expenses
  add column if not exists settled boolean not null default false;
