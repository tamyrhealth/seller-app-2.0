import { nameKey } from '@/lib/assistant/nameFold';

export type TransferParsedItem = { raw_name: string; qty: number };

export type TransferIntent = {
  fromQuery: string;
  toQuery: string;
  items: TransferParsedItem[];
  comment: string | null;
};

const LOOKUP =
  /(где|статус|прими|принять|принят|недостач|оформить недостач|спиши недостач|отмени.{0,20}(отправк|перемещ|T\s?\d)|cancel.{0,20}transfer)/i;

const VERB = /(перемест|отправ|жөнелт|жонелт|жібер|жибер|ауыстыр|\btransfer\b)/i;
const ARROW = /\s*(?:→|->)\s*/;
const ORDER_HINT = /(накладн|заказ|kaspi|каспи|долг|қарыз|предзаказ|подарок|сыйлық|оплач|төлен)/i;
const ITEM_HINT =
  /^(порошок|чай|пластыр|мазь|драже|ұнтақ|унтак|шай|товар|жібер|жибер|отправ|перемест|шт|кг|kg|pcs|дана)/i;
const CITY_JOIN_STOP = /^(в|на|из|с|со|от|to|from|склад|склада|складе)$/i;
const COUNT_UNIT = '(?:штук(?:а|и)?|шт|pcs|дана(?:сы)?)';
const WEIGHT_UNIT = '(?:г|гр|грамм(?:а|ов)?|g|кг|kg|мл|ml)';

const STOP = new Set(
  [
    'отправь',
    'отправка',
    'отправки',
    'перемести',
    'перемещение',
    'перемещения',
    'создай',
    'жібер',
    'жибер',
    'жөнелт',
    'жонелт',
    'ауыстыр',
    'transfer',
    'шт',
    'кг',
    'kg',
    'pcs',
    'дана',
    'товар',
    'товара',
    'товары',
    'склад',
    'склада',
    'складе',
  ].map((s) => nameKey(s))
);

