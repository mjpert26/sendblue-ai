/**
 * agent-core.mjs — reference implementation of Emma's deterministic logic.
 *
 * This module is the single source of truth for the pure functions embedded
 * in the n8n workflow Code nodes (workflows/SB-*.json). The test harness
 * (scripts/test-fixtures.mjs) exercises THIS module; the workflow Code nodes
 * carry the same logic with a `core-sync: <version>` marker that the
 * validator checks exists. If you change logic here, update the matching
 * Code node(s) and bump CORE_VERSION.
 */

export const CORE_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Phone normalization (E.164, default US)
// ---------------------------------------------------------------------------
export function normalizePhone(raw, defaultCountry = 'US') {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const digits = s.replace(/[^\d+]/g, '');
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  const bare = digits.replace(/\D/g, '');
  if (defaultCountry === 'US') {
    if (bare.length === 10) return `+1${bare}`;
    if (bare.length === 11 && bare.startsWith('1')) return `+${bare}`;
  }
  if (bare.length >= 8 && bare.length <= 15) return `+${bare}`;
  return null;
}

/** Stable non-reversible reference for logs / Data Tables (not a secret hash). */
export function phoneRef(e164) {
  if (!e164) return null;
  let h = 5381;
  for (let i = 0; i < e164.length; i++) h = ((h << 5) + h + e164.charCodeAt(i)) >>> 0;
  return `ph_${h.toString(16)}${e164.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// Opt-out detection (deterministic, runs BEFORE the model)
// ---------------------------------------------------------------------------
const NEGATING_PREFIX = /(don'?t|do not|never|please don'?t|no need to)\s+(?:\w+\s+){0,3}$/i;

export function detectOptOut(message, rules) {
  const text = String(message || '').toLowerCase().trim();
  if (!text) return { optOut: false };
  const stripped = text.replace(/[!.?,;:'"()\s]+$/g, '').replace(/^[!.?,;:'"()\s]+/g, '');

  for (const phrase of rules.exact_phrases) {
    const p = phrase.toLowerCase();
    if (stripped === p) return { optOut: true, matched: phrase, mode: 'exact' };
    // Standalone sentence match with no negating context before it.
    const idx = text.indexOf(p);
    if (idx >= 0) {
      const before = text.slice(0, idx);
      const after = text.slice(idx + p.length);
      const sentenceBoundaryBefore = before === '' || /[.!?;\n]\s*$/.test(before);
      const sentenceBoundaryAfter = after === '' || /^[\s.!?;,]/.test(after);
      const negated = NEGATING_PREFIX.test(before);
      // "stop" alone is too ambiguous mid-sentence — require whole-message for
      // single-word phrases unless followed by nothing meaningful.
      const singleWord = !p.includes(' ');
      if (!negated && sentenceBoundaryBefore && sentenceBoundaryAfter && !singleWord) {
        return { optOut: true, matched: phrase, mode: 'sentence' };
      }
    }
  }
  for (const pattern of rules.natural_language_patterns || []) {
    let re;
    try { re = new RegExp(pattern, 'i'); } catch { continue; }
    const m = text.match(re);
    if (m) {
      const before = text.slice(0, m.index);
      if (!NEGATING_PREFIX.test(before)) {
        return { optOut: true, matched: pattern, mode: 'pattern' };
      }
    }
  }
  return { optOut: false };
}

// ---------------------------------------------------------------------------
// Wrong-number detection
// ---------------------------------------------------------------------------
export function detectWrongNumber(message, rules) {
  const text = String(message || '').toLowerCase();
  for (const pattern of rules.patterns || []) {
    let re;
    try { re = new RegExp(pattern, 'i'); } catch { continue; }
    if (re.test(text)) return { wrongNumber: true, matched: pattern };
  }
  return { wrongNumber: false };
}

// ---------------------------------------------------------------------------
// Sensitive-data detection + redaction
// ---------------------------------------------------------------------------
export function detectSensitive(message, detectors) {
  const text = String(message || '');
  const hits = [];
  for (const [name, pattern] of Object.entries(detectors || {})) {
    let re;
    try { re = new RegExp(pattern, 'i'); } catch { continue; }
    if (re.test(text)) hits.push(name);
  }
  return { sensitive: hits.length > 0, types: hits };
}

export function redactSensitive(message, detectors) {
  let text = String(message || '');
  for (const pattern of Object.values(detectors || {})) {
    let re;
    try { re = new RegExp(pattern, 'gi'); } catch { continue; }
    text = text.replace(re, '[REDACTED]');
  }
  return text;
}

// ---------------------------------------------------------------------------
// Record matching / verification level (SB-03)
// ---------------------------------------------------------------------------
/**
 * matches: array of {object:'Lead'|'Contact'|'Account', id, isConverted?, convertedContactId?, fields:{}}
 * Returns deterministic resolution — never guesses between multiple matches.
 */
export function resolveRecord(matches) {
  const active = (matches || []).map(m =>
    m.object === 'Lead' && m.isConverted && m.convertedContactId
      ? { ...m, resolvedObject: 'Contact', resolvedId: m.convertedContactId, viaConvertedLead: true }
      : { ...m, resolvedObject: m.object, resolvedId: m.id }
  );
  const uniqueIds = [...new Set(active.map(m => `${m.resolvedObject}:${m.resolvedId}`))];
  if (uniqueIds.length === 0) return { outcome: 'no_match' };
  if (uniqueIds.length > 1) return { outcome: 'multiple_match', candidates: uniqueIds };
  const rec = active[0];
  const f = rec.fields || {};
  if (String(f.sms_opt_out) === 'true') return { outcome: 'opted_out', record: rec };
  if (String(f.wrong_number) === 'true') return { outcome: 'wrong_number', record: rec };
  if (String(f.human_takeover) === 'true') return { outcome: 'human_takeover', record: rec };
  if (f.ai_enabled !== undefined && String(f.ai_enabled) === 'false') {
    return { outcome: 'ai_disabled', record: rec };
  }
  return { outcome: 'single_match', record: rec };
}

/**
 * Verification level for this turn.
 * confirmation: {factor:'first_name'|'business_name'|'zip_code', value} provided by conversation, or null
 */
export function verificationLevel(resolution, confirmation, level2Result = null) {
  if (!resolution || resolution.outcome !== 'single_match') return 0;
  if (level2Result === true) return 2;
  if (!confirmation || !confirmation.factor || !confirmation.value) return 0;
  const expected = (resolution.record.fields || {})[confirmation.factor];
  if (!expected) return 0;
  const norm = v => String(v).trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
  if (norm(expected) === norm(confirmation.value)) return 1;
  return 0; // conflicting info -> stay unverified
}

/** Deterministic active-application selection — never guesses. */
export function selectApplication(apps, { includeClosed = false } = {}) {
  const list = (apps || []).filter(a => includeClosed || !a.closed);
  const linked = list.filter(a => a.explicitly_linked);
  if (linked.length === 1) return { outcome: 'selected', application: linked[0] };
  if (linked.length > 1) return { outcome: 'ambiguous', candidates: linked.map(a => a.id) };
  if (list.length === 1) return { outcome: 'selected', application: list[0] };
  if (list.length === 0) return { outcome: 'none' };
  return { outcome: 'ambiguous', candidates: list.map(a => a.id) };
}

// ---------------------------------------------------------------------------
// Customer-safe stage mapping (SB-05)
// ---------------------------------------------------------------------------
export function mapStage(internalObject, internalField, internalValue, statusMap) {
  for (const s of statusMap.stages || []) {
    if (!s.active) continue;
    if (s.internal_object === internalObject &&
        s.internal_field === internalField &&
        (s.internal_values || []).includes(String(internalValue))) {
      return { mapped: true, stage: s };
    }
  }
  return { mapped: false, behavior: statusMap.unmapped_internal_value_behavior || 'escalate' };
}

// ---------------------------------------------------------------------------
// Outbound dispatcher guards (SB-06) — every guard must pass to send
// ---------------------------------------------------------------------------
export function buildIdempotencyKey({ correlationId, to, content }) {
  let h = 5381;
  const s = `${to}|${content}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `out_${correlationId}_${h.toString(16)}`;
}

