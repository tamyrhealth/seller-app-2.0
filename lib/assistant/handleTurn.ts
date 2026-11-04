import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { looksLikeInvoice, extractPhones } from '@/lib/assistant/paymentParse';
import { parseInvoiceStructured } from '@/lib/assistant/invoiceParse';
import { generateAssistantReply } from '@/lib/assistant/runModel';
import { resolveInvoiceDraft } from '@/lib/assistant/resolveOrder';
import { buildDraftChatMessage } from '@/lib/assistant/draftSummary';
import { ASSISTANT_REQUEST_DEADLINE_MS } from '@/lib/assistant/limits';
import type { DraftResolved, DraftPreview, DraftIssue } from '@/lib/assistant/orderDraftTypes';
import { parseCancelIntent } from '@/lib/assistant/cancelIntent';
import { resolveCancelPreview } from '@/lib/assistant/resolveCancel';
import type { CancelPreview } from '@/lib/assistant/cancelTypes';

type HistoryRow = { role: string; content: string };

export type AssistantActor = { role: string | null; can_cancel_orders: boolean };

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
  cancel: CancelPreview | null;
};

export async function generateAssistantTurn(
  db: SupabaseClient,
  history: HistoryRow[],
  userText: string,
  actor: AssistantActor
): Promise<AssistantTurn> {
  const started = Date.now();
  const remaining = () => ASSISTANT_REQUEST_DEADLINE_MS - (Date.now() - started);

  const cancelIntent = parseCancelIntent(userText);
  if (cancelIntent) {
    const resolved = await resolveCancelPreview(db, cancelIntent.canonicalNumber || cancelIntent.orderQuery, actor);
    return { content: resolved.content, draft: null, cancel: resolved.preview };
  }

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
      return { content: buildDraftChatMessage(resolved), draft, cancel: null };
    }
  }
  if (remaining() < 2000) throw new Error('timed out');
  const content = await generateAssistantReply(db, history, userText);
  return { content, draft: null, cancel: null };
}
