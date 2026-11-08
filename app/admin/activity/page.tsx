'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import { supabase } from '@/lib/supabaseClient';
import { useTranslation } from '@/lib/i18n';
import { addDaysYmd, getTodayLocalISO } from '@/lib/datetime';
import {
  orderHistoryActionLabel,
  orderHistoryActorLabel,
  orderHistoryPaymentLabel,
} from '@/lib/orderActionHistory';
import type { Profile } from '@/lib/types';
import {
  ACTIVITY_ACTION_VALUES,
  ACTIVITY_PAGE_SIZE,
  activityCancelReturnedStock,
  activityItems,
  activityOrderHref,
  activityOrderNumber,
  activityPageRange,
  activitySumDisplay,
  fetchAdminOrderActivity,
  isActivityDateRangeInvalid,
  type ActivityLogRow,
} from '@/lib/adminActivity';

function formatMoney(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

function formatDate(s: string) {
  return new Date(s).toLocaleString('ru-KZ', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function AdminActivityPage() {
  const { t } = useTranslation();
  const today = getTodayLocalISO();
  const [fromYmd, setFromYmd] = useState(() => addDaysYmd(today, -6));
  const [toYmd, setToYmd] = useState(today);
  const [userId, setUserId] = useState('');
  const [action, setAction] = useState('');
  const [numberSearch, setNumberSearch] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<ActivityLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Pick<Profile, 'id' | 'display_name' | 'role'>[]>([]);

  const dateRangeInvalid = isActivityDateRangeInvalid(fromYmd, toYmd);
  const pageCount = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE));
  const safePage = activityPageRange(page).page;

  const resetPage = useCallback((updater: () => void) => {
    updater();
    setPage(1);
  }, []);

  useEffect(() => {
    supabase
      .from('profiles')
      .select('id, display_name, role')
      .order('display_name')
      .then(({ data }) => setProfiles((data || []) as Pick<Profile, 'id' | 'display_name' | 'role'>[]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      if (dateRangeInvalid) {
        setRows([]);
        setTotal(0);
        setLoading(false);
        return;
      }
      const result = await fetchAdminOrderActivity(supabase, {
        fromYmd,
        toYmd,
        userId,
        action,
        numberSearch,
        page,
      });
      if (cancelled) return;
      if (result.error === 'date_range_invalid') {
        setRows([]);
        setTotal(0);
        setError(t('admin.dateRangeInvalid'));
      } else if (result.error) {
        setRows([]);
        setTotal(0);
        setError(result.error);
      } else {
        setRows(result.rows);
        setTotal(result.total);
      }
      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [fromYmd, toYmd, userId, action, numberSearch, page, dateRangeInvalid, t]);

  const actionOptions = useMemo(
    () =>
      ACTIVITY_ACTION_VALUES.map((value) => ({
        value,
        label: orderHistoryActionLabel(value),
      })),
    []
  );

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-white">
        <NavAdmin />
        <div className="p-4 max-w-4xl mx-auto">
          <h1 className="text-2xl font-bold mb-4 text-gray-900">{t('admin.activityTitle')}</h1>
          <p className="text-sm text-gray-600 mb-4">{t('admin.activityHint')}</p>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            <label className="flex items-center gap-1">
              <span className="text-sm text-gray-600">{t('admin.fromDate')}</span>
              <input
                type="date"
                value={fromYmd}
                onChange={(e) => resetPage(() => setFromYmd(e.target.value))}
                className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 bg-white"
              />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-sm text-gray-600">{t('admin.toDate')}</span>
              <input
                type="date"
                value={toYmd}
                onChange={(e) => resetPage(() => setToYmd(e.target.value))}
                className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 bg-white"
              />
            </label>
            <select
              value={userId}
              onChange={(e) => resetPage(() => setUserId(e.target.value))}
              className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 bg-white min-w-[10rem]"
            >
              <option value="">{t('admin.allUsers')}</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {orderHistoryActorLabel(p.display_name, p.role)}
                </option>
              ))}
            </select>
            <select
              value={action}
              onChange={(e) => resetPage(() => setAction(e.target.value))}
              className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 bg-white min-w-[12rem]"
            >
              <option value="">{t('admin.allActions')}</option>
              {actionOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <input
              type="search"
              value={numberSearch}
              onChange={(e) => resetPage(() => setNumberSearch(e.target.value))}
              placeholder={t('admin.searchNumber')}
              className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 bg-white w-full sm:w-48"
            />
          </div>

          {dateRangeInvalid ? (
            <p className="text-sm text-red-700 mb-3">{t('admin.dateRangeInvalid')}</p>
          ) : null}
          {error ? (
            <p className="text-sm text-red-700 mb-3">
              {t('admin.activityError')}: {error}
            </p>
          ) : null}
          {loading ? <p className="text-sm text-gray-600 mb-3">{t('admin.activityLoading')}</p> : null}
          {!loading && !error && !dateRangeInvalid && rows.length === 0 ? (
            <p className="text-sm text-gray-600 mb-3">{t('admin.activityEmpty')}</p>
          ) : null}

          <ul className="space-y-2">
            {rows.map((row) => {
              const details = row.details || {};
              const items = activityItems(details);
              const sumDisplay = activitySumDisplay(row.action, details);
              const number = activityOrderNumber(details);
              const href = activityOrderHref(row.entity_id);
              const reason = typeof details.reason === 'string' ? details.reason.trim() : '';
              const payment = orderHistoryPaymentLabel(
                (typeof details.payment_method === 'string' && details.payment_method) ||
                  (typeof details.payment_type === 'string' ? details.payment_type : null)
              );
              const returned = activityCancelReturnedStock(details);
              return (
                <li key={row.id} className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-sm font-medium text-gray-900">
                    {formatDate(row.created_at)} · {orderHistoryActionLabel(row.action, details)}
                  </p>
                  <p className="text-xs text-gray-600">
                    {t('admin.historyWho')}: {orderHistoryActorLabel(row.user_name, row.user_role)}
                  </p>
                  <p className="text-sm text-gray-900">
                    {t('admin.orderNumber')}: {number || t('admin.activityNoNumber')}
                    {href ? (
                      <>
                        {' · '}
                        <Link href={href} className="text-blue-700 underline">
                          {t('admin.activityOpenOrder')}
                        </Link>
                      </>
                    ) : null}
                  </p>
                  {sumDisplay.kind === 'unrecorded' ? (
                    <p className="text-sm text-gray-900">{t('admin.sumNotRecorded')}</p>
                  ) : sumDisplay.kind === 'value' ? (
                    <p className="text-sm text-gray-900">
                      {t('admin.historySum')}: {formatMoney(sumDisplay.value)} ₸
                    </p>
                  ) : null}
                  {payment ? (
                    <p className="text-sm text-gray-900">
                      {t('admin.historyPayment')}: {payment}
                    </p>
                  ) : null}
                  {reason ? (
                    <p className="text-sm text-gray-900">
                      {t('admin.historyReason')}: {reason}
                    </p>
                  ) : null}
                  {returned === true ? (
                    <p className="text-xs text-gray-700">{t('admin.activityStockReturned')}</p>
                  ) : null}
                  {returned === false ? (
                    <p className="text-xs text-gray-700">{t('admin.activityStockUnchanged')}</p>
                  ) : null}
                  {items.length > 0 ? (
                    <ul className="mt-1 space-y-0.5 text-xs text-gray-800">
                      {items.map((item, idx) => (
                        <li key={`${row.id}-${idx}`}>
                          {item.name} × {item.qty}
                          {item.is_gift
                            ? ` ${t('common.gift')}`
                            : item.line_sum != null
                              ? ` = ${formatMoney(item.line_sum)} ₸`
                              : ''}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {!loading && total > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-2 rounded-lg bg-gray-200 text-gray-900 text-sm font-medium disabled:opacity-50"
              >
                {t('admin.activityPrev')}
              </button>
              <span className="text-sm text-gray-700">
                {t('admin.activityPage')} {safePage} / {pageCount}
              </span>
              <button
                type="button"
                disabled={safePage >= pageCount}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-2 rounded-lg bg-gray-200 text-gray-900 text-sm font-medium disabled:opacity-50"
              >
                {t('admin.activityNext')}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </Protected>
  );
}
