-- SPDX-License-Identifier: AGPL-3.0-only
-- listings read grants by node with no room filter

alter table node add constraint node_id_workspace unique (id, workspace_id);

alter table access_grant add constraint access_grant_node_in_workspace
  foreign key (node_id, workspace_id) references node (id, workspace_id);
