/**
 * Канон казахстанского мобильного телефона для аналитики клиентов (5.6.1 / 5.6.2).
 * Правила должны совпадать с public.kz_normalize_customer_phone.
 */

/** Код страны + NDC мобильных: 70x, 74x, 75x, 76x, 77x. */
export const KZ_MOBILE_NDC = ['70', '74', '75', '76', '77'] as const;

export function normalizeCustomerPhone(input: string | null | undefined): string | null {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (raw.includes('+') && !raw.startsWith('+')) return null;
  const body = raw.startsWith('+') ? raw.slice(1) : raw;
  if (/[^\d\s().-]/.test(body)) return null;

  let digits = body.replace(/\D/g, '');
  if (!digits) return null;

  if (digits.length === 11 && digits.startsWith('8')) {
    digits = `7${digits.slice(1)}`;
  } else if (digits.length === 10 && digits.startsWith('7')) {
    digits = `7${digits}`;
  }

  if (digits.length !== 11 || !digits.startsWith('7')) return null;
  const ndc = digits.slice(1, 3);
  if (!(KZ_MOBILE_NDC as readonly string[]).includes(ndc)) return null;
  return `+${digits}`;
}

export function isReliableCustomerPhone(input: string | null | undefined): boolean {
  return normalizeCustomerPhone(input) != null;
}
