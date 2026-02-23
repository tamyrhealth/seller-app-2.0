export type Role = 'admin' | 'seller';

export type Profile = {
  id: string;
  display_name: string | null;
  role: Role;
  city_id: string | null;
  is_active?: boolean;
};

export type PaymentType = 'cash' | 'kaspi' | 'card' | 'transfer';

export type Product = {
  id: string;
  name: string;
  price_retail: number;
  is_active: boolean;
};