export function stripCityCase(value: string): string {
  return value
    .replace(/^(из|с|от|from)\s+/i, '')
    .replace(/^(в|на|to)\s+/i, '')
    .replace(/^(со?\s+)?склад[аеу]?\s+/i, '')
    .replace(/\s+склад[аеу]?$/i, '')
    .replace(/(дан|ден|тан|тен|нан|нен)$/i, '')
    .replace(/(ға|ге|қа|ке)$/i, '')
    .replace(/[.,;:!?]+$/g, '')
    .replace(VERB, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCity(value: string): string {
  const stripped = stripCityCase(value);
  const parts = stripped.split(/\s+/).filter((p) => !STOP.has(nameKey(p)));
  return parts.join(' ').trim();
}

function cleanProductName(value: string): string {
  const stripped = value
    .replace(VERB, ' ')
    .replace(/^[.,;:!?—–-]+\s*/g, '')
    .replace(/\s*[.,;:!?—–-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped
    .split(/\s+/)
    .filter((p) => !STOP.has(nameKey(p)))
    .join(' ')
    .trim();
}

function parseQty(raw: string): number {
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

function startsWithWeightUnit(value: string): boolean {
  return new RegExp(`^${WEIGHT_UNIT}\\b`, 'i').test(value.trim());
}

function readCityName(value: string): { name: string; rest: string } | null {
  const t = value.replace(/^[\s,.:;]+/, '').trim();
  if (!t) return null;
  const hyphen = /^([\p{L}0-9]+(?:-[\p{L}0-9]+)+)/u.exec(t);
  if (hyphen) {
    return { name: cleanCity(hyphen[1]), rest: t.slice(hyphen[0].length) };
  }
  const first = /^([\p{L}0-9]+)/u.exec(t);
  if (!first) return null;
  let name = first[1];
  let rest = t.slice(first[0].length);
  const second = /^\s+([\p{L}0-9]+)/u.exec(rest);
  if (
    second &&
    !ITEM_HINT.test(second[1]) &&
    !CITY_JOIN_STOP.test(second[1]) &&
    !/^\d/.test(second[1]) &&
    !STOP.has(nameKey(second[1]))
  ) {
    name = `${name} ${second[1]}`;
    rest = rest.slice(second[0].length);
  }
  const cleaned = cleanCity(name);
  return cleaned ? { name: cleaned, rest } : null;
}

type CityPair = { from: string; to: string; rest: string };

function pairFromNames(fromRaw: string, toRaw: string, rest: string): CityPair | null {
  const from = cleanCity(fromRaw);
  const to = cleanCity(toRaw);
  if (!from || !to) return null;
  return { from, to, rest: rest.replace(/^[\s,:;]+/, '').trim() };
}

function extractPrefixedPair(text: string): CityPair | null {
  const fromPre = /(?:^|[\s,])(?:со?\s+склада|из\s+склада|from(?:\s+the)?(?:\s+warehouse)?|из|с(?!клад))\s+/gi;
  let fromHit: RegExpExecArray | null;
  while ((fromHit = fromPre.exec(text))) {
    const afterFrom = text.slice(fromHit.index + fromHit[0].length);
    const fromCity = readCityName(afterFrom);
    if (!fromCity) continue;
    const toPre = /^(?:\s*)(?:на\s+склад(?:а|е)?|в\s+склад(?:а|е)?|to(?:\s+the)?(?:\s+warehouse)?|на|в)\s+/i.exec(
      fromCity.rest
    );
    if (!toPre) continue;
    const toCity = readCityName(fromCity.rest.slice(toPre[0].length));
    if (!toCity) continue;
    const before = text.slice(0, fromHit.index);
    const rest = `${toCity.rest}\n${before}`.trim();
    const pair = pairFromNames(fromCity.name, toCity.name, rest);
    if (pair) return pair;
  }
  return null;
}

function extractArrowPair(text: string): CityPair | null {
  const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!ARROW.test(line)) continue;
    const [left, right] = line.split(ARROW, 2);
    const fromCity = readCityName(left || '');
    const toCity = readCityName(right || '');
    if (!fromCity || !toCity) continue;
    const rest = [toCity.rest, ...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').trim();
    const pair = pairFromNames(fromCity.name, toCity.name, rest);
    if (pair) return pair;
  }
  return null;
}

function extractEnglishPair(text: string): CityPair | null {
  const en = /\bfrom\s+/i.exec(text);
  if (!en) return null;
  const fromCity = readCityName(text.slice(en.index + en[0].length));
  if (!fromCity) return null;
  const toPre = /^\s*to\s+/i.exec(fromCity.rest);
  if (!toPre) return null;
  const toCity = readCityName(fromCity.rest.slice(toPre[0].length));
  if (!toCity) return null;
  return pairFromNames(fromCity.name, toCity.name, toCity.rest);
}

function extractKazakhPair(text: string): CityPair | null {
  const kz =
    /([\p{L}0-9]+(?:-[\p{L}0-9]+)*(?:дан|ден|тан|тен|нан|нен))\s+([\p{L}0-9]+(?:-[\p{L}0-9]+)*(?:ға|ге|қа|ке))/iu.exec(
      text
    );
  if (!kz) return null;
  const rest = `${text.slice(0, kz.index)} ${text.slice(kz.index + kz[0].length)}`;
  return pairFromNames(kz[1], kz[2], rest);
}

function extractCityPair(text: string): CityPair | null {
  return extractPrefixedPair(text) || extractArrowPair(text) || extractEnglishPair(text) || extractKazakhPair(text);
}

function splitItemChunks(text: string): string[] {
  return text
    .split(/\n|,|;| и | және /i)
    .map((s) => s.replace(/[—–]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function parseItemChunk(chunk: string, skip: Set<string>): TransferParsedItem | null {
  const raw = chunk
    .replace(/[—–]/g, ' ')
    .replace(VERB, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;

  const qtyFirst = new RegExp(`^(\\d+(?:[.,]\\d+)?)(?:\\s*${COUNT_UNIT})?\\s+(.+)$`, 'i').exec(raw);
  if (qtyFirst && !startsWithWeightUnit(qtyFirst[2])) {
    const qty = parseQty(qtyFirst[1]);
    const name = cleanProductName(qtyFirst[2]);
    if (Number.isFinite(qty) && qty > 0 && name && !skip.has(nameKey(name))) {
      return { raw_name: name, qty };
    }
  }

  const qtyLastUnit = new RegExp(`^(.+?)\\s+(\\d+(?:[.,]\\d+)?)\\s*${COUNT_UNIT}\\.?$`, 'i').exec(raw);
  if (qtyLastUnit) {
    const qty = parseQty(qtyLastUnit[2]);
    const name = cleanProductName(qtyLastUnit[1]);
    if (Number.isFinite(qty) && qty > 0 && name && !skip.has(nameKey(name))) {
      return { raw_name: name, qty };
    }
  }

  const qtyLast = /^(.+?)\s+(\d+(?:[.,]\d+)?)\.?$/i.exec(raw);
  if (qtyLast && !new RegExp(`${WEIGHT_UNIT}$`, 'i').test(qtyLast[1].trim())) {
    const qty = parseQty(qtyLast[2]);
    const name = cleanProductName(qtyLast[1]);
    if (Number.isFinite(qty) && qty > 0 && name && !skip.has(nameKey(name))) {
      return { raw_name: name, qty };
    }
  }

  return null;
}

function extractItems(text: string, pair: CityPair): TransferParsedItem[] {
  const skip = new Set([nameKey(pair.from), nameKey(pair.to)]);
  const sources = pair.rest.trim() ? [pair.rest] : [text];
  const items: TransferParsedItem[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const chunk of splitItemChunks(source)) {
      if (ARROW.test(chunk) && !/\d/.test(chunk)) continue;
      const item = parseItemChunk(chunk, skip);
      if (!item) continue;
      const key = `${nameKey(item.raw_name)}:${item.qty}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return items;
}

export function parseTransferIntent(text: string): TransferIntent | null {
  const raw = text.trim();
  if (!raw || LOOKUP.test(raw)) return null;
  const pair = extractCityPair(raw);
  if (!pair) return null;
  const hasVerb = VERB.test(raw);
  const hasArrow = ARROW.test(raw);
  const items = extractItems(raw, pair);
  if (!hasVerb && !hasArrow && items.length === 0) return null;
  if (!hasVerb && !hasArrow && ORDER_HINT.test(raw)) return null;
  return {
    fromQuery: pair.from,
    toQuery: pair.to,
    items,
    comment: null,
  };
}