export function withinMessagingHours(nowISO, hours) {
  // hours: {timezone, start:'HH:MM', end:'HH:MM', days:['Mon',...]}
  const now = new Date(nowISO);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: hours.timezone, hour12: false,
    weekday: 'short', hour: '2-digit', minute: '2-digit'
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const day = parts.weekday;
  const hm = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
  if (hours.days && !hours.days.includes(day)) return false;
  return hm >= hours.start && hm < hours.end;
}

/**
 * Evaluate all pre-send guards. Returns {allowed, failures:[...], mode}.
 * ctx supplies every input deterministically (no I/O here).
 */
export function evaluateSendGuards(ctx) {
  const failures = [];
  const g = (cond, code) => { if (!cond) failures.push(code); };

  g(ctx.global_ai_enabled === true, 'global_ai_disabled');
  g(ctx.outbound_enabled === true, 'outbound_disabled');
  g(ctx.record_ai_enabled !== false, 'record_ai_disabled');
  g(ctx.human_takeover !== true, 'human_takeover_active');
  g(ctx.opted_out !== true, 'opted_out');
  g(ctx.suppressed !== true, 'suppressed');
  g(ctx.wrong_number !== true, 'wrong_number');
  g(ctx.consent_ok === true, 'consent_missing');
  g(typeof ctx.content === 'string' && ctx.content.trim().length > 0, 'blank_message');
  g(ctx.compliance_passed === true, 'compliance_failed');
  g(ctx.idempotency_key_fresh === true, 'duplicate_idempotency_key');
  g(!!ctx.to_number && !!ctx.from_number && ctx.to_number !== ctx.from_number, 'invalid_endpoints');
  // Customer-initiated replies are exempt from messaging hours.
  g(ctx.is_reply_to_inbound === true || ctx.within_messaging_hours === true, 'outside_messaging_hours');
  g(ctx.rate_limit_ok === true, 'rate_limited');
  g(ctx.customer_replied_since_scheduled !== true, 'customer_replied_since_scheduled');

  let mode = 'real';
  if (ctx.test_mode === true) {
    const allow = (ctx.test_allowlist || []);
    mode = allow.includes(ctx.to_number) ? 'test_allowlisted' : 'mock';
  } else {
    g(ctx.allow_real_send === true, 'real_send_not_enabled');
  }
  return { allowed: failures.length === 0, failures, mode };
}

