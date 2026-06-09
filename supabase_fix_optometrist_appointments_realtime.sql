-- Execute no SQL Editor do Supabase se a loja ve agendamentos em tempo real,
-- mas o optometrista so ve depois de atualizar a pagina.

do $$
begin
  if not exists (
    select 1
    from pg_type
    where typnamespace = 'public'::regnamespace
      and typname = 'app_role'
  ) then
    create type public.app_role as enum ('admin', 'store', 'optometrist');
  end if;
end $$;

alter type public.app_role add value if not exists 'admin';
alter type public.app_role add value if not exists 'store';
alter type public.app_role add value if not exists 'optometrist';

alter table public.profiles
  drop constraint if exists store_profile_requires_store;

alter table public.profiles
  add constraint store_profile_requires_store
  check (
    (role::text = 'store' and store_id is not null)
    or role::text in ('admin', 'optometrist')
  ) not valid;

create schema if not exists app_private;

create or replace function app_private.current_profile_role()
returns text
language sql
security definer
set search_path = public, app_private
as $$
  select role::text
  from public.profiles
  where id = auth.uid()
$$;

create or replace function app_private.current_profile_store_id()
returns uuid
language sql
security definer
set search_path = public, app_private
as $$
  select store_id
  from public.profiles
  where id = auth.uid()
$$;

grant execute on function app_private.current_profile_role() to authenticated;
grant execute on function app_private.current_profile_store_id() to authenticated;

alter table public.appointments enable row level security;
grant select, insert, update, delete on table public.appointments to authenticated;

drop policy if exists "appointments_select_admin_optometrist_or_own_store" on public.appointments;
create policy "appointments_select_admin_optometrist_or_own_store"
on public.appointments
for select
to authenticated
using (
  app_private.current_profile_role() in ('admin', 'optometrist')
  or store_id = app_private.current_profile_store_id()
);

drop policy if exists "appointments_insert_admin_optometrist_or_own_store" on public.appointments;
create policy "appointments_insert_admin_optometrist_or_own_store"
on public.appointments
for insert
to authenticated
with check (
  app_private.current_profile_role() in ('admin', 'optometrist')
  or store_id = app_private.current_profile_store_id()
);

drop policy if exists "appointments_update_admin_optometrist_or_own_store" on public.appointments;
create policy "appointments_update_admin_optometrist_or_own_store"
on public.appointments
for update
to authenticated
using (
  app_private.current_profile_role() in ('admin', 'optometrist')
  or store_id = app_private.current_profile_store_id()
)
with check (
  app_private.current_profile_role() in ('admin', 'optometrist')
  or store_id = app_private.current_profile_store_id()
);

drop policy if exists "appointments_delete_admin_optometrist_or_own_store" on public.appointments;
create policy "appointments_delete_admin_optometrist_or_own_store"
on public.appointments
for delete
to authenticated
using (
  app_private.current_profile_role() in ('admin', 'optometrist')
  or store_id = app_private.current_profile_store_id()
);

alter table public.appointments replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'appointments'
  ) then
    alter publication supabase_realtime add table public.appointments;
  end if;
end $$;
