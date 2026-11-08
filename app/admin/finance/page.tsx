'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import { useTranslation } from '@/lib/i18n';
import { supabase } from '@/lib/supabaseClient';
import { getTodayLocalISO } from '@/lib/datetime';
import { fetchRecognizedWindow } from '@/lib/fetchAdminStatsOrders';
import { newClientOperationId, runExclusive } from '@/lib/exclusiveAsync';
import {
  buildAdminFinance,
  FINANCE_CARGO_CUSTOMS_CATEGORY,
  FINANCE_COSTS_RPC,
  FINANCE_EXPENSE_CATEGORIES,
  FINANCE_EXPENSE_CREATE_RPC,
  FINANCE_EXPENSE_DELETE_RPC,
  FINANCE_EXPENSE_EVENTS_RPC,
  FINANCE_EXPENSE_UPDATE_RPC,
  FINANCE_EXPENSES_LIST_RPC,
  financeRpcErrorKind,
  parseFinanceExpenseEvents,
  parseFinanceExpensesList,
  type AdminFinanceReport,
  type FinanceExpenseEventRow,
  type FinanceExpenseRow,
  type FinanceOrder,
} from '@/lib/adminFinance';
import {
  buildFinanceDaily,
  expensesForCityView,
  financeCogsKpi,
  financeGrossKpi,
  financeMarginKpi,
  financeNetKpi,
  ordersForCityView,
  resolveFinanceRange,
  type FinanceKpi,
  type FinancePeriodMode,
} from '@/lib/adminFinanceView';
import type { ProductCostRow } from '@/lib/productCost';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

function formatMoney(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

function rpcMessage(error: { message?: string } | null | undefined): string {
  return error?.message || '';
}

function financeErrorCopy(message: string, t: (key: string) => string): string {
  const kind = financeRpcErrorKind(message);
  if (kind === 'permission') return t('finance.permissionDenied');
  if (kind === 'network') return t('finance.networkError');
  if (kind === 'conflict') return t('finance.idempotencyConflict');
  return message || t('finance.saveError');
}

function KpiCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone: 'blue' | 'green' | 'indigo' | 'amber' | 'rose' | 'slate';
}) {
  const tones = {
    blue: 'bg-blue-50 text-blue-700',
    green: 'bg-emerald-50 text-emerald-700',
    indigo: 'bg-indigo-50 text-indigo-700',
    amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700',
    slate: 'bg-slate-100 text-slate-600',
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <span className={`inline-flex h-2.5 w-2.5 rounded-full ${tones[tone]}`} />
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function FinanceSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl border border-slate-200 bg-white shadow-sm" />
        ))}
      </div>
      <div className="h-56 animate-pulse rounded-2xl border border-slate-200 bg-white shadow-sm" />
      <div className="h-64 animate-pulse rounded-2xl border border-slate-200 bg-white shadow-sm" />
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

type ExpenseForm = {
  date: string;
  category: string;
  amount: string;
  cityId: string;
  comment: string;
};

const emptyForm = (today: string): ExpenseForm => ({
  date: today,
  category: 'other',
  amount: '',
  cityId: '',
  comment: '',
});

