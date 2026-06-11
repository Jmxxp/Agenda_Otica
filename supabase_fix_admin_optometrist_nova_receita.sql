-- Execute no SQL Editor do Supabase.
-- Corrige a regra da nova receita:
-- - admin e optometrista podem criar, editar e limpar a nova receita;
-- - loja continua sem alterar a nova receita;
-- - optometrista continua sem alterar a receita atual.

create or replace function app_private.enforce_client_prescription_roles()
returns trigger
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_role text;
begin
  v_role := app_private.current_profile_role();

  if tg_op = 'INSERT' then
    if new.new_prescription is not null and v_role not in ('optometrist', 'admin') then
      raise exception 'Apenas optometrista ou admin pode preencher a nova receita';
    end if;

    if new.prescription is not null and v_role = 'optometrist' then
      raise exception 'Optometrista nao altera a receita atual';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if new.new_prescription is distinct from old.new_prescription
      and v_role not in ('optometrist', 'admin')
    then
      raise exception 'Apenas optometrista ou admin pode alterar a nova receita';
    end if;

    if new.prescription is distinct from old.prescription and v_role = 'optometrist' then
      raise exception 'Optometrista nao altera a receita atual';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_client_prescription_roles on public.clients;
create trigger enforce_client_prescription_roles
before insert or update on public.clients
for each row execute function app_private.enforce_client_prescription_roles();
