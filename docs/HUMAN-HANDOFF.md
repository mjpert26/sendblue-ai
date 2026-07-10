# Human Handoff & Resume

When and how Emma hands a conversation to a person (SB-09), what the team
sees in Slack and Salesforce, and how AI is safely resumed afterwards. Rules
are configuration, not code:
[`../config/handoff-rules.example.json`](../config/handoff-rules.example.json).
Handoff/resume authorization is a compliance sign-off item
([`../COMPLIANCE-REVIEW.md`](../COMPLIANCE-REVIEW.md) §6).

## 1. Triggers

SB-04 requests a handoff (or SB-09 is invoked directly) when any of these
fire:

| Trigger | Source |
|---------|--------|
| Customer explicitly asks for a person or a call | Model intent + deterministic keywords |
| Qualification complete (threshold met → notify owner) | Qualification rules |
| Complaint | Model intent — Task priority High |
| Fraud or identity-theft report | Model intent — Task priority High |
| Legal or compliance topic | Model intent |
| Underwriting, pricing, offer-detail, or decline-reason question | Hard prohibition for the model |
| Ambiguous record match (never guess) | SB-03 deterministic |
| Model confidence below 0.55 | Structured output field |
| Repeated sensitive data in messages | Compliance detectors |
| Stage requires human (`human_escalation_required` in status map, Level-2 without provider — A-14) | SB-05 deterministic |

Urgency is inferred from deterministic keywords: high = "today", "asap",
"urgent", "immediately", "right now", "emergency"; medium = "this week",
"soon", "quickly".

## 2. Handoff sequence (exact order)

SB-09 executes, in order:

1. **Set `human_takeover = true`** on the Salesforce record — from this
   moment every workflow suppresses AI replies for the contact (precedence:
   [`ARCHITECTURE.md`](ARCHITECTURE.md) §5).
2. **Cancel pending follow-ups** (Salesforce follow-up fields and/or
   `followup_jobs` rows → cancelled with reason `handoff`).
3. **Stop the typing indicator** (fail-soft).
4. **Create a Salesforce Task** (§4) assigned to the record owner.
5. **Post the Slack summary** to `SLACK_HANDOFF_CHANNEL_ID` (§3).
6. **Optionally send one transfer message** to the customer — template
   `handoff_transfer`, dispatched through SB-06 like any send (all guards
   apply). This is the only message sent as part of a handoff.

If any step fails, SB-10 captures it; the takeover flag is set **first** so
a partial failure still silences the AI.

## 3. Slack message format

Posted to `SLACK_HANDOFF_CHANNEL_ID`. Example (all values illustrative;
phone shown masked — raw numbers are never posted to Slack):

```
:rotating_light: Emma handoff — Underwriting/pricing question   Urgency: HIGH

Customer:   Jordan (Acme Plumbing LLC) · +1 555-010-••••
Record:     https://yourInstance.my.salesforce.com/00Q0000000XXXXX
Reason:     Customer asked about rates — outside AI scope
Requested:  "can you tell me what rate I'd get?"

Qualification summary:
• Business: Acme Plumbing LLC (plumbing, NY)
• Time in business: 4 years · Monthly revenue: ~$80k
• Seeking: $150k, equipment purchase, needed "this month"
• Application: link sent, not yet started

Correlation: corr_9f3a…   |   Handled by: SB-09
```

Contents come from `slack_summary_includes`: `qualification_summary`,
`salesforce_record_link`, `customer_request`, `urgency`, `correlation_id`.
Message bodies beyond the immediate customer request are not included —
full transcripts stay in Sendblue.

## 4. Salesforce Task fields

| Field | Value |
|-------|-------|
| Subject | `[{assistant_name} AI] Handoff: {handoff_reason}` |
| Priority | `complaint` → High; `fraud_or_identity_theft_report` → High; otherwise Normal |
| WhoId / WhatId | The resolved Lead/Contact |
| OwnerId | The record owner (`record_owner` mapping) |
| Description | Qualification summary + customer request + correlation ID |
| Status | Open/Not Started |

## 5. Resume procedure

Resume is deliberately manual and authorized-only. Two paths
(`resume.authorized_via`):

### Path A — n8n manual workflow

1. An authorized operator opens SB-09's resume entry point in n8n and runs
   it for the record (record ref + operator identity required).
2. SB-09 **rechecks before resuming**: `sms_opt_out`, `sms_consent`,
   `wrong_number`, `global_ai_enabled`. Any failing check aborts the resume.
3. SB-09 clears `human_takeover` and records **who resumed and when** (§6).

### Path B — Salesforce field cleared by a user

1. A Salesforce user with edit rights unchecks the `human_takeover` field on
   the record (typically the owner closing out their Task).
2. On the next inbound message, SB-03 sees `human_takeover = false` and the
   same rechecks apply before Emma replies.

In both paths, resuming never triggers an unprompted "I'm back" message —
Emma simply handles the next inbound turn.

## 6. Audit fields

Every handoff/resume records: `handoff_reason` (mapped Salesforce field),
the SB-09 Task (permanent CRM audit artifact), the Slack post (channel
history), the correlation ID linking to `processed_messages` /
`outbound_idempotency`, and on resume, who resumed and when
(`record_resumed_by_and_when: true` — written to the record/Task per your
field mapping). If your org wants richer auditing, add fields for
`resumed_by` / `resumed_at` (suggestions in
[`SALESFORCE-SETUP.md`](SALESFORCE-SETUP.md) §5).

## 7. Pausing/resuming AI per record (without a handoff)

To silence Emma on one record without the full handoff ceremony, set the
mapped `ai_enabled` field to false — no Task, no Slack post, no transfer
message; Emma simply stops. Re-enable by setting it back to true. Use
`human_takeover` when a person is actively taking the thread; use
`ai_enabled` for "just stop the AI here."

## 8. Global kill switch

To stop Emma **everywhere immediately**: set the `agent_config` Data Table
key `global_ai_enabled` to `false`. Every workflow checks it, and it
outranks every other control. Full procedure, ownership, and verification
steps: [`OPERATIONS-RUNBOOK.md`](OPERATIONS-RUNBOOK.md) §3 and
[`ROLLBACK.md`](ROLLBACK.md).