export default function AdminFinancePage() {
  const { t } = useTranslation();
  const today = getTodayLocalISO('Asia/Almaty');
  const [mode, setMode] = useState<FinancePeriodMode>('month');
  const [year, setYear] = useState(() => Number(today.slice(0, 4)));
  const [month, setMonth] = useState(() => Number(today.slice(5, 7)));
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  const [cityId, setCityId] = useState<string | 'all'>('all');
  const [cities, setCities] = useState<{ id: string; name: string }[]>([]);
  const [orders, setOrders] = useState<FinanceOrder[]>([]);
  const [costs, setCosts] = useState<ProductCostRow[] | null>(null);
  const [costError, setCostError] = useState<string | null>(null);
  const [expenses, setExpenses] = useState<FinanceExpenseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [expensesComplete, setExpensesComplete] = useState(false);
  const [form, setForm] = useState<ExpenseForm>(() => emptyForm(today));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<FinanceExpenseEventRow[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const operationIdRef = useRef(newClientOperationId());
  const years = useMemo(() => {
    const y = Number(today.slice(0, 4));
    return [y - 2, y - 1, y, y + 1];
  }, [today]);

  const spec = useMemo(
    () => resolveFinanceRange({ mode, year, month, customFrom, customTo }),
    [mode, year, month, customFrom, customTo]
  );

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') setRefreshKey((k) => k + 1);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    supabase
      .from('cities')
      .select('id, name')
      .order('name')
      .then(({ data, error: cityError }) => {
        if (!cityError) setCities(data || []);
      });
  }, []);

  const periodKey = spec ? `${spec.fromYmd}:${spec.toYmd}` : 'invalid';

  useEffect(() => {
    setExpensesComplete(false);
  }, [periodKey]);

  useEffect(() => {
    if (!editingId) operationIdRef.current = newClientOperationId();
  }, [form.date, form.category, form.amount, form.cityId, form.comment, editingId]);

  useEffect(() => {
    if (!spec) {
      setLoading(false);
      setError('invalid-range');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [rev, costRes, expRes] = await Promise.all([
          fetchRecognizedWindow(spec.range),
          supabase.rpc(FINANCE_COSTS_RPC),
          supabase.rpc(FINANCE_EXPENSES_LIST_RPC, {
            p_from: spec.fromYmd,
            p_to: spec.toYmd,
            p_include_deleted: false,
          }),
        ]);
        if (cancelled) return;
        if (rev.error) {
          setError(rev.error);
          setLoading(false);
          return;
        }
        if (expRes.error) {
          setError(rpcMessage(expRes.error));
          setLoading(false);
          return;
        }
        setTruncated(rev.truncated);
        setOrders(rev.orders as FinanceOrder[]);
        if (costRes.error) {
          setCosts(null);
          setCostError(rpcMessage(costRes.error));
        } else {
          setCosts((costRes.data || []) as ProductCostRow[]);
          setCostError(null);
        }
        setExpenses(parseFinanceExpensesList(expRes.data));
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'network');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [periodKey, refreshKey, spec]);

  const cityNames = useMemo(() => new Map(cities.map((c) => [c.id, c.name])), [cities]);

  const report: AdminFinanceReport | null = useMemo(() => {
    if (!spec) return null;
    const { pnlExpenses } = expensesForCityView(expenses, cityId);
    return buildAdminFinance({
      orders: ordersForCityView(orders, cityId),
      range: spec.range,
      fromYmd: spec.fromYmd,
      toYmd: spec.toYmd,
      costs: costs || [],
      expenses: pnlExpenses,
      cityNames,
      expensesInputComplete: expensesComplete,
    });
  }, [spec, orders, expenses, costs, cityId, cityNames, expensesComplete]);

  const companyExpenses = useMemo(() => expensesForCityView(expenses, cityId).companyExpenses, [expenses, cityId]);
  const daily = useMemo(() => {
    if (!spec || !report) return [];
    return buildFinanceDaily({
      orders: ordersForCityView(orders, cityId),
      expenses: expensesForCityView(expenses, cityId).pnlExpenses,
      fromYmd: spec.fromYmd,
      toYmd: spec.toYmd,
      range: spec.range,
    });
  }, [spec, report, orders, expenses, cityId]);

  const journal = useMemo(() => {
    const live = expenses.filter((e) => !e.deleted_at);
    if (cityId === 'all') return live;
    return live.filter((e) => e.city_id === cityId || !e.city_id);
  }, [expenses, cityId]);

  function kpiText(kpi: FinanceKpi, asPercent = false): string {
    if (kpi.kind === 'unavailable' || kpi.amount == null) return t('finance.unavailable');
    if (asPercent) return `${kpi.amount.toFixed(1)}%`;
    return `${formatMoney(kpi.amount)} ₸`;
  }

  function kpiHint(kpi: FinanceKpi, extra?: string): string | undefined {
    const tag =
      kpi.kind === 'preliminary' ? t('finance.preliminary') : kpi.kind === 'estimate' ? t('finance.estimate') : '';
    return [tag, extra].filter(Boolean).join(' · ') || undefined;
  }

  function cityName(id: string | null | undefined): string {
    if (!id) return t('finance.companyCity');
    return cityNames.get(id) || id;
  }

  function catLabel(code: string): string {
    return t(`finance.cat.${code}` as 'finance.cat.other');
  }

  function resetForm() {
    setEditingId(null);
    setForm(emptyForm(today));
    setFormError(null);
    operationIdRef.current = newClientOperationId();
  }

  async function submitExpense() {
    if (saving) return;
    const amount = Number(form.amount.replace(',', '.'));
    if (!form.date || !form.category || !Number.isFinite(amount) || amount <= 0) {
      setFormError(t('finance.saveError'));
      return;
    }
    const payload = {
      p_expense_date: form.date,
      p_category: form.category,
      p_amount: amount,
      p_city_id: form.cityId ? form.cityId : null,
      p_comment: form.comment.trim() ? form.comment.trim() : null,
    };
    const op = operationIdRef.current;
    const key = editingId ? `finance-update:${editingId}` : `finance-create:${op}`;
    setSaving(true);
    setFormError(null);
    try {
      await runExclusive(key, async () => {
        const { error: saveErr } = editingId
          ? await supabase.rpc(FINANCE_EXPENSE_UPDATE_RPC, { p_id: editingId, ...payload })
          : await supabase.rpc(FINANCE_EXPENSE_CREATE_RPC, { p_operation_id: op, ...payload });
        if (saveErr) {
          const raw = rpcMessage(saveErr);
          if (financeRpcErrorKind(raw) === 'conflict') {
            operationIdRef.current = newClientOperationId();
          }
          setFormError(financeErrorCopy(raw, t));
          return;
        }
        resetForm();
        setRefreshKey((k) => k + 1);
      });
    } catch (err) {
      setFormError(financeErrorCopy(err instanceof Error ? err.message : '', t));
    } finally {
      setSaving(false);
    }
  }

  async function removeExpense(id: string) {
    if (saving) return;
    if (!window.confirm(t('finance.deleteConfirm'))) return;
    setSaving(true);
    try {
      await runExclusive(`finance-delete:${id}`, async () => {
        const { error: delErr } = await supabase.rpc(FINANCE_EXPENSE_DELETE_RPC, { p_id: id });
        if (delErr) setFormError(financeErrorCopy(rpcMessage(delErr), t));
        else {
          if (editingId === id) resetForm();
          setRefreshKey((k) => k + 1);
        }
      });
    } catch (err) {
      setFormError(financeErrorCopy(err instanceof Error ? err.message : '', t));
    } finally {
      setSaving(false);
    }
  }

  async function openHistory(id: string) {
    setHistoryId(id);
    setHistoryRows(null);
    setHistoryError(null);
    const { data, error: evErr } = await supabase.rpc(FINANCE_EXPENSE_EVENTS_RPC, { p_expense_id: id });
    if (evErr) setHistoryError(financeErrorCopy(rpcMessage(evErr), t));
    else setHistoryRows(parseFinanceExpenseEvents(data));
  }

  function startEdit(row: FinanceExpenseRow) {
    if (!row.id) return;
    setEditingId(row.id);
    setForm({
      date: String(row.expense_date || '').slice(0, 10),
      category: String(row.category || 'other'),
      amount: String(row.amount ?? ''),
      cityId: row.city_id ? String(row.city_id) : '',
      comment: row.comment ? String(row.comment) : '',
    });
    setFormError(null);
  }

  const cogsKpi = report ? financeCogsKpi(report) : null;
  const grossKpi = report ? financeGrossKpi(report) : null;
  const netKpi = report ? financeNetKpi(report) : null;
  const marginKpi = report ? financeMarginKpi(report) : null;

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-slate-50">
        <NavAdmin />
        <div className="mx-auto max-w-6xl p-4 pb-10">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{t('finance.title')}</h1>
            <p className="mt-1 text-sm text-slate-500">{t('finance.subtitle')}</p>
          </div>

          <div className="mb-4 flex flex-wrap gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <label className="text-sm text-slate-600">
              {t('finance.year')}
              <select
                className="ml-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5"
                value={year}
                disabled={mode === 'custom'}
                onChange={(e) => {
                  setMode('month');
                  setYear(Number(e.target.value));
                }}
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-slate-600">
              {t('finance.month')}
              <select
                className="ml-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5"
                value={month}
                disabled={mode === 'custom'}
                onChange={(e) => {
                  setMode('month');
                  setMonth(Number(e.target.value));
                }}
              >
                {MONTHS.map((m) => (
                  <option key={m} value={m}>
                    {padMonth(m)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={mode === 'custom'}
                onChange={(e) => setMode(e.target.checked ? 'custom' : 'month')}
              />
              {t('finance.customPeriod')}
            </label>
            {mode === 'custom' ? (
              <>
                <label className="text-sm text-slate-600">
                  {t('admin.fromDate')}
                  <input
                    type="date"
                    className="ml-2 rounded-lg border border-slate-200 px-2 py-1.5"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                  />
                </label>
                <label className="text-sm text-slate-600">
                  {t('admin.toDate')}
                  <input
                    type="date"
                    className="ml-2 rounded-lg border border-slate-200 px-2 py-1.5"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                  />
                </label>
              </>
            ) : null}
            <label className="text-sm text-slate-600">
              {t('common.city')}
              <select
                className="ml-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5"
                value={cityId}
                onChange={(e) => setCityId(e.target.value === 'all' ? 'all' : e.target.value)}
              >
                <option value="all">{t('admin.allCities')}</option>
                {cities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {loading ? (
            <FinanceSkeleton />
          ) : error ? (
            <div className="rounded-2xl border border-red-200 bg-white p-4 text-sm text-red-700 shadow-sm">
              {error === 'invalid-range'
                ? t('admin.dateRangeInvalid')
                : `${t('finance.loadError')}: ${financeErrorCopy(error, t)}`}
            </div>
          ) : report && cogsKpi && grossKpi && netKpi && marginKpi ? (
            <div className="space-y-4">
              {truncated ? (
                <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  {t('finance.truncated')}
                </p>
              ) : null}
              {costError ? (
                <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  {financeRpcErrorKind(costError) === 'permission'
                    ? t('finance.permissionDenied')
                    : t('finance.costError')}
                </p>
              ) : null}
              {!report.cogsComplete ? (
                <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  {t('finance.cogsMissing')} {t('finance.cogsKnown')}: {formatMoney(report.cogsKnown)} ₸ ·{' '}
                  {t('finance.missingProducts')}: {report.missingCostProductCount}
                </p>
              ) : null}
              {report.cogsComplete && !report.expensesComplete ? (
                <p className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                  {t('finance.expensesIncomplete')}
                </p>
              ) : null}

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                <KpiCard label={t('finance.revenue')} value={`${formatMoney(report.revenue)} ₸`} tone="blue" />
                <KpiCard
                  label={t('finance.cogs')}
                  value={kpiText(cogsKpi)}
                  hint={kpiHint(cogsKpi, t('finance.cogsHint'))}
                  tone="amber"
                />
                <KpiCard
                  label={t('finance.gross')}
                  value={kpiText(grossKpi)}
                  hint={kpiHint(grossKpi)}
                  tone={grossKpi.kind === 'unavailable' ? 'slate' : 'green'}
                />
                <KpiCard
                  label={t('finance.opex')}
                  value={`${formatMoney(report.operatingExpenses)} ₸`}
                  hint={t('finance.estimate')}
                  tone="indigo"
                />
                <KpiCard
                  label={t('finance.net')}
                  value={kpiText(netKpi)}
                  hint={kpiHint(netKpi)}
                  tone={netKpi.kind === 'preliminary' ? 'amber' : netKpi.kind === 'unavailable' ? 'slate' : 'green'}
                />
                <KpiCard
                  label={t('finance.margin')}
                  value={kpiText(marginKpi, true)}
                  hint={kpiHint(marginKpi)}
                  tone="rose"
                />
              </div>

              <label className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={expensesComplete}
                  onChange={(e) => setExpensesComplete(e.target.checked)}
                />
                <span>
                  <span className="font-medium">{t('finance.expensesCompleteLabel')}</span>
                  <span className="mt-1 block text-xs text-slate-500">{t('finance.expensesCompleteHint')}</span>
                </span>
              </label>

              <Section title={t('finance.daily')}>
                {daily.every((d) => d.revenue === 0 && d.operatingExpenses === 0) ? (
                  <p className="py-8 text-center text-sm text-slate-500">{t('finance.empty')}</p>
                ) : (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={daily} margin={{ left: 8, right: 8, top: 8, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#64748b' }} />
                        <YAxis tick={{ fontSize: 10, fill: '#64748b' }} />
                        <Tooltip
                          formatter={(value, name) => [
                            `${formatMoney(Number(value ?? 0))} ₸`,
                            name === 'revenue' ? t('finance.revenue') : t('finance.opex'),
                          ]}
                        />
                        <Line type="monotone" dataKey="revenue" stroke="#2563eb" strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="operatingExpenses" stroke="#7c3aed" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Section>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Section title={t('finance.categories')}>
                  {report.expensesByCategory.length === 0 ? (
                    <p className="text-sm text-slate-500">{t('finance.emptyExpenses')}</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[320px] text-left text-sm">
                        <thead className="text-xs text-slate-500">
                          <tr>
                            <th className="pb-2 font-medium">{t('finance.category')}</th>
                            <th className="pb-2 text-right font-medium">{t('common.amount')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {report.expensesByCategory.map((row) => (
                            <tr key={row.category}>
                              <td className="py-2">{catLabel(row.category)}</td>
                              <td className="py-2 text-right tabular-nums">{formatMoney(row.amount)} ₸</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Section>

                <Section title={t('finance.cargoTitle')} hint={t('finance.cargoHint')}>
                  <p className="text-2xl font-semibold tabular-nums text-slate-900">
                    {formatMoney(report.cargoCustomsExpenses)} ₸
                  </p>
                </Section>
              </div>

              <Section title={t('finance.companyTitle')} hint={t('finance.companyHint')}>
                {companyExpenses.filter((row) => row.category !== FINANCE_CARGO_CUSTOMS_CATEGORY).length === 0 ? (
                  <p className="text-sm text-slate-500">{t('finance.emptyExpenses')}</p>
                ) : (
                  <ul className="divide-y divide-slate-100 text-sm">
                    {companyExpenses
                      .filter((row) => row.category !== FINANCE_CARGO_CUSTOMS_CATEGORY)
                      .map((row) => (
                      <li key={String(row.id)} className="flex justify-between gap-3 py-2">
                        <span className="truncate text-slate-700">
                          {String(row.expense_date).slice(0, 10)} · {catLabel(String(row.category))}
                          {row.comment ? ` · ${row.comment}` : ''}
                        </span>
                        <span className="shrink-0 tabular-nums">{formatMoney(Number(row.amount))} ₸</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title={t('finance.byCity')}>
                {report.cityRows.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('finance.empty')}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] text-left text-sm">
                      <thead className="text-xs text-slate-500">
                        <tr>
                          <th className="pb-2 font-medium">{t('common.city')}</th>
                          <th className="pb-2 text-right font-medium">{t('finance.revenue')}</th>
                          <th className="pb-2 text-right font-medium">{t('finance.cityProfit')}</th>
                          <th className="pb-2 text-right font-medium">{t('finance.cityOpex')}</th>
                          <th className="pb-2 text-right font-medium">{t('finance.cityNet')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {report.cityRows.map((row) => (
                          <tr key={row.cityId}>
                            <td className="py-2">{row.cityName}</td>
                            <td className="py-2 text-right tabular-nums">{formatMoney(row.revenue)} ₸</td>
                            <td className="py-2 text-right tabular-nums">
                              {row.estimatedGrossProfit == null
                                ? t('finance.unavailable')
                                : `${formatMoney(row.estimatedGrossProfit)} ₸`}
                            </td>
                            <td className="py-2 text-right tabular-nums">{formatMoney(row.cityOperatingExpenses)} ₸</td>
                            <td className="py-2 text-right tabular-nums">
                              {row.estimatedNetProfit == null
                                ? t('finance.unavailable')
                                : `${formatMoney(row.estimatedNetProfit)} ₸`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>

              <Section title={t('finance.byProduct')}>
                {report.productRows.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('finance.empty')}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] text-left text-sm">
                      <thead className="text-xs text-slate-500">
                        <tr>
                          <th className="pb-2 font-medium">{t('common.product')}</th>
                          <th className="pb-2 text-right font-medium">{t('finance.qtySold')}</th>
                          <th className="pb-2 text-right font-medium">{t('finance.qtyGift')}</th>
                          <th className="pb-2 text-right font-medium">{t('finance.revenue')}</th>
                          <th className="pb-2 text-right font-medium">{t('finance.cityProfit')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {report.productRows.map((row) => (
                          <tr key={row.productId}>
                            <td className="py-2">{row.name}</td>
                            <td className="py-2 text-right tabular-nums">{row.qtySold}</td>
                            <td className="py-2 text-right tabular-nums">{row.qtyGift}</td>
                            <td className="py-2 text-right tabular-nums">{formatMoney(row.revenue)} ₸</td>
                            <td className="py-2 text-right tabular-nums">
                              {row.estimatedGrossProfit == null
                                ? t('finance.unavailable')
                                : `${formatMoney(row.estimatedGrossProfit)} ₸`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>

              <Section title={editingId ? t('finance.editExpense') : t('finance.addExpense')}>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <label className="text-sm text-slate-600">
                    {t('common.date')}
                    <input
                      type="date"
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                      value={form.date}
                      onChange={(e) => setForm({ ...form, date: e.target.value })}
                    />
                  </label>
                  <label className="text-sm text-slate-600">
                    {t('finance.category')}
                    <select
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                      value={form.category}
                      onChange={(e) => setForm({ ...form, category: e.target.value })}
                    >
                      {FINANCE_EXPENSE_CATEGORIES.map((code) => (
                        <option key={code} value={code}>
                          {catLabel(code)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm text-slate-600">
                    {t('finance.amountTenge')}
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                      value={form.amount}
                      onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    />
                  </label>
                  <label className="text-sm text-slate-600">
                    {t('common.city')}
                    <select
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                      value={form.cityId}
                      onChange={(e) => setForm({ ...form, cityId: e.target.value })}
                    >
                      <option value="">{t('finance.companyCity')}</option>
                      {cities.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm text-slate-600 sm:col-span-2">
                    {t('finance.comment')}
                    <input
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                      value={form.comment}
                      onChange={(e) => setForm({ ...form, comment: e.target.value })}
                    />
                  </label>
                </div>
                {formError ? <p className="mt-3 text-sm text-red-600">{formError}</p> : null}
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void submitExpense()}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {saving ? t('finance.saving') : t('finance.save')}
                  </button>
                  {editingId ? (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => resetForm()}
                      className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700"
                    >
                      {t('common.cancel')}
                    </button>
                  ) : null}
                </div>
              </Section>

              <Section title={t('finance.journal')}>
                {journal.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('finance.emptyExpenses')}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-left text-sm">
                      <thead className="text-xs text-slate-500">
                        <tr>
                          <th className="pb-2 font-medium">{t('common.date')}</th>
                          <th className="pb-2 font-medium">{t('finance.category')}</th>
                          <th className="pb-2 font-medium">{t('common.city')}</th>
                          <th className="pb-2 text-right font-medium">{t('common.amount')}</th>
                          <th className="pb-2 font-medium">{t('admin.actions')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {journal.map((row) => (
                          <tr key={String(row.id)}>
                            <td className="py-2 tabular-nums">{String(row.expense_date).slice(0, 10)}</td>
                            <td className="py-2">{catLabel(String(row.category))}</td>
                            <td className="py-2">{cityName(row.city_id)}</td>
                            <td className="py-2 text-right tabular-nums">{formatMoney(Number(row.amount))} ₸</td>
                            <td className="py-2">
                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  className="text-xs font-medium text-blue-700"
                                  onClick={() => startEdit(row)}
                                >
                                  {t('finance.editExpense')}
                                </button>
                                <button
                                  type="button"
                                  className="text-xs font-medium text-rose-700"
                                  disabled={saving}
                                  onClick={() => row.id && void removeExpense(row.id)}
                                >
                                  {t('finance.delete')}
                                </button>
                                <button
                                  type="button"
                                  className="text-xs font-medium text-slate-600"
                                  onClick={() => row.id && void openHistory(row.id)}
                                >
                                  {t('finance.history')}
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {historyId ? (
                  <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 p-3 text-sm">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="font-medium text-slate-800">{t('finance.history')}</p>
                      <button type="button" className="text-xs text-slate-500" onClick={() => setHistoryId(null)}>
                        {t('common.close')}
                      </button>
                    </div>
                    {historyError ? <p className="text-red-600">{historyError}</p> : null}
                    {historyRows && historyRows.length === 0 ? (
                      <p className="text-slate-500">{t('admin.historyEmpty')}</p>
                    ) : null}
                    <ul className="space-y-2">
                      {(historyRows || []).map((ev) => (
                        <li key={String(ev.id)} className="text-xs text-slate-600">
                          <span className="font-medium text-slate-800">
                            {t(`finance.event.${ev.action || 'update'}` as 'finance.event.update')}
                          </span>{' '}
                          · {ev.created_at ? new Date(ev.created_at).toLocaleString('ru-KZ') : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </Section>
            </div>
          ) : (
            <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">{t('finance.empty')}</p>
          )}
        </div>
      </div>
    </Protected>
  );
}

function padMonth(m: number): string {
  return String(m).padStart(2, '0');
}
