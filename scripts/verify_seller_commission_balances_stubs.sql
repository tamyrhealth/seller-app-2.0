-- Extra local stubs for 5.17.5B. Not for production.

INSERT INTO public.profiles (id, display_name, role, is_active) VALUES
  ('abababab-abab-4aba-8aba-abababababab', 'InactiveSeller', 'seller', false)
ON CONFLICT (id) DO NOTHING;
