const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** Allow http(s)/mailto/tel, in-page hashes, and same-origin paths. Block javascript:, data:, etc. */
export function safeMarkdownUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('#') && !value.startsWith('#javascript')) return value;
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes(':')) return value;
  try {
    const parsed = new URL(value);
    if (!SAFE_PROTOCOLS.has(parsed.protocol.toLowerCase())) return '';
    return value;
  } catch {
    return '';
  }
}
