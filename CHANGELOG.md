# Changelog

All notable changes to the Emma AI funding agent.

## [Unreleased]

### Changed
- **SB-06 Outbound Dispatcher: send idempotency moved from n8n Data Tables to
  Postgres (Supabase).** `Claim Idempotency Key` is now a primary-key INSERT,
  so two concurrent dispatches of the same message can never both send; a
  duplicate exits on the node's error output as before. `Count Recent Outbound`
  counts claims made in the last 60 seconds in SQL (attempts, not only accepted
  sends). `Record Send Outcome` updates the claim row and writes the
  `reply_sent` / `link_sent` / `send_failed` `conversation_events` row in the
  same statement, with `latency_ms` measured from the matching
  `inbound_received` event. Query parameters are bound, never interpolated.
- `Log Duplicate Send Attempt` distinguishes a genuine duplicate (unique-key
  violation) from any other database error, which is now logged as
  `idempotency_claim_failed` so a Postgres outage cannot masquerade as dedupe.

### Added
- `db/schema.sql` — the Postgres tables, indexes, and operator views the
  workflows rely on, reconstructed from the live database.

## [1.0.0] — 2026-07-10

Initial build.

### Added
- Twelve importable n8n workflows (SB-00 Discovery/Health Check … SB-11
  Automated Test Harness).
- Emma system prompt, structured-output JSON Schema, fallback messages,
  conversation-summary prompt.
- Configuration templates: field mapping, customer-safe status map,
  qualification rules, disclosure policy, follow-up policy, compliance rules,
  handoff rules, approved FAQ.
- n8n Data Table definitions and example seed data.
- Salesforce discovery + field-map generation scripts.
- Sendblue inspection script.
- Workflow validator with security rules; GitHub Actions CI.
- Mock-driven test harness with fixtures and machine/human-readable reports.
- Full documentation set under `docs/`.

### Security / compliance
- Global kill switch + per-record controls, opt-out precedence, human-takeover
  precedence, verification levels 0–2, test-mode send guard.
- No credentials, phone numbers, or customer data in the repository (CI-enforced).
