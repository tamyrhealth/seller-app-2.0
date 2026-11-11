import { readFileSync } from 'fs';
import { join } from 'path';
import { emptyOrderFormDraft, isOrderFormDraftEmpty } from '../lib/orderFormDraft';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const auth = read('lib/auth.tsx');
const protectedUi = read('components/Protected.tsx');
const chats = read('components/AssistantChats.tsx');
const staffOrder = read('app/admin/new-order/page.tsx');
const sellerOrder = read('app/seller/new-order/page.tsx');
const voidRoute = read('app/api/assistant/orders/void/route.ts');
const confirm = read('app/api/assistant/orders/confirm/route.ts');
const storage = read('lib/uiStorage.ts');
const draftLib = read('lib/orderFormDraft.ts');

if (auth.includes("event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION'")) {
  fail('token refresh must not reuse the old loading refresh path');
}
if (!auth.includes("event === 'TOKEN_REFRESHED'")) fail('must handle TOKEN_REFRESHED');
const tokenBlock = auth.slice(auth.indexOf("event === 'TOKEN_REFRESHED'"), auth.indexOf("event === 'SIGNED_IN'"));
if (tokenBlock.includes('refreshProfile')) fail('TOKEN_REFRESHED must not call refreshProfile');
if (!tokenBlock.includes('if (s) applySession(s)')) fail('TOKEN_REFRESHED must keep current session if payload is empty');
if (!auth.includes('prevUserId === nextUserId')) fail('same-user token refresh must not remount the tree');
if (!auth.includes('sameUser && profileRef.current')) fail('SIGNED_IN same user must not reload profile');
if (!auth.includes('revalidateSession')) fail('must revalidate session on resume');
if (!auth.includes('online')) fail('must revalidate when network returns');
if (!auth.includes('getUser()')) fail('resume check must hit the auth server');
if (!auth.includes('isAuthInvalidError')) fail('must not treat network errors as logout');
if (!auth.includes('if (!sessionRef.current)')) fail('refresh errors must keep an existing session');
if (!auth.includes('clearAllUserUi')) fail('signOut must drop this user UI drafts');
if (!auth.includes("event === 'SIGNED_OUT'")) fail('SIGNED_OUT must clear session immediately');
if (!auth.includes('autoRefreshToken') && !read('lib/supabaseClient.ts').includes('autoRefreshToken: true')) {
  fail('must keep supabase autoRefreshToken enabled');
}

if (!protectedUi.includes('entered')) fail('Protected must keep the tree after first successful entry');
if (!protectedUi.includes('if (entered) return <>{children}</>')) fail('do not unmount children when profile flickers');

if (!chats.includes("'assistant-ui'")) fail('assistant must persist selected chat');
if (!chats.includes('draftsByChatRef')) fail('assistant must persist unsent text per chat');
if (!chats.includes('stickToBottomRef')) fail('assistant must not force-scroll when user scrolled up');
if (/void reloadMessages\(openId\);\s*\}, \[openId, chats\]/.test(chats)) {
  fail('reloading chats must not retrigger message reload');
}
if (!chats.includes('}, [openId]);')) fail('message reload must depend only on openId');
if (chats.includes('scrollIntoView')) fail('chat must not use scrollIntoView; it moves the window');
if (!chats.includes('el.scrollTop = el.scrollHeight')) fail('chat stick-to-bottom must stay inside the thread');
if (!draftLib.includes('isOrderFormDraftEmpty(current)')) fail('must not apply storage over typed form data');
if (!read('components/ClientUiStability.tsx').includes("scrollRestoration = 'auto'")) {
  fail('must keep native Back/Forward scroll restoration');
}
if (!read('components/ClientUiStability.tsx').includes('popstate')) fail('must skip custom restore on Back/Forward');

if (!staffOrder.includes("formId: 'staff-new-order'") && !staffOrder.includes("'staff-new-order'")) {
  fail('staff new-order must persist draft');
}
if (!sellerOrder.includes("'seller-new-order'")) fail('seller new-order must persist draft');
if (!staffOrder.includes('clearOrderFormDraft(profile.id, \'staff-new-order\')')) {
  fail('successful staff order must clear draft');
}
if (!sellerOrder.includes('clearOrderFormDraft(profile.id, \'seller-new-order\')')) {
  fail('successful seller order must clear draft');
}

if (!storage.includes('tamyr.ui.v1.')) fail('ui keys must be namespaced');
if (!storage.includes('userId')) fail('ui keys must include user id');
if (draftLib.includes('password') || draftLib.includes('access_token') || draftLib.includes('refresh_token')) {
  fail('order draft must not mention secrets');
}

if (!confirm.includes("rpc('confirm_order'")) fail('confirm_order path must stay');
if (!voidRoute.includes('cancel_order_report')) fail('cancel report RPC must stay');

if (!isOrderFormDraftEmpty(emptyOrderFormDraft())) fail('empty draft helper');
if (
  isOrderFormDraftEmpty({
    ...emptyOrderFormDraft(),
    cart: [{ product_id: 'x', product_name: 'n', price_retail: 1, qty: 1, customPrice: '', qty_on_hand: 1, unit: 'pcs' }],
  })
) {
  fail('cart is not empty');
}

console.log('OK');
