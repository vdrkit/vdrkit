// SPDX-License-Identifier: AGPL-3.0-only
// WCAG 2.0-2.2 A and AA via axe-core; see docs/accessibility.md
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// rule id -> reason
export const ALLOWED: Record<string, string> = {};

// dev-only UI, not in production builds
const DEV_ONLY = ['.proto', '[data-review-ui]', 'nextjs-portal'];

export const EXCLUDED: Record<string, string> = {
  // the watermark preview is faint on purpose; it is role="img" and the labels beside it repeat the text
  '.f3 .wm': 'F3 watermark example: incidental text in a picture (1.4.3)',
};

function describe(v: { id: string; help: string; nodes: { target: unknown[]; failureSummary?: string }[] }): string {
  const nodes = v.nodes.slice(0, 6).map((n) => `    ${JSON.stringify(n.target)}\n      ${(n.failureSummary ?? '').replace(/\n/g, '\n      ')}`).join('\n');
  return `${v.id}: ${v.help} (${v.nodes.length})\n${nodes}`;
}

export async function expectNoAxeViolations(page: Page, where: string, opts: { include?: string } = {}): Promise<void> {
  // let fonts and transitions settle
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  for (const sel of [...DEV_ONLY, ...Object.keys(EXCLUDED)]) builder = builder.exclude(sel);
  if (opts.include) builder = builder.include(opts.include);
  const result = await builder.analyze();
  const bad = result.violations.filter((v) => !(v.id in ALLOWED));
  expect(bad.map(describe).join('\n'), `axe found WCAG A or AA violations on ${where}`).toBe('');
}

export async function focusedDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return 'body';
    const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? '';
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ').join('.')}` : ''} "${name}"`;
  });
}

// 2.4.7 focus visible, 2.4.11 focus not obscured
export async function expectVisibleFocus(page: Page): Promise<void> {
  const r = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { ok: false, why: 'nothing has focus' };
    const ringOn = (x: Element) => {
      const c = getComputedStyle(x);
      return (c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) >= 1) || (c.boxShadow !== 'none' && c.boxShadow !== '');
    };
    // a ring on a small parent counts too; a shadow on a big one is just a card
    let ring = ringOn(el);
    for (let up = el.parentElement, i = 0; !ring && up && i < 4; up = up.parentElement, i++) {
      const c = getComputedStyle(up);
      ring = (c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) >= 1) || (up.getBoundingClientRect().height < 80 && ringOn(up));
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return { ok: false, why: 'the focused element has no size' };
    const pts = [[rect.left + rect.width / 2, rect.top + rect.height / 2], [rect.left + 2, rect.top + 2], [rect.right - 2, rect.bottom - 2]];
    const inView = pts.some(([x, y]) => x! >= 0 && y! >= 0 && x! <= innerWidth && y! <= innerHeight);
    const visible = pts.some(([x, y]) => { const at = document.elementFromPoint(x!, y!); return !!at && (at === el || el.contains(at) || at.contains(el) || !!at.closest('.proto, [data-review-ui]')); });
    if (!ring) return { ok: false, why: 'no outline or box shadow' };
    if (inView && !visible) return { ok: false, why: 'covered by another element' };
    return { ok: true, why: '' };
  });
  expect(r.why, `focus on ${await focusedDescription(page)}`).toBe('');
}

// 2.5.8 target size (minimum)
export async function targetsTooSmall(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [tabindex="0"]';
    const all = [...root.querySelectorAll<HTMLElement>(sel)].filter((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !(el as HTMLButtonElement).disabled && !el.closest('[aria-hidden="true"], .proto, [data-review-ui]');
    });
    const rects = all.map((el) => el.getBoundingClientRect());
    const out: string[] = [];
    all.forEach((el, i) => {
      const r = rects[i]!;
      if (r.width >= 24 && r.height >= 24) return;
      if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') return;
      if ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio') {
        const lab = el.closest('label');
        if (lab) { const lr = lab.getBoundingClientRect(); if (lr.width >= 24 && lr.height >= 24) return; }
      }
      // spacing exception
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const clash = rects.some((o, j) => {
        if (j === i || all[j]!.contains(el) || el.contains(all[j]!)) return false;
        const nx = Math.max(o.left, Math.min(cx, o.right)), ny = Math.max(o.top, Math.min(cy, o.bottom));
        const ocx = o.left + o.width / 2, ocy = o.top + o.height / 2;
        const small = o.width < 24 || o.height < 24;
        return small ? Math.hypot(ocx - cx, ocy - cy) < 24 : Math.hypot(nx - cx, ny - cy) < 12;
      });
      if (clash) out.push(`${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ')[0]}` : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    return out;
  });
}

// 1.4.10 reflow
export async function horizontalOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= vw + 1) return [];
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width > 0 && getComputedStyle(el).position !== 'fixed') {
        let p = el.parentElement, scrolls = false;
        while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { scrolls = true; break; } p = p.parentElement; }
        if (!scrolls) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} right edge ${Math.round(r.right)} > ${vw}`);
      }
    }
    return out.slice(0, 8);
  });
}

// 1.4.12 text spacing
export async function applyTextSpacing(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }',
  });
}

export async function clippedText(page: Page, scope = 'main'): Promise<string[]> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel) ?? document.body;
    const out: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())) continue;
      const s = getComputedStyle(el);
      if (s.overflow === 'visible' && s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      if (s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none') continue;
      if (el.closest('[aria-hidden="true"], .sr-only, .visually-hidden, .proto')) continue;
      if (el.scrollHeight > el.clientHeight + 2 && s.overflowY === 'hidden') out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${el.textContent!.trim().slice(0, 30)}" taller than its box`);
    }
    return out.slice(0, 8);
  }, scope);
}
