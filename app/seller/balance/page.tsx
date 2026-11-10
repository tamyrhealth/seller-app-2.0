'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Protected from '@/components/Protected';
import NavSeller from '@/components/NavSeller';
import TableScroll from '@/components/TableScroll';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { getTodayLocalISO } from '@/lib/datetime';
import {
  SELLER_MY_BALANCE,
  SELLER_MY_LEDGER,
  asSellerBalance,
  cashHistoryToTimestamp,
  cashOperationTimestamp,
  emptySellerBalance,
  formatTariffAmount,
  rpcItems,
  type SellerBalanceRow,
  type SellerLedgerEntry,
} from '@/lib/sellerCommission';

function money(value: number) {
  return formatTariffAmount(value, '0 ₸');
}

export default function SellerBalancePage() {
  const { profile } = useAuth();
  const { t } = useTranslation();
  const today = getTodayLocalISO('Asia/Almaty');
  const [row, setRow] = useState<SellerBalanceRow | null>(null);
  const [history, setHistory] = useState<SellerLedgerEntry[]>([]);
  const [fromYmd, setFromYmd] = useState('2020-01-01');
  const [toYmd, setToYmd] = useState(today);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setMessage('');
    const { data, error } = await supabase.rpc(SELLER_MY_BALANCE);
    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }
    setRow(asSellerBalance(data) ?? emptySellerBalance(profile?.id || ''));
    const { data: ledger, error: ledgerErr } = await supabase.rpc(SELLER_MY_LEDGER, {
      p_from: cashOperationTimestamp(fromYmd),
      p_to: cashHistoryToTimestamp(toYmd),
    });
    if (ledgerErr) {
      setMessage(ledgerErr.message);
      setHistory([]);
    } else {
      setHistory(rpcItems<SellerLedgerEntry>(ledger));
    }
    setLoading(false);
  }, [fromYmd, toYmd, profile?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const balance = row?.balance ?? 0;

  return (
    <Protected role="seller">
      <div className="min-h-screen pb-24 md:pb-4 w-full max-w-full overflow-x-hidden bg-white">
        <NavSeller />
        <div className="p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <h1 className="text-lg sm:text-2xl font-bold text-gray-900">{t('sellerBalances.myTitle')}</h1>
            <Link href="/seller/debts" className="text-sm text-blue-800">
              {t('nav.debts')}
            </Link>
          </div>
          <p className="text-sm text-slate-700 mb-3">{t('sellerBalances.sellerHint')}</p>
          {message ? <p className="text-sm text-red-700 mb-3">{message}</p> : null}
          {loading ? <p className="text-gray-600">{t('sellerBalances.loading')}</p> : null}
          {row ? (
            <div className="rounded-xl border border-gray-200 p-4 mb-4">
              <p className={`text-lg font-semibold ${balance < 0 ? 'text-rose-800' : 'text-emerald-800'}`}>
                {balance >= 0 ? t('sellerBalances.companyOwes') : t('sellerBalances.sellerOwes')}: {money(balance)}
              </p>
              <div className="grid grid-cols-2 gap-2 text-sm mt-3">
                <div>{t('sellerBalances.accrued')}: {money(row.accrued)}</div>
                <div>{t('sellerBalances.reversed')}: {money(row.reversed)}</div>
                <div>{t('sellerBalances.paid')}: {money(row.paid)}</div>
                <div>{t('sellerBalances.advances')}: {money(row.advances)}</div>
                <div>{t('sellerBalances.goods')}: {money(row.goods)}</div>
                <div>{t('sellerBalances.adjustments')}: {money(row.adjustments)}</div>
              </div>
            </div>
          ) : null}
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
          <TableScroll minWidth="640px">
            <table className="min-w-[640px] w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="p-2">{t('sellerBalances.colDate')}</th>
                  <th className="p-2">{t('sellerBalances.colType')}</th>
                  <th className="p-2">{t('sellerBalances.colAmount')}</th>
                  <th className="p-2">{t('sellerBalances.colComment')}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.id} className="border-b">
                    <td className="p-2">{entry.accrued_at}</td>
                    <td className="p-2">{t(`sellerBalances.type.${entry.entry_type}`)}</td>
                    <td className="p-2">{money(Number(entry.amount))}</td>
                    <td className="p-2">{entry.comment || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </div>
      </div>
    </Protected>
  );
}
