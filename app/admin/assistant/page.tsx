'use client';

import { useState } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import AssistantChats from '@/components/AssistantChats';

export default function AdminAssistantPage() {
  const [audit, setAudit] = useState(false);
  return (
    <Protected role="admin">
      <div className="min-h-screen bg-white">
        <NavAdmin />
        <div className="p-4">
          <h1 className="text-2xl font-bold text-gray-900 mb-3">ИИ-бот</h1>
          <div className="flex gap-2 mb-4">
            <button
              type="button"
              onClick={() => setAudit(false)}
              className={`px-3 py-2 rounded-lg ${audit ? 'bg-gray-200' : 'bg-blue-600 text-white'}`}
            >
              Мои диалоги
            </button>
            <button
              type="button"
              onClick={() => setAudit(true)}
              className={`px-3 py-2 rounded-lg ${audit ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
            >
              Аудит менеджеров
            </button>
          </div>
          <AssistantChats audit={audit} key={audit ? 'audit' : 'mine'} />
        </div>
      </div>
    </Protected>
  );
}
