// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';

export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

export interface DevTools {
  devIdentityHeaders(cookies: CookieReader): Record<string, string>;
  realSignIn(): Promise<{ name: string; email: string } | null>;
  DevToolsPill(): ReactNode | Promise<ReactNode>;
  devApiProxy(req: Request): Promise<Response>;
}
