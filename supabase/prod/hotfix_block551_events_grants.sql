-- 5.5.1 hotfix: drop leftover default UPDATE/DELETE grants on finance_expense_events
-- for service_role. Does not rewrite confirm_order, inventory, or expense RPCs.
-- Do not run until explicitly allowed.

BEGIN;

REVOKE ALL ON TABLE public.finance_expense_events FROM service_role;
GRANT SELECT, INSERT ON TABLE public.finance_expense_events TO service_role;

COMMIT;
