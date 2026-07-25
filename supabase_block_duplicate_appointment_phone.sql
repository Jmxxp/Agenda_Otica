-- BLOQUEIO DE TELEFONE COMPARTILHADO ENTRE PESSOAS
-- Execute este arquivo uma vez no SQL Editor do Supabase.
--
-- A regra e aplicada por loja:
--   1. um telefone pertence a um unico cadastro de cliente;
--   2. um agendamento precisa apontar para esse cadastro;
--   3. o nome do agendamento precisa ser o mesmo nome do cadastro.
--
-- Agendamentos repetidos da mesma pessoa continuam permitidos.

begin;

create schema if not exists app_private;

create or replace function app_private.normalize_person_name(p_value text)
returns text
language sql
immutable
set search_path = public, app_private
as $$
  select regexp_replace(
    translate(
      lower(trim(coalesce(p_value, ''))),
      'áàâãäéèêëíìîïóòôõöúùûüçñ',
      'aaaaaeeeeiiiiooooouuuucn'
    ),
    '[[:space:]]+',
    ' ',
    'g'
  );
$$;

create or replace function app_private.enforce_unique_client_phone()
returns trigger
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_phone text;
  v_owner_name text;
begin
  v_phone := regexp_replace(coalesce(new.phone, ''), '[^0-9]', '', 'g');

  if v_phone = '' then
    raise exception 'Cliente precisa ter um telefone valido';
  end if;

  select c.name
  into v_owner_name
  from public.clients c
  where c.store_id = new.store_id
    and c.id is distinct from new.id
    and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') = v_phone
  limit 1;

  if found then
    raise exception 'Este telefone ja esta vinculado a %. Use outro numero para este cliente.', coalesce(v_owner_name, 'outra pessoa');
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

do $$
begin
  if exists (
    select 1
    from public.clients c
    where regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') <> ''
    group by
      c.store_id,
      regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')
    having count(*) > 1
  ) then
    raise warning 'Existem telefones duplicados em clients. O app vai bloquea-los, mas revise esses cadastros para ativar o indice unico.';
  else
    execute $index$
      create unique index if not exists clients_store_phone_digits_unique
      on public.clients (
        store_id,
        (regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'))
      )
      where regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') <> ''
    $index$;
  end if;
end;
$$;

create or replace function app_private.enforce_appointment_phone_owner()
returns trigger
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_phone text;
  v_client public.clients;
  v_conflicting_name text;
begin
  v_phone := regexp_replace(coalesce(new.client_phone, ''), '[^0-9]', '', 'g');

  if v_phone = '' then
    raise exception 'Agendamento precisa ter um telefone valido';
  end if;

  if new.client_id is null then
    raise exception 'Agendamento precisa estar vinculado a um cliente';
  end if;

  select *
  into v_client
  from public.clients c
  where c.id = new.client_id;

  if not found then
    raise exception 'Cliente vinculado ao agendamento nao existe';
  end if;

  if v_client.store_id is distinct from new.store_id
    or regexp_replace(coalesce(v_client.phone, ''), '[^0-9]', '', 'g') is distinct from v_phone
  then
    raise exception 'O telefone do agendamento nao corresponde ao cliente vinculado';
  end if;

  if app_private.normalize_person_name(v_client.name)
    is distinct from app_private.normalize_person_name(new.client_name)
  then
    raise exception 'Este telefone ja esta vinculado a %. Use outro numero para este cliente.', coalesce(v_client.name, 'outra pessoa');
  end if;

  select a.client_name
  into v_conflicting_name
  from public.appointments a
  where a.store_id = new.store_id
    and a.id is distinct from new.id
    and regexp_replace(coalesce(a.client_phone, ''), '[^0-9]', '', 'g') = v_phone
    and app_private.normalize_person_name(a.client_name)
      is distinct from app_private.normalize_person_name(new.client_name)
  limit 1;

  if found then
    raise exception 'Este telefone ja esta vinculado a %. Use outro numero para este cliente.', coalesce(v_conflicting_name, 'outra pessoa');
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_appointment_phone_owner on public.appointments;
create trigger enforce_appointment_phone_owner
before insert or update of store_id, client_id, client_name, client_phone
on public.appointments
for each row
execute function app_private.enforce_appointment_phone_owner();

commit;
