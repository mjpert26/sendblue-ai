# Testing

How Emma is tested: the local fixture harness (`npm test`), the in-n8n
harness (SB-11), the scenario catalogue, adding fixtures, CI, and the UAT
script. The philosophy in one line: **no test ever sends a real message.**
All Sendblue/Salesforce/Claude/Slack interactions in tests are mocks or fake
numbers; UAT uses TEST_MODE with a team-owned allowlist.

## 1. Test philosophy

1. **No real sends, ever.** The harnesses use mocks and fictional
   `+1555-01XX`-range numbers; SB-11 refuses to run against real numbers.
   Even during UAT, `TEST_MODE=true` restricts sends to
   `agent_config.test_allowlist_numbers`.
2. **Deterministic paths get deterministic tests.** Opt-out regex, guards,
   idempotency, verification levels, and templates are asserted exactly.
3. **Model behavior is tested via contract, not vibes.** Fixtures assert the
   *handling* of model output (valid JSON accepted, invalid repaired once
   then falls back, forbidden content blocked) using canned mock responses —
   not live model calls.
4. **Safety rails are tested as first-class features.** A guard without a
   test is assumed broken.

## 2. Running locally

```bash
npm run validate   # workflow JSON + config + security rules (no secrets/numbers)
npm test           # fixture-driven harness (scripts/test-fixtures.mjs), all mocked
npm run test:report  # regenerate tests/TEST-REPORT.md + JSON report
```

`npm test` requires no credentials and touches no external service — it must
pass on a fresh clone.

## 3. Fixture structure

```
tests/
  fixtures/          # one JSON per scenario: input event + config overrides
  mocks/             # canned Sendblue/Salesforce/Claude/Slack responses
  expected-results/  # expected outcome per fixture (assertions)
```

A fixture describes: the inbound event (or trigger), the mock world
(Salesforce records, config table values, prior idempotency rows), and the
expected outcome (which sends/updates/escalations happen — or, as often,
that **nothing** happens and why). Expected results assert on outcome codes,
dispatched-template IDs, Salesforce write sets, and idempotency/lock table
effects — never on free-text model wording.

## 4. Scenario catalogue (~48)

| Category | Scenarios | Count |
|----------|-----------|-------|
| Webhook & routing (SB-01) | valid secret accepted; wrong/missing secret rejected (A-03); fast-200 ordering; E.164 normalization variants; duplicate `message_handle` dropped; correlation ID minted and propagated | 6 |
| Opt-out & wrong number | each exact phrase opts out; standalone-sentence pattern match; false-positive guards ("please don't cancel my application" does NOT opt out); single confirmation only; Salesforce-first then Sendblue opt-out (A-08); wrong-number apology once then suppression | 6 |
| Kill switches & gates | `global_ai_enabled=false` suppresses everything; `outbound_enabled=false` blocks at SB-06; per-record `ai_enabled=false`; `human_takeover=true`; precedence order verified | 5 |
| Record resolution & verification (SB-03) | match order Lead.Mobile→Lead.Phone→Contact.Mobile→Contact.Phone→person account→custom; converted lead resolves to Contact; multiple match → never guess → escalate; no match → Level 0 intake | 4 |
| Identity & disclosure (SB-05) | Level 0 denied record status; Level 1 confirmation success/failure; Level 2 unconfigured → escalate (A-14); unmapped stage value → escalate; assigned rep first-name-only | 5 |
| Qualification (SB-04) | one question at a time; volunteered fields extracted; never re-ask answered fields; threshold met → application link + owner notify; link max 2 per 7 days; `fill_empty_only` never overwrites human values | 6 |
| Claude contract | valid JSON accepted; invalid JSON repaired once; still-invalid → fallback template; forbidden content ("guaranteed approval") blocked by outbound validation; prompt-injection output discarded; sensitive data detected → warn/redact/no-CRM-copy | 6 |
| Outbound guards (SB-06) | idempotency key blocks resend; blank blocked; messaging hours block proactive but exempt replies (A-17); rate limits (global + per-contact); customer-replied-since-scheduled skip; TEST_MODE allowlist enforced; seat attached only when configured (A-05) | 7 |
| Follow-ups (SB-08) | schedule after inbound; cancel on reply; max attempts respected; every recheck-before-send condition can skip with recorded reason; ineligible stage never followed up | 3 |
| Handoff & resume (SB-09) | full sequence order (takeover first); Task + Slack contents; resume rechecks abort on opt-out | 3 |
| Errors & DLQ (SB-10) | retryable vs non-retryable classification; sanitized DLQ row (no PII); replay preserves idempotency; accepted sends never replayed | 3 |

