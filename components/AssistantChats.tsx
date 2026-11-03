'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabaseClient';

type ChatRow = {
  id: string;
  owner_id: string;
  title: string;
  updated_at: string;
  owner_name?: string;
};

type MsgRow = {
  id: string;
  role: string;
  content: string;
  created_at: string;
};

export default function AssistantChats({ audit = false }: { audit?: boolean }) {
  const { profile } = useAuth();
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [messages, setMessages] = useState<MsgRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [rename, setRename] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const readOnly = audit;

  const loadChats = useCallback(async () => {
    let q = supabase
      .from('assistant_chats')
      .select('id, owner_id, title, updated_at')
      .is('archived_at', null)
      .order('updated_at', { ascending: false });
    if (!audit && profile?.id) q = q.eq('owner_id', profile.id);
    const { data, error: err } = await q;
    if (err) {
      setError(
        err.message.includes('assistant_chats')
          ? 'Сначала примените SQL этапа 5.1 (чаты ИИ-бота).'
          : err.message
      );
      setChats([]);
      return;
    }
    setError('');
    const ownerIds = [...new Set((data || []).map((row) => row.owner_id as string))];
    const names = new Map<string, string>();
    if (audit && ownerIds.length > 0) {
      const { data: owners } = await supabase.from('profiles').select('id, display_name').in('id', ownerIds);
      for (const o of owners || []) names.set(o.id as string, (o.display_name as string) || '');
    }
    setChats(
      (data || []).map((row) => ({
        id: row.id as string,
        owner_id: row.owner_id as string,
        title: row.title as string,
        updated_at: row.updated_at as string,
        owner_name: names.get(row.owner_id as string),
      }))
    );
  }, [audit, profile?.id]);

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    if (!openId) {
      setMessages([]);
      return;
    }
    supabase
      .from('assistant_messages')
      .select('id, role, content, created_at')
      .eq('chat_id', openId)
      .order('created_at', { ascending: true })
      .then(({ data, error: err }) => {
        if (err) setError(err.message);
        else setMessages((data || []) as MsgRow[]);
      });
    const chat = chats.find((c) => c.id === openId);
    setRename(chat?.title || '');
  }, [openId, chats]);

  async function createChat() {
    if (!profile?.id || busy) return;
    setBusy(true);
    const { data, error: err } = await supabase
      .from('assistant_chats')
      .insert({ owner_id: profile.id, title: 'Новый диалог' })
      .select('id')
      .single();
    setBusy(false);
    if (err) {
      setError(
        err.message.includes('assistant_chats')
          ? 'Сначала примените SQL этапа 5.1 (чаты ИИ-бота).'
          : err.message
      );
      return;
    }
    await loadChats();
    setOpenId(data.id);
  }

  async function saveTitle() {
    if (!openId || readOnly) return;
    const title = rename.trim() || 'Новый диалог';
    const { error: err } = await supabase
      .from('assistant_chats')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', openId);
    if (err) setError(err.message);
    else await loadChats();
  }

  async function send() {
    if (!openId || !profile?.id || readOnly || busy) return;
    const content = draft.trim();
    if (!content) return;
    setBusy(true);
    const clientMessageId = crypto.randomUUID();
    const { error: err } = await supabase.from('assistant_messages').insert({
      chat_id: openId,
      author_id: profile.id,
      role: 'user',
      content,
      client_message_id: clientMessageId,
      metadata: { source: 'assistant_ui' },
    });
    if (err && err.code !== '23505' && !err.message.toLowerCase().includes('duplicate')) {
      setError(err.message);
      setBusy(false);
      return;
    }
    await supabase.from('assistant_chats').update({ updated_at: new Date().toISOString() }).eq('id', openId);
    setDraft('');
    const { data } = await supabase
      .from('assistant_messages')
      .select('id, role, content, created_at')
      .eq('chat_id', openId)
      .order('created_at', { ascending: true });
    setMessages((data || []) as MsgRow[]);
    await loadChats();
    setBusy(false);
  }

  const open = chats.find((c) => c.id === openId) || null;

  return (
    <div className="grid gap-4 md:grid-cols-[260px_1fr]">
      <div>
        {!readOnly && (
          <button
            type="button"
            onClick={() => void createChat()}
            className="mb-2 w-full px-3 py-2 bg-green-600 text-white rounded-lg"
          >
            Новый диалог
          </button>
        )}
        {error && <p className="text-sm text-red-700 mb-2">{error}</p>}
        <ul className="space-y-1">
          {chats.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setOpenId(c.id)}
                className={`w-full text-left px-3 py-2 rounded ${openId === c.id ? 'bg-blue-100' : 'bg-gray-100'}`}
              >
                <span className="block font-medium text-gray-900">{c.title}</span>
                {audit && <span className="block text-xs text-gray-600">{c.owner_name || c.owner_id.slice(0, 8)}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="border border-gray-200 rounded-lg p-3 min-h-[360px] flex flex-col">
        {!open ? (
          <p className="text-sm text-gray-600">Выберите или создайте диалог. История хранится в базе.</p>
        ) : (
          <>
            <div className="flex gap-2 mb-2">
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
            <p className="text-xs text-amber-800 mb-2">
              ИИ пока не подключён (этап 5.2). Сообщения пользователя сохраняются; ответов модели нет.
            </p>
            <div className="flex-1 overflow-y-auto space-y-2 mb-2">
              {messages.length === 0 ? (
                <p className="text-sm text-gray-600">Сообщений нет</p>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className="text-sm">
                    <span className="font-medium text-gray-700">
                      {m.role === 'user' ? 'Вы' : m.role === 'system' ? 'Система' : 'Ассистент'}
                    </span>
                    <p className="whitespace-pre-wrap text-gray-900">{m.content}</p>
                  </div>
                ))
              )}
            </div>
            {!readOnly && (
              <div className="flex gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={3}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
                  placeholder="Текст сохранится в истории диалога"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void send()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
                >
                  Сохранить
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
