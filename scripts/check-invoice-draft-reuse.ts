import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildInvoiceDraftFingerprint,
  findReusableInvoiceDraft,
  invoiceReuseChatMessage,
} from '../lib/assistant/invoiceDraftFingerprint';
import type { DraftItemResolved, DraftResolved } from '../lib/assistant/orderDraftTypes';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

function item(over: Partial<DraftItemResolved>): DraftItemResolved {
  return {
    raw_name: 'шай',
    product_id: 'p-tea',
    product_name: 'ШАЙ ОРГ 500г',
    unit: 'g',
    qty: 3,
    price: 800,
    is_gift: false,
    stock: 10,
    line_sum: 2400,
    unresolved: false,
    ...over,
  };
}

function resolved(over: Partial<DraftResolved> = {}): DraftResolved {
  return {
    seller_id: 's1',
    seller_name: 'Айгүл',
    city_id: 'c1',
    city_name: 'Астана',
    payment_type: 'cash',
    payment_raw: 'Наличка',
    is_debt: false,
    is_preorder: false,
    pickup_date: null,
    invoice_date: null,
    invoice_time: null,
    comment: null,
    customer_name: 'Айдос',
    customer_phone: '+77751234567',
    debt_customer_name: null,
    debt_due_at: null,
    debt_note: null,
    items: [item({})],
    total_sum: 2400,
    ...over,
  };
}

const fpTea = buildInvoiceDraftFingerprint(resolved());
const fpAlias = buildInvoiceDraftFingerprint(
  resolved({
    items: [item({ raw_name: 'ШАЙ ОРГ 500г', product_id: 'p-tea' })],
  })
);
if (fpTea !== fpAlias) fail('same SKU different spelling must match');

const fpPhone = buildInvoiceDraftFingerprint(resolved({ customer_phone: '87751234567' }));
if (fpTea !== fpPhone) fail('KZ phone canon must match');

const fpTwoLines = buildInvoiceDraftFingerprint(
  resolved({
    items: [item({ qty: 2, line_sum: 1600 }), item({ qty: 1, line_sum: 800 })],
    total_sum: 2400,
  })
);
const fpMerged = buildInvoiceDraftFingerprint(resolved({ items: [item({ qty: 3 })] }));
if (fpTwoLines === fpMerged) fail('line order/qty split must not collapse to a single line');

const fpRev = buildInvoiceDraftFingerprint(
  resolved({
    items: [item({ qty: 1, line_sum: 800 }), item({ qty: 2, line_sum: 1600 })],
    total_sum: 2400,
  })
);
if (fpTwoLines === fpRev) fail('line order must be part of fingerprint');

const mismatches: [string, DraftResolved][] = [
  ['seller', resolved({ seller_id: 's2' })],
  ['city', resolved({ city_id: 'c2' })],
  ['customer name', resolved({ customer_name: 'Марат' })],
  ['phone', resolved({ customer_phone: '+77759876543' })],
  ['payment', resolved({ payment_type: 'kaspi' })],
  ['debt', resolved({ is_debt: true })],
  ['preorder', resolved({ is_preorder: true })],
  ['sku', resolved({ items: [item({ product_id: 'p-oil', raw_name: 'масло' })] })],
  ['qty', resolved({ items: [item({ qty: 4, line_sum: 3200 })] })],
];
for (const [label, other] of mismatches) {
  if (fpTea === buildInvoiceDraftFingerprint(other)) fail(`${label} difference must not reuse`);
}

const openHit = findReusableInvoiceDraft(
  [
    {
      id: 'd1',
      idempotency_key: 'k1',
      status: 'preview',
      resolved: resolved(),
      created_at: '2026-11-11T10:00:00Z',
    },
  ],
  fpTea
);
if (openHit?.kind !== 'open' || openHit.row.id !== 'd1') fail('open draft must be reused');
for (const [label, other] of mismatches) {
  if (findReusableInvoiceDraft([{ ...openHit.row, resolved: other }], fpTea)) {
    fail(`${label} difference must not hit an open draft`);
  }
}

const confirmedHit = findReusableInvoiceDraft(
  [
    {
      id: 'd2',
      idempotency_key: 'k2',
      status: 'confirmed',
      order_id: 'o1',
      order_number: 'A-1',
      resolved: resolved(),
      created_at: '2026-11-11T10:00:00Z',
    },
  ],
  fpTea
);
if (confirmedHit?.kind !== 'confirmed' || confirmedHit.row.order_id !== 'o1') fail('confirmed draft must surface order');
if (!invoiceReuseChatMessage(confirmedHit).includes('A-1')) fail('confirmed message must include order number');
if (findReusableInvoiceDraft([confirmedHit.row], fpTea, { forceNew: true })) {
  fail('forceNew must skip reuse');
}

