-- migrations/0028_device_sign_in.sql — phones and how people sign in on them (TASK-058, D210).
--
-- The staff app (TASK-063) runs on two kinds of Android phone: COMPANY phones, shared across shifts and
-- handed over like any other custody item, and PERSONAL phones that belong to one person. Nobody gets an
-- SMS; nobody types a password.
--
--   device            a phone, enrolled by the CEO or an Admin from a one-time code (shown as a QR). It
--                     proves itself on every call with a secret only it holds (we keep a hash).
--   device_enrolment  the one-time enrolment codes (hashed with a key only the API holds), valid minutes.
--   app_setup_code    a one-time code that sets a person up on a phone (same hashing), valid hours.
--   app_credential    one person on one phone: a random secret the phone keeps for them (hashed here) and
--                     their 4–6 digit PIN (salted, peppered, slow-hashed). Both are needed to sign in, and
--                     only this server can tell a right PIN from a wrong one — the phone holds nothing a PIN
--                     guess can be tested against. Wrong PINs are counted here, slowed down from the fifth,
--                     and the tenth in a row disables the credential until the person is set up again.
--   app_session       a signed-in person on a phone: an opaque 15-minute access token and a refresh token
--                     (both hashed), rotated together; a refresh token used twice ends the whole family
--                     (RFC 9700 §4.14). On a company phone a sign-in ends at the next shift handover.
--
-- Purpose: account security only — never attendance, punctuality or performance (D210, notice v3).
-- Personal data: which phones a person uses and when they signed in; read by the CEO and Admins, and by
-- the person themself for their own rows; written only by the API on the service role; expired rows are
-- removed after 30 days (pruneAppAuth). Every step is in audit_log.

create table if not exists device (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in ('company', 'personal')),
  label             text not null check (length(label) between 1 and 80),
  -- A personal phone belongs to exactly one person; a company phone to nobody in particular.
  bound_employee_id uuid references employee (id),
  platform          text,
  model             text,
  app_version       text,
  -- sha256 of the 32 random bytes the phone keeps in its Keystore.
  secret_hash       text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
  enrolled_by       uuid references employee (id),
  enrolled_at       timestamptz not null default now(),
  last_seen_at      timestamptz,
  -- Too many wrong PINs or wrong set-up codes on this phone: nothing until then.
  locked_until      timestamptz,
  revoked_at        timestamptz,
  revoked_by        uuid references employee (id),
  revoke_reason     text,
  is_synthetic      boolean not null default false,
  correlation_id    uuid,
  check ((kind = 'personal') = (bound_employee_id is not null))
);
create index if not exists idx_device_bound on device (bound_employee_id) where bound_employee_id is not null;

create table if not exists device_enrolment (
  id                uuid primary key default gen_random_uuid(),
  code_hash         text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  kind              text not null check (kind in ('company', 'personal')),
  label             text not null check (length(label) between 1 and 80),
  bound_employee_id uuid references employee (id),
  created_by        uuid not null references employee (id),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  used_at           timestamptz,
  device_id         uuid references device (id),
  is_synthetic      boolean not null default false,
  correlation_id    uuid,
  check ((kind = 'personal') = (bound_employee_id is not null))
);

create table if not exists app_setup_code (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references employee (id),
  code_hash      text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  created_by     uuid not null references employee (id),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  used_at        timestamptz,
  used_on_device uuid references device (id),
  -- Issuing a new code voids the person's earlier unused ones.
  voided_at      timestamptz,
  is_synthetic   boolean not null default false,
  correlation_id uuid
);
create index if not exists idx_app_setup_code_employee on app_setup_code (employee_id, created_at desc);

