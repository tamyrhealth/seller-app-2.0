import type { SupabaseClient } from '@supabase/supabase-js';
import type { FunctionTool } from 'openai/resources/responses/responses';
import {
  ASSISTANT_ORDER_CAP,
  ASSISTANT_STOCK_PRODUCT_CAP,
  ASSISTANT_STOCK_ROW_CAP,
  ASSISTANT_TOOL_RESULT_CHARS,
} from '@/lib/assistant/limits';
import { capText, scrubRecord } from '@/lib/assistant/sanitize';
import { parseOrderNumberQuery } from '@/lib/orderNumber';

export const ASSISTANT_TOOLS: FunctionTool[] = [
  {
    type: 'function',
    name: 'get_stock',
    description:
      'Read-only current warehouse quantities by product and city. Use for questions about leftovers, powder, stock in all cities. Empty city_query means every city.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        product_query: {
          type: 'string',
          description: 'Product name fragment in Russian or Kazakh, e.g. порошок. Empty string lists a limited catalog snapshot.',
        },
        city_query: {
          type: 'string',
          description: 'City name fragment. Empty string means all cities.',
        },
      },
      required: ['product_query', 'city_query'],
    },
  },
  {
    type: 'function',
    name: 'search_orders',
    description:
      'Read-only search of recent orders by number, product, city, or status. Does not change orders. Customer phones are never returned.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        order_number: { type: 'string', description: 'Order number like N000123. Empty if unused.' },
        product_query: { type: 'string', description: 'Product name fragment. Empty if unused.' },
        city_query: { type: 'string', description: 'City name fragment. Empty if unused.' },
        status: {
          type: 'string',
          description: 'confirmed, canceled, or empty for any.',
        },
      },
      required: ['order_number', 'product_query', 'city_query', 'status'],
    },
  },
  {
    type: 'function',
    name: 'get_order',
    description: 'Read-only one order by number, with line items. No customer phone or name.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        order_number: { type: 'string', description: 'Order number like N000123.' },
      },
      required: ['order_number'],
    },
  },
];

const ALLOWED_TOOLS = new Set(ASSISTANT_TOOLS.map((t) => t.name));

type ToolArgs = Record<string, unknown>;

function strArg(args: ToolArgs, key: string): string {
  const raw = args[key];
  return typeof raw === 'string' ? raw.trim().replace(/[%_]/g, '').slice(0, 80) : '';
}

function jsonResult(value: unknown): string {
  const scrubbed = scrubRecord(value);
  return capText(JSON.stringify(scrubbed), ASSISTANT_TOOL_RESULT_CHARS);
}

function parseArgs(raw: string): ToolArgs | { error: string } {
  if (raw.length > 2000) return { error: 'arguments_too_large' };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'invalid_arguments' };
    return parsed as ToolArgs;
  } catch {
    return { error: 'invalid_json' };
  }
}

async function loadCities(db: SupabaseClient) {
  const { data, error } = await db.from('cities').select('id, name, is_active').order('name');
  if (error) throw new Error(error.message);
  return (data || []).filter((c) => c.is_active !== false);
}

export async function executeAssistantTool(
  db: SupabaseClient,
  name: string,
  rawArgs: string
): Promise<string> {
  if (!ALLOWED_TOOLS.has(name)) {
    return jsonResult({ error: 'unknown_tool', name });
  }
  const args = parseArgs(rawArgs);
  if ('error' in args && Object.keys(args).length === 1) return jsonResult(args);
  try {
    if (name === 'get_stock') return jsonResult(await getStock(db, args));
    if (name === 'search_orders') return jsonResult(await searchOrders(db, args));
    if (name === 'get_order') return jsonResult(await getOrder(db, args));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'db_error';
    return jsonResult({ error: 'database_error', message: capText(message, 200) });
  }
  return jsonResult({ error: 'unknown_tool', name });
}

