-- ============================================================
-- Lamba Family — expenses & settlement. Schema v1.
--
-- Money is whole paise (bigint). The app reaches the database only with the server-side secret key (service_role);
-- every table has row level security ON with NO policy, and the public roles have no grants, so the publishable key
-- can read and write nothing. Invariants that money depends on are enforced HERE as well as in code:
--   · an expense's splits add up to its amount, to the paisa (checked at commit);
--   · a month that is closed, or has a live settlement payment, takes no new/changed/removed expenses;
--   · the audit log can only be appended to;
--   · a recurring bill posts at most once per month; a bank reference is filed at most once.
-- ============================================================

-- ---------- people ----------
create table members (
  id            text primary key check (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  kind          text not null default 'person' check (kind in ('person', 'common')),
  display_name  text not null check (length(display_name) between 1 and 60),
  email         text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role          text not null default 'member' check (role in ('admin', 'member')),
  earning       boolean not null default true,        -- funds the Household pot's shortfall
  upi_id        text check (upi_id is null or length(upi_id) <= 80),
  color         text not null default '#4b7bec',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint common_is_not_a_login check (kind <> 'common' or (email is null and role = 'member'))
);
create unique index members_one_common on members ((kind)) where kind = 'common';

create table credentials (                        -- password hashes live apart from the profile
  member_id    text primary key references members(id) on delete cascade,
  hash         text not null,
  salt         text not null,
  iterations   integer not null check (iterations >= 600000),
  must_change  boolean not null default true,
  updated_at   timestamptz not null default now()
);

create table trusted_devices (                     -- a signed cookie names one of these; a new device needs an e-mail code
  id           uuid primary key default gen_random_uuid(),
  member_id    text not null references members(id) on delete cascade,
  token_hash   text not null unique,
  label        text,
  created_at   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  revoked_at   timestamptz
);

create table otp_codes (
  id           uuid primary key default gen_random_uuid(),
  member_id    text not null references members(id) on delete cascade,
  purpose      text not null check (purpose in ('login', 'reset')),
  code_hash    text not null,
  expires_at   timestamptz not null,
  attempts     integer not null default 0 check (attempts >= 0),
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index otp_codes_member on otp_codes (member_id, created_at desc);

-- ---------- categories ----------
create table categories (
  id          serial primary key,
  name        text not null unique check (length(name) between 1 and 60),
  color       text not null default '#9b93b8',
  subs        text[] not null default '{}',
  archived    boolean not null default false
);

-- ---------- months ----------
create table months (                              -- a row exists once a month is touched; closing freezes a snapshot
  month_key        text primary key check (month_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status           text not null default 'open' check (status in ('open', 'closing', 'closed')),
  carry_in_paise   bigint not null default 0 check (carry_in_paise >= 0),   -- pot surplus carried from the previous month
  surplus_choice   text check (surplus_choice in ('carry', 'payout')),
  note             text,
  snapshot         jsonb,                          -- what the month held when it closed; never rewritten
  closed_at        timestamptz,
  closed_by        text references members(id),
  constraint closed_has_snapshot check (status <> 'closed' or (snapshot is not null and closed_at is not null))
);

create table common_income (                       -- the ONLY income in the app: declared for the Household pot
  id            uuid primary key default gen_random_uuid(),
  month_key     text not null references months(month_key),
  source        text not null check (length(source) between 1 and 80),
  amount_paise  bigint not null check (amount_paise > 0 and amount_paise <= 10000000000),
  received_on   date,
  template_id   uuid,
  created_by    text references members(id),
  created_at    timestamptz not null default now()
);
create index common_income_month on common_income (month_key);

-- ---------- recurring bills ----------
create table recurring_templates (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(name) between 1 and 80),
  kind           text not null check (kind in ('fixed', 'fluctuating')),
  amount_paise   bigint not null check (amount_paise > 0 and amount_paise <= 10000000000),   -- fixed: the bill; fluctuating: the estimate
  due_day        smallint not null check (due_day between 1 and 31),                         -- a short month uses its last day
  paid_by        text not null references members(id),
  split_type     text not null check (split_type in ('equal', 'percent', 'exact')),
  splits         jsonb not null,                   -- e.g. {"bhawneet":50,"gurneet":50} (percent) or paise (exact) or ["a","b"] (equal)
  category_id    integer references categories(id),
  subcategory    text,
  start_month    text not null check (start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  end_month      text check (end_month is null or end_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  active         boolean not null default true,
  created_by     text references members(id),
  created_at     timestamptz not null default now(),
  constraint end_after_start check (end_month is null or end_month >= start_month)
);

-- ---------- expenses ----------
create table expenses (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(name) between 1 and 120),
  amount_paise   bigint not null check (amount_paise > 0 and amount_paise <= 10000000000),
  expense_date   date not null check (expense_date between date '2020-01-01' and date '2100-12-31'),
  month_key      text generated always as (lpad(extract(year from expense_date)::int::text, 4, '0') || '-' || lpad(extract(month from expense_date)::int::text, 2, '0')) stored,
  paid_by        text not null references members(id),
  category_id    integer references categories(id),
  subcategory    text,
  tags           text[] not null default '{}',
  note           text,
  receipt_key    text,                              -- object-storage key, never a URL
  envelope       text not null default 'household' check (envelope in ('household', 'personal', 'group')),
  split_type     text not null check (split_type in ('equal', 'percent', 'exact', 'full_reimbursement')),
  status         text not null default 'approved' check (status in ('draft', 'pending_approval', 'approved', 'rejected')),
  source         text not null default 'manual' check (source in ('manual', 'recurring', 'inbox')),
  template_id    uuid references recurring_templates(id),
  ref            text,                              -- bank reference of the payment this was filed from
  refund_of      uuid references expenses(id),      -- a refund is an expense line that returns money against another
  version        integer not null default 1,
  created_by     text references members(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,                       -- soft delete: history stays
  constraint refund_not_self check (refund_of is null or refund_of <> id)
);
create index expenses_month on expenses (month_key) where deleted_at is null;
create index expenses_payer on expenses (paid_by, month_key) where deleted_at is null;
create unique index expenses_ref_once on expenses (ref) where ref is not null and deleted_at is null;

create table expense_splits (
  expense_id   uuid not null references expenses(id) on delete cascade,
  entity_id    text not null references members(id),
  share_paise  bigint not null check (share_paise >= 0),
  primary key (expense_id, entity_id)
);

create table recurring_postings (                  -- a template posts once per month: the primary key is the guarantee
  template_id  uuid not null references recurring_templates(id),
  month_key    text not null check (month_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  expense_id   uuid references expenses(id),
  posted_at    timestamptz not null default now(),
  primary key (template_id, month_key)
);

-- ---------- settlement ----------
create table settlement_payments (
  id            uuid primary key default gen_random_uuid(),
  month_key     text not null references months(month_key),
  from_entity   text not null references members(id),
  to_entity     text not null references members(id),
  amount_paise  bigint not null check (amount_paise > 0 and amount_paise <= 10000000000),
  paid_on       date not null,
  status        text not null default 'cleared' check (status in ('cleared', 'failed', 'reversed')),   -- never deleted
  is_advance    boolean not null default false,
  ref           text,
  note          text,
  proof_key     text,
  status_note   text,
  created_by    text references members(id),
  created_at    timestamptz not null default now(),
  constraint different_people check (from_entity <> to_entity)
);
create index settlement_payments_month on settlement_payments (month_key);
create unique index settlement_payments_ref_once on settlement_payments (ref) where ref is not null and status = 'cleared';

-- ---------- approvals ----------
create table approval_requests (
  id             uuid primary key default gen_random_uuid(),
  type           text not null check (type in ('expense.add', 'expense.edit', 'expense.delete', 'template.change', 'common_income.change', 'presettlement.confirm', 'month.close')),
  expense_id     uuid references expenses(id),
  month_key      text,
  payload        jsonb not null,                    -- the new state
  before_state   jsonb,                             -- the old state, for edits and deletes
  requested_by   text not null references members(id),
  approvers      text[] not null,
  approved_by    text[] not null default '{}',
  mode           text not null default 'all' check (mode in ('all', 'any')),
  status         text not null default 'pending' check (status in ('pending', 'returned', 'accepted', 'declined', 'revoked')),
  reason         text,
  return_note    text,
  version        integer not null default 1,
  created_at     timestamptz not null default now(),
  resubmitted_at timestamptz,
  decided_at     timestamptz,
  constraint returned_has_note check (status <> 'returned' or (return_note is not null and length(trim(return_note)) > 0)),
  constraint approvers_not_requester check (not (requested_by = any (approvers)))
);
-- one open request per expense
create unique index one_open_request_per_expense on approval_requests (expense_id) where expense_id is not null and status in ('pending', 'returned');

-- ---------- inbox (bank e-mail alerts) ----------
create table ingest_keys (
  key_id       text primary key check (key_id ~ '^[a-z0-9]{12,32}$'),
  member_id    text not null references members(id) on delete cascade,
  secret_hash  text not null,
  label        text,
  created_at   timestamptz not null default now(),
  last_used    timestamptz,
  revoked_at   timestamptz
);

create table inbox_messages (
  id           uuid primary key default gen_random_uuid(),
  member_id    text not null references members(id),     -- whose inbox ('common' for the household mailbox)
  source       text not null check (source in ('email', 'sms', 'notification', 'paste', 'manual')),
  snippet      text not null check (length(snippet) <= 1200),   -- the payment text only, never the whole mail
  parsed       jsonb not null,                           -- direction, amount_paise, party, date, ref, bank, method…
  fp           text not null,                            -- fingerprint: the same payment is never queued twice, whatever its status
  status       text not null default 'new' check (status in ('new', 'done', 'ignored')),
  resolution   jsonb,
  created_at   timestamptz not null default now(),
  unique (member_id, fp)
);
create index inbox_waiting on inbox_messages (member_id) where status = 'new';

create table mail_log (                                -- metadata only — never the e-mail text
  id          bigserial primary key,
  member_id   text references members(id),
  at          timestamptz not null default now(),
  sender      text,
  subject     text,
  outcome     text not null check (outcome in ('added', 'duplicate', 'refused', 'untrusted', 'code', 'unrouted')),
  detail      text
);

-- ---------- audit (append-only) ----------
create table audit_logs (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  actor         text not null,
  on_behalf_of  text,
  event         text not null check (event in ('propose', 'accept', 'decline', 'return', 'revoke', 'apply', 'revert', 'payment', 'close', 'reopen', 'login', 'admin')),
  what          text not null,
  reason        text,
  month_key     text,
  request_id    uuid,
  parties       text[] not null default '{}',
  change        jsonb                                    -- {before, after}: what it was and what it became
);
create index audit_logs_month on audit_logs (month_key, at desc);

create table audit_reverts (                            -- the one mutable fact about an entry lives apart from it
  audit_id     bigint primary key references audit_logs(id),
  reverted_at  timestamptz not null default now(),
  reverted_by  text not null
);

-- ============================================================
-- Invariants enforced in the database
-- ============================================================

-- 1. an expense's splits add up to its amount (checked when the transaction commits, so rows can be inserted in any order)
create or replace function split_sum_ok(eid uuid) returns void language plpgsql as $$
declare amt bigint; total bigint; st text;
begin
  select amount_paise, status into amt, st from expenses where id = eid and deleted_at is null;
  if amt is null or st = 'draft' then return; end if;
  select coalesce(sum(share_paise), 0) into total from expense_splits where expense_id = eid;
  if total <> amt then
    raise exception 'splits of expense % add up to % paise but the amount is % paise', eid, total, amt using errcode = '23514';
  end if;
end $$;
create or replace function check_split_sum_expense() returns trigger language plpgsql as $$
begin perform split_sum_ok(new.id); return null; end $$;
create or replace function check_split_sum_split() returns trigger language plpgsql as $$
begin perform split_sum_ok(coalesce(new.expense_id, old.expense_id)); return null; end $$;
create constraint trigger expenses_split_sum after insert or update of amount_paise, status, deleted_at on expenses
  deferrable initially deferred for each row execute function check_split_sum_expense();
create constraint trigger splits_split_sum after insert or update or delete on expense_splits
  deferrable initially deferred for each row execute function check_split_sum_split();

-- 2. a closed month, or one with a live settlement payment, is locked
create or replace function month_is_locked(mk text) returns boolean language sql stable as $$
  select exists (select 1 from months where month_key = mk and status = 'closed')
      or exists (select 1 from settlement_payments where month_key = mk and status = 'cleared');
$$;
create or replace function expenses_lock_guard() returns trigger language plpgsql as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and month_is_locked(old.month_key) then
    raise exception 'month % is closed or settled; its expenses cannot change', old.month_key using errcode = '55006';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and month_is_locked(new.month_key) then
    raise exception 'month % is closed or settled; it takes no new or changed expenses', new.month_key using errcode = '55006';
  end if;
  return coalesce(new, old);
end $$;
create trigger expenses_lock before insert or update or delete on expenses for each row execute function expenses_lock_guard();

create or replace function splits_lock_guard() returns trigger language plpgsql as $$
declare mk text;
begin
  select month_key into mk from expenses where id = coalesce(new.expense_id, old.expense_id);
  if mk is not null and month_is_locked(mk) then
    raise exception 'month % is closed or settled; its splits cannot change', mk using errcode = '55006';
  end if;
  return coalesce(new, old);
end $$;
create trigger splits_lock before insert or update or delete on expense_splits for each row execute function splits_lock_guard();

-- 2b. no date more than 36 months ahead (a typed "2062" is refused, whatever the app does) and none before the books start
create or replace function expenses_date_guard() returns trigger language plpgsql as $$
begin
  if new.expense_date > ((now() at time zone 'Asia/Kolkata')::date + interval '36 months')::date then
    raise exception 'expense_date % is more than 36 months ahead', new.expense_date using errcode = '22008';
  end if;
  return new;
end $$;
create trigger expenses_date before insert or update of expense_date on expenses for each row execute function expenses_date_guard();

-- 3. bookkeeping on every expense change
create or replace function expenses_touch() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then new.version := old.version + 1; new.updated_at := now(); end if;
  return new;
end $$;
create trigger expenses_touch_bu before update on expenses for each row execute function expenses_touch();

-- 4. the audit log is append-only
create or replace function audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'the audit log is append-only' using errcode = '42501'; end $$;
create trigger audit_no_update before update or delete on audit_logs for each row execute function audit_immutable();
create trigger audit_no_truncate before truncate on audit_logs for each statement execute function audit_immutable();

-- 5. a closed month's snapshot is never rewritten
create or replace function months_snapshot_guard() returns trigger language plpgsql as $$
begin
  if old.status = 'closed' and new.status = 'closed' and (new.snapshot is distinct from old.snapshot or new.carry_in_paise <> old.carry_in_paise) then
    raise exception 'a closed month is a record: reopen it first' using errcode = '55006';
  end if;
  return new;
end $$;
create trigger months_snapshot before update on months for each row execute function months_snapshot_guard();

-- ============================================================
-- Security: nothing is reachable with the publishable (anon) key
-- ============================================================
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated, public;
