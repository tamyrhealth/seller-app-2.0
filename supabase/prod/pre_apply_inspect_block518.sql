-- 5.18 preflight. SELECT-only. Do not run writes. Local/ops use after explicit allow.

SELECT
  CASE
    WHEN to_regprocedure('public.admin_stats_seller_earnings(date, date)') IS NULL
    THEN 'PASS admin_stats_seller_earnings.absent'
    ELSE 'FAIL admin_stats_seller_earnings.absent already exists'
  END AS check_rpc_absent;

SELECT
  CASE
    WHEN to_regprocedure('public.admin_finance_seller_pnl(date, date)') IS NOT NULL
    THEN 'PASS admin_finance_seller_pnl.present'
    ELSE 'WARN admin_finance_seller_pnl.missing'
  END AS check_pnl_untouched;

SELECT
  CASE
    WHEN to_regprocedure('public.admin_seller_balances_list()') IS NOT NULL
    THEN 'PASS admin_seller_balances_list.present'
    ELSE 'FAIL admin_seller_balances_list.present'
  END AS check_balances;
