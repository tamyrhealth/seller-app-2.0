'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabaseClient';
import { runExclusive } from '@/lib/exclusiveAsync';
import { displayChatNumber } from '@/lib/chatNumber';
import AssistantMarkdown from '@/components/AssistantMarkdown';
import AssistantOrderDraftCard from '@/components/AssistantOrderDraftCard';
import AssistantTransferDraftCard from '@/components/AssistantTransferDraftCard';
import AssistantCancelCard from '@/components/AssistantCancelCard';
import AssistantTransferManageCard from '@/components/AssistantTransferManageCard';
import type { AssistantDraftRow } from '@/lib/assistant/orderDraftTypes';
import {
  displaySimilarOrderNumber,
  formatSimilarLookupError,
  type SimilarOrderMatch,
} from '@/lib/similarOrders';
import type { AssistantTransferDraftRow } from '@/lib/assistant/transferTypes';
import type { CancelPreview } from '@/lib/assistant/cancelTypes';
import type { TransferManagePreview } from '@/lib/assistant/transferManageTypes';
import { resolveCancelCardState } from '@/lib/assistant/cancelCardState';
import {
  liveDraftForAssistantMessage,
  markDraftConfirmed,
  markDraftConfirming,
  revertDraftIfUnconfirmed,
  shouldPatchDraftConfirmed,
} from '@/lib/assistant/draftCardSync';
import { readUserUi, writeUserUi } from '@/lib/uiStorage';

type ChatRow = {
  id: string;
  owner_id: string;
  title: string;
  updated_at: string;
  chat_number?: string | null;
  message_count?: number;
  owner_name?: string;
};

type MsgRow = {
  id: string;
  role: string;
  content: string;
  created_at: string;
  metadata?: {
    kind?: string;
    draft_id?: string;
    state?: string;
    preview?: CancelPreview | TransferManagePreview;
    order_id?: string;
    order_number?: string;
    reuse?: 'open' | 'confirmed' | null;
    replay_content?: string;
    source?: string;
    already_canceled?: boolean;
  };
};

function sqlMissing(message: string) {
  return (
    message.includes('assistant_chats') ||
    message.includes('open_empty_assistant_chat') ||
    message.includes('chat_number') ||
    message.includes('schema cache')
  );
}

function cancelPreviewOf(meta: MsgRow['metadata']): CancelPreview | undefined {
  if (meta?.kind !== 'cancel_preview' || !meta.preview) return undefined;
  if ('order_id' in meta.preview) return meta.preview as CancelPreview;
  return undefined;
}

