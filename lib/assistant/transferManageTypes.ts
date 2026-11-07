export type TransferManageKind = 'lookup' | 'list' | 'receive' | 'return_remainder' | 'shortage';

export type TransferManageIssue = { code: string; message: string };

export type TransferManageLine = {
  product_id: string;
  name: string;
  unit: string | null;
  qty_sent: number;
  qty_received: number;
  qty_returned: number;
  qty_lost: number;
  remaining: number;
  action_qty: number;
};

export type TransferManageEvent = {
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  created_at: string;
  reason: string | null;
};

export type TransferManagePreview = {
  kind: TransferManageKind;
  can_confirm: boolean;
  transfer_id: string | null;
  transfer_number: string | null;
  from_city_name: string | null;
  to_city_name: string | null;
  status: string | null;
  created_by_name: string | null;
  created_at: string | null;
  remaining: number;
  items: TransferManageLine[];
  events: TransferManageEvent[];
  list: { transfer_number: string; from_city_name: string; to_city_name: string; status: string; remaining: number }[];
  reason: string | null;
  errors: TransferManageIssue[];
  operation_id: string;
};
