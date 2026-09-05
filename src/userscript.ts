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
    :host { display: block; color: var(--yt-spec-text-primary, #eee); font: 13px/1.45 system-ui, sans-serif; }
    .box { padding: 10px 12px; background: var(--yt-spec-badge-chip-background, #272727); border-radius: 10px; margin: 6px 0; }
    button { border: 0; border-radius: 18px; padding: 8px 14px; background: #3ea6ff; color: #101010; font: 600 13px system-ui, sans-serif; cursor: pointer; }
    button:disabled { opacity: .55; cursor: wait; }
    button:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
    p { margin: 6px 0 0; } .detail { opacity: .8; font-size: 12px; }
  `;
  const box = document.createElement('div');
  box.className = 'box';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Shortest → longest';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Sort loaded upcoming videos; keep the current video playing.';
  const detail = document.createElement('p');
  detail.className = 'detail';
  box.append(button, status, detail);
  root.append(style, box);
  const report = (message: string): void => { status.textContent = message; };

  function describe(): void {
    try {
      const snapshot = readSnapshot(panel);
      const upcoming = snapshot.items.length - snapshot.currentIndex - 1;
      const unknown = snapshot.items.slice(snapshot.currentIndex + 1).filter(item => item.duration === null).length;
      const scope = snapshot.total !== null && snapshot.total > snapshot.items.length
        ? `Loaded ${snapshot.items.length} of ${snapshot.total}; unloaded items stay outside this sort.`
        : `${upcoming} upcoming loaded videos.`;
      detail.textContent = `${scope} ${unknown ? `${unknown} live/unknown durations go last. ` : ''}${snapshot.playlistId.startsWith('TLPQ') ? 'Uses native queue moves.' : 'Native playlist moves can also change the saved playlist order.'}`;
    } catch (error) {
      detail.textContent = error instanceof Error ? error.message : String(error);
    }
  }
  button.addEventListener('click', async event => {
    event.stopPropagation();
    if (button.dataset.running === 'true') { running?.abort(); return; }
    if (running) { report('Another queue sort is running.'); return; }
    const abort = new AbortController();
    running = abort;
    button.dataset.running = 'true';
    button.textContent = 'Stop sorting';
    describe();
    report('Reading upcoming durations…');
    try {
      const snapshot = readSnapshot(panel);
      if (snapshot.items.length - snapshot.currentIndex - 1 < 2) {
        report('Load at least two upcoming videos to sort.');
      } else if (snapshot.items.slice(snapshot.currentIndex + 1).every(item => item.duration === null)) {
        report('No durations are available yet. Wait for the thumbnails and try again.');
      } else {
        const moves = await sortPanel(panel, abort.signal, report);
        report(moves ? `Sorted loaded upcoming videos, shortest first (${moves} native moves).` : 'Upcoming videos are already shortest first.');
      }
    } catch (error) {
      report(abort.signal.aborted ? 'Stopped. Completed native moves remain applied.' :
        error instanceof Error ? error.message : String(error));
      if (!abort.signal.aborted) console.warn('[YouTube Up Next Sort]', error);
    } finally {
      running = null;
      delete button.dataset.running;
      button.textContent = 'Shortest → longest';
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
