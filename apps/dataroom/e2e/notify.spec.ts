// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { DEV_TENANT_ID, PERSONAS } from '../src/dev-tools/personas';
import { API, asAdmin, ROOM, type Mail } from './signin-helpers';
import { demoAt, demoIso, LONDON, SAST, timeOf } from './demo-dates';

const ANIKA = PERSONAS.find((p) => p.key === 'anika')!.id;

test.skip(process.env.E2E_PROD === '1', 'The dev mailbox runs against next dev with the API');
const SUBJECT = 'Project Heron: Management presentation, Bidder A due in 2 days';
const MP_A = '2026-12-08T08:00:00Z';
const emailDay = (iso: string, timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  .format(demoAt(iso)).replace(/,/g, '');
const inbox = async (to: string) => (await asAdmin<{ messages: Mail[] }>('GET', `/v1/dev/mailbox?to=${encodeURIComponent(to)}`)).messages;

test('sends deadline reminders only to the group the date is for', async ({ page }) => {
  await asAdmin('POST', '/v1/dev/notifications/run', { job: 'reminders', at: demoIso('2026-12-06T08:00:00Z') });
  // second run sends nothing
  await asAdmin('POST', '/v1/dev/notifications/run', { job: 'reminders', at: demoIso('2026-12-06T08:01:00Z') });

  const jan = (await inbox('jan@bidder-a.example.com')).filter((m) => m.subject === SUBJECT);
  expect(jan).toHaveLength(1);
  expect(jan[0]!.text).toContain(`Due: ${emailDay(MP_A, LONDON)}, ${timeOf(MP_A, LONDON)}\nRoom time: ${timeOf(MP_A, SAST)}, Johannesburg\nFor: Bidder A`);
  expect(jan[0]!.text).toContain('You get this reminder because deadlines are on for Project Heron.');
  expect((await inbox('pieter@bidder-a.example.com')).filter((m) => m.subject === SUBJECT)).toHaveLength(1);
  expect((await inbox('mei@bidder-b.example.com')).filter((m) => /management presentation/i.test(m.subject))).toHaveLength(0);

  await page.setExtraHTTPHeaders({ 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': ANIKA });
  const n = (await inbox('jan@bidder-a.example.com')).findIndex((m) => m.subject === SUBJECT);
  await page.goto(`${API}/v1/dev/mailbox/view?to=${encodeURIComponent('jan@bidder-a.example.com')}&n=${n}`);
  await expect(page.getByRole('heading', { name: 'Management presentation, Bidder A due in 2 days' })).toBeVisible();
  await expect(page.locator('td[align="right"]').first()).toHaveText(/Project Heron\s*Reminder/);
  const button = page.getByRole('link', { name: 'Open the Timeline' });
  await expect(button).toHaveAttribute('href', new RegExp(`/rooms/${ROOM}/timeline$`));
  await expect(page.locator('td[style*="background:#13627A"] a')).toHaveCount(1);
});
