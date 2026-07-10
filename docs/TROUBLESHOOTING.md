# Troubleshooting

Symptom → cause → fix tables for the failures you are most likely to meet
during setup and operation. For live incidents (outages, floods, suspected
duplicates) use [`OPERATIONS-RUNBOOK.md`](OPERATIONS-RUNBOOK.md) §7 first;
this document is diagnostic. When in doubt, run **SB-00** — most
misconfiguration surfaces there — and trace with the correlation ID.

## 1. Webhook 401s (SB-01/SB-07 rejecting Sendblue)

| Cause | How to confirm | Fix |
|-------|----------------|-----|
| Secret **header name** mismatch — Sendblue sends the secret under a different header than `SENDBLUE_WEBHOOK_SECRET_HEADER` (default `sb-signing-secret`); the exact name is unverified (see ASSUMPTIONS.md A-03) | Inspect a rejected request's headers in the SB-01 execution log | Verify the header name in the current Sendblue dashboard/docs and set `SENDBLUE_WEBHOOK_SECRET_HEADER` to match |
| Secret **value** mismatch (rotated on one side only) | Compare Sendblue webhook config vs n8n env | Set the same value in both; restart n8n |
| Per-URL secret vs `globalSecret` confusion | Check which secret type the subscription uses | Configure the secret on the subscription you actually registered |
| Requests aren't from Sendblue at all (scanners) | Source IPs, junk payloads | Expected — 401 is correct. Consider IP filtering if noisy |

## 2. No reply generated

| Cause | How to confirm | Fix |
|-------|----------------|-----|
| Kill switch: `global_ai_enabled=false` (the shipped default) | `agent_config`; SB-01 outcome `suppressed_global_disable` | Intentional? If not, set `true` per runbook §3 |
| `outbound_enabled=false` | SB-06 guard log | Enable in `agent_config` |
| Record flags: opt-out / wrong number / `human_takeover` / `ai_enabled=false` | Salesforce record; SB-06 skip reason | Working as designed — resume via [`HUMAN-HANDOFF.md`](HUMAN-HANDOFF.md) if appropriate |
| TEST_MODE and sender not on allowlist | SB-06 skip `test_mode_not_allowlisted` | Add the team number to `test_allowlist_numbers`, or this is doing its job |
| Message deduped (webhook retry) | `processed_messages` outcome `duplicate` | Correct behavior |
| Debounce still open (rapid messages) | SB-04 execution timing | Wait ~20 s; one combined reply arrives |
| Stale contact lock (crashed run) | `contact_locks` row past `expires_at` | Delete the row; investigate the crashed execution in SB-10/DLQ |
| Claude failure and fallback also failed | SB-04 execution error; DLQ row | See runbook §7.5; fix root cause, replay if applicable |
| Workflow inactive / not imported | n8n workflow list | Activate in the order in [`N8N-SETUP.md`](N8N-SETUP.md) §5 |

## 3. Duplicate replies

| Cause | How to confirm | Fix |
|-------|----------------|-----|
| Inbound dedupe not working — `message_handle` not unique in `processed_messages` | Two rows with same handle | Recreate the unique constraint per `definitions.json`; re-map the node (A-12) |
| Two correlations for one turn (debounce misconfigured/bypassed) | Two `outbound_idempotency` rows, different keys, same content | Check debounce config and that SB-01 is the only inbound entry point |
| Another workflow sending directly (rule violation) | `npm run validate` fails; execution history | Route all sends through SB-06 — only it may call `/send-message` |
| Replay of an accepted send (should be impossible) | DLQ row `accepted_by_sendblue=true` yet resent | Bug — stop replays, capture evidence, fix SB-10 guard |
| Carrier-side duplication | Single idempotency row + single accepted handle, customer saw two | Raise with Sendblue with the `message_handle` |

## 4. Follow-ups not sending

| Cause | How to confirm | Fix |
|-------|----------------|-----|
| `followups_enabled=false` (shipped default) | `agent_config` | Enable when intended |
| A recheck-before-send condition fired — SB-08 records the skip reason (hours, replied-since, stage ineligible, consent, takeover, attempts max…) | SB-08 skip log / job `resolution` | Usually correct behavior; read the reason before "fixing" |
| `followup_date`/`followup_attempt` unmapped AND `followup_jobs` fallback rows absent | Field map; `followup_jobs` table | Map the fields ([`SALESFORCE-SETUP.md`](SALESFORCE-SETUP.md) §4) or verify job creation in SB-04 |
| Schedule trigger not firing | SB-08 execution history empty | Activate SB-08; check instance scheduler/timezone |
| Customer replied → cancelled | Job `resolution=cancelled_on_reply` | Working as designed |

## 5. Health check (SB-00) RED items

