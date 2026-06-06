-- Execute primeiro se o Supabase reclamar do enum app_role.
alter type public.app_role add value if not exists 'optometrist';
