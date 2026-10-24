-- 0007_roles_enum.sql
-- New enum values must be committed before any statement uses them, so this file
-- does nothing else. 'viewer' stays in the type but is unused after 0008.

alter type public.app_role add value if not exists 'vendor';
alter type public.app_role add value if not exists 'consumer';
