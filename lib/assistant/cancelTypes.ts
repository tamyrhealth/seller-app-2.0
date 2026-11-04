export type CancelPreviewItem = {
  name: string;
  qty: number;
  is_gift: boolean;
};

export type CancelPreview = {
  order_id: string;
  order_number: string;
  seller_name: string | null;
  city_name: string | null;
  created_at: string;
  status: string;
  payment_label: string;
  total_sum: number;
  is_preorder: boolean;
  is_debt: boolean;
  items: CancelPreviewItem[];
  will_return_stock: boolean;
  stock_note: string;
  can_cancel: boolean;
  errors: { code: string; message: string }[];
};

export type CancelCardState = 'preview' | 'confirmed' | 'dismissed' | 'blocked';
