// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, sizeLimitText } from '../src/routes/upload-sessions.js';
import { MAX_FILE_BYTES, MAX_FILE_TEXT, TOO_LARGE_TEXT, limitText } from '../../dataroom/src/components/documents/limits.js';

describe('upload size limit', () => {
  it('defaults to 5 GB', () => {
    expect(MAX_FILE_BYTES).toBe(MAX_UPLOAD_BYTES);
    expect(MAX_FILE_TEXT).toBe('5 GB');
    for (const b of [MAX_UPLOAD_BYTES, 1024 ** 3, 1.5 * 1024 ** 3, 500 * 1024 ** 2]) expect(limitText(b)).toBe(sizeLimitText(b));
    expect(TOO_LARGE_TEXT).toBe(`Files larger than ${sizeLimitText()} cannot be uploaded. Split the file or compress it.`);
  });
});
