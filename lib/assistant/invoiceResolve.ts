import type { PaymentType } from '@/lib/types';
import type { ParsedInvoice } from '@/lib/assistant/invoiceParse';
import { resolveProductQuery, type CatalogProduct } from '@/lib/assistant/productAliases';
import type { CityMatchRow, SellerMatchRow } from '@/lib/assistant/sellerCityMatch';
import { resolveInvoiceSeller } from '@/lib/assistant/invoiceSeller';
import {
  detectPayment,
  parseLooseDate,
  parseLooseTime,
  paymentLabel,
} from '@/lib/assistant/paymentParse';
import { extractInvoiceCustomer } from '@/lib/assistant/customerExtract';
import { nameKey } from '@/lib/assistant/nameFold';
import { qtyValidationError } from '@/lib/assistant/qty';
import type {
  DraftIssue,
  DraftItemResolved,
  DraftPreview,
  DraftResolved,
  ResolveResult,
} from '@/lib/assistant/orderDraftTypes';

function issue(code: string, message: string): DraftIssue {
  return { code, message };
}

export function invoiceDateTime(parsed: ParsedInvoice, originalText: string): {
  invoice_date: string | null;
  invoice_time: string | null;
} {
  const invoice_date =
    parseLooseDate(parsed.pickup_date) ||
    parseLooseDate(originalText.match(/\d{1,2}[./-]\d{1,2}[./-]\d{4}/)?.[0] || '') ||
    parseLooseDate(parsed.pickup_date);
  const invoice_time = parseLooseTime(parsed.pickup_time) || parseLooseTime(originalText);
  return { invoice_date, invoice_time };
}

export function toDraftPreview(resolved: DraftResolved): DraftPreview {
  const total_ready = resolved.items.length > 0 && resolved.items.every((i) => Boolean(i.product_id) && !i.unresolved);
  return {
    seller_name: resolved.seller_name,
    city_name: resolved.city_name,
    items: resolved.items.map((i) => ({
      name: i.product_name || i.raw_name,
      qty: i.qty,
      price: i.price,
      is_gift: i.is_gift,
      line_sum: i.line_sum,
      unresolved: i.unresolved || !i.product_id,
      candidates: i.candidates,
    })),
    total_sum: total_ready ? resolved.total_sum : 0,
    total_ready,
    payment_label: paymentLabel(resolved.payment_type, resolved.is_debt, resolved.paid_status || null),
    paid_status: resolved.paid_status || null,
    is_debt: resolved.is_debt,
    is_preorder: resolved.is_preorder,
    invoice_date: resolved.invoice_date,
    invoice_time: resolved.invoice_time,
    pickup_date: resolved.pickup_date,
    customer_name: resolved.customer_name || null,
    customer_phone: resolved.customer_phone || null,
  };
}

export type InvoiceCatalogs = {
  sellers: SellerMatchRow[];
  cities: CityMatchRow[];
  products: CatalogProduct[];
  stockByCityProduct: Map<string, number>;
};

function stockKey(cityId: string, productId: string) {
  return `${cityId}:${productId}`;
}

