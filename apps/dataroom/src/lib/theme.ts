// SPDX-License-Identifier: AGPL-3.0-only
export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_KEY = 'vdrkit-theme';

export const THEME_CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Match my computer' },
];

export function themeChoiceLabel(choice: ThemeChoice): string {
  return THEME_CHOICES.find((c) => c.value === choice)!.label;
}

// Must match THEME_BOOT_SCRIPT_HASH in the CSP.
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;
