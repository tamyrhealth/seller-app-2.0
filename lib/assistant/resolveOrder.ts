import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentType } from '@/lib/types';
import type { ParsedInvoice } from '@/lib/assistant/invoiceParse';
import { matchCatalogProducts, normalizeName, type CatalogProduct } from '@/lib/assistant/productAliases';
import {
  detectPayment,
  parseLooseDate,
  parseLooseTime,
  paymentLabel,
} from '@/lib/assistant/paymentParse';
import { pricesEqual, qtyValidationError } from '@/lib/assistant/qty';
import type {
  DraftIssue,
  DraftItemResolved,
  DraftPreview,
  DraftResolved,
} from '@/lib/assistant/orderDraftTypes';

export type ResolveResult = {
  resolved: DraftResolved;
  preview: DraftPreview;
  errors: DraftIssue[];
  warnings: DraftIssue[];
  can_confirm: boolean;
};

function issue(code: string, message: string): DraftIssue {
  return { code, message };
}

function formatMoney(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

export function buildDraftMarkdown(result: ResolveResult): string {
  const { resolved, errors, warnings, can_confirm } = result;
  const lines: string[] = [];
  lines.push('Предварительный заказ (ещё не создан).');
  if (resolved.seller_name) lines.push(`Продавец: **${resolved.seller_name}**`);
  if (resolved.city_name) lines.push(`Город: **${resolved.city_name}**`);
  if (resolved.items.length) {
    lines.push('Товары:');
    for (const item of resolved.items) {
      const name = item.product_name || item.raw_name;
      const gift = item.is_gift ? ' (подарок)' : '';
      lines.push(
        `- ${name}${gift}: ${item.qty} × ${formatMoney(item.price)} = ${formatMoney(item.line_sum)}`
      );
    }
    lines.push(`Сумма: **${formatMoney(resolved.total_sum)}**`);
  }
  lines.push(`Оплата: ${paymentLabel(resolved.payment_type, resolved.is_debt)}`);
  if (resolved.is_preorder) lines.push(`Предзаказ, дата выдачи: ${resolved.pickup_date || 'не указана'}`);
  if (resolved.is_debt) lines.push('Долг: да (телефон на сервере, в модель не отправлялся).');
  if (resolved.invoice_date) {
    lines.push(
      `Дата накладной: ${resolved.invoice_date}${resolved.invoice_time ? ` ${resolved.invoice_time}` : ''}`
    );
  }
  if (warnings.length) {
    lines.push('Предупреждения:');
    for (const w of warnings) lines.push(`- ${w.message}`);
  }
  if (errors.length) {
    lines.push('Нужно уточнить:');
    for (const e of errors) lines.push(`- ${e.message}`);
  }
  if (can_confirm) {
    lines.push('Если всё верно — нажмите «Подтвердить заказ». Заказ не создаётся из текста чата.');
  } else {
    lines.push('Подтверждение заблокировано, пока не исправлены замечания. Заказ не создан.');
  }
  return lines.join('\n');
}

export async function resolveInvoiceDraft(
  db: SupabaseClient,
  parsed: ParsedInvoice,
  originalText: string,
  phones: string[]
): Promise<ResolveResult> {
  const errors: DraftIssue[] = [];
  const warnings: DraftIssue[] = [];
  const keywords = detectPayment(`${originalText}\n${parsed.payment_raw}`);
  const is_debt = parsed.is_debt === true || keywords.is_debt;
  const is_preorder = (parsed.is_preorder === true || keywords.is_preorder) && !is_debt;
  if (parsed.is_debt && parsed.is_preorder) {
    errors.push(issue('debt_preorder', 'Нельзя одновременно оформить долг и предзаказ.'));
  }

  let payment_type: PaymentType | null = keywords.payment_type;
  if (is_debt) payment_type = 'debt';
  if (!payment_type && keywords.paid_unspecified) {
    errors.push(issue('payment_unspecified', 'Оплата указана как «оплачено», но способ (наличные, Kaspi, карта) не назван.'));
  }
  if (!payment_type && !is_debt) {
    errors.push(issue('payment_missing', 'Способ оплаты не указан. Напишите наличные, Kaspi, карта или долг.'));
  }

  const invoice_date = parseLooseDate(parsed.pickup_date) || parseLooseDate(originalText.match(/\d{1,2}[./-]\d{1,2}[./-]\d{4}/)?.[0] || '');
  const invoice_time = parseLooseTime(parsed.pickup_time) || parseLooseTime(originalText);
  const pickup_date = is_preorder ? invoice_date || new Date().toISOString().slice(0, 10) : null;

  const { data: cities, error: cityErr } = await db.from('cities').select('id, name, is_active').eq('is_active', true);
  if (cityErr) throw new Error(cityErr.message);
  const cityList = cities || [];

  const { data: sellers, error: sellerErr } = await db
    .from('profiles')
    .select('id, display_name, city_id, role, is_active')
    .eq('role', 'seller')
    .eq('is_active', true);
  if (sellerErr) throw new Error(sellerErr.message);
  const sellerList = (sellers || []).filter((s) => s.city_id);

  const sellerQuery = normalizeName(parsed.seller_name);
  const sellerMatches = sellerQuery
    ? sellerList.filter((s) => {
        const name = normalizeName(String(s.display_name || ''));
        return name === sellerQuery || name.includes(sellerQuery) || sellerQuery.includes(name);
      })
    : [];

  let seller_id: string | null = null;
  let seller_name: string | null = parsed.seller_name || null;
  const seller_candidates = sellerMatches.map((s) => ({
    id: s.id as string,
    name: String(s.display_name || ''),
    city: cityList.find((c) => c.id === s.city_id)?.name || '',
  }));

  if (!sellerQuery) {
    errors.push(issue('seller_missing', 'Продавец не указан. Напишите имя существующего продавца.'));
  } else if (sellerMatches.length === 0) {
    errors.push(issue('seller_not_found', `Продавец «${parsed.seller_name}» не найден. Нового продавца не создаю.`));
  } else if (sellerMatches.length > 1) {
    const exact = sellerMatches.filter((s) => normalizeName(String(s.display_name || '')) === sellerQuery);
    if (exact.length === 1) {
      seller_id = exact[0].id as string;
      seller_name = String(exact[0].display_name || parsed.seller_name);
    } else {
      errors.push(
        issue(
          'seller_ambiguous',
          `Несколько продавцов с похожим именем: ${seller_candidates.map((s) => `${s.name} (${s.city || 'город ?'})`).join(', ')}. Уточните.`
        )
      );
    }
  } else {
    seller_id = sellerMatches[0].id as string;
    seller_name = String(sellerMatches[0].display_name || parsed.seller_name);
  }

  const cityQuery = normalizeName(parsed.city_name);
  const cityMatches = cityQuery
    ? cityList.filter((c) => {
        const name = normalizeName(String(c.name || ''));
        return name === cityQuery || name.includes(cityQuery) || cityQuery.includes(name);
      })
    : [];

  let city_id: string | null = null;
  let city_name: string | null = parsed.city_name || null;
  const city_candidates = cityMatches.map((c) => String(c.name || ''));

  const sellerRow = seller_id ? sellerList.find((s) => s.id === seller_id) : null;
  if (cityMatches.length > 1) {
    const exact = cityMatches.filter((c) => normalizeName(String(c.name || '')) === cityQuery);
    if (exact.length === 1) {
      city_id = exact[0].id as string;
      city_name = String(exact[0].name);
    } else {
      errors.push(issue('city_ambiguous', `Несколько городов: ${city_candidates.join(', ')}. Уточните.`));
    }
  } else if (cityMatches.length === 1) {
    city_id = cityMatches[0].id as string;
    city_name = String(cityMatches[0].name);
  } else if (cityQuery) {
    errors.push(issue('city_not_found', `Город «${parsed.city_name}» не найден. Новый склад не создаю.`));
  } else if (sellerRow?.city_id) {
    city_id = sellerRow.city_id as string;
    city_name = cityList.find((c) => c.id === city_id)?.name || null;
  } else {
    errors.push(issue('city_missing', 'Город не указан, и продавец не выбран однозначно. Укажите город.'));
  }

  if (sellerRow?.city_id && city_id && sellerRow.city_id !== city_id) {
    errors.push(
      issue(
        'seller_city_mismatch',
        `Продавец привязан к городу ${cityList.find((c) => c.id === sellerRow.city_id)?.name || ''}, а в накладной другой город.`
      )
    );
  }

  const { data: products, error: productErr } = await db
    .from('products')
    .select('id, name, unit, price_retail, is_active')
    .eq('is_active', true);
  if (productErr) throw new Error(productErr.message);
  const catalog = (products || []) as CatalogProduct[];

  const parsedItems = parsed.items.length
    ? parsed.items
    : [];
  if (parsedItems.length === 0) {
    errors.push(issue('items_missing', 'Товары не распознаны. Перечислите название и количество.'));
  }

  const items: DraftItemResolved[] = [];
  for (const raw of parsedItems) {
    const matches = matchCatalogProducts(raw.name, catalog);
    const qty = Number(raw.qty);
    const chosen = matches.length === 1 ? matches[0] : null;
    const qtyErr = chosen ? qtyValidationError(qty, chosen.unit) : qtyValidationError(qty, 'pcs');
    if (matches.length === 0) {
      errors.push(issue('product_not_found', `Товар «${raw.name}» не найден. Новый товар не создаю.`));
    } else if (matches.length > 1) {
      errors.push(
        issue(
          'product_ambiguous',
          `Товар «${raw.name}» неоднозначен: ${matches.map((p) => p.name).join(', ')}. Уточните.`
        )
      );
    }
    if (qtyErr) errors.push(issue('qty_invalid', `${raw.name}: ${qtyErr}`));
    const price = raw.is_gift ? 0 : Number(chosen?.price_retail || 0);
    items.push({
      raw_name: raw.name,
      product_id: chosen?.id || null,
      product_name: chosen?.name || null,
      unit: chosen?.unit || null,
      qty: Number.isFinite(qty) ? qty : 0,
      price,
      is_gift: raw.is_gift === true,
      stock: null,
      line_sum: (Number.isFinite(qty) ? qty : 0) * price,
      candidates: matches.length > 1 ? matches.map((p) => p.name) : undefined,
    });
  }

  if (city_id) {
    const productIds = items.map((i) => i.product_id).filter(Boolean) as string[];
    if (productIds.length) {
      const { data: inv, error: invErr } = await db
        .from('inventory')
        .select('product_id, qty_on_hand')
        .eq('city_id', city_id)
        .in('product_id', productIds);
      if (invErr) throw new Error(invErr.message);
      const stockMap = new Map((inv || []).map((r) => [r.product_id as string, Number(r.qty_on_hand || 0)]));
      const need = new Map<string, number>();
      for (const item of items) {
        if (!item.product_id) continue;
        item.stock = stockMap.get(item.product_id) ?? 0;
        need.set(item.product_id, (need.get(item.product_id) || 0) + item.qty);
      }
      if (!is_preorder) {
        for (const [pid, qty] of need) {
          const onHand = stockMap.get(pid) ?? 0;
          const name = items.find((i) => i.product_id === pid)?.product_name || pid;
          if (onHand < qty) {
            errors.push(
              issue('insufficient_stock', `Недостаточно остатка: ${name}. Нужно ${qty}, на складе ${onHand}.`)
            );
          }
        }
      }
    }
  }

  const phone = phones[0] || '';
  if (is_debt && !phone) {
    errors.push(issue('debt_phone', 'Для долга нужен телефон. Он не отправляется в ИИ, укажите его в накладной.'));
  }

  if (invoice_date && !is_preorder) {
    warnings.push(
      issue(
        'invoice_datetime_comment',
        'Дата и время накладной будут записаны в комментарий. Время создания заказа — текущее.'
      )
    );
  }

  const total_sum = items.reduce((s, i) => s + i.line_sum, 0);
  const commentParts: string[] = [];
  if (invoice_date) commentParts.push(`Накладная: ${invoice_date}${invoice_time ? ` ${invoice_time}` : ''}`);
  if (parsed.note) commentParts.push(parsed.note.slice(0, 200));
  const comment = is_debt ? null : commentParts.join('. ') || null;

  const resolved: DraftResolved = {
    seller_id,
    seller_name,
    seller_candidates: seller_candidates.length > 1 ? seller_candidates : undefined,
    city_id,
    city_name,
    city_candidates: city_candidates.length > 1 ? city_candidates : undefined,
    payment_type,
    payment_raw: parsed.payment_raw,
    is_debt,
    is_preorder,
    pickup_date,
    invoice_date,
    invoice_time,
    comment,
    debt_customer_name: is_debt ? seller_name : null,
    debt_due_at: null,
    debt_note: is_debt ? parsed.note || null : null,
    items,
    total_sum,
  };

  const preview: DraftPreview = {
    seller_name,
    city_name,
    items: items.map((i) => ({
      name: i.product_name || i.raw_name,
      qty: i.qty,
      price: i.price,
      is_gift: i.is_gift,
      line_sum: i.line_sum,
    })),
    total_sum,
    payment_label: paymentLabel(payment_type, is_debt),
    is_debt,
    is_preorder,
    invoice_date,
    invoice_time,
    pickup_date,
  };

  const idsReady =
    Boolean(seller_id && city_id) &&
    items.length > 0 &&
    items.every((i) => i.product_id) &&
    Boolean(payment_type);
  const can_confirm = errors.length === 0 && idsReady;

  return { resolved, preview, errors, warnings, can_confirm };
}

export async function revalidateResolved(
  db: SupabaseClient,
  resolved: DraftResolved,
  debtPhone: string | null
): Promise<{ ok: boolean; errors: DraftIssue[]; payload: Record<string, unknown> | null }> {
  const errors: DraftIssue[] = [];
  if (!resolved.seller_id || !resolved.city_id || !resolved.items.length) {
    return { ok: false, errors: [issue('incomplete', 'Черновик неполный.')], payload: null };
  }

  const { data: seller, error: sellerErr } = await db
    .from('profiles')
    .select('id, role, is_active, city_id, display_name')
    .eq('id', resolved.seller_id)
    .maybeSingle();
  if (sellerErr) throw new Error(sellerErr.message);
  if (!seller || seller.role !== 'seller' || seller.is_active === false || seller.city_id !== resolved.city_id) {
    errors.push(issue('seller_stale', 'Продавец больше недоступен или сменил город.'));
  }

  const productIds = resolved.items.map((i) => i.product_id).filter(Boolean) as string[];
  const { data: products, error: pErr } = await db
    .from('products')
    .select('id, name, unit, price_retail, is_active')
    .in('id', productIds);
  if (pErr) throw new Error(pErr.message);
  const byId = new Map((products || []).map((p) => [p.id as string, p]));

  const payloadItems: { product_id: string; qty: number; price: string; is_gift?: boolean }[] = [];
  const need = new Map<string, number>();
  for (const item of resolved.items) {
    if (!item.product_id) {
      errors.push(issue('product_missing', `Товар «${item.raw_name}» без идентификатора.`));
      continue;
    }
    const product = byId.get(item.product_id);
    if (!product || product.is_active === false) {
      errors.push(issue('product_stale', `Товар «${item.product_name || item.raw_name}» недоступен.`));
      continue;
    }
    const livePrice = item.is_gift ? 0 : Number(product.price_retail || 0);
    if (!item.is_gift && !pricesEqual(Number(item.price), livePrice)) {
      errors.push(
        issue(
          'price_changed',
          `Цена «${product.name}» изменилась: было ${item.price}, сейчас ${livePrice}. Отправьте накладную заново.`
        )
      );
    }
    const qtyErr = qtyValidationError(item.qty, product.unit as string);
    if (qtyErr) errors.push(issue('qty_invalid', `${product.name}: ${qtyErr}`));
    payloadItems.push({
      product_id: item.product_id,
      qty: item.qty,
      price: String(item.price),
      is_gift: item.is_gift || undefined,
    });
    need.set(item.product_id, (need.get(item.product_id) || 0) + item.qty);
  }

  if (!resolved.is_preorder && productIds.length) {
    const { data: inv, error: invErr } = await db
      .from('inventory')
      .select('product_id, qty_on_hand')
      .eq('city_id', resolved.city_id)
      .in('product_id', productIds);
    if (invErr) throw new Error(invErr.message);
    const stockMap = new Map((inv || []).map((r) => [r.product_id as string, Number(r.qty_on_hand || 0)]));
    for (const [pid, qty] of need) {
      const onHand = stockMap.get(pid) ?? 0;
      if (onHand < qty) {
        const name = byId.get(pid)?.name || pid;
        errors.push(issue('insufficient_stock', `Недостаточно остатка: ${name}. Нужно ${qty}, сейчас ${onHand}.`));
      }
    }
  }

  if (errors.length) return { ok: false, errors, payload: null };

  const payload: Record<string, unknown> = {
    seller_id: resolved.seller_id,
    city_id: resolved.city_id,
    items: payloadItems,
    payment_type: resolved.is_debt ? 'debt' : resolved.payment_type,
    comment: resolved.is_debt ? null : resolved.comment,
    is_preorder: resolved.is_preorder && !resolved.is_debt,
    pickup_date: resolved.is_preorder ? resolved.pickup_date : null,
  };
  if (resolved.is_debt) {
    const phone = (debtPhone || '').trim();
    if (!phone) {
      return { ok: false, errors: [issue('debt_phone', 'Для долга нужен телефон.')], payload: null };
    }
    payload.is_debt = true;
    payload.debt_customer_phone = phone;
    payload.debt_customer_name = resolved.debt_customer_name;
    payload.debt_due_at = resolved.debt_due_at;
    payload.debt_note = resolved.debt_note;
  }
  return { ok: true, errors: [], payload };
}
