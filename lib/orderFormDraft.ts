'use client';

import { useEffect, useRef, useState } from 'react';
import { clearUserUi, readUserUi, writeUserUi } from '@/lib/uiStorage';
import type { PaymentType } from '@/lib/types';

export type OrderFormDraft = {
  selectedSellerId?: string;
  search: string;
  cart: Array<{
    product_id: string;
    product_name: string;
    price_retail: number;
    qty: number;
    customPrice: string;
    qty_on_hand: number;
    unit: string;
  }>;
  paymentType: PaymentType | '';
  comment: string;
  orderType: 'ordinary' | 'preorder' | 'debt';
  pickupDate: string;
  debtCustomerPhone: string;
  debtCustomerName: string;
  debtDueAt: string;
  debtNote: string;
};

export function emptyOrderFormDraft(): OrderFormDraft {
  return {
    selectedSellerId: '',
    search: '',
    cart: [],
    paymentType: '',
    comment: '',
    orderType: 'ordinary',
    pickupDate: '',
    debtCustomerPhone: '',
    debtCustomerName: '',
    debtDueAt: '',
    debtNote: '',
  };
}

export function isOrderFormDraftEmpty(draft: OrderFormDraft): boolean {
  return (
    !draft.selectedSellerId &&
    !draft.search.trim() &&
    draft.cart.length === 0 &&
    !draft.paymentType &&
    !draft.comment.trim() &&
    draft.orderType === 'ordinary' &&
    !draft.pickupDate &&
    !draft.debtCustomerPhone.trim() &&
    !draft.debtCustomerName.trim() &&
    !draft.debtDueAt &&
    !draft.debtNote.trim()
  );
}

export function useOrderFormDraft(
  userId: string | undefined,
  formId: 'staff-new-order' | 'seller-new-order',
  snapshot: OrderFormDraft,
  apply: (draft: OrderFormDraft) => void
) {
  const [hydrated, setHydrated] = useState(false);
  const applyRef = useRef(apply);
  const snapshotRef = useRef(snapshot);
  const restoredForRef = useRef<string | null>(null);
  applyRef.current = apply;
  snapshotRef.current = snapshot;

  useEffect(() => {
    if (!userId) return;
    if (restoredForRef.current === userId) {
      setHydrated(true);
      return;
    }
    const current = snapshotRef.current;
    const saved = readUserUi<OrderFormDraft>(userId, formId);
    if (saved && !isOrderFormDraftEmpty(saved) && isOrderFormDraftEmpty(current)) {
      applyRef.current(saved);
    }
    restoredForRef.current = userId;
    setHydrated(true);
  }, [userId, formId]);

  const encoded = JSON.stringify(snapshot);
  useEffect(() => {
    if (!userId || !hydrated) return;
    const current = JSON.parse(encoded) as OrderFormDraft;
    if (isOrderFormDraftEmpty(current)) clearUserUi(userId, formId);
    else writeUserUi(userId, formId, current);
  }, [userId, formId, encoded, hydrated]);
}

export function clearOrderFormDraft(userId: string | undefined, formId: 'staff-new-order' | 'seller-new-order') {
  clearUserUi(userId, formId);
}
