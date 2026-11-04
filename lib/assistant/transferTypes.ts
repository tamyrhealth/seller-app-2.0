export type TransferDraftStatus = 'preview' | 'blocked' | 'confirming' | 'confirmed' | 'cancelled';

export type TransferIssue = { code: string; message: string };

export type TransferCandidate = { id: string; name: string };

export type TransferItemResolved = {
  raw_name: string;
  product_id: string | null;
  product_name: string | null;
  unit: string | null;
  qty: number;
  stock: number | null;
  unresolved: boolean;
  candidates?: TransferCandidate[];
};

export type TransferResolved = {
  from_city_id: string | null;
  from_city_name: string | null;
  from_city_candidates?: string[];
  to_city_id: string | null;
  to_city_name: string | null;
  to_city_candidates?: string[];
  comment: string | null;
  items: TransferItemResolved[];
};

export type TransferPreview = {
  from_city_name: string | null;
  to_city_name: string | null;
  items: {
    name: string;
    qty: number;
    unit: string | null;
    stock: number | null;
    unresolved: boolean;
    candidates?: TransferCandidate[];
  }[];
};

export type TransferPreviewCard = {
  can_confirm: boolean;
  errors: TransferIssue[];
  warnings: TransferIssue[];
  resolved: TransferResolved;
  preview: TransferPreview;
};

export type AssistantTransferDraftRow = {
  id: string;
  chat_id: string;
  owner_id: string;
  created_by: string;
  user_message_id: string | null;
  assistant_message_id: string | null;
  status: TransferDraftStatus;
  can_confirm: boolean;
  warnings: TransferIssue[];
  errors: TransferIssue[];
  preview: TransferPreview;
  resolved: TransferResolved;
  transfer_id: string | null;
  transfer_number: string | null;
};
