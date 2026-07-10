# Emma POC — textable proof of concept

A single self-contained n8n workflow (`EMMA-POC-textable-bot.json`) so the team
can text Emma and see her converse — **before** any Salesforce integration.

> ⚠️ **POC, not production.** This deliberately deviates from the production
> architecture (it sends directly instead of going through SB-06, has no
> Salesforce state, and keeps conversation memory in n8n workflow static
> data). It is safe to run because of the hard gates below, but it is retired
> the moment the SB-01→SB-06 pipeline goes live. It lives in `poc/`, outside
> the validated `workflows/` directory, on purpose.

## Safety gates (all enforced in the first Code node)

1. **Allowlist** — replies ONLY to team phone numbers listed in `ALLOWLIST`.
   Any other sender is ignored silently (no reply, no processing). Real
   customers can never reach the POC even though the account webhook is
   account-wide.
2. **Single line** — only processes messages addressed to `POC_LINE`; traffic
   on every other company line is ignored.
3. **Webhook secret** — the Sendblue webhook secret is value-matched across
   request headers; non-matching requests are dropped.
4. **Dedupe** — message handles are tracked in static data; webhook retries
   don't produce duplicate replies.
5. **Opt-out** — STOP/unsubscribe etc. is detected deterministically before
   the model, confirmed once, and the number is locally suppressed after.
6. **Output guardrails** — model output is JSON-validated; forbidden claims
   (guaranteed approval/rate, "you are approved", "we are a bank") swap the
   reply for a safe fallback.

## Deploy (values marked `__SET_IN_N8N__` / `__SET_*__`)

| Placeholder | Set to |
|---|---|
| `ALLOWLIST` | Team E.164 numbers allowed to text the POC |
| `POC_LINE` | The Sendblue line Emma answers on |
| `WEBHOOK_SECRET` | The account webhook secret |
| Anthropic credential | Existing n8n Anthropic credential (id in `credentials`) |
| `sb-api-key-id` / `sb-api-secret-key` | Sendblue API headers (n8n instance convention) |

Then: import → activate → register a Sendblue `receive` webhook pointing at
`https://<n8n-host>/webhook/emma-poc` → text the line from an allowlisted
phone.

## What the POC intentionally skips (tracked for the full build)

Salesforce record resolution/writes, verification levels, status lookup,
follow-ups, human handoff to Slack, kill-switch config table, Data Tables,
messaging-hours/rate limits (allowlist makes them moot), and the Emma bot
seat. See the deferred task list and `docs/ARCHITECTURE.md` for the real
pipeline.
