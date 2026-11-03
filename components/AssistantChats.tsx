'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabaseClient';
import { runExclusive } from '@/lib/exclusiveAsync';
import { displayChatNumber } from '@/lib/chatNumber';
import AssistantMarkdown from '@/components/AssistantMarkdown';
import AssistantOrderDraftCard from '@/components/AssistantOrderDraftCard';
import type { AssistantDraftRow } from '@/lib/assistant/orderDraftTypes';

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
  metadata?: { kind?: string; draft_id?: string };
};

function sqlMissing(message: string) {
  return (
    message.includes('assistant_chats') ||
    message.includes('open_empty_assistant_chat') ||
    message.includes('chat_number') ||
    message.includes('schema cache')
  );
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
  const [retry, setRetry] = useState<{ content: string; clientMessageId: string } | null>(null);
  const [drafts, setDrafts] = useState<AssistantDraftRow[]>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);
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
    if (!openId) {
      setMessages([]);
      setDrafts([]);
      return;
    }
    void reloadMessages(openId);
    const chat = chats.find((c) => c.id === openId);
    setRename(chat?.title || '');
  }, [openId, chats]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, openId]);

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
        'id, chat_id, owner_id, created_by, user_message_id, assistant_message_id, status, can_confirm, warnings, errors, preview, order_id, order_number, confirmed_by, confirmed_at'
      )
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true });
    if (err) {
      if (!/assistant_order_drafts|schema cache/i.test(err.message)) setError(err.message);
      else setDrafts([]);
      return;
    }
    setDrafts((data || []) as AssistantDraftRow[]);
  }

  async function reloadMessages(chatId: string) {
    const { data, error: err } = await supabase
      .from('assistant_messages')
      .select('id, role, content, created_at, metadata')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true });
    if (err) setError(err.message);
    else setMessages((data || []) as MsgRow[]);
    await reloadDrafts(chatId);
  }

  async function requestAssistant(chatId: string, content: string, clientMessageId: string) {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setError('Сессия истекла. Войдите снова.');
      setRetry({ content, clientMessageId });
      return;
    }
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ chatId, content, clientMessageId }),
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
      if (payload.retryable !== false) setRetry({ content, clientMessageId });
      else setRetry(null);
      return;
    }
    setError('');
    setRetry(null);
  }

  async function assistantOrderAction(path: 'confirm' | 'cancel', draftId: string) {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setError('Сессия истекла. Войдите снова.');
      return 'error' as const;
    }
    const res = await fetch(`/api/assistant/orders/${path}`, {
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
      setError(payload.message || 'Заказ ещё обрабатывается. Повторите подтверждение.');
      return 'pending' as const;
    }
    if (!res.ok || payload.ok === false) {
      setError(payload.message || 'Не удалось выполнить действие с заказом.');
      return 'error' as const;
    }
    setError('');
    return 'ok' as const;
  }

  async function confirmDraft(draftId: string) {
    if (readOnly || busy) return;
    setBusy(true);
    try {
      await runExclusive(`assistant-order-confirm:${draftId}`, async () => {
        const first = await assistantOrderAction('confirm', draftId);
        if (first !== 'pending') return;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await assistantOrderAction('confirm', draftId);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сеть недоступна.');
    } finally {
      setBusy(false);
    }
  }

  async function cancelDraft(draftId: string, fix = false) {
    if (readOnly || busy) return;
    setBusy(true);
    try {
      await runExclusive(`assistant-order-cancel:${draftId}`, () => assistantOrderAction('cancel', draftId));
      if (fix) {
        setDraft('');
        setError('Отправьте исправленную накладную новым сообщением.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сеть недоступна.');
    } finally {
      setBusy(false);
    }
  }

  async function send(existing?: { content: string; clientMessageId: string }) {
    if (!openId || !profile?.id || readOnly || busy || sendingRef.current) return;
    const content = (existing?.content || draft).trim();
    if (!content) return;
    const clientMessageId = existing?.clientMessageId || crypto.randomUUID();
    sendingRef.current = true;
    setBusy(true);
    setWaitingAi(true);
    setError('');
    if (!existing) setDraft('');
    try {
      await runExclusive(`assistant-send:${openId}`, () => requestAssistant(openId, content, clientMessageId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сеть недоступна.');
      setRetry({ content, clientMessageId });
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
    <div className="grid gap-4 md:grid-cols-[260px_1fr]">
      <div>
        {!readOnly && (
          <button
            type="button"
            onClick={() => void createChat()}
            disabled={busy}
            className="mb-2 w-full px-3 py-2 bg-green-600 text-white rounded-lg disabled:opacity-50"
          >
            Новый диалог
          </button>
        )}
        {error && <p className="text-sm text-red-700 mb-2">{error}</p>}
        <ul className="space-y-1">
          {chats.map((c) => {
            const num = displayChatNumber(c);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(c.id)}
                  className={`w-full text-left px-3 py-2 rounded ${openId === c.id ? 'bg-blue-100' : 'bg-gray-100'}`}
                >
                  {num ? <span className="block text-xs font-mono text-gray-600">{num}</span> : null}
                  <span className="block font-medium text-gray-900">{c.title}</span>
                  {audit && <span className="block text-xs text-gray-600">{c.owner_name || c.owner_id.slice(0, 8)}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="border border-gray-200 rounded-lg p-3 min-h-[360px] flex flex-col">
        {!open ? (
          <p className="text-sm text-gray-600">Выберите или создайте диалог. История хранится в базе.</p>
        ) : (
          <>
            <div className="mb-2">
              {openNumber ? <p className="text-xs font-mono text-gray-600 mb-1">{openNumber}</p> : null}
              <div className="flex gap-2">
                <input
                  value={rename}
                  onChange={(e) => setRename(e.target.value)}
                  disabled={readOnly}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
                />
                {!readOnly && (
                  <button type="button" onClick={() => void saveTitle()} className="px-3 py-2 bg-gray-200 rounded">
                    Переименовать
                  </button>
                )}
              </div>
            </div>
            {waitingAi ? <p className="text-xs text-blue-800 mb-2">ИИ отвечает…</p> : null}
            <div className="flex-1 overflow-y-auto space-y-2 mb-2">
              {messages.length === 0 ? (
                <p className="text-sm text-gray-600">Сообщений нет</p>
              ) : (
                messages.map((m) => {
                  const mine = m.role === 'user';
                  const card =
                    !mine
                      ? drafts.find(
                          (row) =>
                            row.assistant_message_id === m.id ||
                            row.id === m.metadata?.draft_id
                        )
                      : undefined;
                  return (
                    <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[85%] min-w-0 rounded-2xl px-3 py-2 text-sm ${
                          mine ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-900'
                        }`}
                      >
                        {mine ? (
                          <p className="whitespace-pre-wrap break-words">{m.content}</p>
                        ) : (
                          <AssistantMarkdown content={m.content} />
                        )}
                        {card ? (
                          <AssistantOrderDraftCard
                            draft={card}
                            readOnly={readOnly}
                            busy={busy}
                            onConfirm={(id) => void confirmDraft(id)}
                            onFix={(id) => void cancelDraft(id, true)}
                            onCancel={(id) => void cancelDraft(id)}
                          />
                        ) : null}
                        <p className={`mt-1 text-[11px] ${mine ? 'text-blue-100' : 'text-gray-500'}`}>
                          {formatMsgTime(m.created_at)}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>
            {!readOnly && (
              <div className="space-y-2">
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
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    rows={3}
                    disabled={busy}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
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
