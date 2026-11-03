/** Normalize user input like "1", "n1", "N000001" to canonical N000001. */
export function parseOrderNumberQuery(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (!trimmed) return null;
  const digits = trimmed.startsWith('N') ? trimmed.slice(1) : trimmed;
  if (!/^\d+$/.test(digits)) return null;
  const s = digits.replace(/^0+/, '');
  if (!s) return null;
  return `N${s.length >= 6 ? s : s.padStart(6, '0')}`;
}

export function displayOrderNumber(order: { order_number?: string | null; id: string }): string {
  return order.order_number?.trim() || order.id.slice(0, 8);
}
