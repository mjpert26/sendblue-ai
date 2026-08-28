-- Emma operational state.
--
-- These tables hold TECHNICAL STATE ONLY: dedupe keys, concurrency locks, send
-- idempotency, scheduled jobs, and error records. Never CRM data, never message
-- content, never customer transcripts. Phone numbers are stored only as the
-- non-reversible hash the workflows already compute (phoneRef), never in E.164.
--
-- agent_config deliberately stays in n8n Data Tables: it is the operator's kill
-- switch panel and must remain editable from the n8n UI under pressure.

-- ---------------------------------------------------------------- dedupe
-- One row per inbound Sendblue message. Written before processing so a webhook
-- redelivery is a no-op. High volume; see the retention job at the bottom.
create table if not exists processed_messages (
  message_handle       text primary key,
  correlation_id       text not null,
  normalized_phone_hash text,
  outcome              text,
  processed_at         timestamptz not null default now()
);
create index if not exists processed_messages_processed_at_idx
  on processed_messages (processed_at);

-- ------------------------------------------------------------ contact locks
-- Serialises processing per contact. Claimed with INSERT .. ON CONFLICT so the
-- claim is atomic — the read-then-write pattern this replaces had a race window
-- in which two concurrent messages could both believe they held the lock.
create table if not exists contact_locks (
  normalized_phone_hash text primary key,
  correlation_id        text not null,
  locked_at             timestamptz not null default now(),
  expires_at            timestamptz not null
);
create index if not exists contact_locks_expires_at_idx
  on contact_locks (expires_at);

-- ------------------------------------------------------ outbound idempotency
-- One row per intended send. The unique key is claimed before dispatch, so a
-- retry or duplicate trigger cannot produce a second message to a customer.
create table if not exists outbound_idempotency (
  idempotency_key      text primary key,
  correlation_id       text not null,
  message_handle       text,
  delivery_status      text,
  accepted_by_sendblue boolean not null default false,
  failure_count        integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists outbound_idempotency_created_at_idx
  on outbound_idempotency (created_at);
create index if not exists outbound_idempotency_undelivered_idx
  on outbound_idempotency (created_at)
  where accepted_by_sendblue = false;

-- -------------------------------------------------------------- followup jobs
-- Scheduled nudges. Queried by due date, so status/due_at carries a compound
-- index rather than the single unique column a key-value store allows.
create table if not exists followup_jobs (
  job_id                text primary key,
  salesforce_record_ref text,
  normalized_phone_hash text,
  due_at                timestamptz not null,
  attempt               integer not null default 0,
  status                text not null default 'PENDING',
  reason                text,
  resolution            text,
  created_at            timestamptz not null default now(),
  resolved_at           timestamptz
);
create index if not exists followup_jobs_due_idx
  on followup_jobs (status, due_at);
create index if not exists followup_jobs_contact_idx
  on followup_jobs (normalized_phone_hash);

-- ---------------------------------------------------------- dead letter queue
-- Unrecoverable events, sanitised. `sanitized_summary` must never contain
-- message bodies or customer identifiers.
create table if not exists dead_letter_events (
  event_id              text primary key,
  correlation_id        text,
  workflow_name         text,
  category              text,
  error_code            text,
  sanitized_summary     text,
  message_handle        text,
  salesforce_record_ref text,
  replayable            boolean not null default false,
  replayed_at           timestamptz,
  created_at            timestamptz not null default now()
);
create index if not exists dead_letter_events_created_at_idx
  on dead_letter_events (created_at);
create index if not exists dead_letter_events_open_idx
  on dead_letter_events (created_at)
  where replayed_at is null;

-- ------------------------------------------------------------- test results
create table if not exists test_results (
  id          bigint generated always as identity primary key,
  run_id      text not null,
  case_id     text not null,
  passed      boolean not null,
  detail      text,
  executed_at timestamptz not null default now()
);
create index if not exists test_results_run_idx on test_results (run_id);

-- ----------------------------------------------------------------------- RLS
-- Every table is service-role only. n8n connects with the service key; no
-- anonymous or authenticated client may read operational state. A dashboard
-- reads through a server-side endpoint, never directly from the browser.
alter table processed_messages    enable row level security;
alter table contact_locks         enable row level security;
alter table outbound_idempotency  enable row level security;
alter table followup_jobs         enable row level security;
alter table dead_letter_events    enable row level security;
alter table test_results          enable row level security;
