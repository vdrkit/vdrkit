// SPDX-License-Identifier: AGPL-3.0-only
// ids come from stableId() in the demo seed
export const DEV_TENANT_ID = 'de300000-0000-4000-8000-000000000001';
export const DEV_ROOM_ID = 'b90253f5-0a8f-4005-9a3a-2a3d26bbf53e';
export const PERSONA_COOKIE = 'vdrkit-dev-persona';

export interface Persona {
  key: string;
  id: string;
  name: string;
  label: string;
}

export const PERSONAS: Persona[] = [
  { key: 'anika', id: 'a369f772-bdd8-4e7f-a614-11dc069feb12', name: 'Anika Pillay', label: 'Room admin' },
  { key: 'maria', id: 'cafbc60e-812a-40ba-b97d-b8ab0353be2e', name: 'Maria Botha', label: 'Contributor' },
  { key: 'johan', id: 'ed2c82c4-0f00-46ed-86e8-9ff2cdabf611', name: 'Johan Steyn', label: 'Publisher, 3 Finance' },
  { key: 'jan', id: '49ef5130-7c1a-459b-82c1-711e02ebe85e', name: 'Jan de Vries', label: 'Bidder A lead' },
  { key: 'pieter', id: 'e7d2d901-f71b-45d8-a12a-978d4fc8a0ee', name: 'Pieter Nel', label: 'Bidder A member' },
  { key: 'lars', id: 'c78f0956-066e-4f08-bcb8-d8b17dd90ec6', name: 'Lars Eriksen', label: 'Bidder C financier' },
  { key: 'liesl', id: 'e4b89b9a-3822-4872-8c44-b217917d09ff', name: 'Liesl van Wyk', label: 'Seller observer' },
  { key: 'thabo', id: 'b5239a6c-41b9-481f-8d35-df33ad285a49', name: 'Thabo Molefe', label: 'Site admin' },
];

export const DEFAULT_PERSONA = PERSONAS[0]!;

export function personaFrom(value: string | undefined | null): Persona {
  return PERSONAS.find((p) => p.key === value || p.id === value) ?? DEFAULT_PERSONA;
}
