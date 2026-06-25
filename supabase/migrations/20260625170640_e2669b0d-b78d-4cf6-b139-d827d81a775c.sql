
-- Seed brayan@adseleto.com as viewer with access to all sites (one-off)
ALTER TABLE public.admin_profiles DISABLE TRIGGER trg_prevent_admin_self_escalation;

DO $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE email = 'brayan@adseleto.com';
  IF v_user_id IS NULL THEN
    v_user_id := gen_random_uuid();
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      confirmation_token, email_change, email_change_token_new, recovery_token, is_sso_user
    ) VALUES (
      '00000000-0000-0000-0000-000000000000', v_user_id, 'authenticated', 'authenticated',
      'brayan@adseleto.com', crypt('brayan321', gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"display_name":"Brayan"}'::jsonb,
      '', '', '', '', false
    );
    INSERT INTO auth.identities (
      id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), v_user_id, v_user_id::text,
      jsonb_build_object('sub', v_user_id::text, 'email', 'brayan@adseleto.com', 'email_verified', true),
      'email', now(), now(), now()
    );
  ELSE
    UPDATE auth.users
      SET encrypted_password = crypt('brayan321', gen_salt('bf')),
          email_confirmed_at = COALESCE(email_confirmed_at, now()),
          updated_at = now()
      WHERE id = v_user_id;
  END IF;

  INSERT INTO public.admin_profiles (user_id, name, role, is_active)
  VALUES (v_user_id, 'Brayan', 'viewer'::public.app_role, true)
  ON CONFLICT (user_id) DO UPDATE
    SET role = 'viewer'::public.app_role,
        is_active = true,
        name = COALESCE(public.admin_profiles.name, EXCLUDED.name);

  INSERT INTO public.admin_permissions (user_id, can_view_dashboard)
  VALUES (v_user_id, true)
  ON CONFLICT (user_id) DO UPDATE SET can_view_dashboard = true;

  INSERT INTO public.admin_site_access (user_id, site_id)
  SELECT v_user_id, s.id FROM public.sites s
  ON CONFLICT DO NOTHING;
END $$;

ALTER TABLE public.admin_profiles ENABLE TRIGGER trg_prevent_admin_self_escalation;
