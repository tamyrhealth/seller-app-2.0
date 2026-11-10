'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import TableScroll from '@/components/TableScroll';
import CollapsibleFilters from '@/components/CollapsibleFilters';
import { supabase } from '@/lib/supabaseClient';
import { useTranslation } from '@/lib/i18n';
import { getTodayLocalISO } from '@/lib/datetime';
import { runExclusive, newClientOperationId } from '@/lib/exclusiveAsync';
import {
  SELLER_BALANCES_LIST,
  SELLER_CASH_ADVANCE,
  SELLER_CASH_PAYOUT,
  SELLER_LEDGER_LIST,
  asSellerBalance,
  cashHistoryToTimestamp,
  cashOperationTimestamp,
  formatTariffAmount,
  parseCashAmount,
  rpcItems,
  type SellerBalanceRow,
  type SellerLedgerEntry,
} from '@/lib/sellerCommission';

const SAVE_KEY = 'seller-cash-save';
const HISTORY_FROM = '2020-01-01';

function money(value: number) {
  return formatTariffAmount(value, '0 ₸');
}

function balanceClass(value: number) {
  if (value > 0) return 'text-emerald-800';
  if (value < 0) return 'text-rose-800';
  return 'text-gray-800';
}

export default function SellerBalancesView({ canMutate }: { canMutate: boolean }) {
  const { t } = useTranslation();
  const today = getTodayLocalISO('Asia/Almaty');
  const [rows, setRows] = useState<SellerBalanceRow[]>([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [history, setHistory] = useState<SellerLedgerEntry[]>([]);
  const [fromYmd, setFromYmd] = useState(HISTORY_FROM);
  const [toYmd, setToYmd] = useState(today);
  const [amount, setAmount] = useState('');
  const [opDate, setOpDate] = useState(today);
  const [comment, setComment] = useState('');
  const [advanceOk, setAdvanceOk] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const selected = useMemo(
    () => rows.find((row) => row.seller_id === selectedId) ?? null,
    [rows, selectedId],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => (row.display_name || row.seller_id).toLowerCase().includes(q));
  }, [rows, search]);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc(SELLER_BALANCES_LIST);
    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }
    const next = rpcItems<Record<string, unknown>>(data)
      .map((item) => asSellerBalance(item))
      .filter((row): row is SellerBalanceRow => row != null);
    setRows(next);
    setSelectedId((prev) => prev || next[0]?.seller_id || '');
    setLoading(false);
  }, []);

  const loadHistory = useCallback(async (sellerId: string) => {
    if (!sellerId) {
      setHistory([]);
      return;
    }
    const { data, error } = await supabase.rpc(SELLER_LEDGER_LIST, {
      p_seller_id: sellerId,
      p_from: cashOperationTimestamp(fromYmd || HISTORY_FROM),
      p_to: cashHistoryToTimestamp(toYmd || today),
    });
    if (error) {
      setMessage(error.message);
      setHistory([]);
      return;
    }
    setHistory(rpcItems<SellerLedgerEntry>(data));
  }, [fromYmd, toYmd, today]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadHistory(selectedId);
  }, [loadHistory, selectedId]);

  const parsedAmount = parseCashAmount(amount);
  const payoutBlocked =
    !canMutate ||
    saving ||
    parsedAmount.kind !== 'value' ||
    !selected ||
    selected.balance <= 0 ||
    parsedAmount.value > selected.balance;
  const advanceBlocked = !canMutate || saving || parsedAmount.kind !== 'value' || !selected || !advanceOk;

  async function postCash(kind: 'payout' | 'advance') {
    if (!canMutate || !selected) return;
    if (kind === 'advance' && !advanceOk) {
      setMessage(t('sellerBalances.advanceConfirmNeeded'));
      return;
    }
    if (parsedAmount.kind !== 'value') {
      setMessage(t('sellerBalances.invalidAmount'));
      return;
    }
    if (opDate > today) {
      setMessage(t('sellerBalances.futureDate'));
      return;
    }
    if (kind === 'payout' && parsedAmount.value > selected.balance) {
      setMessage(t('sellerBalances.overBalance'));
      return;
    }
    await runExclusive(SAVE_KEY, async () => {
      setSaving(true);
      setMessage('');
      const rpc = kind === 'payout' ? SELLER_CASH_PAYOUT : SELLER_CASH_ADVANCE;
      const { error } = await supabase.rpc(rpc, {
        p_operation_id: newClientOperationId(),
        p_seller_id: selected.seller_id,
        p_amount: parsedAmount.value,
        p_comment: comment.trim() || null,
        p_accrued_at: cashOperationTimestamp(opDate),
      });
      setSaving(false);
      if (error) {
        setMessage(error.message);
        return;
      }
      setAmount('');
      setComment('');
      setAdvanceOk(false);
      await load();
      await loadHistory(selected.seller_id);
      setMessage(t('sellerBalances.saved'));
    });
  }

  return (
    <div className="p-4 max-w-full overflow-x-hidden">
      <p className="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 mb-4">
        {t('sellerBalances.warn')}
      </p>
      {message ? <p className="text-sm text-gray-800 mb-3">{message}</p> : null}
      {loading ? <p className="text-gray-600">{t('sellerBalances.loading')}</p> : null}

      <CollapsibleFilters title={t('sellerBalances.search')}>
        <input
          className="border rounded-lg px-3 py-2 mb-3 w-full min-h-11 max-w-sm"
          placeholder={t('sellerBalances.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </CollapsibleFilters>

      <div className="lg:hidden space-y-2 mb-4">
        {visible.map((row) => (
          <button
            type="button"
            key={row.seller_id}
            className={`w-full text-left rounded-xl border p-3 min-h-11 ${selectedId === row.seller_id ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}
            onClick={() => setSelectedId(row.seller_id)}
          >
            <div className="font-medium">{row.display_name || row.seller_id}</div>
            <div className={`text-sm ${balanceClass(row.balance)}`}>
              {t('sellerBalances.balance')}: {money(row.balance)}
            </div>
            {row.is_active === false ? (
              <div className="text-xs text-gray-500">{t('sellerBalances.inactive')}</div>
            ) : null}
          </button>
        ))}
      </div>

      <div className="hidden lg:block">
        <TableScroll minWidth="920px">
          <table className="min-w-[920px] w-full text-sm">
            <thead>
              <tr className="text-left border-b">
                <th className="p-2">{t('sellerBalances.colSeller')}</th>
                <th className="p-2">{t('sellerBalances.accrued')}</th>
                <th className="p-2">{t('sellerBalances.reversed')}</th>
                <th className="p-2">{t('sellerBalances.paid')}</th>
                <th className="p-2">{t('sellerBalances.advances')}</th>
                <th className="p-2">{t('sellerBalances.goods')}</th>
                <th className="p-2">{t('sellerBalances.adjustments')}</th>
                <th className="p-2">{t('sellerBalances.balance')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.seller_id}
                  className={`border-b cursor-pointer ${selectedId === row.seller_id ? 'bg-blue-50' : ''}`}
                  onClick={() => setSelectedId(row.seller_id)}
                >
                  <td className="p-2">
                    {row.display_name || row.seller_id}
                    {row.is_active === false ? (
                      <span className="ml-2 text-xs text-gray-500">{t('sellerBalances.inactive')}</span>
                    ) : null}
                  </td>
                  <td className="p-2">{money(row.accrued)}</td>
                  <td className="p-2">{money(row.reversed)}</td>
                  <td className="p-2">{money(row.paid)}</td>
                  <td className="p-2">{money(row.advances)}</td>
                  <td className="p-2">{money(row.goods)}</td>
                  <td className="p-2">{money(row.adjustments)}</td>
                  <td className={`p-2 font-medium ${balanceClass(row.balance)}`}>{money(row.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </div>

      {selected ? (
        <section className="mt-6 rounded-xl border border-gray-200 p-4">
          <h2 className="text-lg font-semibold mb-2">{selected.display_name || selected.seller_id}</h2>
          <p className={`text-base font-medium mb-3 ${balanceClass(selected.balance)}`}>
            {selected.balance >= 0 ? t('sellerBalances.companyOwes') : t('sellerBalances.sellerOwes')}: {money(selected.balance)}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm mb-4">
            <div>{t('sellerBalances.accrued')}: {money(selected.accrued)}</div>
            <div>{t('sellerBalances.reversed')}: {money(selected.reversed)}</div>
            <div>{t('sellerBalances.paid')}: {money(selected.paid)}</div>
            <div>{t('sellerBalances.advances')}: {money(selected.advances)}</div>
            <div>{t('sellerBalances.goods')}: {money(selected.goods)}</div>
            <div>{t('sellerBalances.adjustments')}: {money(selected.adjustments)}</div>
          </div>

          {canMutate ? (
            <div className="grid gap-3 sm:grid-cols-2 mb-4">
              <div className="rounded-lg border p-3">
                <h3 className="font-medium mb-2">{t('sellerBalances.payoutTitle')}</h3>
                <input
                  className="border rounded-lg px-3 py-2 w-full min-h-11 mb-2"
                  inputMode="decimal"
                  placeholder={t('sellerBalances.amount')}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <input
                  type="date"
                  className="border rounded-lg px-3 py-2 w-full min-h-11 mb-2"
                  value={opDate}
                  max={today}
                  onChange={(e) => setOpDate(e.target.value)}
                />
                <input
                  className="border rounded-lg px-3 py-2 w-full min-h-11 mb-2"
                  placeholder={t('sellerBalances.comment')}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <button
                  type="button"
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white disabled:opacity-50 min-h-11 w-full"
                  disabled={payoutBlocked}
                  onClick={() => void postCash('payout')}
                >
                  {t('sellerBalances.pay')}
                </button>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <h3 className="font-medium mb-2">{t('sellerBalances.advanceTitle')}</h3>
                <label className="flex items-start gap-2 text-sm mb-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={advanceOk}
                    onChange={(e) => setAdvanceOk(e.target.checked)}
                  />
                  {t('sellerBalances.advanceConfirm')}
                </label>
                <button
                  type="button"
                  className="px-4 py-2 rounded-lg bg-amber-700 text-white disabled:opacity-50 min-h-11 w-full"
                  disabled={advanceBlocked}
                  onClick={() => void postCash('advance')}
                >
                  {t('sellerBalances.advance')}
                </button>
              </div>
            </div>
          ) : null}

          <h3 className="font-medium mb-2">{t('sellerBalances.history')}</h3>
          <p className="text-sm text-gray-600 mb-2">{t('sellerBalances.historyHint')}</p>
          <div className="flex flex-wrap gap-2 mb-3">
            <input
              type="date"
              className="border rounded-lg px-3 py-2 min-h-11"
              value={fromYmd}
              onChange={(e) => setFromYmd(e.target.value)}
            />
            <input
              type="date"
              className="border rounded-lg px-3 py-2 min-h-11"
              value={toYmd}
              onChange={(e) => setToYmd(e.target.value)}
            />
          </div>
          <TableScroll minWidth="720px">
            <table className="min-w-[720px] w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="p-2">{t('sellerBalances.colDate')}</th>
                  <th className="p-2">{t('sellerBalances.colRecorded')}</th>
                  <th className="p-2">{t('sellerBalances.colType')}</th>
                  <th className="p-2">{t('sellerBalances.colAmount')}</th>
                  <th className="p-2">{t('sellerBalances.colOrder')}</th>
                  <th className="p-2">{t('sellerBalances.colComment')}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id} className="border-b">
                    <td className="p-2">{row.accrued_at}</td>
                    <td className="p-2">{row.created_at}</td>
                    <td className="p-2">{t(`sellerBalances.type.${row.entry_type}`)}</td>
                    <td className="p-2">{money(Number(row.amount))}</td>
                    <td className="p-2">{row.order_id || '—'}</td>
                    <td className="p-2">{row.comment || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </section>
      ) : null}
    </div>
  );
}
