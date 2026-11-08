import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveProductQuery, type CatalogProduct } from '@/lib/assistant/productAliases';
import { foldTransferProductQuery } from '@/lib/assistant/transferProductFold';
import { qtyValidationError } from '@/lib/assistant/qty';
import {
  geoCityForTransferQuery,
  inCityPrepositional,
  matchTransferWarehouses,
} from '@/lib/assistant/transferCityMatch';
import type { TransferIntent } from '@/lib/assistant/transferIntent';
import type {
  TransferCityCandidate,
  TransferIssue,
  TransferItemResolved,
  TransferPreview,
  TransferPreviewCard,
  TransferResolved,
} from '@/lib/assistant/transferTypes';

export function actorCanManageTransfers(
  role: string | null | undefined,
  canManageTransfers: boolean
): { allowed: boolean; code: string; message: string } {
  if (role === 'admin') return { allowed: true, code: 'ok', message: '' };
  if (role === 'manager') {
    if (canManageTransfers) return { allowed: true, code: 'ok', message: '' };
    return {
      allowed: false,
      code: 'transfer_manage_forbidden',
      message: 'Управление перемещениями запрещено (can_manage_transfers = false). Можно только создать отправку, если есть can_create_transfers.',
    };
  }
  return {
    allowed: false,
    code: 'transfer_manage_forbidden',
    message: 'Продавец не может управлять перемещениями.',
  };
}

export function actorCanCreateTransfer(
  role: string | null | undefined,
  canCreateTransfers: boolean,
  _canManageTransfers = false
): { allowed: boolean; code: string; message: string } {
  if (role === 'admin') return { allowed: true, code: 'ok', message: '' };
  if (role === 'manager') {
    if (canCreateTransfers) return { allowed: true, code: 'ok', message: '' };
    return {
      allowed: false,
      code: 'transfer_forbidden',
      message: 'Создание перемещений для этой учётки запрещено (can_create_transfers = false).',
    };
  }
  return {
    allowed: false,
    code: 'transfer_forbidden',
    message: 'Продавец не может создавать перемещения.',
  };
}

function issue(code: string, message: string): TransferIssue {
  return { code, message };
}

function toPreview(resolved: TransferResolved): TransferPreview {
  return {
    from_city_name: resolved.from_city_name,
    to_city_name: resolved.to_city_name,
    from_city_candidates: resolved.from_city_candidates,
    to_city_candidates: resolved.to_city_candidates,
    items: resolved.items.map((i) => ({
      name: i.product_name || i.raw_name,
      qty: i.qty,
      unit: i.unit,
      stock: i.stock,
      unresolved: i.unresolved || !i.product_id,
      candidates: i.candidates,
    })),
  };
}

type CityRow = { id: string; name: string; is_active: boolean | null };

export function stockQtyForSource(
  fromCityId: string | null | undefined,
  stockByProduct: Map<string, number>,
  productId: string | null | undefined
): number | null {
  if (!fromCityId || !productId) return null;
  if (!stockByProduct.has(productId)) return 0;
  return Number(stockByProduct.get(productId) || 0);
}

export function shouldFlagInsufficientStock(
  fromCityId: string | null | undefined,
  qty: number,
  stock: number | null
): boolean {
  if (!fromCityId || stock == null) return false;
  return qty > stock;
}

export function mergeTransferEditItems(
  items: { product_id: string; qty: number; raw_name: string }[]
): { product_id: string; qty: number; raw_name: string }[] {
  const unresolved: { product_id: string; qty: number; raw_name: string }[] = [];
  const byId = new Map<string, { product_id: string; qty: number; raw_name: string }>();
  for (const row of items) {
    if (!row.product_id) {
      unresolved.push({ ...row, product_id: '' });
      continue;
    }
    const prev = byId.get(row.product_id);
    if (!prev) {
      byId.set(row.product_id, { product_id: row.product_id, qty: Number(row.qty), raw_name: row.raw_name });
      continue;
    }
    prev.qty += Number(row.qty);
  }
  return [...byId.values(), ...unresolved];
}

export function mergeResolvedTransferItems(items: TransferItemResolved[]): TransferItemResolved[] {
  const out: TransferItemResolved[] = [];
  const index = new Map<string, number>();
  for (const item of items) {
    if (!item.product_id) {
      out.push({ ...item });
      continue;
    }
    const at = index.get(item.product_id);
    if (at == null) {
      index.set(item.product_id, out.length);
      out.push({ ...item });
      continue;
    }
    out[at] = { ...out[at], qty: Number(out[at].qty) + Number(item.qty) };
  }
  return out.map((item) => {
    if (!item.product_id) return item;
    const qtyErr = qtyValidationError(item.qty, item.unit);
    return { ...item, unresolved: Boolean(qtyErr) };
  });
}

