-- CORRECAO CRITICA: impede que um agendamento use o cadastro/receita de outra pessoa.
-- Execute este arquivo uma vez no SQL Editor do Supabase.
--
-- A primeira etapa corrige automaticamente apenas vinculos inequivocos:
-- mesma loja + mesmo telefone e exatamente um cliente correspondente.
-- Casos ambiguos ficam intocados e passam a ser bloqueados pelo app/trigger.

with unique_matches as (
  select
    a.id as appointment_id,
    (array_agg(c.id))[1] as correct_client_id
  from public.appointments a
  join public.clients c
    on c.store_id = a.store_id
   and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')
       = regexp_replace(coalesce(a.client_phone, ''), '[^0-9]', '', 'g')
  where regexp_replace(coalesce(a.client_phone, ''), '[^0-9]', '', 'g') <> ''
  group by a.id
  having count(*) = 1
)
update public.appointments a
set client_id = matches.correct_client_id
from unique_matches matches
where a.id = matches.appointment_id
  and a.client_id is distinct from matches.correct_client_id;

create schema if not exists app_private;

create or replace function app_private.enforce_appointment_client_identity()
returns trigger
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_client public.clients;
  v_appointment_phone text;
  v_client_phone text;
begin
  if new.client_id is null then
    return new;
  end if;

  select *
  into v_client
  from public.clients
  where id = new.client_id;

  if v_client.id is null then
    raise exception 'Cliente vinculado ao agendamento nao existe';
  end if;

  v_appointment_phone := regexp_replace(coalesce(new.client_phone, ''), '[^0-9]', '', 'g');
  v_client_phone := regexp_replace(coalesce(v_client.phone, ''), '[^0-9]', '', 'g');

  if v_client.store_id is distinct from new.store_id
    or v_appointment_phone = ''
    or v_client_phone is distinct from v_appointment_phone
  then
    raise exception 'client_id nao corresponde a loja e telefone do agendamento';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_appointment_client_identity on public.appointments;
create trigger enforce_appointment_client_identity
before insert or update of client_id, store_id, client_phone
on public.appointments
for each row
execute function app_private.enforce_appointment_client_identity();

-- Impede que uma mesma loja tenha dois cadastros com o mesmo telefone.
-- Duplicidades antigas nao sao apagadas automaticamente; elas precisam de revisao.
create or replace function app_private.enforce_unique_client_phone()
returns trigger
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_phone text;
begin
  v_phone := regexp_replace(coalesce(new.phone, ''), '[^0-9]', '', 'g');

  if v_phone = '' then
    raise exception 'Cliente precisa ter um telefone valido';
  end if;

  if exists (
    select 1
    from public.clients c
    where c.store_id = new.store_id
      and c.id is distinct from new.id
      and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') = v_phone
  ) then
    raise exception 'Ja existe um cliente com este telefone nesta loja';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_unique_client_phone on public.clients;
create trigger enforce_unique_client_phone
before insert or update of store_id, phone
on public.clients
for each row
execute function app_private.enforce_unique_client_phone();

-- Historico imutavel para auditoria e recuperacao de receitas sobrescritas.
create table if not exists public.prescription_change_audit (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  prescription_kind text not null check (prescription_kind in ('current', 'new')),
  previous_value text,
  next_value text,
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now()
);

alter table public.prescription_change_audit enable row level security;
grant select on table public.prescription_change_audit to authenticated;

drop policy if exists "prescription_audit_admin_select" on public.prescription_change_audit;
create policy "prescription_audit_admin_select"
on public.prescription_change_audit
for select
to authenticated
using ((select app_private.current_profile_role()) = 'admin');

create or replace function app_private.audit_client_prescription_change()
returns trigger
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_appointment_setting text;
  v_appointment_id uuid;
begin
  v_appointment_setting := current_setting('app.prescription_appointment_id', true);
  if nullif(v_appointment_setting, '') is not null then
    v_appointment_id := v_appointment_setting::uuid;
  end if;

  if new.prescription is distinct from old.prescription then
    insert into public.prescription_change_audit (
      client_id,
      appointment_id,
      prescription_kind,
      previous_value,
      next_value,
      changed_by
    )
    values (
      new.id,
      v_appointment_id,
      'current',
      old.prescription,
      new.prescription,
      auth.uid()
    );
  end if;

  if new.new_prescription is distinct from old.new_prescription then
    insert into public.prescription_change_audit (
      client_id,
      appointment_id,
      prescription_kind,
      previous_value,
      next_value,
      changed_by
    )
    values (
      new.id,
      v_appointment_id,
      'new',
      old.new_prescription,
      new.new_prescription,
      auth.uid()
    );
  end if;

  return new;
