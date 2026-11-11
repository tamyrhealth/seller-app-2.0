import { readFileSync } from 'fs';
import { join } from 'path';
import { isSilentPageReload, markPageQueryPainted } from '../lib/pageViewport';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const painted = { current: null as string | null };
if (isSilentPageReload('finance:2026-01', painted)) fail('unpainted query is not silent');
markPageQueryPainted('finance:2026-01', painted);
if (!isSilentPageReload('finance:2026-01', painted)) fail('same query must be silent after paint');
if (isSilentPageReload('finance:2026-02', painted)) fail('new query must show blocking load');

const visPages = [
  'app/admin/page.tsx',
  'app/admin/finance/page.tsx',
  'app/admin/abc/page.tsx',
  'app/admin/forecast/page.tsx',
  'app/admin/customers/page.tsx',
  'app/admin/map/page.tsx',
  'app/seller/page.tsx',
];

for (const rel of visPages) {
  const src = read(rel);
  if (!src.includes("document.visibilityState === 'visible'")) fail(`${rel} must still refresh on resume`);
  if (!src.includes('isSilentPageReload')) fail(`${rel} must keep tree on resume reload`);
  if (!src.includes('markPageQueryPainted')) fail(`${rel} must mark painted query`);
  if (src.includes('window.scrollTo(0, 0)')) fail(`${rel} must not force window top`);
}

const otherRoutes = [
  'app/admin/orders/page.tsx',
  'app/admin/stats/page.tsx',
  'app/admin/seller-tariffs/page.tsx',
  'app/admin/locations/page.tsx',
  'app/admin/products/page.tsx',
  'app/admin/users/page.tsx',
  'app/admin/activity/page.tsx',
  'app/admin/losses/page.tsx',
  'app/admin/assistant/page.tsx',
  'app/manager/page.tsx',
  'app/manager/orders/page.tsx',
  'app/manager/inventory/page.tsx',
  'app/manager/assistant/page.tsx',
  'app/seller/orders/SellerOrdersClient.tsx',
  'app/seller/inventory/page.tsx',
  'app/seller/debts/page.tsx',
  'app/seller/preorders/page.tsx',
  'app/seller/balance/page.tsx',
  'app/seller/new-order/page.tsx',
  'components/AssistantChats.tsx',
  'components/TransfersPanel.tsx',
  'components/InventoryBrowse.tsx',
];

for (const rel of otherRoutes) {
  const src = read(rel);
  if (src.includes("document.visibilityState === 'visible'") && src.includes('setRefreshKey')) {
    fail(`${rel} resume refresh must use silent page reload`);
  }
  if (src.includes('window.scrollTo(0')) fail(`${rel} must not reset window scroll`);
}

const auth = read('lib/auth.tsx');
if (!auth.includes('prevUserId === nextUserId')) fail('auth must skip same-user session setState');
if (!auth.includes("visibilityState === 'visible'")) fail('auth must still revalidate on resume');
if (!auth.includes('revalidateSession')) fail('auth resume check');

const protectedUi = read('components/Protected.tsx');
if (!protectedUi.includes('if (entered) return <>{children}</>')) fail('Protected must keep children after entry');

const chats = read('components/AssistantChats.tsx');
if (chats.includes('scrollIntoView')) fail('chat must not move the window');

console.log('scroll-resume checks ok');
