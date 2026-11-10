'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Protected from '@/components/Protected';
import NavSeller from '@/components/NavSeller';
import TableScroll from '@/components/TableScroll';
import { supabase } from '@/lib/supabaseClient';
import { useTranslation } from '@/lib/i18n';
import {
  SELLER_MY_GOODS_ISSUES,
  asSellerGoodsIssue,
  formatTariffAmount,
  rpcItems,
  type SellerGoodsIssue,
} from '@/lib/sellerCommission';

function money(value: number) {
  return formatTariffAmount(value, '0 ₸');
}

export default function SellerGoodsPage() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<SellerGoodsIssue[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc(SELLER_MY_GOODS_ISSUES);
    if (error) {
      setMessage(error.message);
      setRows([]);
    } else {
      setRows(
        rpcItems<Record<string, unknown>>(data)
          .map((item) => asSellerGoodsIssue(item))
          .filter((row): row is SellerGoodsIssue => row != null),
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Protected role="seller">
      <div className="min-h-screen pb-24 md:pb-4 w-full max-w-full overflow-x-hidden bg-white">
        <NavSeller />
        <div className="p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <h1 className="text-lg sm:text-2xl font-bold text-gray-900">{t('sellerGoods.myTitle')}</h1>
            <Link href="/seller/balance" className="text-sm text-blue-800">
              {t('sellerBalances.myTitle')}
            </Link>
          </div>
          <p className="text-sm text-slate-700 mb-3">{t('sellerGoods.sellerHint')}</p>
          {message ? <p className="text-sm text-red-700 mb-3">{message}</p> : null}
          {loading ? <p className="text-sm">{t('sellerBalances.loading')}</p> : null}
          <div className="lg:hidden space-y-3">
            {rows.map((issue) => (
              <div key={issue.id} className="rounded-xl border border-gray-200 p-3 text-sm">
                <div className="font-medium">
                  {issue.issue_number} · {t(`sellerGoods.status.${issue.status}`)}
                </div>
                <div>
                  {issue.city_name} · {money(issue.credit_amount)}
                </div>
              </div>
            ))}
          </div>
          <div className="hidden lg:block">
            <TableScroll minWidth="640px">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-600">
                    <th className="p-2">{t('sellerGoods.colNumber')}</th>
                    <th className="p-2">{t('sellerGoods.colStatus')}</th>
                    <th className="p-2">{t('sellerGoods.warehouse')}</th>
                    <th className="p-2">{t('sellerGoods.previewCredit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((issue) => (
                    <tr key={issue.id} className="border-t border-gray-100">
                      <td className="p-2">{issue.issue_number}</td>
                      <td className="p-2">{t(`sellerGoods.status.${issue.status}`)}</td>
                      <td className="p-2">{issue.city_name}</td>
                      <td className="p-2">{money(issue.credit_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </div>
        </div>
      </div>
    </Protected>
  );
}
