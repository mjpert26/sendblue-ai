#!/usr/bin/env node
/**
 * validate-workflows.mjs — repository validation gate (runs in CI).
 *
 * Checks (per docs/TESTING.md and section 20 of the build spec):
 *  - every workflow file parses as JSON, unique workflow names
 *  - unique, non-empty node names; connections reference existing nodes
 *  - no embedded credentials/secrets, no production phone numbers
 *  - no empty HTTP endpoints; critical API calls have error handling
 *  - only SB-06 sends Sendblue messages
 *  - send/dispatch workflows check the kill switch and opt-out state
 *  - scheduled sends recheck inbound activity; test-mode guard present
 *  - credentials are placeholders; webhook paths unique; version metadata
 *  - required Data Tables documented; config files parse + invariants hold
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const configOnly = args.includes('--config-only');

let errors = [];
let warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const readJson = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));

// ---------------------------------------------------------------------------
// Secret / PII scanning helpers
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
  [/sk-ant-[a-zA-Z0-9-_]{10,}/, 'Anthropic API key'],
  [/xox[bap]-[a-zA-Z0-9-]{10,}/, 'Slack token'],
  [/(?<![A-Za-z0-9])(?:[A-Za-z0-9+/]{40})(?![A-Za-z0-9+/=])/, 'AWS-style secret (40 base64 chars)'],
  [/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, 'Private key'],
  [/"(?:api[_-]?key|secret|password|token)"\s*:\s*"(?!\s*$)(?!\{\{)(?!__REPLACE_ME__)(?!PLACEHOLDER)[A-Za-z0-9+/_-]{16,}"/i, 'Inline credential value'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, 'JWT'],
];

// Real-looking US numbers. Allowed: fictional +1555xxxxxxx range and the
// obvious +15550000000 placeholder.
const PHONE_RE = /\+1[2-9]\d{9}/g;
const isAllowedPhone = (p) => /^\+1555\d{7}$/.test(p);

function scanText(text, where) {
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(text)) err(`${where}: possible embedded secret (${label})`);
  }
  for (const m of text.match(PHONE_RE) || []) {
    if (!isAllowedPhone(m)) err(`${where}: production-looking phone number ${m.slice(0, 5)}… embedded`);
  }
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------
function validateConfigs() {
  const required = [
    'config/approved-faq.example.json',
    'config/customer-safe-status-map.example.json',
    'config/salesforce-field-map.example.json',
    'config/qualification-rules.example.json',
    'config/status-disclosure-policy.example.json',
    'config/follow-up-policy.example.json',
    'config/compliance-rules.example.json',
    'config/handoff-rules.example.json',
    'data-tables/definitions.json',
    'data-tables/seed-data.example.json',
    'prompts/structured-output-schema.json',
    'prompts/fallback-messages.json',
  ];
  for (const f of required) {
    if (!existsSync(path.join(ROOT, f))) { err(`missing required file: ${f}`); continue; }
    let json;
    try { json = readJson(f); } catch (e) { err(`${f}: invalid JSON — ${e.message}`); continue; }
    scanText(JSON.stringify(json), f);
  }

  // Invariants
  try {
    const faq = readJson('config/approved-faq.example.json');
    for (const e of faq.entries || []) {
      if (e.placeholder_requires_compliance_approval !== true) {
        err(`approved-faq: entry ${e.id} not marked placeholder_requires_compliance_approval`);
      }
    }
  } catch { /* reported above */ }
  try {
    const fu = readJson('config/follow-up-policy.example.json');
    if (fu.outreach_journey_f?.enabled !== false) err('follow-up-policy: outreach_journey_f must ship disabled');
  } catch { /* reported above */ }
  try {
    const dt = readJson('data-tables/definitions.json');
    const names = (dt.tables || []).map(t => t.name);
    for (const t of ['agent_config', 'processed_messages', 'outbound_idempotency', 'contact_locks',
      'retry_state', 'dead_letter_events', 'followup_jobs', 'test_results']) {
      if (!names.includes(t)) err(`data-tables/definitions.json: missing required table ${t}`);
    }
    const cfg = dt.tables.find(t => t.name === 'agent_config');
    for (const k of ['global_ai_enabled', 'outbound_enabled', 'followups_enabled', 'status_lookup_enabled', 'test_mode']) {
      if (!(cfg?.required_keys || []).includes(k)) err(`agent_config required_keys missing ${k}`);
    }
  } catch { /* reported above */ }
  try {
    const seed = readJson('data-tables/seed-data.example.json');
    const get = (k) => (seed.agent_config || []).find(r => r.key === k)?.value;
    if (get('global_ai_enabled') !== 'false') err('seed-data: global_ai_enabled must seed as "false"');
    if (get('test_mode') !== 'true') err('seed-data: test_mode must seed as "true"');
  } catch { /* reported above */ }
}

// ---------------------------------------------------------------------------
// Workflow validation
// ---------------------------------------------------------------------------
const SEND_ENDPOINT_RE = /send-message/;
const DISPATCHER_FILE = 'SB-06-outbound-dispatcher.json';

function nodeText(node) { return JSON.stringify(node); }

