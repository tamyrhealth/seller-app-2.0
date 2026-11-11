import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  confirmedOrderLabel,
  liveDraftForAssistantMessage,
  markDraftConfirmed,
  markDraftConfirming,
  revertDraftIfUnconfirmed,
  shouldPatchDraftConfirmed,
} from '../lib/assistant/draftCardSync';
import { runExclusive } from '../lib/exclusiveAsync';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const draft = {
  id: 'd1',
  assistant_message_id: 'm1',
  status: 'preview',
  can_confirm: true,
  order_id: null as string | null,
  order_number: null as string | null,
  idempotency_key: 'k1',
};

const first = { id: 'm1', metadata: { draft_id: 'd1', kind: 'order_draft' } };
const second = { id: 'm2', metadata: { draft_id: 'd1', kind: 'order_draft', reuse: 'open' } };
const drafts = [draft];

const a = liveDraftForAssistantMessage(drafts, first);
const b = liveDraftForAssistantMessage(drafts, second);
if (!a || !b || a !== b) fail('both cards must bind the same live draft object');
if (a.idempotency_key !== 'k1') fail('shared idempotency_key');

const confirming = markDraftConfirming(drafts, 'd1');
if (liveDraftForAssistantMessage(confirming, first)?.status !== 'confirming') fail('first card confirming');
if (liveDraftForAssistantMessage(confirming, second)?.status !== 'confirming') fail('second card confirming');

const confirmed = markDraftConfirmed(confirming, 'd1', { order_id: 'o1', order_number: 'A-1' });
const c1 = liveDraftForAssistantMessage(confirmed, first);
const c2 = liveDraftForAssistantMessage(confirmed, second);
if (c1?.status !== 'confirmed' || c2?.status !== 'confirmed') fail('confirming either card must confirm both');
if (c1?.order_id !== 'o1' || c2?.order_id !== 'o1') fail('both cards must show the same orderId');
if (c1?.idempotency_key !== 'k1' || c2?.idempotency_key !== 'k1') fail('key stays shared after confirm');
if (confirmedOrderLabel(c1?.order_number, c1?.order_id) !== 'Заказ оформлен №A-1') fail('confirmed label');

if (markDraftConfirming(confirmed, 'd1')[0].status !== 'confirmed') {
  fail('already confirmed draft must not drop back to confirming');
}

const other = {
  id: 'd2',
  assistant_message_id: 'm3',
  status: 'preview',
  can_confirm: true,
  order_id: null as string | null,
  order_number: null as string | null,
  idempotency_key: 'k2',
};
const mixed = markDraftConfirmed([draft, other], 'd1', { order_id: 'o1', order_number: 'A-1' });
if (mixed.find((row) => row.id === 'd2')?.status !== 'preview' || mixed.find((row) => row.id === 'd2')?.idempotency_key !== 'k2') {
  fail('confirming one draft must not change another');
}

const emptyPatch = markDraftConfirmed(confirming, 'd1', { order_id: null, order_number: null });
if (emptyPatch[0].status === 'confirmed') fail('empty order payload must not mark confirmed');

const reverted = revertDraftIfUnconfirmed(confirming, 'd1', draft);
if (reverted[0].status !== 'preview' || reverted[0].can_confirm !== true) fail('error must restore unconfirmed cards');
if (revertDraftIfUnconfirmed(confirmed, 'd1', draft)[0].status !== 'confirmed') {
  fail('revert must not undo a real confirmed order');
}

if (
  shouldPatchDraftConfirmed({
    path: 'confirm',
    okHttp: false,
    payload: { ok: false, order_id: 'o1', order_number: 'A-1' },
  })
) {
  fail('error HTTP must not show Заказ оформлен');
}
if (
  shouldPatchDraftConfirmed({
    path: 'confirm',
    okHttp: true,
    payload: { ok: false, pending: true, order_id: 'o1' },
  })
) {
  fail('timeout pending must not show Заказ оформлен');
}
if (
  shouldPatchDraftConfirmed({
    path: 'cancel',
    okHttp: true,
    payload: { ok: true, order_id: 'o1' },
  })
) {
  fail('cancel path must not patch confirmed');
}
if (
  !shouldPatchDraftConfirmed({
    path: 'confirm',
    okHttp: true,
    payload: { ok: true, order_id: 'o1', order_number: 'A-1' },
  })
) {
  fail('successful confirm must patch both cards');
}

async function assertExclusive() {
  let runs = 0;
  const [x, y] = await Promise.all([
    runExclusive('draft-d1', async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 20));
      return 'one';
    }),
    runExclusive('draft-d1', async () => {
      runs += 1;
      return 'two';
    }),
  ]);
  if (x !== 'one' || y !== 'one' || runs !== 1) fail('parallel confirm on one draftId must share one execution');
}

const ui = read('components/AssistantChats.tsx');
if (!ui.includes('liveDraftForAssistantMessage')) fail('chat must bind reuse cards to the live draft');
if (!ui.includes('markDraftConfirmed')) fail('confirm must patch every card of the draft');
if (!ui.includes('revertDraftIfUnconfirmed')) fail('confirm error must restore unconfirmed cards');
if (!ui.includes('shouldPatchDraftConfirmed')) fail('only successful confirm may show Заказ оформлен');
if (!ui.includes("assistant-order-confirm:${draftId}")) fail('parallel confirms share exclusive key');
if (!ui.includes('forceNewInvoiceDraft')) fail('explicit new draft remains');
if (ui.includes("rpc('confirm_order'")) fail('chat UI must not call confirm_order');

const card = read('components/AssistantOrderDraftCard.tsx');
if (!card.includes('confirmedOrderLabel')) fail('card confirmed copy');
if (!card.includes('if (readOnly || locked || done) return')) fail('confirmed card must not re-confirm');
if (card.includes("rpc('confirm_order'")) fail('card must not call confirm_order');

const confirm = read('app/api/assistant/orders/confirm/route.ts');
if (!confirm.includes('recoverCreatedOrder')) fail('second confirm recovers the same order');
if (!confirm.includes('findOrderByKey')) fail('recover by idempotency_key');

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

void (async () => {
  await assertExclusive();
  const psqlBin = resolvePsql();
  if (!psqlBin) fail('psql required for draft card sync PG tests');
  const uri = process.env.LOCAL_PG_URI || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
  const file = join(process.cwd(), 'scripts/verify_assistant_draft_card_sync.sql');
  const out = execFileSync(psqlBin, [uri, '-v', 'ON_ERROR_STOP=1', '-At', '-f', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!out.includes('pg_draft_card_sync_ok')) fail(`pg card sync failed: ${out}`);
  console.log('assistant-draft-card-sync checks ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
