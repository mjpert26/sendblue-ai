# ASSUMPTIONS

Every material assumption made while building this system. Each item states what
was verified, what could not be verified, and the safe behavior implemented.
Review each item before production activation.

Legend: **Verified** = confirmed against current official documentation or the
organization's live tooling. **Assumed** = could not be fully verified from the
build environment; implemented as a configurable, fail-safe placeholder.

---

## A-01 — Sendblue authentication (Verified)
Sendblue authenticates with two request headers, `sb-api-key-id` and
`sb-api-secret-key`, against base URL `https://api.sendblue.com`
(docs.sendblue.com). All workflow HTTP nodes use an n8n Header Auth credential
placeholder named `Sendblue API (Header Auth)` — no keys are embedded.

## A-02 — Sendblue send endpoint and statuses (Verified)
`POST /send-message` sends a single message (`number`, `content` or
`media_url`, `from_number`, optional `status_callback`). Documented message
status values: `REGISTERED, PENDING, SENT, DELIVERED, RECEIVED, QUEUED, ERROR,
DECLINED, ACCEPTED, SUCCESS`. The delivery-status workflow (SB-07) treats any
status outside this list as unknown and alerts instead of guessing.

## A-03 — Sendblue webhook secret header name (Assumed)
Sendblue documentation states a configured webhook secret is included in the
webhook request headers, and webhooks support per-URL secrets and a
`globalSecret`. The exact header name could not be re-verified from this build
environment (docs.sendblue.com was unreachable through the network policy).
**Implementation:** the header name is configurable
(`SENDBLUE_WEBHOOK_SECRET_HEADER`, default `sb-signing-secret`); SB-01 and
SB-07 reject any request whose configured header does not exactly match the
configured secret. Confirm the exact header name in the Sendblue dashboard /
current docs during setup (docs/SENDBLUE-SETUP.md).

