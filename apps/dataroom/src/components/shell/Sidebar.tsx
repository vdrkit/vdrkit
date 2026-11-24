// SPDX-License-Identifier: AGPL-3.0-only
import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { AccountMenu, type AccountMenuItem } from './AccountMenu';
import { Avatar } from './Avatar';
import { Icon } from './icons';
import type { Instance, NavEntry, ShellPerson, ShellRoom } from './types';

export function Sidebar({
  instance,
  room,
  nav,
  navLabel,
  documentIndex,
  person,
  accountMenu,
  onRoomSwitch,
}: {
  instance: Instance;
  room?: ShellRoom;
  nav: NavEntry[];
  navLabel: string;
  documentIndex?: ReactNode;
  person: ShellPerson;
  accountMenu: AccountMenuItem[];
  onRoomSwitch?: () => void;
}) {
  return (
    <aside className="side" id="room-menu">
      <Link className="org" href={instance.homeHref} aria-label={`${instance.name}, home: my rooms`} title={`${instance.name} · logo set in instance settings`}>
        {instance.logo}
      </Link>
      {room && (
        <div className="room">
          {room.logo ?? <div className="room-logo">{room.initials}</div>}
          <div><b>{room.name}</b><span>{room.subtitle}</span></div>
          {room.canSwitch && <button type="button" className="sw" onClick={onRoomSwitch} title="Go to My rooms to open another room">Switch</button>}
        </div>
      )}
      <nav className="nav" aria-label={navLabel}>
        {nav.map((n) => {
          if ('section' in n) return <div key={`sec-${n.section}`} className="sec">{n.section}</div>;
          return (
            <Fragment key={n.key}>
              <Link href={n.href} className={n.current ? 'on' : undefined} aria-current={n.current ? 'page' : undefined} data-nav={n.key}>
                <Icon name={n.icon} />
                {n.label}
                {n.attention && <span className="cnt" title={n.attention.title}>{n.attention.value}</span>}
                {n.count && <em>{n.count}</em>}
              </Link>
              {n.key === 'docs' && documentIndex}
            </Fragment>
          );
        })}
      </nav>
      <div className="user">
        {/* avatar and name open the profile */}
        {person.profileHref ? (
          <Link className="me" href={person.profileHref} title="Opens your profile and email settings">
            <Avatar name={person.name} colourKey={person.avatarKey} />
            <span className="who"><b>{person.name}</b><span>{person.role}</span></span>
          </Link>
        ) : (
          <>
            <Avatar name={person.name} colourKey={person.avatarKey} />
            <div className="who"><b>{person.name}</b><span>{person.role}</span></div>
          </>
        )}
        <AccountMenu items={accountMenu} />
      </div>
      <div className="powered"><i></i>
        <a href="https://vdrkit.com" target="_blank" rel="noopener noreferrer" aria-label="Powered by VDRkit (opens vdrkit.com in a new tab)">
          Powered by <b>VDRkit</b>
        </a>
      </div>
    </aside>
  );
}
