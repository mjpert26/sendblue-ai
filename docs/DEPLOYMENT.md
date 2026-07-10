# Deployment Guide

End-to-end procedure for taking Emma from this repository to a live n8n
instance. The system ships in its safest state: `TEST_MODE=true`, the global
kill switch off, outreach (SB-02) disabled. Follow the phases in order; do not
skip the health-check and UAT phases. Nothing may message a real customer
until every item in [`../COMPLIANCE-REVIEW.md`](../COMPLIANCE-REVIEW.md) is
signed off.

## Phase 0 — Prerequisites

1. An n8n instance (self-hosted or cloud) on a version with **Data Tables**
   support, reachable at a stable HTTPS URL (see
   [`N8N-SETUP.md`](N8N-SETUP.md) for version notes).
2. A Sendblue account with API keys and a **dedicated line** for Emma
   ([`SENDBLUE-SETUP.md`](SENDBLUE-SETUP.md)).
3. A Salesforce org with a connected app + API integration user
   ([`SALESFORCE-SETUP.md`](SALESFORCE-SETUP.md)).
4. An Anthropic API key with access to the configured model
   (`ANTHROPIC_MODEL`).
5. A Slack app/bot with permission to post to the handoff and alerts channels.
6. Node.js ≥ 20 locally for the repo scripts.
7. Named owners for: the kill switch, compliance sign-off, and the on-call
   rotation ([`OPERATIONS-RUNBOOK.md`](OPERATIONS-RUNBOOK.md)).

## Phase 1 — Environment setup

1. Clone the repo and install dependencies (`npm install`).
2. `cp .env.example .env` and fill in every `__REPLACE_ME__`. **Never commit
   `.env`.** Leave the safety gates at their defaults for now:
   `TEST_MODE=true`, `ALLOW_REAL_SEND=false`, `ALLOW_N8N_WRITE=false`.
3. Run `npm run validate` — it must pass before anything else (it also
   enforces the no-secrets/no-phone-numbers rules from
   [`../CLAUDE.md`](../CLAUDE.md)).
4. Run `npm test` — the mocked fixture harness must be green
   ([`TESTING.md`](TESTING.md)).

## Phase 2 — Salesforce discovery and field-map resolution

1. Complete [`SALESFORCE-SETUP.md`](SALESFORCE-SETUP.md) through the API-user
   step.
2. Run `npm run inspect:salesforce` to pull the org's object/field describes.
3. Run `npm run generate:sf-map` — this writes
   `config/salesforce-field-map.generated.json` (gitignored).
4. Copy `config/salesforce-field-map.example.json` to a local
   `config/salesforce-field-map.json` and resolve **every entry marked
   `UNMAPPED`** using the generated file. Required logical fields
   (`ai_enabled`, `human_takeover`, `sms_consent`, `sms_opt_out`, plus
   identity/company/phone/lead_source/owner mappings) must be mapped or SB-00
   will report RED (see ASSUMPTIONS.md A-10). Optional fields may stay
   `UNMAPPED` — the dependent feature is skipped and logged.
5. Populate the `internal_values` placeholders in
   `config/customer-safe-status-map.example.json` (copied locally) from the
   real Lead Status / Opportunity StageName picklists in the generated map
   (see ASSUMPTIONS.md A-15). Wording changes require compliance review.

## Phase 3 — Data Tables

1. In the n8n UI, create the 9 Data Tables exactly as defined in
   [`../data-tables/definitions.json`](../data-tables/definitions.json)
   (columns, types, unique constraints). Step-by-step:
   [`N8N-SETUP.md`](N8N-SETUP.md) §3.
2. Seed `agent_config` from `data-tables/seed-data.example.json`. Confirm the
   safe defaults landed: `global_ai_enabled=false`, `outbound_enabled=false`,
   `followups_enabled=false`, `test_mode=true`.
3. Set `test_allowlist_numbers` to a comma-separated list of E.164 numbers
   **owned by your team** (the seeded `+15550100001,+15550100002` are
   fictional placeholders and must be replaced).

## Phase 4 — Import workflows and attach credentials

Two import paths:

- **Manual UI import (recommended first time):** import the 12 JSON files
  from `workflows/` in this order — SB-10 (error handler first, so everything
  imported after can reference it), SB-06, SB-03, SB-05, SB-09, SB-04, SB-07,
  SB-01, SB-08, SB-02, SB-11, SB-00.
- **Scripted:** `npm run deploy:n8n`. This writes to a live instance **only**
  when `N8N_API_URL`, `N8N_API_KEY`, and `ALLOW_N8N_WRITE=true` are all set;
  otherwise it only writes local files (see [`../CLAUDE.md`](../CLAUDE.md)
  rule 4).

Then:

1. Create the four n8n credentials and attach them to the placeholder slots
   in every imported workflow ([`N8N-SETUP.md`](N8N-SETUP.md) §2):
   - `Sendblue API (Header Auth)`
   - `Salesforce OAuth2`
   - `Anthropic API`
   - `Slack API`
2. Re-map the Data Table node references — node parameter schemas vary by n8n
   version (see ASSUMPTIONS.md A-12 and
   [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)).
3. Set SB-10 as the instance/workflow-level **error workflow**
   ([`N8N-SETUP.md`](N8N-SETUP.md) §6).
