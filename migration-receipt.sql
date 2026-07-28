-- Trip Split — receipt photos
-- Run ONCE in Supabase: Dashboard > SQL Editor > New query > paste all > Run.
-- Safe to re-run.

-- ── 1. where the file lives ────────────────────────────────────────
-- Only the key is stored, e.g. "ttgkxsg/a1b2c3d4". The full photo is
-- "<key>.jpg" and the list thumbnail is "<key>_t.jpg".
alter table public.expenses add column if not exists receipt_path text;

-- ── 2. storage bucket ──────────────────────────────────────────────
-- Public: the app has no login, so a room link is already the only key
-- there is. Receipts follow the same model — anyone with the image URL
-- can open it. Keep that in mind before photographing a card statement.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- ── 3. who may touch it ────────────────────────────────────────────
-- Same link-based model as the tables: the anon key may do everything,
-- but only inside this one bucket.
drop policy if exists "receipts read"   on storage.objects;
drop policy if exists "receipts write"  on storage.objects;
drop policy if exists "receipts update" on storage.objects;
drop policy if exists "receipts delete" on storage.objects;

create policy "receipts read"   on storage.objects for select
  using (bucket_id = 'receipts');
create policy "receipts write"  on storage.objects for insert
  with check (bucket_id = 'receipts');
create policy "receipts update" on storage.objects for update
  using (bucket_id = 'receipts') with check (bucket_id = 'receipts');
create policy "receipts delete" on storage.objects for delete
  using (bucket_id = 'receipts');
