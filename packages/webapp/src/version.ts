/**
 * Detects when the deployed bundle is newer than the one this tab is running.
 *
 * Vite gives the entry script a content hash (assets/index-<hash>.js) and
 * index.html points at it, so "which bundle is live" is just that filename.
 * A single-page app never reloads on its own, so a tab left open across a
 * deploy keeps calling the new API with old client code — which is how a
 * report edit proposal came back fine from the server and rendered nothing.
 */

const ENTRY_PATTERN = /assets\/index-[\w-]+\.js/;

/** Entry bundle this tab is running, or null outside a built deployment. */
export function runningBundle(doc: Document = document): string | null {
  for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>('script[src]'))) {
    const match = ENTRY_PATTERN.exec(script.src);
    if (match) return match[0];
  }
  return null;
}

/** Entry bundle named by an index.html body, or null when there is none. */
export function bundleInHtml(html: string): string | null {
  return ENTRY_PATTERN.exec(html)?.[0] ?? null;
}

/** True when the live index.html points at a different bundle than `running`. */
export async function isBundleStale(running: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl('/index.html', { cache: 'no-store' });
    if (!response.ok) return false;
    const live = bundleInHtml(await response.text());
    return live !== null && live !== running;
  } catch {
    return false;
  }
}

/**
 * Calls `onStale` once when a newer bundle is detected. Checks when the tab
 * regains focus (the common "came back to an old tab" case) and on a slow
 * interval; stops after the first hit. Returns a cleanup function.
 */
export function watchForNewBundle(onStale: () => void, intervalMs = 5 * 60_000): () => void {
  const running = runningBundle();
  if (!running) return () => undefined;
  let done = false;
  const check = async () => {
    if (done || document.visibilityState === 'hidden') return;
    if (await isBundleStale(running)) {
      done = true;
      stop();
      onStale();
    }
  };
  const onVisible = () => void check();
  window.addEventListener('focus', onVisible);
  document.addEventListener('visibilitychange', onVisible);
  const timer = window.setInterval(() => void check(), intervalMs);
  function stop() {
    window.removeEventListener('focus', onVisible);
    document.removeEventListener('visibilitychange', onVisible);
    window.clearInterval(timer);
  }
  return stop;
}
