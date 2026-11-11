'use client';

import Protected from '@/components/Protected';
import NavManager from '@/components/NavManager';
import AssistantChats from '@/components/AssistantChats';

export default function ManagerAssistantPage() {
  return (
    <Protected role="manager">
      <div className="app-shell-chat min-h-0 overflow-hidden flex flex-col bg-white h-[var(--app-vvh,100dvh)]">
        <div className="shrink-0">
          <NavManager />
        </div>
        <div className="flex-1 min-h-0 overflow-hidden px-3 py-2 md:px-4 md:py-3 flex flex-col gap-2">
          <h1 className="hidden lg:block shrink-0 text-lg md:text-2xl font-bold text-gray-900">ИИ-бот</h1>
          <div className="flex-1 min-h-0 overflow-hidden">
            <AssistantChats />
          </div>
        </div>
      </div>
    </Protected>
  );
}
