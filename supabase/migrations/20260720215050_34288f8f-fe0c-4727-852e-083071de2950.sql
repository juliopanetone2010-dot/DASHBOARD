
ALTER TABLE public.admin_profiles DISABLE TRIGGER USER;

DO $$
DECLARE
  v_user_id uuid;
  v_email text := 'rilker@adseleto.com';
  v_password text := 'AdSel3to@Rilker#2026';
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = v_email;

  IF v_user_id IS NULL THEN
    v_user_id := gen_random_uuid();
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, confirmation_token, email_change,
      email_change_token_new, recovery_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000', v_user_id, 'authenticated', 'authenticated',
      v_email, crypt(v_password, gen_salt('bf')),
      now(), '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('display_name', 'Rilker'),
      now(), now(), '', '', '', ''
    );
    INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
    VALUES (gen_random_uuid(), v_user_id,
      jsonb_build_object('sub', v_user_id::text, 'email', v_email, 'email_verified', true),
      'email', v_email, now(), now(), now());
  ELSE
    UPDATE auth.users
      SET encrypted_password = crypt(v_password, gen_salt('bf')),
          email_confirmed_at = COALESCE(email_confirmed_at, now()),
          updated_at = now()
      WHERE id = v_user_id;
  END IF;

  DELETE FROM public.admin_profiles WHERE user_id = v_user_id;
  INSERT INTO public.admin_profiles (user_id, name, role, is_active)
  VALUES (v_user_id, 'Rilker', 'admin', true);

  INSERT INTO public.admin_permissions (user_id, can_view_dashboard)
  VALUES (v_user_id, true)
  ON CONFLICT (user_id) DO NOTHING;

  DELETE FROM public.admin_site_access WHERE user_id = v_user_id;
  INSERT INTO public.admin_site_access (user_id, site_id)
  SELECT v_user_id, id FROM public.sites;

  INSERT INTO public.admin_google_ads_permissions (user_id, google_account_id, can_view, can_sync, can_migrate)
  SELECT v_user_id, id, true, true, false FROM public.google_accounts
  ON CONFLICT (user_id, google_account_id) DO UPDATE SET can_view = true, can_sync = true;
END $$;

ALTER TABLE public.admin_profiles ENABLE TRIGGER USER;
