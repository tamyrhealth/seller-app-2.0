# 5.20.2B/C preorder reserve — Production SQL only when explicitly allowed

Do not apply until go-ahead. Do not re-run Phase 2. Do not re-run P0 5.20.1.

## Safe order

1. Backup: `backup_main.ps1`
2. Read-only inspect: `inspect_block5202a_readonly.sql` (qty_reserved absent, wrappers present)
3. Preflight: `pre_apply_inspect_block5202a.sql` — expect PASS: Phase 2 wrap, P0 write trigger, no `qty_reserved`
4. **SQL first** (one transaction): `run_preorder_inventory_reserve.sql`
   - Adds columns, helpers, replaces `__session_body` / goods/transfer bodies only
   - Backfills pending reserves without changing statuses, payments, commissions, movements
   - Does not replace `confirm_order` / `fulfill_preorder` / `cancel_order` wrappers
5. Postflight: `post_apply_verify_block5202a.sql` — reserved ≤ physical, helpers not executable by JWT, wrappers still assert session
6. **Then** publish client that selects `qty_reserved` (demand panel, catalog). Old client + new SQL is safe (RPC already uses available). New client + old SQL will error on `qty_reserved` in selects.
7. Do not ship the local invoice-parser leftover in this commit unless separately approved.

Rollback: `rollback_block5202a.sql` restores dump `20261111-131616` session bodies, drops helpers/columns. Does not drop Phase 2 wrappers or P0 triggers.

Do not apply from this audit step.
