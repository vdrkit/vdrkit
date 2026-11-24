// SPDX-License-Identifier: AGPL-3.0-only

export const deadLink = (status: number) => status === 400 || status === 404 || status === 410;
