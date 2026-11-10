export type DeviceAccess = 'allowed' | 'denied' | 'unknown';

export type DeviceQueryError = {
  message?: string;
  code?: string;
  status?: number;
} | null;

/**
 * Maps a session-row query to ALLOWED / DENIED / UNKNOWN.
 * UNKNOWN is never treated as ALLOWED. DENIED only when another device_id is stored.
 */
export function interpretActiveDeviceQuery(input: {
  userId: string;
  deviceId: string;
  rowDeviceId: string | null | undefined;
  error: DeviceQueryError;
}): DeviceAccess {
  if (!input.userId) return 'denied';
  if (!input.deviceId) return 'unknown';
  if (input.error) return 'unknown';
  if (!input.rowDeviceId) return 'allowed';
  return input.rowDeviceId === input.deviceId ? 'allowed' : 'denied';
}
