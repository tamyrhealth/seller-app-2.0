export const PRODUCT_ALIAS_GROUPS: string[][] = [
  ['порошок', 'ұнтақ', 'унтак', 'powder'],
  ['чай', 'шай', 'shai', 'tea'],
  ['драже', 'draje'],
];

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function expandProductQuery(query: string): string[] {
  const norm = normalizeName(query);
  if (!norm) return [];
  const out = new Set<string>([norm]);
  for (const group of PRODUCT_ALIAS_GROUPS) {
    const norms = group.map(normalizeName);
    if (norms.includes(norm)) {
      for (const alias of norms) out.add(alias);
    }
  }
  return [...out];
}

export type CatalogProduct = { id: string; name: string; unit: string | null; price_retail: number | null };

export function matchCatalogProducts(query: string, catalog: CatalogProduct[]): CatalogProduct[] {
  const terms = expandProductQuery(query);
  const q = normalizeName(query);
  if (!q) return [];
  const hits = catalog.filter((product) => {
    const name = normalizeName(product.name || '');
    return terms.some((term) => term && (name === term || name.includes(term)));
  });
  if (hits.length <= 1) return hits;
  const exactQuery = hits.filter((product) => normalizeName(product.name || '') === q);
  if (exactQuery.length === 1) {
    const othersContainQuery = hits.some((product) => {
      const name = normalizeName(product.name || '');
      return name !== q && name.includes(q);
    });
    if (!othersContainQuery || q.split(' ').length > 1) return exactQuery;
  }
  return hits;
}
