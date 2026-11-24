// SPDX-License-Identifier: AGPL-3.0-only
import type { Channel } from '@vdrkit/core';

// Never derive this from a real sign-in send: that leaks which addresses exist
export class MailHealth {
  private last: { ok: boolean; at: number } | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly probe: () => Promise<void>,
    private readonly options: { freshMs?: number; timeoutMs?: number; clock?: () => number } = {},
  ) {}

  ok(): boolean {
    const now = (this.options.clock ?? Date.now)();
    const stale = !this.last || now - this.last.at >= (this.options.freshMs ?? 60_000);
    if (!this.running && stale) this.running = this.check();
    return this.last?.ok ?? true;
  }

  async settled(): Promise<void> { await this.running; }

  private async check(): Promise<void> {
    let ok: boolean;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.probe(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The mail server did not answer in time.')), this.options.timeoutMs ?? 20_000);
        timer.unref?.();
      })]);
      ok = true;
    } catch {
      ok = false;
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.last = { ok, at: (this.options.clock ?? Date.now)() };
    this.running = null;
  }
}

export function channelProbe(mailer: Channel | undefined): () => Promise<void> {
  return async () => {
    if (!mailer) throw new Error('No mail channel');
    const verify = (mailer as Channel & { verify?: () => Promise<void> }).verify;
    if (typeof verify === 'function') await verify.call(mailer);
  };
}
