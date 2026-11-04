import { compactKey, levenshtein, nameKey, nameTokens, normalizeName } from '@/lib/assistant/nameFold';

export { normalizeName, nameKey };

export const PRODUCT_ALIAS_GROUPS: string[][] = [
  ['порошок', 'ұнтақ', 'унтак', 'powder', 'poroshok'],
  ['чай', 'шай', 'shai', 'tea', 'chai'],
  ['драже', 'draje'],
];

const FILLER = new Set(['g', 'kg', 'ml', 'l', 'sht', 'st', 'pcs', 'gr', 'org', 'org250g', '250g', '500g', '50sht']);

const TOKEN_SYN: Record<string, string> = {
  chai: 'shai',
  tea: 'shai',
  powder: 'poroshok',
  untak: 'poroshok',
  plaster: 'plastyr',
  draje: 'drazhe',
  mazi: 'maz',
};

function productTokens(value: string): string[] {
  return nameTokens(value).map((t) => TOKEN_SYN[t] || t);
}

type AliasRule = { aliases: string[]; target: string };

const PRODUCT_ALIAS_RULES: AliasRule[] = [
  {
    aliases: [
      'шикі порошок',
      'шики порошок',
      'шикі порошок орг',
      'сырой порошок',
      'сырой порошок орг',
      'shiki poroshok',
      'shyki poroshok',
    ],
    target: 'шикі порошок орг',
  },
  {
    aliases: ['порошок орг', 'порошок', 'ұнтақ', 'унтак', 'powder', 'poroshok', 'poroshok org'],
    target: 'порошок орг',
  },
  {
    aliases: [
      'тәтті шай',
      'татти шай',
      'татти чай',
      'сладкий чай',
      'сладкий шай',
      'tatti shai',
      'tatti chai',
      'sladkiy chai',
    ],
    target: 'тәтті шай',
  },
  {
    aliases: ['чай', 'шай', 'shai', 'tea', 'chai', 'шай орг'],
    target: 'шай орг',
  },
  {
    aliases: ['моксопластырь', 'моксо пластырь', 'moksoplastyr', 'mokso plastyr'],
    target: 'моксопластырь',
  },
  {
    aliases: ['арқа пластырь', 'арка пластырь', 'arka plastyr', 'arqa plastyr'],
    target: 'арқа пластырь',
  },
  {
    aliases: ['аю пластырь', 'ayu plastyr', 'ayu plaster'],
    target: 'аю пластырь',
  },
  {
    aliases: ['пластырь', 'plastyr', 'plaster', 'пластырь 50', 'пластырь 50шт'],
    target: 'пластырь 50',
  },
  {
    aliases: ['драже', 'draje'],
    target: 'драже',
  },
  {
    aliases: ['мазь макси', 'maz maxi', 'мазь максимум'],
    target: 'мазь макси',
  },
  {
    aliases: ['мазь', 'maz', 'mazi'],
    target: 'мазь',
  },
];

export type CatalogProduct = {
  id: string;
  name: string;
  unit: string | null;
  price_retail: number | null;
  is_active?: boolean;
};

export type ProductMatchResult = {
  chosen: CatalogProduct | null;
  candidates: CatalogProduct[];
  reason: 'exact' | 'alias' | 'similar' | 'ambiguous' | 'none';
};

function activeCatalog(catalog: CatalogProduct[]): CatalogProduct[] {
  return catalog.filter((p) => p.is_active !== false);
}

function isFillerToken(token: string): boolean {
  if (FILLER.has(token)) return true;
  if (/^\d+$/.test(token)) return true;
  if (/^\d+(g|kg|ml|l|sht)$/.test(token)) return true;
  return false;
}

export function coreTokens(value: string): string[] {
  return productTokens(value).filter((t) => !isFillerToken(t));
}

function aliasTokenLen(alias: string): number {
  return nameTokens(alias).length;
}

function queryMatchesAlias(query: string, alias: string): boolean {
  const q = productTokens(query);
  const a = productTokens(alias);
  if (!a.length || q.length < a.length) return false;
  if (nameKey(query) === nameKey(alias) || compactKey(query) === compactKey(alias)) return true;
  const qc = compactKey(query);
  const ac = compactKey(alias);
  if (ac.length >= 5 && levenshtein(qc, ac) <= 1) return true;
  return a.every((tok) => q.includes(tok) || q.some((qt) => qt.startsWith(tok) || (tok.startsWith(qt) && qt.length >= 4)));
}

function findAliasRule(query: string): AliasRule | null {
  const ranked = [...PRODUCT_ALIAS_RULES].sort((a, b) => {
    const aMax = Math.max(...a.aliases.map(aliasTokenLen));
    const bMax = Math.max(...b.aliases.map(aliasTokenLen));
    return bMax - aMax;
  });
  for (const rule of ranked) {
    if (rule.aliases.some((alias) => queryMatchesAlias(query, alias))) return rule;
  }
  return null;
}

