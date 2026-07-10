# Salesforce Setup

How to connect Emma to your Salesforce org: connected app + OAuth2, a
least-privilege API user, schema discovery, resolving the field map, and the
actions Emma is forbidden from ever performing automatically. No custom field
API names are assumed anywhere in this repo — everything org-specific is
resolved through discovery (see ASSUMPTIONS.md A-10).

## 1. Connected app + OAuth2 for n8n

1. In Salesforce **Setup → App Manager → New Connected App**.
2. Enable OAuth settings; callback URL = your n8n instance's Salesforce
   OAuth2 callback (shown in the n8n credential dialog when you create
   `Salesforce OAuth2`).
3. OAuth scopes: `api` (Manage user data via APIs) and `refresh_token,
   offline_access`. Do not grant `full`.
4. Save, then copy the **Consumer Key** and **Consumer Secret** into `.env`
   (`SF_CLIENT_ID`, `SF_CLIENT_SECRET`) and into the n8n `Salesforce OAuth2`
   credential ([`N8N-SETUP.md`](N8N-SETUP.md) §2.2).
5. Under the connected app's policies, restrict access to the API user's
   profile/permission set only ("Admin approved users are pre-authorized").

## 2. API user permissions (least privilege)

Create a **dedicated integration user** (e.g., "Emma Integration") — never
run the integration as a human admin. Grant, via a dedicated permission set:

| Object | Access | Why |
|--------|--------|-----|
| Lead | Read, Create, Edit | Intake (Journey A/B), qualification field updates, flags |
| Contact | Read, Edit | Converted-lead conversations |
| Task | Read, Create | Handoff tasks (SB-09) |
| Account | Read only | Person-account/converted-lead resolution |
| Opportunity | Read only | Status lookup (SB-05) reads StageName; Emma never edits opportunities |
| **Delete (any object)** | **None** | Emma never deletes anything |

Also: API Enabled; field-level security granting edit only on the specific
fields mapped in §4–5; no "Modify All Data", no "View All Data" beyond what
phone-match queries require. The narrower this user, the smaller the blast
radius of any defect — SB-06 and the field map are the application-level
guards, but Salesforce permissions are the backstop.

## 3. Running the discovery scripts

1. Put an access token for the integration user in `.env`
   (`SF_ACCESS_TOKEN`; discovery scripts only — n8n uses its own credential),
   plus `SF_INSTANCE_URL` and `SF_API_VERSION`.
2. `npm run inspect:salesforce` — pulls `describe` metadata for Lead,
   Contact, Account, Opportunity, Task: field API names, types, picklist
   values.
3. `npm run generate:sf-map` — writes
   `config/salesforce-field-map.generated.json` (**gitignored**; it contains
   org schema and must not be committed).
4. Re-run both whenever admins add/rename fields or picklist values, then
   re-run SB-00.

## 4. Resolving UNMAPPED required fields

Copy `config/salesforce-field-map.example.json` to a local
`config/salesforce-field-map.json` and resolve every `UNMAPPED` entry using
the generated file. **SB-00 fails RED while any required mapping is
`UNMAPPED`.** The required logical fields:

| Logical field | Purpose | Example ships as |
|---------------|---------|------------------|
| `ai_enabled` | Per-record AI on/off toggle | `UNMAPPED` — must map |
| `human_takeover` | Human owns the thread; Emma silent | `UNMAPPED` — must map |
| `sms_consent` | Messaging consent flag (gates proactive sends) | `UNMAPPED` — must map |
| `sms_opt_out` | Opt-out flag (blocks everything) | `UNMAPPED` — must map |
| `first_name`, `last_name` | Identity / confirmation factor | `Lead.FirstName` / `Lead.LastName` |
| `business_name` | Company / confirmation factor | `Lead.Company` |
| `mobile_phone`, `phone` | Phone matching (SB-03) | `Lead.MobilePhone` / `Lead.Phone` |
| `lead_source` | Attribution of AI-created leads | `Lead.LeadSource` |
| `record_owner` | Handoff task assignment | `Lead.OwnerId` |
| `lead_id`, `contact_id` | Record references | `Lead.Id` / `Contact.Id` |

