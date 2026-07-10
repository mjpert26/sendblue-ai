# Identity Verification & Privacy

How Emma decides who she is talking to and what she may tell them. The core
principle is **default to less disclosure**: matching a phone number is not
identity, uncertainty always resolves toward saying less, and anything the
current verification level does not explicitly allow is refused or escalated.
The policy is data, not code —
[`../config/status-disclosure-policy.example.json`](../config/status-disclosure-policy.example.json)
— and its wording/thresholds require compliance sign-off
([`../COMPLIANCE-REVIEW.md`](../COMPLIANCE-REVIEW.md) §3).

## 1. Verification levels

SB-03 computes a verification level for every inbound turn; SB-05 and the
disclosure policy enforce it deterministically. The model cannot raise the
level, and status facts never come from conversation memory.

### Level 0 — Unverified

No requirements. Applies to unknown numbers, failed confirmations, and any
uncertainty.

| Allowed | Denied (examples) |
|---------|-------------------|
| `general_company_information` | `record_specific_status` |
| `general_application_instructions` | `missing_document_details` |
| `start_new_lead_intake` | `owner_information` |
| `request_human` | `offers`, `terms`, `funding_status` |

### Level 1 — Phone match + confirmation

Requires **all** of:

1. `exactly_one_salesforce_match_on_normalized_phone` (SB-03, §4 below),
2. `confirmed_non_sensitive_factor` — at least 1 of the confirmation factors
   `first_name`, `business_name`, `zip_code` (§2),
3. `no_conflicting_record_information` — nothing the customer said
   contradicts the record.

| Allowed | Notes |
|---------|-------|
| `customer_safe_stage` | Approved wording from the status map only |
| `application_received_yes_no` | Yes/no, no detail |
| `customer_safe_next_step` | Approved `next_step` wording only |
| `human_followup_pending_yes_no` | Yes/no |
| `assigned_rep_first_name` | First name only |

### Level 2 — Secure verification

Requires `level2_provider_success_or_human`.

| Allowed | Never automated (even at Level 2) |
|---------|-----------------------------------|
| `offer_exists_yes_no` | `specific_offer_details`, `specific_rates`, `repayment_terms` |
| `specialist_discussion_scheduling` | `sensitive_document_details`, `underwriting_notes`, `banking_details`, `decline_reasons`, `personally_identifying_documents` |

The `never_automated` list is absolute: those items are human-only
regardless of verification outcome.

## 2. Confirmation-factor flow (Level 1)

1. Customer asks something requiring Level 1 (e.g., "what's my status?").
2. If not yet confirmed this conversation, Emma sends the deterministic
   template `identity_confirmation_request` (asks for a non-sensitive factor,
   typically the business name).
3. SB-03/SB-04 compare the answer against the resolved record
   (`confirmation_factors`: `first_name`, `business_name`, `zip_code`;
   minimum 1 must match).
4. Match → Level 1 granted for the conversation; proceed with the
   customer-safe answer. Mismatch → template `identity_confirmation_failed`
   and escalation to a human — Emma never offers hints, retries with leading
   questions, or reveals what the record says.
5. Confirmation factors are deliberately non-sensitive; nothing on the
   `never_collect_over_text` list
   ([`../config/qualification-rules.example.json`](../config/qualification-rules.example.json))
   may ever be used as a factor.

## 3. Level-2 pluggable provider interface

No approved provider was specified, so **none is configured and none was
invented**: `verification.level2_provider` defaults to `null`, and every
request requiring Level 2 escalates to a human via SB-09 with template
`verification_escalation` (see ASSUMPTIONS.md A-14).

To integrate a provider later, set the policy's `provider` to
`{"type": "webhook", "url": "https://…"}` implementing this contract:

**Request** (n8n → provider):

```json
{
  "correlation_id": "corr_abc123",
  "salesforce_record_ref": "Lead/00Q…",
  "normalized_phone_hash": "sha256:…",
  "requested_level": 2,
  "channel": "sms"
}
```

**Response** (provider → n8n, within timeout):

```json
{
  "verified": true,
  "method": "otp",
  "verified_at": "2026-01-01T00:00:00Z",
  "expires_at": "2026-01-01T00:10:00Z"
}
```

Rules: timeout 10 seconds (configurable); **fail closed** — any timeout,
non-200, malformed body, `verified: false`, or expired `expires_at` is
treated as NOT verified and escalates to a human. The provider request never
includes raw phone numbers, message content, or record data beyond the
reference. The provider choice itself is a compliance sign-off item
([`../COMPLIANCE-REVIEW.md`](../COMPLIANCE-REVIEW.md) §3).

## 4. Record matching and multiple matches

SB-03 matches the normalized E.164 number deterministically, in order:
`Lead.MobilePhone` → `Lead.Phone` → `Contact.MobilePhone` → `Contact.Phone`
→ person account phones → configured custom phone fields. Converted leads
resolve to their Contact.

**Multiple matches are never guessed** (`multiple_match_behavior:
clarify_or_escalate_never_guess`): if more than one record matches and a
clarifying question can't safely distinguish them, Emma sends the
`ambiguous_record` template and SB-09 hands off. Verification level for an
ambiguous match is 0 — no record-specific disclosure of any kind.

## 5. Sensitive data handling and redaction

Deterministic detectors in
[`../config/compliance-rules.example.json`](../config/compliance-rules.example.json)
(SSN, card numbers, routing/account numbers in context, credentials, DOB)
run on every inbound message. On detection:

1. The value is **never repeated** back to the customer.
2. It is **never copied to Salesforce** (not even into the summary).
3. It is **redacted in all logs and DLQ rows**.
4. The customer gets the `sensitive_info_warning` template pointing to the
   secure application link.
5. Repeated occurrences escalate to a human.

Media/documents are never processed: template
`media_redirect_secure_portal`, with escalation if it looks like a financial
document. The full never-collect-over-text list lives in the qualification
rules config.

## 6. Default-to-less-disclosure principle

`default_on_uncertainty: less_disclosure` — whenever level computation,
record matching, stage mapping, or template selection is uncertain, the
system chooses the lower-disclosure path: a generic answer, a confirmation
request, or escalation. An unmapped internal stage value escalates rather
than improvises (`unmapped_internal_value_behavior: escalate` in the status
map). The assigned rep is disclosed by **first name only**, and only at
Level 1+.

## 7. Data minimization to Claude

SB-03/SB-04 build a **sanitized context object** for the model containing
only what the turn needs: assistant/company identity, the customer's recent
transcript window, first name, the resolved record's customer-safe stage (at
or below the current verification level), `missing_fields` in priority
order, and the deterministic flags (`human_takeover`, `ai_enabled`,
verification level). It never includes: raw Salesforce IDs beyond an opaque
ref, other customers' data, internal notes, underwriting information, offer
details, credentials, API details, or anything above the current
verification level. If a fact is not in CONTEXT, the system prompt requires
the model to treat it as unknown — so minimization is also the primary
defense against hallucinated disclosure.

## Related

- [`ARCHITECTURE.md`](ARCHITECTURE.md) §9 — the model's place in the loop
- [`HUMAN-HANDOFF.md`](HUMAN-HANDOFF.md) — where escalations land
- [`OPERATIONS-RUNBOOK.md`](OPERATIONS-RUNBOOK.md) — log sanitization rules
