# Start Next on :3001 against STAGING Supabase without editing .env.local.
# Requires .env.staging next to package.json.

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$envFile = Join-Path $root ".env.staging"
if (-not (Test-Path $envFile)) { throw "Create .env.staging from .env.staging.example first." }

Get-Content $envFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) { return }
  $i = $line.IndexOf("=")
  if ($i -lt 1) { return }
  $k = $line.Substring(0, $i).Trim()
  $v = $line.Substring($i + 1).Trim()
  Set-Item -Path "Env:$k" -Value $v
}

if (-not $env:STAGING_PROJECT_REF) { throw "STAGING_PROJECT_REF missing" }
if (-not $env:STAGING_SUPABASE_URL) { throw "STAGING_SUPABASE_URL missing" }
if ($env:STAGING_SUPABASE_URL -notmatch [regex]::Escape($env:STAGING_PROJECT_REF)) {
  throw "URL does not contain STAGING_PROJECT_REF"
}

$localEnv = Join-Path $root ".env.local"
if (Test-Path $localEnv) {
  $prodUrl = (Select-String -Path $localEnv -Pattern '^NEXT_PUBLIC_SUPABASE_URL=(.+)$').Matches.Groups[1].Value
  if ($prodUrl -and ($prodUrl.Trim() -eq $env:STAGING_SUPABASE_URL.Trim())) {
    throw ".env.local URL equals staging URL — check you did not mix projects."
  }
}

$env:NEXT_PUBLIC_SUPABASE_URL = $env:STAGING_SUPABASE_URL
$env:NEXT_PUBLIC_SUPABASE_ANON_KEY = $env:STAGING_SUPABASE_ANON_KEY
$env:SUPABASE_SERVICE_ROLE_KEY = $env:STAGING_SUPABASE_SERVICE_ROLE_KEY
$env:SUPABASE_URL = $env:STAGING_SUPABASE_URL

Write-Host "Next.js :3001 -> $($env:NEXT_PUBLIC_SUPABASE_URL)"
Set-Location $root
npx next dev -p 3001