end;
$$;

drop trigger if exists audit_client_prescription_change on public.clients;
create trigger audit_client_prescription_change
after update of prescription, new_prescription
on public.clients
for each row
execute function app_private.audit_client_prescription_change();

-- Salva receitas abertas diretamente pelo cadastro do cliente.
create or replace function public.save_client_prescriptions(
  p_client_id uuid,
  p_update_current boolean default false,
  p_current_prescription text default null,
  p_update_new boolean default false,
  p_new_prescription text default null
)
returns public.clients
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_role text;
  v_profile_store_id uuid;
  v_client public.clients;
begin
  v_role := app_private.current_profile_role();

  select *
  into v_client
  from public.clients
  where id = p_client_id
  for update;

  if v_client.id is null then
    raise exception 'Cliente nao encontrado';
  end if;

  if v_role is null or v_role not in ('admin', 'store', 'optometrist') then
    raise exception 'Usuario sem permissao para salvar receita';
  end if;

  if v_role = 'store' then
    v_profile_store_id := app_private.current_profile_store_id();
    if v_profile_store_id is distinct from v_client.store_id then
      raise exception 'Loja sem permissao para este cliente';
    end if;
  end if;

  if p_update_current and v_role not in ('admin', 'store') then
    raise exception 'Optometrista nao altera a receita atual';
  end if;

  if p_update_new and v_role not in ('admin', 'optometrist') then
    raise exception 'Loja nao altera a nova receita';
  end if;

  perform set_config('app.prescription_write_guard', 'allowed', true);
  perform set_config('app.prescription_appointment_id', '', true);

  update public.clients
  set
    prescription = case
      when p_update_current then nullif(trim(coalesce(p_current_prescription, '')), '')
      else prescription
    end,
    prescription_updated_at = case
      when p_update_current and nullif(trim(coalesce(p_current_prescription, '')), '') is null then null
      when p_update_current then now()
      else prescription_updated_at
    end,
    prescription_updated_by = case
      when p_update_current and nullif(trim(coalesce(p_current_prescription, '')), '') is null then null
      when p_update_current then auth.uid()
      else prescription_updated_by
    end,
    new_prescription = case
      when p_update_new then nullif(trim(coalesce(p_new_prescription, '')), '')
      else new_prescription
    end,
    new_prescription_updated_at = case
      when p_update_new and nullif(trim(coalesce(p_new_prescription, '')), '') is null then null
      when p_update_new then now()
      else new_prescription_updated_at
    end,
    new_prescription_updated_by = case
      when p_update_new and nullif(trim(coalesce(p_new_prescription, '')), '') is null then null
      when p_update_new then auth.uid()
      else new_prescription_updated_by
    end
  where id = p_client_id
  returning * into v_client;

  return v_client;
end;
$$;

revoke execute on function public.save_client_prescriptions(uuid, boolean, text, boolean, text)
from public;
revoke execute on function public.save_client_prescriptions(uuid, boolean, text, boolean, text)
from anon;
grant execute on function public.save_client_prescriptions(uuid, boolean, text, boolean, text)
to authenticated;

-- O navegador informa apenas o agendamento. O banco resolve o unico cliente
-- correspondente por loja + telefone e grava a receita e o vinculo juntos.
-- Assim, nenhum client_id antigo ou estado da ultima tela pode escolher o paciente.
create or replace function public.save_appointment_prescriptions(
  p_appointment_id uuid,
  p_update_current boolean default false,
  p_current_prescription text default null,
  p_update_new boolean default false,
  p_new_prescription text default null
)
returns public.clients
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_role text;
  v_store_id uuid;
  v_profile_store_id uuid;
  v_appointment_phone text;
  v_client_id uuid;
  v_match_count integer;
  v_client public.clients;
