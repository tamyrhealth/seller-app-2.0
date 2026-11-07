export type TransferManageKind = 'lookup' | 'list' | 'receive' | 'return_remainder' | 'shortage';

export type TransferManageParsedItem = { raw_name: string; qty: number };

export type TransferManageIntent = {
  kind: TransferManageKind;
  transferNumber: string | null;
  items: TransferManageParsedItem[];
  reason: string | null;
  listFilter: 'all' | 'in_transit';
  mineOnly: boolean;
  previewOnly: boolean;
  explicitAll: boolean;
};

function formatTransferNumber(n: string): string {
  const digits = n.replace(/^0+/, '') || '0';
  return digits.length >= 6 ? `T${digits}` : `T${digits.padStart(6, '0')}`;
}

export function parseTransferNumberQuery(text: string): string | null {
  const m = /(?:^|[^\w])t\s*0*(\d{1,8})(?:\b|$)/i.exec(text);
  return m ? formatTransferNumber(m[1]) : null;
}

const COUNT_UNIT = '(?:штук(?:а|и)?|шт|pcs|дана(?:сы)?)';
const WEIGHT_UNIT = '(?:г|гр|грамм(?:а|ов)?|g|кг|kg|мл|ml)';

function parseQty(raw: string): number {
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

function stripTransferClause(value: string): string {
  return value
    .replace(/t\s*0*\d+/gi, ' ')
    .replace(/\s+(?:из|по|от)\s+(?:перемещен\p{L}*|отправк\p{L}*)/giu, ' ')
    .replace(
      /\s+(?:перемещен\p{L}*|отправк\p{L}*|ауыстыру\p{L}*|жөнелт\p{L}*|жонелт\p{L}*)(?:ден|дан|тен|тан|нен|нан)?/giu,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanItemName(value: string): string {
  return stripTransferClause(value)
    .replace(/^(прими|принять|принят\p{L}*|получи|получить|қабылда\p{L}*|верни|отмени|недостач\p{L}*)\s+/iu, '')
    .replace(/\s+(из|в|на|қабылда\p{L}*|прими|получи)$/iu, '')
    .replace(/[.,;:!?—–]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseItemChunk(chunk: string): TransferManageParsedItem | null {
  const raw = chunk.replace(/[—–]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const qtyFirst = new RegExp(`(?:^|\\s)(\\d+(?:[.,]\\d+)?)(?:\\s*${COUNT_UNIT})?\\s+(.+)$`, 'i').exec(raw);
  if (qtyFirst && !new RegExp(`^${WEIGHT_UNIT}\\b`, 'i').test(qtyFirst[2].trim())) {
    const qty = parseQty(qtyFirst[1]);
    const name = cleanItemName(qtyFirst[2]);
    if (Number.isFinite(qty) && qty > 0 && name.length >= 2) return { raw_name: name, qty };
  }
  const qtyLastUnit = new RegExp(`^(.+?)\\s+(\\d+(?:[.,]\\d+)?)\\s*${COUNT_UNIT}\\.?$`, 'i').exec(raw);
  if (qtyLastUnit) {
    const qty = parseQty(qtyLastUnit[2]);
    const name = cleanItemName(qtyLastUnit[1]);
    if (Number.isFinite(qty) && qty > 0 && name.length >= 2) return { raw_name: name, qty };
  }
  const qtyLast = /^(.+?)\s+(\d+(?:[.,]\d+)?)\.?$/i.exec(raw);
  if (qtyLast && !new RegExp(`${WEIGHT_UNIT}$`, 'i').test(qtyLast[1].trim())) {
    const qty = parseQty(qtyLast[2]);
    const name = cleanItemName(qtyLast[1]);
    if (Number.isFinite(qty) && qty > 0 && name.length >= 2) return { raw_name: name, qty };
  }
  return null;
}

export function extractTransferManageItems(text: string): TransferManageParsedItem[] {
  const source = stripTransferClause(text);
  const items: TransferManageParsedItem[] = [];
  const seen = new Set<string>();
  for (const chunk of source.split(/\n|,|;| и | және /i).map((s) => s.trim()).filter(Boolean)) {
    const item = parseItemChunk(chunk);
    if (!item) continue;
    const key = `${item.raw_name.toLowerCase()}:${item.qty}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

function extractReason(text: string): string | null {
  const labeled = /(?:причин\S*|reason)\s*[:\-–]?\s*(.+)$/i.exec(text.replace(/\n/g, ' '));
  if (labeled) {
    const reason = labeled[1].replace(/t\s*0*\d+/gi, '').trim();
    return reason || null;
  }
  return null;
}

export function parseTransferManageIntent(text: string): TransferManageIntent | null {
  const raw = text.trim();
  if (!raw) return null;
  if (/(заказ|тапсырыс|order)\s*n?\s*\d+/i.test(raw) && !/t\s*\d+/i.test(raw)) return null;

  const transferNumber = parseTransferNumberQuery(raw);
  const receive = /(прими|принять|принят|получи|получить|қабылда)/i.test(raw);
  const ret =
    /(верн\S*\s+остат|верни.{0,30}отправител|отмени.{0,24}(отправк|перемещ)|cancel.{0,20}transfer)/i.test(raw);
  const shortage = /(недостач|спиши недостач|оформи недостач|write.?off)/i.test(raw);
  const lookupWord = /(где|статус|покажи|история|список|что с)/i.test(raw);
  const transferWord = /(перемещен\w*|отправк\w*|\btransfer\b)/i.test(raw);
  const inTransitList =
    /(ожида\w*.{0,24}при[её]м|ждут\s+при[её]м|к при[её]мк|непринят|в пути|awaiting|pending\s+receiv|waiting\s+(for\s+)?receiv)/i.test(
      raw
    );
  const mineOnly = /(мои|моих|\bmy\b)/i.test(raw);
  const previewOnly =
    /(ничего не провод|не провод[иь]|не подтвержда|только покажи|покажи товар)/i.test(raw);
  const explicitAll = /(все|всё|весь остаток|целиком|толық|барлық|барлығы)/i.test(raw);

  let kind: TransferManageKind | null = null;
  if (shortage && (transferNumber || transferWord)) kind = 'shortage';
  else if (ret && (transferNumber || transferWord)) kind = 'return_remainder';
  else if (receive && (transferNumber || transferWord)) kind = 'receive';
  else if (transferNumber) kind = 'lookup';
  else if (lookupWord && transferWord) kind = 'list';
  else return null;

  return {
    kind,
    transferNumber,
    items: extractTransferManageItems(raw),
    reason:
      extractReason(raw) ||
      (shortage
        ? raw
            .replace(/t\s*0*\d+/gi, '')
            .replace(/(недостач\S*|прими|принят\S*|получи\S*|перемещен\S*|отправк\S*)/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        : null),
    listFilter: kind === 'list' && inTransitList ? 'in_transit' : 'all',
    mineOnly: kind === 'list' && mineOnly,
    previewOnly,
    explicitAll: (kind === 'receive' || kind === 'shortage') && explicitAll,
  };
}
