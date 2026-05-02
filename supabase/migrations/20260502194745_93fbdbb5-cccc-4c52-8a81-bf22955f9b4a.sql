-- handle_new_user só roda via trigger; revoga execução pública
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- set_updated_at também só via trigger
revoke all on function public.set_updated_at() from public, anon, authenticated;

-- Garante search_path imutável (já estava, mas reforça)
alter function public.set_updated_at() set search_path = public;