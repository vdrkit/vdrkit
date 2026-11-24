// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from 'next/navigation';

export default async function Room({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  redirect(`/rooms/${ws}/dashboard`);
}
