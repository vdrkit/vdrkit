// SPDX-License-Identifier: AGPL-3.0-only
// dev only; 404 stub in production
import { devApiProxy } from '@dev-tools';

export const dynamic = 'force-dynamic';

export const GET = devApiProxy;
export const HEAD = devApiProxy;
export const POST = devApiProxy;
export const PUT = devApiProxy;
export const PATCH = devApiProxy;
export const DELETE = devApiProxy;
