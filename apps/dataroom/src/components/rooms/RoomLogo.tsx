// SPDX-License-Identifier: AGPL-3.0-only
import { apiUrl } from '@/api/browser';

export interface RoomLogos {
  light: boolean;
  dark: boolean;
  version?: string | null;
}

// both rendered, CSS picks by theme
export function RoomLogo({ roomId, initials, logos, className }: { roomId: string; initials: string; logos: RoomLogos; className: string }) {
  if (!logos.light && !logos.dark) return <span className={className}>{initials}</span>;
  const v = logos.version ? `?v=${encodeURIComponent(logos.version)}` : '';
  const light = apiUrl(`/v1/workspaces/${roomId}/logo/${logos.light ? 'light' : 'dark'}${v}`);
  const dark = apiUrl(`/v1/workspaces/${roomId}/logo/${logos.dark ? 'dark' : 'light'}${v}`);
  return (
    <span className={`${className} img`}>
      <img className="lg-light" src={light} alt="" />
      <img className="lg-dark" src={dark} alt="" />
    </span>
  );
}
