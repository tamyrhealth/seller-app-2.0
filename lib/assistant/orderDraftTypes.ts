import type { PaymentType } from '@/lib/types';

export type DraftStatus = 'preview' | 'blocked' | 'confirming' | 'confirmed' | 'cancelled';

export type DraftIssue = { code: string; message: string };

export type DraftCandidate = { id: string; name: string; price?: number };

export type DraftItemResolved = {
  raw_name: string;
  product_id: string | null;
  product_name: string | null;
  unit: string | null;
  qty: number;
  price: number;
  is_gift: boolean;
  stock: number | null;
  line_sum: number;
  unresolved: boolean;
  candidates?: DraftCandidate[];
};

export type DraftResolved = {
  seller_id: string | null;
  seller_name: string | null;
  seller_candidates?: { id: string; name: string; city: string }[];
  city_id: string | null;
  city_name: string | null;
  city_candidates?: string[];
  payment_type: PaymentType | null;
  payment_raw: string;
  is_debt: boolean;
  is_preorder: boolean;
  pickup_date: string | null;
  invoice_date: string | null;
  invoice_time: string | null;
  comment: string | null;
  debt_customer_name: string | null;
  debt_due_at: string | null;
  debt_note: string | null;
  items: DraftItemResolved[];
  total_sum: number;
};

export type DraftPreviewItem = {
  name: string;
  qty: number;
  price: number;
  is_gift: boolean;
  line_sum: number;
  unresolved: boolean;
  candidates?: DraftCandidate[];
};

export type DraftPreview = {
  seller_name: string | null;
  city_name: string | null;
  items: DraftPreviewItem[];
  total_sum: number;
  total_ready: boolean;
  payment_label: string;
  is_debt: boolean;
  is_preorder: boolean;
  invoice_date: string | null;
  invoice_time: string | null;
  pickup_date: string | null;
};

export type AssistantDraftRow = {
  id: string;
  chat_id: string;
  owner_id: string;
  created_by: string;
  user_message_id: string | null;
  assistant_message_id: string | null;
  status: DraftStatus;
  can_confirm: boolean;
  warnings: DraftIssue[];
  errors: DraftIssue[];
  preview: DraftPreview;
  resolved?: DraftResolved;
  order_id: string | null;
  order_number: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
};
