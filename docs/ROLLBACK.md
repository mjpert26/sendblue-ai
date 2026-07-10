# Rollback

How to take Emma partially or fully out of service, revert to a previous
version, and verify the system is quiet. Order of preference: **kill switch
first** (instant, reversible, no state loss), then scoped disables, then
workflow deactivation, then version reverts. Practice this procedure before
launch — the on-call engineer should be able to execute §1 from memory.

## 1. Instant kill switch (first move, always safe)

1. n8n → **Data Tables → agent_config** → set `global_ai_enabled` = `false`
   (record `updated_by`/`updated_at`).
2. Effect is immediate and global: every workflow checks this key, and it
   outranks all other controls ([`ARCHITECTURE.md`](ARCHITECTURE.md) §5).
   Inbound webhooks still return 200 and are deduped/recorded, but nothing
   is processed further and nothing is sent.
3. Verify per [`OPERATIONS-RUNBOOK.md`](OPERATIONS-RUNBOOK.md) §3 (test
   message from an allowlisted phone → suppressed outcome).
4. Announce (§8). This state can be held indefinitely — there is no pressure
   to complete further rollback steps until the situation is understood.

## 2. Deactivating workflows in safe order

If you need workflows actually off (e.g., before re-import), deactivate
**inbound first, outbound last** — the reverse of activation. Rationale: an
inbound router with no downstream processors silently drops customer turns,
but downstream workflows with no inbound feed are harmless; keeping SB-06
and SB-07 alive longest lets already-in-flight replies finish and their
delivery callbacks land, instead of stranding half-processed conversations.

1. **SB-02** Lead Intake (should already be inactive in most orgs).
2. **SB-01** Inbound Router — new inbound stops here. (Sendblue will get
   404/no-webhook responses for its deliveries from this point; see §3.)
3. **SB-08** Follow-Up Orchestrator — no more scheduled sends.
4. **SB-04**, **SB-05**, **SB-09**, **SB-03** — orchestration layer.
5. **SB-06** Outbound Dispatcher — last of the senders' path, after in-flight
   executions drain (check the running-executions view).
6. **SB-07** Delivery Status — last overall, so final delivery callbacks are
   still recorded.
7. Leave **SB-10** active if any workflow remains active; deactivate it only
   when everything else is off. SB-00/SB-11 are manual — nothing to do.

## 3. Webhook deregistration

Only needed for extended shutdown or when pointing Sendblue elsewhere —
for short rollbacks, leaving webhooks registered is fine (SB-01/SB-07
inactive simply means Sendblue's deliveries fail; kill-switch mode even
keeps answering 200).

1. In Sendblue, remove (or repoint) the `receive` subscription for
   `…/webhook/sendblue/inbound` and the `outbound`/status subscription for
   `…/webhook/sendblue/status`.
2. Note that per-message `status_callback` URLs on already-sent messages
   will still be called; if n8n itself is being torn down, expect and ignore
   those failures.
3. Record what you removed — re-registration steps are in
   [`SENDBLUE-SETUP.md`](SENDBLUE-SETUP.md) §4, including the secret header
   caveat (A-03).

## 4. Reverting to previous workflow versions

Two complementary mechanisms:

1. **n8n workflow history/versioning** (where your n8n version supports
   it): open the workflow → history → restore the last-known-good version.
   Fastest for a single bad edit.
2. **Git (authoritative):** the repo's `workflows/*.json` are the source of
   truth. Check out the last-known-good commit/tag and re-import — manually
   or via `npm run deploy:n8n` (requires `N8N_API_URL`, `N8N_API_KEY`,
   `ALLOW_N8N_WRITE=true`).

After any re-import: re-attach credentials, **re-map Data Table nodes**
(see ASSUMPTIONS.md A-12), re-set SB-10 as error workflow, and run SB-00 to
GREEN before reactivating ([`N8N-SETUP.md`](N8N-SETUP.md) §4–6). Tag the
deployed commit at every launch so "last-known-good" is unambiguous.

## 5. Data Table state during rollback

Data Tables are technical state — generally **keep them intact**:

- `processed_messages` and `outbound_idempotency` **must survive** rollback;
  wiping them destroys dedupe/send history and risks duplicate sends when
  service resumes. Never truncate these as part of a rollback.
- `agent_config` — keep; it holds your kill-switch state. If restoring an
  older workflow version that expects different keys, reconcile keys against
  `data-tables/definitions.json` `required_keys`.
- `contact_locks` — safe to clear rows past `expires_at` (crashed
  executions); do not clear active ones while executions may be running.
- `followup_jobs` — on rollback, mark pending jobs as cancelled/on-hold
  rather than deleting: SB-08's recheck-before-send will re-verify
  everything anyway, but stale jobs firing on reactivation should be a
  decision, not an accident.
- `dead_letter_events`, `retry_state`, `test_results` — keep for forensics.

Salesforce state (takeover flags, opt-outs, consent) is **never** rolled
back mechanically — opt-outs in particular must survive any rollback.

## 6. Partial rollback

| Goal | Action | Leaves working |
|------|--------|----------------|
| Stop proactive follow-ups only | `agent_config.followups_enabled=false` (or deactivate SB-08) | All inbound conversation behavior |
| Stop outreach (Journey F) only | Deactivate SB-02 / set `outreach.enabled=false` (default state) | Everything else |
| Stop all sends, keep processing | `agent_config.outbound_enabled=false` | Inbound intake, CRM updates, handoffs still logged |
| Stop AI for one customer | Record-level `ai_enabled=false` or `human_takeover=true` ([`HUMAN-HANDOFF.md`](HUMAN-HANDOFF.md) §7) | Everyone else |
| Back to pre-launch safety | `TEST_MODE=true` (and `ALLOW_REAL_SEND=false`) | Full behavior, but only allowlisted numbers can receive |
| Stop status disclosure only | `agent_config.status_lookup_enabled=false` | Qualification, FAQ, handoff |

## 7. Post-rollback verification

1. Kill-switch/scoped-disable verification: allowlisted test message →
   suppressed outcome; **zero** new `outbound_idempotency` rows since the
   rollback timestamp (except any explicitly allowed scope).
2. SB-08's next scheduled run (if still active) records only skips.
3. No fresh DLQ rows caused by the rollback itself (half-deactivated call
   chains); if present, finish deactivating in §2 order.
4. If rolled back to an older version: SB-00 GREEN, SB-11 pass, before
   reactivation.
5. Confirm Sendblue dashboard shows no outbound from the Emma line since
   rollback.
6. Log the incident timeline while fresh (correlation IDs, who flipped
   what, when).

## 8. Team communication template

Post to the ops/alerts channel at rollback start and resolution:

```
EMMA ROLLBACK — [STARTED | UPDATED | RESOLVED]
When:        2026-__-__ __:__ ET
By:          <name>
Scope:       [global kill switch | outbound only | follow-ups only |
              workflow revert to <tag/commit> | full shutdown]
Reason:      <one line — what was observed>
Customer impact: [none | replies stopped at __:__ | describe]
Current state:  global_ai_enabled=false; workflows active: <list>
Handling inbound: <who covers customer texts meanwhile — see
                  #handoff channel>
Next step / ETA: <what happens next, who owns it>
Correlation IDs: <if incident-linked>
Do not re-enable anything without <kill-switch owner> sign-off.
```

Re-enabling afterwards follows [`DEPLOYMENT.md`](DEPLOYMENT.md) Phases 5–8
(health check → verification → gated flips) — never a bare "flip it back."
