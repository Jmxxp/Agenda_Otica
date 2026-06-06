-- Use quando o app disser que o nick ja existe, mas o optometrista nao aparece na lista.
-- Troque optometrista-1 pelo nick que voce tentou criar.

-- 1) Confira se o usuario ficou criado no Auth.
select
  id,
  email,
  created_at,
  last_sign_in_at
from auth.users
where email = 'optometrista-1@agenda.local';

-- 2) Se aparecer uma linha acima e esse usuario nao existe em public.profiles,
-- apague o usuario orfao do Auth para poder criar pelo app de novo.
delete from auth.users
where email = 'optometrista-1@agenda.local'
  and not exists (
    select 1
    from public.profiles
    where profiles.id = auth.users.id
  );
