-- Execute se aparecer:
-- new row for relation "profiles" violates check constraint "store_profile_requires_store"

alter table public.profiles
  drop constraint if exists store_profile_requires_store;

alter table public.profiles
  add constraint store_profile_requires_store
  check (
    (role::text = 'store' and store_id is not null)
    or role::text in ('admin', 'optometrist')
  ) not valid;
