-- Execute no SQL Editor do Supabase para habilitar:
-- - Receita atual e Nova receita no mesmo cliente;
-- - permissao da loja para editar somente a Receita atual;
-- - permissao do optometrista para editar somente a Nova receita;
-- - notificacoes persistentes por loja;
-- - Realtime para detectar nova receita pronta.
--
-- O campo "Adicao" fica dentro do JSON da receita, entao nao precisa de coluna extra.

create schema if not exists app_private;
create extension if not exists pgcrypto with schema extensions;

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

create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default '#2563eb',
  login_nick text,
  auth_email text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.app_role not null default 'store',
  store_id uuid references public.stores(id) on delete set null,
  full_name text,
  login_nick text,
  auth_email text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  phone text not null,
  email text,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  client_name text not null,
  client_phone text not null,
  date date not null,
  time time not null,
  notes text,
  status text not null default 'scheduled',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.stores
  add column if not exists name text,
  add column if not exists color text not null default '#2563eb',
  add column if not exists login_nick text,
  add column if not exists auth_email text,
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists created_at timestamptz not null default now();

alter table public.profiles
  add column if not exists role public.app_role not null default 'store',
  add column if not exists store_id uuid references public.stores(id) on delete set null,
  add column if not exists full_name text,
  add column if not exists login_nick text,
  add column if not exists auth_email text,
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists created_at timestamptz not null default now();

alter table public.clients
  add column if not exists store_id uuid references public.stores(id) on delete cascade,
  add column if not exists name text,
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists notes text,
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists created_at timestamptz not null default now();

alter table public.appointments
  add column if not exists store_id uuid references public.stores(id) on delete cascade,
  add column if not exists client_id uuid references public.clients(id) on delete set null,
  add column if not exists client_name text,
  add column if not exists client_phone text,
  add column if not exists date date,
  add column if not exists time time,
  add column if not exists notes text,
  add column if not exists status text not null default 'scheduled',
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists created_at timestamptz not null default now();

alter table public.profiles
  drop constraint if exists store_profile_requires_store;

alter table public.profiles
  add constraint store_profile_requires_store
  check (
    (role::text = 'store' and store_id is not null)
    or role::text in ('admin', 'optometrist')
  ) not valid;

create unique index if not exists stores_login_nick_unique
  on public.stores (login_nick)
  where login_nick is not null;

create unique index if not exists stores_auth_email_unique
  on public.stores (auth_email)
  where auth_email is not null;

create unique index if not exists profiles_login_nick_unique
  on public.profiles (login_nick)
  where login_nick is not null;

create unique index if not exists profiles_auth_email_unique
  on public.profiles (auth_email)
  where auth_email is not null;

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

create or replace function app_private.has_admin_profile()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where role::text = 'admin'
  )
$$;

grant usage on schema app_private to authenticated;
grant execute on function app_private.current_profile_role() to authenticated;
grant execute on function app_private.current_profile_store_id() to authenticated;
grant execute on function app_private.has_admin_profile() to authenticated;

alter table public.clients
  add column if not exists prescription text,
  add column if not exists prescription_updated_at timestamptz,
  add column if not exists prescription_updated_by uuid references auth.users(id),
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

alter table public.profiles enable row level security;
alter table public.stores enable row level security;
alter table public.clients enable row level security;
alter table public.appointments enable row level security;
alter table public.prescription_notifications enable row level security;
grant select, insert, update on table public.profiles to authenticated;
grant select, insert, update, delete on table public.stores to authenticated;
grant select, insert, update, delete on table public.clients to authenticated;
grant select, insert, update, delete on table public.appointments to authenticated;
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
    if new.new_prescription is distinct from old.new_prescription then
      if v_role = 'optometrist'
        and coalesce(trim(old.new_prescription), '') <> ''
        and coalesce(trim(new.new_prescription), '') = ''
      then
        raise exception 'Optometrista pode editar a nova receita, mas nao excluir';
      end if;

      if v_role = 'admin'
        and coalesce(trim(new.new_prescription), '') <> ''
      then
        raise exception 'Admin apenas exclui a nova receita';
      end if;

      if v_role not in ('optometrist', 'admin') then
        raise exception 'Apenas optometrista pode alterar a nova receita';
      end if;
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
alter table public.appointments replica identity full;
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

drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_admin"
on public.profiles
for select
to authenticated
using (
  id = auth.uid()
  or app_private.current_profile_role() = 'admin'
);

drop policy if exists "profiles_bootstrap_first_admin" on public.profiles;
create policy "profiles_bootstrap_first_admin"
on public.profiles
for insert
to authenticated
with check (
  id = auth.uid()
  and role::text = 'admin'
  and not app_private.has_admin_profile()
);

drop policy if exists "profiles_admin_insert_store_or_optometrist" on public.profiles;
create policy "profiles_admin_insert_store_or_optometrist"
on public.profiles
for insert
to authenticated
with check (
  app_private.current_profile_role() = 'admin'
  and role::text in ('store', 'optometrist')
);

drop policy if exists "profiles_admin_update" on public.profiles;
create policy "profiles_admin_update"
on public.profiles
for update
to authenticated
using (app_private.current_profile_role() = 'admin')
with check (app_private.current_profile_role() = 'admin');

drop policy if exists "stores_select_admin_optometrist_or_own" on public.stores;
create policy "stores_select_admin_optometrist_or_own"
on public.stores
for select
to authenticated
using (
  app_private.current_profile_role() in ('admin', 'optometrist')
  or id = app_private.current_profile_store_id()
);

drop policy if exists "stores_admin_insert" on public.stores;
create policy "stores_admin_insert"
on public.stores
for insert
to authenticated
with check (app_private.current_profile_role() = 'admin');

drop policy if exists "stores_admin_update" on public.stores;
create policy "stores_admin_update"
on public.stores
for update
to authenticated
using (app_private.current_profile_role() = 'admin')
with check (app_private.current_profile_role() = 'admin');

drop policy if exists "stores_admin_delete" on public.stores;
create policy "stores_admin_delete"
on public.stores
for delete
to authenticated
using (app_private.current_profile_role() = 'admin');

drop policy if exists "clients_select_admin_optometrist_or_own_store" on public.clients;
create policy "clients_select_admin_optometrist_or_own_store"
on public.clients
for select
to authenticated
using (
  app_private.current_profile_role() in ('admin', 'optometrist')
  or store_id = app_private.current_profile_store_id()
);

drop policy if exists "clients_insert_admin_optometrist_or_own_store" on public.clients;
create policy "clients_insert_admin_optometrist_or_own_store"
on public.clients
for insert
to authenticated
with check (
  app_private.current_profile_role() in ('admin', 'optometrist')
  or store_id = app_private.current_profile_store_id()
);

drop policy if exists "clients_update_admin_optometrist_or_own_store" on public.clients;
create policy "clients_update_admin_optometrist_or_own_store"
on public.clients
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

drop policy if exists "clients_delete_admin_optometrist_or_own_store" on public.clients;
drop policy if exists "clients_delete_admin_only" on public.clients;
create policy "clients_delete_admin_only"
on public.clients
for delete
to authenticated
using (
  app_private.current_profile_role() = 'admin'
);

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
drop policy if exists "prescription_notifications_insert_admin_or_optometrist" on public.prescription_notifications;
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
