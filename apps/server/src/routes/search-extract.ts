// SPDX-License-Identifier: AGPL-3.0-only

export const EXTRACT_MAX = 220;

export function queryTerms(raw: string): { terms: string[]; lastIsPrefix: boolean } {
  const terms: string[] = [];
  let lastIsPrefix = false;
  for (const m of raw.matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
    const phrase = m[2];
    const t = (phrase ?? m[4] ?? '').replace(/"/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!t || t === 'or' || m[1] || m[3]) continue;
    terms.push(t);
    lastIsPrefix = phrase === undefined;
  }
  return { terms, lastIsPrefix };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function termRe(t: string, prefix: boolean): RegExp {
  const words = t.split(' ').map(escapeRe).join('[^\\p{L}\\p{N}]+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${words}${prefix ? '' : '(?![\\p{L}\\p{N}])'}`, 'giu');
}

function test(re: RegExp, s: string): boolean {
  re.lastIndex = 0;
  return re.test(s);
}

// PDF text wraps mid-sentence. Don't join after short lines (headings, cells) or before a numbered clause
export function sentences(body: string): string[] {
  const lines = body.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const blocks: string[] = [];
  let cur = '';
  lines.forEach((line, i) => {
    cur = cur ? `${cur} ${line}` : line;
    const next = lines[i + 1];
    if (!next || line.length < 40 || /[.!?:;]["”)]?$/.test(line) || /^\d+(\.\d+)*\.?\s/.test(next)) {
      blocks.push(cur);
      cur = '';
    }
  });
  return blocks
    // not after a clause number: "6. CHANGE OF CONTROL"
    .flatMap((b) => b.split(/(?<!(?:^|\s)\d+(?:\.\d+)*\.)(?<=[.!?]["”)]?)\s+(?=["“(]?[\p{Lu}\p{N}])/u))
    .map((x) => x.trim())
    .filter(Boolean);
}

export function pageExtract(body: string, raw: string): { snippet: string; highlights: [number, number][] } | null {
  const { terms, lastIsPrefix } = queryTerms(raw);
  if (!terms.length) return null;
  const pats = terms.map((t, i) => termRe(t, lastIsPrefix && i === terms.length - 1));
  const whole = terms.length > 1 ? termRe(terms.join(' '), lastIsPrefix) : null;

  let best: { text: string; score: number } | null = null;
  for (const text of sentences(body)) {
    const found = pats.filter((re) => test(re, text)).length;
    if (!found) continue;
    const sentence = /[.!?]["”)]?$/.test(text) && text.split(' ').length >= 6;
    const capitals = !/\p{Ll}/u.test(text);
    let score = found * 10;
    if (whole && test(whole, text)) score += 5;
    if (sentence) score += 6;
    if (capitals) score -= 8;
    if (!best || score > best.score) best = { text, score };
  }
  if (!best) return null;

  const marksIn = (s: string): [number, number][] => {
    const list = whole && test(whole, s) ? [whole] : pats.filter((_, i) => terms[i]!.length > 2);
    const out: [number, number][] = [];
    for (const re of list) {
      re.lastIndex = 0;
      for (let m = re.exec(s); m; m = re.exec(s)) {
        if (m[0].length) out.push([m.index, m.index + m[0].length]);
        else re.lastIndex++;
      }
    }
    out.sort((a, b) => a[0] - b[0]);
    return out.filter((r, i) => i === 0 || r[0] >= out[i - 1]![1]);
  };

  let text = best.text;
  if (text.length > EXTRACT_MAX) {
    const first = marksIn(text)[0]?.[0] ?? 0;
    let start = Math.max(0, first - Math.floor(EXTRACT_MAX / 3));
    if (start > 0) {
      const sp = text.indexOf(' ', start);
      if (sp >= 0 && sp < first) start = sp + 1;
    }
    let end = Math.min(text.length, start + EXTRACT_MAX);
    if (end < text.length) {
      const sp = text.lastIndexOf(' ', end);
      if (sp > first) end = sp;
    }
    const cut = text.slice(start, end).trim();
    const before = start > 0 ? '… ' : '';
    const after = end < text.length ? ' …' : '';
    text = before + cut + after;
  }
  return { snippet: text, highlights: marksIn(text) };
}
