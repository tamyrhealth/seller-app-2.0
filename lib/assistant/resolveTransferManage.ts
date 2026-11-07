import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { matchTransferCatalogProduct } from '@/lib/assistant/productAliases';
import { actorCanManageTransfers } from '@/lib/assistant/resolveTransfer';
import type { TransferManageIntent } from '@/lib/assistant/transferManageIntent';
import type {
  TransferManageEvent,
  TransferManageIssue,
  TransferManageLine,
  TransferManagePreview,
} from '@/lib/assistant/transferManageTypes';
import { transferDisplayStatus, transferLineQtys, transferRemaining } from '@/lib/stockTransfer';

type Actor = { id?: string | null; role: string | null; can_manage_transfers: boolean };

export type TransferManageListRow = {
  transfer_number: string;
  from_city_name: string;
  to_city_name: string;
  status: string;
  remaining: number;
  created_by?: string | null;
};

export function filterTransferManageList(
  rows: TransferManageListRow[],
  opts: { inTransit: boolean; mineOnly: boolean; actorId: string | null }
): TransferManageListRow[] {
  return rows.filter((row) => {
    if (opts.inTransit && !(row.remaining > 0)) return false;
    if (opts.mineOnly && opts.actorId && row.created_by !== opts.actorId) return false;
    return true;
  });
}

export type TransferManageMutationSnapshot = {
  remaining: number;
  received: number;
  returned: number;
  lost: number;
  events: number;
};

export function transferManageMutationSnapshot(preview: TransferManagePreview): TransferManageMutationSnapshot {
  return {
    remaining: preview.remaining,
    received: preview.items.reduce((sum, item) => sum + item.qty_received, 0),
    returned: preview.items.reduce((sum, item) => sum + item.qty_returned, 0),
    lost: preview.items.reduce((sum, item) => sum + item.qty_lost, 0),
    events: preview.events.length,
  };
}

export function didManageMutationApply(
  kind: TransferManagePreview['kind'],
  before: TransferManageMutationSnapshot,
  after: TransferManageMutationSnapshot
): boolean {
  if (after.events > before.events) return true;
  if (after.remaining < before.remaining) return true;
  if (kind === 'receive' && after.received > before.received) return true;
  if (kind === 'return_remainder' && after.returned > before.returned) return true;
  if (kind === 'shortage' && after.lost > before.lost) return true;
  if (before.remaining <= 0 && after.remaining <= 0) return true;
  return false;
}

export async function fetchTransferManageLive(
  db: SupabaseClient,
  base: TransferManagePreview
): Promise<TransferManagePreview | null> {
  if (!base.transfer_id) return null;
  const { data: tr, error } = await db
    .from('stock_transfers')
    .select(
      'id, transfer_number, from_city_id, to_city_id, status, created_by, created_at, stock_transfer_items(product_id, qty_sent, qty_received, qty_lost, qty_returned, products(name, unit))'
    )
    .eq('id', base.transfer_id)
    .maybeSingle();
  if (error || !tr) return null;
  const { data: cities } = await db.from('cities').select('id, name');
  const cityName = (id: string | null) => cities?.find((c) => c.id === id)?.name || id?.slice(0, 8) || null;
  const { data: eventRows } = await db
    .from('stock_transfer_events')
    .select('action, actor_id, details, created_at')
    .eq('transfer_id', tr.id)
    .order('created_at', { ascending: true });
  const actorIds = [...new Set((eventRows || []).map((e) => e.actor_id).filter(Boolean) as string[])];
  if (tr.created_by) actorIds.push(String(tr.created_by));
  const { data: actorProfiles } =
    actorIds.length > 0
      ? await db.from('profiles').select('id, display_name').in('id', [...new Set(actorIds)])
      : { data: [] };
  const nameById = new Map((actorProfiles || []).map((p) => [p.id as string, (p.display_name as string) || p.id.slice(0, 8)]));
  const items: TransferManageLine[] = (
    (tr.stock_transfer_items || []) as Array<{
      product_id: string;
      qty_sent: number;
      qty_received: number | null;
      qty_lost: number | null;
      qty_returned: number | null;
      products?: { name?: string; unit?: string | null } | { name?: string; unit?: string | null }[] | null;
    }>
  ).map((row) => {
    const prod = Array.isArray(row.products) ? row.products[0] : row.products;
    const q = transferLineQtys(row);
    return {
      product_id: row.product_id,
      name: prod?.name || row.product_id.slice(0, 8),
      unit: prod?.unit || null,
      qty_sent: q.sent,
      qty_received: q.received,
      qty_returned: q.returned,
      qty_lost: q.lost,
      remaining: q.remaining,
      action_qty: 0,
    };
  });
  const remaining = items.reduce((sum, item) => sum + item.remaining, 0);
  const events: TransferManageEvent[] = (eventRows || []).map((e) => {
    const details = (e.details && typeof e.details === 'object' ? e.details : {}) as Record<string, unknown>;
    return {
      action: String(e.action),
      actor_id: e.actor_id || null,
      actor_name: e.actor_id ? nameById.get(e.actor_id) || e.actor_id.slice(0, 8) : null,
      created_at: String(e.created_at),
      reason: typeof details.reason === 'string' ? details.reason : null,
    };
  });
  return {
    ...base,
    can_confirm: false,
    transfer_number: String(tr.transfer_number),
    from_city_name: cityName(String(tr.from_city_id)),
    to_city_name: cityName(String(tr.to_city_id)),
    status: transferDisplayStatus({
      status: String(tr.status),
      remaining,
      received: items.reduce((sum, item) => sum + item.qty_received, 0),
      lost: items.reduce((sum, item) => sum + item.qty_lost, 0),
    }),
    created_by_name: tr.created_by ? nameById.get(String(tr.created_by)) || String(tr.created_by).slice(0, 8) : base.created_by_name,
    remaining,
    items,
    events,
    errors: [],
  };
}

