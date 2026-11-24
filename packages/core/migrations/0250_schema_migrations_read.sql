-- SPDX-License-Identifier: AGPL-3.0-only
-- read only: app must not mark migrations applied
revoke insert, update, delete, truncate on schema_migrations from vdrkit_app;
grant select on schema_migrations to vdrkit_app;
