export type CatalogProductRow = {
  id: string;
  name: string;
  category: string | null;
  unit: string;
  is_active: boolean;
};

export type CostValue = number | null;

export type ParsedCostInput =
  | { kind: 'empty' }
  | { kind: 'clear' }
  | { kind: 'value'; value: number }
  | { kind: 'invalid'; code: string };

export type CostDraftRow = CatalogProductRow & {
  baseline: CostValue;
  input: string;
  dirty: boolean;
};

export type CostChange = {
  id: string;
  name: string;
  from: CostValue;
  to: CostValue;
};

export type TsvIssue = {
  line: number;
  name: string;
  code: string;
};

export type TsvApplyResult = {
  drafts: CostDraftRow[];
  applied: number;
  issues: TsvIssue[];
};

export type SaveRowResult = {
  id: string;
  name: string;
  ok: boolean;
  code: 'saved' | 'already' | 'conflict' | 'forbidden' | 'error';
  message: string;
};

const CLEAR_TOKENS = new Set(['clear', 'null', 'очистить', 'тазалау', 'жою']);

export function costsEqual(a: CostValue, b: CostValue): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Number(a.toFixed(2)) === Number(b.toFixed(2));
}

export function formatCostDisplay(value: CostValue): string {
  if (value == null) return 'Не указана';
  return `${new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 2 }).format(value)} ₸`;
}

