# CLAUDE.md — working in this repository

This repo contains **Emma**, Big Think Capital's AI business-funding assistant:
importable n8n workflow JSON, prompts, config templates, validation tooling,
test fixtures, and docs. There is no application server; n8n executes the
workflows.

## Hard rules (do not relax without human sign-off)

1. **Never commit secrets, phone numbers, customer data, or Salesforce data.**
   `scripts/validate-workflows.mjs` enforces this and runs in CI.
2. **Only SB-06 (Outbound Dispatcher) may call the Sendblue send endpoint.**
   Every other workflow must route sends through it.
3. **Real sends require `TEST_MODE=false` AND `ALLOW_REAL_SEND=true`.**
   In test mode, sends are mocked or restricted to the test allowlist.
4. **Writes to a live n8n instance require `N8N_API_URL`, `N8N_API_KEY`, and
   `ALLOW_N8N_WRITE=true`** (enforced by `scripts/deploy-n8n.mjs`). Otherwise
   generate local JSON only.
5. **Claude never sends messages or writes Salesforce directly.** The model
   returns structured JSON; n8n decides which actions are permitted.
6. Do not invent Sendblue/Salesforce/n8n/Anthropic API behavior. If a
   capability is unverified, add it to `ASSUMPTIONS.md` with a configurable,
   fail-safe placeholder.

## Commands

- `npm run validate` — validate workflow JSON + config + security rules
- `npm test` — run the fixture-driven test harness (all mocked)
- `npm run inspect:salesforce && npm run generate:sf-map` — field discovery
- `npm run deploy:n8n` — gated deploy (see rule 4)

## Key layout

- `workflows/SB-XX-*.json` — importable n8n workflows (SB-00…SB-11)
- `prompts/` — Emma system prompt + structured output schema + fallbacks
- `config/*.example.json` — all business rules; copy to non-`.example` names
  locally (generated/real configs are gitignored where org-specific)
- `data-tables/definitions.json` — required n8n Data Tables
- `docs/` — architecture, setup, runbook, rollback, compliance

## Naming

The assistant name is configurable (`ASSISTANT_NAME`, default `Emma`). Never
hardcode "Emma" into customer-facing strings — use the config value.
