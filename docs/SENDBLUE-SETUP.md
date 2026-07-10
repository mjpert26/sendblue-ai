# Sendblue Setup

How to configure Sendblue for Emma: API keys, the dedicated line, the Emma
bot seat, webhook registration with secrets, typing indicators, opt-out
behavior, the test allowlist, and rate limits. Several Sendblue behaviors
could not be re-verified at build time and are catalogued in
[`../ASSUMPTIONS.md`](../ASSUMPTIONS.md) — verify each flagged item against
the current Sendblue dashboard/docs during setup.

## 1. API keys

1. In the Sendblue dashboard, create (or locate) your API key pair: a **key
   ID** and a **secret key**. Sendblue authenticates every API request with
   two headers, `sb-api-key-id` and `sb-api-secret-key`, against
   `https://api.sendblue.com` (ASSUMPTIONS A-01).
2. Put them in `.env` as `SENDBLUE_API_KEY_ID` / `SENDBLUE_API_SECRET_KEY`
   (never commit) and into the n8n credential `Sendblue API (Header Auth)`
   ([`N8N-SETUP.md`](N8N-SETUP.md) §2.1).
3. Verify connectivity with the read-only discovery script:
   `npm run inspect:sendblue`.

## 2. Dedicated line

1. Provision a **dedicated phone number** for Emma — do not share a line
   humans also text from, or human replies and AI replies will interleave on
   one thread and delivery attribution becomes ambiguous.
2. Record it in `.env` as `SENDBLUE_FROM_NUMBER` in E.164 format
   (placeholder example: `+15550100001` — replace with your real line).
3. SB-06 passes this as `from_number` on every `POST /send-message` so all
   Emma traffic originates from the one line.

## 3. Emma bot seat (attribution) and inbox assignment

Sendblue **seats** each have a `seat_id` usable for attribution when sending.

1. In the Sendblue dashboard, create a seat for the assistant (name it after
   `ASSISTANT_NAME`, e.g., "Emma (AI)").
2. Copy its `seat_id` into `.env` as `SENDBLUE_EMMA_SEAT_ID`. When set, SB-06
   attaches it to outbound sends under a configurable parameter name
   (default `seat_id`) — the exact request-body parameter name on
   `/send-message` is unverified, so confirm it in current docs and adjust
   the config if needed (see ASSUMPTIONS.md A-05). Sends succeed without a
   seat; attribution is simply absent.
3. **Inbound conversation seat assignment is a manual dashboard step.** No
   API for assigning an inbound conversation/line to a seat was found, and
   none was invented (see ASSUMPTIONS.md A-06). In the dashboard, assign the
   dedicated line / inbox routing to the Emma seat so inbound threads appear
   under it. Re-check this assignment after adding lines or seats.

## 4. Webhook registration

Register two webhook subscriptions pointing at your n8n instance
(`N8N_WEBHOOK_BASE_URL`):

| Sendblue event type | URL | Handled by |
|---------------------|-----|-----------|
| `receive` | `https://<your-n8n>/webhook/sendblue/inbound` | SB-01 |
| `outbound` (delivery/status) | `https://<your-n8n>/webhook/sendblue/status` | SB-07 |

Supported webhook types are `receive`, `outbound`, `typing_indicator`,
`line_blocked`, `line_assigned`, `call_log`, `contact_created` (ASSUMPTIONS
A-04). Emma only needs `receive` and `outbound`; SB-06 additionally sets a
per-message `status_callback` to the SB-07 URL on each send.

### Webhook secret (verify the header name — A-03)

1. Generate a strong random secret and store it as
   `SENDBLUE_WEBHOOK_SECRET=__REPLACE_ME__` in `.env` and in the n8n
   environment.
2. Configure it in Sendblue as the webhook secret — Sendblue supports a
   per-URL secret and a `globalSecret`, delivered in the webhook **request
   headers**.
