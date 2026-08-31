# ESign Prefill Integration — application.bigthinkcapital.com

Emma sends qualified merchants a personalized application link. The link carries
a random bearer token that resolves to the merchant's Salesforce Lead, so the
e-sign application opens **pre-filled** with everything collected in the chat.

## Link format Emma sends

```
https://application.bigthinkcapital.com/apply?t=<token>
```

- `token`: 48 lowercase hex chars, generated fresh each time Emma sends a link
- Stored on the Lead (`Emma_ESign_Token__c`, unique external id) with a 30-day
  expiry (`Emma_ESign_Token_Expiry__c`). Re-sending a link rotates the token.

## Implementation status

Built and verified end to end (2026-08-21). The funnel calls a server-side proxy,
`api/public/esign-prefill.js` in `bigthinkcapital/Esign-new`, which resolves the
token against this endpoint via `EMMA_ESIGN_PREFILL_URL` and re-serves a
whitelisted copy of the payload. `src/App.jsx` handles the `/apply?t=` route.
The proxy adds per-IP rate limiting (30/min → `429 rate_limited`) and maps any
non-2xx that is not 400/404/410 to `502 prefill_unavailable`.

## What the esign app implements

On page load of `/apply`, read `t` from the query string and call the prefill
API **server-side** (do not call from the browser — keep the n8n host out of
client code):

```
GET https://api.bigthinkcapital.com/webhook/emma/esign-prefill?t=<token>
```

### Responses

| HTTP | Body | Meaning |
|---|---|---|
| 200 | prefill JSON (below) | token valid — populate the form |
| 400 | `{"error":"invalid_token"}` | malformed token — render blank form |
| 404 | `{"error":"token_not_found"}` | unknown/rotated token — render blank form |
| 410 | `{"error":"token_expired"}` | >30 days old — render blank form (optionally show "ask Emma for a fresh link") |
| 503 | `{"error":"prefill_unavailable"}` | lookup failed (Salesforce unreachable) — the token may be perfectly valid, so prefer "try again in a moment" over a blank form |

### 200 payload

```json
{
  "first_name": "Mike",
  "last_name": "Perticone",
  "business_name": "Bweiss Enterprises",
  "email": "mike@example.com",
  "phone": "+16317591737",
  "business_state": "NY",
  "industry": "Technology",
  "time_in_business": "4 years",
  "monthly_gross_revenue": 25000,
  "requested_amount": 150000,
  "use_of_funds": "equipment financing"
}
```

Any field may be `null` (not yet collected in chat) — leave those inputs empty.

Placeholder values are scrubbed to `null` before they leave this endpoint.
Salesforce requires `LastName`, so intake writes `Unknown`, and `Industry` picks
up an org-level default of `Other - Other`; prefilling either would force the
merchant to notice and delete junk, which is worse than an empty field. The
scrubbed set is configurable via `SF_PLACEHOLDER_VALUES`.

## Security properties

- The token is the only credential; it is unguessable (192 bits), single-lead,
  rotated on every send, and expires after 30 days.
- The endpoint returns **only** the application fields above — never record
  ownership, underwriting data, or internal identifiers.
- Failed lookups are logged with correlation ids in n8n (SB-12 executions).
- Recommendation for the esign app: rate-limit `/apply` and cache the prefill
  response per token for the session only.

## Test procedure (Devbox phase)

1. Text Emma until she sends the application link (or set a token manually on
   a Devbox Lead: `Emma_ESign_Token__c` = any 48-hex string,
   `Emma_ESign_Token_Expiry__c` = future datetime).
2. `curl "https://api.bigthinkcapital.com/webhook/emma/esign-prefill?t=<token>"`
3. Expect the 200 payload above with the Lead's chat-collected values.
