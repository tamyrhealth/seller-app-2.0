const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

export function stripIdentifiers(value: string): string {
  return value.replace(PHONE_RE, '[скрыто]').replace(UUID_RE, '[id]');
}

export function capText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

const PII_KEYS = new Set([
  'debt_customer_phone',
  'debt_customer_name',
  'debt_note',
  'comment',
  'phone',
  'customer_phone',
  'customer_phone_canon',
  'customer_name',
  'email',
]);

export function scrubRecord(input: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (typeof input === 'string') return stripIdentifiers(input);
  if (Array.isArray(input)) return input.map((item) => scrubRecord(item, depth + 1));
  if (!input || typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input)) {
    if (PII_KEYS.has(key)) continue;
    out[key] = scrubRecord(val, depth + 1);
  }
  return out;
}
