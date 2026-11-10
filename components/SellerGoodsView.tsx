'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import TableScroll from '@/components/TableScroll';
import { supabase } from '@/lib/supabaseClient';
import { useTranslation } from '@/lib/i18n';
import { runExclusive, newClientOperationId } from '@/lib/exclusiveAsync';
import { FINANCE_COSTS_RPC } from '@/lib/adminFinance';
import type { ProductCostRow } from '@/lib/productCost';
import { PRODUCT_CATALOG_SELECT, type City, type Product } from '@/lib/types';
import {
  SELLER_BALANCES_LIST,
  SELLER_GOODS_ADVANCE,
  SELLER_GOODS_ISSUE,
  SELLER_GOODS_ISSUES_LIST,
  SELLER_GOODS_RETURN,
  asSellerBalance,
  asSellerGoodsIssue,
  formatTariffAmount,
  parseQty,
  parseTariffAmount,
  rpcItems,
  type SellerBalanceRow,
  type SellerGoodsIssue,
} from '@/lib/sellerCommission';

const SAVE_KEY = 'seller-goods-save';
const RETURN_KEY = 'seller-goods-return';

type DraftLine = { key: string; productId: string; qty: string; unitCredit: string };

function money(value: number) {
  return formatTariffAmount(value, '0 ₸');
}

function newLine(): DraftLine {
  return { key: newClientOperationId(), productId: '', qty: '1', unitCredit: '' };
}

