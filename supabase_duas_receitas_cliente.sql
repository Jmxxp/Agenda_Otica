-- Execute no SQL Editor do Supabase para habilitar Receita atual + Nova receita.

create schema if not exists app_private;
create extension if not exists pgcrypto with schema extensions;

create or replace function app_private.current_profile_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role::text
  from public.profiles
  where id = auth.uid()
$$;

create or replace function app_private.current_profile_store_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select store_id
  from public.profiles
  where id = auth.uid()
$$;

grant usage on schema app_private to authenticated;
grant execute on function app_private.current_profile_role() to authenticated;
grant execute on function app_private.current_profile_store_id() to authenticated;

alter table public.clients
  add column if not exists new_prescription text,
  add column if not exists new_prescription_updated_at timestamptz,
  add column if not exists new_prescription_updated_by uuid references auth.users(id);

create table if not exists public.prescription_notifications (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  client_name text,
  message text not null,
  read_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.prescription_notifications enable row level security;
grant select, insert, update on table public.prescription_notifications to authenticated;

create or replace function app_private.enforce_client_prescription_roles()
returns trigger
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_role text;
begin
  v_role := app_private.current_profile_role();

  if tg_op = 'INSERT' then
    if new.new_prescription is not null and v_role <> 'optometrist' then
      raise exception 'Apenas optometrista pode preencher a nova receita';
    end if;

    if new.prescription is not null and v_role = 'optometrist' then
      raise exception 'Optometrista nao altera a receita atual';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if new.new_prescription is distinct from old.new_prescription and v_role <> 'optometrist' then
      raise exception 'Apenas optometrista pode alterar a nova receita';
    end if;

    if new.prescription is distinct from old.prescription and v_role = 'optometrist' then
      raise exception 'Optometrista nao altera a receita atual';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_client_prescription_roles on public.clients;
create trigger enforce_client_prescription_roles
before insert or update on public.clients
for each row
execute function app_private.enforce_client_prescription_roles();

alter table public.clients replica identity full;
alter table public.prescription_notifications replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'prescription_notifications'
  ) then
    alter publication supabase_realtime add table public.prescription_notifications;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'clients'
  ) then
    alter publication supabase_realtime add table public.clients;
  end if;
end $$;

drop policy if exists "prescription_notifications_store_select_own" on public.prescription_notifications;
create policy "prescription_notifications_store_select_own"
on public.prescription_notifications
for select
to authenticated
using (
  app_private.current_profile_role() = 'store'
  and store_id = app_private.current_profile_store_id()
);

drop policy if exists "prescription_notifications_insert_optometrist" on public.prescription_notifications;
create policy "prescription_notifications_insert_optometrist"
on public.prescription_notifications
for insert
to authenticated
with check (
  app_private.current_profile_role() = 'optometrist'
);

drop policy if exists "prescription_notifications_store_update_own" on public.prescription_notifications;
create policy "prescription_notifications_store_update_own"
on public.prescription_notifications
for update
to authenticated
using (
  app_private.current_profile_role() = 'store'
  and store_id = app_private.current_profile_store_id()
)
with check (
  app_private.current_profile_role() = 'store'
  and store_id = app_private.current_profile_store_id()
);