function formatMsgTime(iso: string) {
  return new Date(iso).toLocaleString('ru-KZ', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function AssistantChats({ audit = false }: { audit?: boolean }) {
  const { profile } = useAuth();
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [messages, setMessages] = useState<MsgRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [rename, setRename] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [waitingAi, setWaitingAi] = useState(false);
  const [retry, setRetry] = useState<{
    content: string;
    clientMessageId: string;
    forceNewInvoiceDraft?: boolean;
  } | null>(null);
  const [drafts, setDrafts] = useState<AssistantDraftRow[]>([]);
  const [similarByDraft, setSimilarByDraft] = useState<Record<string, SimilarOrderMatch[]>>({});
  const [transferDrafts, setTransferDrafts] = useState<AssistantTransferDraftRow[]>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [newlineOnEnter, setNewlineOnEnter] = useState(false);
  const NEAR_BOTTOM_PX = 96;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const coarse = window.matchMedia('(pointer: coarse)');
    const noHover = window.matchMedia('(hover: none)');
    const sync = () => {
      setNewlineOnEnter(coarse.matches || noHover.matches || navigator.maxTouchPoints > 0);
    };
    sync();
    const listen = (mq: MediaQueryList, fn: () => void) => {
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', fn);
      else mq.addListener(fn);
      return () => {
        if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', fn);
        else mq.removeListener(fn);
      };
    };
    const offCoarse = listen(coarse, sync);
    const offHover = listen(noHover, sync);
    return () => {
      offCoarse();
      offHover();
    };
  }, []);

  function isThreadNearBottom(el: HTMLElement) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }

  function scrollThreadToEnd() {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      const again = threadRef.current;
      if (again) again.scrollTop = again.scrollHeight;
    });
  }

  function syncJumpFromThread() {
    const el = threadRef.current;
    if (!el) return;
    const near = isThreadNearBottom(el);
    stickToBottomRef.current = near;
    setShowJump(!near && el.scrollHeight > el.clientHeight + 8);
  }
  const draftsByChatRef = useRef<Record<string, string>>({});
  const readOnly = audit;
  const sendingRef = useRef(false);

  const loadChats = useCallback(async () => {
    const selectFull = 'id, owner_id, title, updated_at, chat_number, message_count';
    const selectBase = 'id, owner_id, title, updated_at';
    async function query(cols: string) {
      let q = supabase.from('assistant_chats').select(cols).is('archived_at', null).order('updated_at', {
        ascending: false,
      });
      if (!audit && profile?.id) q = q.eq('owner_id', profile.id);
      return q;
    }
    let { data, error: err } = await query(selectFull);
    if (err && (err.message.includes('chat_number') || err.message.includes('message_count'))) {
      ({ data, error: err } = await query(selectBase));
    }
    if (err) {
      setError(sqlMissing(err.message) ? 'Сначала примените SQL этапа 5.1.1 (нумерация диалогов).' : err.message);
      setChats([]);
      return;
    }
    setError('');
    const rows = (data || []) as unknown as ChatRow[];
    const ownerIds = [...new Set(rows.map((row) => row.owner_id))];
    const names = new Map<string, string>();
    if (audit && ownerIds.length > 0) {
      const { data: owners } = await supabase.from('profiles').select('id, display_name').in('id', ownerIds);
      for (const o of owners || []) names.set(o.id as string, (o.display_name as string) || '');
    }
    setChats(
      rows.map((row) => ({
        ...row,
        owner_name: names.get(row.owner_id),
      }))
    );
  }, [audit, profile?.id]);

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    if (audit || !profile?.id) return;
    const saved = readUserUi<{ openId?: string | null; draftsByChat?: Record<string, string> }>(
      profile.id,
      'assistant-ui'
    );
    if (saved?.draftsByChat) {
      draftsByChatRef.current = { ...saved.draftsByChat, ...draftsByChatRef.current };
    }
  }, [audit, profile?.id]);

  useEffect(() => {
    if (audit || openId || !profile?.id || chats.length === 0) return;
    const saved = readUserUi<{ openId?: string | null }>(profile.id, 'assistant-ui');
    if (saved?.openId && chats.some((c) => c.id === saved.openId)) setOpenId(saved.openId);
  }, [audit, chats, openId, profile?.id]);

  useEffect(() => {
    if (audit || !profile?.id) return;
    writeUserUi(profile.id, 'assistant-ui', { openId, draftsByChat: draftsByChatRef.current });
  }, [audit, profile?.id, openId, draft]);

  useEffect(() => {
    if (!openId) {
      setMessages([]);
      setDrafts([]);
      setTransferDrafts([]);
      return;
    }
    stickToBottomRef.current = true;
    const savedDraft = draftsByChatRef.current[openId];
    if (savedDraft) setDraft(savedDraft);
    void reloadMessages(openId);
  }, [openId]);

  useEffect(() => {
    if (!openId) return;
    const chat = chats.find((c) => c.id === openId);
    if (chat) setRename(chat.title || '');
  }, [openId, chats]);

  useLayoutEffect(() => {
    if (!openId) {
      setShowJump(false);
      return;
    }
    if (!stickToBottomRef.current) {
      syncJumpFromThread();
      return;
    }
    scrollThreadToEnd();
    setShowJump(false);
  }, [messages, drafts, transferDrafts, waitingAi, openId]);

  useEffect(() => {
    const el = threadRef.current;
    if (!el || !openId || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollThreadToEnd();
      else syncJumpFromThread();
    });
    ro.observe(el);
    const inner = el.firstElementChild;
    if (inner instanceof HTMLElement) ro.observe(inner);
    return () => ro.disconnect();
  }, [openId, messages.length, waitingAi]);

  async function createChat() {
    if (!profile?.id || busy || readOnly) return;
    setBusy(true);
    try {
      await runExclusive(`assistant-empty:${profile.id}`, async () => {
        const localEmpty = chats.find((c) => c.owner_id === profile.id && (c.message_count ?? -1) === 0);
        if (localEmpty) {
          setOpenId(localEmpty.id);
          return;
        }
        const { data, error: err } = await supabase.rpc('open_empty_assistant_chat');
        if (err) {
          if (sqlMissing(err.message)) {
            setError('Сначала примените SQL этапа 5.1.1 (нумерация диалогов).');
            return;
          }
          setError(err.message);
          return;
        }
        await loadChats();
        if (data) setOpenId(data as string);
      });
    } finally {
      setBusy(false);
    }
  }

  async function saveTitle() {
    if (!openId || readOnly) return;
    const title = rename.trim();
    if (!title) return;
    const { error: err } = await supabase
      .from('assistant_chats')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', openId);
    if (err) setError(err.message);
    else await loadChats();
  }

  async function reloadDrafts(chatId: string) {
    const { data, error: err } = await supabase
      .from('assistant_order_drafts')
      .select(
        'id, chat_id, owner_id, created_by, user_message_id, assistant_message_id, status, can_confirm, warnings, errors, preview, resolved, customer_phone, idempotency_key, order_id, order_number, confirmed_by, confirmed_at'
      )
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true });
    if (err) {
      if (!/assistant_order_drafts|schema cache/i.test(err.message)) setError(err.message);
      else setDrafts([]);
    } else {
      setDrafts((data || []) as AssistantDraftRow[]);
    }
    const { data: transferData, error: transferErr } = await supabase
      .from('assistant_stock_transfer_drafts')
      .select(
        'id, chat_id, owner_id, created_by, user_message_id, assistant_message_id, status, can_confirm, warnings, errors, preview, resolved, transfer_id, transfer_number'
      )
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true });
    if (transferErr) {
      if (!/assistant_stock_transfer_drafts|schema cache/i.test(transferErr.message)) setError(transferErr.message);
      else setTransferDrafts([]);
      return;
    }
    setTransferDrafts((transferData || []) as AssistantTransferDraftRow[]);
  }

  async function reloadMessages(chatId: string) {
    const { data, error: err } = await supabase
      .from('assistant_messages')
      .select('id, role, content, created_at, metadata')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true });
    if (err) {
      setError(err.message);
      await reloadDrafts(chatId);
      return;
    }
    const rows = (data || []) as MsgRow[];
    const orderIds = [
      ...new Set(
        rows
          .map((m) => cancelPreviewOf(m.metadata)?.order_id || '')
          .filter((id): id is string => Boolean(id))
      ),
    ];
    const live = new Map<string, { status: string | null; preorder_status: string | null }>();
    if (orderIds.length > 0) {
      const { data: orders } = await supabase
        .from('orders')
        .select('id, status, preorder_status')
        .in('id', orderIds);
      for (const row of orders || []) {
        live.set(row.id as string, {
          status: (row.status as string | null) || null,
          preorder_status: (row.preorder_status as string | null) || null,
        });
      }
    }
    const canceledByHistory = new Set(
      rows
        .filter((m) => m.metadata?.source === 'assistant_cancel' && m.metadata.order_id)
        .map((m) => m.metadata?.order_id as string)
    );
    setMessages(
      rows.map((m) => {
        const cancelPreview = cancelPreviewOf(m.metadata);
        if (!cancelPreview) return m;
        const liveRow = live.get(cancelPreview.order_id);
        const historyCanceled = canceledByHistory.has(cancelPreview.order_id);
        const state = resolveCancelCardState({
          storedState: m.metadata?.state,
          preview: cancelPreview,
          liveStatus: historyCanceled ? 'canceled' : liveRow?.status,
          livePreorderStatus: liveRow?.preorder_status,
        });
        const preview =
          state === 'confirmed'
            ? { ...cancelPreview, status: 'canceled', can_cancel: false }
            : cancelPreview;
        return { ...m, metadata: { ...m.metadata, state, preview } };
      })
    );
    await reloadDrafts(chatId);
  }

  async function requestAssistant(
    chatId: string,
    content: string,
    clientMessageId: string,
    forceNewInvoiceDraft = false
  ) {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setError('Сессия истекла. Войдите снова.');
      setRetry({ content, clientMessageId, forceNewInvoiceDraft });
      return;
    }
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        chatId,
        content,
        clientMessageId,
        forceNewInvoiceDraft: forceNewInvoiceDraft === true,
      }),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
      retryable?: boolean;
    };
    await reloadMessages(chatId);
    await loadChats();
    if (!res.ok || payload.ok === false) {
      setError(payload.message || 'Не удалось получить ответ ИИ.');
      if (payload.retryable !== false) {
        setRetry({ content, clientMessageId, forceNewInvoiceDraft });
      }
      else setRetry(null);
      return;
    }
    setError('');
    setRetry(null);
  }

  async function assistantTransferAction(path: 'confirm' | 'cancel', draftId: string) {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setError('Сессия истекла. Войдите снова.');
      return 'error' as const;
    }
    const res = await fetch(`/api/assistant/transfers/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ draftId }),
    });
    const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; pending?: boolean };
    if (openId) {
      await reloadMessages(openId);
      await loadChats();
    }
    if (res.status === 202 || payload.pending) {
      setError(payload.message || 'Отправка ещё обрабатывается. Повторите подтверждение.');
      return 'pending' as const;
    }
    if (!res.ok || payload.ok === false) {
      setError(payload.message || 'Не удалось выполнить действие с перемещением.');
      return 'error' as const;
    }
    setError('');
    return 'ok' as const;
  }

  async function confirmTransferDraft(draftId: string) {
    if (readOnly || busy) return;
    setBusy(true);
    try {
      await runExclusive(`assistant-transfer-confirm:${draftId}`, async () => {
        const first = await assistantTransferAction('confirm', draftId);
        if (first !== 'pending') return;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await assistantTransferAction('confirm', draftId);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сеть недоступна.');
    } finally {
      setBusy(false);
    }
  }

  async function assistantTransferManage(action: 'confirm' | 'dismiss', messageId: string) {
    if (readOnly || busy || !openId) return;
    setBusy(true);
    try {
      await runExclusive(`assistant-transfer-manage:${action}:${messageId}`, async () => {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) {
          setError('Сессия истекла. Войдите снова.');
          return;
        }
        const res = await fetch('/api/assistant/transfers/manage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ chatId: openId, messageId, action }),
        });
        const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
        if (!res.ok || payload.ok === false) {
          setError(payload.message || 'Не удалось выполнить операцию перемещения.');
          return;
        }
        setError('');
        await reloadMessages(openId);
        await loadChats();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сеть недоступна.');
    } finally {
      setBusy(false);
    }
  }

  async function cancelTransferDraft(draftId: string) {
    if (readOnly || busy) return;
    setBusy(true);
    try {
      await runExclusive(`assistant-transfer-cancel:${draftId}`, () => assistantTransferAction('cancel', draftId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сеть недоступна.');
    } finally {
      setBusy(false);
    }
  }

  async function assistantOrderAction(
    path: 'confirm' | 'cancel',
    draftId: string,
    extra?: { acknowledgedSimilarIds?: string[]; acknowledgedComposition?: string }
  ) {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setError('Сессия истекла. Войдите снова.');
      return { status: 'error' as const };
    }
    const res = await fetch(`/api/assistant/orders/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        draftId,
        acknowledged_similar_ids: extra?.acknowledgedSimilarIds || [],
        acknowledged_similar_composition: extra?.acknowledgedComposition || '',
      }),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
      pending?: boolean;
      code?: string;
      matches?: SimilarOrderMatch[];
      order_id?: string;
      order_number?: string;
    };
    if (
      shouldPatchDraftConfirmed({
        path,
        okHttp: res.ok,
        payload,
      })
    ) {
      setDrafts((prev) => markDraftConfirmed(prev, draftId, payload));
    }
    if (openId) {
      await reloadMessages(openId);
      await loadChats();
    }
    if (res.status === 202 || payload.pending) {
      setError(payload.message || 'Заказ ещё обрабатывается. Повторите подтверждение.');
      return { status: 'pending' as const };
    }
    if (res.status === 409 && payload.code === 'similar_orders') {
      const matches = Array.isArray(payload.matches) ? payload.matches : [];
      setSimilarByDraft((prev) => ({ ...prev, [draftId]: matches }));
      const numbers = matches.map(displaySimilarOrderNumber).join(', ');
      setError(
        payload.message ||
          `Похожий заказ уже есть: ${numbers || 'без номера'}. Откройте существующий или нажмите «Это другой заказ — продолжить».`
      );
      return { status: 'similar' as const };
    }
    if (res.status === 503 && payload.code === 'sql_missing') {
      setError(payload.message || formatSimilarLookupError(payload.message));
      return { status: 'error' as const };
    }
    if (!res.ok || payload.ok === false) {
      setError(payload.message || 'Не удалось выполнить действие с заказом.');
      return { status: 'error' as const };
    }
    setError('');
    setSimilarByDraft((prev) => {
      const next = { ...prev };
      delete next[draftId];
      return next;
    });
    return {
      status: 'ok' as const,
      order_id: payload.order_id,
      order_number: payload.order_number,
    };
  }

  async function confirmDraft(
    draftId: string,
    opts?: { acknowledgedSimilarIds?: string[]; acknowledgedComposition?: string }
  ) {
    if (readOnly) return;
    setBusy(true);
    let previous: AssistantDraftRow | undefined;
    setDrafts((prev) => {
      previous = prev.find((row) => row.id === draftId);
      return markDraftConfirming(prev, draftId);
    });
    try {
      await runExclusive(`assistant-order-confirm:${draftId}`, async () => {
        const first = await assistantOrderAction('confirm', draftId, opts);
        if (first.status === 'error' || first.status === 'similar') {
          const snapshot = previous;
          if (snapshot) setDrafts((prev) => revertDraftIfUnconfirmed(prev, draftId, snapshot));
          return;
        }
        if (first.status !== 'pending') return;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const second = await assistantOrderAction('confirm', draftId, opts);
        if (second.status === 'error' || second.status === 'similar') {
          const snapshot = previous;
          if (snapshot) setDrafts((prev) => revertDraftIfUnconfirmed(prev, draftId, snapshot));
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сеть недоступна.');
      const snapshot = previous;
      if (snapshot) setDrafts((prev) => revertDraftIfUnconfirmed(prev, draftId, snapshot));
    } finally {
      setBusy(false);
    }
  }

  async function confirmLiveCancel(orderId: string, messageId: string) {
    if (readOnly || busy || !openId) return;
    setBusy(true);
    try {
      await runExclusive(`assistant-live-cancel:${orderId}`, async () => {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) {
          setError('Сессия истекла. Войдите снова.');
          return;
        }
        const res = await fetch('/api/assistant/orders/void', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ orderId, chatId: openId, messageId }),
        });
        const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
        if (!res.ok || payload.ok !== true) {
          setError(payload.message || 'Не удалось отменить заказ.');
          return;
        }
        setError('');
        if (openId) {
          await reloadMessages(openId);
          await loadChats();
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сеть недоступна.');
    } finally {
      setBusy(false);
    }
  }

  async function dismissCancelCard(messageId: string) {
    if (readOnly || busy || !openId) return;
    setBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setError('Сессия истекла. Войдите снова.');
        return;
      }
      const res = await fetch('/api/assistant/orders/void', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'dismiss', chatId: openId, messageId }),
      });
      const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || payload.ok !== true) {
        setError(payload.message || 'Не удалось сохранить отказ от отмены.');
        return;
      }
      setError('');
      await reloadMessages(openId);
      await loadChats();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сеть недоступна.');
    } finally {
      setBusy(false);
    }
  }

  async function cancelDraft(draftId: string) {
    if (readOnly || busy) return;
    setBusy(true);
    try {
      await runExclusive(`assistant-order-cancel:${draftId}`, () => assistantOrderAction('cancel', draftId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сеть недоступна.');
    } finally {
      setBusy(false);
    }
  }

  async function send(existing?: {
    content: string;
    clientMessageId?: string;
    forceNewInvoiceDraft?: boolean;
  }) {
    if (!openId || !profile?.id || readOnly || busy || sendingRef.current) return;
    const content = (existing?.content || draft).trim();
    if (!content) return;
    const clientMessageId = existing?.clientMessageId || crypto.randomUUID();
    sendingRef.current = true;
    stickToBottomRef.current = true;
    setShowJump(false);
    setBusy(true);
    setWaitingAi(true);
    setError('');
    if (!existing) {
      setDraft('');
      if (openId) draftsByChatRef.current[openId] = '';
    }
    try {
      await runExclusive(`assistant-send:${openId}`, () =>
        requestAssistant(openId, content, clientMessageId, existing?.forceNewInvoiceDraft === true)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сеть недоступна.');
      setRetry({ content, clientMessageId, forceNewInvoiceDraft: existing?.forceNewInvoiceDraft === true });
      await reloadMessages(openId);
    } finally {
      sendingRef.current = false;
      setBusy(false);
      setWaitingAi(false);
    }
  }

  const open = chats.find((c) => c.id === openId) || null;
  const openNumber = open ? displayChatNumber(open) : '';

  return (
    <div className="h-full min-h-0 overflow-hidden flex flex-col md:grid md:h-full md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] md:gap-3">
      <div
        className={`min-h-0 overflow-hidden flex-col ${
          open ? 'hidden md:flex' : 'flex flex-1'
        }`}
      >
        {!readOnly && (
          <button
            type="button"
            onClick={() => void createChat()}
            disabled={busy}
            className="mb-2 shrink-0 w-full px-3 py-2 bg-green-600 text-white rounded-lg disabled:opacity-50"
          >
            Новый диалог
          </button>
        )}
        {error && !open ? <p className="text-sm text-red-700 mb-2 shrink-0">{error}</p> : null}
        <ul className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden space-y-1 pr-0.5">
          {chats.map((c) => {
            const num = displayChatNumber(c);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (openId) draftsByChatRef.current[openId] = draft;
                    stickToBottomRef.current = true;
                    setShowJump(false);
                    setOpenId(c.id);
                    setDraft(draftsByChatRef.current[c.id] || '');
                  }}
                  className={`w-full text-left px-3 py-2 rounded-xl ${openId === c.id ? 'bg-blue-100' : 'bg-gray-100'}`}
                >
                  {num ? <span className="block text-xs font-mono text-gray-600">{num}</span> : null}
                  <span className="block font-medium text-gray-900 truncate">{c.title}</span>
                  {audit && <span className="block text-xs text-gray-600 truncate">{c.owner_name || c.owner_id.slice(0, 8)}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div
        className={`min-h-0 overflow-hidden border border-gray-200 rounded-xl bg-slate-50 flex-col ${
          open ? 'flex flex-1' : 'hidden md:flex md:flex-1'
        }`}
      >
        {!open ? (
          <p className="m-4 text-sm text-gray-600">Выберите или создайте диалог. История хранится в базе.</p>
        ) : (
          <>
            <div className="shrink-0 border-b border-gray-200 bg-white px-3 py-2 space-y-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (openId) draftsByChatRef.current[openId] = draft;
                    setOpenId(null);
                  }}
                  className="md:hidden shrink-0 px-2 py-1 text-sm text-blue-700"
                >
                  К диалогам
                </button>
                {openNumber ? <p className="text-xs font-mono text-gray-600 truncate">{openNumber}</p> : null}
              </div>
              <div className="flex gap-2 min-w-0">
                <input
                  value={rename}
                  onChange={(e) => setRename(e.target.value)}
                  disabled={readOnly}
                  className="min-w-0 flex-1 px-3 py-2 border border-gray-300 rounded-lg bg-white text-gray-900"
                />
                {!readOnly && (
                  <button type="button" onClick={() => void saveTitle()} className="shrink-0 px-3 py-2 bg-gray-200 rounded-lg">
                    Переименовать
                  </button>
                )}
              </div>
            </div>
            <div className="relative flex-1 min-h-0 overflow-hidden">
              <div
                ref={threadRef}
                onScroll={() => syncJumpFromThread()}
                className="h-full overflow-y-auto overflow-x-hidden px-3 py-3 overscroll-contain"
              >
                <div className="flex min-h-full flex-col justify-end gap-3">
                {messages.length === 0 && !waitingAi ? (
                  <p className="text-sm text-gray-600">Сообщений нет</p>
                ) : (
                  messages.map((m) => {
                    const mine = m.role === 'user';
                    const card = !mine ? liveDraftForAssistantMessage(drafts, m) : undefined;
                    const transferCard =
                      !mine
                        ? transferDrafts.find(
                            (row) =>
                              row.assistant_message_id === m.id ||
                              row.id === m.metadata?.draft_id
                          )
                        : undefined;
                    const hasCard = Boolean(
                      card ||
                        transferCard ||
                        m.metadata?.kind === 'cancel_preview' ||
                        m.metadata?.kind === 'transfer_manage'
                    );
                    return (
                      <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`min-w-0 max-w-[min(100%,40rem)] rounded-2xl px-3 py-2.5 text-sm shadow-sm ${
                            mine
                              ? 'ml-10 bg-blue-600 text-white rounded-br-md'
                              : `mr-10 bg-white text-gray-900 border border-gray-200 rounded-bl-md ${hasCard ? 'w-full' : ''}`
                          }`}
                        >
                          {mine ? (
                            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{m.content}</p>
                          ) : (
                            <div className="min-w-0">
                              <AssistantMarkdown content={m.content} />
                            </div>
                          )}
                          {m.metadata?.reuse && m.metadata.replay_content && !readOnly ? (
                            <button
                              type="button"
                              className="mt-2 text-sm text-blue-700 underline"
                              disabled={busy}
                              onClick={() =>
                                void send({
                                  content: String(m.metadata?.replay_content || ''),
                                  forceNewInvoiceDraft: true,
                                })
                              }
                            >
                              Это новый заказ
                            </button>
                          ) : null}
                          {card ? (
                            <div className="mt-2 min-w-0 overflow-x-auto">
                            <AssistantOrderDraftCard
                              draft={card}
                              readOnly={readOnly}
                              busy={busy}
                              onConfirm={(id, opts) => void confirmDraft(id, opts)}
                              onCancel={(id) => void cancelDraft(id)}
                              onUpdated={() => (openId ? reloadMessages(openId) : Promise.resolve())}
                              serverSimilarMatches={similarByDraft[card.id] || []}
                            />
                            </div>
                          ) : null}
                          {transferCard ? (
                            <div className="mt-2 min-w-0 overflow-x-auto">
                            <AssistantTransferDraftCard
                              draft={transferCard}
                              readOnly={readOnly}
                              busy={busy}
                              onConfirm={(id) => void confirmTransferDraft(id)}
                              onCancel={(id) => void cancelTransferDraft(id)}
                              onUpdated={() => (openId ? reloadMessages(openId) : Promise.resolve())}
                            />
                            </div>
                          ) : null}
                          {m.metadata?.kind === 'cancel_preview' && m.metadata.preview ? (
                            <div className="mt-2 min-w-0">
                            <AssistantCancelCard
                              preview={m.metadata.preview as CancelPreview}
                              state={m.metadata.state}
                              readOnly={readOnly}
                              busy={busy}
                              onConfirm={() =>
                                void confirmLiveCancel((m.metadata?.preview as CancelPreview | undefined)?.order_id || '', m.id)
                              }
                              onDismiss={() => void dismissCancelCard(m.id)}
                            />
                            </div>
                          ) : null}
                          {m.metadata?.kind === 'transfer_manage' && m.metadata.preview ? (
                            <div className="mt-2 min-w-0">
                            <AssistantTransferManageCard
                              preview={m.metadata.preview as TransferManagePreview}
                              state={m.metadata.state}
                              readOnly={readOnly}
                              busy={busy}
                              onConfirm={() => void assistantTransferManage('confirm', m.id)}
                              onDismiss={() => void assistantTransferManage('dismiss', m.id)}
                            />
                            </div>
                          ) : null}
                          <p className={`mt-1.5 text-[11px] ${mine ? 'text-blue-100 text-right' : 'text-gray-500'}`}>
                            {formatMsgTime(m.created_at)}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
                {waitingAi ? (
                  <div className="flex justify-start">
                    <div className="mr-10 max-w-[min(100%,40rem)] rounded-2xl rounded-bl-md border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-600 shadow-sm">
                      ИИ отвечает…
                    </div>
                  </div>
                ) : null}
                <div ref={bottomRef} />
                </div>
              </div>
              {showJump ? (
                <button
                  type="button"
                  onClick={() => {
                    stickToBottomRef.current = true;
                    setShowJump(false);
                    scrollThreadToEnd();
                  }}
                  className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-blue-600 px-3.5 py-2 text-sm font-medium text-white shadow-lg min-h-11"
                >
                  К новым
                </button>
              ) : null}
            </div>
            {!readOnly && (
              <div className="shrink-0 border-t border-gray-200 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] space-y-2 bg-white">
                {error ? <p className="text-sm text-red-700">{error}</p> : null}
                {retry ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void send(retry)}
                    className="px-3 py-2 bg-amber-100 text-amber-950 rounded-lg text-sm disabled:opacity-50"
                  >
                    Повторить запрос к ИИ
                  </button>
                ) : null}
                <div className="flex gap-2 items-end">
                  <textarea
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      if (openId) draftsByChatRef.current[openId] = e.target.value;
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
                      if (newlineOnEnter) return;
                      e.preventDefault();
                      void send();
                    }}
                    rows={newlineOnEnter ? 4 : 2}
                    disabled={busy}
                    enterKeyHint={newlineOnEnter ? 'enter' : 'send'}
                    onFocus={() => {
                      if (stickToBottomRef.current) scrollThreadToEnd();
                    }}
                    className={`min-w-0 flex-1 overflow-y-auto px-3 py-2.5 border border-gray-300 rounded-xl bg-white text-gray-900 resize-none text-base ${
                      newlineOnEnter ? 'min-h-[6.5rem] max-h-[40vh]' : 'max-h-32'
                    }`}
                    placeholder="Сообщение"
                  />
                  <button
                    type="button"
                    disabled={busy || !draft.trim()}
                    onClick={() => void send()}
                    aria-label="Отправить"
                    className="h-11 w-11 shrink-0 flex items-center justify-center rounded-full bg-blue-600 text-white disabled:opacity-50"
                  >
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
                      <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
