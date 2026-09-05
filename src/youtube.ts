import { parseDuration, parsePostedDate, sameOrder, type Item } from './sort.ts';

type RecordValue = Record<string, unknown>;
type NativeElement = HTMLElement & {
  data?: RecordValue;
  polymerController?: NativeController;
  inst?: NativeController;
};
interface NativeController {
  data?: RecordValue;
  canReorder?: boolean;
  shuffleOn?: boolean;
  ytReorderableController?: { handleDrop?: (event: { currDragItem: HTMLElement }) => void };
}
export interface Snapshot {
  items: Item[];
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

function postedDateOf(data: RecordValue, now: number): number | null {
  for (const field of ['publishDate', 'datePublished', 'publishedTimeText']) {
    const raw = data[field];
    const timestamp = parsePostedDate(typeof raw === 'string' ? raw : textOf(raw), now);
    if (timestamp !== null) return timestamp;
  }
  return null;
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
  const now = Date.now();
  const items = entries.map((entry, index): Item => {
    const row = rows[index]!;
    const rowData = row.data;
    const id = entry.playlistSetVideoId;
    if (typeof id !== 'string' || !id || rowData?.playlistSetVideoId !== id) {
      throw new Error('Queue data and visible rows disagree. Wait for YouTube to finish updating.');
    }
    return {
      id, duration: durationOf(entry, row),
      title: textOf(entry.title).trim() || row.querySelector('#video-title')?.textContent?.trim() || null,
      postedAt: postedDateOf(entry, now),
    };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) {
    throw new Error('Queue occurrence identifiers are missing or duplicated.');
  }
  const selected = entries.flatMap((entry, index) => entry.selected === true ? [index] : []);
  if (selected.length !== 1 || data.currentIndex !== selected[0]) {
    throw new Error('Cannot locate the current video in the loaded queue. Try a short, fully loaded queue.');
  }
  const total = typeof data.totalVideos === 'number' ? data.totalVideos : null;
  return { items, currentIndex: selected[0]!, playlistId, total, container, rows, controller };
}

const ids = (snapshot: Snapshot): string[] => snapshot.items.map(item => item.id);
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function checkSession(snapshot: Snapshot, initial: Snapshot): void {
  if (snapshot.playlistId !== initial.playlistId || snapshot.currentIndex !== initial.currentIndex ||
      snapshot.items[snapshot.currentIndex]?.id !== initial.items[initial.currentIndex]?.id) {
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
      target.some(id => !original.includes(id)) ||
      !sameOrder(target.slice(0, initial.currentIndex + 1), original.slice(0, initial.currentIndex + 1))) {
    throw new Error('The requested order no longer matches this queue.');
  }
  let expected = ids(initial);
  let moves = 0;
  for (let position = initial.currentIndex + 1; position < target.length; position++) {
    signal.throwIfAborted();
    const before = readSnapshot(panel);
    checkSession(before, initial);
    if (!sameOrder(ids(before), expected)) {
      throw new Error('The queue changed while sorting. Completed moves remain applied; try again.');
    }
    if (expected[position] === target[position]) continue;
    const from = expected.indexOf(target[position]!);
    const row = before.rows[from]!;
    const oldNext = row.nextSibling;
    const nextOrder = [...expected];
    nextOrder.splice(position, 0, nextOrder.splice(from, 1)[0]!);
    const reorder = before.controller.ytReorderableController!;
    before.container.insertBefore(row, before.rows[position]!);
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
      while (Date.now() < deadline) {
        await delay(100);
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
    report(`Sorting: ${position - initial.currentIndex}/${target.length - initial.currentIndex - 1} upcoming positions checked…`);
    // Give native refreshes time to arrive; never flood the drag handler.
    await delay(350);
  }
  signal.throwIfAborted();
  const final = readSnapshot(panel);
  checkSession(final, initial);
  if (!sameOrder(ids(final), target)) throw new Error('YouTube changed the order before verification finished. Try again.');
  return moves;
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