function productMatchesTarget(product: CatalogProduct, target: string): boolean {
  const p = productTokens(product.name);
  const t = coreTokens(target);
  if (!t.length) return false;
  return t.every((tok) => p.some((pt) => pt === tok || pt.startsWith(tok) || tok.startsWith(pt)));
}

function coreEqual(product: CatalogProduct, target: string): boolean {
  const a = coreTokens(product.name).join(' ');
  const b = coreTokens(target).join(' ');
  return a === b;
}

function pickByTarget(catalog: CatalogProduct[], target: string): CatalogProduct[] {
  const hits = catalog.filter((p) => productMatchesTarget(p, target));
  const exactCore = hits.filter((p) => coreEqual(p, target));
  if (exactCore.length) return exactCore;
  return hits;
}

function similarScore(query: string, product: CatalogProduct): number {
  const qKey = nameKey(query);
  const nKey = nameKey(product.name);
  if (!qKey || !nKey) return 0;
  if (qKey === nKey) return 100;
  const qCore = coreTokens(query).join(' ');
  const nCore = coreTokens(product.name).join(' ');
  if (qCore && qCore === nCore) return 95;
  if (qKey.length >= 4 && (nKey.startsWith(qKey) || qKey.startsWith(nKey))) return 80;
  if (nKey.includes(qKey) && qKey.length >= 4) return 74;
  const qTok = productTokens(query);
  const nTok = productTokens(product.name);
  if (!qTok.length) return 0;
  let hit = 0;
  for (const qt of qTok) {
    if (nTok.some((nt) => nt === qt || nt.startsWith(qt) || (qt.startsWith(nt) && nt.length >= 3))) hit += 1;
    else if (nTok.some((nt) => nt.length >= 5 && qt.length >= 5 && levenshtein(nt, qt) === 1)) hit += 0.75;
  }
  return (hit / qTok.length) * 70;
}

function uniqueOrAmbiguous(ranked: { product: CatalogProduct; score: number }[]): ProductMatchResult {
  const strong = ranked.filter((x) => x.score >= 55);
  if (!strong.length) return { chosen: null, candidates: [], reason: 'none' };
  const best = strong[0];
  const close = strong.filter((x) => best.score - x.score < 8);
  if (best.score >= 88 && close.length === 1) {
    return { chosen: best.product, candidates: [best.product], reason: best.score >= 99 ? 'exact' : 'similar' };
  }
  const candidates = close.slice(0, 5).map((x) => x.product);
  if (candidates.length === 1) {
    return { chosen: null, candidates, reason: 'ambiguous' };
  }
  return { chosen: null, candidates: candidates.slice(0, 5), reason: 'ambiguous' };
}

export function resolveProductQuery(query: string, catalog: CatalogProduct[]): ProductMatchResult {
  const active = activeCatalog(catalog);
  const q = nameKey(query);
  if (!q) return { chosen: null, candidates: [], reason: 'none' };

  const exact = active.filter((p) => nameKey(p.name) === q);
  if (exact.length === 1) return { chosen: exact[0], candidates: exact, reason: 'exact' };
  if (exact.length > 1) return { chosen: null, candidates: exact.slice(0, 5), reason: 'ambiguous' };

  const rule = findAliasRule(query);
  if (rule) {
    const hits = pickByTarget(active, rule.target);
    if (hits.length === 1) return { chosen: hits[0], candidates: hits, reason: 'alias' };
    if (hits.length > 1) {
      const exactCore = hits.filter((p) => coreEqual(p, rule.target));
      if (exactCore.length === 1) return { chosen: exactCore[0], candidates: exactCore, reason: 'alias' };
      return { chosen: null, candidates: (exactCore.length ? exactCore : hits).slice(0, 5), reason: 'ambiguous' };
    }
  }

  const ranked = active
    .map((product) => ({ product, score: similarScore(query, product) }))
    .filter((x) => x.score >= 40)
    .sort((a, b) => b.score - a.score);
  return uniqueOrAmbiguous(ranked);
}

export function expandProductQuery(query: string): string[] {
  const norm = normalizeName(query);
  if (!norm) return [];
  const out = new Set<string>([norm, nameKey(query)]);
  for (const group of PRODUCT_ALIAS_GROUPS) {
    const keys = group.map((g) => nameKey(g));
    if (keys.includes(nameKey(query)) || group.map(normalizeName).includes(norm)) {
      for (const alias of group) {
        out.add(normalizeName(alias));
        out.add(nameKey(alias));
      }
    }
  }
  return [...out];
}

export function matchCatalogProducts(query: string, catalog: CatalogProduct[]): CatalogProduct[] {
  const result = resolveProductQuery(query, catalog);
  if (result.chosen) return [result.chosen];
  return result.candidates;
}

export function filterCatalogProducts(query: string, catalog: CatalogProduct[], limit = 8): CatalogProduct[] {
  const active = activeCatalog(catalog);
  const q = nameKey(query);
  if (!q) return [];
  const ranked = active
    .map((product) => ({ product, score: similarScore(query, product) }))
    .filter((x) => x.score >= 30 || nameKey(x.product.name).includes(q))
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit).map((x) => x.product);
}