export function chooseTransferCity(
  query: string,
  cities: CityRow[],
  label: 'from' | 'to'
): {
  id: string | null;
  name: string | null;
  candidates: TransferCityCandidate[];
  errors: TransferIssue[];
} {
  const errors: TransferIssue[] = [];
  const prefix = label === 'from' ? 'Исходный' : 'Конечный';
  if (!query.trim()) {
    errors.push(issue(`${label}_city_missing`, `${prefix} город не указан.`));
    return { id: null, name: query || null, candidates: [], errors };
  }
  const hits = matchTransferWarehouses(query, cities);
  const activeHits = hits.filter((c) => {
    const row = cities.find((x) => x.id === c.id);
    return row ? row.is_active !== false : true;
  });
  if (activeHits.length === 0 && hits.length > 0) {
    const row = cities.find((c) => c.id === hits[0].id);
    const name = row?.name || query;
    errors.push(issue(`${label}_city_inactive`, `${prefix} город «${name}» неактивен.`));
    return { id: null, name, candidates: [], errors };
  }
  if (activeHits.length === 0) {
    errors.push(issue(`${label}_city_not_found`, `${prefix} город «${query}» не найден. Новый склад не создаю.`));
    return { id: null, name: query, candidates: [], errors };
  }
  const candidates = activeHits.map((c) => ({ id: c.id, name: c.name }));
  if (activeHits.length > 1) {
    const role = label === 'from' ? 'отправителя' : 'получателя';
    const geo = geoCityForTransferQuery(query);
    const place = geo ? inCityPrepositional(geo.nameRu) : query;
    errors.push(
      issue(
        `${label}_city_ambiguous`,
        geo
          ? `В ${place} найдено несколько складов. Выберите ${role}.`
          : `${prefix} склад неоднозначен. Выберите один: ${candidates.map((c) => c.name).join(', ')}.`
      )
    );
    return { id: null, name: query, candidates, errors };
  }
  const city = activeHits[0];
  const row = cities.find((c) => c.id === city.id);
  if (row && row.is_active === false) {
    errors.push(issue(`${label}_city_inactive`, `${prefix} город «${row.name}» неактивен.`));
    return { id: null, name: row.name, candidates: [], errors };
  }
  return { id: city.id, name: city.name, candidates: [], errors };
}

function resolveItem(
  raw_name: string,
  qty: number,
  catalog: CatalogProduct[],
  stockByProduct: Map<string, number>,
  fromCityId: string | null
): TransferItemResolved {
  const match = resolveProductQuery(foldTransferProductQuery(raw_name), catalog);
  const chosen = match.chosen;
  const unit = chosen?.unit || null;
  const qtyErr = qtyValidationError(qty, unit);
  const inactive = catalog.filter((p) => p.is_active === false && p.name.toLowerCase() === raw_name.toLowerCase());
  if (!chosen) {
    if (inactive.length) {
      return {
        raw_name,
        product_id: null,
        product_name: inactive[0].name,
        unit: inactive[0].unit,
        qty,
        stock: null,
        unresolved: true,
        candidates: [],
      };
    }
    return {
      raw_name,
      product_id: null,
      product_name: raw_name,
      unit: null,
      qty,
      stock: null,
      unresolved: true,
      candidates: (match.candidates || []).map((p) => ({ id: p.id, name: p.name })),
    };
  }
  const stock = stockQtyForSource(fromCityId, stockByProduct, chosen.id);
  return {
    raw_name,
    product_id: chosen.id,
    product_name: chosen.name,
    unit: chosen.unit,
    qty,
    stock,
    unresolved: Boolean(qtyErr),
    candidates: [],
  };
}