## A-04 — Sendblue webhook event types (Verified)
Webhook subscriptions support types: `receive`, `outbound`, `typing_indicator`,
`line_blocked`, `line_assigned`, `call_log`, `contact_created` (confirmed via
the organization's Sendblue tooling). SB-01 subscribes to `receive`; SB-07
handles outbound/delivery status callbacks (per-message `status_callback` and
account-level `outbound` webhooks).

## A-05 — Bot seat attribution on outbound sends (Partially verified)
Sendblue seats each have a `seat_id` usable **for attribution when sending
messages** (verified). The exact request-body parameter name on
`/send-message` could not be re-verified. **Implementation:** SB-06 attaches
the configured seat id under a configurable parameter name
(`sendblue.seat_param`, default `seat_id`) only when `SENDBLUE_EMMA_SEAT_ID`
is configured; sends succeed without it.

## A-06 — Inbound conversation seat assignment (Not documented — not implemented)
No documented API was found for assigning an *inbound* conversation to a seat.
Per instructions, this is NOT invented. docs/SENDBLUE-SETUP.md documents the
manual dashboard step (create the Emma seat, assign the dedicated line /
inbox routing in the Sendblue dashboard).

## A-07 — Typing indicators (Assumed)
A `typing_indicator` webhook type exists (verified). Sendblue has historically
documented an evoke-typing-indicator endpoint; its current v2 path could not be
re-verified. **Implementation:** typing start/stop is a configurable, fail-soft
sub-operation (config key `sendblue.typing_indicator_path`, default
`/api/evoke-typing-indicator`). Failures are logged and never block or fail a
conversation. Disable by clearing the config key.

## A-08 — Sendblue opt-out API (Verified)
A contact opt-out operation exists (opt out / opt back in by number);
outbound messages to opted-out numbers are blocked at the Sendblue layer.
SB-01 opt-out handling updates Salesforce first (source of truth for consent
state we enforce), then calls the Sendblue opt-out operation.

## A-09 — Sendblue rate limits (Partially verified)
Contacts and Messages APIs are rate-limited (100 requests / 10 seconds
observed on the org tooling). SB-06 enforces its own conservative outbound
rate limit from the config table (`rate_limit_per_minute`, default 20) and
backs off on HTTP 429.

## A-10 — Salesforce org schema (Assumed — discovery-driven)
No live Salesforce credentials are used at build time, so **no custom field
API names are assumed**. `scripts/inspect-salesforce-fields.mjs` +
`scripts/generate-salesforce-map.mjs` generate
`config/salesforce-field-map.generated.json` from the org's `describe`
endpoints. `config/salesforce-field-map.example.json` uses standard fields
(`Lead.FirstName`, `Lead.Company`, `Lead.MobilePhone`, …) and leaves every
custom mapping (`ai_enabled`, `human_takeover`, `sms_consent`, …) as
explicitly-marked `UNMAPPED` placeholders. Health check (SB-00) fails RED when
a *required* mapping is `UNMAPPED`; optional mappings degrade gracefully
(feature is skipped and logged).

## A-11 — Salesforce Company placeholder (Assumed)
`Lead.Company` is required by standard Salesforce validation. When a Lead must
be created before the business name is known, the configurable placeholder
`Unknown (Sendblue AI intake)` (config `lead_intake.company_placeholder`) is
used and replaced as soon as the real business name is collected.

## A-12 — n8n Data Tables node parameters (Assumed)
n8n Data Tables are a recent n8n feature; exact node parameter schemas vary by
n8n version. Workflow JSON uses the `n8n-nodes-base.dataTable` node with
version-tolerant parameters and documents the required tables in
`data-tables/definitions.json`. If your n8n version differs, re-map the Data
Table nodes after import (docs/N8N-SETUP.md). Table *semantics* (idempotency,
locks, config) are version-independent.

## A-13 — Anthropic API (Verified against current SDK knowledge)
Uses the Messages API (`POST /v1/messages`, `anthropic-version: 2023-06-01`,
`x-api-key`) with a `tools`/JSON-schema-constrained structured output pattern:
the workflow instructs strict JSON and validates against
`prompts/structured-output-schema.json`, with exactly one repair attempt.
Model id is configurable (`ANTHROPIC_MODEL`, default `claude-sonnet-5`).

## A-14 — OTP / Level-2 verification provider (Not configured — not invented)
No approved one-time-code provider was specified. Verification Level 2 is a
pluggable interface (config `verification.level2_provider`, default `null`).
While unconfigured, every request requiring Level 2 escalates to a human. No
OTP implementation was invented.

## A-15 — Customer-safe stage mapping (Assumed)
The stage values in `config/customer-safe-status-map.example.json` are
placeholders. They deliberately do NOT assume they match the org's real
Opportunity/StageName values; the `internal_value` fields must be populated
from discovery output and reviewed by compliance before activation.

## A-16 — FAQ answers are placeholders (Assumed)
Every answer in `config/approved-faq.example.json` is marked
`"placeholder_requires_compliance_approval": true`. None may reach a customer
until reviewed (COMPLIANCE-REVIEW.md).

## A-17 — Messaging hours & timezone (Assumed)
Customer timezone is not reliably known from a phone number. Follow-ups and
outbound sends use a single configured business timezone
(`MESSAGING_TIMEZONE`, default America/New_York) and window (09:00–20:00).
Replies to an inbound customer message are allowed outside the window
(customer-initiated); proactive sends are not.

## A-18 — Consent for Journey F outreach (Conservative)
Existence of a Salesforce Lead is NOT treated as messaging consent. SB-02 is
disabled by default and requires mapped `sms_consent`, `consent_source`, and
`consent_timestamp` fields plus config `outreach.enabled=true` and a
compliance-reviewed template. TCPA/carrier compliance sign-off is a launch
blocker (COMPLIANCE-REVIEW.md).

## A-19 — Network policy at build time
docs.sendblue.com, docs.n8n.io and developer.salesforce.com were not directly
reachable from the build container (proxy policy). Facts above were grounded
via web search excerpts of the official docs and the organization's live
Sendblue/Salesforce MCP tooling. Items that could not be grounded are marked
Assumed with safe fallbacks.

## A-20 — Persistence split: Data Tables vs Postgres (Revised)
Sendblue holds message history and Salesforce holds business state. Technical
state is split: operator-editable configuration (`agent_config`) and the
low-contention tables stay in n8n Data Tables, while concurrency-critical
state — inbound dedupe (`processed_messages`), per-contact locks
(`contact_locks`), the outbound send claim (`outbound_idempotency`) and funnel
telemetry (`conversation_events`) — lives in Postgres on Supabase
(`db/schema.sql`). Reason: a Data Table read-then-write is not atomic, and a
race on the send claim can double-text a customer; a primary-key INSERT cannot.
n8n reaches Postgres through the Supabase Session pooler (port 5432, SSL); the
direct connection is IPv6-only. The n8n Postgres node's "Query Parameters"
option is used for every value that originates outside the workflow (Sendblue
response fields) so nothing is string-interpolated into SQL.
