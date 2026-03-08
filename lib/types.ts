export type Role = 'admin' | 'seller';

export type City = {
  id: string;
  name: string;
  address?: string | null;
};

export type Profile = {
  id: string;
  display_name: string | null;
  role: Role;
  city_id: string | null;
  is_active?: boolean;
};

export type PaymentType = 'cash' | 'kaspi' | 'card' | 'transfer' | 'debt';

export type Product = {
  id: string;
  name: string;
  price_retail: number;
  is_active: boolean;
};

export type PreorderStatus = 'pending' | 'fulfilled' | 'cancelled';

export type OrderItem = {
  id: string;
  order_id: string;
  product_id: string;
  product_name_snapshot: string;
  price: number;
  qty: number;
  line_sum: number;
  is_gift?: boolean;
};

export type Order = {
  id: string;
  created_at: string;
  updated_at?: string;
  cancelled_at?: string | null;
  seller_id: string;
  city_id: string;
  status: 'confirmed' | 'canceled';
  payment_type: PaymentType | null;
  comment: string | null;
  total_sum: number;
  is_preorder?: boolean;
  preorder_status?: PreorderStatus;
  pickup_date?: string | null;
  fulfilled_at?: string | null;
  is_debt?: boolean;
  debt_status?: 'active' | 'paid' | 'written_off' | null;
  debt_due_at?: string | null;
  debt_paid_at?: string | null;
  debt_payment_method?: string | null;
  debt_customer_name?: string | null;
  debt_customer_phone?: string | null;
  debt_note?: string | null;
  order_items?: OrderItem[];
};