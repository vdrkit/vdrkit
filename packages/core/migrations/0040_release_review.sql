-- SPDX-License-Identifier: AGPL-3.0-only

alter table workspace add column publish_notify text not null default 'digest'
  check (publish_notify in ('digest', 'now', 'none'));
