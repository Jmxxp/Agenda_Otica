-- Execute este arquivo no SQL Editor do Supabase.
-- Lojas continuam vendo a agenda e os agendamentos de todas as lojas.
-- Somente o cadastro completo do cliente fica restrito por loja, porque
-- as receitas atual e nova ficam nas colunas da tabela public.clients.

alter table public.stores enable row level security;
alter table public.clients enable row level security;
alter table public.appointments enable row level security;

grant select on table public.stores to authenticated;
grant select, insert, update, delete on table public.clients to authenticated;
grant select, insert, update, delete on table public.appointments to authenticated;

drop policy if exists "stores_select_admin_optometrist_or_own" on public.stores;
create policy "stores_select_admin_optometrist_or_own"
on public.stores
for select
to authenticated
using (
  (select app_private.current_profile_role()) in ('admin', 'optometrist', 'store')
);

drop policy if exists "clients_select_admin_optometrist_or_own_store" on public.clients;
create policy "clients_select_admin_optometrist_or_own_store"
on public.clients
for select
to authenticated
using (
  (select app_private.current_profile_role()) in ('admin', 'optometrist')
  or store_id = (select app_private.current_profile_store_id())
);

drop policy if exists "clients_insert_admin_optometrist_or_own_store" on public.clients;
create policy "clients_insert_admin_optometrist_or_own_store"
on public.clients
for insert
to authenticated
with check (
  (select app_private.current_profile_role()) in ('admin', 'optometrist')
  or store_id = (select app_private.current_profile_store_id())
);

drop policy if exists "clients_update_admin_optometrist_or_own_store" on public.clients;
create policy "clients_update_admin_optometrist_or_own_store"
on public.clients
for update
to authenticated
using (
  (select app_private.current_profile_role()) in ('admin', 'optometrist')
  or store_id = (select app_private.current_profile_store_id())
)
with check (
  (select app_private.current_profile_role()) in ('admin', 'optometrist')
  or store_id = (select app_private.current_profile_store_id())
);

drop policy if exists "appointments_select_admin_optometrist_or_own_store" on public.appointments;
create policy "appointments_select_admin_optometrist_or_own_store"
on public.appointments
for select
to authenticated
using (
  (select app_private.current_profile_role()) in ('admin', 'optometrist', 'store')
);

drop policy if exists "appointments_insert_admin_optometrist_or_own_store" on public.appointments;
create policy "appointments_insert_admin_optometrist_or_own_store"
on public.appointments
for insert
to authenticated
with check (
  (select app_private.current_profile_role()) in ('admin', 'optometrist')
  or store_id = (select app_private.current_profile_store_id())
);

drop policy if exists "appointments_update_admin_optometrist_or_own_store" on public.appointments;
create policy "appointments_update_admin_optometrist_or_own_store"
on public.appointments
for update
to authenticated
using (
  (select app_private.current_profile_role()) in ('admin', 'optometrist')
  or store_id = (select app_private.current_profile_store_id())
)
with check (
  (select app_private.current_profile_role()) in ('admin', 'optometrist')
  or store_id = (select app_private.current_profile_store_id())
);

drop policy if exists "appointments_delete_admin_optometrist_or_own_store" on public.appointments;
create policy "appointments_delete_admin_optometrist_or_own_store"
on public.appointments
for delete
to authenticated
using (
  (select app_private.current_profile_role()) in ('admin', 'optometrist')
  or store_id = (select app_private.current_profile_store_id())
);

do $$
begin
  if to_regclass('public.prescription_notifications') is not null then
    execute 'alter table public.prescription_notifications enable row level security';
    execute 'grant select, insert, update, delete on table public.prescription_notifications to authenticated';

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
  end if;

  if to_regclass('public.appointment_notifications') is not null then
    execute 'alter table public.appointment_notifications enable row level security';
    execute 'grant select, insert, update, delete on table public.appointment_notifications to authenticated';

    execute 'drop policy if exists "appointment_notifications_store_select_own" on public.appointment_notifications';
    execute $policy$
      create policy "appointment_notifications_store_select_own"
      on public.appointment_notifications
      for select
      to authenticated
      using (
        (select app_private.current_profile_role()) in ('admin', 'optometrist')
        or (
          (select app_private.current_profile_role()) = 'store'
          and store_id = (select app_private.current_profile_store_id())
        )
      )
    $policy$;

    execute 'drop policy if exists "appointment_notifications_insert_allowed" on public.appointment_notifications';
    execute $policy$
      create policy "appointment_notifications_insert_allowed"
      on public.appointment_notifications
      for insert
      to authenticated
      with check (
        (select app_private.current_profile_role()) in ('admin', 'optometrist')
        or store_id = (select app_private.current_profile_store_id())
      )
    $policy$;

    execute 'drop policy if exists "appointment_notifications_store_update_own" on public.appointment_notifications';
    execute $policy$
      create policy "appointment_notifications_store_update_own"
      on public.appointment_notifications
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

    execute 'drop policy if exists "appointment_notifications_store_delete_own" on public.appointment_notifications';
    execute $policy$
      create policy "appointment_notifications_store_delete_own"
      on public.appointment_notifications
      for delete
      to authenticated
      using (
        (select app_private.current_profile_role()) = 'store'
        and store_id = (select app_private.current_profile_store_id())
      )
    $policy$;
  end if;
end $$;