async function getStock(db: SupabaseClient, args: ToolArgs) {
  const productQuery = strArg(args, 'product_query');
  const cityQuery = strArg(args, 'city_query').toLowerCase();
  const cities = await loadCities(db);
  const cityIds = cityQuery
    ? cities.filter((c) => String(c.name || '').toLowerCase().includes(cityQuery)).map((c) => c.id)
    : cities.map((c) => c.id);
  if (cityQuery && cityIds.length === 0) {
    return { error: 'city_not_found', city_query: cityQuery, hint: 'Уточните город. Доступные города можно запросить с пустым city_query.' };
  }

  let productQ = db
    .from('products')
    .select('id, name, unit, is_active, sort_order')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (productQuery) productQ = productQ.ilike('name', `%${productQuery}%`);
  const { data: products, error: pErr } = await productQ.limit(40);
  if (pErr) throw new Error(pErr.message);
  const list = products || [];
  if (list.length === 0) {
    return { error: 'product_not_found', product_query: productQuery };
  }
  if (productQuery && list.length > ASSISTANT_STOCK_PRODUCT_CAP) {
    return {
      error: 'ambiguous_product',
      matches: list.slice(0, 15).map((p) => p.name),
      hint: 'Уточните название товара.',
    };
  }

  const productIds = list.map((p) => p.id);
  const { data: inv, error: iErr } = await db
    .from('inventory')
    .select('city_id, product_id, qty_on_hand')
    .in('product_id', productIds)
    .in('city_id', cityIds);
  if (iErr) throw new Error(iErr.message);

  const cityName = new Map(cities.map((c) => [c.id, c.name]));
  const items = [];
  let rows = 0;
  for (const p of list) {
    const byCity = (inv || [])
      .filter((r) => r.product_id === p.id)
      .map((r) => ({
        city: cityName.get(r.city_id as string) || '—',
        qty: Number(r.qty_on_hand || 0),
      }))
      .sort((a, b) => a.city.localeCompare(b.city, 'ru'));
    const total = byCity.reduce((s, r) => s + r.qty, 0);
    items.push({ product: p.name, unit: p.unit, total_qty: total, cities: byCity });
    rows += byCity.length;
    if (rows >= ASSISTANT_STOCK_ROW_CAP) break;
  }
  return {
    as_of: new Date().toISOString(),
    truncated: rows >= ASSISTANT_STOCK_ROW_CAP,
    items,
  };
}

async function searchOrders(db: SupabaseClient, args: ToolArgs) {
  const numberRaw = strArg(args, 'order_number');
  const productQuery = strArg(args, 'product_query').toLowerCase();
  const cityQuery = strArg(args, 'city_query').toLowerCase();
  const statusRaw = strArg(args, 'status').toLowerCase();
  const cities = await loadCities(db);
  const cityName = new Map(cities.map((c) => [c.id, c.name]));

  let q = db
    .from('orders')
    .select(
      'order_number, created_at, total_sum, status, payment_type, city_id, is_preorder, preorder_status, is_debt, debt_status, pickup_date, order_items(product_name_snapshot, qty, is_gift)'
    )
    .order('created_at', { ascending: false })
    .limit(80);

  const parsedNumber = parseOrderNumberQuery(numberRaw);
  if (parsedNumber) q = q.eq('order_number', parsedNumber);
  else if (numberRaw) q = q.ilike('order_number', `%${numberRaw}%`);

  if (statusRaw === 'confirmed') q = q.eq('status', 'confirmed');
  else if (statusRaw === 'canceled' || statusRaw === 'cancelled') q = q.in('status', ['canceled', 'cancelled']);

  if (cityQuery) {
    const cityIds = cities.filter((c) => String(c.name || '').toLowerCase().includes(cityQuery)).map((c) => c.id);
    if (cityIds.length === 0) return { error: 'city_not_found', city_query: cityQuery };
    q = q.in('city_id', cityIds);
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  let rows = (data || []).map((row) => ({
    order_number: row.order_number,
    created_at: row.created_at,
    status: row.status,
    payment_type: row.payment_type,
    city: cityName.get(row.city_id as string) || '—',
    total_sum: Number(row.total_sum || 0),
    is_preorder: row.is_preorder,
    preorder_status: row.preorder_status,
    is_debt: row.is_debt,
    debt_status: row.debt_status,
    pickup_date: row.pickup_date,
    items: ((row.order_items as { product_name_snapshot?: string; qty?: number; is_gift?: boolean }[]) || []).map(
      (it) => ({
        product: it.product_name_snapshot,
        qty: Number(it.qty || 0),
        is_gift: !!it.is_gift,
      })
    ),
  }));

  if (productQuery) {
    rows = rows.filter((r) => r.items.some((it) => String(it.product || '').toLowerCase().includes(productQuery)));
  }

  if (parsedNumber && rows.length === 0) return { error: 'order_not_found', order_number: parsedNumber };
  return { as_of: new Date().toISOString(), count: Math.min(rows.length, ASSISTANT_ORDER_CAP), orders: rows.slice(0, ASSISTANT_ORDER_CAP) };
}

async function getOrder(db: SupabaseClient, args: ToolArgs) {
  const parsed = parseOrderNumberQuery(strArg(args, 'order_number'));
  if (!parsed) return { error: 'invalid_order_number' };
  const found = await searchOrders(db, { order_number: parsed, product_query: '', city_query: '', status: '' });
  if ('error' in found) return found;
  if (!found.orders?.length) return { error: 'order_not_found', order_number: parsed };
  return { as_of: found.as_of, order: found.orders[0] };
}
