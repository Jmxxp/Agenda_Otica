-- Execute para permitir editar nome, nick e senha do optometrista pelo app.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.admin_update_optometrist(
  p_profile_id uuid,
  p_name text,
  p_login_nick text,
  p_password text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_profile public.profiles;
  v_login_nick text;
  v_auth_email text;
begin
  if app_private.current_profile_role() <> 'admin' then
    raise exception 'Apenas administradores podem editar optometristas';
  end if;

  v_login_nick := lower(trim(p_login_nick));
  v_auth_email := v_login_nick || '@agenda.local';

  if trim(coalesce(p_name, '')) = '' or length(v_login_nick) < 3 then
    raise exception 'Informe nome e nick validos';
  end if;

  if p_password is not null and length(p_password) < 6 then
    raise exception 'A senha precisa ter pelo menos 6 caracteres';
  end if;

  if exists (
    select 1
    from public.stores
    where login_nick = v_login_nick
      or auth_email = v_auth_email
  ) then
    raise exception 'Este nick ja esta em uso';
  end if;

  if exists (
    select 1
    from public.profiles
    where id <> p_profile_id
      and (
        login_nick = v_login_nick
        or auth_email = v_auth_email
      )
  ) then
    raise exception 'Este nick ja esta em uso';
  end if;

  update auth.users
  set
    email = v_auth_email,
    encrypted_password = case
      when p_password is null then encrypted_password
      else extensions.crypt(p_password, extensions.gen_salt('bf'))
    end,
    raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
      || jsonb_build_object('name', trim(p_name), 'nick', v_login_nick, 'role', 'optometrist'),
    updated_at = now()
  where id = p_profile_id;

  update auth.identities
  set
    provider_id = v_auth_email,
    identity_data = coalesce(identity_data, '{}'::jsonb)
      || jsonb_build_object('email', v_auth_email, 'email_verified', true, 'phone_verified', false, 'sub', p_profile_id::text),
    updated_at = now()
  where user_id = p_profile_id
    and provider = 'email';

  update public.profiles
  set
    full_name = trim(p_name),
    login_nick = v_login_nick,
    auth_email = v_auth_email,
    store_id = null
  where id = p_profile_id
    and role::text = 'optometrist'
  returning * into v_profile;

  if v_profile.id is null then
    raise exception 'Optometrista nao encontrado';
  end if;

  return v_profile;
end;
$$;

grant execute on function public.admin_update_optometrist(uuid, text, text, text) to authenticated;
