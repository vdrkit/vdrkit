// SPDX-License-Identifier: AGPL-3.0-only
// Rooms can have more than one seller party. Always the first, everywhere
export const sellerNameSql = (workspaceIdExpr: string) =>
  `(select pa.name from party pa where pa.workspace_id = ${workspaceIdExpr} and pa.kind = 'seller' order by pa.created_at, pa.id limit 1)`;

export const SELLER_ID_SQL = `select id from party where workspace_id = $1 and kind = 'seller' order by created_at, id limit 1`;
