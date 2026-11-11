export type DraftCardSyncRow = {
  id: string;
  assistant_message_id?: string | null;
  status: string;
  can_confirm: boolean;
  order_id?: string | null;
  order_number?: string | null;
  idempotency_key?: string | null;
};

export type DraftCardMessage = {
  id: string;
  metadata?: {
    draft_id?: string;
    kind?: string;
  };
};

/** Prefer metadata.draft_id so two reuse messages share the live draft row. */
export function liveDraftForAssistantMessage<T extends DraftCardSyncRow>(
  drafts: T[],
  message: DraftCardMessage
): T | undefined {
  const draftId = message.metadata?.draft_id;
  if (draftId) {
    const byId = drafts.find((row) => row.id === draftId);
    if (byId) return byId;
  }
  return drafts.find((row) => row.assistant_message_id === message.id);
}

export function markDraftConfirming<T extends DraftCardSyncRow>(drafts: T[], draftId: string): T[] {
  return drafts.map((row) =>
    row.id === draftId && row.status !== 'confirmed'
      ? { ...row, status: 'confirming', can_confirm: false }
      : row
  );
}

export function markDraftConfirmed<T extends DraftCardSyncRow>(
  drafts: T[],
  draftId: string,
  order: { order_id?: string | null; order_number?: string | null }
): T[] {
  const orderId = order.order_id || null;
  const orderNumber = order.order_number || null;
  if (!orderId && !orderNumber) return drafts;
  return drafts.map((row) =>
    row.id === draftId
      ? {
          ...row,
          status: 'confirmed',
          can_confirm: false,
          order_id: orderId || row.order_id || null,
          order_number: orderNumber || row.order_number || null,
        }
      : row
  );
}

/** Undo optimistic confirming unless this draft already has a real order. */
export function revertDraftIfUnconfirmed<T extends DraftCardSyncRow>(
  drafts: T[],
  draftId: string,
  previous: T
): T[] {
  return drafts.map((row) => {
    if (row.id !== draftId) return row;
    if (row.status === 'confirmed' && (row.order_id || row.order_number)) return row;
    return previous;
  });
}

export function shouldPatchDraftConfirmed(input: {
  path?: string;
  okHttp: boolean;
  payload: { ok?: boolean; pending?: boolean; order_id?: string | null; order_number?: string | null };
}): boolean {
  if (input.path && input.path !== 'confirm') return false;
  if (!input.okHttp || input.payload.ok === false || input.payload.pending) return false;
  return Boolean(input.payload.order_id || input.payload.order_number);
}

export function confirmedOrderLabel(orderNumber: string | null | undefined, orderId?: string | null): string {
  const number = (orderNumber || String(orderId || '').slice(0, 8)).trim();
  return number ? `Заказ оформлен №${number}` : 'Заказ оформлен';
}
