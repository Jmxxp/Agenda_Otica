-- Execute este arquivo no SQL Editor do Supabase.
-- Recursos:
-- - perfil optometrist criado pelo admin;
-- - receita no cliente;
-- - notificacao de receita apenas para a loja vinculada;
-- - policies para admin/optometrista/loja.

alter type public.app_role add value if not exists 'optometrist';

create schema if not exists app_private;

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

alter table public.profiles
  add column if not exists login_nick text,
  add column if not exists auth_email text,
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

create unique index if not exists profiles_login_nick_unique
  on public.profiles (login_nick)
  where login_nick is not null;

create unique index if not exists profiles_auth_email_unique
  on public.profiles (auth_email)
  where auth_email is not null;

alter table public.clients
  add column if not exists prescription text,
  add column if not exists prescription_updated_at timestamptz,
  add column if not exists prescription_updated_by uuid references auth.users(id);

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

alter table public.prescription_notifications replica identity full;
alter table public.clients replica identity full;

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

alter table public.profiles enable row level security;
alter table public.stores enable row level security;
alter table public.clients enable row level security;
alter table public.appointments enable row level security;
alter table public.prescription_notifications enable row level security;

grant select, insert, update on table public.profiles to authenticated;
grant select on table public.stores to authenticated;
grant select, insert, update, delete on table public.clients to authenticated;
grant select, insert, update, delete on table public.appointments to authenticated;
grant select, insert, update on table public.prescription_notifications to authenticated;

create extension if not exists pgcrypto with schema extensions;

create or replace function public.admin_update_optometrist(
  p_profile_id uuid,
  p_name text,
  p_login_nick text,
  p_password text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_profile public.profiles;
  v_login_nick text;
  v_auth_email text;
begin
  if app_private.current_profile_role() <> 'admin' then
    raise exception 'Apenas administradores podem editar optometristas';
  end if;

  v_login_nick := lower(trim(p_login_nick));
  v_auth_email := v_login_nick || '@agenda.local';

  if trim(coalesce(p_name, '')) = '' or length(v_login_nick) < 3 then
    raise exception 'Informe nome e nick validos';
  end if;

  if p_password is not null and length(p_password) < 6 then
    raise exception 'A senha precisa ter pelo menos 6 caracteres';
  end if;

  if exists (
    select 1
    from public.stores
    where login_nick = v_login_nick
      or auth_email = v_auth_email
  ) then
    raise exception 'Este nick ja esta em uso';
  end if;

  if exists (
    select 1
    from public.profiles
    where id <> p_profile_id
      and (
        login_nick = v_login_nick
        or auth_email = v_auth_email
      )
  ) then
    raise exception 'Este nick ja esta em uso';
  end if;

  update auth.users
  set
    email = v_auth_email,
    encrypted_password = case
      when p_password is null then encrypted_password
      else extensions.crypt(p_password, extensions.gen_salt('bf'))
    end,
    raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
      || jsonb_build_object('name', trim(p_name), 'nick', v_login_nick, 'role', 'optometrist'),
    updated_at = now()
  where id = p_profile_id;

  update auth.identities
  set
    provider_id = v_auth_email,
    identity_data = coalesce(identity_data, '{}'::jsonb)
      || jsonb_build_object('email', v_auth_email, 'email_verified', true, 'phone_verified', false, 'sub', p_profile_id::text),
    updated_at = now()
  where user_id = p_profile_id
    and provider = 'email';

  update public.profiles
  set
    full_name = trim(p_name),
    login_nick = v_login_nick,
    auth_email = v_auth_email,
    store_id = null
  where id = p_profile_id
    and role::text = 'optometrist'
  returning * into v_profile;

  if v_profile.id is null then
    raise exception 'Optometrista nao encontrado';
  end if;

  return v_profile;
end;
$$;

grant execute on function public.admin_update_optometrist(uuid, text, text, text) to authenticated;

drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_admin"
on public.profiles
for select
to authenticated
using (
  id = auth.uid()
  or app_private.current_profile_role() = 'admin'
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

drop policy if exists "stores_select_admin_optometrist_or_own" on public.stores;
create policy "stores_select_admin_optometrist_or_own"
on public.stores
for select
to authenticated
using (
  app_private.current_profile_role() in ('admin', 'optometrist')
  or id = app_private.current_profile_store_id()
);

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
create policy "clients_delete_admin_optometrist_or_own_store"
on public.clients
for delete
to authenticated
using (
  app_private.current_profile_role() in ('admin', 'optometrist')
  or store_id = app_private.current_profile_store_id()
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

drop policy if exists "prescription_notifications_insert_admin_or_optometrist" on public.prescription_notifications;
create policy "prescription_notifications_insert_admin_or_optometrist"
on public.prescription_notifications
for insert
to authenticated
with check (
  app_private.current_profile_role() in ('admin', 'optometrist')
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
