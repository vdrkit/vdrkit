// SPDX-License-Identifier: AGPL-3.0-only
import { connect } from 'node:net';
import type { Readable } from 'node:stream';
import { ServiceUnavailable, type Step } from './pipeline.js';

export type ScanResult = { status: 'clean' } | { status: 'infected'; signature: string } | { status: 'too_large' };

export const DEFAULT_SCAN_MAX_BYTES = 1024 * 1024 * 1024;

export class ClamAvClient {
  // maxBytes <= clamd StreamMaxLength (else it drops the connection) and <= MaxFileSize (else OK unscanned)
  // timeoutMs is idle time; clamd says nothing until the scan ends
  constructor(readonly host: string, readonly port = 3310, private readonly timeoutMs = 600_000, readonly maxBytes = DEFAULT_SCAN_MAX_BYTES) {}

  scan(body: Readable): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      let reply = '';
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const unavailable = (why: string) => done(() => {
        body.destroy();
        socket.destroy();
        reject(new ServiceUnavailable(`The virus scanner is not reachable (${why}). The file is scanned when it is back.`));
      });
      socket.setTimeout(this.timeoutMs, () => unavailable('no answer'));
      socket.on('error', (e: NodeJS.ErrnoException) => (reply ? finish() : unavailable(e.code ?? 'connection failed')));
      socket.on('data', (d: Buffer) => {
        reply += d.toString('utf8');
        if (reply.includes('\0')) finish();
      });
      socket.on('end', finish);
      function finish() {
        const text = reply.replace(/\0[\s\S]*$/, '').trim();
        done(() => {
          body.destroy();
          socket.destroy();
          if (/^stream: OK$/.test(text)) return resolve({ status: 'clean' });
          const found = /^stream: (.+) FOUND$/.exec(text);
          if (found) return resolve({ status: 'infected', signature: found[1]! });
          if (/size limit exceeded/i.test(text)) return resolve({ status: 'too_large' });
          reject(new ServiceUnavailable(`The virus scanner gave an unexpected answer: ${text.slice(0, 200) || 'none'}`));
        });
      }
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- settles the scan itself
      socket.on('connect', async () => {
        try {
          socket.write('zINSTREAM\0');
          for await (const chunk of body) {
            const c = chunk as Buffer;
            for (let i = 0; i < c.length; i += 65_536) {
              const piece = c.subarray(i, i + 65_536);
              const len = Buffer.alloc(4);
              len.writeUInt32BE(piece.length, 0);
              if (settled) return;
              const flushed = socket.write(Buffer.concat([len, piece]));
              if (!flushed) await new Promise((r) => socket.once('drain', r));
            }
          }
          if (!settled) socket.write(Buffer.alloc(4));
        } catch (e) {
          if (!settled) unavailable((e as Error).message);
        }
      });
    });
  }
}

export function virusScanStep(clamav: ClamAvClient | null | undefined): Step {
  return {
    name: 'virus',
    appliesTo: () => true,
    async run(ctx) {
      if (!clamav) {
        ctx.facts.virusScan = 'not_configured';
        return;
      }
      const size = typeof ctx.facts.size === 'number' ? ctx.facts.size : await ctx.storedSize();
      if (size != null && size > clamav.maxBytes) {
        ctx.facts.virusScan = 'too_large';
        ctx.facts.virusScanLimit = clamav.maxBytes;
        return;
      }
      const r = await clamav.scan(await ctx.openOriginal());
      if (r.status === 'infected') {
        ctx.facts.virusScan = 'infected';
        ctx.facts.virusSignature = r.signature;
        throw new Error(`The virus scanner found ${r.signature} in this file. It is locked: nobody can open or download it. Remove it and upload a clean copy.`);
      }
      ctx.facts.virusScan = r.status;
      if (r.status === 'too_large') ctx.facts.virusScanLimit = clamav.maxBytes;
    },
  };
}

export function clamAvFromEnv(env: Record<string, string | undefined> = process.env): ClamAvClient | null {
  const host = env.CLAMAV_HOST?.trim();
  if (!host) return null;
  const port = Number(env.CLAMAV_PORT ?? 3310);
  let maxBytes: number | undefined;
  const max = Number(env.CLAMAV_MAX_BYTES);
  if (Number.isSafeInteger(max) && max > 0) maxBytes = max;
  return new ClamAvClient(host, port, undefined, maxBytes);
}
