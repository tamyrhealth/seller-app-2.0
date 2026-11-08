export function orderCustomerDisplay(order: {
  customer_name?: string | null;
  customer_phone?: string | null;
  debt_customer_name?: string | null;
  debt_customer_phone?: string | null;
}): string {
  const name = String(order.customer_name || order.debt_customer_name || '').trim();
  const phone = String(order.customer_phone || order.debt_customer_phone || '').trim();
  return [name, phone].filter(Boolean).join(' · ') || '—';
}

export function applyCustomerToConfirmPayload(
  payload: Record<string, unknown>,
  input: {
    isDebt: boolean;
    name: string | null;
    phone: string | null;
    debtDueAt?: string | null;
    debtNote?: string | null;
  }
) {
  if (input.name) payload.customer_name = input.name;
  if (input.phone) payload.customer_phone = input.phone;
  if (input.isDebt) {
    payload.is_debt = true;
    payload.debt_customer_phone = input.phone;
    payload.debt_customer_name = input.name;
    payload.debt_due_at = input.debtDueAt ?? null;
    payload.debt_note = input.debtNote ?? null;
  }
}
