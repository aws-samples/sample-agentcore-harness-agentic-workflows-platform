/** Small shared formatting helpers for the UI. */

export function formatDateTime(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function timeAgo(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime();
  if (deltaMs < 0) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function durationBetween(startIso?: string, endIso?: string): string {
  if (!startIso || !endIso) return '—';
  const seconds = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatCount(value?: number): string {
  return (value ?? 0).toLocaleString();
}