export function resolveInvoiceFromCatalogs(
  parsed: ParsedInvoice,
  originalText: string,
  phones: string[],
  catalogs: InvoiceCatalogs
): ResolveResult {
  const errors: DraftIssue[] = [];
  const warnings: DraftIssue[] = [];
  const keywords = detectPayment(`${originalText}\n${parsed.payment_raw}`);
  const is_debt = parsed.is_debt === true || keywords.is_debt;
  const is_preorder = keywords.is_preorder && !is_debt;
  if ((parsed.is_debt || keywords.is_debt) && keywords.is_preorder) {
    errors.push(issue('debt_preorder', 'Нельзя одновременно оформить долг и предзаказ.'));
  }

  let payment_type: PaymentType | null = keywords.payment_type;
  if (is_debt) payment_type = 'debt';
  if (!is_debt && keywords.ambiguous) {
    payment_type = null;
    errors.push(
      issue(
        'payment_ambiguous',
        'Указано несколько способов оплаты. Выберите один в карточке: наличные, Kaspi, карта или перевод.'
      )
    );
  }
  if (!payment_type && keywords.paid_unspecified) {
    errors.push(
      issue(
        'payment_unspecified',
        'Накладная отмечена как оплаченная. Выберите Kaspi или наличные в карточке — способ сам не подставляю.'
      )
    );
  } else if (!payment_type && !is_debt && !keywords.ambiguous) {
    errors.push(
      issue(
        'payment_missing',
        keywords.paid_status === 'unpaid'
          ? 'Заказ не оплачен. Выберите способ оплаты в карточке (наличные, Kaspi, карта) или оформите долг.'
          : 'Способ оплаты не указан. Выберите наличные, Kaspi, карта или долг в карточке.'
      )
    );
  }

  const { invoice_date, invoice_time } = invoiceDateTime(parsed, originalText);
  const pickup_date = is_preorder ? invoice_date || new Date().toISOString().slice(0, 10) : null;

  const placed = resolveInvoiceSeller(
    parsed.seller_name,
    parsed.city_name,
    originalText,
    catalogs.sellers,
    catalogs.cities
  );
  errors.push(...placed.errors);
  const seller_id = placed.seller_id;
  const seller_name = placed.seller_name;
  const seller_candidates = placed.seller_candidates;
  const city_id = placed.city_id;
  const city_name = placed.city_name;
  const city_candidates = placed.city_candidates;

  const parsedItems = parsed.items.length ? parsed.items : [];
  if (parsedItems.length === 0) {
    errors.push(issue('items_missing', 'Товары не распознаны. Перечислите название и количество.'));
  }

  const items: DraftItemResolved[] = [];
  for (const raw of parsedItems) {
    const matched = resolveProductQuery(raw.name, catalogs.products);
    const qty = Number(raw.qty);
    const chosen = matched.chosen;
    const qtyErr = chosen ? qtyValidationError(qty, chosen.unit) : qtyValidationError(qty, 'pcs');
    if (matched.reason === 'none') {
      errors.push(issue('product_not_found', `Товар «${raw.name}» не найден. Новый товар не создаю.`));
    } else if (!chosen) {
      errors.push(issue('product_ambiguous', `Товар «${raw.name}» неоднозначен. Выберите вариант в карточке.`));
    }
    if (qtyErr) errors.push(issue('qty_invalid', `${raw.name}: ${qtyErr}`));
    const unresolved = !chosen;
    const price = raw.is_gift ? 0 : unresolved ? 0 : Number(chosen?.price_retail || 0);
    const qtySafe = Number.isFinite(qty) ? qty : 0;
    items.push({
      raw_name: raw.name,
      product_id: chosen?.id || null,
      product_name: chosen?.name || null,
      unit: chosen?.unit || null,
      qty: qtySafe,
      price,
      is_gift: raw.is_gift === true,
      stock: null,
      line_sum: unresolved ? 0 : qtySafe * price,
      unresolved,
      candidates:
        !chosen && matched.candidates.length
          ? matched.candidates.slice(0, 5).map((p) => ({
              id: p.id,
              name: p.name,
              price: Number(p.price_retail || 0),
            }))
          : undefined,
    });
  }

  if (city_id) {
    const need = new Map<string, number>();
    for (const item of items) {
      if (!item.product_id) continue;
      item.stock = catalogs.stockByCityProduct.get(stockKey(city_id, item.product_id)) ?? 0;
      need.set(item.product_id, (need.get(item.product_id) || 0) + item.qty);
    }
    if (!is_preorder) {
      for (const [pid, qty] of need) {
        const onHand = catalogs.stockByCityProduct.get(stockKey(city_id, pid)) ?? 0;
        const name = items.find((i) => i.product_id === pid)?.product_name || pid;
        if (onHand < qty) {
          errors.push(issue('insufficient_stock', `Недостаточно остатка: ${name}. Нужно ${qty}, на складе ${onHand}.`));
        }
      }
    }
  }

  const extractedEarly = extractInvoiceCustomer(originalText, seller_name);
  const phone = extractedEarly.phone || phones[0] || '';
  if (is_debt && !phone) {
    errors.push(issue('debt_phone', 'Для долга нужен телефон. Он не отправляется в ИИ, укажите его в накладной.'));
  }

  if (invoice_date && !is_preorder) {
    warnings.push(
      issue(
        'invoice_datetime_comment',
        'Дата и время накладной будут записаны в комментарий. Это не предзаказ. Время создания заказа — текущее.'
      )
    );
  }

  const total_sum = items.reduce((s, i) => s + i.line_sum, 0);
  const commentParts: string[] = [];
  if (invoice_date) commentParts.push(`Накладная: ${invoice_date}${invoice_time ? ` ${invoice_time}` : ''}`);
  if (parsed.note) commentParts.push(parsed.note.slice(0, 200));
  const comment = is_debt ? null : commentParts.join('. ') || null;

  const extracted = extractInvoiceCustomer(originalText, seller_name);
  const parsedCustomer = String(parsed.customer_name || '').trim() || null;
  const parsedCustomerOk =
    parsedCustomer && (!seller_name || nameKey(parsedCustomer) !== nameKey(seller_name))
      ? parsedCustomer
      : null;
  const customer_phone = extracted.phone || phone || null;
  const customer_name = extracted.name || parsedCustomerOk;

  const resolved: DraftResolved = {
    seller_id,
    seller_name,
    seller_candidates: seller_candidates.length > 1 ? seller_candidates : undefined,
    city_id,
    city_name,
    city_candidates: city_candidates.length > 1 ? city_candidates : undefined,
    payment_type,
    payment_raw: parsed.payment_raw,
    paid_status: keywords.paid_status,
    is_debt,
    is_preorder,
    pickup_date,
    invoice_date,
    invoice_time,
    comment,
    customer_name,
    customer_phone,
    debt_customer_name: is_debt ? customer_name : null,
    debt_due_at: null,
    debt_note: is_debt ? parsed.note || null : null,
    items,
    total_sum,
  };

  const preview = toDraftPreview(resolved);
  const idsReady =
    Boolean(seller_id && city_id) &&
    items.length > 0 &&
    items.every((i) => i.product_id && !i.unresolved) &&
    Boolean(payment_type);
  const can_confirm = errors.length === 0 && idsReady;
  return { resolved, preview, errors, warnings, can_confirm };
}

export function draftChoiceHints(errors: DraftIssue[]): string[] {
  const hints: string[] = [];
  const codes = new Set(errors.map((e) => e.code));
  if (codes.has('seller_missing') || codes.has('seller_not_found') || codes.has('seller_ambiguous')) {
    hints.push('Выберите продавца');
  }
  if (codes.has('city_missing') || codes.has('city_not_found') || codes.has('city_ambiguous') || codes.has('seller_city_mismatch')) {
    hints.push('Проверьте город');
  }
  if (codes.has('payment_unspecified') || codes.has('payment_missing') || codes.has('payment_ambiguous')) {
    hints.push('Выберите Kaspi или наличные');
  }
  if (codes.has('product_ambiguous')) hints.push('Выберите точный товар (SKU)');
  if (codes.has('product_not_found')) hints.push('Укажите товар из каталога');
  if (codes.has('insufficient_stock')) hints.push('Недостаточно остатка — уменьшите количество или оформите предзаказ');
  return hints;
}
