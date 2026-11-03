export function formatChatNumber(n: number): string {
  const s = String(Math.trunc(n));
  return `C${s.length >= 6 ? s : s.padStart(6, '0')}`;
}

export function displayChatNumber(chat: { chat_number?: string | null; id: string }): string {
  return chat.chat_number?.trim() || '';
}
