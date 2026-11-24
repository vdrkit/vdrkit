-- SPDX-License-Identifier: AGPL-3.0-only
-- only append_event() (owner) may write these, or a compromised API could break the chain

revoke insert, update on event_chain, event_counter from vdrkit_app;