Optional mappings (`time_in_business`, `requested_amount`,
`conversation_stage`, `followup_date`, …) may remain `UNMAPPED`: the
dependent feature is skipped and logged rather than failing (A-10). Note the
follow-up fields specifically — if `followup_date`/`followup_attempt` are
unmapped, SB-08 falls back to the `followup_jobs` Data Table, but Salesforce
remains the preferred home for that state.

Also populate `internal_values` in your local copy of
`config/customer-safe-status-map.example.json` from the generated picklists
(ASSUMPTIONS A-15) — the shipped `PLACEHOLDER_*` values match no real org.

## 5. Recommended custom fields (suggestions only)

If your org has no existing fields to map the required logical fields to,
these are **suggested** definitions — your org may equally map to existing
fields, different names, or a different object model. Create on Lead (and
mirror on Contact where conversations continue post-conversion):

| Suggested label | Suggested API name | Type | Logical field |
|-----------------|--------------------|------|---------------|
| AI Enabled | `AI_Enabled__c` | Checkbox, default TRUE | `ai_enabled` |
| Human Takeover | `Human_Takeover__c` | Checkbox, default FALSE | `human_takeover` |
| SMS Consent | `SMS_Consent__c` | Checkbox, default FALSE | `sms_consent` |
| SMS Consent Source | `SMS_Consent_Source__c` | Text(100) | `consent_source` |
| SMS Consent Timestamp | `SMS_Consent_Timestamp__c` | Date/Time | `consent_timestamp` |
| SMS Opt Out | `SMS_Opt_Out__c` | Checkbox, default FALSE | `sms_opt_out` |
| Wrong Number | `Wrong_Number__c` | Checkbox, default FALSE | `wrong_number` |
| AI Conversation Stage | `AI_Conversation_Stage__c` | Picklist | `conversation_stage` |
| AI Handoff Reason | `AI_Handoff_Reason__c` | Text(255) | `handoff_reason` |
| Next Follow-Up Date | `AI_Followup_Date__c` | Date/Time | `followup_date` |
| Follow-Up Attempt | `AI_Followup_Attempt__c` | Number | `followup_attempt` |
| Last Inbound SMS | `Last_Inbound_SMS__c` | Date/Time | `last_inbound_date` |
| Last Outbound SMS | `Last_Outbound_SMS__c` | Date/Time | `last_outbound_date` |
| Monthly Gross Revenue | `Monthly_Gross_Revenue__c` | Currency | `monthly_gross_revenue` |
| Time in Business (months) | `Time_in_Business_Months__c` | Number | `time_in_business` |
| Requested Amount | `Requested_Amount__c` | Currency | `requested_amount` |

After creating fields: grant the integration user field-level edit access,
re-run discovery (§3), then update the local field map.

## 6. Field-map file workflow

1. `config/salesforce-field-map.example.json` — committed template; standard
   fields pre-mapped, everything org-specific `UNMAPPED`. Never edit this
   with real org values.
2. `config/salesforce-field-map.generated.json` — raw discovery output from
   `npm run generate:sf-map`; **gitignored**.
3. `config/salesforce-field-map.json` — your resolved local copy (example +
   generated, every required `UNMAPPED` resolved); **gitignored**, deployed
   to the workflows' configuration.

Conflict rules travel with the map: the default is `fill_empty_only` — Emma
may only populate empty fields, never overwrite human-entered values; the
only `overwrite` overrides are AI-owned bookkeeping fields
(`ai_conversation_summary`, `last_inbound_date`, `last_outbound_date`,
`conversation_stage`).

## 7. Forbidden automatic actions

These are hard-blocked in the field map's `forbidden_automatic_actions` and
must never be granted, mapped, or worked around:

- `convert_lead`
- `change_owner`
- `close_opportunity`
- `approve_application`
- `decline_application`
- `change_underwriting_stage`

Emma also never deletes records (no delete permission at all, §2) and never
writes Opportunity fields. Anything credit-decision-adjacent is a human
action by design — see [`../COMPLIANCE-REVIEW.md`](../COMPLIANCE-REVIEW.md)
§4 and [`HUMAN-HANDOFF.md`](HUMAN-HANDOFF.md).
