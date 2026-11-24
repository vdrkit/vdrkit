// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from '@vdrkit/core';
import type { Storage } from '../pipeline/pipeline.js';
import { displaySize, logoBytes, type StoredLogo } from '../site/logos.js';
import type { MailBranding } from './layout.js';

const logoCache = new Map<string, Buffer>();
const CACHE_LIMIT = 8;

async function cachedLogo(storage: Storage, logo: StoredLogo): Promise<Buffer | null> {
  const hit = logoCache.get(logo.sha256);
  if (hit) return hit;
  const png = await logoBytes(storage, logo).catch(() => null);
  if (!png) return null;
  if (logoCache.size >= CACHE_LIMIT) {
    const oldest = logoCache.keys().next().value!;
    logoCache.delete(oldest);
  }
  logoCache.set(logo.sha256, png);
  return png;
}

export async function mailBranding(tx: SqlClient, storage: Storage | undefined, publicUrl: string): Promise<MailBranding> {
  return brandingFrom(await brandingRow(tx), storage, publicUrl);
}

export type BrandingRow = { org_name: string | null; logo_light: StoredLogo | null; privacy_url?: string | null; privacy_text?: string | null };

// no storage I/O inside the tx
export async function brandingRow(tx: SqlClient): Promise<BrandingRow | null> {
  return (await tx.query<BrandingRow>(
    `select coalesce(s.org_name, t.name) as org_name, s.logo_light, s.privacy_url, s.privacy_text
       from tenant t left join site_settings s on s.tenant_id = t.id where t.id = current_tenant_id()`)).rows[0] ?? null;
}

export async function brandingFrom(
  r: BrandingRow | null,
  storage: Storage | undefined, publicUrl: string,
): Promise<MailBranding> {
  let logo: MailBranding['logo'] = null;
  if (r?.logo_light && storage) {
    const png = await cachedLogo(storage, r.logo_light);
    if (png) logo = { png, ...displaySize(r.logo_light) };
  }
  // worker may lack PUBLIC_URL
  const base = publicUrl.replace(/\/$/, '');
  const web = (u: string) => /^https?:\/\/[^/\s]/i.test(u);
  let privacyUrl: string | null = null;
  if (r?.privacy_url && web(r.privacy_url)) privacyUrl = r.privacy_url;
  else if (r?.privacy_text && web(base)) privacyUrl = `${base}/privacy`;
  return { orgName: r?.org_name?.trim() || null, logo, privacyUrl };
}

export function siteName(b: MailBranding): string | null {
  return b.orgName ? `${b.orgName} data rooms` : null;
}
