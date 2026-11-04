import type { CancelCardState, CancelPreview } from '@/lib/assistant/cancelTypes';

export function isCanceledStatus(status?: string | null, preorderStatus?: string | null): boolean {
  const s = (status || '').toLowerCase();
  return s === 'canceled' || s === 'cancelled' || preorderStatus === 'cancelled';
}

export function resolveCancelCardState(opts: {
  storedState?: string | null;
  preview?: CancelPreview | null;
  liveStatus?: string | null;
  livePreorderStatus?: string | null;
}): CancelCardState {
  const preview = opts.preview;
  if (isCanceledStatus(opts.liveStatus, opts.livePreorderStatus)) return 'confirmed';
  if (isCanceledStatus(preview?.status, null)) return 'confirmed';
  if ((preview?.errors || []).some((e) => e.code === 'already_canceled')) return 'confirmed';
  if (opts.storedState === 'confirmed') return 'confirmed';
  if (opts.storedState === 'dismissed') return 'dismissed';
  if (opts.storedState === 'blocked' || preview?.can_cancel === false) return 'blocked';
  return 'preview';
}