export function collectTransferManageActionErrors(args: {
  kind: TransferManagePreview['kind'];
  remaining: number;
  items: Array<{ name: string; action_qty: number; remaining: number }>;
  reason: string | null;
  skipQtyPrompt?: boolean;
}): TransferManageIssue[] {
  const errors: TransferManageIssue[] = [];
  if (args.kind !== 'receive' && args.kind !== 'return_remainder' && args.kind !== 'shortage') {
    return errors;
  }
  if (args.remaining <= 0) {
    if (args.kind === 'shortage') {
      errors.push(issue('nothing_remaining', 'В пути ничего не осталось. Недостачу повторно списать нельзя.'));
    } else if (args.kind === 'return_remainder') {
      errors.push(issue('nothing_remaining', 'В пути ничего не осталось. Повторно вернуть остаток нельзя.'));
    } else {
      errors.push(issue('nothing_remaining', 'В пути ничего не осталось. Повторно принять нельзя.'));
    }
    return errors;
  }
  for (const line of args.items) {
    if (line.action_qty < 0) errors.push(issue('qty_invalid', `${line.name}: некорректное количество.`));
    if (line.action_qty > line.remaining) {
      errors.push(issue('qty_exceeds', `${line.name}: нужно не больше остатка в пути ${line.remaining}.`));
    }
  }
  if (args.kind === 'receive' && !args.items.some((i) => i.action_qty > 0) && !args.skipQtyPrompt) {
    errors.push(
      issue(
        'items_missing',
        'Укажите количество к приёмке, например «прими 2 штуки …». Весь остаток автоматически не принимаю.'
      )
    );
  }
  if (args.kind === 'shortage') {
    const reason = (args.reason || '').trim();
    if (reason.length < 3) errors.push(issue('reason_required', 'Для недостачи нужна обязательная причина.'));
    if (!args.items.some((i) => i.action_qty > 0) && !args.skipQtyPrompt) {
      errors.push(issue('items_missing', 'Укажите количество недостачи.'));
    }
  }
  return errors;
}

function issue(code: string, message: string): TransferManageIssue {
  return { code, message };
}

function emptyPreview(
  kind: TransferManagePreview['kind'],
  errors: TransferManageIssue[],
  extras: Partial<TransferManagePreview> = {}
): TransferManagePreview {
  return {
    kind,
    can_confirm: false,
    transfer_id: null,
    transfer_number: extras.transfer_number || null,
    from_city_name: null,
    to_city_name: null,
    status: null,
    created_by_name: null,
    created_at: null,
    remaining: 0,
    items: [],
    events: [],
    list: extras.list || [],
    empty_list_message: extras.empty_list_message || null,
    reason: extras.reason || null,
    errors,
    operation_id: extras.operation_id || randomUUID(),
  };
}

