-- Read-only diagnosis for 5.4.1 postflight FAIL on search_path / row_security.
-- Does not ALTER/CREATE/DROP. Do not use to change production.

WITH f AS (
  SELECT
    p.oid,
    n.nspname,
    p.proname,
    pg_get_function_identity_arguments(p.oid) AS args,
    p.prosecdef,
    p.proconfig,
    pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'find_similar_orders'
    AND pg_get_function_identity_arguments(p.oid) = 'p jsonb'
)
SELECT
  nspname,
  proname,
  args,
  prosecdef AS security_definer,
  proconfig,
  EXISTS (
    SELECT 1 FROM unnest(COALESCE(proconfig, ARRAY[]::text[])) c
    WHERE c = 'search_path=public'
  ) AS proconfig_search_path_public,
  EXISTS (
    SELECT 1 FROM unnest(COALESCE(proconfig, ARRAY[]::text[])) c
    WHERE c = 'row_security=off'
  ) AS proconfig_row_security_off,
  (def LIKE '%SET search_path = public%') AS def_matches_create_equals_syntax,
  (def LIKE '%row_security = off%') AS def_matches_create_equals_syntax_rls,
  (def ILIKE '%SET search_path TO%') AS def_has_set_search_path_to,
  (def ILIKE '%SET row_security TO%') AS def_has_set_row_security_to,
  left(def, 700) AS functiondef_head
FROM f;
