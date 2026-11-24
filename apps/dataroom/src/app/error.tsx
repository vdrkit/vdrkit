// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { referenceFrom, SomethingWrong, useRoomContact } from '@/components/errors/live';
import { OutsideFrame } from '@/components/outside/OutsideFrame';
import { useBranding } from '@/components/outside/useBranding';

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const branding = useBranding();
  const contact = useRoomContact(branding.name);
  return (
    <OutsideFrame branding={branding}>
      <SomethingWrong reference={referenceFrom(error)} onRetry={retry} contact={contact} />
    </OutsideFrame>
  );
}
