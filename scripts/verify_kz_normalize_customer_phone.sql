-- Local/read-only after 5.6.2 apply. Do not run as a production mutation.
-- Expect 0 failing rows.

SELECT t.input, t.expected, public.kz_normalize_customer_phone(t.input) AS got
FROM (VALUES
  ('87771234567', '+77771234567'),
  ('+77771234567', '+77771234567'),
  ('7771234567', '+77771234567'),
  ('+7 (777) 123-45-67', '+77771234567'),
  ('8 777 123 45 67', '+77771234567'),
  ('77011234567', '+77011234567'),
  ('87471234567', '+77471234567'),
  ('12345', NULL),
  ('abc87771234567', NULL),
  ('7+7771234567', NULL),
  ('77271234567', NULL),
  ('84951234567', NULL)
) AS t(input, expected)
WHERE public.kz_normalize_customer_phone(t.input) IS DISTINCT FROM t.expected;
