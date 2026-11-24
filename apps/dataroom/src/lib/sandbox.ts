// SPDX-License-Identifier: AGPL-3.0-only
// needs VDRKIT_SANDBOX=1 here and the API's agreement
import { apiInternalUrl } from '@/api/server';

export interface SandboxPerson {
  key: string;
  name: string;
  company: string;
  jobTitle: string;
  group: string;
  groupLabel: string;
  can: string;
}

export interface SandboxInfo {
  sandbox: true;
  resetTime: string;
  nextResetAt: string;
  roomName: string;
  limits: { maxFileBytes: number; uploadsPerVisitorPerDay: number };
  people: SandboxPerson[];
}

export const sandboxFlag = () => process.env.VDRKIT_SANDBOX === '1';

let cached: { until: number; value: SandboxInfo | null } | null = null;

export async function sandboxInfo(): Promise<SandboxInfo | null> {
  if (!sandboxFlag()) return null;
  if (cached && cached.until > Date.now()) return cached.value;
  let value: SandboxInfo | null = null;
  try {
    const res = await fetch(`${apiInternalUrl()}/v1/sandbox`, { cache: 'no-store', headers: { 'x-vdrkit-render': 'server' } });
    const body = res.ok ? (await res.json()) as Partial<SandboxInfo> : null;
    value = body?.sandbox === true && Array.isArray(body.people) ? body as SandboxInfo : null;
  } catch {
    return null;
  }
  cached = { until: Date.now() + 60_000, value };
  return value;
}
