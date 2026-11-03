import type { PaymentType } from '@/lib/types';

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

export function detectPayment(text: string): {
  payment_type: PaymentType | null;
  is_debt: boolean;
  is_preorder: boolean;
  paid_unspecified: boolean;
} {
  const raw = text.toLowerCase();
  const is_debt = /(в\s*долг|долг|қарыз|карыз|\bdebt\b)/i.test(raw);
  const is_preorder = /(предзаказ|алдын\s*ала|preorder)/i.test(raw);
  const paid_unspecified = /(төленген|толенген|оплачен|оплачено|\bpaid\b)/i.test(raw);
  let payment_type: PaymentType | null = null;
  if (is_debt) payment_type = 'debt';
  else if (/(kaspi|каспи)/i.test(raw)) payment_type = 'kaspi';
  else if (/(карт|card)/i.test(raw)) payment_type = 'card';
  else if (/(перевод|аударым|transfer)/i.test(raw)) payment_type = 'transfer';
  else if (/(наличн|касса|қолма|колма|cash|ақша)/i.test(raw)) payment_type = 'cash';
  return { payment_type, is_debt, is_preorder, paid_unspecified };
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
  const matches = text.match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || [];
  const out: string[] = [];
  for (const raw of matches) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 10) continue;
    let n = digits;
    if (n.length === 11 && n.startsWith('8')) n = `7${n.slice(1)}`;
    if (n.length === 10 && n.startsWith('7')) n = `7${n}`;
    out.push(n);
  }
  return [...new Set(out)];
}
