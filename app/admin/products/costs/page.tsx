'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { PRODUCT_CATALOG_SELECT, type Product } from '@/lib/types';
import { FINANCE_COSTS_RPC } from '@/lib/adminFinance';
import { runExclusive } from '@/lib/exclusiveAsync';
import type { ProductCostRow } from '@/lib/productCost';
import {
  applyCostTsv,
  canSubmitCostChanges,
  classifyLiveChange,
  collectCostChanges,
  costUpdatePayload,
  interpretCostUpdateResult,
  filledMissingCounts,
  filterCostDrafts,
  mergeSaveResultsIntoDrafts,
  parseCostInput,
  seedCostDrafts,
  setDraftInput,
  type CostDraftRow,
  type CostValue,
  type SaveRowResult,
  type TsvIssue,
} from '@/lib/productCostBulk';

const UNIT_LABELS: Record<string, string> = {
  pcs: 'шт',
  g: 'г',
  kg: 'кг',
  ml: 'мл',
  l: 'л',
};

const SAVE_KEY = 'product-costs-save';

function unitLabel(unit: string | null | undefined) {
  if (!unit) return '';
  return UNIT_LABELS[unit] ?? unit;
}

function money(n: number) {
  return `${new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 2 }).format(n)} ₸`;
}

function showCost(value: CostValue, unset: string) {
  return value == null ? unset : money(value);
}