export async function resolveTransferDraft(
  db: SupabaseClient,
  intent: TransferIntent,
  actor: { role: string | null; can_create_transfers: boolean; can_manage_transfers?: boolean }
): Promise<{ content: string; preview: TransferPreviewCard }> {
  const errors: TransferIssue[] = [];
  const warnings: TransferIssue[] = [];
  const perm = actorCanCreateTransfer(
    actor.role,
    actor.can_create_transfers === true,
    actor.can_manage_transfers === true
  );
  if (!perm.allowed) errors.push(issue(perm.code, perm.message));

  const [{ data: cityRows }, { data: productRows }] = await Promise.all([
    db.from('cities').select('id, name, is_active').order('name'),
    db.from('products').select('id, name, unit, price_retail, is_active').order('name'),
  ]);
  const cities = (cityRows || []) as CityRow[];
  const catalog = (productRows || []) as CatalogProduct[];

  const from = chooseTransferCity(intent.fromQuery, cities, 'from');
  const to = chooseTransferCity(intent.toQuery, cities, 'to');
  errors.push(...from.errors, ...to.errors);
  if (from.id && to.id && from.id === to.id) {
    errors.push(issue('same_city', 'Исходный и конечный склады должны отличаться.'));
  }

  let stockByProduct = new Map<string, number>();
  if (from.id) {
    const { data: inv } = await db
      .from('inventory')
      .select('product_id, qty_on_hand')
      .eq('city_id', from.id);
    stockByProduct = new Map(
      (inv || []).map((row) => [String(row.product_id), Number(row.qty_on_hand || 0)])
    );
  }

  const items: TransferItemResolved[] = [];
  if (!intent.items.length) {
    errors.push(issue('items_missing', 'Не указаны товары и количества для отправки.'));
  }
  for (const row of intent.items.slice(0, 40)) {
    items.push(resolveItem(row.raw_name, row.qty, catalog, stockByProduct, from.id));
  }
  const mergedItems = mergeResolvedTransferItems(items);
  for (const item of mergedItems) {
    const product = catalog.find((p) => p.id === item.product_id);
    if (!item.product_id) {
      if (item.candidates?.length) {
        errors.push(
          issue(
            'product_ambiguous',
            `Товар «${item.raw_name}» неоднозначен: ${(item.candidates || []).map((c) => c.name).join(', ')}.`
          )
        );
      } else if (product?.is_active === false || (!product && item.product_name && item.unresolved)) {
        const inactiveHit = catalog.find(
          (p) => p.is_active === false && p.name.toLowerCase() === item.raw_name.toLowerCase()
        );
        if (inactiveHit) {
          errors.push(issue('product_inactive', `Товар «${inactiveHit.name}» неактивен.`));
        } else {
          errors.push(issue('product_not_found', `Товар «${item.raw_name}» не найден.`));
        }
      } else {
        errors.push(issue('product_not_found', `Товар «${item.raw_name}» не найден.`));
      }
      continue;
    }
    if (product?.is_active === false) {
      errors.push(issue('product_inactive', `Товар «${product.name}» неактивен.`));
    }
    const qtyErr = qtyValidationError(item.qty, item.unit);
    if (qtyErr) errors.push(issue('qty_invalid', `${item.product_name}: ${qtyErr}`));
    if (shouldFlagInsufficientStock(from.id, item.qty, item.stock)) {
      errors.push(
        issue(
          'insufficient_stock',
          `Недостаточно остатков «${item.product_name}» в ${from.name || 'исходном городе'}: нужно ${item.qty}, есть ${item.stock}.`
        )
      );
    }
  }

  const resolved: TransferResolved = {
    from_city_id: from.id,
    from_city_name: from.name,
    from_city_candidates: from.candidates,
    to_city_id: to.id,
    to_city_name: to.name,
    to_city_candidates: to.candidates,
    comment: intent.comment,
    items: mergedItems,
  };
  const can_confirm =
    errors.length === 0 && mergedItems.length > 0 && mergedItems.every((i) => i.product_id && !i.unresolved);
  const preview: TransferPreviewCard = {
    can_confirm,
    errors,
    warnings,
    resolved,
    preview: toPreview(resolved),
  };
  return { content: buildTransferChatMessage(preview), preview };
}

