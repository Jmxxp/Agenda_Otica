-- Execute no SQL Editor do Supabase para receitas e agendamentos chegarem em tempo real.
-- Garante publication, replica identity e policies de notificacao com RLS ativo.

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

do $$
begin
  if to_regclass('public.clients') is not null then
    execute 'alter table public.clients replica identity full';

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'clients'
    ) then
      alter publication supabase_realtime add table public.clients;
    end if;
  end if;

  if to_regclass('public.appointments') is not null then
    execute 'alter table public.appointments replica identity full';

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'appointments'
    ) then
      alter publication supabase_realtime add table public.appointments;
    end if;
  end if;

  if to_regclass('public.prescription_notifications') is not null then
    execute 'alter table public.prescription_notifications enable row level security';
    execute 'grant select, insert, update, delete on table public.prescription_notifications to authenticated';
    execute 'alter table public.prescription_notifications replica identity full';

    execute 'drop policy if exists "prescription_notifications_store_select_own" on public.prescription_notifications';
    execute $policy$
      create policy "prescription_notifications_store_select_own"
      on public.prescription_notifications
      for select
      to authenticated
      using (
        (select app_private.current_profile_role()) = 'store'
        and store_id = (select app_private.current_profile_store_id())
      )
    $policy$;

    execute 'drop policy if exists "prescription_notifications_insert_optometrist" on public.prescription_notifications';
    execute 'drop policy if exists "prescription_notifications_insert_admin_or_optometrist" on public.prescription_notifications';
    execute $policy$
      create policy "prescription_notifications_insert_admin_or_optometrist"
      on public.prescription_notifications
      for insert
      to authenticated
      with check (
        (select app_private.current_profile_role()) in ('admin', 'optometrist')
      )
    $policy$;

    execute 'drop policy if exists "prescription_notifications_store_update_own" on public.prescription_notifications';
    execute $policy$
      create policy "prescription_notifications_store_update_own"
      on public.prescription_notifications
      for update
      to authenticated
      using (
        (select app_private.current_profile_role()) = 'store'
        and store_id = (select app_private.current_profile_store_id())
      )
      with check (
        (select app_private.current_profile_role()) = 'store'
        and store_id = (select app_private.current_profile_store_id())
      )
    $policy$;

    execute 'drop policy if exists "prescription_notifications_store_delete_own" on public.prescription_notifications';
    execute $policy$
      create policy "prescription_notifications_store_delete_own"
      on public.prescription_notifications
      for delete
      to authenticated
      using (
        (select app_private.current_profile_role()) = 'store'
        and store_id = (select app_private.current_profile_store_id())
      )
    $policy$;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'prescription_notifications'
    ) then
      alter publication supabase_realtime add table public.prescription_notifications;
    end if;
  end if;

  if to_regclass('public.appointment_notifications') is not null then
    execute 'alter table public.appointment_notifications replica identity full';

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'appointment_notifications'
    ) then
      alter publication supabase_realtime add table public.appointment_notifications;
    end if;
  end if;
end $$;
