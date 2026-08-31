# Salesforce metadata — Emma custom fields

One-shot deploy of the custom fields the Emma production workflows (SB-00…SB-11)
require, so nobody has to click through Setup 13 times.

All fields are on **Lead**. **4 are required** for SB-00 to go GREEN; the rest
are optional-but-recommended (features degrade gracefully without them — see
`config/salesforce-field-map.json`).

| Field | API name | Type | Required |
|-------|----------|------|----------|
| Emma AI Enabled | `Emma_AI_Enabled__c` | Checkbox (default TRUE) | ✅ |
| Emma Human Takeover | `Emma_Human_Takeover__c` | Checkbox (default FALSE) | ✅ |
| Sendblue Consent | `Sendblue_Consent__c` | Checkbox (default FALSE) | ✅ |
| Sendblue Opt Out | `Sendblue_Opt_Out__c` | Checkbox (default FALSE) | ✅ |
| Sendblue Consent Source | `Sendblue_Consent_Source__c` | Text(255) | optional |
| Sendblue Consent Timestamp | `Sendblue_Consent_Timestamp__c` | DateTime | optional |
| Emma Conversation Stage | `Emma_Conversation_Stage__c` | Text(60) | optional |
| Emma Last Inbound | `Emma_Last_Inbound__c` | DateTime | optional |
| Emma Last Outbound | `Emma_Last_Outbound__c` | DateTime | optional |
| Emma Followup Date | `Emma_Followup_Date__c` | DateTime | optional |
| Emma Followup Attempt | `Emma_Followup_Attempt__c` | Number(2,0) | optional |
| Emma Handoff Reason | `Emma_Handoff_Reason__c` | Text(255) | optional |
| Emma App Link Sent | `Emma_App_Link_Sent__c` | DateTime | optional |

## Deploy (Salesforce CLI)

```bash
cd salesforce
sf org login web --alias btc-prod          # authenticate to production
sf project deploy start --manifest manifest/package.xml --target-org btc-prod
```

## Deploy (Workbench, no CLI)

1. Zip the `force-app` folder **and** `manifest/package.xml` together.
2. workbench.developerforce.com → **migration → Deploy** → upload the zip → Deploy.

## After deploy

1. **Field-Level Security:** grant the integration user's profile (the one the
   n8n `Salesforce Brian` credential authenticates as) **read/write** on all 13.
   Make the four control fields read-only for most rep profiles **except**
   `Emma_Human_Takeover__c` (reps should be able to check it to take over).
2. Confirm the API names match `config/salesforce-field-map.json` exactly (they do).
3. Re-run **SB-00 Discovery & Health Check** — required mappings should now
   resolve and the field-map check should pass.

> These fields are deliberately separate from the existing `Activate_Sendblue__c`
> (managed-package autotext) and `Do_Not_Contact__c` (all-channel DNC) so Emma
> never collides with automation already running on the org.