const preferOpen = findReusableInvoiceDraft(
  [
    {
      id: 'd-conf',
      idempotency_key: 'k-conf',
      status: 'confirmed',
      order_id: 'o-old',
      order_number: 'OLD',
      resolved: resolved(),
      created_at: '2026-11-11T09:00:00Z',
    },
    {
      id: 'd-open',
      idempotency_key: 'k-open',
      status: 'blocked',
      resolved: resolved(),
      created_at: '2026-11-11T11:00:00Z',
    },
  ],
  fpTea
);
if (preferOpen?.kind !== 'open' || preferOpen.row.id !== 'd-open') fail('unfinished draft wins over confirmed');

const phoneOnColumn = findReusableInvoiceDraft(
  [
    {
      id: 'd-phone',
      idempotency_key: 'k-phone',
      status: 'preview',
      resolved: resolved({ customer_phone: null }),
      customer_phone: '87751234567',
      created_at: '2026-11-11T10:00:00Z',
    },
  ],
  fpTea
);
if (phoneOnColumn?.row.id !== 'd-phone') fail('draft.customer_phone column must match normalized invoice phone');

if (findReusableInvoiceDraft([{ ...openHit!.row, status: 'cancelled' }], fpTea)) {
  fail('cancelled drafts must not be reused');
}

const chat = read('app/api/assistant/chat/route.ts');
if (!chat.includes('findReusableInvoiceDraft')) fail('chat must reuse invoice drafts');
if (!chat.includes('forceNewInvoiceDraft')) fail('chat must accept force-new flag');
if (!chat.includes('!forceNewInvoiceDraft')) fail('force-new must skip reuse lookup');
if (!chat.includes('.eq(\'chat_id\', chatId)')) fail('reuse is same-chat only');
if (!chat.includes('skipDraftSave')) fail('confirmed reuse must not insert a new draft');
if (!chat.includes("hit.kind === 'confirmed'")) fail('confirmed reuse must not re-save or re-confirm');
if (!chat.includes("claim.status === 'done'")) fail('same client_message_id must reuse generation');
if (!chat.includes("claim.status === 'running' || claim.status === 'busy'")) {
  fail('parallel chat generations must stay serialized');
}
if (chat.includes("rpc('confirm_order'")) fail('chat must not confirm_order');

const ui = read('components/AssistantChats.tsx');
if (!ui.includes('Это новый заказ')) fail('UI force-new button');
if (!ui.includes('forceNewInvoiceDraft')) fail('UI must send force-new flag');
if (!ui.includes('liveDraftForAssistantMessage')) fail('reuse cards must share one live draft');
if (!ui.includes('markDraftConfirmed')) fail('confirm must sync every bound card');
if (!ui.includes('revertDraftIfUnconfirmed')) fail('confirm error must not leave a false confirmed card');

const handle = read('lib/assistant/handleTurn.ts');
if (!handle.includes('randomUUID()')) fail('new drafts still mint a key before reuse overlay');

const session = read('supabase/migrations/20261111120000_preorder_inventory_reserve.sql');
if (!session.includes("v_key := NULLIF(trim(COALESCE(payload->>'idempotency_key', '')), '');")) {
  fail('5.20.2 session_body must keep nullable idempotency_key');
}
if (/idempotency_key required/i.test(session)) fail('must not require idempotency_key in 5.20.2 body');
if (/UNIQUE INDEX[\s\S]{0,80}idempotency_fingerprint/i.test(session)) {
  fail('must not unique-index order composition/fingerprint');
}

const confirmRoute = read('app/api/assistant/orders/confirm/route.ts');
if (!confirmRoute.includes('idempotency_key: String(live.idempotency_key)')) {
  fail('AI confirm must keep sending the draft idempotency_key');
}
if (!read('app/seller/new-order/page.tsx').includes('payload.idempotency_key = idempotencyKey')) {
  fail('seller new-order must keep sending idempotency_key');
}
if (!read('app/admin/new-order/page.tsx').includes('payload.idempotency_key = idempotencyKey')) {
  fail('admin new-order must keep sending idempotency_key');
}

const p0 = read('scripts/pg_p0_integration_tests.sql');
if (!p0.includes("confirm_order('{\"payment_type\":\"cash\"}'::jsonb)")) {
  fail('P0 harness still confirms without idempotency_key — required-key SQL is unsafe');
}

const preorderTests = read('scripts/verify_preorder_inventory_reserve_tests.sql');
if (!preorderTests.includes('null idempotency_key must create distinct orders')) {
  fail('keep current null-key contract until a dedicated migration');
}

function resolvePsql(): string | null {
  for (const bin of [
    'psql',
    'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe',
    'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe',
  ]) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch {
      /* next */
    }
  }
  return null;
}

const psqlBin = resolvePsql();
if (psqlBin) {
  const uri = process.env.LOCAL_PG_URI || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
  const file = join(process.cwd(), 'scripts/verify_invoice_draft_reuse.sql');
  const out = execFileSync(psqlBin, [uri, '-v', 'ON_ERROR_STOP=1', '-At', '-f', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!out.includes('pg_invoice_draft_reuse_ok')) fail(`pg composition test failed: ${out}`);
} else {
  fail('psql required for invoice draft reuse PG tests');
}

console.log('invoice-draft-reuse checks ok');
