/**
 * Read-mostly smoke against staging (no production).
 * Does not create orders unless STAGING_CREATE_ORDERS=1.
 *
 *   npx tsx scripts/staging-env-guard.ts
 *   npx tsx scripts/staging-assistant-smoke.ts
 */
import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { assertStagingTarget } from './staging-env-guard';

function fileEnv(key: string): string {
  const path = join(process.cwd(), '.env.staging');
  if (!existsSync(path)) return process.env[key] || '';
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return process.env[key] || '';
}

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

async function main() {
  const t = assertStagingTarget();
  const email = fileEnv('STAGING_MANAGER_EMAIL');
  const password = fileEnv('STAGING_MANAGER_PASSWORD');
  if (!email || !password) fail('STAGING_MANAGER_EMAIL / PASSWORD required');

  const db = createClient(t.url, t.anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error: authErr } = await db.auth.signInWithPassword({ email, password });
  if (authErr || !auth.user) fail(authErr?.message || 'manager sign-in failed');

  const { data: profile, error: pErr } = await db
    .from('profiles')
    .select('id, role, display_name, city_id')
    .eq('id', auth.user.id)
    .maybeSingle();
  if (pErr || profile?.role !== 'manager') fail(pErr?.message || `expected manager, got ${profile?.role}`);

  const { data: products, error: prErr } = await db
    .from('products')
    .select('id, name, price_retail')
    .in('name', ['Порошок', 'Чай', 'Драже', 'Порошок детский']);
  if (prErr) fail(prErr.message);
  if ((products || []).length < 3) fail('seed products missing');

  const { data: sellers, error: sErr } = await db
    .from('profiles')
    .select('id, display_name, city_id, role')
    .eq('role', 'seller')
    .eq('display_name', 'Айгүл');
  if (sErr) fail(sErr.message);
  if ((sellers || []).length < 1) fail('seller Айгүл missing');

  const { error: chatErr } = await db.from('assistant_chats').select('id').limit(1);
  if (chatErr) fail(`assistant_chats: ${chatErr.message} (apply 5.1 SQL)`);

  const { error: draftErr } = await db.from('assistant_order_drafts').select('id').limit(1);
  if (draftErr) fail(`assistant_order_drafts: ${draftErr.message} (apply 5.2.2 SQL)`);

  console.log('OK staging smoke: manager session, catalog, chats, drafts table');
  if (process.env.STAGING_CREATE_ORDERS === '1') {
    console.log('STAGING_CREATE_ORDERS=1 is set — create orders only via the UI/API on staging, not in this script.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
