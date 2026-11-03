# Dump schema-only from production, restore to staging.
# Does NOT dump table data (no orders, phones, PII).
# Does NOT apply idempotency migration.
#
# Before running, in THIS PowerShell window only:
#   $env:PROD_DB_URI = "postgresql://postgres:<URL-ENCODED-PASSWORD>@db.<PROD-REF>.supabase.co:5432/postgres"
#   $env:STAGING_DB_URI = "postgresql://postgres:<URL-ENCODED-PASSWORD>@db.<STAGING-REF>.supabase.co:5432/postgres"
# Use Direct connection (port 5432), not pooler 6543.

$ErrorActionPreference = "Stop"

if (-not $env:PROD_DB_URI -or -not $env:STAGING_DB_URI) {
  throw "Set PROD_DB_URI and STAGING_DB_URI in this session. Do not commit them."
}
if ($env:PROD_DB_URI -eq $env:STAGING_DB_URI) {
  throw "PROD_DB_URI and STAGING_DB_URI must be different."
}
if (-not $env:STAGING_PROJECT_REF) { throw "Set STAGING_PROJECT_REF." }
if ($env:STAGING_DB_URI -notmatch [regex]::Escape($env:STAGING_PROJECT_REF)) {
  throw "STAGING_DB_URI does not contain STAGING_PROJECT_REF. Refusing restore to unknown host."
}
if ($env:PROD_PROJECT_REF -and ($env:STAGING_DB_URI -match [regex]::Escape($env:PROD_PROJECT_REF))) {
  throw "STAGING_DB_URI contains PROD_PROJECT_REF. Refusing."
}

$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $pgDump -or -not $psql) {
  throw "Install PostgreSQL client tools (pg_dump, psql) and reopen PowerShell so they are on PATH."
}

$outDir = Join-Path $PSScriptRoot "_generated"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$dumpFile = Join-Path $outDir "public_schema_only.sql"

Write-Host "Dumping production schema public (no data) -> $dumpFile"
& pg_dump $env:PROD_DB_URI `
  --schema-only `
  --no-owner `
  --schema=public `
  --encoding=UTF8 `
  --file=$dumpFile
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with $LASTEXITCODE" }

$dumpText = Get-Content -Raw -Encoding UTF8 $dumpFile
if ($dumpText -match "COPY public\.(orders|order_items)\b") {
  throw "Dump unexpectedly contains COPY data. Abort. Do not restore."
}

Write-Host "Restoring schema to STAGING only"
& psql $env:STAGING_DB_URI --set ON_ERROR_STOP=1 --file=$dumpFile
if ($LASTEXITCODE -ne 0) { throw "psql restore failed with $LASTEXITCODE" }

Write-Host "Done schema-only restore. Next:"
Write-Host "  1. supabase/staging/assert_is_staging.sql"
Write-Host "  2. supabase/staging/apply_run_sql.ps1  (5.1 … 5.2.2)"
Write-Host "  3. create auth users, then seed_synthetic.sql"
Write-Host "This script does not write to production."
