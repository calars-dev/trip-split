-- Migration: per-expense FX rate, so foreign-currency spending settles in KRW.
-- Run once in Supabase SQL Editor if your DB was created before this feature.
alter table public.expenses
  add column if not exists rate_krw    numeric,  -- KRW per 1 unit of `currency` (null when currency = KRW)
  add column if not exists rate_date   date,     -- business day the rate came from (weekend -> prior weekday)
  add column if not exists rate_source text;     -- 'api' | 'room' | 'manual' | 'fallback'

-- Room-level fallback rate: the last rate successfully fetched by any client.
-- Used when an expense is saved while offline, and for rows that predate this feature.
alter table public.rooms
  add column if not exists base_rate_jpy  numeric,
  add column if not exists base_rate_date date;
