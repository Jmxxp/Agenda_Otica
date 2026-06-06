-- Execute no SQL Editor do Supabase para as notificacoes de receita chegarem em tempo real.

alter table public.prescription_notifications replica identity full;
alter table public.clients replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'prescription_notifications'
  ) then
    alter publication supabase_realtime add table public.prescription_notifications;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'clients'
  ) then
    alter publication supabase_realtime add table public.clients;
  end if;
end $$;
