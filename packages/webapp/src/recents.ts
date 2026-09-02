/**
 * Recently viewed workflows/runs, surfaced in the side navigation (sidebar
 * Recents rail). Purely client-side: localStorage with cross-tab sync via
 * the storage event.
 */
import { useEffect, useState } from 'react';

export interface RecentEntry {
  kind: 'workflow' | 'run';
  id: string;
  name: string;
  href: string;
  at: number;
}

const KEY = 'agentic.recents';
const EVENT = 'agentic:recents-changed';
const MAX_ENTRIES = 6;

function read(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordVisit(entry: Omit<RecentEntry, 'at'>): void {
  const next = [
    { ...entry, at: Date.now() },
    ...read().filter((existing) => existing.href !== entry.href),
  ].slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return;
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useRecents(): RecentEntry[] {
  const [recents, setRecents] = useState<RecentEntry[]>(read);
  useEffect(() => {
    const refresh = () => setRecents(read());
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return recents;
}

/** Record a visit once the entity's display name is known. */
export function useRecordVisit(entry: Omit<RecentEntry, 'at'> | null): void {
  const kind = entry?.kind;
  const id = entry?.id;
  const name = entry?.name;
  const href = entry?.href;
  useEffect(() => {
    if (kind && id && name && href) {
      recordVisit({ kind, id, name, href });
    }
  }, [kind, id, name, href]);
}