create table if not exists app_credential (
  id                uuid primary key default gen_random_uuid(),
  device_id         uuid not null references device (id),
  employee_id       uuid not null references employee (id),
  -- sha256 of the random secret this phone keeps for this person.
  secret_hash       text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
  -- scrypt over an HMAC of the PIN with a pepper only the API holds: 'scrypt$<logN>$<r>$<p>$<salt>$<hash>'.
  pin_hash          text not null check (pin_hash like 'scrypt$%'),
  pin_set_at        timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  setup_code_id     uuid references app_setup_code (id),
  -- Wrong PINs in a row since the last good sign-in.
  failed_count      integer not null default 0 check (failed_count >= 0),
  last_failed_at    timestamptz,
  -- From the fifth wrong PIN in a row: no try before this moment.
  locked_until      timestamptz,
  disabled_at       timestamptz,
  disabled_reason   text,
  revoked_at        timestamptz,
  revoked_by        uuid references employee (id),
  last_signed_in_at timestamptz,
  is_synthetic      boolean not null default false,
  correlation_id    uuid
);
-- One live credential per person per phone.
create unique index if not exists uq_app_credential_live on app_credential (device_id, employee_id) where revoked_at is null;
create index if not exists idx_app_credential_employee on app_credential (employee_id);

create table if not exists app_session (
  id                uuid primary key default gen_random_uuid(),
  -- Every token pair descended from one sign-in; a refresh token presented twice ends them all.
  family_id         uuid not null,
  credential_id     uuid not null references app_credential (id),
  device_id         uuid not null references device (id),
  employee_id       uuid not null references employee (id),
  access_hash       text not null unique check (access_hash ~ '^[0-9a-f]{64}$'),
  access_expires_at timestamptz not null,
  refresh_hash      text not null unique check (refresh_hash ~ '^[0-9a-f]{64}$'),
  created_at        timestamptz not null default now(),
  -- The family's hard end — the next shift handover on a company phone, a month on a personal one …
  expires_at        timestamptz not null,
  -- … and the end if the phone goes quiet.
  idle_until        timestamptz not null,
  -- When this pair's refresh token was exchanged, and for which pair.
  used_at           timestamptz,
  replaced_by       uuid references app_session (id),
  revoked_at        timestamptz,
  revoke_reason     text,
  is_synthetic      boolean not null default false,
  correlation_id    uuid
);
create index if not exists idx_app_session_family on app_session (family_id);
create index if not exists idx_app_session_device on app_session (device_id) where revoked_at is null;
create index if not exists idx_app_session_employee on app_session (employee_id, created_at desc);

-- ── Row security ──────────────────────────────────────────────────────────────
-- Read by whoever manages people (CEO, Admin); a person reads their own phones, credentials and
-- sessions. Codes are for the API alone (a policy only managers match). Nothing is written by the app
-- role: every write is core on the service role, checked and audited.
alter table device enable row level security;
alter table device force row level security;
alter table device_enrolment enable row level security;
alter table device_enrolment force row level security;
alter table app_setup_code enable row level security;
alter table app_setup_code force row level security;
alter table app_credential enable row level security;
alter table app_credential force row level security;
alter table app_session enable row level security;
alter table app_session force row level security;

do $$
begin
  perform set_config('client_min_messages', 'warning', true);
  drop policy if exists device_select on device;
  drop policy if exists device_enrolment_select on device_enrolment;
  drop policy if exists app_setup_code_select on app_setup_code;
  drop policy if exists app_credential_select on app_credential;
  drop policy if exists app_session_select on app_session;
end $$;

create policy device_select on device for select to freshnow_app
  using ((select app_has_capability('people.manage')) or bound_employee_id = app_current_employee());
create policy device_enrolment_select on device_enrolment for select to freshnow_app
  using ((select app_has_capability('people.manage')));
create policy app_setup_code_select on app_setup_code for select to freshnow_app
  using ((select app_has_capability('people.manage')));
create policy app_credential_select on app_credential for select to freshnow_app
  using ((select app_has_capability('people.manage')) or employee_id = app_current_employee());
create policy app_session_select on app_session for select to freshnow_app
  using ((select app_has_capability('people.manage')) or employee_id = app_current_employee());

grant select on device, device_enrolment, app_setup_code, app_credential, app_session to freshnow_app;
