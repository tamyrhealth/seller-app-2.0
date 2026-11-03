import { readFileSync } from 'fs';
import { join } from 'path';
import { isAssistantRole } from '../lib/roles';
import { stripIdentifiers, scrubRecord } from '../lib/assistant/sanitize';
import { ASSISTANT_TOOLS } from '../lib/assistant/tools';
import { ASSISTANT_INSTRUCTIONS } from '../lib/assistant/prompt';
import {
  ASSISTANT_DEFAULT_MODEL,
  ASSISTANT_LEASE_SECONDS,
  ASSISTANT_OPENAI_TIMEOUT_MS,
  ASSISTANT_REQUEST_DEADLINE_MS,
} from '../lib/assistant/limits';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const sql = read('supabase/migrations/20261103280000_assistant_ai_generations.sql');
const runSql = read('supabase/run_assistant_ai_generations.sql');
const verify = read('supabase/prod/post_apply_verify_block521.sql');
const route = read('app/api/assistant/chat/route.ts');
const ui = read('components/AssistantChats.tsx');
const tools = read('lib/assistant/tools.ts');
const runModel = read('lib/assistant/runModel.ts');
const pkg = read('package.json');

if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('5.2.1 migration must be transactional');
if (!sql.includes('assistant_generations')) fail('generation table');
if (!sql.includes("role = 'assistant'")) fail('server inserts assistant role');
if (!sql.includes('GRANT EXECUTE ON FUNCTION public.claim_assistant_generation')) fail('claim grant');
if (!sql.includes('TO service_role')) fail('RPCs must be service_role only');
if (!sql.includes('lease_id')) fail('generation lease required');
if (!sql.includes('lease_expired')) fail('stale running must expire');
if (!sql.includes('user_message_mismatch')) fail('RPC must bind user message to request');
if (!sql.includes('stale_lease')) fail('complete must reject stolen lease');
if (!sql.includes("interval '90 seconds'")) fail('SQL lease must be 90 seconds');
if (!runSql.includes("interval '90 seconds'")) fail('run SQL lease must be 90 seconds');
if (!runSql.includes('stale_lease') || !runSql.includes('lease_expired')) fail('run SQL missing lease guards');
if (!runSql.includes('user_message_mismatch')) fail('run SQL must bind user message');
if (sql.includes('pg_trigger_depth()')) fail('5.2.1 must not restore message_count depth guard');
if (!sql.includes('DROP FUNCTION IF EXISTS public.complete_assistant_generation(uuid, text)')) {
  fail('old complete signature must be dropped');
}
if (/GRANT EXECUTE ON FUNCTION public\.(claim_assistant_generation|complete_assistant_generation|fail_assistant_generation)[^\n]*authenticated/i.test(sql)) {
  fail('authenticated must not execute generation RPCs');
}
if (/DELETE\s+FROM\s+public\.assistant_messages/i.test(sql)) fail('must not delete messages');
if (/DELETE\s+FROM\s+public\.(orders|inventory|profiles|products)/i.test(sql)) fail('must not delete business rows');
if (!runSql.includes('complete_assistant_generation')) fail('run SQL missing complete RPC');
if (!runSql.includes('assistant_generations_one_running_per_chat_uidx')) fail('run SQL missing running lock');
if (!runSql.includes('p_lease_id')) fail('run SQL missing lease on complete');

const verifyBare = verify.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(verifyBare)) {
  fail('post_apply_verify_block521.sql must be SELECT-only');
}

if (!pkg.includes('"openai"')) fail('official openai SDK required');
if (!route.includes('createUserClient')) fail('user-scoped supabase client');
if (!route.includes('createServiceClient')) fail('service client only for reply RPCs');
if (!route.includes('owner_id !== user.id')) fail('must reject writing in someone else chat');
if (!route.includes('isAssistantRole')) fail('role check');
if (!route.includes('OPENAI_API_KEY')) fail('openai key from env');
if (route.includes('NEXT_PUBLIC_OPENAI')) fail('openai key must not be public');
if (!route.includes('23505')) fail('user message idempotency');
if (!route.includes('p_lease_id')) fail('complete/fail must pass lease');
if (!route.includes('message_mismatch')) fail('retry must not swap user text');
if (!ui.includes('/api/assistant/chat')) fail('UI must post to server route');
if (ui.includes("role: 'assistant'")) fail('UI must not insert assistant messages');
if (!ui.includes('Повторить запрос к ИИ')) fail('retry');
if (auditWriteTools(tools)) fail('assistant tools must stay read-only');
if (/\bcost_price\b/.test(tools)) fail('tools must not read cost_price');
if (/debt_customer_phone|customer_phone/.test(tools)) fail('tools must not select customer phones');
if (/\.rpc\(/i.test(tools)) fail('tools must not call RPCs');
if (!runModel.includes('stripIdentifiers')) fail('OpenAI history must mask phones and UUIDs');
if (/from\('(?:orders|inventory)'\)\.(insert|update|delete)/i.test(read('app/api/assistant/orders/confirm/route.ts'))) {
  fail('confirm route must not write orders/inventory directly');
}

if (!ASSISTANT_TOOLS.every((t) => t.type === 'function')) fail('custom function tools only');
if (ASSISTANT_TOOLS.some((t) => /web_search|computer|shell|mcp/i.test(t.name))) fail('no open-world tools');
if (!ASSISTANT_INSTRUCTIONS.includes('казахский') && !ASSISTANT_INSTRUCTIONS.toLowerCase().includes('казах')) {
  fail('prompt must mention Kazakh');
}
if (!ASSISTANT_INSTRUCTIONS.toLowerCase().includes('не выдумывай')) {
  fail('prompt must forbid invented numbers');
}
if (ASSISTANT_DEFAULT_MODEL.length < 3) fail('default model');
if (ASSISTANT_LEASE_SECONDS !== 90) fail('lease constant must match SQL 90s');
if (ASSISTANT_OPENAI_TIMEOUT_MS >= ASSISTANT_LEASE_SECONDS * 1000) fail('OpenAI timeout must be below lease');
if (ASSISTANT_REQUEST_DEADLINE_MS >= ASSISTANT_LEASE_SECONDS * 1000) fail('request deadline must be below lease');
if (ASSISTANT_LEASE_SECONDS * 1000 - ASSISTANT_REQUEST_DEADLINE_MS < 25000) {
  fail('need at least 25s margin between deadline and lease');
}
if (!route.includes('maxDuration = 60')) fail('Vercel maxDuration must stay under the 90s lease');

if (isAssistantRole('seller')) fail('seller is not assistant');
if (!isAssistantRole('manager') || !isAssistantRole('admin')) fail('admin/manager are assistants');

if (!stripIdentifiers('+7 701 123 45 67').includes('скрыто')) fail('phones must be stripped');
const scrubbed = scrubRecord({ debt_customer_phone: '123', order_number: 'N000001' }) as Record<string, unknown>;
if ('debt_customer_phone' in scrubbed) fail('PII keys must be dropped');
if (scrubbed.order_number !== 'N000001') fail('order numbers must remain');

const hotfix = read('supabase/run_fix_assistant_message_count_guard.sql');
if (hotfix.includes('pg_trigger_depth()')) fail('hotfix must stay without pg_trigger_depth');

console.log('OK');

function auditWriteTools(src: string) {
  return /from\('(?:orders|inventory|products|profiles)'\)\.(insert|update|delete)/i.test(src);
}