export function applyTransferEdit(
  cities: CityRow[],
  catalog: CatalogProduct[],
  stockByProduct: Map<string, number>,
  fromCityId: string,
  toCityId: string,
  items: { product_id: string; qty: number; raw_name: string }[],
  actor: { role: string | null; can_create_transfers: boolean; can_manage_transfers?: boolean }
): TransferPreviewCard {
  const errors: TransferIssue[] = [];
  const warnings: TransferIssue[] = [];
  const perm = actorCanCreateTransfer(
    actor.role,
    actor.can_create_transfers === true,
    actor.can_manage_transfers === true
  );
  if (!perm.allowed) errors.push(issue(perm.code, perm.message));

  const fromRow = cities.find((c) => c.id === fromCityId) || null;
  const toRow = cities.find((c) => c.id === toCityId) || null;
  if (!fromRow) errors.push(issue('from_city_not_found', 'Исходный город не найден.'));
  else if (fromRow.is_active === false) errors.push(issue('from_city_inactive', `Исходный город «${fromRow.name}» неактивен.`));
  if (!toRow) errors.push(issue('to_city_not_found', 'Конечный город не найден.'));
  else if (toRow.is_active === false) errors.push(issue('to_city_inactive', `Конечный город «${toRow.name}» неактивен.`));
  if (fromRow && toRow && fromRow.id === toRow.id) {
    errors.push(issue('same_city', 'Исходный и конечный склады должны отличаться.'));
  }

  const resolvedItems: TransferItemResolved[] = [];
  const editItems = mergeTransferEditItems(items).slice(0, 40);
  if (!editItems.length) errors.push(issue('items_missing', 'Добавьте товары из каталога.'));
  for (const row of editItems) {
    if (!row.product_id) {
      const item = resolveItem(row.raw_name, row.qty, catalog, stockByProduct, fromRow?.id || null);
      resolvedItems.push(item);
      if (!item.product_id) {
        if (item.candidates?.length) {
          errors.push(
            issue(
              'product_ambiguous',
              `Товар «${item.raw_name}» неоднозначен: ${(item.candidates || []).map((c) => c.name).join(', ')}.`
            )
          );
        } else {
          errors.push(issue('product_not_found', `Товар «${row.raw_name}» не найден.`));
        }
      } else {
        const product = catalog.find((p) => p.id === item.product_id);
        if (product?.is_active === false) errors.push(issue('product_inactive', `Товар «${product.name}» неактивен.`));
        const qtyErr = qtyValidationError(item.qty, item.unit);
        if (qtyErr) errors.push(issue('qty_invalid', `${item.product_name}: ${qtyErr}`));
        if (shouldFlagInsufficientStock(fromRow?.id || null, item.qty, item.stock)) {
          errors.push(
            issue(
              'insufficient_stock',
              `Недостаточно остатков «${item.product_name}» в ${fromRow?.name || 'исходном городе'}: нужно ${item.qty}, есть ${item.stock}.`
            )
          );
        }
      }
      continue;
    }
    const product = catalog.find((p) => p.id === row.product_id) || null;
    if (!product) {
      resolvedItems.push({
        raw_name: row.raw_name,
        product_id: null,
        product_name: row.raw_name,
        unit: null,
        qty: row.qty,
        stock: null,
        unresolved: true,
      });
      errors.push(issue('product_not_found', `Товар «${row.raw_name}» не найден.`));
      continue;
    }
    if (product.is_active === false) {
      errors.push(issue('product_inactive', `Товар «${product.name}» неактивен.`));
    }
    const qtyErr = qtyValidationError(row.qty, product.unit);
    const stock = stockQtyForSource(fromRow?.id || null, stockByProduct, product.id);
    if (qtyErr) errors.push(issue('qty_invalid', `${product.name}: ${qtyErr}`));
    if (shouldFlagInsufficientStock(fromRow?.id || null, row.qty, stock)) {
      errors.push(
        issue(
          'insufficient_stock',
          `Недостаточно остатков «${product.name}» в ${fromRow?.name || 'исходном городе'}: нужно ${row.qty}, есть ${stock}.`
        )
      );
    }
    resolvedItems.push({
      raw_name: row.raw_name || product.name,
      product_id: product.id,
      product_name: product.name,
      unit: product.unit,
      qty: row.qty,
      stock,
      unresolved: Boolean(qtyErr) || product.is_active === false,
    });
  }

  const resolved: TransferResolved = {
    from_city_id: fromRow?.id || null,
    from_city_name: fromRow?.name || null,
    to_city_id: toRow?.id || null,
    to_city_name: toRow?.name || null,
    comment: null,
    items: resolvedItems,
  };
  const can_confirm =
    errors.length === 0 && resolvedItems.length > 0 && resolvedItems.every((i) => i.product_id && !i.unresolved);
  return { can_confirm, errors, warnings, resolved, preview: toPreview(resolved) };
}

export function buildTransferChatMessage(card: TransferPreviewCard): string {
  const from = card.preview.from_city_name || '—';
  const to = card.preview.to_city_name || '—';
  const lines = [
    `Черновик перемещения: ${from} → ${to}.`,
    ...card.preview.items.map((i) => {
      const unit = i.unit || '';
      const stock =
        i.stock == null ? 'остаток после выбора исходного склада' : `остаток ${i.stock}`;
      return `• ${i.name}: ${i.qty}${unit ? ` ${unit}` : ''} (${stock})`;
    }),
  ];
  if (card.errors.length) lines.push(...card.errors.map((e) => `Ошибка: ${e.message}`));
  if (card.can_confirm) {
    lines.push('Проверьте карточку и нажмите «Подтвердить отправку». Само по себе сообщение склад не списывает.');
  } else {
    lines.push('Отправка заблокирована, пока не исправлены ошибки.');
  }
  return lines.join('\n');
}
