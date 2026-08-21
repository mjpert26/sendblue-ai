# n8n Setup

How to prepare an n8n instance for Emma: version requirements, the four
credentials, the 9 Data Tables, importing the 12 workflows, re-mapping Data
Table nodes, activation order, error-workflow wiring, and environment
variables. This document covers the n8n side only — for the overall
deployment sequence see [`DEPLOYMENT.md`](DEPLOYMENT.md).

## 1. Version requirements

- n8n must support **Data Tables** (a recent n8n feature; the
  `n8n-nodes-base.dataTable` node must be available). If your instance
  predates Data Tables, upgrade before importing — there is no fallback
  store by design (see [`ARCHITECTURE.md`](ARCHITECTURE.md) §2).
- Data Table node **parameter schemas vary between n8n versions**; the
  shipped workflow JSON uses version-tolerant parameters, but expect to
  re-map Data Table nodes after import (see §4 and ASSUMPTIONS.md A-12).
- The instance must be reachable over HTTPS at a stable base URL
  (`N8N_WEBHOOK_BASE_URL`) so Sendblue can deliver webhooks.
- Webhook processing should run in a mode where SB-01 can respond 200
  quickly (queue/main mode both work; avoid setups that block webhook
  responses on full execution).

## 2. Credentials

Create these four credentials in n8n (**Credentials → Add credential**). The
names below match the placeholder slots inside the imported workflows —
using the exact names makes re-attachment near-automatic.

### 2.1 `Sendblue API (Header Auth)`

1. Type: **Header Auth** (used for all Sendblue HTTP Request nodes).
   Sendblue authenticates with **two** headers (`sb-api-key-id` and
   `sb-api-secret-key`, ASSUMPTIONS A-01); if your n8n version's Header Auth
   supports only one header, use a **Custom Auth / Generic credential** type
   that can inject both, or set the second header on the HTTP nodes from an
   n8n environment variable — never hardcode the value in the node.
2. Header 1: name `sb-api-key-id`, value = your Sendblue key ID.
3. Header 2: name `sb-api-secret-key`, value = your Sendblue secret key.
4. Base URL used by the nodes: `https://api.sendblue.com`.

### 2.2 `Salesforce OAuth2`

1. Type: **Salesforce OAuth2 API**.
2. Enter the connected app's Consumer Key/Secret and your instance URL
   ([`SALESFORCE-SETUP.md`](SALESFORCE-SETUP.md) §1–2).
3. Complete the OAuth flow with the **dedicated API integration user** (least
   privilege — never a human admin account).

### 2.3 `Anthropic API`

1. Type: **Anthropic** (or Header Auth with `x-api-key` if you use raw HTTP
   Request nodes).
2. API key: your Anthropic key. The workflows call the Messages API
   (`POST /v1/messages`, `anthropic-version: 2023-06-01`, ASSUMPTIONS A-13).
3. Model is taken from configuration (`ANTHROPIC_MODEL`), not hardcoded.

### 2.4 `Slack API`

1. Type: **Slack API** (bot token).
2. Scopes: post messages to channels (`chat:write`) in the handoff and alerts
   channels. Invite the bot to both channels.

## 3. Data Tables

Create all 9 tables **before** importing workflows, exactly per
[`../data-tables/definitions.json`](../data-tables/definitions.json). In the
n8n UI: **Data Tables → Create table**, add each column with the listed type,
and mark the unique column where specified.

| Table | Unique column | Columns |
|-------|---------------|---------|
| `agent_config` | `key` | `key` (string), `value` (string), `updated_by` (string), `updated_at` (date) |
| `processed_messages` | `message_handle` | `message_handle`, `correlation_id`, `normalized_phone_hash` (string), `processed_at` (date), `outcome` (string) |
| `outbound_idempotency` | `idempotency_key` | `idempotency_key`, `correlation_id`, `message_handle`, `delivery_status` (string), `accepted_by_sendblue` (boolean), `created_at`, `updated_at` (date), `failure_count` (number) |
| `contact_locks` | `normalized_phone_hash` | `normalized_phone_hash`, `correlation_id` (string), `locked_at`, `expires_at` (date) |
| `retry_state` | `retry_key` | `retry_key`, `category` (string), `attempts` (number), `next_attempt_at` (date), `last_error_code` (string) |
| `dead_letter_events` | `event_id` | `event_id`, `correlation_id`, `workflow_name`, `category`, `error_code`, `sanitized_summary`, `message_handle`, `salesforce_record_ref` (string), `replayable` (boolean), `replayed_at`, `created_at` (date) |
| `approved_faq` | `faq_id` | `faq_id`, `intent`, `question`, `answer` (string), `required_verification_level`, `review_version` (number), `active`, `approved` (boolean) |
| `followup_jobs` | `job_id` | `job_id`, `salesforce_record_ref`, `normalized_phone_hash` (string), `due_at` (date), `attempt` (number), `status`, `reason` (string), `created_at`, `resolved_at` (date), `resolution` (string) |
| `test_results` | — | `run_id`, `case_id` (string), `passed` (boolean), `detail` (string), `executed_at` (date) |

Then seed `agent_config` from `data-tables/seed-data.example.json`
(everything disabled, `test_mode=true`), and replace the placeholder
`test_allowlist_numbers` with real team-owned E.164 numbers.

These tables hold **technical state only** — never CRM data, transcripts, or
raw phone numbers (phones are stored hashed).

