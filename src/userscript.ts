import { readSnapshot, sortPanel } from './youtube.ts';

const HOST_TAG = 'yt-up-next-duration-sort';
let running: AbortController | null = null;

function mount(panel: HTMLElement): void {
  if (panel.querySelector(HOST_TAG)) return;
  const host = document.createElement(HOST_TAG);
  const root = host.attachShadow({ mode: 'open' });
  // YouTube enforces Trusted Types in page context. Build DOM nodes rather than
  // assigning HTML strings, which would throw before the control is attached.
  const style = document.createElement('style');
  style.textContent = `
    :host { display: block; padding: 4px 8px; color: var(--yt-spec-text-secondary, #aaa); font: 11px/1.4 system-ui, sans-serif; }
    button { border: 1px solid var(--yt-spec-10-percent-layer, #555); border-radius: 4px; padding: 3px 7px; background: transparent; color: inherit; font: 400 11px/16px system-ui, sans-serif; cursor: pointer; }
    button:hover { background: var(--yt-spec-badge-chip-background, #333); color: var(--yt-spec-text-primary, #eee); }
    button:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
    .notice { margin: 4px 0 0; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Duration ↑';
  button.setAttribute('aria-label', 'Sort upcoming videos by duration, shortest first');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.className = 'sr-only';
  root.append(style, button, status);
  const report = (message: string, attention = false): void => {
    status.textContent = message;
    status.className = attention ? 'notice' : 'sr-only';
  };

  function describe(): void {
    try {
      const snapshot = readSnapshot(panel);
      const upcoming = snapshot.items.length - snapshot.currentIndex - 1;
      const unknown = snapshot.items.slice(snapshot.currentIndex + 1).filter(item => item.duration === null).length;
      const scope = snapshot.total !== null && snapshot.total > snapshot.items.length
        ? `Loaded ${snapshot.items.length} of ${snapshot.total}; unloaded items stay outside this sort.`
        : `${upcoming} upcoming loaded videos.`;
      button.title = `Sort shortest to longest; keep the current video fixed. ${scope} ${unknown ? `${unknown} live/unknown durations go last. ` : ''}${snapshot.playlistId.startsWith('TLPQ') ? '' : 'Native playlist moves can also change the saved playlist order.'}`.trim();
    } catch (error) {
      button.title = error instanceof Error ? error.message : String(error);
    }
  }
  button.addEventListener('click', async event => {
    event.stopPropagation();
    if (button.dataset.running === 'true') { running?.abort(); return; }
    if (running) { report('Another queue sort is running.', true); return; }
    const abort = new AbortController();
    running = abort;
    button.dataset.running = 'true';
    button.textContent = 'Stop';
    button.title = 'Stop sorting';
    button.setAttribute('aria-label', 'Stop sorting');
    report('Reading upcoming durations…');
    try {
      const snapshot = readSnapshot(panel);
      if (snapshot.items.length - snapshot.currentIndex - 1 < 2) {
        report('Load at least two upcoming videos to sort.', true);
      } else if (snapshot.items.slice(snapshot.currentIndex + 1).every(item => item.duration === null)) {
        report('No durations are available yet. Wait for the thumbnails and try again.', true);
      } else {
        const moves = await sortPanel(panel, abort.signal, report);
        report(moves ? `Sorted loaded upcoming videos, shortest first (${moves} native moves).` : 'Upcoming videos are already shortest first.');
      }
    } catch (error) {
      report(abort.signal.aborted ? 'Stopped. Completed native moves remain applied.' :
        error instanceof Error ? error.message : String(error), !abort.signal.aborted);
      if (!abort.signal.aborted) console.warn('[YouTube Up Next Sort]', error);
    } finally {
      running = null;
      delete button.dataset.running;
      button.textContent = 'Duration ↑';
      button.setAttribute('aria-label', 'Sort upcoming videos by duration, shortest first');
      describe();
    }
  });
  panel.prepend(host); // Outside #items: native drop computes indices from childNodes.
  describe();
  panel.addEventListener('yt-rendererstamper-finished', () => { if (!running) describe(); });
}

let scheduled = false;
function scan(): void {
  scheduled = false;
  document.querySelectorAll<HTMLElement>('ytd-playlist-panel-renderer').forEach(mount);
}
const observer = new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(scan, 250);
});
observer.observe(document.body, { childList: true, subtree: true });
document.addEventListener('yt-navigate-start', () => running?.abort());
document.addEventListener('yt-navigate-finish', scan);
scan();
