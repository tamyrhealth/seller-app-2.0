# Local read-only backup of MAIN Seller App (project vkdoosnksmezigdrqsxx).
# Uses Session pooler (not Direct). Creates files under supabase/prod/_generated/ only.
# Does not run INSERT/UPDATE/DELETE, DROP, TRUNCATE, or pg_restore --dbname.
# pg_restore is used only as: pg_restore --list <file> (no database connection).
#
# In this PowerShell session (do not paste the URI into chat or git):
#   $env:PROD_DB_URI = "postgresql://postgres.vkdoosnksmezigdrqsxx:<URL-ENCODED-PASSWORD>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require"

$ErrorActionPreference = "Stop"
$ExpectedProjectRef = "vkdoosnksmezigdrqsxx"
$ExpectedPoolerHost = "aws-1-ap-northeast-2.pooler.supabase.com"
$ExpectedUser = "postgres.$ExpectedProjectRef"
$ExpectedPort = "5432"
$ExpectedDb = "postgres"

function Get-PgUriParts([string]$Uri) {
  # user:password@host:port/db — password may be URL-encoded and contain ':'
  if ($Uri -notmatch '^(?:postgres(?:ql)?):\/\/([^:/@]+):([^@]*)@([^/:?]+)(?::(\d+))?(?:\/([^?]+))?') {
    throw "PROD_DB_URI is not a valid postgresql URI."
  }
  $db = $Matches[5]
  if ($db) { $db = $db.Trim() }
  return @{
    User = $Matches[1]
    Host = $Matches[3]
    Port = $(if ($Matches[4]) { $Matches[4] } else { "5432" })
    Database = $(if ($db) { $db } else { "postgres" })
  }
}

function Invoke-PgReadOnly {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList
  )
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "Install PostgreSQL client tools so '$Name' is on PATH. Reopen PowerShell after install."
  }
  & $cmd.Source @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE. Backup aborted. No files were restored to the database."
  }
}

if (-not $env:PROD_DB_URI) {
  throw "Set PROD_DB_URI in this session only. Do not write it into repo files."
}

if ($env:PROD_DB_URI -match "staging") {
  throw "Refusing to run: URI contains 'staging'."
}

$parsed = Get-PgUriParts $env:PROD_DB_URI
if ($parsed.Host -ne $ExpectedPoolerHost) {
  throw "Refusing to run: host is not the main-project Session pooler. No dump started."
}
if ($parsed.User -ne $ExpectedUser) {
  throw "Refusing to run: user is not the main Seller App project. No dump started."
}
if ($parsed.Port -ne $ExpectedPort) {
  throw "Refusing to run: use Session pooler port $ExpectedPort, not $($parsed.Port)."
}
if ($parsed.Database -ne $ExpectedDb) {
  throw "Refusing to run: database name must be $ExpectedDb."
}

foreach ($tool in @("pg_dump", "psql", "pg_restore")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "Install PostgreSQL client tools so $tool is on PATH."
  }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outDir = Join-Path $PSScriptRoot "_generated\$stamp"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$schemaFile = Join-Path $outDir "public_schema.sql"
$dataFile = Join-Path $outDir "public_data.sql"
$customFile = Join-Path $outDir "public_full.backup"
$fnFile = Join-Path $outDir "confirm_order_before.sql"
$listFile = Join-Path $outDir "public_full.list.txt"

Write-Host "Backup project: $ExpectedProjectRef"
Write-Host "Backup path: Session pooler $ExpectedPoolerHost port $ExpectedPort"
Write-Host "Output: $outDir"
Write-Host "Mode: dump only (no restore to database)"

Invoke-PgReadOnly pg_dump @(
  $env:PROD_DB_URI,
  "--schema-only",
  "--no-owner",
  "--schema=public",
  "--encoding=UTF8",
  "--file=$schemaFile"
)

Invoke-PgReadOnly pg_dump @(
  $env:PROD_DB_URI,
  "--data-only",
  "--schema=public",
  "--encoding=UTF8",
  "--file=$dataFile"
)

Invoke-PgReadOnly pg_dump @(
  $env:PROD_DB_URI,
  "--format=custom",
  "--no-owner",
  "--schema=public",
  "--file=$customFile"
)

$fnSql = @"
SELECT pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'confirm_order';
"@
$fnSql | & (Get-Command psql).Source @(
  $env:PROD_DB_URI,
  "--set", "ON_ERROR_STOP=1",
  "--no-align",
  "--tuples-only",
  "--output=$fnFile"
)
if ($LASTEXITCODE -ne 0) {
  throw "psql function dump failed with exit code $LASTEXITCODE (read-only SELECT). Backup aborted."
}

foreach ($f in @($schemaFile, $dataFile, $customFile, $fnFile)) {
  if (-not (Test-Path $f) -or (Get-Item $f).Length -le 0) {
    throw "Dump file missing or empty: $([IO.Path]::GetFileName($f)). Backup is incomplete."
  }
}

# Integrity check of custom archive. --list reads the file only; it does not connect to a database.
Invoke-PgReadOnly pg_restore @(
  "--list",
  $customFile
) | Tee-Object -FilePath $listFile | Out-Null

if (-not (Test-Path $listFile) -or (Get-Item $listFile).Length -le 0) {
  throw "pg_restore --list produced an empty TOC. Custom dump is not usable."
}

$listText = Get-Content -Raw -Encoding UTF8 $listFile
if ($listText -notmatch "\sorders\s" -or $listText -notmatch "\sinventory\s" -or $listText -notmatch "confirm_order") {
  throw "pg_restore --list is missing orders, inventory, or confirm_order. Custom dump looks incomplete."
}

Write-Host "OK: local backup complete. Files:"
Get-ChildItem $outDir | Format-Table Name, Length, LastWriteTime
Write-Host "Verified custom dump with pg_restore --list (no database connection)."
Write-Host "Password/URI were not written to the console."
