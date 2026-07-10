# Operations Runbook

Day-2 operations for Emma: routine checks, the kill switch, monitoring
signals, log hygiene, correlation-ID tracing, incident response, and DLQ
replay. Keep this document and [`ROLLBACK.md`](ROLLBACK.md) bookmarked by
everyone on call. Kill-switch ownership and log-sanitization rules are
compliance sign-off items
([`../COMPLIANCE-REVIEW.md`](../COMPLIANCE-REVIEW.md) §5–6).

## 1. Daily operations

1. Check `SLACK_ALERTS_CHANNEL_ID` for overnight SB-07/SB-10 alerts; triage
   anything ungrouped or repeated.
2. Review `dead_letter_events` for new rows (`replayed_at` empty). Growth
   day-over-day is a warning sign even if each row looks benign.
3. Scan the handoff channel: every handoff should have a claimed owner /
   completed Salesforce Task.
4. Spot-check 2–3 transcripts in Sendblue for tone and compliance drift
   (placeholder wording, forbidden claims).
5. Confirm SB-08's scheduled runs executed and skip reasons look sane (e.g.,
   `messaging_hours`, `customer_replied`) rather than erroring.

## 2. Weekly operations

1. Run **SB-00** and file/fix any YELLOW items.
2. Review `retry_state` for keys stuck near max attempts.
3. Review outbound volume vs rate limits; revisit A-20 if Data Table
   operations are becoming a bottleneck ([`ARCHITECTURE.md`](ARCHITECTURE.md) §2).
4. Re-run `npm run inspect:salesforce` if admins changed schema; diff the
   generated map; update the local field map + status map if needed.
5. Verify Data Table retention is actually pruning (`processed_messages` ≤30
   days, `contact_locks` ≤1 day, etc.).
6. Review who is on the TEST allowlist and the resume-authorized list.

## 3. Kill-switch procedures

**Who:** the named kill-switch owner plus all on-call operators — anyone
with n8n access may flip it in an emergency; flipping it back requires the
owner. **It is always correct to flip it first and investigate second.**

Engage:

1. n8n → **Data Tables → agent_config** → set `global_ai_enabled` = `false`;
   set `updated_by` to your name and `updated_at` to now.
2. Verify: send a test message from an allowlisted phone — SB-01 must
   short-circuit with outcome `suppressed_global_disable` (check the
   execution and `processed_messages`); no SB-06 execution may reach the
   send node.
3. Announce in the alerts channel: who, when, why.

Scoped alternatives (lower blast radius): `outbound_enabled=false` (no sends
but inbound processing/CRM updates continue), `followups_enabled=false`
(only proactive follow-ups stop), per-record `ai_enabled`/`human_takeover`
([`HUMAN-HANDOFF.md`](HUMAN-HANDOFF.md) §7).

Disengage: owner confirms root cause fixed → set back to `true` → verify
with one allowlisted end-to-end test → announce.

## 4. Monitoring signals

| Signal | Source | Meaning / threshold |
|--------|--------|---------------------|
| Repeated delivery failures to one number | SB-07 | Line/carrier issue; SB-07 alerts, never resends |
| HTTP 401 from Sendblue | SB-07/SB-10 alert | Credential invalid/rotated — treat as incident (§7.1) |
| HTTP 429 from Sendblue | SB-06 backoff + alert | Rate pressure; check volume |
| `line_blocked` / line issues | SB-07 | Carrier blocked the line — escalate to Sendblue support |
| Unknown delivery status value | SB-07 | Outside the documented list (A-02) — alert, don't guess |
| DLQ growth | `dead_letter_events` count | Any sustained growth; page if >10/hour |
| Health check RED/YELLOW | SB-00 | RED = do not operate; YELLOW = fix this week |
| Claude JSON invalid after repair | SB-04 fallback counter | Occasional is expected; a spike means schema/model drift |
| Locks not expiring | `contact_locks` | Rows past `expires_at` = crashed executions |
| Follow-up skips | SB-08 skip reasons | All skips are recorded; audit weekly |

## 5. Log sanitization rules

Enforced by workflow design and `npm run validate`; anything below appearing
in logs/alerts/DLQ is itself an incident:

- **Never logged anywhere:** message bodies, media, raw phone numbers
  (hashed as `normalized_phone_hash` instead), names + record data
  combined, SSN/DOB/bank/card values (redacted even inside error text), API
  keys/tokens/secrets, Claude prompt contents or raw completions.
- **Allowed in logs/DLQ:** correlation IDs, message handles, hashed phones,
  workflow/node names, error codes, sanitized one-line summaries, Salesforce
  record refs (IDs, not field data).
- Slack alerts follow the same rules; Slack handoff summaries may include
  first name/business context but never sensitive values
  ([`HUMAN-HANDOFF.md`](HUMAN-HANDOFF.md) §3).

## 6. Correlation-ID tracing

Every inbound event gets a `correlation_id` in SB-01, carried everywhere. To
trace a customer turn:

1. Start from any artifact bearing the ID (Slack alert, DLQ row, handoff
   post).
