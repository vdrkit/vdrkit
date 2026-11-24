// SPDX-License-Identifier: AGPL-3.0-only
import { promises as dns } from 'node:dns';

export interface TxtResolver {
  resolveTxt(name: string): Promise<string[][]>;
}

export const systemResolver: TxtResolver = {
  resolveTxt: (name) => {
    const r = new dns.Resolver({ timeout: 5_000, tries: 2 });
    return r.resolveTxt(name);
  },
};

export type RecordStatus = 'pass' | 'missing';

export interface RecordCheck {
  name: string;
  status: RecordStatus;
  record: string | null;
  fix: string | null;
}

export interface DomainCheck {
  domain: string;
  spf: RecordCheck;
  dkim: RecordCheck & { selector: string };
  dmarc: RecordCheck;
}

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function domainOf(address: string): string | null {
  const d = address.split('@').pop()?.trim().toLowerCase() ?? '';
  return DOMAIN.test(d) ? d : null;
}

async function txt(r: TxtResolver, name: string): Promise<string[]> {
  try {
    return (await r.resolveTxt(name)).map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

export async function checkDomain(r: TxtResolver, domain: string, selector: string, reportTo?: string | null): Promise<DomainCheck> {
  const [spfRecs, dkimRecs, dmarcRecs] = await Promise.all([
    txt(r, domain), txt(r, `${selector}._domainkey.${domain}`), txt(r, `_dmarc.${domain}`),
  ]);
  const spf = spfRecs.find((t) => /^v=spf1(\s|$)/i.test(t.trim())) ?? null;
  const dkim = dkimRecs.find((t) => /(^|;)\s*(v=DKIM1|p=)/i.test(t)) ?? null;
  const dmarc = dmarcRecs.find((t) => /^v=DMARC1(\s*;|$)/i.test(t.trim())) ?? null;
  return {
    domain,
    spf: {
      name: domain, status: spf ? 'pass' : 'missing', record: spf,
      fix: spf ? null : `Ask whoever manages ${domain} to add a TXT record that allows your mail server to send for it, for example v=spf1 include:<your mail provider> ~all.`,
    },
    dkim: {
      name: `${selector}._domainkey.${domain}`, selector, status: dkim ? 'pass' : 'missing', record: dkim,
      fix: dkim ? null : `Your mail server or provider gives you a DKIM key. Ask whoever manages ${domain} to publish it as a TXT record at ${selector}._domainkey.${domain}, or change the selector here to the one your provider uses.`,
    },
    dmarc: {
      name: `_dmarc.${domain}`, status: dmarc ? 'pass' : 'missing', record: dmarc,
      fix: dmarc ? null : `Without a DMARC record, some recipients may send invitations to spam. Ask whoever manages ${domain} to add one, for example v=DMARC1; p=none${reportTo ? `; rua=mailto:${reportTo}` : ''}.`,
    },
  };
}
