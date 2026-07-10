#!/usr/bin/env node
/**
 * generate-salesforce-map.mjs — builds config/salesforce-field-map.generated.json
 * from the describe dump produced by inspect-salesforce-fields.mjs.
 *
 * Matching is heuristic-by-label and CONSERVATIVE: a logical field is mapped
 * only on an unambiguous single candidate; everything else stays UNMAPPED for
 * a human to resolve. Never invents API names.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const describePath = path.join(ROOT, 'config/salesforce-describe.generated.json');
if (!existsSync(describePath)) {
  console.error('Run npm run inspect:salesforce first (config/salesforce-describe.generated.json missing).');
  process.exit(2);
}
const describe = JSON.parse(readFileSync(describePath, 'utf8'));
const example = JSON.parse(readFileSync(path.join(ROOT, 'config/salesforce-field-map.example.json'), 'utf8'));

// label keywords per logical field (order matters; all lowercase)
const HINTS = {
  time_in_business: ['time in business', 'years in business', 'months in business'],
  monthly_gross_revenue: ['monthly revenue', 'gross revenue', 'monthly gross'],
  requested_amount: ['requested amount', 'amount requested', 'funding amount', 'loan amount'],
  use_of_funds: ['use of funds', 'purpose of funds', 'funding purpose'],
  funding_urgency: ['urgency', 'how soon', 'timeline'],
  current_positions: ['positions', 'current advances', 'existing loans'],
  preferred_call_time: ['call time', 'best time'],
  ai_enabled: ['ai enabled', 'ai active', 'bot enabled'],
  human_takeover: ['human takeover', 'human owned', 'agent takeover'],
  sms_consent: ['sms consent', 'text consent', 'sms opt in', 'messaging consent'],
  consent_source: ['consent source'],
  consent_timestamp: ['consent date', 'consent timestamp'],
  sms_opt_out: ['sms opt out', 'opt out', 'do not text'],
  wrong_number: ['wrong number'],
  conversation_stage: ['conversation stage', 'ai stage'],
  missing_item_status: ['missing item', 'missing docs', 'stips'],
  application_link: ['application link', 'app link'],
  application_link_sent_date: ['link sent'],
  appointment_status: ['appointment'],
  last_inbound_date: ['last inbound'],
  last_outbound_date: ['last outbound'],
  followup_date: ['follow up date', 'follow-up date', 'next follow'],
  followup_attempt: ['follow up attempt', 'follow-up attempt'],
  handoff_reason: ['handoff reason'],
  sendblue_line: ['sendblue line'],
  sendblue_bot_seat: ['bot seat', 'sendblue seat'],
  sendblue_conversation_id: ['sendblue conversation', 'conversation id'],
};

function candidates(obj, keywords) {
  const fields = describe.objects?.[obj]?.fields || [];
  return fields.filter(f => {
    const label = (f.label || '').toLowerCase();
    const name = (f.name || '').toLowerCase();
    return keywords.some(k => label.includes(k) || name.includes(k.replace(/[^a-z]/g, '_')));
  });
}

const generated = JSON.parse(JSON.stringify(example));
generated.$comment = 'GENERATED from salesforce-describe.generated.json — review every mapping, then save as config/salesforce-field-map.json (local, gitignored). UNMAPPED = resolve by hand.';
generated.generated_at = new Date().toISOString();
const notes = [];

for (const [logical, spec] of Object.entries(generated.mappings)) {
  if (spec.field !== 'UNMAPPED') continue;                 // standard fields already set
  const keywords = HINTS[logical];
  if (!keywords) { notes.push(`${logical}: no heuristic — left UNMAPPED`); continue; }
  for (const obj of ['Lead', 'Contact', 'Opportunity', 'Account']) {
    const c = candidates(obj, keywords);
    if (c.length === 1) {
      spec.object = obj; spec.field = c[0].name;
      notes.push(`${logical}: mapped to ${obj}.${c[0].name} ("${c[0].label}") — VERIFY`);
      break;
    }
    if (c.length > 1) {
      notes.push(`${logical}: AMBIGUOUS on ${obj} (${c.map(x => x.name).join(', ')}) — left UNMAPPED`);
      break;
    }
  }
}

// surface custom-object suggestions for the application object
generated.application_object_candidates = (describe.custom_object_names || [])
  .filter(o => /app|fund|deal|loan/i.test(o.name + o.label)).slice(0, 10);

// surface picklist values needed by the status map
generated.picklists = {
  'Lead.Status': describe.objects?.Lead?.fields?.find(f => f.name === 'Status')?.picklistValues || [],
  'Opportunity.StageName': describe.objects?.Opportunity?.fields?.find(f => f.name === 'StageName')?.picklistValues || []
};
generated.generation_notes = notes;

const outPath = path.join(ROOT, 'config/salesforce-field-map.generated.json');
writeFileSync(outPath, JSON.stringify(generated, null, 2));

const unmappedRequired = Object.entries(generated.mappings)
  .filter(([, s]) => s.required && (s.field === 'UNMAPPED' || s.object === 'UNMAPPED'))
  .map(([k]) => k);
console.log(`Wrote ${outPath} (gitignored).`);
notes.forEach(n => console.log('  - ' + n));
if (unmappedRequired.length) {
  console.log(`\nREQUIRED mappings still unresolved (health check will be RED): ${unmappedRequired.join(', ')}`);
  console.log('Resolve them (create fields per docs/SALESFORCE-SETUP.md or map to existing ones), then save as config/salesforce-field-map.json.');
}
