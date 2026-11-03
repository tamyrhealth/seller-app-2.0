/**
 * Refuse staging scripts if the target URL matches production (.env.local)
 * or is missing the staging project ref.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

function envFile(name: string): Record<string, string> {
  const path = join(process.cwd(), name);
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export function assertStagingTarget(): {
  url: string;
  anon: string;
  service?: string;
} {
  const stagingFile = envFile('.env.staging');
  const local = envFile('.env.local');
  const url = process.env.STAGING_SUPABASE_URL || stagingFile.STAGING_SUPABASE_URL;
  const anon = process.env.STAGING_SUPABASE_ANON_KEY || stagingFile.STAGING_SUPABASE_ANON_KEY;
  const service = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || stagingFile.STAGING_SUPABASE_SERVICE_ROLE_KEY;
  const ref = process.env.STAGING_PROJECT_REF || stagingFile.STAGING_PROJECT_REF;
  const prodUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || local.NEXT_PUBLIC_SUPABASE_URL;
  const prodService = local.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !anon) {
    console.error('Set STAGING_SUPABASE_URL and STAGING_SUPABASE_ANON_KEY (or .env.staging).');
    process.exit(1);
  }
  if (!ref) {
    console.error('Set STAGING_PROJECT_REF.');
    process.exit(1);
  }
  if (!url.includes(ref)) {
    console.error('STAGING_SUPABASE_URL does not contain STAGING_PROJECT_REF.');
    process.exit(1);
  }
  if (prodUrl && url.replace(/\/$/, '') === prodUrl.replace(/\/$/, '')) {
    console.error('Staging URL equals .env.local NEXT_PUBLIC_SUPABASE_URL. Refusing.');
    process.exit(1);
  }
  if (service && prodService && service === prodService) {
    console.error('Staging service_role equals production service_role. Refusing.');
    process.exit(1);
  }
  if (/supabase\.co/i.test(url) && process.env.STAGING_ALLOW_HOSTED !== '1' && stagingFile.STAGING_ALLOW_HOSTED !== '1') {
    console.error('Set STAGING_ALLOW_HOSTED=1 after confirming this is not production.');
    process.exit(1);
  }
  return { url, anon, service };
}

if (require.main === module) {
  const t = assertStagingTarget();
  console.log('OK staging target', t.url);
}