Total ≈ 48. The authoritative list is `tests/fixtures/` + SB-11's scenario
set; keep this table in sync when adding fixtures.

## 5. SB-11 in-n8n harness

SB-11 runs the same scenario logic **inside** the deployed n8n instance,
against mocked endpoints and fake numbers only — proving the *imported*
workflows (credentials wired, Data Table nodes re-mapped per A-12) behave
like the repo says they should.

1. Ensure TEST_MODE is on and SB-00 is GREEN.
2. Run SB-11 manually; it executes the scenario set and writes one row per
   case to the `test_results` Data Table plus a summary report.
3. Any `passed=false` row blocks proceeding; use its `detail` and the
   correlation ID to trace ([`OPERATIONS-RUNBOOK.md`](OPERATIONS-RUNBOOK.md) §6).
4. Re-run after every workflow re-import, n8n upgrade, or config change.

## 6. Adding new fixtures

1. Copy the closest fixture in `tests/fixtures/`; give it a descriptive
   kebab-case name and a unique `case_id`.
2. Define the mock world in `tests/mocks/` (reuse shared mocks where
   possible) and the assertion file in `tests/expected-results/`.
3. Use only fictional data: `+1555010XXXX` numbers, invented names, no real
   record IDs. `npm run validate` rejects real-looking data.
4. Run `npm test`; then mirror the scenario into SB-11's set if it exercises
   in-n8n behavior, and update the table in §4.
5. Every bug fix ships with a fixture reproducing the bug.

## 7. CI behavior

`.github/workflows/validate.yml` runs `npm run validate` and `npm test` on
every PR. CI has **no credentials** — by design it cannot reach Sendblue,
Salesforce, Anthropic, or Slack, so a test that needs network access is a
broken test. A failing check blocks merge. The validator also enforces the
security rules from [`../CLAUDE.md`](../CLAUDE.md): no secrets, no real
phone numbers, only SB-06 calls the send endpoint.

## 8. UAT script (TEST_MODE, allowlisted phones)

Performed from team phones listed in `test_allowlist_numbers`
([`DEPLOYMENT.md`](DEPLOYMENT.md) Phase 7). For each item, verify both the
customer-visible behavior and the artifacts (tables, Salesforce, Slack):

1. New number → intake: greeting, one question at a time, Lead created with
   `lead_source` and company placeholder (A-11).
2. Answer through the threshold → application link arrives, owner notified.
3. Ask an approved FAQ → approved wording verbatim.
4. Ask status unverified → generic only; confirm business name → Level 1
   customer-safe stage; ask a Level-2 item → escalation (A-14).
5. Text "STOP" → single confirmation, Salesforce + Sendblue opt-out, all
   further sends blocked. Then verify a non-opt-out phrase ("don't stop my
   application") does NOT opt out (separate tester).
6. "wrong number" → one apology, suppression.
7. Ask for a human → transfer message, Slack summary, Salesforce Task; reply
   again → Emma stays silent; authorized resume → Emma answers next turn.
8. Go silent → follow-up scheduled; reply before due → cancelled.
9. Send rapid consecutive messages → one combined (debounced) reply.
10. Text an SSN-shaped string → warning template, value absent from
    Salesforce and logs.
11. Attempt a message from a non-allowlisted phone → no real send occurs.

## 9. Acceptance criteria — Definition of done

| Criterion | Evidence |
|-----------|----------|
| `npm run validate` + `npm test` green | CI run |
| All ~48 fixtures pass locally **and** via SB-11 in the target instance | `tests/TEST-REPORT.md`, `test_results` table |
| SB-00 GREEN | Health report |
| UAT script §8 fully passed, transcripts reviewed | UAT sign-off |
| No real number was messaged during any test phase | `outbound_idempotency` audit |
| Compliance sign-off complete | [`../COMPLIANCE-REVIEW.md`](../COMPLIANCE-REVIEW.md) |

Only after all rows are satisfied may the launch flip
([`DEPLOYMENT.md`](DEPLOYMENT.md) Phase 8) occur.
