const KZ_TO_RU: Record<string, string> = {
  ә: 'а',
  ғ: 'г',
  қ: 'к',
  ң: 'н',
  ө: 'о',
  ұ: 'у',
  ү: 'у',
  һ: 'х',
  і: 'и',
  ё: 'е',
};

const CYR_TO_LAT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ы: 'y',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

export function foldCyrillic(value: string): string {
  return [...value.toLowerCase()].map((ch) => KZ_TO_RU[ch] || ch).join('').replace(/[ьъ]/g, '');
}

export function normalizeName(value: string): string {
  return foldCyrillic(value)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function nameKey(value: string): string {
  const n = normalizeName(value);
  let out = '';
  for (const ch of n) {
    if (ch === ' ') {
      out += ' ';
      continue;
    }
    out += CYR_TO_LAT[ch] || ch;
  }
  return splitCompounds(out.replace(/\s+/g, ' ').trim());
}

function splitCompounds(key: string): string {
  return key
    .replace(/moksoplast/g, 'mokso plast')
    .replace(/([a-z])plastyr/g, '$1 plastyr')
    .replace(/([a-z])poroshok/g, '$1 poroshok');
}

export function nameTokens(value: string): string[] {
  return nameKey(value).split(' ').filter(Boolean);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cur = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return row[b.length];
}

export function compactKey(value: string): string {
  return nameKey(value).replace(/\s+/g, '');
}
