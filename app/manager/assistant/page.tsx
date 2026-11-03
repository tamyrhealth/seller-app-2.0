'use client';

import Protected from '@/components/Protected';
import NavManager from '@/components/NavManager';
import AssistantChats from '@/components/AssistantChats';

export default function ManagerAssistantPage() {
  return (
    <Protected role="manager">
      <div className="min-h-screen bg-white">
        <NavManager />
        <div className="p-4">
          <h1 className="text-2xl font-bold text-gray-900 mb-4">ИИ-бот</h1>
          <AssistantChats />
        </div>
      </div>
    </Protected>
  );
}
