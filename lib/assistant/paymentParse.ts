import type { PaymentType } from '@/lib/types';
import { extractPhonesCanon } from '@/lib/assistant/customerExtract';

const PAYMENT_LABELS: Record<PaymentType, string> = {
  cash: 'Наличные',
  kaspi: 'Kaspi',
  card: 'Карта',
  transfer: 'Перевод',
  debt: 'Долг',
};

export function paymentLabel(type: PaymentType | null, isDebt: boolean): string {
  if (isDebt) return PAYMENT_LABELS.debt;
  if (!type) return 'Не указан';
  return PAYMENT_LABELS[type];
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

export function detectPayment(text: string): {
  payment_type: PaymentType | null;
  is_debt: boolean;
  is_preorder: boolean;
  paid_unspecified: boolean;
  ambiguous: boolean;
} {
  const raw = String(text || '');
  const is_debt = /(в\s*долг|долг|қарыз|карыз|\bdebt\b)/i.test(raw);
  const is_preorder = /(предзаказ|алдын\s*ала|preorder)/i.test(raw);
  const paid_unspecified = /(төленген|толенген|оплачен|оплачено|\bpaid\b)/i.test(raw);
  if (is_debt) {
    return { payment_type: 'debt', is_debt, is_preorder, paid_unspecified, ambiguous: false };
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
    return { payment_type: null, is_debt, is_preorder, paid_unspecified, ambiguous: true };
  }
  return {
    payment_type: methods[0] || null,
    is_debt,
    is_preorder,
    paid_unspecified,
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
  const hasQty = /(^|\s)\d+([.,]\d+)?(\s|$)/.test(text);
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
