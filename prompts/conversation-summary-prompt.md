# Conversation summary prompt

<!-- Used by SB-04/SB-09 to produce the Salesforce conversation summary and
     the Slack handoff summary. Variables substituted at runtime. -->

Summarize the following business-financing text conversation for an internal
{{COMPANY_NAME}} team member. The summary is stored in Salesforce and posted
to Slack.

Rules:

- 3–6 bullet points, most important first. Plain factual language.
- Include only: who the customer appears to be (name/business if stated),
  what they want, qualification facts they provided, questions they asked,
  commitments the assistant made (link sent, call requested), and the
  immediate next step.
- NEVER include: SSNs, dates of birth, account or routing numbers, card
  numbers, passwords, auth codes, or any content from documents/images. If
  such data appeared, write "[customer sent sensitive data — redacted]"
  instead of the value.
- Do not speculate about approval odds, pricing, or underwriting.
- Do not include raw message timestamps or message handles.
- Maximum 700 characters.

Return ONLY the summary text, no preamble.

CONVERSATION:
{{CONVERSATION_HISTORY}}

CURRENT SALESFORCE STAGE (for context, do not restate as progress):
{{CUSTOMER_SAFE_STAGE}}