// ---------------------------------------------------------------------------
// Outbound content compliance (SB-06 / SB-04)
// ---------------------------------------------------------------------------
export function validateOutboundContent(content, templateId, rules) {
  const v = rules.outbound_validation || {};
  const text = String(content || '');
  if (v.block_empty && !text.trim()) return { ok: false, reason: 'empty' };
  if (v.max_message_length && text.length > v.max_message_length) {
    return { ok: false, reason: 'too_long' };
  }
  if (templateId && (v.whitelisted_template_ids || []).includes(templateId)) {
    return { ok: true, whitelistedTemplate: true };
  }
  for (const pattern of v.forbidden_content_patterns || []) {
    let re;
    try { re = new RegExp(pattern, 'i'); } catch { continue; }
    if (re.test(text)) return { ok: false, reason: 'forbidden_pattern', pattern };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Structured-output validation (subset of JSON Schema sufficient for our schema)
// ---------------------------------------------------------------------------
export function validateStructuredOutput(obj, schema) {
  const errors = [];
  const check = (value, sch, path) => {
    const types = Array.isArray(sch.type) ? sch.type : [sch.type];
    const jsType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const typeName = jsType === 'number' ? 'number' : jsType;
    if (sch.type && !types.includes(typeName)) {
      // integer not used; treat all numbers as number
      errors.push(`${path}: expected ${types.join('|')}, got ${typeName}`);
      return;
    }
    if (sch.enum && !sch.enum.includes(value)) errors.push(`${path}: not in enum`);
    if (typeName === 'string') {
      if (sch.maxLength && value.length > sch.maxLength) errors.push(`${path}: too long`);
    }
    if (typeName === 'number') {
      if (sch.minimum !== undefined && value < sch.minimum) errors.push(`${path}: < minimum`);
      if (sch.maximum !== undefined && value > sch.maximum) errors.push(`${path}: > maximum`);
    }
    if (typeName === 'array') {
      if (sch.maxItems !== undefined && value.length > sch.maxItems) errors.push(`${path}: too many items`);
      if (sch.items) value.forEach((it, i) => check(it, sch.items, `${path}[${i}]`));
    }
    if (typeName === 'object' && sch.properties) {
      for (const req of sch.required || []) {
        if (!(req in value)) errors.push(`${path}.${req}: missing`);
      }
      if (sch.additionalProperties === false) {
        for (const k of Object.keys(value)) {
          if (!sch.properties[k]) errors.push(`${path}.${k}: unexpected property`);
        }
      }
      for (const [k, v] of Object.entries(value)) {
        if (sch.properties[k]) check(v, sch.properties[k], `${path}.${k}`);
      }
    }
  };
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['root: not an object'] };
  }
  check(obj, schema, '$');
  return { valid: errors.length === 0, errors };
}

