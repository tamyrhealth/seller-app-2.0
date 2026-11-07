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
};

function formatTransferNumber(n: string): string {
  const digits = n.replace(/^0+/, '') || '0';
  return digits.length >= 6 ? `T${digits}` : `T${digits.padStart(6, '0')}`;
}

export function parseTransferNumberQuery(text: string): string | null {
  const m = /(?:^|[^\w])t\s*0*(\d{1,8})(?:\b|$)/i.exec(text);
  return m ? formatTransferNumber(m[1]) : null;
}

function parseQty(raw: string): number {
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

function extractItems(text: string): TransferManageParsedItem[] {
  const items: TransferManageParsedItem[] = [];
  for (const line of text.split(/\n/).map((s) => s.trim()).filter(Boolean)) {
    if (/t\s*\d+/i.test(line) && !/\d.+\d/.test(line.replace(/t\s*0*\d+/i, ''))) continue;
    const qtyFirst = /^(\d+(?:[.,]\d+)?)\s+(.+)$/.exec(line);
    const qtyLast = /^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(?:шт|кг|kg|pcs)?$/i.exec(line);
    const hit = qtyFirst || qtyLast;
    if (!hit) continue;
    const qty = parseQty(qtyFirst ? hit[1] : hit[2]);
    let raw = (qtyFirst ? hit[2] : hit[1]).replace(/t\s*0*\d+/i, '').trim();
    raw = raw.replace(/^(прими|принять|получи|недостач\w*|верни|отмени)\s+/i, '').trim();
    if (!Number.isFinite(qty) || qty <= 0 || raw.length < 2) continue;
    if (/перемещ|отправк|остат|причин/i.test(raw) && raw.length < 8) continue;
    items.push({ raw_name: raw, qty });
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
  const receive = /(прими|принять|принят|получи|получить)/i.test(raw);
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
    items: extractItems(raw),
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
  };
}
