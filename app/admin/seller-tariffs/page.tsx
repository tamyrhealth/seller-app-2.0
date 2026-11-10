'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import TableScroll from '@/components/TableScroll';
import CollapsibleFilters from '@/components/CollapsibleFilters';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { PRODUCT_CATALOG_SELECT, type Product, type Profile } from '@/lib/types';
import { runExclusive } from '@/lib/exclusiveAsync';
import {
  SELLER_RATE_OVERRIDES_LIST,
  SELLER_RATE_OVERRIDE_SET,
  SELLER_TARIFF_ASSIGN,
  SELLER_TARIFF_ASSIGNMENTS_LIST,
  SELLER_TARIFF_PLANS_LIST,
  SELLER_TARIFF_RATES_LIST,
  SELLER_TARIFF_RATE_SET,
  SELLER_MISSING_ACCRUALS_LIST,
  SELLER_UNACCRUED_ITEMS_LIST,
  SELLER_ACCRUAL_CONSISTENCY,
  SELLER_ACCRUAL_RETRY_ITEM,
  formatTariffAmount,
  openAssignment,
  openRate,
  parseTariffAmount,
  rpcItems,
  asUnaccruedItems,
  asAccrualConsistency,
  type AccrualConsistencySummary,
  type RateOverrideRow,
  type TariffAssignmentRow,
  type TariffPlan,
  type TariffRateRow,
  type UnaccruedCommissionItem,
} from '@/lib/sellerCommission';

const SAVE_KEY = 'seller-tariffs-save';

function planByCode(plans: TariffPlan[], code: string) {
  return plans.find((p) => p.code === code) ?? null;
}

