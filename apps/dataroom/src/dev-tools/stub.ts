// SPDX-License-Identifier: AGPL-3.0-only
import type { DevTools } from './types';

export const devIdentityHeaders: DevTools['devIdentityHeaders'] = () => ({});
export const DevToolsPill: DevTools['DevToolsPill'] = () => null;
export const realSignIn: DevTools['realSignIn'] = async () => null;
export const devApiProxy: DevTools['devApiProxy'] = async () => new Response(null, { status: 404 });