export function assignManageActionQty(opts: {
  kind: TransferManagePreview['kind'];
  remaining: number;
  matchedQty: number | undefined;
  takeAllRemaining: boolean;
}): number {
  if (opts.kind === 'lookup' || opts.kind === 'list') return 0;
  if (opts.kind === 'return_remainder') return opts.remaining;
  if (opts.matchedQty != null) return opts.matchedQty;
  if (opts.takeAllRemaining) return opts.remaining;
  return 0;
}

export function buildTransferManageMessage(preview: TransferManagePreview): string {
  if (preview.kind === 'list') {
    const lines = ['Доступные перемещения:'];
    if (!preview.list.length) lines.push(preview.empty_list_message || 'Ничего не найдено.');
    for (const row of preview.list) {
      lines.push(`• ${row.transfer_number}: ${row.from_city_name} → ${row.to_city_name}, ${row.status}, в пути ${row.remaining}`);
    }
    if (preview.errors.length) lines.push(...preview.errors.map((e) => `Ошибка: ${e.message}`));
    return lines.join('\n');
  }
  const lines = [
    `${preview.transfer_number || 'Перемещение'}: ${preview.from_city_name || '—'} → ${preview.to_city_name || '—'}.`,
    `Статус: ${preview.status || '—'}. В пути: ${preview.remaining}.`,
    ...preview.items.map((i) => {
      const leftover = Number((i.remaining - i.action_qty).toFixed(3));
      const actionLabel =
        preview.kind === 'shortage' ? 'к списанию' : preview.kind === 'return_remainder' ? 'к возврату' : 'к приёмке';
      const action =
        i.action_qty > 0 && preview.kind !== 'lookup' && preview.kind !== 'list'
          ? `, ${actionLabel} ${i.action_qty}, останется ${leftover}`
          : '';
      return `• ${i.name}: отправлено ${i.qty_sent}, принято ${i.qty_received}, возвращено ${i.qty_returned}, списано ${i.qty_lost}, в пути ${i.remaining}${action}`;
    }),
  ];
  if (preview.events.length) {
    lines.push('История:');
    for (const ev of preview.events) {
      lines.push(`• ${ev.created_at} · ${ev.action} · ${ev.actor_name || ev.actor_id?.slice(0, 8) || '—'}${ev.reason ? ` · ${ev.reason}` : ''}`);
    }
  }
  if (preview.errors.length) lines.push(...preview.errors.map((e) => `Ошибка: ${e.message}`));
  if (preview.can_confirm) {
    if (preview.kind === 'receive') lines.push('Проверьте количества и нажмите «Подтвердить приёмку».');
    if (preview.kind === 'return_remainder') lines.push('Нажмите «Вернуть остаток отправителю». Уже принятое не возвращается.');
    if (preview.kind === 'shortage') lines.push('Нажмите «Подтвердить недостачу». Нужна причина.');
  }
  return lines.join('\n');
}

