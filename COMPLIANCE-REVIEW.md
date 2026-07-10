# COMPLIANCE-REVIEW.md — required sign-offs before production activation

Nothing in this repository may message a real customer until every item below
is reviewed and signed off by Big Think Capital compliance. Each item lists the
artifact to review and the risk it controls.

Status legend: ☐ open · ☑ approved (add reviewer + date when approving).

## 1. Messaging consent & TCPA
- ☐ Journey F outreach (SB-02) stays **disabled** until consent capture
  (source + timestamp fields), quiet hours, and message content are approved.
  Artifacts: `config/follow-up-policy.example.json`, `workflows/SB-02-*.json`,
  ASSUMPTIONS A-17/A-18.
- ☐ Opt-out phrase list and single non-promotional confirmation message.
  Artifacts: `config/compliance-rules.example.json`,
  `prompts/fallback-messages.json` (`opt_out_confirmation`).
- ☐ Messaging window (09:00–20:00 default) vs. applicable state rules.

## 2. Customer-facing content
- ☐ Every FAQ answer (`config/approved-faq.example.json`) — all are marked
  `placeholder_requires_compliance_approval: true`.
- ☐ Every customer-safe stage wording and next step
  (`config/customer-safe-status-map.example.json`).
- ☐ All fallback/template messages (`prompts/fallback-messages.json`).
- ☐ Emma's disclosure line ("virtual assistant") and company description —
  Emma must never imply Big Think Capital is a bank, direct lender, SBA office,
  or government entity. Artifact: `prompts/emma-system-prompt.md`.

## 3. Disclosure & privacy
- ☐ Verification levels and what each level may disclose
  (`config/status-disclosure-policy.example.json`,
  `docs/IDENTITY-AND-PRIVACY.md`).
- ☐ Level-2 provider selection (currently unconfigured → auto-escalates;
  ASSUMPTIONS A-14).
- ☐ Sensitive-data handling: redaction list, "do not text sensitive info"
  response, secure-portal redirect (`config/compliance-rules.example.json`).

## 4. Credit / lending boundaries
- ☐ Confirm the agent makes no underwriting, approval, denial, pricing, or
  adverse-action statements. The system prompt forbids it and SB-05 only
  relays mapped Salesforce values — review both.
- ☐ Confirm "business financing" generic terminology is acceptable.

## 5. Data handling
- ☐ Sendblue retains transcripts; Salesforce stores qualification data; n8n
  Data Tables store technical state only. Review `docs/ARCHITECTURE.md`
  data-residency section.
- ☐ Log sanitization rules (`docs/OPERATIONS-RUNBOOK.md`).

## 6. Operational controls
- ☐ Global kill-switch ownership and procedure (`docs/OPERATIONS-RUNBOOK.md`).
- ☐ Human takeover / resume authorization list (`docs/HUMAN-HANDOFF.md`).

Sign-off table:

| Item | Reviewer | Date | Notes |
|------|----------|------|-------|
|      |          |      |       |
