import type { PaymentType } from '@/lib/types';
import { extractPhonesCanon } from '@/lib/assistant/customerExtract';

const PAYMENT_LABELS: Record<PaymentType, string> = {
  cash: 'Наличные',
  kaspi: 'Kaspi',
  card: 'Карта',
  transfer: 'Перевод',
  debt: 'Долг',
};

export function paymentLabel(
  type: PaymentType | null,
  isDebt: boolean,
  paidStatus?: PaidStatus
): string {
  if (isDebt) return PAYMENT_LABELS.debt;
  if (type) return PAYMENT_LABELS[type];
  if (paidStatus === 'paid') return 'Оплачено — выберите Kaspi или наличные';
  if (paidStatus === 'unpaid') return 'Не оплачено — выберите способ';
  return 'Не указан';
}

function escapeRe(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasPhrase(raw: string, phrase: string): boolean {
  const n = phrase.toLowerCase();
  const text = ` ${raw.toLowerCase().replace(/ё/g, 'е')} `;
  if (n.includes(' ') || n.includes('-')) {
    return text.replace(/-/g, ' ').includes(` ${n.replace(/-/g, ' ')} `) || text.includes(n);
  }
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}([^\\p{L}\\p{N}]|$)`, 'iu');
  return re.test(raw);
}

function hasAny(raw: string, phrases: string[]): boolean {
  return phrases.some((p) => hasPhrase(raw, p));
}

function isWarehouseTransferTalk(raw: string): boolean {
  return /(перевод\s+(товар|на\s+склад|со\s+склад|склад)|товар\S*\s+.*перевод|между\s+склад|перемещен|перемещение|перевод\s+склад)/i.test(
    raw
  );
}

export type PaidStatus = 'paid' | 'unpaid' | 'debt' | null;

export function detectPayment(text: string): {
  payment_type: PaymentType | null;
  is_debt: boolean;
  is_preorder: boolean;
  paid_unspecified: boolean;
  paid_status: PaidStatus;
  ambiguous: boolean;
} {
  const raw = String(text || '');
  const is_debt = /(в\s*долг|долг|қарыз|карыз|\bdebt\b)/i.test(raw);
  const is_preorder = /(предзаказ|алдын\s*ала|preorder)/i.test(raw);
  const is_unpaid = hasAny(raw, [
    'не оплачено',
    'не оплачен',
    'неоплачено',
    'неоплачен',
    'төленбеген',
    'толенбеген',
    'төленбеді',
    'unpaid',
  ]);
  const paidWord =
    !is_unpaid &&
    (hasAny(raw, ['төленген', 'толенген', 'оплачено', 'оплачена', 'оплачен', 'paid']) ||
      hasPhrase(raw, 'paid'));
  const paid_unspecified = paidWord && !is_debt;
  const paid_status: PaidStatus = is_debt ? 'debt' : is_unpaid ? 'unpaid' : paidWord ? 'paid' : null;
  if (is_debt) {
    return { payment_type: 'debt', is_debt, is_preorder, paid_unspecified: false, paid_status, ambiguous: false };
  }

  const found = new Set<Exclude<PaymentType, 'debt'>>();
  const kaspiQr = hasAny(raw, ['kaspi qr', 'каспи qr', 'каспи куар', 'kaspiqr', 'каспиqr']);
  const kaspiPay = hasAny(raw, ['kaspi pay', 'kaspi пэй', 'kaspi пей', 'каспи pay', 'каспи пэй', 'каспи пей']);
  const kaspiWord = hasAny(raw, ['kaspi', 'каспи', 'каспий']);
  const qrAlone = hasPhrase(raw, 'qr') || hasPhrase(raw, 'куар');
  if (kaspiQr || kaspiPay || kaspiWord || qrAlone) found.add('kaspi');

  if (hasAny(raw, ['нал', 'налом', 'наличка', 'наличку', 'наличные', 'наличными', 'наличкой', 'наличн', 'қолма-қол', 'қолма қол', 'колма-кол', 'колма кол', 'cash'])) {
    found.add('cash');
  }

  if (hasAny(raw, ['карта', 'картой', 'карточку', 'карточка', 'карточки', 'банк картасы', 'card'])) {
    found.add('card');
  }

  const transferWord = hasAny(raw, ['перевод', 'переводом', 'перевёл', 'перевел', 'аударым', 'аударды', 'transfer']);
  if (transferWord && !isWarehouseTransferTalk(raw)) found.add('transfer');

  const methods = [...found];
  if (methods.length > 1) {
    return { payment_type: null, is_debt, is_preorder, paid_unspecified, paid_status, ambiguous: true };
  }
  return {
    payment_type: methods[0] || null,
    is_debt,
    is_preorder,
    paid_unspecified: paid_unspecified && methods.length === 0,
    paid_status,
    ambiguous: false,
  };
}

export function parseLooseDate(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(t);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  return null;
}

export function parseLooseTime(raw: string): string | null {
  const m = /(\d{1,2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function looksLikeInvoice(text: string): boolean {
  const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);
  const hasQty =
    /(?:^|\s)\d+(?:[.,]\d+)?(?:\s*(?:шт\.?|штук(?:а|и)?|pcs|дана(?:сы)?|кг|kg|мл|ml|г|g)|\s|$)/iu.test(
      text
    );
  const hasWord = /[а-яёәғқңөұүһіa-z]{3,}/i.test(text);
  const keywords =
    /(накладн|заказ|төлен|толен|оплач|долг|қарыз|предзаказ|подарок|сыйлық|kaspi|каспи|налич)/i.test(
      text
    );
  if (lines.length >= 2 && hasQty && hasWord) return true;
  if (hasQty && hasWord && keywords) return true;
  return false;
}

export function extractPhones(text: string): string[] {
  return extractPhonesCanon(text);
}