## 4. Importing the 12 workflow JSONs

1. **Workflows → Import from file**, one file at a time from `workflows/`, in
   this order: SB-10, SB-06, SB-03, SB-05, SB-09, SB-04, SB-07, SB-01, SB-08,
   SB-02, SB-11, SB-00. (Dependencies first: SB-10 so it can be set as error
   workflow; SB-06 before anything that dispatches; callers last.)
   Alternatively use the gated `npm run deploy:n8n` script
   ([`DEPLOYMENT.md`](DEPLOYMENT.md) Phase 4).
2. Open each workflow and attach the four credentials from §2 to their
   placeholder slots (n8n flags nodes with missing credentials).
3. **Re-map Data Table node references.** Because Data Table node parameters
   differ across n8n versions and table IDs are instance-specific
   (ASSUMPTIONS.md A-12), open every Data Table node and re-select the target
   table (and, if prompted, the operation and column mappings) from your
   instance's dropdowns. The table each node needs is named in the node's
   title/notes (e.g., "processed_messages: check handle"). A node left
   unmapped fails at execution — SB-00 also flags this
   ([`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)).
4. Run `SB-00` manually after import — it verifies credentials, tables, and
   mappings without messaging anyone.

## 5. Activation order

Activate in dependency order so no active workflow calls an inactive one:

1. **SB-10** Error Handler (and set it as error workflow — §6).
2. **SB-06** Outbound Dispatcher (safe: every send is gated).
3. **SB-03** Resolver, **SB-05** Status Lookup, **SB-09** Handoff.
4. **SB-04** Conversation Orchestrator.
5. **SB-07** Delivery Status webhook.
6. **SB-01** Inbound Router (this is the moment inbound traffic can flow).
7. **SB-08** Follow-Up Orchestrator (schedule trigger; still gated by
   `followups_enabled`).
8. **SB-02** — leave **inactive** unless Journey F outreach has been
   explicitly approved (ASSUMPTIONS.md A-18,
   [`../COMPLIANCE-REVIEW.md`](../COMPLIANCE-REVIEW.md) §1).
9. SB-00 and SB-11 are manual — they need no activation.

Deactivation for rollback is the reverse — see [`ROLLBACK.md`](ROLLBACK.md).

## 6. Error-workflow wiring (SB-10)

1. In each imported workflow's **Settings → Error workflow**, select
   **SB-10 Error Handler & DLQ**. If your n8n version supports an
   instance-level default error workflow, set that too.
2. Verify: force a test error (e.g., temporarily point a Salesforce node at a
   bad object in a copy of a workflow, or use SB-11's error fixture) and
   confirm SB-10 executes, writes a sanitized `dead_letter_events` row, and
   posts a grouped alert to `SLACK_ALERTS_CHANNEL_ID`.
3. SB-10 classifies retryable vs non-retryable failures and supports safe
   replay that preserves idempotency — replay procedure in
   [`OPERATIONS-RUNBOOK.md`](OPERATIONS-RUNBOOK.md).

## 7. Environment variables in n8n

Set these on the n8n instance (container env / `.env` of the deployment — not
inside workflow JSON). They mirror the repo's `.env.example`:

| Variable | Purpose | Safe default |
|----------|---------|--------------|
| `ASSISTANT_NAME`, `COMPANY_NAME` | Identity substitution in prompts/templates | `Emma`, `Big Think Capital` |
| `TEST_MODE` | Mock/allowlist-restrict all sends | `true` |
| `ALLOW_REAL_SEND` | Second key for real sends | `false` |
| `SENDBLUE_FROM_NUMBER` | Dedicated line (E.164) | — |
| `SENDBLUE_EMMA_SEAT_ID` | Seat attribution on sends (A-05) | empty |
| `SENDBLUE_WEBHOOK_SECRET` | Shared webhook secret | `__REPLACE_ME__` |
| `SENDBLUE_WEBHOOK_SECRET_HEADER` | Header carrying the secret (A-03) | `sb-signing-secret` |
| `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_TOKENS` | Model config | `claude-sonnet-5`, `1024` |
| `SLACK_HANDOFF_CHANNEL_ID`, `SLACK_ALERTS_CHANNEL_ID` | Slack targets | `__REPLACE_ME__` |
| `MESSAGING_HOURS_START/END`, `MESSAGING_TIMEZONE` | Proactive-send window (A-17) | `09:00`/`20:00`, `America/New_York` |
| `FOLLOWUP_MAX_ATTEMPTS` | Follow-up cap | `3` |
| `APPLICATION_LINK_BASE_URL` | The only URL allowed in outbound text | placeholder |
| `SF_PLACEHOLDER_VALUES` | Values scrubbed to null in the prefill payload | `Unknown,Other - Other,Other,N/A,None,TBD` |
| `RESET_CONTROL_ENABLED` | Honour the `RESET` control word (testing only) | `false` |
| `RESET_CONTROL_NUMBERS` | Comma-separated numbers allowed to send `RESET` | empty |

`RESET` lets a tester clear conversation history without the message reaching
the model — a meaningless message scores low confidence, which deterministically
triggers a human handoff and mutes the assistant for that contact. Keep
`RESET_CONTROL_ENABLED` at `false` in production so a customer cannot
un-escalate themselves out of a handoff; an unpermitted `RESET` is handled as an
ordinary message.

API keys themselves live in n8n **credentials** (§2), not env vars. Restart
n8n after changing environment variables so workflows pick them up.
