#!/usr/bin/env node
/**
 * inspect-sendblue.mjs — READ-ONLY Sendblue account inspection.
 *
 * Verifies authentication and enumerates lines, seats, webhooks and recent
 * message metadata so the from-number / Emma seat / webhook registration can
 * be confirmed before activation. NEVER sends a message.
 *
 * Output: config/sendblue-inspection.generated.json (gitignored) + console
 * summary with secrets and full phone numbers masked.
 *
 * Endpoints follow the current Sendblue API docs (base https://api.sendblue.com,
 * headers sb-api-key-id / sb-api-secret-key). Paths are overridable because
 * account plans differ — see ASSUMPTIONS.md A-05/A-07.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BASE = process.env.SENDBLUE_API_BASE_URL || 'https://api.sendblue.com';
const KEY = process.env.SENDBLUE_API_KEY_ID;
const SECRET = process.env.SENDBLUE_API_SECRET_KEY;

if (!KEY || !SECRET || KEY === '__REPLACE_ME__') {
  console.error('SENDBLUE_API_KEY_ID / SENDBLUE_API_SECRET_KEY not set — nothing to inspect.');
  console.error('This script is read-only and safe to run once credentials exist.');
  process.exit(2);
}

const mask = (v) => typeof v === 'string' && /^\+?\d{8,15}$/.test(v.replace(/\D/g, ''))
  ? v.slice(0, 5) + '…' + v.slice(-2) : v;

async function get(pathName) {
  const url = `${BASE}${pathName}`;
  try {
    const res = await fetch(url, {
      headers: { 'sb-api-key-id': KEY, 'sb-api-secret-key': SECRET }
    });
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* non-JSON */ }
    return { path: pathName, status: res.status, ok: res.ok, body: json ?? body.slice(0, 500) };
  } catch (e) {
    return { path: pathName, status: 0, ok: false, error: e.message };
  }
}

// Candidate read-only endpoints (v2 resource paths differ by plan/version;
// non-200s are recorded, not fatal).
const CHECKS = {
  account_lines: ['/api/v2/lines', '/accounts/lines'],
  seats: ['/api/v2/seats', '/accounts/seats'],
  webhooks: ['/api/v2/webhooks', '/accounts/webhooks'],
  messages_sample: ['/api/v2/messages?limit=1', '/accounts/messages?limit=1'],
  contacts_sample: ['/api/v2/contacts?limit=1', '/accounts/contacts?limit=1'],
};

const report = { generated_at: new Date().toISOString(), base_url: BASE, results: {} };
let authOk = false;

for (const [name, candidates] of Object.entries(CHECKS)) {
  for (const p of candidates) {
    const r = await get(p);
    report.results[name] = r;
    if (r.status === 401 || r.status === 403) break;   // auth problem — same for all
    if (r.ok) { authOk = true; break; }                 // first working path wins
  }
}

mkdirSync(path.join(ROOT, 'config'), { recursive: true });
writeFileSync(
  path.join(ROOT, 'config/sendblue-inspection.generated.json'),
  JSON.stringify(report, (k, v) => (k === 'number' || k === 'from_number' || k === 'phone' ? mask(v) : v), 2)
);

console.log('--- Sendblue inspection summary ---');
for (const [name, r] of Object.entries(report.results)) {
  console.log(`${name.padEnd(16)} ${r.ok ? 'OK ' : 'FAIL'} (${r.status}) ${r.path}`);
}
console.log(`\nAuth ${authOk ? 'VERIFIED' : 'NOT verified — check keys and endpoint paths (ASSUMPTIONS.md A-05/A-07)'}.`);
console.log('Full (masked) detail: config/sendblue-inspection.generated.json (gitignored)');
process.exit(authOk ? 0 : 1);
