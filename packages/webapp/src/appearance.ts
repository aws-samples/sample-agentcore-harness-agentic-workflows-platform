/**
 * Visual mode (light/dark) and content density preferences, persisted in
 * localStorage and applied through Cloudscape global styles (theme toggle +
 * density toggle).
 */
import { applyDensity, applyMode, Density, Mode } from '@cloudscape-design/global-styles';

const MODE_KEY = 'agentic.appearance.mode';
const DENSITY_KEY = 'agentic.appearance.density';

export function isDarkMode(): boolean {
  try {
    return localStorage.getItem(MODE_KEY) === 'dark';
  } catch {
    return false;
  }
}

export function isCompactDensity(): boolean {
  try {
    return localStorage.getItem(DENSITY_KEY) === 'compact';
  } catch {
    return false;
  }
}

export function setDarkMode(dark: boolean): void {
  try {
    localStorage.setItem(MODE_KEY, dark ? 'dark' : 'light');
  } catch {
    // preference simply won't persist
  }
  applyMode(dark ? Mode.Dark : Mode.Light);
}

export function setCompactDensity(compact: boolean): void {
  try {
    localStorage.setItem(DENSITY_KEY, compact ? 'compact' : 'comfortable');
  } catch {
    // preference simply won't persist
  }
  applyDensity(compact ? Density.Compact : Density.Comfortable);
}

/** Apply persisted preferences on boot (called from main.tsx). */
export function initAppearance(): void {
  applyMode(isDarkMode() ? Mode.Dark : Mode.Light);
  applyDensity(isCompactDensity() ? Density.Compact : Density.Comfortable);
}