export function parseCostInput(raw: string): ParsedCostInput {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { kind: 'empty' };
  if (CLEAR_TOKENS.has(trimmed.toLowerCase())) return { kind: 'clear' };
  const normalized = trimmed.replace(/\s+/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return { kind: 'invalid', code: 'not_number' };
  const n = Number(normalized);
  if (!Number.isFinite(n)) return { kind: 'invalid', code: 'not_finite' };
  if (n < 0) return { kind: 'invalid', code: 'negative' };
  return { kind: 'value', value: Number(n.toFixed(2)) };
}

export function intendedCost(row: CostDraftRow): CostValue | undefined {
  if (!row.dirty) return undefined;
  const parsed = parseCostInput(row.input);
  if (parsed.kind === 'empty' || parsed.kind === 'clear') return null;
  if (parsed.kind === 'value') return parsed.value;
  return undefined;
}

export function rowInputError(row: CostDraftRow): string | null {
  if (!row.dirty) return null;
  const parsed = parseCostInput(row.input);
  if (parsed.kind === 'invalid') return parsed.code;
  return null;
}

export function seedCostDrafts(
  products: CatalogProductRow[],
  costs: Array<{ id: string; cost_price: number | null }>
): CostDraftRow[] {
  const map = new Map(costs.map((c) => [c.id, c.cost_price]));
  return products.map((p) => {
    const baseline = map.has(p.id) ? map.get(p.id) ?? null : null;
    return {
      ...p,
      baseline,
      input: baseline == null ? '' : String(baseline),
      dirty: false,
    };
  });
}

export function setDraftInput(row: CostDraftRow, input: string): CostDraftRow {
  return { ...row, input, dirty: true };
}

export function collectCostChanges(drafts: CostDraftRow[]): {
  changes: CostChange[];
  invalid: Array<{ id: string; name: string; code: string }>;
} {
  const changes: CostChange[] = [];
  const invalid: Array<{ id: string; name: string; code: string }> = [];
  for (const row of drafts) {
    if (!row.dirty) continue;
    const parsed = parseCostInput(row.input);
    if (parsed.kind === 'invalid') {
      invalid.push({ id: row.id, name: row.name, code: parsed.code });
      continue;
    }
    const next: CostValue = parsed.kind === 'value' ? parsed.value : null;
    if (costsEqual(row.baseline, next)) continue;
    changes.push({ id: row.id, name: row.name, from: row.baseline, to: next });
  }
  return { changes, invalid };
}

export function canSubmitCostChanges(changes: CostChange[], invalidCount: number, tsvIssues = 0): boolean {
  return changes.length > 0 && invalidCount === 0 && tsvIssues === 0;
}

export function parseCostTsvLines(text: string): Array<{ line: number; name: string; raw: string; hasTab: boolean }> {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((content, idx) => ({ line: idx + 1, content }))
    .filter((row) => row.content.trim().length > 0)
    .map((row) => {
      const tab = row.content.indexOf('\t');
      if (tab < 0) {
        return { line: row.line, name: row.content.trim(), raw: '', hasTab: false };
      }
      return {
        line: row.line,
        name: row.content.slice(0, tab).trim(),
        raw: row.content.slice(tab + 1).trim(),
        hasTab: true,
      };
    });
}

export function matchProductsByExactName(
  name: string,
  products: CatalogProductRow[]
): { kind: 'one'; product: CatalogProductRow } | { kind: 'none' } | { kind: 'ambiguous'; products: CatalogProductRow[] } {
  const hits = products.filter((p) => p.name === name);
  if (hits.length === 1) return { kind: 'one', product: hits[0] };
  if (hits.length > 1) return { kind: 'ambiguous', products: hits };
  return { kind: 'none' };
}

export function applyCostTsv(text: string, drafts: CostDraftRow[]): TsvApplyResult {
  const catalog = drafts.map((d) => ({
    id: d.id,
    name: d.name,
    category: d.category,
    unit: d.unit,
    is_active: d.is_active,
  }));
  const next = drafts.map((d) => ({ ...d }));
  const byId = new Map(next.map((d) => [d.id, d]));
  const issues: TsvIssue[] = [];
  let applied = 0;
  const pending = new Map<string, { name: string; raw: string; line: number }>();

  for (const row of parseCostTsvLines(text)) {
    if (!row.name) {
      issues.push({ line: row.line, name: '', code: 'missing_name' });
      continue;
    }
    if (!row.hasTab) {
      issues.push({ line: row.line, name: row.name, code: 'missing_tab' });
      continue;
    }
    const parsed = parseCostInput(row.raw);
    if (parsed.kind === 'empty') {
      issues.push({ line: row.line, name: row.name, code: 'empty_cost' });
      continue;
    }
    if (parsed.kind === 'invalid') {
      issues.push({ line: row.line, name: row.name, code: parsed.code });
      continue;
    }
    const matched = matchProductsByExactName(row.name, catalog);
    if (matched.kind === 'none') {
      issues.push({ line: row.line, name: row.name, code: 'unknown_name' });
      continue;
    }
    if (matched.kind === 'ambiguous') {
      issues.push({ line: row.line, name: row.name, code: 'duplicate_name' });
      continue;
    }
    const prev = pending.get(matched.product.id);
    if (prev && prev.raw !== row.raw) {
      issues.push({ line: prev.line, name: row.name, code: 'tsv_conflict' });
      issues.push({ line: row.line, name: row.name, code: 'tsv_conflict' });
      continue;
    }
    pending.set(matched.product.id, { name: row.name, raw: row.raw, line: row.line });
  }

  const badNames = new Set(issues.filter((i) => i.code === 'tsv_conflict').map((i) => i.name));
  for (const [id, row] of pending) {
    if (badNames.has(row.name)) continue;
    const draft = byId.get(id);
    if (!draft) continue;
    const parsed = parseCostInput(row.raw);
    if (parsed.kind === 'clear') {
      draft.input = '';
      draft.dirty = true;
      applied += 1;
    } else if (parsed.kind === 'value') {
      draft.input = String(parsed.value);
      draft.dirty = true;
      applied += 1;
    }
  }

  return { drafts: next, applied, issues };
}

export function classifyLiveChange(
  change: CostChange,
  live: CostValue
): 'write' | 'already' | 'conflict' {
  if (costsEqual(live, change.to)) return 'already';
  if (!costsEqual(live, change.from)) return 'conflict';
  return 'write';
}

export function detectCostConflicts(
  changes: CostChange[],
  live: Map<string, CostValue>
): CostChange[] {
  return changes.filter((change) => {
    const actual = live.has(change.id) ? live.get(change.id) ?? null : null;
    return classifyLiveChange(change, actual) === 'conflict';
  });
}

export function costUpdatePayload(next: CostValue): { cost_price: CostValue } {
  return { cost_price: next };
}

export function interpretCostUpdateResult(count: number | null | undefined, errorMessage?: string | null): {
  ok: boolean;
  code: 'saved' | 'missing' | 'error';
} {
  if (errorMessage) return { ok: false, code: 'error' };
  if (count === 0) return { ok: false, code: 'missing' };
  return { ok: true, code: 'saved' };
}

export function mergeSaveResultsIntoDrafts(
  drafts: CostDraftRow[],
  live: Map<string, CostValue>,
  results: SaveRowResult[]
): CostDraftRow[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  return drafts.map((row) => {
    const liveVal = live.has(row.id) ? live.get(row.id) ?? null : row.baseline;
    const result = byId.get(row.id);
    if (result?.ok) {
      return {
        ...row,
        baseline: liveVal,
        input: liveVal == null ? '' : String(liveVal),
        dirty: false,
      };
    }
    if (result && !result.ok) {
      return { ...row, baseline: liveVal, dirty: true };
    }
    return { ...row, baseline: liveVal };
  });
}

export function filledMissingCounts(drafts: CostDraftRow[]): { filled: number; missing: number } {
  let filled = 0;
  let missing = 0;
  for (const row of drafts) {
    if (row.baseline == null) missing += 1;
    else filled += 1;
  }
  return { filled, missing };
}

export function filterCostDrafts(
  drafts: CostDraftRow[],
  opts: { search: string; missingOnly: boolean; dirtyOnly: boolean }
): CostDraftRow[] {
  const q = opts.search.trim().toLowerCase();
  return drafts.filter((row) => {
    if (opts.missingOnly && row.baseline != null) return false;
    if (opts.dirtyOnly && !row.dirty) return false;
    if (!q) return true;
    return (
      row.name.toLowerCase().includes(q) ||
      String(row.category || '')
        .toLowerCase()
        .includes(q)
    );
  });
}
