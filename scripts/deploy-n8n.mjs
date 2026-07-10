#!/usr/bin/env node
/**
 * deploy-n8n.mjs — gated deployment of workflows/*.json to a live n8n.
 *
 * HARD GATE: writes to a live instance ONLY when ALL of
 *   N8N_API_URL, N8N_API_KEY, ALLOW_N8N_WRITE=true
 * are set. Otherwise it validates and stages local files only.
 *
 * Behavior: for each workflows/SB-*.json, create-or-update by workflow name
 * via the n8n public REST API (/api/v1/workflows). Never activates workflows
 * (activation stays a deliberate manual step; see docs/DEPLOYMENT.md).
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = process.env.N8N_API_URL;
const KEY = process.env.N8N_API_KEY;
const ALLOW = process.env.ALLOW_N8N_WRITE === 'true';

console.log('Validating repository before any deploy step…');
execSync(`node ${path.join(ROOT, 'scripts/validate-workflows.mjs')}`, { stdio: 'inherit' });

const files = readdirSync(path.join(ROOT, 'workflows')).filter(f => f.endsWith('.json')).sort();

if (!URL_ || !KEY || !ALLOW) {
  const staging = path.join(ROOT, 'dist-workflows');
  mkdirSync(staging, { recursive: true });
  for (const f of files) {
    writeFileSync(path.join(staging, f), readFileSync(path.join(ROOT, 'workflows', f)));
  }
  console.log('\nLive n8n write DISABLED (requires N8N_API_URL + N8N_API_KEY + ALLOW_N8N_WRITE=true).');
  console.log(`Validated workflow JSON staged to dist-workflows/ (${files.length} files) for manual import.`);
  process.exit(0);
}

const api = async (method, p, body) => {
  const res = await fetch(`${URL_.replace(/\/$/, '')}${p}`, {
    method,
    headers: { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
};

console.log(`\nALLOW_N8N_WRITE=true — deploying ${files.length} workflows to ${URL_} (NOT activating).`);
const existing = (await api('GET', '/api/v1/workflows?limit=250')).data || [];
const byName = new Map(existing.map(w => [w.name, w.id]));

for (const f of files) {
  const wf = JSON.parse(readFileSync(path.join(ROOT, 'workflows', f), 'utf8'));
  const payload = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings || {} };
  const id = byName.get(wf.name);
  if (id) {
    await api('PUT', `/api/v1/workflows/${id}`, payload);
    console.log(`updated  ${wf.name} (id ${id})`);
  } else {
    const created = await api('POST', '/api/v1/workflows', payload);
    console.log(`created  ${wf.name} (id ${created.id})`);
  }
}
console.log('\nDone. Workflows are imported INACTIVE. Attach credentials, map Data Tables,');
console.log('run SB-00 to GREEN, then activate per docs/DEPLOYMENT.md.');
