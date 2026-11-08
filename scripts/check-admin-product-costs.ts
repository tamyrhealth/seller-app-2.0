import { readFileSync } from 'fs';
import { join } from 'path';
import { homePathForRole, isAssistantRole } from '../lib/roles';
import { PRODUCT_CATALOG_SELECT } from '../lib/types';
import { resolveLineUnitCost } from '../lib/adminFinanceSnapshots';
import {
  applyCostTsv,
  canSubmitCostChanges,
  classifyLiveChange,
  collectCostChanges,
  costUpdatePayload,
  interpretCostUpdateResult,
  costsEqual,
  filledMissingCounts,
  filterCostDrafts,
  formatCostDisplay,
  mergeSaveResultsIntoDrafts,
  parseCostInput,
  seedCostDrafts,
  setDraftInput,
} from '../lib/productCostBulk';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

if (homePathForRole('manager') === '/admin/products/costs' || homePathForRole('seller') === '/admin/products/costs') {
  fail('non-admin home is not cost editor');
}
if (isAssistantRole('seller')) fail('seller must not be assistant');
if (homePathForRole('admin') !== '/admin') fail('admin home');

const catalog = [
  { id: 'p1', name: 'Имбирный порошок 250 г', category: 'порошок', unit: 'g', is_active: true },
  { id: 'p2', name: 'Имбирный чай 150 г', category: 'чай', unit: 'g', is_active: true },
  { id: 'p3', name: 'Дубль', category: 'a', unit: 'pcs', is_active: true },
  { id: 'p4', name: 'Дубль', category: 'b', unit: 'pcs', is_active: true },
];
const costs = [
  { id: 'p1', cost_price: null },
  { id: 'p2', cost_price: 0 },
  { id: 'p3', cost_price: 10 },
  { id: 'p4', cost_price: 20 },
];
let drafts = seedCostDrafts(catalog, costs);
if (drafts[0].baseline !== null) fail('null baseline');
if (drafts[1].baseline !== 0) fail('zero is explicit');
if (formatCostDisplay(null) === formatCostDisplay(0)) fail('NULL display must differ from 0');
if (formatCostDisplay(0).includes('0') === false) fail('zero display');
if (costsEqual(null, 0)) fail('null !== 0');

const parsed0 = parseCostInput('0');
if (parsed0.kind !== 'value' || parsed0.kind === 'value' && parsed0.value !== 0) fail('parse 0');
if (parseCostInput('').kind !== 'empty') fail('empty is not zero');
if (parseCostInput('CLEAR').kind !== 'clear') fail('CLEAR');
if (parseCostInput('очистить').kind !== 'clear') fail('очистить');
if (parseCostInput('-1').kind !== 'invalid') fail('negative');
if (parseCostInput('abc').kind !== 'invalid') fail('nan');
if (parseCostInput('Infinity').kind !== 'invalid') fail('infinity');
const dec = parseCostInput('1800,5');
if (dec.kind !== 'value' || dec.value !== 1800.5) fail(`decimal comma ${JSON.stringify(dec)}`);

drafts = drafts.map((row) => (row.id === 'p1' ? setDraftInput(row, '1800') : row));
let collected = collectCostChanges(drafts);
if (collected.changes.length !== 1 || collected.changes[0].to !== 1800) fail('ordinary edit');
if (collected.changes[0].from !== null) fail('from null');

const tsv = applyCostTsv('Имбирный порошок 250 г\t1800\nИмбирный чай 150 г\t1500\n', seedCostDrafts(catalog, costs));
if (tsv.issues.length) fail(`tsv issues ${tsv.issues.map((i) => i.code).join(',')}`);
if (tsv.applied !== 2) fail(`tsv applied ${tsv.applied}`);
const afterTsv = collectCostChanges(tsv.drafts);
if (afterTsv.changes.length !== 2) fail('tsv should dirty two rows; tea 0→1500 and powder null→1800');