function validateWorkflows() {
  const dir = path.join(ROOT, 'workflows');
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : [];
  if (files.length === 0) { err('workflows/: no workflow JSON files found'); return; }

  const workflowNames = new Map();
  const webhookPaths = new Map();

  for (const file of files) {
    const where = `workflows/${file}`;
    let wf;
    try { wf = readJson(`workflows/${file}`); } catch (e) { err(`${where}: invalid JSON — ${e.message}`); continue; }

    // name uniqueness + version metadata
    if (!wf.name) err(`${where}: workflow has no name`);
    if (workflowNames.has(wf.name)) err(`${where}: duplicate workflow name "${wf.name}" (also in ${workflowNames.get(wf.name)})`);
    workflowNames.set(wf.name, file);
    const version = wf.meta?.workflowVersion || wf.meta?.version;
    if (!version) err(`${where}: missing meta.workflowVersion`);

    const nodes = wf.nodes || [];
    if (nodes.length === 0) { err(`${where}: no nodes`); continue; }

    // node name uniqueness / emptiness
    const names = new Set();
    for (const n of nodes) {
      if (!n.name || !n.name.trim()) err(`${where}: node with empty name (type ${n.type})`);
      if (names.has(n.name)) err(`${where}: duplicate node name "${n.name}"`);
      names.add(n.name);
    }

    // connections reference existing nodes
    for (const [from, outs] of Object.entries(wf.connections || {})) {
      if (!names.has(from)) err(`${where}: connection from unknown node "${from}"`);
      for (const branch of Object.values(outs || {})) {
        for (const conns of branch || []) {
          for (const c of conns || []) {
            if (!names.has(c.node)) err(`${where}: connection "${from}" -> unknown node "${c.node}"`);
          }
        }
      }
    }

    // per-node checks
    for (const n of nodes) {
      const t = nodeText(n);
      scanText(t, `${where} node "${n.name}"`);

      // credentials must be placeholders
      for (const [credType, cred] of Object.entries(n.credentials || {})) {
        const label = `${cred?.name ?? ''} ${cred?.id ?? ''}`;
        if (!/placeholder/i.test(label)) {
          err(`${where} node "${n.name}": credential ${credType} is not a placeholder ("${label.trim()}")`);
        }
      }

      if (n.type === 'n8n-nodes-base.httpRequest') {
        const url = n.parameters?.url ?? '';
        if (!String(url).trim()) err(`${where} node "${n.name}": empty HTTP endpoint`);
        const critical = /sendblue|salesforce|anthropic|api\./i.test(String(url)) || /\{\{/.test(String(url));
        if (critical) {
          const hasErrorPath = n.onError === 'continueErrorOutput' || n.continueOnFail === true ||
            (wf.connections?.[n.name]?.main || []).length > 1;
          if (!hasErrorPath) err(`${where} node "${n.name}": critical API call without error branch`);
        }
        // only the dispatcher may hit the send endpoint
        if (SEND_ENDPOINT_RE.test(String(url)) && file !== DISPATCHER_FILE) {
          err(`${where} node "${n.name}": Sendblue send endpoint outside the outbound dispatcher`);
        }
      }

      if (n.type === 'n8n-nodes-base.webhook') {
        const p = n.parameters?.path;
        if (!p) err(`${where} node "${n.name}": webhook without path`);
        else if (webhookPaths.has(p)) err(`${where}: webhook path "${p}" already used in ${webhookPaths.get(p)}`);
        else webhookPaths.set(p, file);
      }
    }

    const wfText = JSON.stringify(wf);

    // dispatcher-specific invariants
    if (file === DISPATCHER_FILE) {
      for (const marker of ['global_ai_enabled', 'outbound_enabled', 'opted_out', 'test_mode',
        'idempotency', 'human_takeover', 'customer_replied_since_scheduled', 'test_allowlist']) {
        if (!wfText.includes(marker)) err(`${where}: dispatcher missing guard marker "${marker}"`);
      }
      if (!wfText.includes('evaluateSendGuards')) err(`${where}: dispatcher missing evaluateSendGuards logic`);
    }

    // follow-up orchestrator must recheck inbound activity
    if (file.startsWith('SB-08')) {
      for (const marker of ['inbound_since_scheduled', 'followups_enabled', 'max_attempts']) {
        if (!wfText.includes(marker)) err(`${where}: follow-up orchestrator missing recheck marker "${marker}"`);
      }
    }

    // workflows that trigger sends must reference the kill switch
    if (/SB-0[1248]|SB-06|SB-09/.test(file)) {
      if (!wfText.includes('global_ai_enabled')) {
        err(`${where}: no global kill-switch (global_ai_enabled) reference`);
      }
    }

    // core-sync marker where deterministic core logic is embedded
    if (/SB-0[13468]/.test(file) && !wfText.includes('core-sync:')) {
      warn(`${where}: no core-sync marker (Code nodes should cite scripts/lib/agent-core.mjs version)`);
    }
  }

  // cross-file: every required workflow present
  const requiredWf = ['SB-00-discovery-health-check.json', 'SB-01-inbound-webhook-router.json',
    'SB-02-salesforce-lead-intake-trigger.json', 'SB-03-record-resolver-verification.json',
    'SB-04-conversation-orchestrator.json', 'SB-05-process-status-lookup.json',
    'SB-06-outbound-dispatcher.json', 'SB-07-delivery-status-webhook.json',
    'SB-08-follow-up-orchestrator.json', 'SB-09-human-handoff-resume.json',
    'SB-10-error-handler-dead-letter.json', 'SB-11-automated-test-harness.json'];
  for (const f of requiredWf) if (!files.includes(f)) err(`workflows/: missing ${f}`);
}

// ---------------------------------------------------------------------------
validateConfigs();
if (!configOnly) validateWorkflows();

for (const w of warnings) console.log(`WARN  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`ERROR ${e}`);
  console.error(`\nValidation FAILED: ${errors.length} error(s), ${warnings.length} warning(s).`);
  process.exit(1);
}
console.log(`Validation PASSED (${warnings.length} warning(s)).`);
