# Apply idempotent run_*.sql to STAGING only. Never writes to PROD_DB_URI.
#
# In this PowerShell window:
#   . .\.env.staging.ps1   # or set env vars yourself
#   $env:STAGING_DB_URI = "..."
#   $env:STAGING_PROJECT_REF = "abcdxyz"
# Optional:
#   $env:PROD_DB_URI / $env:PROD_PROJECT_REF  — used only to refuse accidental prod target

$ErrorActionPreference = "Stop"
if (-not $env:STAGING_DB_URI) { throw "Set STAGING_DB_URI in this session." }
if (-not $env:STAGING_PROJECT_REF) { throw "Set STAGING_PROJECT_REF (Supabase project ref of STAGING)." }
if ($env:STAGING_DB_URI -notmatch [regex]::Escape($env:STAGING_PROJECT_REF)) {
  throw "STAGING_DB_URI does not contain STAGING_PROJECT_REF. Refusing."
}
if ($env:PROD_DB_URI -and ($env:STAGING_DB_URI -eq $env:PROD_DB_URI)) {
  throw "STAGING_DB_URI equals PROD_DB_URI. Refusing."
}
if ($env:PROD_PROJECT_REF -and ($env:STAGING_PROJECT_REF -eq $env:PROD_PROJECT_REF)) {
  throw "STAGING_PROJECT_REF equals PROD_PROJECT_REF. Refusing."
}

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) { throw "psql not on PATH." }

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$files = @(
  "supabase\run_cities_is_active.sql",
  "supabase\run_confirm_order_idempotency.sql",
  "supabase\run_order_cancel_numbers_history.sql",
  "supabase\run_client_operations_inventory.sql",
  "supabase\run_stock_transfers.sql",
  "supabase\run_stock_transfer_partial_receive.sql",
  "supabase\run_product_cost_shortage_snapshot.sql",
  "supabase\run_manager_assistant_chats.sql",
  "supabase\run_assistant_chat_numbers.sql",
  "supabase\run_fix_assistant_message_count_guard.sql",
  "supabase\run_assistant_ai_generations.sql",
  "supabase\run_assistant_order_drafts.sql"
)

Write-Host "Target staging ref: $($env:STAGING_PROJECT_REF)"
foreach ($rel in $files) {
  $path = Join-Path $root $rel
  if (-not (Test-Path $path)) { throw "Missing $rel" }
  Write-Host "APPLY $rel"
  & psql $env:STAGING_DB_URI --set ON_ERROR_STOP=1 --file=$path
  if ($LASTEXITCODE -ne 0) { throw "Failed $rel exit $LASTEXITCODE" }
}

$assert = Join-Path $PSScriptRoot "assert_is_staging.sql"
& psql $env:STAGING_DB_URI --set ON_ERROR_STOP=1 --file=$assert
if ($LASTEXITCODE -ne 0) { throw "assert_is_staging failed" }

Write-Host "All run_*.sql applied on staging."