export default function AdminProductCostsPage() {
  const { profile } = useAuth();
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<CostDraftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);
  const [dirtyOnly, setDirtyOnly] = useState(false);
  const [tsvText, setTsvText] = useState('');
  const [tsvIssues, setTsvIssues] = useState<TsvIssue[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<SaveRowResult[] | null>(null);
  const [saveMessage, setSaveMessage] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    const { data: products, error: productErr } = await supabase
      .from('products')
      .select(PRODUCT_CATALOG_SELECT)
      .order('name');
    const { data: costs, error: costErr } = await supabase.rpc(FINANCE_COSTS_RPC);
    if (productErr) {
      setLoadError(productErr.message);
      setLoading(false);
      return;
    }
    if (costErr) {
      setLoadError('productCosts.loadError');
      setLoading(false);
      return;
    }
    const catalog = ((products || []) as Product[]).map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category ?? null,
      unit: p.unit,
      is_active: p.is_active,
    }));
    setDrafts(seedCostDrafts(catalog, (costs || []) as ProductCostRow[]));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { changes, invalid } = useMemo(() => collectCostChanges(drafts), [drafts]);
  const counts = useMemo(() => filledMissingCounts(drafts), [drafts]);
  const visible = useMemo(
    () => filterCostDrafts(drafts, { search, missingOnly, dirtyOnly }),
    [drafts, search, missingOnly, dirtyOnly]
  );
  const canSave = canSubmitCostChanges(changes, invalid.length, tsvIssues.length) && confirmed;
  const isAdmin = profile?.role === 'admin';

  function issueLabel(code: string) {
    const key = `productCosts.issue.${code}`;
    const translated = t(key);
    return translated === key ? code : translated;
  }

  function rowStatus(row: CostDraftRow): { key: string; className: string } {
    if (!row.dirty) return { key: 'productCosts.statusUnchanged', className: 'text-gray-500' };
    const parsed = parseCostInput(row.input);
    if (parsed.kind === 'invalid') return { key: 'productCosts.statusInvalid', className: 'text-red-700' };
    const next = parsed.kind === 'value' ? parsed.value : null;
    const from = row.baseline;
    if (from == null && next == null && parsed.kind !== 'clear' && parsed.kind !== 'empty') {
      return { key: 'productCosts.statusUnchanged', className: 'text-gray-500' };
    }
    if (parsed.kind === 'empty' || parsed.kind === 'clear') {
      if (row.baseline == null) return { key: 'productCosts.statusUnchanged', className: 'text-gray-500' };
      return { key: 'productCosts.statusClear', className: 'text-amber-800' };
    }
    if (parsed.kind === 'value' && row.baseline != null && Number(row.baseline.toFixed(2)) === parsed.value) {
      return { key: 'productCosts.statusUnchanged', className: 'text-gray-500' };
    }
    return { key: 'productCosts.statusSet', className: 'text-green-800' };
  }

  function applyPaste() {
    const result = applyCostTsv(tsvText, drafts);
    setDrafts(result.drafts);
    setTsvIssues(result.issues);
    setShowPreview(false);
    setConfirmed(false);
    setResults(null);
  }

  async function persist() {
    if (!isAdmin) {
      setSaveMessage(t('productCosts.forbidden'));
      return;
    }
    if (!canSave || saving) return;
    await runExclusive(SAVE_KEY, async () => {
      setSaving(true);
      setSaveMessage('');
      const planned = collectCostChanges(drafts);
      if (planned.invalid.length || planned.changes.length === 0) {
        setSaving(false);
        return;
      }
      const { data: liveRows, error: liveErr } = await supabase.rpc(FINANCE_COSTS_RPC);
      if (liveErr) {
        setSaveMessage(t('productCosts.loadError'));
        setSaving(false);
        return;
      }
      const live = new Map(
        ((liveRows || []) as ProductCostRow[]).map((row) => [row.id, row.cost_price] as const)
      );
      const rowResults: SaveRowResult[] = [];
      for (const change of planned.changes) {
        const current = live.has(change.id) ? live.get(change.id) ?? null : null;
        const kind = classifyLiveChange(change, current);
        if (kind === 'already') {
          live.set(change.id, change.to);
          rowResults.push({
            id: change.id,
            name: change.name,
            ok: true,
            code: 'already',
            message: t('productCosts.already'),
          });
          continue;
        }
        if (kind === 'conflict') {
          rowResults.push({
            id: change.id,
            name: change.name,
            ok: false,
            code: 'conflict',
            message: t('productCosts.conflict'),
          });
          continue;
        }
        const payload = costUpdatePayload(change.to);
        const { error, count } = await supabase
          .from('products')
          .update(payload, { count: 'exact' })
          .eq('id', change.id);
        const written = interpretCostUpdateResult(count, error?.message);
        if (!written.ok) {
          const forbidden = /permission|42501|row-level security|only admin/i.test(error?.message || '');
          rowResults.push({
            id: change.id,
            name: change.name,
            ok: false,
            code: forbidden ? 'forbidden' : written.code === 'missing' ? 'conflict' : 'error',
            message: forbidden
              ? t('productCosts.forbidden')
              : written.code === 'missing'
                ? t('productCosts.conflict')
                : error?.message || t('productCosts.conflict'),
          });
        } else {
          live.set(change.id, change.to);
          rowResults.push({
            id: change.id,
            name: change.name,
            ok: true,
            code: 'saved',
            message: t('productCosts.saved'),
          });
        }
      }
      const { data: costsAfter } = await supabase.rpc(FINANCE_COSTS_RPC);
      const afterMap = new Map(
        ((costsAfter || []) as ProductCostRow[]).map((row) => [row.id, row.cost_price] as const)
      );
      const mergedLive = afterMap.size ? afterMap : live;
      setDrafts((prev) => mergeSaveResultsIntoDrafts(prev, mergedLive, rowResults));
      setResults(rowResults);
      const failed = rowResults.filter((r) => !r.ok).length;
      const ok = rowResults.filter((r) => r.ok).length;
      if (failed && ok) setSaveMessage(t('productCosts.partial'));
      else if (failed && !ok) setSaveMessage(t('productCosts.partial'));
      else setSaveMessage(t('productCosts.allOk'));
      if (!failed) {
        setShowPreview(false);
        setConfirmed(false);
        setTsvIssues([]);
      }
      setSaving(false);
    });
  }

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-white">
        <NavAdmin />
        <div className="p-4">
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <h1 className="text-2xl font-bold text-gray-900">{t('productCosts.title')}</h1>
            <Link href="/admin/products" className="text-sm text-blue-800">
              {t('productCosts.back')}
            </Link>
          </div>

          {!isAdmin && profile ? <p className="text-red-700 mb-3">{t('productCosts.forbidden')}</p> : null}

          <p className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3">
            {t('productCosts.warnEstimate')}
          </p>
          <p className="text-sm text-gray-700 bg-gray-100 rounded-lg p-3 mb-4">{t('productCosts.notAtomic')}</p>

          <div className="flex flex-wrap gap-2 mb-3 items-center">
            <input
              type="text"
              placeholder={t('productCosts.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-lg flex-1 min-w-[200px] bg-white text-gray-900"
            />
            <label className="flex items-center gap-2 text-gray-900 whitespace-nowrap">
              <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />
              {t('productCosts.filterMissing')}
            </label>
            <label className="flex items-center gap-2 text-gray-900 whitespace-nowrap">
              <input type="checkbox" checked={dirtyOnly} onChange={(e) => setDirtyOnly(e.target.checked)} />
              {t('productCosts.filterDirty')}
            </label>
            <button
              type="button"
              onClick={() => void load()}
              className="px-3 py-2 rounded-lg bg-gray-200 text-gray-900"
            >
              {t('productCosts.reload')}
            </button>
          </div>

          <p className="text-sm text-gray-700 mb-3">
            {t('productCosts.filled')}: {counts.filled} · {t('productCosts.missing')}: {counts.missing}
          </p>

          <div className="bg-gray-100 rounded-lg p-4 mb-4">
            <h2 className="font-bold mb-2 text-gray-900">{t('productCosts.pasteTitle')}</h2>
            <p className="text-sm text-gray-700 mb-2">{t('productCosts.pasteHint')}</p>
            <textarea
              value={tsvText}
              onChange={(e) => setTsvText(e.target.value)}
              rows={5}
              className="w-full px-3 py-2 border border-gray-300 rounded bg-white text-gray-900 font-mono text-sm"
            />
            <button
              type="button"
              onClick={applyPaste}
              className="mt-2 px-4 py-2 bg-blue-600 text-white rounded-lg"
            >
              {t('productCosts.pasteApply')}
            </button>
            {tsvIssues.length > 0 ? (
              <ul className="mt-2 text-sm text-red-700 list-disc pl-5">
                {tsvIssues.map((issue) => (
                  <li key={`${issue.line}-${issue.code}-${issue.name}`}>
                    {issue.line}: {issue.name || '—'} — {issueLabel(issue.code)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {loadError ? (
            <p className="text-red-700 mb-3">{loadError === 'productCosts.loadError' ? t('productCosts.loadError') : loadError}</p>
          ) : null}
          {loading ? (
            <p className="text-gray-900">{t('admin.activityLoading')}</p>
          ) : (
            <div className="overflow-x-auto border border-gray-200 rounded-lg mb-4">
              <table className="min-w-full text-sm text-gray-900">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="text-left p-2">{t('productCosts.colName')}</th>
                    <th className="text-left p-2">{t('productCosts.colCategory')}</th>
                    <th className="text-left p-2">{t('productCosts.colUnit')}</th>
                    <th className="text-left p-2">{t('productCosts.colCurrent')}</th>
                    <th className="text-left p-2">{t('productCosts.colNew')}</th>
                    <th className="text-left p-2">{t('productCosts.colStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => {
                    const status = rowStatus(row);
                    return (
                      <tr key={row.id} className="border-t border-gray-100">
                        <td className="p-2 font-medium">
                          {row.name}
                          {!row.is_active ? <span className="ml-1 text-gray-500">(архив)</span> : null}
                        </td>
                        <td className="p-2">{row.category || '—'}</td>
                        <td className="p-2">{unitLabel(row.unit)}</td>
                        <td className="p-2">{showCost(row.baseline, t('productCosts.unset'))}</td>
                        <td className="p-2">
                          <input
                            inputMode="decimal"
                            value={row.input}
                            onChange={(e) => {
                              const value = e.target.value;
                              setDrafts((prev) => prev.map((item) => (item.id === row.id ? setDraftInput(item, value) : item)));
                              setConfirmed(false);
                              setResults(null);
                            }}
                            placeholder={t('productCosts.unset')}
                            className="w-28 px-2 py-1 border border-gray-300 rounded bg-white"
                          />
                        </td>
                        <td className={`p-2 ${status.className}`}>{t(status.key)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap gap-2 items-center mb-3">
            <button
              type="button"
              onClick={() => {
                setShowPreview(true);
                setConfirmed(false);
              }}
              className="px-4 py-2 bg-gray-800 text-white rounded-lg"
            >
              {t('productCosts.preview')}
            </button>
            <span className="text-sm text-gray-700">
              {t('productCosts.changes')}: {changes.length} · {t('productCosts.errors')}: {invalid.length + tsvIssues.length}
            </span>
          </div>

          {showPreview ? (
            <div className="border border-gray-300 rounded-lg p-4 mb-4">
              <h2 className="font-bold mb-2 text-gray-900">{t('productCosts.previewTitle')}</h2>
              {changes.length === 0 ? (
                <p className="text-sm text-gray-700">{t('productCosts.noChanges')}</p>
              ) : (
                <div className="overflow-x-auto mb-3">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-600">
                        <th className="p-1">{t('productCosts.colName')}</th>
                        <th className="p-1">{t('productCosts.was')}</th>
                        <th className="p-1">{t('productCosts.will')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changes.map((change) => (
                        <tr key={change.id} className="border-t border-gray-100">
                          <td className="p-1">{change.name}</td>
                          <td className="p-1">{showCost(change.from, t('productCosts.unset'))}</td>
                          <td className="p-1">{showCost(change.to, t('productCosts.unset'))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {invalid.length > 0 ? (
                <ul className="text-sm text-red-700 list-disc pl-5 mb-2">
                  {invalid.map((row) => (
                    <li key={row.id}>
                      {row.name}: {issueLabel(row.code)}
                    </li>
                  ))}
                </ul>
              ) : null}
              <label className="flex items-start gap-2 text-sm text-gray-900 mb-3">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-1"
                />
                {t('productCosts.confirm')}
              </label>
              <button
                type="button"
                disabled={!canSave || saving || !isAdmin}
                onClick={() => void persist()}
                className="px-4 py-2 bg-green-600 text-white rounded-lg disabled:opacity-50"
              >
                {t('productCosts.save')}
              </button>
            </div>
          ) : null}

          {saveMessage ? <p className="text-sm font-medium text-gray-900 mb-2">{saveMessage}</p> : null}
          {results ? (
            <ul className="text-sm mb-8">
              {results.map((row) => (
                <li key={row.id} className={row.ok ? 'text-green-800' : 'text-red-700'}>
                  {row.name}: {row.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </Protected>
  );
}
