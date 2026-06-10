-- Permite que logins de loja vejam todas as lojas na Agenda Geral
-- e clientes/etiquetas de todas as lojas na tela "Todos".
-- Insert/update/delete continuam restritos pelas politicas ja existentes.

alter table public.stores enable row level security;
alter table public.clients enable row level security;
alter table public.appointments enable row level security;

grant select on table public.stores to authenticated;
grant select on table public.clients to authenticated;
grant select on table public.appointments to authenticated;

drop policy if exists "stores_select_admin_optometrist_or_own" on public.stores;
create policy "stores_select_admin_optometrist_or_own"
on public.stores
for select
to authenticated
using (
  app_private.current_profile_role() in ('admin', 'optometrist', 'store')
);

drop policy if exists "clients_select_admin_optometrist_or_own_store" on public.clients;
create policy "clients_select_admin_optometrist_or_own_store"
on public.clients
for select
to authenticated
using (
  app_private.current_profile_role() in ('admin', 'optometrist', 'store')
);

drop policy if exists "appointments_select_admin_optometrist_or_own_store" on public.appointments;
create policy "appointments_select_admin_optometrist_or_own_store"
on public.appointments
for select
to authenticated
using (
  app_private.current_profile_role() in ('admin', 'optometrist', 'store')
);