begin
  v_role := app_private.current_profile_role();

  if v_role is null or v_role not in ('admin', 'store', 'optometrist') then
    raise exception 'Usuario sem permissao para salvar receita';
  end if;

  if p_update_current and v_role not in ('admin', 'store') then
    raise exception 'Optometrista nao altera a receita atual';
  end if;

  if p_update_new and v_role not in ('admin', 'optometrist') then
    raise exception 'Loja nao altera a nova receita';
  end if;

  select
    a.store_id,
    regexp_replace(coalesce(a.client_phone, ''), '[^0-9]', '', 'g')
  into v_store_id, v_appointment_phone
  from public.appointments a
  where a.id = p_appointment_id
  for update;

  if v_store_id is null or v_appointment_phone = '' then
    raise exception 'Agendamento sem identificacao segura do cliente';
  end if;

  if v_role = 'store' then
    v_profile_store_id := app_private.current_profile_store_id();
    if v_profile_store_id is distinct from v_store_id then
      raise exception 'Loja sem permissao para este agendamento';
    end if;
  end if;

  select
    count(*),
    (array_agg(c.id))[1]
  into v_match_count, v_client_id
  from public.clients c
  where c.store_id = v_store_id
    and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') = v_appointment_phone;

  if v_match_count <> 1 or v_client_id is null then
    raise exception 'Nao existe um unico cliente para a loja e telefone deste agendamento';
  end if;

  update public.appointments
  set client_id = v_client_id
  where id = p_appointment_id
    and client_id is distinct from v_client_id;

  perform set_config('app.prescription_write_guard', 'allowed', true);
  perform set_config('app.prescription_appointment_id', p_appointment_id::text, true);

  update public.clients
  set
    prescription = case
      when p_update_current then nullif(trim(coalesce(p_current_prescription, '')), '')
      else prescription
    end,
    prescription_updated_at = case
      when p_update_current and nullif(trim(coalesce(p_current_prescription, '')), '') is null then null
      when p_update_current then now()
      else prescription_updated_at
    end,
    prescription_updated_by = case
      when p_update_current and nullif(trim(coalesce(p_current_prescription, '')), '') is null then null
      when p_update_current then auth.uid()
      else prescription_updated_by
    end,
    new_prescription = case
      when p_update_new then nullif(trim(coalesce(p_new_prescription, '')), '')
      else new_prescription
    end,
    new_prescription_updated_at = case
      when p_update_new and nullif(trim(coalesce(p_new_prescription, '')), '') is null then null
      when p_update_new then now()
      else new_prescription_updated_at
    end,
    new_prescription_updated_by = case
      when p_update_new and nullif(trim(coalesce(p_new_prescription, '')), '') is null then null
      when p_update_new then auth.uid()
      else new_prescription_updated_by
    end
  where id = v_client_id
  returning * into v_client;

  if v_client.id is null then
    raise exception 'Receita nao atualizada';
  end if;

  return v_client;
end;
$$;

revoke execute on function public.save_appointment_prescriptions(uuid, boolean, text, boolean, text)
from public;
revoke execute on function public.save_appointment_prescriptions(uuid, boolean, text, boolean, text)
from anon;
grant execute on function public.save_appointment_prescriptions(uuid, boolean, text, boolean, text)
to authenticated;

-- Bloqueio final: nenhuma versao antiga do app pode alterar receitas diretamente.
-- Somente as duas funcoes seguras acima liberam a escrita durante a transacao.
create or replace function app_private.enforce_client_prescription_roles()
returns trigger
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_role text;
  v_guard text;
  v_prescription_changed boolean;
begin
  v_role := app_private.current_profile_role();
  v_guard := current_setting('app.prescription_write_guard', true);

  if tg_op = 'INSERT' then
    if new.prescription is not null or new.new_prescription is not null then
      raise exception 'Receitas devem ser gravadas pelo fluxo seguro';
    end if;
    return new;
  end if;

  v_prescription_changed :=
    new.prescription is distinct from old.prescription
    or new.new_prescription is distinct from old.new_prescription;

  if v_prescription_changed and v_guard is distinct from 'allowed' then
    raise exception 'Alteracao direta de receita bloqueada por seguranca';
  end if;

  if new.new_prescription is distinct from old.new_prescription
    and v_role not in ('optometrist', 'admin')
  then
    raise exception 'Apenas optometrista ou admin pode alterar a nova receita';
  end if;

  if new.prescription is distinct from old.prescription and v_role = 'optometrist' then
    raise exception 'Optometrista nao altera a receita atual';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_client_prescription_roles on public.clients;
create trigger enforce_client_prescription_roles
before insert or update on public.clients
for each row
execute function app_private.enforce_client_prescription_roles();

-- Auditoria: o resultado deve ficar vazio.
-- Linhas restantes exigem revisao manual porque nao possuem correspondencia unica.
select
  a.id as appointment_id,
  a.client_name as appointment_client_name,
  a.client_phone as appointment_client_phone,
  a.client_id,
  c.name as linked_client_name,
  c.phone as linked_client_phone
from public.appointments a
left join public.clients c on c.id = a.client_id
where a.client_id is not null
  and (
    c.id is null
    or c.store_id is distinct from a.store_id
    or regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')
       is distinct from regexp_replace(coalesce(a.client_phone, ''), '[^0-9]', '', 'g')
  )
order by a.date desc, a.time desc;
