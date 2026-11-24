// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { LOGGER, redactedUrl, refusePlaceholders, trustProxyFrom } from '../src/startup.js';

describe('start-up checks', () => {
  it('refuses CHANGE_ME passwords without printing them', () => {
    for (const name of ['DATABASE_URL', 'QUEUE_DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
      for (const password of ['CHANGE_ME', 'CHANGE_ME_s3cr3t', 'CHANGE%5FME']) {
        const env = { [name]: `postgres://vdrkit_app:${password}@postgres:5432/vdrkit` };
        expect(() => refusePlaceholders(env)).toThrow(`The password in ${name} is still the CHANGE_ME placeholder`);
        try { refusePlaceholders(env); } catch (err) { expect(String(err)).not.toMatch(/s3cr3t|vdrkit_app|postgres:/); }
      }
    }
  });

  it('refuses placeholder secrets', () => {
    expect(() => refusePlaceholders({ BETTER_AUTH_SECRET: 'CHANGE_ME_to_at_least_32_random_characters' })).toThrow('BETTER_AUTH_SECRET is still the CHANGE_ME placeholder');
    expect(() => refusePlaceholders({ VDRKIT_MASTER_KEY: 'CHANGE_ME' })).toThrow('VDRKIT_MASTER_KEY is still the CHANGE_ME placeholder');
  });

  it('accepts real values', () => {
    expect(() => refusePlaceholders({
      DATABASE_URL: 'postgres://vdrkit_app:9f2c4e1a@postgres:5432/vdrkit', QUEUE_DATABASE_URL: 'postgres://vdrkit_queue@host/vdrkit',
      MIGRATION_DATABASE_URL: 'not a url', BETTER_AUTH_SECRET: 'x'.repeat(40), VDRKIT_MASTER_KEY: 'q6bXz2F0VZb0kE9cX2l1m0bq0Yw1m6kq3n3n0Qy7m0Y=',
    })).not.toThrow();
    expect(() => refusePlaceholders({})).not.toThrow();
  });

  it('trusts private networks when TRUST_PROXY is blank', () => {
    for (const value of [undefined, '', '   ']) expect(trustProxyFrom({ TRUST_PROXY: value })).toBe('loopback, linklocal, uniquelocal');
    expect(trustProxyFrom({ TRUST_PROXY: ' 10.1.0.0/16 ' })).toBe('10.1.0.0/16');
  });

  it('keeps live tokens out of the request log', () => {
    const token = `${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}.${'x'.repeat(43)}`;
    expect(redactedUrl(`/v1/public/invitations/${token}`)).toBe('/v1/public/invitations/[redacted]');
    expect(redactedUrl(`/v1/public/email-change/${token}?x=1`)).toBe('/v1/public/email-change/[redacted]?x=1');
    expect(redactedUrl(`/v1/public/email-change/approval/${token}`)).toBe('/v1/public/email-change/approval/[redacted]');
    expect(redactedUrl(`/v1/auth/magic-link/verify?token=${token}&callbackURL=%2F`)).toBe('/v1/auth/magic-link/verify?token=[redacted]&callbackURL=%2F');
    for (const url of ['/v1/public/invitations/accept', '/v1/public/email-change/confirm', '/v1/workspaces/abc/nodes?q=token']) expect(redactedUrl(url)).toBe(url);
    const logged = LOGGER.serializers.req({ method: 'GET', url: `/v1/public/invitations/${token}`, headers: {}, host: 'api', ip: '10.0.0.1', socket: { remotePort: 5 } } as never);
    expect(logged).toEqual({ method: 'GET', url: '/v1/public/invitations/[redacted]', version: undefined, host: 'api', remoteAddress: '10.0.0.1', remotePort: 5 });
    expect(JSON.stringify(logged)).not.toContain('xxxx');
  });
});

