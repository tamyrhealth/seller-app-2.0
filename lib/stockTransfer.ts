export type TransferStatus = 'in_transit' | 'received' | 'received_with_variance' | 'cancelled';

export function transferRemaining(
  sent: number,
  received: number | null | undefined,
  lost: number | null | undefined = 0,
  returned: number | null | undefined = 0
): number {
  return Number((Number(sent) - Number(received || 0) - Number(lost || 0) - Number(returned || 0)).toFixed(3));
}

export function transferStatusLabel(status: string): string {
  if (status === 'in_transit') return 'В пути';
  if (status === 'received') return 'Получено';
  if (status === 'received_with_variance') return 'Закрыто с недостачей';
  if (status === 'cancelled') return 'Отменено';
  if (status === 'created') return 'Отправка';
  if (status === 'received_partial') return 'Получение';
  if (status === 'shortage') return 'Недостача';
  return status;
}

export function transferLineQtys(item: {
  qty_sent: number;
  qty_received?: number | null;
  qty_lost?: number | null;
  qty_returned?: number | null;
}): { sent: number; received: number; remaining: number; returned: number; lost: number } {
  const sent = Number(item.qty_sent || 0);
  const received = Number(item.qty_received || 0);
  const returned = Number(item.qty_returned || 0);
  const lost = Number(item.qty_lost || 0);
  return {
    sent,
    received,
    remaining: transferRemaining(sent, received, lost, returned),
    returned,
    lost,
  };
}

export function transferTotals(
  items: Array<{
    qty_sent: number;
    qty_received?: number | null;
    qty_lost?: number | null;
    qty_returned?: number | null;
  }>
) {
  return items.reduce(
    (acc, item) => {
      const q = transferLineQtys(item);
      acc.sent += q.sent;
      acc.received += q.received;
      acc.remaining += q.remaining;
      acc.returned += q.returned;
      acc.lost += q.lost;
      return acc;
    },
    { sent: 0, received: 0, remaining: 0, returned: 0, lost: 0 }
  );
}

export function transferDisplayStatus(opts: {
  status: string;
  remaining: number;
  received: number;
  lost: number;
}): string {
  if (opts.remaining > 0) {
    return opts.received > 0 ? 'В пути (частично получено)' : 'В пути';
  }
  if (opts.lost > 0) return 'Закрыто с недостачей';
  if (opts.status === 'received_with_variance') return 'Получено';
  return transferStatusLabel(opts.status);
}

export function mapTransferRpcError(message: string): string {
  if (message.includes('Insufficient stock')) return 'Недостаточно остатка на складе отправителя';
  if (message.includes('Source and destination cities must differ')) {
    return 'Город отправления и город получения не могут совпадать';
  }
  if (message.includes('different payload')) return 'Повтор операции с другими данными. Обновите страницу.';
  if (message.includes('Received transfer cannot be cancelled')) {
    return 'Полученное перемещение нельзя отменить. Нужна корректировка с историей.';
  }
  if (message.includes('Transfer is cancelled')) return 'Перемещение уже отменено';
  if (message.includes('exceeds remaining')) {
    return 'Количество больше остатка в пути';
  }
  if (message.includes('Shortage reason is required')) return 'Укажите причину недостачи';
  if (message.includes('No remaining quantity to write off')) {
    return 'Нет остатка в пути для списания недостачи';
  }
  if (message.includes('Received qty exceeds sent qty')) {
    return 'Полученное количество не может быть больше отправленного';
  }
  if (message.includes('Account is inactive')) return 'Учётная запись отключена';
  if (message.includes('Transfer manage permission denied')) {
    return 'Нет права управлять перемещениями (can_manage_transfers)';
  }
  if (message.includes('Only admin') || message.includes('Transfer permission denied')) {
    return 'Нет права на эту складскую операцию';
  }
  if (message.includes('Source city is inactive')) return 'Город отправления неактивен';
  if (message.includes('Destination city is inactive')) return 'Город получения неактивен';
  if (message.includes('Inactive product')) return 'Товар неактивен';
  if (message.includes('No items')) return 'Добавьте хотя бы один товар';
  if (message.includes('Invalid qty')) return 'Введите корректное количество';
  return message;
}
