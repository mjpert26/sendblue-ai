#!/usr/bin/env node
/**
 * test-fixtures.mjs — mock-driven test harness (no network, no real numbers).
 *
 * Loads every tests/fixtures/*.json file; each contains cases of the form
 *   { id, description, kind, input, expected }
 * and dispatches to the reference implementation in scripts/lib/agent-core.mjs
 * (the same logic embedded in the workflow Code nodes — see core-sync markers).
 *
 * Outputs:
 *   tests/output/test-report.json   (machine-readable)
 *   tests/TEST-REPORT.md            (human-readable, with --write-report)
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from './lib/agent-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const writeReport = process.argv.includes('--write-report');

const config = {
  compliance: JSON.parse(readFileSync(path.join(ROOT, 'config/compliance-rules.example.json'), 'utf8')),
  statusMap: JSON.parse(readFileSync(path.join(ROOT, 'config/customer-safe-status-map.example.json'), 'utf8')),
  schema: JSON.parse(readFileSync(path.join(ROOT, 'prompts/structured-output-schema.json'), 'utf8')),
  fallbacks: JSON.parse(readFileSync(path.join(ROOT, 'prompts/fallback-messages.json'), 'utf8')),
};

const KINDS = {
  phone: (i) => ({ normalized: core.normalizePhone(i.raw, i.country) }),
  opt_out: (i) => core.detectOptOut(i.message, config.compliance.opt_out),
  wrong_number: (i) => core.detectWrongNumber(i.message, config.compliance.wrong_number),
  sensitive: (i) => core.detectSensitive(i.message, config.compliance.sensitive_data.detectors),
  redact: (i) => ({ redacted: core.redactSensitive(i.message, config.compliance.sensitive_data.detectors) }),
  resolve: (i) => core.resolveRecord(i.matches),
  verification: (i) => ({ level: core.verificationLevel(i.resolution, i.confirmation, i.level2Result) }),
  application_select: (i) => core.selectApplication(i.apps, i.options),
  stage_map: (i) => core.mapStage(i.object, i.field, i.value, config.statusMap),
  send_guards: (i) => core.evaluateSendGuards(i.ctx),
  followup: (i) => core.followupEligible(i.ctx),
  content_validation: (i) => core.validateOutboundContent(i.content, i.templateId, config.compliance),
  structured_output: (i) => {
    const parsed = typeof i.raw === 'string' ? core.extractJson(i.raw) : i.raw;
    if (parsed === null) return { valid: false, parse_failed: true };
    return core.validateStructuredOutput(parsed, config.schema);
  },
  action_permission: (i) => ({ permitted: core.isActionPermitted(i.action, i.outcome) }),
  error_category: (i) => core.categorizeError(i.statusCode, i.context),
  messaging_hours: (i) => ({ within: core.withinMessagingHours(i.now, i.hours) }),
  idempotency: (i) => {
    const k1 = core.buildIdempotencyKey(i.first);
    const k2 = core.buildIdempotencyKey(i.second);
    return { same_key: k1 === k2 };
  },
};

/** expected is a subset-match against actual (deep). */
function subsetMatch(expected, actual, pathStr = '') {
  if (expected === null || typeof expected !== 'object') {
    return Object.is(expected, actual) ? [] : [`${pathStr}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${pathStr}: expected array`];
    const diffs = [];
    for (const item of expected) {
      if (!actual.some(a => subsetMatch(item, a).length === 0)) {
        diffs.push(`${pathStr}: missing array element ${JSON.stringify(item)}`);
      }
    }
    return diffs;
  }
  const diffs = [];
  for (const [k, v] of Object.entries(expected)) {
    diffs.push(...subsetMatch(v, actual?.[k], `${pathStr}.${k}`));
  }
  return diffs;
}

const fixtureDir = path.join(ROOT, 'tests/fixtures');
const files = readdirSync(fixtureDir).filter(f => f.endsWith('.json')).sort();
const results = [];

for (const file of files) {
  const cases = JSON.parse(readFileSync(path.join(fixtureDir, file), 'utf8')).cases || [];
  for (const c of cases) {
    const fn = KINDS[c.kind];
    let passed = false, detail = '';
    if (!fn) {
      detail = `unknown kind "${c.kind}"`;
    } else {
      try {
        const actual = fn(c.input || {});
        const diffs = subsetMatch(c.expected, actual);
        passed = diffs.length === 0;
        detail = passed ? '' : diffs.join('; ');
        if (!passed) detail += ` | actual=${JSON.stringify(actual).slice(0, 220)}`;
      } catch (e) {
        detail = `threw: ${e.message}`;
      }
    }
    results.push({ file, id: c.id, kind: c.kind, description: c.description, passed, detail });
  }
}

const passed = results.filter(r => r.passed).length;
const failed = results.length - passed;

mkdirSync(path.join(ROOT, 'tests/output'), { recursive: true });
const machine = {
  run_at: new Date().toISOString(),
  core_version: core.CORE_VERSION,
  total: results.length, passed, failed,
  results
};
writeFileSync(path.join(ROOT, 'tests/output/test-report.json'), JSON.stringify(machine, null, 2));

if (writeReport) {
  const byFile = {};
  for (const r of results) (byFile[r.file] ||= []).push(r);
  let md = `# Test Report\n\nGenerated by \`npm run test:report\` (all mocked — no network, no real phone numbers).\n\n`;
  md += `- Core logic version: ${core.CORE_VERSION}\n- Total: **${results.length}** · Passed: **${passed}** · Failed: **${failed}**\n\n`;
  for (const [file, rs] of Object.entries(byFile)) {
    md += `## ${file}\n\n| Case | Kind | Result | Description |\n|------|------|--------|-------------|\n`;
    for (const r of rs) {
      md += `| ${r.id} | ${r.kind} | ${r.passed ? '✅ pass' : `❌ fail — ${r.detail.replace(/\|/g, '\\|')}`} | ${r.description} |\n`;
    }
    md += '\n';
  }
  md += `Machine-readable results: \`tests/output/test-report.json\` (regenerated each run; the JSON copy is gitignored).\n`;
  writeFileSync(path.join(ROOT, 'tests/TEST-REPORT.md'), md);
  console.log('Wrote tests/TEST-REPORT.md');
}

for (const r of results.filter(r => !r.passed)) {
  console.error(`FAIL ${r.file} ${r.id}: ${r.detail}`);
}
console.log(`\n${passed}/${results.length} cases passed.`);
process.exit(failed ? 1 : 0);
