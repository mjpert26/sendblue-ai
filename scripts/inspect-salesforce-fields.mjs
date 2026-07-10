#!/usr/bin/env node
/**
 * inspect-salesforce-fields.mjs — READ-ONLY Salesforce metadata discovery.
 *
 * Uses the REST describe endpoints (sobjects/{name}/describe) to dump the
 * fields available on Lead, Contact, Account, Opportunity, Task plus any
 * custom objects listed in SF_EXTRA_OBJECTS (comma-separated API names).
 *
 * Output: config/salesforce-describe.generated.json (gitignored). Feed it to
 * generate-salesforce-map.mjs. Never writes to Salesforce.
 *
 * Auth: either SF_ACCESS_TOKEN (+ SF_INSTANCE_URL) or client-credentials via
 * SF_CLIENT_ID/SF_CLIENT_SECRET (connected app with client_credentials flow).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTANCE = process.env.SF_INSTANCE_URL;
const API = process.env.SF_API_VERSION || 'v61.0';

if (!INSTANCE || INSTANCE.includes('yourInstance')) {
  console.error('SF_INSTANCE_URL not configured. Read-only script; safe to run once set.');
  process.exit(2);
}

async function getToken() {
  if (process.env.SF_ACCESS_TOKEN) return process.env.SF_ACCESS_TOKEN;
  const id = process.env.SF_CLIENT_ID, secret = process.env.SF_CLIENT_SECRET;
  if (!id || !secret || id === '__REPLACE_ME__') {
    console.error('Provide SF_ACCESS_TOKEN or SF_CLIENT_ID/SF_CLIENT_SECRET.');
    process.exit(2);
  }
  const res = await fetch(`${INSTANCE}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret })
  });
  if (!res.ok) { console.error(`OAuth failed: ${res.status} ${await res.text()}`); process.exit(1); }
  return (await res.json()).access_token;
}

const token = await getToken();
const sfGet = async (p) => {
  const res = await fetch(`${INSTANCE}/services/data/${API}${p}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return { __error: res.status, detail: (await res.text()).slice(0, 300) };
  return res.json();
};

const objects = ['Lead', 'Contact', 'Account', 'Opportunity', 'Task',
  ...(process.env.SF_EXTRA_OBJECTS || '').split(',').map(s => s.trim()).filter(Boolean)];

const out = { generated_at: new Date().toISOString(), api_version: API, objects: {} };

// Global describe first — lets the map generator suggest custom application objects.
const global_ = await sfGet('/sobjects/');
out.custom_object_names = (global_.sobjects || [])
  .filter(o => o.custom && o.queryable)
  .map(o => ({ name: o.name, label: o.label }));

for (const obj of objects) {
  const d = await sfGet(`/sobjects/${obj}/describe/`);
  if (d.__error) { out.objects[obj] = { error: d.__error, detail: d.detail }; continue; }
  out.objects[obj] = {
    label: d.label,
    fields: (d.fields || []).map(f => ({
      name: f.name, label: f.label, type: f.type, custom: f.custom,
      nillable: f.nillable, createable: f.createable, updateable: f.updateable,
      length: f.length || undefined,
      picklistValues: f.type === 'picklist'
        ? (f.picklistValues || []).filter(v => v.active).map(v => v.value) : undefined,
      referenceTo: (f.referenceTo || []).length ? f.referenceTo : undefined
    })),
    recordTypeInfos: (d.recordTypeInfos || []).map(r => ({ name: r.name, developerName: r.developerName }))
  };
  console.log(`described ${obj}: ${out.objects[obj].fields.length} fields`);
}

mkdirSync(path.join(ROOT, 'config'), { recursive: true });
const file = path.join(ROOT, 'config/salesforce-describe.generated.json');
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\nWrote ${file} (gitignored). Next: npm run generate:sf-map`);
