$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Output 'HARNESS_SKIP docker not available'
  exit 2
}

$name = "seller-5201-pg"
docker rm -f $name 2>$null | Out-Null
docker run --name $name -e POSTGRES_PASSWORD=postgres -d postgres:15-alpine | Out-Null
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  docker exec $name pg_isready -U postgres | Out-Null
  if ($LASTEXITCODE -eq 0) { $ok = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ok) { throw 'postgres did not become ready' }

function Invoke-SqlFile([string]$rel) {
  Get-Content -Raw (Join-Path $root $rel) | docker exec -i $name psql -U postgres -v ON_ERROR_STOP=1 -X
  if ($LASTEXITCODE -ne 0) { throw "psql failed: $rel" }
}

Invoke-SqlFile 'scripts/pg_orders_protect_harness_setup.sql'
Invoke-SqlFile 'supabase/migrations/20261111090000_orders_protect_client_updates.sql'
Invoke-SqlFile 'scripts/verify_orders_protect_client_updates_tests.sql'

docker exec -i $name psql -U postgres -v ON_ERROR_STOP=1 -X -c @"
DO `$`$
DECLARE
  v_id uuid;
  v_status text;
BEGIN
  SELECT id INTO v_id FROM public.orders LIMIT 1;
  UPDATE public.orders SET comment = 'rpc-path' WHERE id = v_id;
  SELECT status INTO v_status FROM public.orders WHERE id = v_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'postgres update must succeed';
  END IF;
END;
`$`$;
"@
if ($LASTEXITCODE -ne 0) { throw 'allowed postgres update failed' }

docker rm -f $name | Out-Null
Write-Output 'HARNESS_OK'