4. Configure environment variables in n8n (mirror of `.env` values relevant
   at runtime — [`N8N-SETUP.md`](N8N-SETUP.md) §7).

## Phase 5 — Health check to GREEN

1. Run **SB-00 Discovery & Health Check** manually. It is read-only and never
   messages customers.
2. Fix every RED item (missing credential, `UNMAPPED` required field, missing
   Data Table/column, unreachable API) and every YELLOW item you can. Consult
   [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) for common RED causes.
3. Repeat until the report is GREEN. Do not proceed on RED.

## Phase 6 — Webhook registration

1. Activate SB-01 and SB-07 in n8n so their webhook paths
   (`…/webhook/sendblue/inbound`, `…/webhook/sendblue/status`) are live.
2. Register the Sendblue webhooks per [`SENDBLUE-SETUP.md`](SENDBLUE-SETUP.md):
   `receive` → SB-01, `outbound`/status → SB-07, each with the shared secret.
   Verify the exact secret header name against current Sendblue docs — it is
   configurable via `SENDBLUE_WEBHOOK_SECRET_HEADER`, default
   `sb-signing-secret` (see ASSUMPTIONS.md A-03).
3. Send a test message **from an allowlisted team phone** to the dedicated
   line and confirm SB-01 executes, dedupes, and the correlation ID appears
   in `processed_messages`.

## Phase 7 — UAT in TEST_MODE

With `TEST_MODE=true`, sends are mocked or restricted to
`test_allowlist_numbers` — real customers cannot be messaged.

1. Activate the remaining workflows in the order given in
   [`N8N-SETUP.md`](N8N-SETUP.md) §5 (leave SB-02 inactive).
2. Set `agent_config.global_ai_enabled=true` and `outbound_enabled=true`
   (safe: TEST_MODE still gates real sends).
3. Run SB-11 (in-n8n harness) and the UAT script in
   [`TESTING.md`](TESTING.md) §7 from allowlisted phones: qualification flow,
   FAQ, status lookup at each verification level, opt-out, wrong number,
   handoff + resume, follow-up scheduling and cancellation.
4. Have compliance review live transcripts from UAT and complete
   [`../COMPLIANCE-REVIEW.md`](../COMPLIANCE-REVIEW.md), including replacing
   every placeholder customer-facing string.

## Phase 8 — Launch flip

Only after the launch checklist below is fully checked:

1. Set `TEST_MODE=false` **and** `ALLOW_REAL_SEND=true` (both are required
   for any real send; either one alone keeps sends blocked).
2. Update the corresponding `agent_config.test_mode` key to `false`.
3. Send one supervised end-to-end message from a team phone (now a real send)
   and verify delivery + SB-07 status callback.
4. Announce launch in the ops channel with the kill-switch procedure linked
   ([`OPERATIONS-RUNBOOK.md`](OPERATIONS-RUNBOOK.md)).

## Phase 9 — Post-launch monitoring

For the first 48 hours: watch the alerts channel for SB-07 delivery failures
and SB-10 DLQ entries; run SB-00 daily; review every handoff in the Slack
channel; sample transcripts in Sendblue for tone/compliance drift; verify
follow-up skip reasons look sane. Ongoing cadence:
[`OPERATIONS-RUNBOOK.md`](OPERATIONS-RUNBOOK.md).

## Launch checklist

| # | Item | Reference | Done |
|---|------|-----------|------|
| 1 | `npm run validate` and `npm test` green | [`TESTING.md`](TESTING.md) | ☐ |
| 2 | All required field mappings resolved (no `UNMAPPED`) | Phase 2 | ☐ |
| 3 | Status-map `internal_values` populated from real picklists | ASSUMPTIONS A-15 | ☐ |
| 4 | 9 Data Tables created + seeded with safe defaults | Phase 3 | ☐ |
| 5 | 12 workflows imported, credentials attached, Data Table nodes re-mapped | Phase 4 | ☐ |
| 6 | SB-10 wired as global error workflow | [`N8N-SETUP.md`](N8N-SETUP.md) | ☐ |
| 7 | SB-00 health check GREEN | Phase 5 | ☐ |
| 8 | Webhooks registered; secret header name verified (A-03) | Phase 6 | ☐ |
| 9 | Emma seat created + line assigned in dashboard (A-06) | [`SENDBLUE-SETUP.md`](SENDBLUE-SETUP.md) | ☐ |
| 10 | UAT scenarios passed from allowlisted numbers | Phase 7 | ☐ |
| 11 | **Every item in COMPLIANCE-REVIEW.md signed off** | [`../COMPLIANCE-REVIEW.md`](../COMPLIANCE-REVIEW.md) | ☐ |
| 12 | Placeholder customer-facing strings replaced with approved wording | COMPLIANCE-REVIEW §2 | ☐ |
| 13 | Kill-switch owner named; rollback doc read by on-call | [`ROLLBACK.md`](ROLLBACK.md) | ☐ |
| 14 | SB-02 (Journey F) confirmed still disabled unless separately approved | ASSUMPTIONS A-18 | ☐ |
| 15 | `TEST_MODE=false` + `ALLOW_REAL_SEND=true` flipped, supervised send OK | Phase 8 | ☐ |
