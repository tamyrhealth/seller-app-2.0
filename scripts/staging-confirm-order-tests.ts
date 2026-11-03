/**
 * Staging RPC tests including a race for the last unit.
 * Usage (local, never production):
 *   npx tsx scripts/staging-confirm-order-tests.ts
 * Env: STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY,
 *      STAGING_SELLER_EMAIL, STAGING_SELLER_PASSWORD
 */
import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { assertStagingTarget } from './staging-env-guard';

function req(name: string): string {
  let v = process.env[name];
  if (!v) {
    const path = join(process.cwd(), '.env.staging');
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        if (line.startsWith(`${name}=`)) v = line.slice(name.length + 1).trim();
      }
    }
  }
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return v;
}

const guarded = assertStagingTarget();
const url = guarded.url;

const supabase = createClient(url, guarded.anon, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

async function main() {
  const { data: auth, error: authErr } = await supabase.auth.signInWithPassword({
    email: req('STAGING_SELLER_EMAIL'),
    password: req('STAGING_SELLER_PASSWORD'),
  });
  if (authErr || !auth.user) fail(authErr?.message ?? 'sign-in failed');

  const { data: profile, error: pErr } = await supabase
    .from('profiles')
    .select('id, city_id, role')
    .eq('id', auth.user.id)
    .single();
  if (pErr || !profile?.city_id) fail(pErr?.message ?? 'profile/city missing');

  const { data: inv, error: iErr } = await supabase
    .from('inventory')
    .select('product_id, qty_on_hand, products(name)')
    .eq('city_id', profile.city_id);
  if (iErr) fail(iErr.message);
  const pB = (inv ?? []).find((row) => {
    const p = row.products as { name?: string } | { name?: string }[] | null;
    const name = Array.isArray(p) ? p[0]?.name : p?.name;
    return name === 'STAGING Last Unit' || name === 'STAGING Product B';
  });
  if (!pB) fail('STAGING Last Unit not in inventory — run seed_synthetic.sql');
  if (Number(pB.qty_on_hand) !== 1) fail('STAGING Last Unit qty_on_hand must be 1');

  const lastKeyA = crypto.randomUUID();
  const lastKeyB = crypto.randomUUID();
  const payload = {
    items: [{ product_id: pB.product_id, qty: 1, price: '500' }],
    payment_type: 'cash',
    is_preorder: false,
  };

  const [r1, r2] = await Promise.all([
    supabase.rpc('confirm_order', { payload: { ...payload, idempotency_key: lastKeyA } }),
    supabase.rpc('confirm_order', { payload: { ...payload, idempotency_key: lastKeyB } }),
  ]);

  const ok = [r1, r2].filter((r) => !r.error && r.data);
  const insufficient = [r1, r2].filter((r) => (r.error?.message ?? '').includes('Insufficient stock'));
  if (ok.length !== 1) fail(`last-unit race: expected 1 success, got ${ok.length} data=${r1.data}/${r2.data}`);
  if (insufficient.length !== 1) {
    fail(`last-unit race: expected 1 insufficient stock, got errors: ${r1.error?.message} | ${r2.error?.message}`);
  }

  const { data: after } = await supabase
    .from('inventory')
    .select('qty_on_hand')
    .eq('city_id', profile.city_id)
    .eq('product_id', pB.product_id)
    .single();
  if (Number(after?.qty_on_hand) !== 0) {
    fail(`last unit stock must be 0, got ${after?.qty_on_hand}`);
  }

  console.log('OK concurrent last-unit: winner', ok[0].data, 'loser insufficient stock, qty_on_hand=0');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
