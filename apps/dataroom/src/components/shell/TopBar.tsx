// SPDX-License-Identifier: AGPL-3.0-only
import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { NotificationsButton, SHOW_BELL } from './NotificationsButton';
import { ThemeButton } from './ThemeButton';
import type { Crumb } from './types';

export function TopBar({
  menuButton,
  crumbs,
  search,
  clock,
  unread,
  notificationSettingsHref,
}: {
  menuButton: ReactNode;
  crumbs: Crumb[];
  search?: ReactNode;
  clock?: ReactNode;
  unread: number;
  notificationSettingsHref?: string;
}) {
  return (
    <header className="top">
      {menuButton}
      <div className="crumbs">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Fragment key={`${i}-${c.label}`}>
              {i > 0 && <span className="sep">/</span>}
              {last ? <b>{c.label}</b> : c.href ? <Link href={c.href}>{c.label}</Link> : c.label}
            </Fragment>
          );
        })}
      </div>
      {search ?? <span style={{ flex: 1 }} />}
      {clock}
      <div className="top-r">
        <ThemeButton />
        {SHOW_BELL ? <NotificationsButton unread={unread} settingsHref={notificationSettingsHref} /> : null}
      </div>
    </header>
  );
}
