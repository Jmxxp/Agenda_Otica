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