export default function AdminSellerTariffsPage() {
  const { profile } = useAuth();
  const { t } = useTranslation();
  const isAdmin = profile?.role === 'admin';
  const [plans, setPlans] = useState<TariffPlan[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [sellers, setSellers] = useState<Profile[]>([]);
  const [ratesA, setRatesA] = useState<TariffRateRow[]>([]);
  const [ratesB, setRatesB] = useState<TariffRateRow[]>([]);
  const [draftA, setDraftA] = useState<Record<string, string>>({});
  const [draftB, setDraftB] = useState<Record<string, string>>({});
  const [assignments, setAssignments] = useState<Record<string, TariffAssignmentRow[]>>({});
  const [overrides, setOverrides] = useState<RateOverrideRow[]>([]);
  const [sellerId, setSellerId] = useState('');
  const [assignPlan, setAssignPlan] = useState('A');
  const [overrideProduct, setOverrideProduct] = useState('');
  const [overrideAmount, setOverrideAmount] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [messageKind, setMessageKind] = useState<'ok' | 'error' | ''>('');
  const [retryBusy, setRetryBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [missingRows, setMissingRows] = useState<Array<Record<string, unknown>>>([]);
  const [unaccruedRows, setUnaccruedRows] = useState<UnaccruedCommissionItem[]>([]);
  const [consistency, setConsistency] = useState<AccrualConsistencySummary | null>(null);
  const [retryItemId, setRetryItemId] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async (opts?: { preserveMessage?: boolean }) => {
    if (!opts?.preserveMessage) {
      setMessage('');
      setMessageKind('');
    }
    const { data: planPayload, error: planErr } = await supabase.rpc(SELLER_TARIFF_PLANS_LIST);
    if (planErr) {
      setMessageKind('error');
      setMessage(planErr.message);
      setLoading(false);
      return planErr.message;
    }
    const nextPlans = rpcItems<TariffPlan>(planPayload);
    setPlans(nextPlans);
    const planA = planByCode(nextPlans, 'A');
    const planB = planByCode(nextPlans, 'B');
    const { data: productsData, error: productErr } = await supabase
      .from('products')
      .select(PRODUCT_CATALOG_SELECT)
      .order('name');
    if (productErr) {
      setMessageKind('error');
      setMessage(productErr.message);
      setLoading(false);
      return productErr.message;
    }
    setProducts((productsData || []) as Product[]);
    const { data: sellerRows, error: sellerErr } = await supabase
      .from('profiles')
      .select('id, display_name, role, is_active')
      .eq('role', 'seller')
      .order('display_name');
    if (sellerErr) {
      setMessageKind('error');
      setMessage(sellerErr.message);
      setLoading(false);
      return sellerErr.message;
    }
    const nextSellers = (sellerRows || []) as Profile[];
    setSellers(nextSellers);
    if (planA) {
      const { data } = await supabase.rpc(SELLER_TARIFF_RATES_LIST, { p_plan_id: planA.id });
      setRatesA(rpcItems<TariffRateRow>(data));
    }
    if (planB) {
      const { data } = await supabase.rpc(SELLER_TARIFF_RATES_LIST, { p_plan_id: planB.id });
      setRatesB(rpcItems<TariffRateRow>(data));
    }
    const nextAssign: Record<string, TariffAssignmentRow[]> = {};
    for (const seller of nextSellers) {
      const { data } = await supabase.rpc(SELLER_TARIFF_ASSIGNMENTS_LIST, { p_seller_id: seller.id });
      nextAssign[seller.id] = rpcItems<TariffAssignmentRow>(data);
    }
    setAssignments(nextAssign);
    setSellerId((prev) => prev || nextSellers[0]?.id || '');
    setDraftA({});
    setDraftB({});
    const { data: missingPayload, error: missingErr } = await supabase.rpc(SELLER_MISSING_ACCRUALS_LIST, {
      p_limit: 100,
    });
    setMissingRows(rpcItems<Record<string, unknown>>(missingPayload));
    const { data: unaccruedPayload, error: unaccruedErr } = await supabase.rpc(SELLER_UNACCRUED_ITEMS_LIST, {
      p_limit: 100,
    });
    setUnaccruedRows(asUnaccruedItems(unaccruedPayload));
    const { data: consistencyPayload, error: consistencyErr } = await supabase.rpc(SELLER_ACCRUAL_CONSISTENCY);
    setConsistency(asAccrualConsistency(consistencyPayload));
    const loadErr = missingErr || unaccruedErr || consistencyErr;
    if (loadErr) {
      setMessageKind('error');
      setMessage(loadErr.message);
      setLoading(false);
      return loadErr.message;
    }
    setLoading(false);
    return null;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!sellerId) {
      setOverrides([]);
      return;
    }
    void supabase.rpc(SELLER_RATE_OVERRIDES_LIST, { p_seller_id: sellerId }).then(({ data, error }) => {
      if (error) setMessage(error.message);
      else setOverrides(rpcItems<RateOverrideRow>(data));
    });
  }, [sellerId]);

  const visibleProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [products, search]);

  async function saveRates() {
    if (!isAdmin || saving) return;
    await runExclusive(SAVE_KEY, async () => {
      setSaving(true);
      setMessage('');
      const planA = planByCode(plans, 'A');
      const planB = planByCode(plans, 'B');
      const from = new Date().toISOString();
      const jobs: Array<{ plan: TariffPlan; productId: string; amount: number }> = [];
      for (const product of products) {
        const parsedA = parseTariffAmount(draftA[product.id] ?? '');
        const parsedB = parseTariffAmount(draftB[product.id] ?? '');
        if (parsedA.kind === 'invalid' || parsedB.kind === 'invalid') {
          setMessage(t('sellerTariffs.invalid'));
          setSaving(false);
          return;
        }
        if (parsedA.kind === 'value' && planA) jobs.push({ plan: planA, productId: product.id, amount: parsedA.value });
        if (parsedB.kind === 'value' && planB) jobs.push({ plan: planB, productId: product.id, amount: parsedB.value });
      }
      if (!jobs.length) {
        setMessage(t('sellerTariffs.noChanges'));
        setSaving(false);
        return;
      }
      for (const job of jobs) {
        const { error } = await supabase.rpc(SELLER_TARIFF_RATE_SET, {
          p_plan_id: job.plan.id,
          p_product_id: job.productId,
          p_amount_kzt: job.amount,
          p_effective_from: from,
        });
        if (error) {
          setMessage(error.message);
          setSaving(false);
          return;
        }
      }
      setMessage(t('sellerTariffs.saved'));
      setSaving(false);
      await load();
    });
  }

  async function saveAssign() {
    if (!isAdmin || !sellerId) return;
    const plan = planByCode(plans, assignPlan);
    if (!plan) return;
    const { error } = await supabase.rpc(SELLER_TARIFF_ASSIGN, {
      p_seller_id: sellerId,
      p_plan_id: plan.id,
      p_effective_from: new Date().toISOString(),
    });
    setMessage(error ? error.message : t('sellerTariffs.saved'));
    if (!error) await load();
  }

  async function saveOverride() {
    if (!isAdmin || !sellerId || !overrideProduct) return;
    const parsed = parseTariffAmount(overrideAmount);
    if (parsed.kind !== 'value') {
      setMessage(t('sellerTariffs.invalid'));
      return;
    }
    const { error } = await supabase.rpc(SELLER_RATE_OVERRIDE_SET, {
      p_seller_id: sellerId,
      p_product_id: overrideProduct,
      p_amount_kzt: parsed.value,
      p_effective_from: new Date().toISOString(),
    });
    setMessage(error ? error.message : t('sellerTariffs.saved'));
    if (!error) {
      setOverrideAmount('');
      const { data } = await supabase.rpc(SELLER_RATE_OVERRIDES_LIST, { p_seller_id: sellerId });
      setOverrides(rpcItems<RateOverrideRow>(data));
    }
  }

  async function retryItem(orderItemId?: string) {
    const id = (orderItemId || retryItemId).trim();
    if (!isAdmin || !id || retryBusy) return;
    if (!window.confirm(t('sellerTariffs.retryConfirm'))) return;
    setRetryBusy(true);
    await runExclusive('seller-tariffs-retry', async () => {
      const { data, error } = await supabase.rpc(SELLER_ACCRUAL_RETRY_ITEM, { p_order_item_id: id });
      if (error) {
        setMessageKind('error');
        setMessage(error.message);
        return;
      }
      if (!data) {
        setMessageKind('error');
        setMessage(t('sellerTariffs.retryFailed'));
        return;
      }
      setRetryItemId('');
      const reloadErr = await load({ preserveMessage: true });
      if (reloadErr) return;
      setMessageKind('ok');
      setMessage(t('sellerTariffs.retryDone'));
    });
    setRetryBusy(false);
  }

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-white">
        <NavAdmin />
        <div className="p-4 max-w-full overflow-x-hidden">
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('sellerTariffs.title')}</h1>
            <Link href="/admin/products" className="text-sm text-blue-800">
              {t('sellerTariffs.back')}
            </Link>
          </div>
          {!isAdmin && profile ? <p className="text-red-700 mb-3">{t('sellerTariffs.forbidden')}</p> : null}
          <p className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
            {t('sellerTariffs.warn')}
          </p>
          {message ? (
            <p
              className={`text-sm mb-3 ${
                messageKind === 'error' ? 'text-red-700' : messageKind === 'ok' ? 'text-emerald-800' : 'text-gray-800'
              }`}
            >
              {message}
            </p>
          ) : null}
          {loading ? <p className="text-gray-600">{t('sellerTariffs.loading')}</p> : null}

          <h2 className="text-lg font-semibold mb-2">{t('sellerTariffs.ratesTitle')}</h2>
          <CollapsibleFilters title={t('sellerTariffs.search')}>
            <input
              className="border rounded-lg px-3 py-2 mb-3 w-full min-h-11 max-w-sm"
              placeholder={t('sellerTariffs.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </CollapsibleFilters>
          <label className="flex items-center gap-2 text-sm mb-2">
            <input type="checkbox" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} />
            {t('sellerTariffs.showHistory')}
          </label>
          <TableScroll minWidth="720px">
            <table className="min-w-[720px] w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="p-2">{t('sellerTariffs.colProduct')}</th>
                  <th className="p-2">{t('sellerTariffs.colCurrentA')}</th>
                  <th className="p-2">{t('sellerTariffs.colNewA')}</th>
                  <th className="p-2">{t('sellerTariffs.colCurrentB')}</th>
                  <th className="p-2">{t('sellerTariffs.colNewB')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map((product) => {
                  const a = openRate(ratesA, product.id);
                  const b = openRate(ratesB, product.id);
                  return (
                    <tr key={product.id} className="border-b">
                      <td className="p-2">{product.name}</td>
                      <td className="p-2">{formatTariffAmount(a?.amount_kzt ?? null, t('sellerTariffs.unset'))}</td>
                      <td className="p-2">
                        <input
                          className="border rounded px-2 py-1 w-28 min-h-11"
                          value={draftA[product.id] ?? ''}
                          onChange={(e) => setDraftA((prev) => ({ ...prev, [product.id]: e.target.value }))}
                          disabled={!isAdmin}
                        />
                      </td>
                      <td className="p-2">{formatTariffAmount(b?.amount_kzt ?? null, t('sellerTariffs.unset'))}</td>
                      <td className="p-2">
                        <input
                          className="border rounded px-2 py-1 w-28 min-h-11"
                          value={draftB[product.id] ?? ''}
                          onChange={(e) => setDraftB((prev) => ({ ...prev, [product.id]: e.target.value }))}
                          disabled={!isAdmin}
                        />
                      </td>
                    </tr>
                  );
                })}
                {showHistory
                  ? [...ratesA, ...ratesB].map((row) => {
                      const product = products.find((p) => p.id === row.product_id);
                      const plan = plans.find((p) => p.id === row.plan_id);
                      return (
                        <tr key={row.id} className="border-b bg-slate-50 text-gray-700">
                          <td className="p-2" colSpan={5}>
                            {plan?.code || '?'} · {product?.name || row.product_id} · {formatTariffAmount(row.amount_kzt, t('sellerTariffs.unset'))} · {row.effective_from} → {row.effective_to || '—'}
                          </td>
                        </tr>
                      );
                    })
                  : null}
              </tbody>
            </table>
          </TableScroll>
          <button
            type="button"
            className="mt-3 px-4 py-2 rounded-lg bg-blue-600 text-white disabled:opacity-50"
            disabled={!isAdmin || saving}
            onClick={() => void saveRates()}
          >
            {t('sellerTariffs.saveRates')}
          </button>

          <h2 className="text-lg font-semibold mt-8 mb-2">{t('sellerTariffs.assignTitle')}</h2>
          <div className="flex flex-wrap gap-2 items-center mb-3">
            <select className="border rounded-lg px-3 py-2 min-h-11 w-full sm:w-auto" value={sellerId} onChange={(e) => setSellerId(e.target.value)}>
              {sellers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.display_name}
                </option>
              ))}
            </select>
            <select className="border rounded-lg px-3 py-2" value={assignPlan} onChange={(e) => setAssignPlan(e.target.value)}>
              <option value="A">A</option>
              <option value="B">B</option>
            </select>
            <button
              type="button"
              className="px-4 py-2 rounded-lg bg-blue-600 text-white disabled:opacity-50"
              disabled={!isAdmin}
              onClick={() => void saveAssign()}
            >
              {t('sellerTariffs.saveAssign')}
            </button>
          </div>
          <ul className="text-sm text-gray-800 mb-4">
            {sellers.map((s) => {
              const current = openAssignment(assignments[s.id] || []);
              const plan = plans.find((p) => p.id === current?.plan_id);
              return (
                <li key={s.id}>
                  {s.display_name}: {plan ? plan.code : t('sellerTariffs.unset')}
                </li>
              );
            })}
          </ul>

          <h2 className="text-lg font-semibold mb-2">{t('sellerTariffs.overrideTitle')}</h2>
          <div className="flex flex-wrap gap-2 items-center mb-3">
            <select
              className="border rounded-lg px-3 py-2"
              value={overrideProduct}
              onChange={(e) => setOverrideProduct(e.target.value)}
            >
              <option value="">{t('sellerTariffs.colProduct')}</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              className="border rounded-lg px-3 py-2 w-28"
              value={overrideAmount}
              onChange={(e) => setOverrideAmount(e.target.value)}
              disabled={!isAdmin}
            />
            <button
              type="button"
              className="px-4 py-2 rounded-lg bg-blue-600 text-white disabled:opacity-50"
              disabled={!isAdmin}
              onClick={() => void saveOverride()}
            >
              {t('sellerTariffs.saveOverride')}
            </button>
          </div>
          <TableScroll minWidth="560px">
            <table className="min-w-[560px] w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="p-2">{t('sellerTariffs.colProduct')}</th>
                  <th className="p-2">{t('sellerTariffs.colAmount')}</th>
                  <th className="p-2">{t('sellerTariffs.colFrom')}</th>
                  <th className="p-2">{t('sellerTariffs.colTo')}</th>
                </tr>
              </thead>
              <tbody>
                {overrides.map((row) => {
                  const product = products.find((p) => p.id === row.product_id);
                  return (
                    <tr key={row.id} className="border-b">
                      <td className="p-2">{product?.name || row.product_id}</td>
                      <td className="p-2">{formatTariffAmount(row.amount_kzt, t('sellerTariffs.unset'))}</td>
                      <td className="p-2">{row.effective_from}</td>
                      <td className="p-2">{row.effective_to || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>

          <h2 className="text-lg font-semibold mt-8 mb-2">{t('sellerTariffs.unaccruedTitle')}</h2>
          <p className="text-sm text-gray-700 mb-3">{t('sellerTariffs.unaccruedHint')}</p>
          {consistency ? (
            <p className="text-sm text-gray-800 mb-3">
              {t('sellerTariffs.unaccruedCount')}: {consistency.unaccruedHookSkip}
              {' · '}
              {t('sellerTariffs.noTariffCount')}: {consistency.unaccruedNoTariff}
              {' · '}
              {t('sellerTariffs.backdatedCount')}: {consistency.unaccruedBackdated}
              {' · '}
              {t('sellerTariffs.missingTitle')}: {consistency.missingRate}
            </p>
          ) : null}
          <TableScroll minWidth="720px">
            <table className="min-w-[720px] w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="p-2">{t('sellerTariffs.colSeller')}</th>
                  <th className="p-2">{t('sellerTariffs.colOrder')}</th>
                  <th className="p-2">{t('sellerTariffs.colProduct')}</th>
                  <th className="p-2">{t('sellerTariffs.colReason')}</th>
                  <th className="p-2">{t('sellerTariffs.colFrom')}</th>
                  <th className="p-2">{t('sellerTariffs.colStatus')}</th>
                  <th className="p-2">{t('sellerTariffs.retry')}</th>
                </tr>
              </thead>
              <tbody>
                {unaccruedRows.length === 0 ? (
                  <tr>
                    <td className="p-2 text-gray-600" colSpan={7}>
                      {t('sellerTariffs.unaccruedEmpty')}
                    </td>
                  </tr>
                ) : (
                  unaccruedRows.map((row) => (
                    <tr key={row.order_item_id} className="border-b">
                      <td className="p-2">{row.seller_name || row.seller_id}</td>
                      <td className="p-2">{row.order_number || row.order_id}</td>
                      <td className="p-2">{row.product_name || row.product_id}</td>
                      <td className="p-2">
                        {row.reason === 'no_tariff_at_sale'
                          ? t('sellerTariffs.reasonNoTariff')
                          : row.reason === 'backdated_tariff'
                            ? t('sellerTariffs.reasonBackdated')
                            : t('sellerTariffs.reasonHookSkip')}
                      </td>
                      <td className="p-2">{row.sale_at || '—'}</td>
                      <td className="p-2">{row.status}</td>
                      <td className="p-2">
                        {row.retryable ? (
                          <button
                            type="button"
                            className="px-3 py-1 rounded-lg bg-blue-600 text-white disabled:opacity-50 min-h-11"
                            disabled={!isAdmin || retryBusy}
                            onClick={() => void retryItem(row.order_item_id)}
                          >
                            {t('sellerTariffs.retry')}
                          </button>
                        ) : (
                          t('sellerTariffs.retryBlocked')
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </TableScroll>

          <h2 className="text-lg font-semibold mt-8 mb-2">{t('sellerTariffs.missingTitle')}</h2>
          <p className="text-sm text-gray-700 mb-3">{t('sellerTariffs.missingHint')}</p>
          <TableScroll minWidth="640px">
            <table className="min-w-[640px] w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="p-2">{t('sellerTariffs.colSeller')}</th>
                  <th className="p-2">{t('sellerTariffs.colProduct')}</th>
                  <th className="p-2">{t('sellerTariffs.colAmount')}</th>
                  <th className="p-2">{t('sellerTariffs.colFrom')}</th>
                </tr>
              </thead>
              <tbody>
                {missingRows.map((row) => (
                  <tr key={String(row.id)} className="border-b">
                    <td className="p-2">{String(row.seller_id || '')}</td>
                    <td className="p-2">{String(row.product_id || '')}</td>
                    <td className="p-2">{t('sellerTariffs.missingFlag')}</td>
                    <td className="p-2">{String(row.accrued_at || '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <div className="flex flex-wrap gap-2 items-center mt-3">
            <input
              className="border rounded-lg px-3 py-2 min-h-11 w-full sm:w-80"
              placeholder={t('sellerTariffs.retryPlaceholder')}
              value={retryItemId}
              onChange={(e) => setRetryItemId(e.target.value)}
              disabled={!isAdmin || retryBusy}
            />
            <button
              type="button"
              className="px-4 py-2 rounded-lg bg-blue-600 text-white disabled:opacity-50 min-h-11"
              disabled={!isAdmin || retryBusy}
              onClick={() => void retryItem()}
            >
              {t('sellerTariffs.retry')}
            </button>
          </div>
        </div>
      </div>
    </Protected>
  );
}
