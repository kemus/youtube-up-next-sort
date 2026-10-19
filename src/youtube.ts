import { parseDuration, planMoves, sameOrder, type Item, type Occurrence } from './sort.ts';

type RecordValue = Record<string, unknown>;
type NativeElement = HTMLElement & {
  data?: RecordValue;
  polymerController?: NativeController;
  inst?: NativeController;
  resolveCommand?: (command: RecordValue) => unknown;
};
interface NativeController {
  resolveCommand?: (command: RecordValue) => unknown;
  data?: RecordValue;
  canReorder?: boolean;
  shuffleOn?: boolean;
  ytReorderableController?: { handleDrop?: (event: { currDragItem: HTMLElement }) => void };
}
export type QueueItem = Item & Occurrence;
export interface Snapshot {
  items: QueueItem[];
  entries: RecordValue[];
  currentIndex: number;
  playlistId: string;
  total: number | null;
  container: HTMLElement;
  rows: NativeElement[];
  controller: NativeController;
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : undefined;
}

function controllerOf(element: NativeElement): NativeController {
  return element.polymerController ?? element.inst ?? element as NativeController;
}

function textOf(value: unknown): string {
  const data = record(value);
  if (typeof data?.simpleText === 'string') return data.simpleText;
  return Array.isArray(data?.runs)
    ? data.runs.map(run => record(run)?.text ?? '').join('') : '';
}

function durationOf(data: RecordValue, row: HTMLElement): number | null {
  if (data.isLive === true || data.isLiveNow === true || data.upcomingEventData) return null;
  const overlays = Array.isArray(data.thumbnailOverlays) ? data.thumbnailOverlays : [];
  for (const overlay of overlays) {
    const badge = record(record(overlay)?.thumbnailOverlayTimeStatusRenderer);
    if (badge?.style === 'LIVE' || badge?.style === 'UPCOMING') return null;
  }
  const candidates = [textOf(data.lengthText), ...overlays.map(overlay =>
    textOf(record(record(overlay)?.thumbnailOverlayTimeStatusRenderer)?.text))];
  // Read only time-badge elements, never a title that happens to contain a time.
  for (const badge of row.querySelectorAll('ytd-thumbnail-overlay-time-status-renderer, .badge-shape-wiz__text')) {
    candidates.push(badge.textContent ?? '');
  }
  for (const candidate of candidates) {
    const seconds = parseDuration(candidate);
    if (seconds !== null) return seconds;
  }
  return null;
}

/** YouTube's resume-bar percentage for this row; 0 when it records none. */
function watchedOf(data: RecordValue): number {
  const overlays = Array.isArray(data.thumbnailOverlays) ? data.thumbnailOverlays : [];
  for (const overlay of overlays) {
    const percent = record(record(overlay)?.thumbnailOverlayResumePlaybackRenderer)?.percentDurationWatched;
    if (typeof percent === 'number' && percent > 0) return percent;
  }
  return 0;
}