3. **Verify the exact header name Sendblue uses** in the current dashboard/
   docs. It could not be re-verified at build time; the workflows read it
   from `SENDBLUE_WEBHOOK_SECRET_HEADER` (default `sb-signing-secret`) and
   SB-01/SB-07 reject any request whose configured header does not exactly
   match the secret (see ASSUMPTIONS.md A-03). If your inbound webhooks 401,
   this mismatch is the first thing to check
   ([`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)).
4. Test: send a message from an allowlisted team phone to the dedicated line
   and confirm an SB-01 execution appears with outcome recorded in
   `processed_messages`.

## 5. Typing indicators (fail-soft — A-07)

A `typing_indicator` webhook type exists, and Sendblue has historically
offered an evoke-typing-indicator endpoint, but its current path could not be
re-verified. SB-04 treats typing as a **fail-soft** nicety: the path is
configurable (config key `sendblue.typing_indicator_path`, default
`/api/evoke-typing-indicator`), failures are logged and never block a reply,
and clearing the config key disables the feature entirely (see
ASSUMPTIONS.md A-07). Do not spend launch time debugging typing indicators —
disable and move on if they misbehave.

## 6. Opt-out behavior

Two enforcement layers, deliberately redundant:

1. **Ours (authoritative):** SB-01 detects opt-out phrases deterministically
   — before any model call — and writes `sms_opt_out` to Salesforce, the
   consent state the workflows enforce everywhere (SB-06 guard, SB-08
   recheck).
2. **Sendblue's:** SB-01 then calls the Sendblue contact opt-out operation,
   so Sendblue itself blocks outbound to that number as a backstop
   (ASSUMPTIONS A-08).

At most one non-promotional confirmation message is sent (template
`opt_out_confirmation` — wording pending compliance approval, see
[`../COMPLIANCE-REVIEW.md`](../COMPLIANCE-REVIEW.md) §1). Opt-back-in is
never inferred from a casual later message.

## 7. TEST allowlist guidance

While `TEST_MODE=true`, sends are mocked or restricted to the numbers in
`agent_config.test_allowlist_numbers` (comma-separated E.164).

1. Use only numbers **owned by the team** — testers' own phones. Never a
   customer's number, and never the fictional placeholders
   (`+15550100001,+15550100002`) shipped in the seed data.
2. Keep the list short and reviewed; remove testers who leave the project.
3. Remember the allowlist is a TEST_MODE construct only — it is not a
   production allow mechanism.

## 8. Rate limits

- Sendblue's Contacts/Messages APIs are rate-limited (~100 requests / 10
  seconds observed; ASSUMPTIONS A-09).
- SB-06 enforces its own conservative limits from config well below that:
  `outbound_per_minute_global` (default 20, `agent_config`
  `rate_limit_per_minute`) and `outbound_per_contact_per_hour` (default 4,
  [`../config/follow-up-policy.example.json`](../config/follow-up-policy.example.json)).
- On HTTP 429 from Sendblue, SB-06 backs off and SB-07/SB-10 alert on
  repeats; response steps in
  [`OPERATIONS-RUNBOOK.md`](OPERATIONS-RUNBOOK.md).

## Setup checklist

| # | Item | Done |
|---|------|------|
| 1 | API key pair created, in `.env` + n8n credential | ☐ |
| 2 | Dedicated line provisioned, `SENDBLUE_FROM_NUMBER` set | ☐ |
| 3 | Emma seat created; `SENDBLUE_EMMA_SEAT_ID` set; seat param verified (A-05) | ☐ |
| 4 | Line/inbox manually assigned to the Emma seat in the dashboard (A-06) | ☐ |
| 5 | `receive` + `outbound` webhooks registered with secret | ☐ |
| 6 | Secret header name verified against current docs (A-03) | ☐ |
| 7 | Test allowlist populated with real team numbers | ☐ |
| 8 | Inbound test message flows through SB-01 | ☐ |
