import OpenAI from 'openai';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ASSISTANT_DEFAULT_MODEL,
  ASSISTANT_HISTORY_CHAR_EACH,
  ASSISTANT_HISTORY_MESSAGES,
  ASSISTANT_MAX_OUTPUT_TOKENS,
  ASSISTANT_OPENAI_TIMEOUT_MS,
  ASSISTANT_REQUEST_DEADLINE_MS,
  ASSISTANT_TOOL_ROUNDS,
} from '@/lib/assistant/limits';
import { ASSISTANT_INSTRUCTIONS } from '@/lib/assistant/prompt';
import { capText, stripIdentifiers } from '@/lib/assistant/sanitize';
import { ASSISTANT_TOOLS, executeAssistantTool } from '@/lib/assistant/tools';

type HistoryRow = { role: string; content: string };

export function openaiClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('missing_openai_key');
  return new OpenAI({ apiKey, timeout: ASSISTANT_OPENAI_TIMEOUT_MS, maxRetries: 0 });
}

export function modelName(): string {
  return (process.env.OPENAI_MODEL || ASSISTANT_DEFAULT_MODEL).trim() || ASSISTANT_DEFAULT_MODEL;
}

export function toModelInput(history: HistoryRow[], userText: string): ResponseInputItem[] {
  const recent = history.slice(-ASSISTANT_HISTORY_MESSAGES);
  const input: ResponseInputItem[] = recent
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({
      type: 'message',
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: capText(stripIdentifiers(row.content || ''), ASSISTANT_HISTORY_CHAR_EACH),
    }));
  input.push({
    type: 'message',
    role: 'user',
    content: capText(stripIdentifiers(userText), ASSISTANT_HISTORY_CHAR_EACH),
  });
  return input;
}

export async function generateAssistantReply(
  db: SupabaseClient,
  history: HistoryRow[],
  userText: string
): Promise<string> {
  const client = openaiClient();
  let input: ResponseInputItem[] = toModelInput(history, userText);
  const started = Date.now();

  for (let round = 0; round < ASSISTANT_TOOL_ROUNDS; round += 1) {
    const remaining = ASSISTANT_REQUEST_DEADLINE_MS - (Date.now() - started);
    if (remaining < 2000) throw new Error('timed out');
    const response = await client.responses.create(
      {
        model: modelName(),
        instructions: ASSISTANT_INSTRUCTIONS,
        input,
        tools: ASSISTANT_TOOLS,
        store: false,
        max_output_tokens: ASSISTANT_MAX_OUTPUT_TOKENS,
      },
      { timeout: Math.min(ASSISTANT_OPENAI_TIMEOUT_MS, remaining) }
    );

    const calls = response.output.filter((item) => item.type === 'function_call');
    if (calls.length === 0) {
      const text = (response.output_text || '').trim();
      if (text) return text;
      return 'Модель не вернула текст. Повторите запрос.';
    }

    const outputs: ResponseInputItem[] = [];
    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i];
      const result =
        i < 3
          ? await executeAssistantTool(db, call.name, call.arguments || '{}')
          : JSON.stringify({ error: 'too_many_tool_calls' });
      outputs.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: result,
      });
    }
    input = [...input, ...(response.output as ResponseInputItem[]), ...outputs];
  }

  return 'Не удалось завершить запрос к данным за разумное число шагов. Уточните вопрос и повторите.';
}