export async function resolveTransferManage(
  db: SupabaseClient,
  intent: TransferManageIntent,
  actor: Actor
): Promise<{ content: string; preview: TransferManagePreview }> {
  const perm = actorCanManageTransfers(actor.role, actor.can_manage_transfers === true);
  if (intent.kind === 'list') {
    if (!perm.allowed) {
      const preview = emptyPreview('list', [issue(perm.code, perm.message)]);
      return { content: buildTransferManageMessage(preview), preview };
    }
    const { data: rows } = await db
      .from('stock_transfers')
      .select(
        'id, transfer_number, from_city_id, to_city_id, status, created_by, created_at, stock_transfer_items(qty_sent, qty_received, qty_lost, qty_returned)'
      )
      .order('created_at', { ascending: false })
      .limit(100);
    const { data: cities } = await db.from('cities').select('id, name');
    const cityName = (id: string) => cities?.find((c) => c.id === id)?.name || id.slice(0, 8);
    const mapped = (rows || []).map((row) => {
      const items = (row.stock_transfer_items || []) as Array<{
        qty_sent: number;
        qty_received: number | null;
        qty_lost: number | null;
        qty_returned: number | null;
      }>;
      const remaining = items.reduce(
        (sum, item) => sum + transferRemaining(item.qty_sent, item.qty_received, item.qty_lost, item.qty_returned),
        0
      );
      return {
        transfer_number: String(row.transfer_number),
        from_city_name: cityName(String(row.from_city_id)),
        to_city_name: cityName(String(row.to_city_id)),
        status: transferDisplayStatus({
          status: String(row.status),
          remaining,
          received: items.reduce((s, i) => s + Number(i.qty_received || 0), 0),
          lost: items.reduce((s, i) => s + Number(i.qty_lost || 0), 0),
        }),
        remaining,
        created_by: row.created_by ? String(row.created_by) : null,
      };
    });
    const inTransit = intent.listFilter === 'in_transit';
    const list = filterTransferManageList(mapped, {
      inTransit,
      mineOnly: intent.mineOnly,
      actorId: actor.id || null,
    }).map((row) => ({
      transfer_number: row.transfer_number,
      from_city_name: row.from_city_name,
      to_city_name: row.to_city_name,
      status: row.status,
      remaining: row.remaining,
    }));
    const empty_list_message = list.length
      ? null
      : inTransit && intent.mineOnly
        ? 'Нет ваших перемещений, ожидающих приёмки.'
        : inTransit
          ? 'Нет перемещений, ожидающих приёмки.'
          : 'Ничего не найдено.';
    const preview = emptyPreview(intent.kind, [], { list, empty_list_message });
    preview.can_confirm = false;
    return { content: buildTransferManageMessage(preview), preview };
  }

  if (!intent.transferNumber) {
    const preview = emptyPreview(intent.kind, [issue('transfer_number_missing', 'Укажите номер перемещения, например T000005.')]);
    return { content: buildTransferManageMessage(preview), preview };
  }

  const { data: tr, error } = await db
    .from('stock_transfers')
    .select(
      'id, transfer_number, from_city_id, to_city_id, status, created_by, created_at, stock_transfer_items(product_id, qty_sent, qty_received, qty_lost, qty_returned, products(name, unit))'
    )
    .eq('transfer_number', intent.transferNumber)
    .maybeSingle();
  if (error) {
    const preview = emptyPreview(intent.kind, [issue('lookup_failed', error.message)], {
      transfer_number: intent.transferNumber,
    });
    return { content: buildTransferManageMessage(preview), preview };
  }
  if (!tr) {
    const preview = emptyPreview(
      intent.kind,
      [
        issue(
          'not_found',
          perm.allowed
            ? `Перемещение ${intent.transferNumber} не найдено.`
            : actor.role === 'manager'
              ? `Перемещение ${intent.transferNumber} недоступно. Для приёмки чужих отправок нужен флаг can_manage_transfers.`
              : `Перемещение ${intent.transferNumber} не найдено.`
        ),
      ],
      { transfer_number: intent.transferNumber }
    );
    return { content: buildTransferManageMessage(preview), preview };
  }

  const { data: cities } = await db.from('cities').select('id, name');
  const cityName = (id: string | null) => cities?.find((c) => c.id === id)?.name || id?.slice(0, 8) || null;
  const { data: creator } = tr.created_by
    ? await db.from('profiles').select('id, display_name').eq('id', tr.created_by).maybeSingle()
    : { data: null };
  const { data: eventRows } = await db
    .from('stock_transfer_events')
    .select('action, actor_id, details, created_at')
    .eq('transfer_id', tr.id)
    .order('created_at', { ascending: true });
  const actorIds = [...new Set((eventRows || []).map((e) => e.actor_id).filter(Boolean) as string[])];
  const { data: actorProfiles } =
    actorIds.length > 0
      ? await db.from('profiles').select('id, display_name').in('id', actorIds)
      : { data: [] };
  const nameById = new Map((actorProfiles || []).map((p) => [p.id as string, (p.display_name as string) || p.id.slice(0, 8)]));
  if (creator?.id) nameById.set(creator.id, creator.display_name || creator.id.slice(0, 8));

  const catalog = ((tr.stock_transfer_items || []) as Array<{
    product_id: string;
    qty_sent: number;
    qty_received: number | null;
    qty_lost: number | null;
    qty_returned: number | null;
    products?: { name?: string; unit?: string | null } | { name?: string; unit?: string | null }[] | null;
  }>).map((row) => {
    const prod = Array.isArray(row.products) ? row.products[0] : row.products;
    const q = transferLineQtys(row);
    return {
      product_id: row.product_id,
      name: prod?.name || row.product_id.slice(0, 8),
      unit: prod?.unit || null,
      ...q,
    };
  });

  const matchedQty = new Map<string, number>();
  const errors: TransferManageIssue[] = [];
  if (!perm.allowed && intent.kind !== 'lookup') {
    errors.push(issue(perm.code, perm.message));
  }
  if (intent.kind !== 'lookup' && intent.items.length) {
    for (const row of intent.items) {
      const hit = matchTransferCatalogProduct(
        row.raw_name,
        catalog.map((c) => ({
          id: c.product_id,
          name: c.name,
          unit: c.unit,
          price_retail: 0,
          is_active: true,
        }))
      );
      if (!hit.chosen) {
        if ((hit.candidates || []).length > 1) {
          errors.push(
            issue(
              'product_ambiguous',
              `Товар «${row.raw_name}» неоднозначен: ${hit.candidates.map((p) => p.name).join(', ')}. Уточните.`
            )
          );
        } else {
          errors.push(issue('product_not_found', `Товар «${row.raw_name}» не найден в этом перемещении.`));
        }
        continue;
      }
      matchedQty.set(hit.chosen.id, (matchedQty.get(hit.chosen.id) || 0) + row.qty);
    }
  }

  const takeAllRemaining =
    (intent.kind === 'receive' || intent.kind === 'shortage') && intent.explicitAll && intent.items.length === 0;
  const items: TransferManageLine[] = catalog.map((c) => {
    const remaining = c.remaining;
    const action_qty = assignManageActionQty({
      kind: intent.kind,
      remaining,
      matchedQty: matchedQty.has(c.product_id) ? Number(matchedQty.get(c.product_id)) : undefined,
      takeAllRemaining,
    });
    return {
      product_id: c.product_id,
      name: c.name,
      unit: c.unit,
      qty_sent: c.sent,
      qty_received: c.received,
      qty_returned: c.returned,
      qty_lost: c.lost,
      remaining,
      action_qty,
    };
  });
  const remaining = items.reduce((s, i) => s + i.remaining, 0);
  const status = transferDisplayStatus({
    status: String(tr.status),
    remaining,
    received: items.reduce((s, i) => s + i.qty_received, 0),
    lost: items.reduce((s, i) => s + i.qty_lost, 0),
  });

  errors.push(
    ...collectTransferManageActionErrors({
      kind: intent.kind,
      remaining,
      items,
      reason: intent.reason,
      skipQtyPrompt: errors.some((e) => e.code === 'product_not_found' || e.code === 'product_ambiguous'),
    })
  );

  const events: TransferManageEvent[] = (eventRows || []).map((e) => {
    const details = (e.details && typeof e.details === 'object' ? e.details : {}) as Record<string, unknown>;
    return {
      action: String(e.action),
      actor_id: e.actor_id || null,
      actor_name: e.actor_id ? nameById.get(e.actor_id) || e.actor_id.slice(0, 8) : null,
      created_at: String(e.created_at),
      reason: typeof details.reason === 'string' ? details.reason : null,
    };
  });

  const preview: TransferManagePreview = {
    kind: intent.kind,
    can_confirm:
      perm.allowed &&
      !intent.previewOnly &&
      remaining > 0 &&
      errors.length === 0 &&
      (intent.kind === 'receive' || intent.kind === 'return_remainder' || intent.kind === 'shortage'),
    transfer_id: String(tr.id),
    transfer_number: String(tr.transfer_number),
    from_city_name: cityName(String(tr.from_city_id)),
    to_city_name: cityName(String(tr.to_city_id)),
    status,
    created_by_name: tr.created_by ? nameById.get(String(tr.created_by)) || String(tr.created_by).slice(0, 8) : null,
    created_at: String(tr.created_at),
    remaining,
    items,
    events,
    list: [],
    empty_list_message: null,
    reason: intent.reason,
    errors,
    operation_id: randomUUID(),
  };
  return { content: buildTransferManageMessage(preview), preview };
}
