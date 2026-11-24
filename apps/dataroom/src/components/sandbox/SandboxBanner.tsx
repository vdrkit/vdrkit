// SPDX-License-Identifier: AGPL-3.0-only
import { sandboxInfo } from '@/lib/sandbox';

// fixed height (--sandbox-h) so sticky bits can offset without JS
export async function SandboxBanner() {
  const info = await sandboxInfo();
  if (!info) return null;
  return (
    <div className="sbx-bar" role="region" aria-label="Sandbox">
      <b className="sbx-tag">Sandbox</b>
      <span className="sbx-text sbx-long">
        Invented data, shared with every visitor and wiped daily at {info.resetTime}. Do not upload confidential or personal files.
      </span>
      <span className="sbx-text sbx-short" aria-hidden="true">Wiped daily at {info.resetTime}</span>
      <a className="sbx-switch" href="/try">Switch person</a>
    </div>
  );
}