const unknown = applyCostTsv('Нет такого\t10\n', drafts);
if (!unknown.issues.some((i) => i.code === 'unknown_name')) fail('unknown name');
if (unknown.applied !== 0) fail('unknown must not apply');

const dup = applyCostTsv('Дубль\t5\n', seedCostDrafts(catalog, costs));
if (!dup.issues.some((i) => i.code === 'duplicate_name')) fail('duplicate name');
if (dup.applied !== 0) fail('must not guess duplicate id');

const badSum = applyCostTsv('Имбирный чай 150 г\tнет\n', seedCostDrafts(catalog, costs));
if (!badSum.issues.some((i) => i.code === 'not_number')) fail('bad amount');

const neg = applyCostTsv('Имбирный чай 150 г\t-3\n', seedCostDrafts(catalog, costs));
if (!neg.issues.some((i) => i.code === 'negative')) fail('negative tsv');

const emptyCell = applyCostTsv('Имбирный чай 150 г\t\n', seedCostDrafts(catalog, costs));
if (!emptyCell.issues.some((i) => i.code === 'empty_cost')) fail('empty tsv is not 0');
if (emptyCell.applied !== 0) fail('empty tsv must not apply');

const clear = applyCostTsv('Имбирный чай 150 г\tCLEAR\n', seedCostDrafts(catalog, costs));
if (clear.issues.length) fail('CLEAR should apply');
const clearChange = collectCostChanges(clear.drafts).changes.find((c) => c.id === 'p2');
if (!clearChange || clearChange.to !== null || clearChange.from !== 0) fail('CLEAR to null from 0');

if (canSubmitCostChanges([], 0, 0)) fail('no changes cannot submit');
if (canSubmitCostChanges([{ id: 'p1', name: 'a', from: null, to: 1 }], 1, 0)) fail('invalid blocks submit');
if (!canSubmitCostChanges([{ id: 'p1', name: 'a', from: null, to: 1 }], 0, 0)) fail('valid submit');

if (classifyLiveChange({ id: 'p1', name: 'a', from: null, to: 10 }, 99) !== 'conflict') fail('conflict');
if (classifyLiveChange({ id: 'p1', name: 'a', from: null, to: 10 }, 10) !== 'already') fail('already');
if (classifyLiveChange({ id: 'p1', name: 'a', from: null, to: 10 }, null) !== 'write') fail('write');

const payload = costUpdatePayload(12.5);
if (Object.keys(payload).join(',') !== 'cost_price') fail('update only cost_price');
if (costUpdatePayload(null).cost_price !== null) fail('null payload');
if (interpretCostUpdateResult(0).ok) fail('zero-row update is not success');
if (!interpretCostUpdateResult(1).ok) fail('one-row update is success');
if (interpretCostUpdateResult(1, '42501').ok) fail('permission error');

const hist = resolveLineUnitCost({ snapshot: null, catalog: 1800 });
if (hist.source !== 'estimated' || hist.unit !== 1800) fail('old null snapshot stays estimated');
const kept = resolveLineUnitCost({ snapshot: 100, catalog: 1800 });
if (kept.source !== 'historical' || kept.unit !== 100) fail('snapshot not rewritten by catalog');
const zeroSnap = resolveLineUnitCost({ snapshot: 0, catalog: 1800 });
if (zeroSnap.source !== 'historical' || zeroSnap.unit !== 0) fail('zero snapshot is historical 0');

const counts = filledMissingCounts(seedCostDrafts(catalog, costs));
if (counts.filled !== 3 || counts.missing !== 1) fail(`counts ${counts.filled}/${counts.missing}`);

const filtered = filterCostDrafts(seedCostDrafts(catalog, costs), {
  search: 'чай',
  missingOnly: false,
  dirtyOnly: false,
});
if (filtered.length !== 1 || filtered[0].id !== 'p2') fail('search');

