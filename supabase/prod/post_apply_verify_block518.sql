-- 5.18 postflight. SELECT-only. Do not run writes.

SELECT
  CASE
    WHEN p.prosecdef
      AND p.provolatile = 's'
      AND p.proconfig @> ARRAY['search_path=public']
    THEN 'PASS admin_stats_seller_earnings.security_definer'
    ELSE 'FAIL admin_stats_seller_earnings.security_definer'
  END AS check_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'admin_stats_seller_earnings';

SELECT
  CASE
    WHEN has_function_privilege('authenticated', 'public.admin_stats_seller_earnings(date, date)', 'EXECUTE')
    THEN 'PASS grant.authenticated'
    ELSE 'FAIL grant.authenticated'
  END AS check_grant;

SELECT
  CASE
    WHEN NOT has_function_privilege('anon', 'public.admin_stats_seller_earnings(date, date)', 'EXECUTE')
    THEN 'PASS revoke.anon'
    ELSE 'FAIL revoke.anon'
  END AS check_anon;

SELECT
  CASE
    WHEN to_regprocedure('public.admin_finance_seller_pnl(date, date)') IS NOT NULL
    THEN 'PASS admin_finance_seller_pnl.untouched'
    ELSE 'FAIL admin_finance_seller_pnl.untouched'
  END AS check_pnl;