| RED item | Fix |
|----------|-----|
| Required field mapping `UNMAPPED` | Resolve in local field map ([`SALESFORCE-SETUP.md`](SALESFORCE-SETUP.md) §4); required set: `ai_enabled`, `human_takeover`, `sms_consent`, `sms_opt_out`, identity/company/phone/lead_source/owner |
| Credential missing/invalid | Recreate/re-auth the credential ([`N8N-SETUP.md`](N8N-SETUP.md) §2); for Salesforce see runbook §7.4 |
| Data Table or column missing | Create exactly per `data-tables/definitions.json`, including unique constraints |
| Required `agent_config` key absent | Seed from `data-tables/seed-data.example.json` |
| API unreachable (Sendblue/Salesforce/Anthropic/Slack) | Network/proxy/base-URL check; `npm run inspect:sendblue` / `inspect:salesforce` |
| Webhook not registered / URL mismatch | Re-register per [`SENDBLUE-SETUP.md`](SENDBLUE-SETUP.md) §4 |

## 6. Data Table node errors after import (A-12)

| Symptom | Cause | Fix |
|---------|-------|-----|
| Node shows "table not found" / empty parameters | Table IDs are instance-specific; parameter schemas vary by n8n version (see ASSUMPTIONS.md A-12) | Open each Data Table node and re-select table/operation/columns from your instance's dropdowns ([`N8N-SETUP.md`](N8N-SETUP.md) §4) |
| "Unknown column" at execution | Table created with different column names/types than `definitions.json` | Recreate the column exactly (name and type) |
| Unique-violation errors on insert | Normal for dedupe/idempotency inserts — workflows treat it as "already processed" | Only investigate if it surfaces as a *failed* execution rather than a handled branch |
| Node type unavailable | n8n version predates Data Tables | Upgrade n8n ([`N8N-SETUP.md`](N8N-SETUP.md) §1) |

## 7. High Claude invalid-JSON rates

| Cause | How to confirm | Fix |
|-------|----------------|-----|
| Occasional invalid output (expected) | Repair attempt succeeds; no fallback | None — the one-repair design absorbs this (A-13) |
| Model changed (`ANTHROPIC_MODEL` updated) | Spike correlates with config change | Re-run SB-11 + fixtures against the new model; adjust prompt if needed |
| Schema drift — `prompts/structured-output-schema.json` edited without prompt update | Diff schema vs system prompt output section | Keep schema + prompt + fixtures in sync; add a fixture for the new field |
| `ANTHROPIC_MAX_TOKENS` too low → truncated JSON | Responses cut mid-object | Raise the limit |
| Prompt-injection outputs being (correctly) discarded | `detected_intent=prompt_injection` markers | Working as designed; review the source messages |

Customers never see raw failures — invalid-after-repair falls back to
deterministic templates. A sustained spike is a quality problem, not an
outage.

## 8. Status lookup escalating everything

| Cause | How to confirm | Fix |
|-------|----------------|-----|
| **Unmapped stage values** — the status map still contains `PLACEHOLDER_*` `internal_values` that match no real picklist, and unmapped values escalate by design | Local `customer-safe-status-map` vs generated picklists | Populate `internal_values` from discovery output (see ASSUMPTIONS.md A-15); wording changes need compliance review |
| Admins added/renamed picklist values since mapping | Re-run `npm run inspect:salesforce`, diff | Add the new values to the map |
| Level 2 required but no provider configured | Escalations only on Level-2 stages | Expected until a provider is integrated (see ASSUMPTIONS.md A-14, [`IDENTITY-AND-PRIVACY.md`](IDENTITY-AND-PRIVACY.md) §3) |
| Identity confirmation failing (record data empty/wrong) | `identity_confirmation_failed` template frequency | Check the mapped confirmation-factor fields hold real values |
| `status_lookup_enabled=false` | `agent_config` | Enable if intended |

## 9. Messages blocked in TEST_MODE

| Cause | How to confirm | Fix |
|-------|----------------|-----|
| Recipient not on `test_allowlist_numbers` | SB-06 skip reason | Add the team-owned number (E.164, comma-separated). Never add customer numbers |
| Allowlist still holds the fictional seed placeholders | `agent_config` value `+15550100001,…` | Replace with real team numbers |
| Expecting real sends while `TEST_MODE=true` | `.env` + `agent_config.test_mode` | Real sends require `TEST_MODE=false` **and** `ALLOW_REAL_SEND=true` — and belong after the launch checklist ([`DEPLOYMENT.md`](DEPLOYMENT.md) Phase 8) |
| Env and config-table disagree (`TEST_MODE` vs `test_mode` key) | Compare both | Keep them in sync; the safer value wins by design |

## 10. Seat attribution missing on sends

| Cause | How to confirm | Fix |
|-------|----------------|-----|
| `SENDBLUE_EMMA_SEAT_ID` unset (sends succeed without it by design) | n8n env | Create the seat and set the ID ([`SENDBLUE-SETUP.md`](SENDBLUE-SETUP.md) §3) |
| Wrong request parameter name — the exact `/send-message` seat param is unverified | Sendblue dashboard shows no attribution despite ID set | Confirm the param name in current docs; adjust `sendblue.seat_param` (default `seat_id`) — see ASSUMPTIONS.md A-05 |
| Inbound threads not under the Emma seat | Dashboard inbox view | Inbound seat assignment is a **manual dashboard step**, not API (see ASSUMPTIONS.md A-06) — re-assign the line/inbox |
