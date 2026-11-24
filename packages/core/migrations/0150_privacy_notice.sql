-- SPDX-License-Identifier: AGPL-3.0-only
-- privacy_text is plain text, never rendered as HTML

alter table site_settings add column privacy_url text
  check (privacy_url is null or (privacy_url ~ '^https?://[^\s<>"]+$' and length(privacy_url) <= 2000));
alter table site_settings add column privacy_text text
  check (privacy_text is null or length(privacy_text) between 1 and 50000);
alter table site_settings add constraint site_settings_privacy_one check (privacy_url is null or privacy_text is null);