export function readSnapshot(panel: HTMLElement): Snapshot {
  if (!panel.isConnected) throw new Error('The queue panel was closed.');
  const controller = controllerOf(panel as NativeElement);
  const data = controller.data;
  if (!data || !Array.isArray(data.contents)) {
    throw new Error('Cannot read YouTube’s queue. Enable page-context injection in your userscript manager and reload.');
  }
  if (controller.canReorder !== true || typeof controller.ytReorderableController?.handleDrop !== 'function') {
    throw new Error('Native reordering is unavailable here. Open a queue or an editable playlist with drag handles.');
  }
  if (controller.shuffleOn === true) throw new Error('Turn off YouTube shuffle before sorting.');
  if (data.isInfinite === true) throw new Error('Radio/mix playlists are not supported by this prototype.');
  const playlistId = typeof data.playlistId === 'string' ? data.playlistId : '';
  if (!playlistId) throw new Error('YouTube has not provided a queue identifier yet.');
  const container = panel.querySelector<HTMLElement>('#items');
  if (!container) throw new Error('Expand the queue panel first.');
  const rows = Array.from(container.children).filter((node): node is NativeElement =>
    node instanceof HTMLElement && node.tagName === 'YTD-PLAYLIST-PANEL-VIDEO-RENDERER');
  const entries = data.contents.map(entry => record(record(entry)?.playlistPanelVideoRenderer)).filter(entry => entry !== undefined);
  if (rows.length === 0 || entries.length !== rows.length) {
    throw new Error('Wait for the loaded queue items to finish rendering, then try again.');
  }
  // The native drop handler uses childNodes indices. Require the same contiguous
  // video prefix it expects; do not accidentally count injected nodes or gaps.
  if (rows.some((row, index) => container.childNodes[index] !== row)) {
    throw new Error('Unsupported queue layout: video rows are not contiguous.');
  }
  const items = entries.map((entry, index): QueueItem => {
    const row = rows[index]!;
    const rowData = row.data;
    const id = entry.playlistSetVideoId;
    if (typeof id !== 'string' || !id || rowData?.playlistSetVideoId !== id) {
      throw new Error('Queue data and visible rows disagree. Wait for YouTube to finish updating.');
    }
    return {
      id, duration: durationOf(entry, row),
      title: textOf(entry.title).trim() || row.querySelector('#video-title')?.textContent?.trim() || null,
      videoId: typeof entry.videoId === 'string' ? entry.videoId : '',
      watched: watchedOf(entry),
    };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) {
    throw new Error('Queue occurrence identifiers are missing or duplicated.');
  }
  const selected = entries.flatMap((entry, index) => entry.selected === true ? [index] : []);
  // After a video starts in place, YouTube keeps currentIndex on the playing
  // video but can leave the selected flags on its old position. The address
  // bar names the playing video, so accept currentIndex when they agree.
  const playing = new URLSearchParams(location.search).get('v');
  const index = typeof data.currentIndex === 'number' ? data.currentIndex : -1;
  const flagged = selected.length === 1 && selected[0] === index;
  const named = !!playing && items[index]?.videoId === playing;
  if (!flagged && !named) {
    throw new Error('Cannot locate the current video in the loaded queue. Try a short, fully loaded queue.');
  }
  const total = typeof data.totalVideos === 'number' ? data.totalVideos : null;
  return { items, entries, currentIndex: index, playlistId, total, container, rows, controller };
}

const ids = (snapshot: Snapshot): string[] => snapshot.items.map(item => item.id);
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
// Hidden tabs skip animation frames, so a timer stands in for one there.
const nextFrame = (): Promise<void> => new Promise(resolve => {
  requestAnimationFrame(() => resolve());
  setTimeout(resolve, 50);
});

const currentId = (snapshot: Snapshot): string | undefined => snapshot.items[snapshot.currentIndex]?.id;

/** Same queue, same video playing; its index may change as rows move around it. */
function checkSession(snapshot: Snapshot, initial: Snapshot): void {
  if (snapshot.playlistId !== initial.playlistId || currentId(snapshot) !== currentId(initial)) {
    throw new Error('Playback or the queue changed. Sorting stopped; completed moves remain applied.');
  }
}

export async function reorderPanel(
  panel: HTMLElement,
  initial: Snapshot,
  target: string[],
  signal: AbortSignal,
  report: (message: string) => void,
): Promise<number> {
  const original = ids(initial);
  if (target.length !== original.length || new Set(target).size !== target.length ||
      target.some(id => !original.includes(id))) {
    throw new Error('The requested order no longer matches this queue.');
  }
  let expected = ids(initial);
  let fixed = 0;
  while (fixed < target.length && target[fixed] === expected[fixed]) fixed++;
  const plan = planMoves(expected, target, fixed);
  let moves = 0;
  for (const { id, after: anchor } of plan) {
    signal.throwIfAborted();
    const before = readSnapshot(panel);
    checkSession(before, initial);
    if (!sameOrder(ids(before), expected)) {
      throw new Error('The queue changed while sorting. Completed moves remain applied; try again.');
    }
    const row = before.rows[expected.indexOf(id)]!;
    const oldNext = row.nextSibling;
    const nextOrder = expected.filter(other => other !== id);
    nextOrder.splice(anchor === null ? 0 : nextOrder.indexOf(anchor) + 1, 0, id);
    const reorder = before.controller.ytReorderableController!;
    // Rows start the container, so the top is before the first row.
    before.container.insertBefore(row, anchor === null ? before.rows[0]! : before.rows[expected.indexOf(anchor)]!.nextSibling);
    try {
      // This is the callback installed by YouTube's own drag controller.
      // Its input is the moved row at its destination, exactly as after a drop.
      reorder.handleDrop!({ currDragItem: row });
    } catch (error) {
      // Restore only the visual move if native state is still unchanged.
      restoreVisualIfUnchanged(before, row, oldNext, expected);
      throw new Error(`YouTube’s native move failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const deadline = Date.now() + 3500;
    let confirmed = false;
    try {
      // YouTube applies the move before handleDrop returns, so check at once;
      // poll only if a build ever applies it later.
      for (let first = true; Date.now() < deadline; first = false) {
        if (!first) await delay(25);
        signal.throwIfAborted();
        // Rendering may briefly lag behind the native data update.
        let after: Snapshot;
        try { after = readSnapshot(panel); } catch { continue; }
        checkSession(after, initial);
        if (sameOrder(ids(after), nextOrder)) { confirmed = true; break; }
        if (!sameOrder(ids(after), expected)) {
          throw new Error('Unexpected queue change after a native move. Sorting stopped.');
        }
      }
    } catch (error) {
      restoreVisualIfUnchanged(before, row, oldNext, expected);
      throw error;
    }
    if (!confirmed) {
      restoreVisualIfUnchanged(before, row, oldNext, expected);
      throw new Error('YouTube did not confirm the move in its queue data. Sorting stopped.');
    }
    expected = nextOrder;
    moves++;
    report(`Sorting: ${moves}/${plan.length} moves…`);
    // Let the page repaint between moves; never flood the drag handler.
    await nextFrame();
  }
  signal.throwIfAborted();
  const final = readSnapshot(panel);
  checkSession(final, initial);
  if (!sameOrder(ids(final), target)) throw new Error('YouTube changed the order before verification finished. Try again.');
  return moves;
}

/**
 * Play one loaded occurrence through its row's own link, as a click on the row
 * does, and wait until YouTube marks it current. The order stays as it is.
 */
export async function playItem(panel: HTMLElement, initial: Snapshot, id: string, signal: AbortSignal): Promise<Snapshot> {
  const index = ids(initial).indexOf(id);
  const link = initial.rows[index]?.querySelector<HTMLElement>('a#wc-endpoint');
  if (!link) throw new Error('YouTube offers no link to play the first sorted video. The new order stays.');
  link.click();
  const deadline = Date.now() + 5000;
  for (;;) {
    signal.throwIfAborted();
    try {
      const snapshot = readSnapshot(panel);
      if (snapshot.playlistId !== initial.playlistId) throw new Error('The queue changed before the first sorted video started.');
      if (currentId(snapshot) === id) return snapshot;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    if (Date.now() >= deadline) throw new Error('YouTube did not start the first sorted video. The new order stays.');
    await delay(50);
  }
}

/** The row's own "Remove" menu item, only if it removes exactly this occurrence from this list. */
function removeMenuItem(entry: RecordValue, id: string, playlistId: string): RecordValue | undefined {
  const items = record(record(entry.menu)?.menuRenderer)?.items;
  for (const item of Array.isArray(items) ? items : []) {
    const menuItem = record(record(item)?.menuServiceItemRenderer);
    const edit = record(record(menuItem?.serviceEndpoint)?.playlistEditEndpoint);
    const actions = Array.isArray(edit?.actions) ? edit.actions : [];
    const action = record(actions[0]);
    if (actions.length === 1 && action?.action === 'ACTION_REMOVE_VIDEO' && action.setVideoId === id &&
        edit?.playlistId === playlistId) return menuItem;
  }
  return undefined;
}

/**
 * Remove occurrences with one edit built from their rows' own remove items.
 * Separate edits overlap on YouTube's server, which rejects some of them and
 * later restores those rows; one edit removes them all at once.
 */
export function removeItems(initial: Snapshot, remove: readonly string[]): void {
  const playlistId = initial.playlistId;
  const order = ids(initial);
  if (remove.length === 0 || remove.includes(order[initial.currentIndex]!) ||
      new Set(remove).size !== remove.length || remove.some(id => !order.includes(id))) {
    throw new Error('The requested removals no longer match this queue.');
  }
  const items = remove.map(id => removeMenuItem(initial.entries[order.indexOf(id)]!, id, playlistId));
  if (items.some(item => !item)) throw new Error('YouTube offers no remove action for a video here. Nothing was removed.');
  const first = items[0]!;
  const endpoint = record(first.serviceEndpoint)!;
  const edit = record(endpoint.playlistEditEndpoint)!;
  const combined: RecordValue = { ...first, serviceEndpoint: { ...endpoint, playlistEditEndpoint: {
    ...edit,
    actions: items.flatMap(item => record(record(item!.serviceEndpoint)!.playlistEditEndpoint)!.actions as unknown[]),
    // The queue drops rows through these client actions, as for YouTube's own menu.
    ...(Array.isArray(edit.clientActions) ? { clientActions: [{ playlistRemoveVideosAction: { setVideoIds: [...remove] } }] } : {}),
  } } };
  const native = customElements.get('ytd-menu-service-item-renderer') !== undefined;
  const app = document.querySelector<NativeElement>('ytd-app');
  const resolver = app && typeof app.resolveCommand !== 'function' ? controllerOf(app) : app;
  if (!native && typeof resolver?.resolveCommand !== 'function') throw new Error('YouTube’s command handler is unavailable here.');
  try {
    if (native) {
      // Select a menu item exactly as YouTube's own row menu does.
      const item = document.createElement('ytd-menu-service-item-renderer') as NativeElement;
      item.hidden = true;
      item.data = combined;
      initial.rows[order.indexOf(remove[0]!)]!.append(item);
      try { item.click(); } finally { item.remove(); }
    } else {
      resolver!.resolveCommand!(combined.serviceEndpoint as RecordValue);
    }
  } catch (error) {
    throw new Error(`YouTube’s native removal failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The queue once none of `gone` is in it, or as it stands after a short wait,
 * so a sort that follows removals works on the rows YouTube actually kept.
 */
export async function afterRemoval(panel: HTMLElement, gone: readonly string[], signal: AbortSignal): Promise<Snapshot> {
  const deadline = Date.now() + 1500;
  for (;;) {
    signal.throwIfAborted();
    try {
      const snapshot = readSnapshot(panel);
      if (Date.now() >= deadline || !snapshot.items.some(item => gone.includes(item.id))) return snapshot;
    } catch (error) {
      // Rows may briefly lag behind the queue data while YouTube re-renders.
      if (Date.now() >= deadline) throw error;
    }
    await delay(25);
  }
}

function restoreVisualIfUnchanged(before: Snapshot, row: HTMLElement, oldNext: ChildNode | null, expected: string[]): void {
  const contents = before.controller.data?.contents;
  if (!Array.isArray(contents) || row.parentNode !== before.container ||
      (oldNext && oldNext.parentNode !== before.container)) return;
  const current = contents.flatMap(entry => {
    const id = record(record(entry)?.playlistPanelVideoRenderer)?.playlistSetVideoId;
    return typeof id === 'string' ? [id] : [];
  });
  if (sameOrder(current, expected)) before.container.insertBefore(row, oldNext);
}
