-- SPDX-License-Identifier: AGPL-3.0-only
-- token null: no approval needed. Otherwise the current address approves before the new one gets a code
alter table email_change
  add column approval_token_sha256 text unique check (approval_token_sha256 ~ '^[0-9a-f]{64}$'),
  add column approved_at timestamptz;

alter table email_change drop constraint email_change_status_check;
alter table email_change add constraint email_change_status_check
  check (status in ('pending', 'confirmed', 'replaced', 'expired', 'locked', 'declined'));
