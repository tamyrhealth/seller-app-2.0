$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = 'C:\Program Files\PostgreSQL\17\bin'
$psql = Join-Path $bin 'psql.exe'
$initdb = Join-Path $bin 'initdb.exe'
$pgctl = Join-Path $bin 'pg_ctl.exe'
if (-not (Test-Path $psql)) { Write-Output 'HARNESS_SKIP postgres 17 bin not found'; exit 2 }

$port = 55432
$data = Join-Path $env:TEMP 'seller-5201c-pgdata'
$log = Join-Path $env:TEMP 'seller-5201c-pg.log'
$pwfile = Join-Path $env:TEMP 'seller-5201c-pw.txt'
$bytes = New-Object byte[] 18
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$pw = [Convert]::ToBase64String($bytes)
Set-Content -Path $pwfile -Value $pw -NoNewline -Encoding ascii

if (Test-Path $data) {
  & $pgctl -D $data stop -m fast 2>$null | Out-Null
  Start-Sleep -Seconds 1
  Remove-Item -Recurse -Force $data
}

& $initdb -D $data --username=postgres --pwfile=$pwfile --auth-host=scram-sha-256 --auth-local=scram-sha-256 --encoding=UTF8 --locale=C --no-sync --no-instructions
if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
Remove-Item -Force $pwfile -ErrorAction SilentlyContinue

Add-Content (Join-Path $data 'postgresql.conf') "`nlisten_addresses = '127.0.0.1'`nport = $port`n"

$env:PGPASSWORD = $pw
$env:PGUSER = 'postgres'
$env:PGHOST = '127.0.0.1'
$env:PGPORT = "$port"
$env:PGDATABASE = 'postgres'

try {
  & $pgctl -D $data -l $log start -w -t 20
  if ($LASTEXITCODE -ne 0) {
    if (Test-Path $log) { Get-Content $log -Tail 40 }
    throw 'pg_ctl start failed'
  }

  function Invoke-SqlFile([string]$rel) {
    Get-Content -Raw (Join-Path $root $rel) | & $psql -X -v ON_ERROR_STOP=1 -q
    if ($LASTEXITCODE -ne 0) { throw "psql failed: $rel" }
  }

  Invoke-SqlFile 'scripts/pg_p0_integration_setup.sql'
  Invoke-SqlFile 'supabase/migrations/20261111090000_orders_protect_client_updates.sql'
  Invoke-SqlFile 'scripts/pg_p0_integration_tests.sql'

  $sqlParallel = Get-Content -Raw (Join-Path $root 'scripts/pg_p0_integration_parallel.sql')
  $job1 = Start-Job -ScriptBlock {
    param($psql, $pw, $port, $sql)
    $env:PGPASSWORD = $pw
    $sql | & $psql -h 127.0.0.1 -p $port -U postgres -d postgres -X -v ON_ERROR_STOP=1 -q 2>&1 | Out-String
  } -ArgumentList $psql, $pw, $port, $sqlParallel
  $job2 = Start-Job -ScriptBlock {
    param($psql, $pw, $port, $sql)
    $env:PGPASSWORD = $pw
    $sql | & $psql -h 127.0.0.1 -p $port -U postgres -d postgres -X -v ON_ERROR_STOP=1 -q 2>&1 | Out-String
  } -ArgumentList $psql, $pw, $port, $sqlParallel
  Wait-Job $job1, $job2 | Out-Null
  Receive-Job $job1, $job2 | Out-Null
  Remove-Job $job1, $job2 -Force -ErrorAction SilentlyContinue

  $paid = & $psql -X -t -A -c "SELECT count(*) FROM public.orders WHERE id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' AND debt_status = 'paid';"
  if ($paid.Trim() -ne '1') { throw "parallel pay expected 1 paid row, got $paid" }

  Write-Output 'HARNESS_OK'
}
finally {
  $env:PGPASSWORD = $null
  & $pgctl -D $data stop -m fast 2>$null | Out-Null
  Start-Sleep -Seconds 1
  if (Test-Path $data) { Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue }
}