/** Extract the first JSON object from raw model text (repair step 0). */
export function extractJson(raw) {
  const text = String(raw || '').trim();
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* no */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Action permission matrix — the model recommends, n8n decides
// ---------------------------------------------------------------------------
const ALLOWED_ACTIONS_BY_OUTCOME = {
  no_match: ['reply_only', 'create_lead', 'human_handoff', 'suppress', 'no_action', 'schedule_followup'],
  single_match: ['reply_only', 'update_record', 'lookup_status', 'send_application_link',
    'schedule_call', 'schedule_followup', 'human_handoff', 'suppress', 'no_action'],
  multiple_match: ['human_handoff', 'suppress', 'no_action', 'reply_only'],
  opted_out: ['suppress', 'no_action'],
  wrong_number: ['suppress', 'no_action'],
  human_takeover: ['suppress', 'no_action'],
  ai_disabled: ['suppress', 'no_action']
};

export function isActionPermitted(requestedAction, resolutionOutcome) {
  const allowed = ALLOWED_ACTIONS_BY_OUTCOME[resolutionOutcome] || ['suppress', 'no_action'];
  return allowed.includes(requestedAction);
}

// ---------------------------------------------------------------------------
// Follow-up eligibility (SB-08 recheck, immediately before send)
// ---------------------------------------------------------------------------
export function followupEligible(ctx) {
  const reasons = [];
  const need = (cond, code) => { if (!cond) reasons.push(code); };
  need(ctx.global_ai_enabled === true, 'global_ai_disabled');
  need(ctx.followups_enabled === true, 'followups_disabled');
  need(ctx.opted_out !== true, 'opted_out');
  need(ctx.wrong_number !== true, 'wrong_number');
  need(ctx.human_takeover !== true, 'human_takeover');
  need(ctx.record_ai_enabled !== false, 'record_ai_disabled');
  need(ctx.consent_ok === true, 'consent_missing');
  need(ctx.attempt <= ctx.max_attempts, 'max_attempts_exceeded');
  need(ctx.stage_eligible === true, 'stage_not_eligible');
  need(ctx.inbound_since_scheduled !== true, 'customer_replied');
  need(ctx.appointment_pending !== true, 'appointment_pending');
  need(ctx.within_messaging_hours === true, 'outside_messaging_hours');
  return { eligible: reasons.length === 0, skipReasons: reasons };
}

// ---------------------------------------------------------------------------
// Error categorization (SB-10)
// ---------------------------------------------------------------------------
export function categorizeError(statusCode, context = {}) {
  const sc = Number(statusCode);
  if (sc === 401 || sc === 403) return { category: 'auth', retryable: false, alert: true };
  if (sc === 429) return { category: 'rate_limit', retryable: true, backoffSeconds: 60, alert: true };
  if (sc >= 500) return { category: 'upstream_5xx', retryable: true, backoffSeconds: 30, alert: false };
  if (sc === 408 || context.timeout) return { category: 'timeout', retryable: true, backoffSeconds: 15, alert: false };
  if (sc >= 400) return { category: 'client_error', retryable: false, alert: false };
  return { category: 'unknown', retryable: false, alert: true };
}
