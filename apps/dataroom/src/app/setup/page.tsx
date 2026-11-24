// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { serverApi } from '@/api/server';
import { SetupFlow } from '@/components/setup/SetupFlow';
import { SetupFrame } from '@/components/setup/SetupFrame';

export const metadata: Metadata = { title: 'Setup' };

export default async function Setup() {
  const api = await serverApi();
  const state = await api.GET('/v1/setup');
  if (state.data?.open) {
    return <SetupFrame version={state.data.version}><SetupFlow /></SetupFrame>;
  }
  if (!state.data) throw new Error(`The API answered ${state.response.status} for the setup state.`);
  const me = await api.GET('/v1/me/workspaces');
  if (me.response.status === 401) redirect('/sign-in');
  notFound();
}
