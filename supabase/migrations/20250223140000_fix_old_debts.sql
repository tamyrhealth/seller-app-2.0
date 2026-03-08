-- Исправление старых долгов: payment_type='debt', но is_debt=false
-- Выполнить в Supabase SQL Editor или через migrations

UPDATE public.orders
SET is_debt = true,
    debt_status = COALESCE(NULLIF(TRIM(debt_status), ''), 'active')
WHERE payment_type = 'debt'
  AND COALESCE(is_debt, false) = false;