2. `processed_messages` → the inbound handle, outcome, timing.
3. n8n execution list → filter executions around `processed_at`; the ID is
   in each execution's data (SB-01 → SB-03 → SB-04 → SB-05/09 → SB-06).
4. `outbound_idempotency` → rows with that `correlation_id`: what was
   dispatched, `accepted_by_sendblue`, `delivery_status` (updated by SB-07).
5. `dead_letter_events` → any failure rows for the ID.
6. Message content, if needed, is viewed **in Sendblue** (by
   `message_handle`) — never in our stores.

## 7. Common incidents

### 7.1 Sendblue 401 (auth failure)

1. Alert fires from SB-07/SB-10. Sends are failing — decide whether to set
   `outbound_enabled=false` to stop retry noise.
2. Check whether keys were rotated in the Sendblue dashboard; update the n8n
   credential `Sendblue API (Header Auth)`.
3. Verify with `npm run inspect:sendblue`, then one allowlisted test send.
4. Replay any non-accepted, replayable DLQ rows (§8).

### 7.2 Sendblue 429 (rate limited)

1. SB-06 backs off automatically; confirm in `retry_state`.
2. Check for a send loop: many `outbound_idempotency` rows to few recipients
   = investigate; broad organic volume = lower `rate_limit_per_minute` in
   `agent_config`.
3. Persistent 429 at low volume → contact Sendblue (account-level limit,
   A-09).

### 7.3 Sendblue 5xx / outage

1. SB-06 retries transient failures with backoff; unsent messages are never
   double-sent (idempotency keys).
2. Extended outage: set `followups_enabled=false` to avoid queue pileup;
   inbound webhooks may also be delayed — expect a burst on recovery, which
   dedupe absorbs.
3. On recovery, replay retryable DLQ rows (§8).

### 7.4 Salesforce token expiry / auth failure

1. Symptom: SB-03 resolution failures → conversations escalate (fail-safe:
   unresolved = Level 0, no disclosure); DLQ rows with Salesforce error
   codes.
2. Re-authorize the `Salesforce OAuth2` credential in n8n (refresh token may
   have been revoked — check the connected-app policies and the integration
   user's status).
3. Run SB-00 to confirm GREEN, then replay retryable rows.

### 7.5 Claude outage / errors

1. Fail-safe by design: deterministic paths (opt-out, wrong number, kill
   switches, status templates via SB-05, FAQ cache) keep working; for turns
   needing the model, SB-04 falls back to the `fallback_generic` template
   (loops in a human) after retry/repair fails — customers are never left
   hanging on an error.
2. Watch handoff volume — a model outage shows up as a handoff spike.
3. If prolonged, consider `global_ai_enabled=false` and announcing manual
   coverage in the handoff channel.

### 7.6 Webhook flood / suspected abuse

1. Dedupe (`processed_messages`) and per-contact locks absorb duplicates and
   bursts; secret validation rejects unauthenticated posts.
2. If floods are unauthenticated: rotate `SENDBLUE_WEBHOOK_SECRET` (update
   both Sendblue and n8n env), consider IP-level filtering in front of n8n.
3. If authenticated (Sendblue retry storm): confirm SB-01 is answering 200
   fast; a slow responder causes retries.

### 7.7 Duplicate sends suspected

1. Get the recipient's rows in `outbound_idempotency`: two rows with
   different `idempotency_key` but same content = an upstream generated two
   correlations (check SB-01 dedupe and debounce); one row but customer got
   two messages = check Sendblue side / carrier duplication with the
   `message_handle`s.
2. Verify only SB-06 can send (`npm run validate` enforces this repo-side).
3. If actively duplicating, `outbound_enabled=false` while investigating.

## 8. Replay procedure (SB-10 / DLQ)

1. Filter `dead_letter_events` for `replayable = true` and `replayed_at`
   empty. Read each `sanitized_summary` — replay is per-row and deliberate,
   never bulk-blind.
2. Fix the underlying cause first (credential, mapping, outage).
3. Trigger SB-10's replay entry for the row(s). Replay **preserves the
   original idempotency key**, so a send that already reached Sendblue can
   never go out twice; SB-10 refuses to replay any event whose send was
   already accepted (`accepted_by_sendblue = true`).
4. SB-10 stamps `replayed_at`. Verify outcome via the correlation ID (§6).

## 9. Escalation contacts

Placeholders — fill in at launch and keep current:

| Role | Name | Contact | When |
|------|------|---------|------|
| Kill-switch owner | __REPLACE_ME__ | __REPLACE_ME__ | Any customer-impacting incident |
| On-call engineer (n8n/workflows) | __REPLACE_ME__ | __REPLACE_ME__ | Execution failures, DLQ growth |
| Salesforce admin | __REPLACE_ME__ | __REPLACE_ME__ | Auth, schema, permissions |
| Compliance officer | __REPLACE_ME__ | __REPLACE_ME__ | Any content/disclosure incident |
| Sendblue support | — | per Sendblue account | Line blocked, carrier issues |
| Anthropic status/support | — | status page / support | Model outage |
