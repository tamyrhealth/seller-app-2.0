import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { looksLikeInvoice, extractPhones } from '@/lib/assistant/paymentParse';
import { parseInvoiceStructured } from '@/lib/assistant/invoiceParse';
import { generateAssistantReply } from '@/lib/assistant/runModel';
import { buildDraftMarkdown, resolveInvoiceDraft } from '@/lib/assistant/resolveOrder';
import { ASSISTANT_REQUEST_DEADLINE_MS } from '@/lib/assistant/limits';
import type { DraftResolved, DraftPreview, DraftIssue } from '@/lib/assistant/orderDraftTypes';

type HistoryRow = { role: string; content: string };

export type TurnDraft = {
  id: string;
  status: 'preview' | 'blocked';
  can_confirm: boolean;
  warnings: DraftIssue[];
  errors: DraftIssue[];
  resolved: DraftResolved;
  preview: DraftPreview;
  customer_phone: string | null;
  idempotency_key: string;
};

export type AssistantTurn = {
  content: string;
  draft: TurnDraft | null;
};

export async function generateAssistantTurn(
  db: SupabaseClient,
  history: HistoryRow[],
  userText: string
): Promise<AssistantTurn> {
  const started = Date.now();
  const remaining = () => ASSISTANT_REQUEST_DEADLINE_MS - (Date.now() - started);
  if (looksLikeInvoice(userText)) {
    const parsed = await parseInvoiceStructured(userText, Math.max(3000, remaining() - 8000));
    if (parsed.intent === 'create_order' || parsed.items.length > 0) {
      const phones = extractPhones(userText);
      const resolved = await resolveInvoiceDraft(db, parsed, userText, phones);
      const draft: TurnDraft = {
        id: randomUUID(),
        status: resolved.can_confirm ? 'preview' : 'blocked',
        can_confirm: resolved.can_confirm,
        warnings: resolved.warnings,
        errors: resolved.errors,
        resolved: resolved.resolved,
        preview: resolved.preview,
        customer_phone: resolved.resolved.is_debt ? phones[0] || null : null,
        idempotency_key: randomUUID(),
      };
      return { content: buildDraftMarkdown(resolved), draft };
    }
  }
  if (remaining() < 2000) throw new Error('timed out');
  const content = await generateAssistantReply(db, history, userText);
  return { content, draft: null };
}
