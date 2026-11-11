SELECT set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
SET ROLE authenticated;
SELECT public.complete_seller_debt_pay(
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'cash',
  '77019999999'
);
