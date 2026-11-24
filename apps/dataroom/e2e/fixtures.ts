// SPDX-License-Identifier: AGPL-3.0-only
import { test as base, expect, type Locator, type Page, type Request } from '@playwright/test';
import { DEV_ROOM_ID, PERSONA_COOKIE, PERSONAS } from '../src/dev-tools/personas';

export { expect };

export type PersonaKey = 'anika' | 'maria' | 'johan' | 'jan' | 'pieter' | 'lars' | 'liesl' | 'thabo';

export const ROOM_ID = DEV_ROOM_ID;
export const API_URL = `http://127.0.0.1:${process.env.API_PORT ?? '3101'}`;

// fixed by stableId() in apps/server/src/demo/seed-demo.ts
export const NODE = {
  '2': '755a8aec-8ff0-4391-b1ca-1004fe78ffdf',
  '2.4': '87ffb060-4ff4-4179-8884-13169b5f4195',
  '2.4.2': '27087787-3869-4ad1-bf60-086b3e78fc98',
  '3': '2aa3b957-02c2-4e19-aced-d7f938734e44',
} as const;

export function roomPath(section: string, id?: string): string {
  return `/rooms/${ROOM_ID}/${section}${id ? `/${id}` : ''}`;
}

// clicks before hydration are lost under next dev
export async function hydrated(page: Page): Promise<void> {
  await expect(page.locator('.top .qs-in[data-ready]')).toBeAttached();
}

export async function setPersona(page: Page, key: PersonaKey): Promise<void> {
  await page.context().addCookies([{ name: PERSONA_COOKIE, value: key, domain: '127.0.0.1', path: '/' }]);
}

// Waits for the router.refresh() after a click. Navigating while it is in flight aborts the
// test's next goto in Firefox (NS_BINDING_ABORTED).
export async function clickAndRefresh(page: Page, button: Locator): Promise<void> {
  // finished or failed; Chromium sometimes aborts the refresh after its headers
  const isRefresh = (r: Request) => r.method() === 'GET' && new URL(r.url()).searchParams.has('_rsc');
  let stop = () => {};
  const settled = new Promise<void>((resolve, reject) => {
    const done = (r: Request) => { if (isRefresh(r)) { stop(); resolve(); } };
    const timer = setTimeout(() => { stop(); reject(new Error('Save did not refresh the page (no _rsc request within 30 s)')); }, 30_000);
    stop = () => { clearTimeout(timer); page.off('requestfinished', done); page.off('requestfailed', done); };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
  });
  await button.click();
  await settled;
}

// data-hydrated is set by HydrationMark; non-app pages (JSON, files) pass straight away
export async function pageHydrated(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.hasAttribute('data-hydrated') || !document.querySelector('script[src*="/_next/"]'),
    null,
    { timeout: 45_000 },
  );
}

// WebKit hydrates slowly on dev bundles and drops early typing
function waitForHydrationOnLoad(page: Page): Page {
  for (const name of ['goto', 'reload'] as const) {
    const original = page[name].bind(page) as (...args: unknown[]) => Promise<unknown>;
    (page as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      const res = await original(...args);
      await pageHydrated(page);
      return res;
    };
  }
  return page;
}

export function cspViolations(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|^Refused to /.test(t)) seen.push(`${page.url()}: ${t}`);
  });
  void page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`Content Security Policy violation: ${e.effectiveDirective} blocked ${e.blockedURI || 'inline'} at ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  return seen;
}

export const test = base.extend<{ persona: (key: PersonaKey) => Promise<void> }>({
  page: async ({ page }, use) => {
    const violations = cspViolations(page);
    await use(waitForHydrationOnLoad(page));
    expect(violations, 'Content-Security-Policy violations').toEqual([]);
  },
  persona: async ({ page }, use) => {
    await use((key) => setPersona(page, key));
  },
});

export { PERSONAS };
