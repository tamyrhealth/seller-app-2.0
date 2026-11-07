import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { resolveProductQuery } from '@/lib/assistant/productAliases';
import { actorCanManageTransfers } from '@/lib/assistant/resolveTransfer';
import type { TransferManageIntent } from '@/lib/assistant/transferManageIntent';
import type {
  TransferManageEvent,
  TransferManageIssue,
  TransferManageLine,
  TransferManagePreview,
} from '@/lib/assistant/transferManageTypes';
import { transferDisplayStatus, transferLineQtys, transferRemaining } from '@/lib/stockTransfer';

type Actor = { role: string | null; can_manage_transfers: boolean };

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
    reason: extras.reason || null,
    errors,
    operation_id: extras.operation_id || randomUUID(),
  };
}

function lineActionQty(
  kind: TransferManagePreview['kind'],
  remaining: number,
  matched: number | null
): number {
  if (kind === 'lookup' || kind === 'list') return 0;
  if (matched == null) return remaining;
  return matched;
}

export function buildTransferManageMessage(preview: TransferManagePreview): string {
  if (preview.kind === 'list') {
    const lines = ['Доступные перемещения:'];
    if (!preview.list.length) lines.push('Ничего не найдено.');
    for (const row of preview.list) {
      lines.push(`• ${row.transfer_number}: ${row.from_city_name} → ${row.to_city_name}, ${row.status}, в пути ${row.remaining}`);
    }
    if (preview.errors.length) lines.push(...preview.errors.map((e) => `Ошибка: ${e.message}`));
    return lines.join('\n');
  }
  const lines = [
    `${preview.transfer_number || 'Перемещение'}: ${preview.from_city_name || '—'} → ${preview.to_city_name || '—'}.`,
    `Статус: ${preview.status || '—'}. В пути: ${preview.remaining}.`,
    ...preview.items.map((i) => `• ${i.name}: отправлено ${i.qty_sent}, принято ${i.qty_received}, возвращено ${i.qty_returned}, списано ${i.qty_lost}, в пути ${i.remaining}`),
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
        'id, transfer_number, from_city_id, to_city_id, status, created_at, stock_transfer_items(qty_sent, qty_received, qty_lost, qty_returned)'
      )
      .order('created_at', { ascending: false })
      .limit(20);
    const { data: cities } = await db.from('cities').select('id, name');
    const cityName = (id: string) => cities?.find((c) => c.id === id)?.name || id.slice(0, 8);
    const list = (rows || []).map((row) => {
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
      };
    });
    const preview = emptyPreview(intent.kind, [], { list });
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
      const hit = resolveProductQuery(
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
        errors.push(issue('product_not_found', `Товар «${row.raw_name}» не найден в этом перемещении.`));
        continue;
      }
      matchedQty.set(hit.chosen.id, (matchedQty.get(hit.chosen.id) || 0) + row.qty);
    }
  }

  const specifiedMode =
    (intent.kind === 'receive' || intent.kind === 'shortage') && intent.items.length > 0;
  const items: TransferManageLine[] = catalog.map((c) => {
    const remaining = c.remaining;
    const specified = matchedQty.has(c.product_id)
      ? Number(matchedQty.get(c.product_id))
      : specifiedMode
        ? 0
        : remaining;
    const action_qty = lineActionQty(intent.kind, remaining, specified);
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

  if (intent.kind === 'receive' || intent.kind === 'return_remainder' || intent.kind === 'shortage') {
    if (remaining <= 0) errors.push(issue('nothing_remaining', 'В пути ничего не осталось. Повторно вернуть или принять нельзя.'));
    for (const line of items) {
      if (line.action_qty < 0) errors.push(issue('qty_invalid', `${line.name}: некорректное количество.`));
      if (line.action_qty > line.remaining) {
        errors.push(
          issue('qty_exceeds', `${line.name}: нужно не больше остатка в пути ${line.remaining}.`)
        );
      }
    }
    if (intent.kind === 'receive' && !items.some((i) => i.action_qty > 0)) {
      errors.push(issue('items_missing', 'Укажите количество к приёмке.'));
    }
    if (intent.kind === 'shortage') {
      const reason = (intent.reason || '').trim();
      if (reason.length < 3) errors.push(issue('reason_required', 'Для недостачи нужна обязательная причина.'));
      if (!items.some((i) => i.action_qty > 0)) errors.push(issue('items_missing', 'Укажите количество недостачи.'));
    }
  }

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
    reason: intent.reason,
    errors,
    operation_id: randomUUID(),
  };
  return { content: buildTransferManageMessage(preview), preview };
}
