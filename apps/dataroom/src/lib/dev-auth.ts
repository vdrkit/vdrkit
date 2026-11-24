// SPDX-License-Identifier: AGPL-3.0-only
export const devAuthOn = () => process.env.NODE_ENV !== 'production' && process.env.VDRKIT_DEV_AUTH === '1';
