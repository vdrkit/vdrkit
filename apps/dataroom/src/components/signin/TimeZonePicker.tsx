// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { utcOffsetMinutes, zoneAbbreviation, zoneCity } from '@/lib/time';

const MOST_USED = [
  'Africa/Johannesburg', 'Europe/London', 'Europe/Amsterdam', 'Europe/Berlin', 'Europe/Paris', 'Europe/Zurich', 'America/New_York',
  'Asia/Dubai', 'Asia/Singapore', 'Asia/Hong_Kong', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney', 'Asia/Tokyo', 'UTC',
];

const COUNTRY: Record<string, string> = {
  'Africa/Johannesburg': 'South Africa', 'Africa/Windhoek': 'Namibia', 'Africa/Gaborone': 'Botswana', 'Africa/Harare': 'Zimbabwe',
  'Africa/Maputo': 'Mozambique', 'Africa/Lusaka': 'Zambia', 'Africa/Nairobi': 'Kenya', 'Africa/Lagos': 'Nigeria', 'Africa/Cairo': 'Egypt',
  'Africa/Casablanca': 'Morocco', 'Africa/Accra': 'Ghana', 'Europe/London': 'United Kingdom', 'Europe/Dublin': 'Ireland',
  'Europe/Amsterdam': 'Netherlands', 'Europe/Brussels': 'Belgium', 'Europe/Luxembourg': 'Luxembourg', 'Europe/Paris': 'France',
  'Europe/Berlin': 'Germany', 'Europe/Zurich': 'Switzerland', 'Europe/Vienna': 'Austria', 'Europe/Madrid': 'Spain', 'Europe/Lisbon': 'Portugal',
  'Europe/Rome': 'Italy', 'Europe/Stockholm': 'Sweden', 'Europe/Oslo': 'Norway', 'Europe/Copenhagen': 'Denmark', 'Europe/Helsinki': 'Finland',
  'Europe/Warsaw': 'Poland', 'Europe/Prague': 'Czechia', 'Europe/Athens': 'Greece', 'Europe/Istanbul': 'Turkey', 'Europe/Moscow': 'Russia',
  'America/New_York': 'United States', 'America/Chicago': 'United States', 'America/Denver': 'United States', 'America/Los_Angeles': 'United States',
  'America/Toronto': 'Canada', 'America/Vancouver': 'Canada', 'America/Sao_Paulo': 'Brazil', 'America/Mexico_City': 'Mexico',
  'Asia/Dubai': 'United Arab Emirates', 'Asia/Riyadh': 'Saudi Arabia', 'Asia/Qatar': 'Qatar', 'Asia/Kolkata': 'India', 'Asia/Singapore': 'Singapore',
  'Asia/Hong_Kong': 'Hong Kong', 'Asia/Shanghai': 'China', 'Asia/Tokyo': 'Japan', 'Asia/Seoul': 'South Korea', 'Australia/Sydney': 'Australia',
  'Australia/Perth': 'Australia', 'Pacific/Auckland': 'New Zealand', 'Indian/Mauritius': 'Mauritius', 'Asia/Jerusalem': 'Israel',
};

// Chromium uses old names (Asia/Calcutta); show the current city, store the browser's id
const CITY_NOW: Record<string, string> = {
  'Asia/Calcutta': 'Kolkata', 'Asia/Saigon': 'Ho Chi Minh City', 'Europe/Kiev': 'Kyiv', 'Asia/Katmandu': 'Kathmandu', 'Asia/Rangoon': 'Yangon',
};
const COUNTRY_OLD: Record<string, string> = { 'Asia/Calcutta': 'India', 'Asia/Saigon': 'Vietnam', 'Europe/Kiev': 'Ukraine', 'Asia/Katmandu': 'Nepal', 'Asia/Rangoon': 'Myanmar' };

const cityOf = (id: string) => CITY_NOW[id] ?? zoneCity(id);
const countryOf = (id: string): string | undefined => COUNTRY[id] ?? COUNTRY_OLD[id];

export interface ZoneOption { id: string; city: string; label: string; offset: number; search: string }

function offsetText(m: number): string {
  const sign = m < 0 ? '-' : '+';
  const a = Math.abs(m);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
}

export function zoneOption(id: string, at = new Date()): ZoneOption {
  const city = id === 'UTC' ? 'UTC' : cityOf(id);
  const abbr = zoneAbbreviation(at, id);
  const offset = utcOffsetMinutes(at, id);
  const utc = offsetText(offset);
  const showAbbr = abbr !== utc.replace('UTC', 'GMT') && abbr !== city;
  const label = `${city}, ${showAbbr ? `${abbr}, ` : ''}${utc}`;
  const search = `${id} ${city} ${abbr} ${countryOf(id) ?? ''}`.toLowerCase().replace(/_/g, ' ');
  return { id, city, label, offset, search };
}

function allZones(own: string | null): ZoneOption[] {
  const ids: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? MOST_USED;
  const first = [...new Set(own ? [own, ...MOST_USED] : MOST_USED)].filter((z) => z === 'UTC' || ids.includes(z));
  const rest = ids.filter((z) => !first.includes(z)).sort((a, b) => cityOf(a).localeCompare(cityOf(b)));
  return [...first, ...rest].map((z) => zoneOption(z));
}

export function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

export function TimeZonePicker({ value, onChange, id }: { value: string; onChange: (tz: string) => void; id?: string }) {
  const zones = useMemo(() => allZones(browserZone()), []);
  const current = useMemo(() => zones.find((z) => z.id === value) ?? zoneOption(value), [zones, value]);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  const open = query !== null;
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const hits = open ? zones.filter((z) => words.every((w) => z.search.includes(w))).slice(0, 60) : [];

  function choose(z: ZoneOption) {
    onChange(z.id);
    setQuery(null);
    input.current?.blur();
  }

  return (
    <div className="tz">
      <input
        ref={input}
        id={id}
        className="tsel"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        value={open ? query : current.label}
        placeholder="Type a city or country"
        onFocus={() => { setQuery(''); setActive(0); }}
        // close now, or the list covers the next field
        onBlur={() => setQuery(null)}
        aria-activedescendant={open && hits[active] ? `${listId}-${active}` : undefined}
        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter') { e.preventDefault(); const z = hits[active]; if (z) choose(z); }
          if (e.key === 'Escape') { setQuery(null); }
        }}
      />
      {open ? (
        // tabIndex -1: Firefox makes scrolling lists a Tab stop
        <ul className="tz-list" role="listbox" id={listId} tabIndex={-1}>
          {hits.length === 0 ? <li className="none" role="option" aria-selected={false} aria-disabled="true">No time zone matches. Try a city nearby.</li> : hits.map((z, i) => {
            const [city, ...rest] = z.label.split(', ');
            const country = countryOf(z.id);
            return (
              <li key={z.id} id={`${listId}-${i}`} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); choose(z); }} onMouseEnter={() => setActive(i)}>
                {city}<span>{rest.join(', ')}{country ? ` · ${country}` : ''}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
