'use client';

import { useState } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import AssistantChats from '@/components/AssistantChats';

export default function AdminAssistantPage() {
  const [audit, setAudit] = useState(false);
  return (
    <Protected role="admin">
      <div className="h-dvh min-h-0 overflow-hidden flex flex-col bg-white">
        <div className="shrink-0">
          <NavAdmin />
        </div>
        <div className="flex-1 min-h-0 overflow-hidden px-3 py-2 md:px-4 md:py-3 flex flex-col gap-2">
          <div className="shrink-0">
            <h1 className="text-lg md:text-2xl font-bold text-gray-900">ИИ-бот</h1>
            <div className="flex gap-2 mt-2">
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
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <AssistantChats audit={audit} key={audit ? 'audit' : 'mine'} />
          </div>
        </div>
      </div>
    </Protected>
  );
}
