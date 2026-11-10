'use client';

import { supabase } from '@/lib/supabaseClient';
import { interpretActiveDeviceQuery, type DeviceAccess } from '@/lib/deviceAccess';
import { mapAuthSessionRpcResult } from '@/lib/authSessionGuard';

export type { DeviceAccess };
export { interpretActiveDeviceQuery };

/**
 * Registers the signed JWT session_id as the allowed session.
 * Older sessions cannot take over. Does not trust device_id.
 * Missing RPC (client before phase 1) → unknown, never signOut, never revoke others.
 */
export async function claimActiveAuthSession(): Promise<DeviceAccess> {
  try {
    const { data, error } = await supabase.rpc('claim_active_auth_session');
    return mapAuthSessionRpcResult({ kind: 'claim', data, error });
  } catch {
    return 'unknown';
  }
}

/**
 * UI/mutation pre-check. UNKNOWN never becomes ALLOWED. Does not claim.
 * Missing RPC (client before phase 1) → allowed so sales continue until phase 2.
 */
export async function checkActiveDevice(_userId?: string, _deviceId?: string): Promise<DeviceAccess> {
  try {
    const { data, error } = await supabase.rpc('check_active_auth_session');
    return mapAuthSessionRpcResult({ kind: 'check', data, error });
  } catch {
    return 'unknown';
  }
}

export async function revokeOtherAuthSessions(): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: 'others' });
  } catch {
    /* leftover access tokens are still rejected by assert after phase 2 */
  }
}
