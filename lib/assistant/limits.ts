export const ASSISTANT_USER_MESSAGE_MAX = 4000;
export const ASSISTANT_HISTORY_MESSAGES = 20;
export const ASSISTANT_HISTORY_CHAR_EACH = 1500;
export const ASSISTANT_TOOL_ROUNDS = 6;
export const ASSISTANT_TOOL_RESULT_CHARS = 8000;
export const ASSISTANT_MAX_OUTPUT_TOKENS = 1200;
/** Must stay below the SQL lease (90s) with room for fail() before Vercel kill. */
export const ASSISTANT_LEASE_SECONDS = 90;
export const ASSISTANT_OPENAI_TIMEOUT_MS = 20000;
export const ASSISTANT_REQUEST_DEADLINE_MS = 55000;
export const ASSISTANT_DEFAULT_MODEL = 'gpt-4o-mini';
export const ASSISTANT_STOCK_PRODUCT_CAP = 8;
export const ASSISTANT_STOCK_ROW_CAP = 60;
export const ASSISTANT_ORDER_CAP = 12;
