export function isCanceledStatus(status: string | null | undefined): boolean {
  return /cancel(l?)ed/i.test(String(status ?? ''));
}

export function orderStatusI18nKey(status: string | null | undefined): string {
  const raw = String(status ?? '').toLowerCase();
  if (raw === 'confirmed') return 'orders.status.confirmed';
  if (raw === 'canceled' || raw === 'cancelled') return 'orders.status.canceled';
  if (raw === 'pending') return 'common.pending';
  return 'orders.status.unknown';
}