export default function SellerGoodsView({ canMutate }: { canMutate: boolean }) {
  const { t } = useTranslation();
  const [sellers, setSellers] = useState<SellerBalanceRow[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [costs, setCosts] = useState<Map<string, number | null>>(new Map());
  const [stock, setStock] = useState<Map<string, number>>(new Map());
  const [sellerId, setSellerId] = useState('');
  const [cityId, setCityId] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);
  const [kind, setKind] = useState<'settlement' | 'advance'>('settlement');
  const [advanceOk, setAdvanceOk] = useState(false);
  const [comment, setComment] = useState('');
  const [history, setHistory] = useState<SellerGoodsIssue[]>([]);
  const [receivedId, setReceivedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const selectedSeller = useMemo(
    () => sellers.find((row) => row.seller_id === sellerId) ?? null,
    [sellers, sellerId],
  );

  const loadRef = useCallback(async () => {
    const { data: list, error } = await supabase.rpc(SELLER_BALANCES_LIST);
    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }
    const next = rpcItems<Record<string, unknown>>(list)
      .map((item) => asSellerBalance(item))
      .filter((row): row is SellerBalanceRow => row != null);
    setSellers(next);
    setSellerId((prev) => prev || next[0]?.seller_id || '');

    const [{ data: cityRows }, { data: productRows }] = await Promise.all([
      supabase.from('cities').select('id, name').order('name'),
      supabase.from('products').select(PRODUCT_CATALOG_SELECT).order('name'),
    ]);
    const nextCities = (cityRows || []) as City[];
    setCities(nextCities);
    setCityId((prev) => prev || nextCities[0]?.id || '');
    setProducts((productRows || []) as Product[]);

    if (canMutate) {
      const { data: costRows } = await supabase.rpc(FINANCE_COSTS_RPC);
      const map = new Map<string, number | null>();
      (Array.isArray(costRows) ? (costRows as ProductCostRow[]) : []).forEach((row) => {
        map.set(row.id, row.cost_price);
      });
      setCosts(map);
    }
    setLoading(false);
  }, [canMutate]);

  const loadHistory = useCallback(async (id: string) => {
    const { data, error } = await supabase.rpc(SELLER_GOODS_ISSUES_LIST, {
      p_seller_id: id || null,
    });
    if (error) {
      setMessage(error.message);
      setHistory([]);
      return;
    }
    setHistory(
      rpcItems<Record<string, unknown>>(data)
        .map((item) => asSellerGoodsIssue(item))
        .filter((row): row is SellerGoodsIssue => row != null),
    );
  }, []);

  const loadStock = useCallback(async (warehouseId: string) => {
    if (!warehouseId) {
      setStock(new Map());
      return;
    }
    const { data, error } = await supabase
      .from('inventory')
      .select('product_id, qty_on_hand')
      .eq('city_id', warehouseId);
    if (error) {
      setMessage(error.message);
      setStock(new Map());
      return;
    }
    const map = new Map<string, number>();
    (data || []).forEach((row: { product_id: string; qty_on_hand: number }) => {
      map.set(row.product_id, Number(row.qty_on_hand) || 0);
    });
    setStock(map);
  }, []);

  useEffect(() => {
    void loadRef();
  }, [loadRef]);

  useEffect(() => {
    void loadHistory(sellerId);
  }, [loadHistory, sellerId]);

  useEffect(() => {
    void loadStock(cityId);
  }, [loadStock, cityId]);

  const preview = useMemo(() => {
    let credit = 0;
    let cost = 0;
    let missingCost = false;
    let noStock = false;
    const parsed: { product_id: string; qty: number; unit_credit_amount: number }[] = [];
    const used = new Set<string>();
    let duplicate = false;
    let incomplete = false;
    for (const line of lines) {
      if (!line.productId && !line.unitCredit.trim() && line.qty.trim() === '1') continue;
      if (!line.productId) {
        if (line.unitCredit.trim() || (line.qty.trim() && line.qty.trim() !== '1')) incomplete = true;
        continue;
      }
      const qty = parseQty(line.qty);
      const unit = parseTariffAmount(line.unitCredit);
      if (qty.kind !== 'value' || unit.kind !== 'value') {
        incomplete = true;
        continue;
      }
      if (used.has(line.productId)) {
        duplicate = true;
        continue;
      }
      used.add(line.productId);
      const lineCredit = Number((qty.value * unit.value).toFixed(2));
      const unitCost = costs.get(line.productId);
      if (unitCost == null) missingCost = true;
      const lineCost = unitCost == null ? 0 : Number((qty.value * unitCost).toFixed(2));
      const onHand = stock.get(line.productId) ?? 0;
      if (qty.value > onHand) noStock = true;
      credit += lineCredit;
      cost += lineCost;
      parsed.push({
        product_id: line.productId,
        qty: qty.value,
        unit_credit_amount: unit.value,
      });
    }
    credit = Number(credit.toFixed(2));
    cost = Number(cost.toFixed(2));
    const balance = selectedSeller ? Number((selectedSeller.balance - credit).toFixed(2)) : 0;
    return { credit, cost, missingCost, noStock, parsed, balance, duplicate, incomplete };
  }, [lines, costs, stock, selectedSeller]);

  async function submit() {
    if (!canMutate || !selectedSeller || !cityId) return;
    if (preview.duplicate) {
      setMessage(t('sellerGoods.duplicateProduct'));
      return;
    }
    if (preview.incomplete || preview.parsed.length < 1 || preview.credit <= 0) {
      setMessage(t('sellerGoods.needLines'));
      return;
    }
    if (preview.missingCost) {
      setMessage(t('sellerGoods.missingCost'));
      return;
    }
    if (preview.noStock) {
      setMessage(t('sellerGoods.noStock'));
      return;
    }
    if (kind === 'advance' && !advanceOk) {
      setMessage(t('sellerGoods.advanceConfirmNeeded'));
      return;
    }
    if (kind === 'settlement' && preview.credit > selectedSeller.balance) {
      setMessage(t('sellerGoods.overBalance'));
      return;
    }
    await runExclusive(SAVE_KEY, async () => {
      setSaving(true);
      setMessage('');
      const rpc = kind === 'advance' ? SELLER_GOODS_ADVANCE : SELLER_GOODS_ISSUE;
      const { error } = await supabase.rpc(rpc, {
        p_operation_id: newClientOperationId(),
        p_seller_id: selectedSeller.seller_id,
        p_city_id: cityId,
        p_items: preview.parsed,
        p_comment: comment.trim() || null,
      });
      setSaving(false);
      if (error) {
        setMessage(error.message);
        return;
      }
      setMessage(t('sellerGoods.saved'));
      setAdvanceOk(false);
      setComment('');
      setLines([newLine()]);
      await loadRef();
      await loadHistory(selectedSeller.seller_id);
      await loadStock(cityId);
    });
  }

  async function submitReturn(issue: SellerGoodsIssue) {
    if (!canMutate || issue.status !== 'issued') return;
    if (receivedId !== issue.id) {
      setMessage(t('sellerGoods.receivedNeeded'));
      return;
    }
    await runExclusive(RETURN_KEY, async () => {
      setSaving(true);
      setMessage('');
      const { error } = await supabase.rpc(SELLER_GOODS_RETURN, {
        p_operation_id: newClientOperationId(),
        p_issue_id: issue.id,
        p_received: true,
        p_comment: comment.trim() || null,
      });
      setSaving(false);
      if (error) {
        setMessage(error.message);
        return;
      }
      setMessage(t('sellerGoods.returned'));
      setReceivedId('');
      await loadRef();
      await loadHistory(sellerId);
      await loadStock(cityId);
    });
  }

  if (loading) {
    return <p className="p-4 text-sm text-slate-700">{t('sellerBalances.loading')}</p>;
  }

  return (
    <div className="p-3 sm:p-4 space-y-4">
      <p className="text-sm text-slate-700">{t('sellerGoods.warn')}</p>
      {message ? <p className="text-sm text-red-700">{message}</p> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-gray-800">
          {t('sellerBalances.colSeller')}
          <select
            className="mt-1 w-full min-h-[44px] border border-gray-300 rounded-lg px-3 bg-white"
            value={sellerId}
            onChange={(e) => setSellerId(e.target.value)}
          >
            {sellers.map((row) => (
              <option key={row.seller_id} value={row.seller_id}>
                {row.display_name || row.seller_id}
                {row.is_active === false ? ` (${t('sellerBalances.inactive')})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-gray-800">
          {t('sellerGoods.warehouse')}
          <select
            className="mt-1 w-full min-h-[44px] border border-gray-300 rounded-lg px-3 bg-white"
            value={cityId}
            onChange={(e) => setCityId(e.target.value)}
          >
            {cities.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selectedSeller ? (
        <p className="text-sm">
          {t('sellerBalances.balance')}:{' '}
          <span className={selectedSeller.balance < 0 ? 'text-rose-800' : 'text-emerald-800'}>
            {money(selectedSeller.balance)}
          </span>
        </p>
      ) : null}

      {canMutate ? (
        <div className="space-y-3 rounded-xl border border-gray-200 p-3">
          {lines.map((line, index) => {
            const qty = parseQty(line.qty);
            const unit = parseTariffAmount(line.unitCredit);
            const onHand = line.productId ? stock.get(line.productId) ?? 0 : 0;
            const unitCost = line.productId ? costs.get(line.productId) : null;
            const lineCredit =
              qty.kind === 'value' && unit.kind === 'value'
                ? Number((qty.value * unit.value).toFixed(2))
                : 0;
            const afterStock = qty.kind === 'value' ? onHand - qty.value : onHand;
            return (
              <div key={line.key} className="grid gap-2 sm:grid-cols-6 border-b border-gray-100 pb-3">
                <label className="text-xs text-gray-700 sm:col-span-2">
                  {t('sellerGoods.product')}
                  <select
                    className="mt-1 w-full min-h-[44px] border border-gray-300 rounded-lg px-2 bg-white text-sm"
                    value={line.productId}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((row, i) => (i === index ? { ...row, productId: e.target.value } : row)),
                      )
                    }
                  >
                    <option value="">{t('sellerGoods.product')}</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-gray-700">
                  {t('sellerGoods.qty')}
                  <input
                    className="mt-1 w-full min-h-[44px] border border-gray-300 rounded-lg px-2"
                    inputMode="decimal"
                    value={line.qty}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((row, i) => (i === index ? { ...row, qty: e.target.value } : row)),
                      )
                    }
                  />
                </label>
                <label className="text-xs text-gray-700">
                  {t('sellerGoods.unitCredit')}
                  <input
                    className="mt-1 w-full min-h-[44px] border border-gray-300 rounded-lg px-2"
                    inputMode="decimal"
                    value={line.unitCredit}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((row, i) =>
                          i === index ? { ...row, unitCredit: e.target.value } : row,
                        ),
                      )
                    }
                  />
                </label>
                <div className="text-xs text-gray-700 space-y-1">
                  <div>
                    {t('sellerGoods.stock')}: {onHand}
                  </div>
                  <div>
                    {t('sellerGoods.cost')}: {unitCost == null ? '—' : money(unitCost)}
                  </div>
                  <div>
                    {t('sellerGoods.lineCredit')}: {money(lineCredit)}
                  </div>
                  <div>
                    {t('sellerGoods.previewStock')}: {afterStock}
                  </div>
                </div>
                <button
                  type="button"
                  className="min-h-[44px] text-sm text-rose-800"
                  onClick={() =>
                    setLines((prev) => (prev.length === 1 ? [newLine()] : prev.filter((_, i) => i !== index)))
                  }
                >
                  {t('sellerGoods.remove')}
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="min-h-[44px] px-3 rounded-lg border border-gray-300 text-sm"
            onClick={() => setLines((prev) => [...prev, newLine()])}
          >
            {t('sellerGoods.addItem')}
          </button>

          <div className="grid gap-2 sm:grid-cols-2 text-sm">
            <div>
              {t('sellerGoods.previewCredit')}: {money(preview.credit)}
            </div>
            <div>
              {t('sellerGoods.previewCost')}: {money(preview.cost)}
            </div>
            <div>
              {t('sellerGoods.previewBalance')}: {money(preview.balance)}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`min-h-[44px] px-3 rounded-lg text-sm ${kind === 'settlement' ? 'bg-gray-900 text-white' : 'border border-gray-300'}`}
              onClick={() => setKind('settlement')}
            >
              {t('sellerGoods.kindSettlement')}
            </button>
            <button
              type="button"
              className={`min-h-[44px] px-3 rounded-lg text-sm ${kind === 'advance' ? 'bg-amber-800 text-white' : 'border border-gray-300'}`}
              onClick={() => setKind('advance')}
            >
              {t('sellerGoods.kindAdvance')}
            </button>
          </div>
          {kind === 'advance' ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={advanceOk}
                onChange={(e) => setAdvanceOk(e.target.checked)}
              />
              {t('sellerGoods.advanceConfirm')}
            </label>
          ) : null}
          <label className="block text-sm text-gray-800">
            {t('sellerBalances.comment')}
            <textarea
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2"
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={saving}
            className="min-h-[44px] px-4 rounded-lg bg-emerald-700 text-white text-sm disabled:opacity-50"
            onClick={() => void submit()}
          >
            {t('sellerGoods.issue')}
          </button>
        </div>
      ) : null}

      <h2 className="text-lg font-semibold">{t('sellerGoods.history')}</h2>
      <div className="lg:hidden space-y-3">
        {history.map((issue) => (
          <div key={issue.id} className="rounded-xl border border-gray-200 p-3 text-sm space-y-1">
            <div className="font-medium">
              {issue.issue_number} · {t(`sellerGoods.status.${issue.status}`)}
            </div>
            <div>
              {issue.city_name} · {money(issue.credit_amount)}
            </div>
            {canMutate ? (
              <div>
                {t('sellerGoods.cost')}: {money(issue.cost_total)}
              </div>
            ) : null}
            {canMutate && issue.status === 'issued' ? (
              <div className="pt-2 space-y-2">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={receivedId === issue.id}
                    onChange={(e) => setReceivedId(e.target.checked ? issue.id : '')}
                  />
                  {t('sellerGoods.receivedConfirm')}
                </label>
                <button
                  type="button"
                  disabled={saving}
                  className="min-h-[44px] px-3 rounded-lg border border-rose-700 text-rose-800"
                  onClick={() => void submitReturn(issue)}
                >
                  {t('sellerGoods.return')}
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="hidden lg:block">
        <TableScroll minWidth="720px">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-600">
                <th className="p-2">{t('sellerGoods.colNumber')}</th>
                <th className="p-2">{t('sellerGoods.colStatus')}</th>
                <th className="p-2">{t('sellerGoods.warehouse')}</th>
                <th className="p-2">{t('sellerGoods.previewCredit')}</th>
                {canMutate ? <th className="p-2">{t('sellerGoods.previewCost')}</th> : null}
                <th className="p-2">{t('sellerBalances.comment')}</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {history.map((issue) => (
                <tr key={issue.id} className="border-t border-gray-100">
                  <td className="p-2">{issue.issue_number}</td>
                  <td className="p-2">{t(`sellerGoods.status.${issue.status}`)}</td>
                  <td className="p-2">{issue.city_name}</td>
                  <td className="p-2">{money(issue.credit_amount)}</td>
                  {canMutate ? <td className="p-2">{money(issue.cost_total)}</td> : null}
                  <td className="p-2">{issue.comment || '—'}</td>
                  <td className="p-2">
                    {canMutate && issue.status === 'issued' ? (
                      <div className="space-y-2">
                        <label className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={receivedId === issue.id}
                            onChange={(e) => setReceivedId(e.target.checked ? issue.id : '')}
                          />
                          {t('sellerGoods.receivedConfirm')}
                        </label>
                        <button
                          type="button"
                          disabled={saving}
                          className="min-h-[44px] px-3 rounded-lg border border-rose-700 text-rose-800"
                          onClick={() => void submitReturn(issue)}
                        >
                          {t('sellerGoods.return')}
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </div>
    </div>
  );
}
