# Changelog

All notable changes to the Emma AI funding agent.

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
