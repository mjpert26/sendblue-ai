-- Append-only record of what Emma did, kept so the business impact of the
-- assistant can be measured rather than estimated. Execution logs roll off and
-- Salesforce holds only end state, so nothing here can be reconstructed after
-- the fact — it has to be captured as it happens.
--
-- PRIVACY: no message content, ever. Contacts appear only as the existing
-- non-reversible phoneRef hash. Nothing in this table identifies a person.

create table if not exists conversation_events (
  event_id        bigint generated always as identity primary key,
  correlation_id  text not null,
  contact_ref     text not null,
  record_ref      text,

  -- inbound_received | reply_sent | link_sent | qualified | handoff
  -- | suppressed | followup_sent | send_failed
  event_type      text not null,
  conversation_stage text,
  template_id     text,
  handoff_reason  text,

  -- Time from the triggering inbound message to this event. Populated on
  -- reply_sent; this is the response-time claim.
  latency_ms      integer,

  -- Stamped at write time from the configured messaging timezone, so
  -- out-of-hours coverage stays queryable without re-deriving it later.
  after_hours     boolean not null default false,
  is_weekend      boolean not null default false,

  occurred_at     timestamptz not null default now()
);

create index if not exists conversation_events_occurred_idx on conversation_events (occurred_at);
create index if not exists conversation_events_type_idx     on conversation_events (event_type, occurred_at);
create index if not exists conversation_events_contact_idx  on conversation_events (contact_ref, occurred_at);
create index if not exists conversation_events_record_idx   on conversation_events (record_ref);

alter table conversation_events enable row level security;

-- Daily rollup. Deliberately plain SQL so the numbers are auditable by anyone
-- who wants to check the claim rather than trust the dashboard.
create or replace view emma_daily_activity as
select
  date_trunc('day', occurred_at)                                    as day,
  count(distinct contact_ref)                                       as merchants_engaged,
  count(*) filter (where event_type = 'inbound_received')           as messages_received,
  count(*) filter (where event_type = 'reply_sent')                 as replies_sent,
  count(*) filter (where event_type = 'link_sent')                  as application_links_sent,
  count(*) filter (where event_type = 'qualified')                  as qualifications_completed,
  count(*) filter (where event_type = 'handoff')                    as handoffs_to_human,
  count(*) filter (where event_type = 'send_failed')                as send_failures,
  count(distinct contact_ref) filter (where after_hours or is_weekend)
                                                                    as merchants_engaged_off_hours,
  percentile_cont(0.5) within group (order by latency_ms)
    filter (where event_type = 'reply_sent' and latency_ms is not null)
                                                                    as median_response_ms
from conversation_events
group by 1
order by 1 desc;

-- Conversations Emma carried from first contact to an application link with no
-- human handoff at any point. This is the headline number: work that would
-- otherwise have required a representative.
create or replace view emma_unassisted_conversions as
select
  contact_ref,
  min(occurred_at)                                          as first_contact,
  max(occurred_at) filter (where event_type = 'link_sent')  as link_sent_at,
  count(*) filter (where event_type = 'reply_sent')          as replies,
  extract(epoch from (max(occurred_at) filter (where event_type = 'link_sent') - min(occurred_at)))
                                                            as seconds_to_link
from conversation_events
group by contact_ref
having count(*) filter (where event_type = 'link_sent') > 0
   and count(*) filter (where event_type = 'handoff')   = 0;

-- Views default to SECURITY DEFINER, which would run with the creator's rights
-- and bypass the row level security on the underlying tables. security_invoker
-- makes them honour the caller's permissions instead.
alter view emma_daily_activity         set (security_invoker = on);
alter view emma_unassisted_conversions set (security_invoker = on);
revoke all on emma_daily_activity         from anon, authenticated;
revoke all on emma_unassisted_conversions from anon, authenticated;
