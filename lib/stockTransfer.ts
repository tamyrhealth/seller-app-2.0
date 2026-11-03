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
  if (status === 'received_with_variance') return 'Получено с расхождением';
  if (status === 'cancelled') return 'Отменено';
  if (status === 'created') return 'Отправка';
  if (status === 'received_partial') return 'Получение';
  if (status === 'shortage') return 'Недостача';
  return status;
}

export function transferOpenLabel(status: string, remaining: number, received: number): string {
  if (remaining > 0 && received > 0) return 'В пути (частично получено)';
  if (remaining > 0) return 'В пути';
  return transferStatusLabel(status);
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
  if (message.includes('Only admin')) return 'Только администратор может управлять перемещениями';
  if (message.includes('No items')) return 'Добавьте хотя бы один товар';
  if (message.includes('Invalid qty')) return 'Введите корректное количество';
  return message;
}
