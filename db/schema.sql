-- Emma technical-state schema (Postgres on Supabase, project "btc-sendblue-ai").
--
-- Reconstructed from the live database on 2026-09-04. The database is the source
-- of truth; this file documents the contract the n8n Postgres nodes rely on so a
-- new environment can be provisioned identically. Technical state ONLY: hashed
-- phone references, correlation ids, delivery handles and statuses. Never message
-- content, CRM data, or raw phone numbers.
--
-- Concurrency-critical tables were moved here from n8n Data Tables because a
-- primary-key INSERT is atomic and a Data Table read-then-write is not:
--   processed_messages    SB-01 inbound dedupe claim
--   contact_locks         SB-01 per-contact lock
--   outbound_idempotency  SB-06 send claim (the only race that could double-text)
--   conversation_events   funnel telemetry behind the emma_* views
--
-- Connection from n8n: Supabase Session pooler (port 5432, user postgres.<project ref>),
-- SSL on. The direct connection is IPv6-only.

create table if not exists processed_messages (
  message_handle         text primary key,
  correlation_id         text not null,
  normalized_phone_hash  text,
  outcome                text,
  processed_at           timestamptz not null default now()
);
create index if not exists processed_messages_processed_at_idx on processed_messages (processed_at);

create table if not exists contact_locks (
  normalized_phone_hash  text primary key,
  correlation_id         text not null,
  locked_at              timestamptz not null default now(),
  expires_at             timestamptz not null
);
create index if not exists contact_locks_expires_at_idx on contact_locks (expires_at);

create table if not exists outbound_idempotency (
  idempotency_key        text primary key,
  correlation_id         text not null,
  message_handle         text,
  delivery_status        text,
  accepted_by_sendblue   boolean not null default false,
  failure_count          integer not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists outbound_idempotency_created_at_idx on outbound_idempotency (created_at);
create index if not exists outbound_idempotency_undelivered_idx on outbound_idempotency (created_at) where accepted_by_sendblue = false;

create table if not exists followup_jobs (
  job_id                 text primary key,
  salesforce_record_ref  text,
  normalized_phone_hash  text,
  due_at                 timestamptz not null,
  attempt                integer not null default 0,
  status                 text not null default 'PENDING',
  reason                 text,
  resolution             text,
  created_at             timestamptz not null default now(),
  resolved_at            timestamptz
);
create index if not exists followup_jobs_due_idx on followup_jobs (status, due_at);
create index if not exists followup_jobs_contact_idx on followup_jobs (normalized_phone_hash);

create table if not exists dead_letter_events (
  event_id               text primary key,
  correlation_id         text,
  workflow_name          text,
  category               text,
  error_code             text,
  sanitized_summary      text,
  message_handle         text,
  salesforce_record_ref  text,
  replayable             boolean not null default false,
  replayed_at            timestamptz,
  created_at             timestamptz not null default now()
);
create index if not exists dead_letter_events_created_at_idx on dead_letter_events (created_at);
create index if not exists dead_letter_events_open_idx on dead_letter_events (created_at) where replayed_at is null;

create table if not exists test_results (
  id                     bigint generated always as identity primary key,
  run_id                 text not null,
  case_id                text not null,
  passed                 boolean not null,
  detail                 text,
  executed_at            timestamptz not null default now()
);
create index if not exists test_results_run_idx on test_results (run_id);

-- One row per funnel event. event_type values written today:
--   inbound_received  SB-01 (same statement as the dedupe claim)
--   reply_sent        SB-06 Record Send Outcome (latency_ms from inbound_received)
--   link_sent         SB-06 Record Send Outcome (template_id = application_link)
--   send_failed       SB-06 Record Send Outcome (Sendblue returned no handle)
-- Read by the views but not yet written by any workflow:
--   handoff, qualified
create table if not exists conversation_events (
  event_id               bigint generated always as identity primary key,
  correlation_id         text not null,
  contact_ref            text not null,
  record_ref             text,
  event_type             text not null,
  conversation_stage     text,
  template_id            text,
  handoff_reason         text,
  latency_ms             integer,
  after_hours            boolean not null default false,
  is_weekend             boolean not null default false,
  occurred_at            timestamptz not null default now()
);
create index if not exists conversation_events_type_idx     on conversation_events (event_type, occurred_at);
create index if not exists conversation_events_contact_idx  on conversation_events (contact_ref, occurred_at);
create index if not exists conversation_events_record_idx   on conversation_events (record_ref);
create index if not exists conversation_events_occurred_idx on conversation_events (occurred_at);

-- Row Level Security is enabled on every table; n8n connects as the postgres
-- role, which bypasses RLS. Any other client needs explicit policies.
alter table processed_messages    enable row level security;
alter table contact_locks         enable row level security;
alter table outbound_idempotency  enable row level security;
alter table followup_jobs         enable row level security;
alter table dead_letter_events    enable row level security;
alter table test_results          enable row level security;
alter table conversation_events   enable row level security;

-- Operator views ------------------------------------------------------------

create or replace view emma_daily_activity as
select date_trunc('day', occurred_at)                                                   as day,
       count(distinct contact_ref)                                                      as merchants_engaged,
       count(*) filter (where event_type = 'inbound_received')                          as messages_received,
       count(*) filter (where event_type = 'reply_sent')                                as replies_sent,
       count(*) filter (where event_type = 'link_sent')                                 as application_links_sent,
       count(*) filter (where event_type = 'qualified')                                 as qualifications_completed,
       count(*) filter (where event_type = 'handoff')                                   as handoffs_to_human,
       count(*) filter (where event_type = 'send_failed')                               as send_failures,
       count(distinct contact_ref) filter (where after_hours or is_weekend)             as merchants_engaged_off_hours,
       percentile_cont(0.5) within group (order by latency_ms::double precision)
         filter (where event_type = 'reply_sent' and latency_ms is not null)            as median_response_ms
from conversation_events
group by 1
order by 1 desc;

-- Headline metric: merchants who got an application link with no human involved.
-- Returns zero rows until link_sent events are written (SB-06 Record Send Outcome).
create or replace view emma_unassisted_conversions as
select contact_ref,
       min(occurred_at)                                                as first_contact,
       max(occurred_at) filter (where event_type = 'link_sent')        as link_sent_at,
       count(*) filter (where event_type = 'reply_sent')               as replies,
       extract(epoch from max(occurred_at) filter (where event_type = 'link_sent') - min(occurred_at)) as seconds_to_link
from conversation_events
group by contact_ref
having count(*) filter (where event_type = 'link_sent') > 0
   and count(*) filter (where event_type = 'handoff') = 0;
