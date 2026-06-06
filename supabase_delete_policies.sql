-- Execute este arquivo no SQL Editor do Supabase.
-- Ele libera exclusao para admin e para a loja dona do registro.

alter table public.clients enable row level security;
alter table public.appointments enable row level security;

grant delete on table public.clients to authenticated;
grant delete on table public.appointments to authenticated;

drop policy if exists "clients_delete_admin_or_own_store" on public.clients;
create policy "clients_delete_admin_or_own_store"
on public.clients
for delete
to authenticated
using (
  exists (
    select 1
    from public.profiles profile
    where profile.id = (select auth.uid())
      and (
        profile.role = 'admin'
        or profile.store_id = clients.store_id
      )
  )
);

drop policy if exists "appointments_delete_admin_or_own_store" on public.appointments;
create policy "appointments_delete_admin_or_own_store"
on public.appointments
for delete
to authenticated
using (
  exists (
    select 1
    from public.profiles profile
    where profile.id = (select auth.uid())
      and (
        profile.role = 'admin'
        or profile.store_id = appointments.store_id
      )
  )
);
