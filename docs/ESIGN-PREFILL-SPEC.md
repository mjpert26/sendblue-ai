# ESign Prefill Integration — spec for esign.bigthinkcapital.com

Emma sends qualified merchants a personalized application link. The link carries
a random bearer token that resolves to the merchant's Salesforce Lead, so the
e-sign application opens **pre-filled** with everything collected in the chat.

## Link format Emma sends

```
https://esign.bigthinkcapital.com/apply?t=<token>
```

- `token`: 48 lowercase hex chars, generated fresh each time Emma sends a link
- Stored on the Lead (`Emma_ESign_Token__c`, unique external id) with a 30-day
  expiry (`Emma_ESign_Token_Expiry__c`). Re-sending a link rotates the token.

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
