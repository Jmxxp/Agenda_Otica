-- Bloqueio inclusivo por loja ou para todas as lojas (store_id nulo).
-- Execute no SQL Editor do projeto configurado em supabase.js.
-- Depende das tabelas stores/profiles/appointments e dos helpers de perfil ja usados pelo app.
-- Agendamentos existentes sao preservados: criacao, remarcacao e reabertura sao impedidas.
-- A coordenacao concorrente usa o isolamento READ COMMITTED padrao da API Supabase.

begin;

create table if not exists public.schedule_blocks (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references public.stores(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  reason text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint schedule_blocks_valid_dates check (
    isfinite(start_date) and isfinite(end_date) and end_date >= start_date
  ),
  constraint schedule_blocks_reason_length check (char_length(reason) <= 240)
);

comment on column public.schedule_blocks.store_id is
  'NULL bloqueia todas as lojas; somente admin e optometrista podem criar ou remover esse bloqueio.';
comment on table public.schedule_blocks is
  'Bloqueios inclusivos de novos agendamentos e remarcacoes. Nao cancela atendimentos existentes.';

create index if not exists schedule_blocks_store_dates_idx
  on public.schedule_blocks (store_id, start_date, end_date);
create index if not exists schedule_blocks_global_dates_idx
  on public.schedule_blocks (start_date, end_date) where store_id is null;
create index if not exists schedule_blocks_created_by_idx
  on public.schedule_blocks (created_by);

alter table public.schedule_blocks enable row level security;
revoke all on table public.schedule_blocks from public, anon, authenticated;
grant select, insert, delete on table public.schedule_blocks to authenticated;
-- A identidade, autoria e data de criacao nao podem ser alteradas pelo cliente.
grant update (store_id, start_date, end_date, reason)
  on table public.schedule_blocks to authenticated;
grant all on table public.schedule_blocks to service_role;

drop policy if exists schedule_blocks_select on public.schedule_blocks;
create policy schedule_blocks_select
on public.schedule_blocks for select to authenticated
using (
  (select auth.uid()) is not null
  and (
    (select app_private.current_profile_role()) in ('admin', 'optometrist')
    or (
      (select app_private.current_profile_role()) = 'store'
      and (
        store_id is null
        or store_id = (select app_private.current_profile_store_id())
      )
    )
  )
);

drop policy if exists schedule_blocks_insert on public.schedule_blocks;
create policy schedule_blocks_insert
on public.schedule_blocks for insert to authenticated
with check (
  (select auth.uid()) is not null
  and created_by = (select auth.uid())
  and (
    (select app_private.current_profile_role()) in ('admin', 'optometrist')
    or (
      (select app_private.current_profile_role()) = 'store'
      and store_id = (select app_private.current_profile_store_id())
    )
  )
);

drop policy if exists schedule_blocks_update on public.schedule_blocks;
create policy schedule_blocks_update
on public.schedule_blocks for update to authenticated
using (
  (select auth.uid()) is not null
  and (
    (select app_private.current_profile_role()) in ('admin', 'optometrist')
    or (
      (select app_private.current_profile_role()) = 'store'
      and store_id = (select app_private.current_profile_store_id())
    )
  )
)
with check (
  (select auth.uid()) is not null
  and (
    (select app_private.current_profile_role()) in ('admin', 'optometrist')
    or (
      (select app_private.current_profile_role()) = 'store'
      and store_id = (select app_private.current_profile_store_id())
    )
  )
);

drop policy if exists schedule_blocks_delete on public.schedule_blocks;
create policy schedule_blocks_delete
on public.schedule_blocks for delete to authenticated
using (
  (select auth.uid()) is not null
  and (
    (select app_private.current_profile_role()) in ('admin', 'optometrist')
    or (
      (select app_private.current_profile_role()) = 'store'
      and store_id = (select app_private.current_profile_store_id())
    )
  )
);

-- As duas tabelas usam o mesmo lock de transacao. Atendimentos tomam o lock
-- compartilhado; bloquear/desbloquear toma o exclusivo. Assim, uma gravacao
-- concorrente em READ COMMITTED consulta os bloqueios ja confirmados antes
-- de aceitar o agendamento, sem serializar agendamentos entre si.
create or replace function app_private.lock_schedule_block_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(178261, 1);
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function app_private.lock_schedule_block_change()
  from public, anon, authenticated;

drop trigger if exists lock_schedule_block_change on public.schedule_blocks;
create trigger lock_schedule_block_change
before insert or update or delete on public.schedule_blocks
for each row execute function app_private.lock_schedule_block_change();

create or replace function app_private.enforce_appointment_schedule_block()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_block public.schedule_blocks;
begin
  -- O app envia data, hora e loja mesmo ao salvar outras alteracoes.
  -- Comparar valores preserva status, receitas e dados de atendimentos ja marcados,
  -- exceto reabrir um atendimento cancelado: isso volta a ocupar a agenda.
  if tg_op = 'UPDATE' then
    if new.store_id is not distinct from old.store_id
      and new.date is not distinct from old.date
      and new.time is not distinct from old.time
      and not (old.status is not distinct from 'cancelled' and new.status is distinct from 'cancelled') then
      return new;
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(178261, 1);

  select b.* into v_block
  from public.schedule_blocks b
  where (b.store_id is null or b.store_id = new.store_id)
    and new.date between b.start_date and b.end_date
  order by b.start_date, b.end_date, b.id
  limit 1;

  if found then
    raise exception using
      errcode = 'P0001',
      message = pg_catalog.format(
        'Agenda bloqueada de %s ate %s. Escolha outra data ou desbloqueie o periodo.',
        pg_catalog.to_char(v_block.start_date, 'DD/MM/YYYY'),
        pg_catalog.to_char(v_block.end_date, 'DD/MM/YYYY')
      );
  end if;

  return new;
end;
$$;

revoke all on function app_private.enforce_appointment_schedule_block()
  from public, anon, authenticated;

drop trigger if exists enforce_appointment_schedule_block on public.appointments;
create trigger enforce_appointment_schedule_block
before insert or update of store_id, date, time, status on public.appointments
for each row execute function app_private.enforce_appointment_schedule_block();

alter table public.schedule_blocks replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'schedule_blocks'
    ) then
    alter publication supabase_realtime add table public.schedule_blocks;
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