const merged = mergeSaveResultsIntoDrafts(
  tsv.drafts,
  new Map([
    ['p1', 1800],
    ['p2', 0],
  ]),
  [
    { id: 'p1', name: 'a', ok: true, code: 'saved', message: 'ok' },
    { id: 'p2', name: 'b', ok: false, code: 'error', message: 'fail' },
  ]
);
if (merged[0].dirty) fail('saved row must clear dirty');
if (!merged.find((r) => r.id === 'p2')?.dirty) fail('failed row must keep unsaved edit');

const page = read('app/admin/products/costs/page.tsx');
const productsPage = read('app/admin/products/page.tsx');
const navM = read('components/NavManager.tsx');
const navS = read('components/NavSeller.tsx');
const i18n = read('lib/i18n.tsx');
const finance = read('lib/adminFinance.ts');
const snapshots = read('lib/adminFinanceSnapshots.ts');
const abc = read('lib/adminAbc.ts');
const confirmSql = read('supabase/migrations/20261108220000_order_item_cost_snapshot.sql');

if (!page.includes('Protected role="admin"')) fail('admin only page');
if (!page.includes("profile?.role === 'admin'")) fail('admin role re-check before save');
if (!page.includes('runExclusive')) fail('repeat click guard');
if (!page.includes('product-costs-save')) fail('exclusive key');
if (!page.includes('classifyLiveChange')) fail('conflict recheck');
if (!page.includes('costUpdatePayload')) fail('narrow update');
if (!page.includes("count: 'exact'")) fail('must count updated rows');
if (page.includes(".eq('cost_price'")) fail('no SELECT grant on cost_price: cannot CAS in WHERE');
if (!i18n.includes('между чтением и UPDATE')) fail('must disclose TOCTOU window');
if (!page.includes('FINANCE_COSTS_RPC')) fail('reload via admin_product_costs');
if (!page.includes('productCosts.notAtomic')) fail('non-atomic notice');
if (!page.includes('productCosts.warnEstimate')) fail('estimate warning');
if (!page.includes('productCosts.partial')) fail('partial copy');
if (page.includes('service_role') || page.includes('createServiceClient')) fail('no service_role');
if (page.includes('confirm_order') || page.includes('cost_price_snapshot')) fail('must not touch snapshots');
if (page.includes("update({") && !page.includes('costUpdatePayload')) fail('raw update object');
if (!productsPage.includes('/admin/products/costs')) fail('link from products');
if (navM.includes('/admin/products/costs')) fail('manager nav');
if (navS.includes('/admin/products/costs')) fail('seller nav');
if (PRODUCT_CATALOG_SELECT.includes('cost_price')) fail('catalog select must omit cost');

if (!i18n.includes("'productCosts.title': 'Себестоимость товаров'")) fail('i18n ru');
if (!i18n.includes("'productCosts.title': 'Тауарлардың өзіндік құны'")) fail('i18n kz');
const keys = [...i18n.matchAll(/'(productCosts\.[^']+)':/g)].map((m) => m[1]);
const mid = keys.length / 2;
const ruSet = new Set(keys.slice(0, mid));
const kzSet = new Set(keys.slice(mid));
if (ruSet.size !== kzSet.size) fail(`i18n size ru ${ruSet.size} kz ${kzSet.size}`);
for (const key of ruSet) if (!kzSet.has(key)) fail(`kz missing ${key}`);

if (!finance.includes('resolveLineUnitCost')) fail('finance still uses resolveLineUnitCost');
if (!snapshots.includes("source: 'historical'") || !snapshots.includes("source: 'estimated'")) {
  fail('snapshot helper unchanged');
}
if (!abc.includes('buildAdminFinance') && !read('lib/adminAbc.ts').includes('cogs')) fail('abc file present');
if (!confirmSql.includes('cost_price_snapshot')) fail('confirm snapshot sql untouched as reference');
if (page.includes('admin_order_item_cost_snapshots')) fail('costs page must not write snapshots');

console.log('admin-product-costs checks ok');
