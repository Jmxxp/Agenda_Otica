-- Permite que logins de loja vejam todas as lojas e agendamentos
-- na Agenda Geral, mas nao libera o cadastro completo de clientes
-- de outra loja porque as receitas ficam na tabela public.clients.

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

drop policy if exists "appointments_select_admin_optometrist_or_own_store" on public.appointments;
create policy "appointments_select_admin_optometrist_or_own_store"
on public.appointments
for select
to authenticated
using (
  (select app_private.current_profile_role()) in ('admin', 'optometrist', 'store')
);
