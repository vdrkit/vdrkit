// SPDX-License-Identifier: AGPL-3.0-only
import type { Channel } from '@vdrkit/core';

// records everything as not sent
export const sandboxMailer: Channel & { verify(): Promise<void> } = {
  name: 'email',
  send: async () => ({ status: 'failed', error: 'The sandbox sends no email' }),
  verify: async () => { throw new Error('The sandbox sends no email'); },
};
