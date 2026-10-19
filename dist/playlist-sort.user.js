// ==UserScript==
// @name         YouTube Up Next — Shortest First
// @namespace    urn:kemus:youtube-up-next-sort
// @version      0.9.0
// @description  Sort upcoming videos by duration or title, and optionally by views, likes, or upload date. Remove watched or repeated videos.
// @homepageURL  https://github.com/kemus/youtube-up-next-sort
// @downloadURL  https://raw.githubusercontent.com/kemus/youtube-up-next-sort/main/dist/playlist-sort.user.js
// @updateURL    https://raw.githubusercontent.com/kemus/youtube-up-next-sort/main/dist/playlist-sort.user.js
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @sandbox      raw
// @inject-into  page
// @noframes
// ==/UserScript==
"use strict";
(() => {
  // src/settings.ts
  function storageAvailable() {
    return typeof GM_getValue === "function" && typeof GM_setValue === "function";
  }
  function readStored(name, fallback) {
    return storageAvailable() ? GM_getValue(name, fallback) : fallback;
  }
  function writeStored(name, value) {
    if (storageAvailable()) GM_setValue(name, value);
  }
  function loadSettings() {
    if (!storageAvailable()) return { apiKey: "", fetch: false, dedupe: false };
    const apiKey = GM_getValue("apiKey", "");
    return {
      apiKey: typeof apiKey === "string" ? apiKey : "",
      fetch: GM_getValue("fetch", false) === true,
      dedupe: GM_getValue("dedupe", true) === true
    };
  }
  function saveSettings(settings2) {
    if (!storageAvailable()) throw new Error("The userscript manager\u2019s storage is unavailable. Reinstall the script to grant it.");
    GM_setValue("apiKey", settings2.apiKey);
    GM_setValue("fetch", settings2.fetch);
    GM_setValue("dedupe", settings2.dedupe);
  }

  // src/sort.ts
  var titleOrder = new Intl.Collator(void 0, { numeric: true, sensitivity: "base" });
  function parseDuration(text) {
    const value = text.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
    if (!/^\d+:\d{2}(?::\d{2})?$/.test(value)) return null;
    const parts = value.split(":").map(Number);
    if (parts.slice(1).some((part) => part >= 60)) return null;
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
  }
  function sortUpcoming(items, currentIndex, key = "duration", direction = "asc") {
    if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= items.length) {
      throw new Error("Cannot identify the currently playing item.");
    }
    if (new Set(items.map((item) => item.id)).size !== items.length) {
      throw new Error("YouTube did not provide unique queue item identifiers.");
    }
    const upcoming = items.slice(currentIndex + 1).map((item, index) => ({ item, index }));
    const value = (item) => key === "title" ? item.title?.trim() || null : key === "views" ? item.views ?? null : key === "likes" ? item.likes ?? null : key === "uploaded" ? item.uploadedAt ?? null : item.duration;
    upcoming.sort((a, b) => {
      const left = value(a.item);
      const right = value(b.item);
      if (left === null || right === null) return left === right ? a.index - b.index : left === null ? 1 : -1;
      const comparison = typeof left === "string" && typeof right === "string" ? titleOrder.compare(left, right) : left < right ? -1 : left > right ? 1 : 0;
      return comparison * (direction === "asc" ? 1 : -1) || a.index - b.index;
    });
    return [...items.slice(0, currentIndex + 1), ...upcoming.map((entry) => entry.item)];
  }
  function duplicateIds(items, currentIndex) {
    const seen = /* @__PURE__ */ new Set();
    return items.flatMap((item, index) => {
      if (!item.videoId) return [];
      if (!seen.has(item.videoId)) {
        seen.add(item.videoId);
        return [];
      }
      return index > currentIndex ? [item.id] : [];
    });
  }
  function watchedIds(items, currentIndex) {
    return items.flatMap((item, index) => index !== currentIndex && item.watched > 0 ? [item.id] : []);
  }
  function aboveIds(items, currentIndex) {
    return items.slice(0, Math.max(currentIndex, 0)).map((item) => item.id);
  }
  function planMoves(current, target, fixed) {
    const rank = new Map(target.map((id, index) => [id, index]));
    const upcoming = current.slice(fixed);
    const tails = [];
    const previous = [];
    upcoming.forEach((id, index) => {
      const value = rank.get(id);
      let low = 0;
      let high = tails.length;
      while (low < high) {
        const middle = low + high >> 1;
        if (rank.get(upcoming[tails[middle]]) < value) low = middle + 1;
        else high = middle;
      }
      previous[index] = low > 0 ? tails[low - 1] : -1;
      tails[low] = index;
    });
    const kept = /* @__PURE__ */ new Set();
    for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]) kept.add(upcoming[index]);
    return target.slice(fixed).flatMap((id, offset) => kept.has(id) ? [] : [{ id, after: target[fixed + offset - 1] }]);
  }
  function sameOrder(left, right) {
    return left.length === right.length && left.every((id, index) => id === right[index]);
  }

  // src/stats.ts
  var ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";
  var BATCH = 50;
  var CACHE_KEY = "stats";
  var CACHE_MS = 8 * 60 * 60 * 1e3;
  var cache = /* @__PURE__ */ new Map();
  function count(value) {
    const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(number) ? number : null;
  }
  var known = (value) => value === null || typeof value === "number";
  function refreshCache(now) {
    const stored = readStored(CACHE_KEY, {});
    if (stored !== null && typeof stored === "object") {
      for (const [id, entry] of Object.entries(stored)) {
        if (typeof entry?.fetchedAt === "number" && known(entry.views) && known(entry.likes) && known(entry.uploadedAt) && entry.fetchedAt > (cache.get(id)?.fetchedAt ?? -Infinity)) {
          cache.set(id, { views: entry.views, likes: entry.likes, uploadedAt: entry.uploadedAt, fetchedAt: entry.fetchedAt });
        }
      }
    }
    let expired = false;
    for (const [id, entry] of cache) {
      if (now - entry.fetchedAt >= CACHE_MS || entry.fetchedAt > now) {
        cache.delete(id);
        expired = true;
      }
    }
    return expired;
  }
  function failure(status, body) {
    const error = body?.error;
    const reason = error?.errors?.[0]?.reason;
    const message = typeof error?.message === "string" ? error.message : "";
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      return "Today\u2019s YouTube Data API quota is used up. It resets at midnight Pacific Time.";
    }
    if (status === 400 && /API key/i.test(message)) return "YouTube rejected the API key. Check it in the sort settings.";
    return `YouTube Data API request failed (${status})${message ? `: ${message}` : "."}`;
  }
  async function fetchStats(videoIds, apiKey, signal) {
    const changed = refreshCache(Date.now());
    const missing = [...new Set(videoIds)].filter((id) => id && !cache.has(id));
    try {
      await fetchMissing(missing, apiKey, signal);
    } finally {
      if (changed || missing.some((id) => cache.has(id))) writeStored(CACHE_KEY, Object.fromEntries(cache));
    }
    return new Map(videoIds.flatMap((id) => {
      const entry = cache.get(id);
      return entry ? [[id, { views: entry.views, likes: entry.likes, uploadedAt: entry.uploadedAt }]] : [];
    }));
  }
  async function fetchMissing(missing, apiKey, signal) {
    for (let start = 0; start < missing.length; start += BATCH) {
      const batch = missing.slice(start, start + BATCH);
      const query = new URLSearchParams({
        part: "snippet,statistics",
        fields: "items(id,snippet/publishedAt,statistics(viewCount,likeCount))",
        id: batch.join(",")
      });
      let response;
      try {
        response = await fetch(`${ENDPOINT}?${query}`, { signal, credentials: "omit", headers: { "X-Goog-Api-Key": apiKey } });
      } catch (error) {
        signal.throwIfAborted();
        throw new Error(`Could not reach the YouTube Data API: ${error instanceof Error ? error.message : String(error)}`);
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(failure(response.status, body));
      const items = body?.items;
      if (!Array.isArray(items)) throw new Error("The YouTube Data API returned an unexpected response.");
      const fetchedAt = Date.now();
      for (const item of items) {
        if (typeof item.id !== "string") continue;
        const published = typeof item.snippet?.publishedAt === "string" ? Date.parse(item.snippet.publishedAt) : NaN;
        cache.set(item.id, {
          views: count(item.statistics?.viewCount),
          likes: count(item.statistics?.likeCount),
          uploadedAt: Number.isFinite(published) ? published : null,
          fetchedAt
        });
      }
      for (const id of batch) if (!cache.has(id)) cache.set(id, { views: null, likes: null, uploadedAt: null, fetchedAt });
    }
  }

  // src/youtube.ts
  function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  }
  function controllerOf(element) {
    return element.polymerController ?? element.inst ?? element;
  }
  function textOf(value) {
    const data = record(value);
    if (typeof data?.simpleText === "string") return data.simpleText;
    return Array.isArray(data?.runs) ? data.runs.map((run) => record(run)?.text ?? "").join("") : "";
  }
  function durationOf(data, row) {
    if (data.isLive === true || data.isLiveNow === true || data.upcomingEventData) return null;
    const overlays = Array.isArray(data.thumbnailOverlays) ? data.thumbnailOverlays : [];
    for (const overlay of overlays) {
      const badge = record(record(overlay)?.thumbnailOverlayTimeStatusRenderer);
      if (badge?.style === "LIVE" || badge?.style === "UPCOMING") return null;
    }
    const candidates = [textOf(data.lengthText), ...overlays.map((overlay) => textOf(record(record(overlay)?.thumbnailOverlayTimeStatusRenderer)?.text))];
    for (const badge of row.querySelectorAll("ytd-thumbnail-overlay-time-status-renderer, .badge-shape-wiz__text")) {
      candidates.push(badge.textContent ?? "");
    }
    for (const candidate of candidates) {
      const seconds = parseDuration(candidate);
      if (seconds !== null) return seconds;
    }
    return null;
  }
  function watchedOf(data) {
    const overlays = Array.isArray(data.thumbnailOverlays) ? data.thumbnailOverlays : [];
    for (const overlay of overlays) {
      const percent = record(record(overlay)?.thumbnailOverlayResumePlaybackRenderer)?.percentDurationWatched;
      if (typeof percent === "number" && percent > 0) return percent;
    }
    return 0;
  }
  function readSnapshot(panel) {
    if (!panel.isConnected) throw new Error("The queue panel was closed.");
    const controller = controllerOf(panel);
    const data = controller.data;
    if (!data || !Array.isArray(data.contents)) {
      throw new Error("Cannot read YouTube\u2019s queue. Enable page-context injection in your userscript manager and reload.");
    }
    if (controller.canReorder !== true || typeof controller.ytReorderableController?.handleDrop !== "function") {
      throw new Error("Native reordering is unavailable here. Open a queue or an editable playlist with drag handles.");
    }
    if (controller.shuffleOn === true) throw new Error("Turn off YouTube shuffle before sorting.");
    if (data.isInfinite === true) throw new Error("Radio/mix playlists are not supported by this prototype.");
    const playlistId = typeof data.playlistId === "string" ? data.playlistId : "";
    if (!playlistId) throw new Error("YouTube has not provided a queue identifier yet.");
    const container = panel.querySelector("#items");
    if (!container) throw new Error("Expand the queue panel first.");
    const rows = Array.from(container.children).filter((node) => node instanceof HTMLElement && node.tagName === "YTD-PLAYLIST-PANEL-VIDEO-RENDERER");
    const entries = data.contents.map((entry) => record(record(entry)?.playlistPanelVideoRenderer)).filter((entry) => entry !== void 0);
    if (rows.length === 0 || entries.length !== rows.length) {
      throw new Error("Wait for the loaded queue items to finish rendering, then try again.");
    }
    if (rows.some((row, index) => container.childNodes[index] !== row)) {
      throw new Error("Unsupported queue layout: video rows are not contiguous.");
    }
    const items = entries.map((entry, index) => {
      const row = rows[index];
      const rowData = row.data;
      const id = entry.playlistSetVideoId;
      if (typeof id !== "string" || !id || rowData?.playlistSetVideoId !== id) {
        throw new Error("Queue data and visible rows disagree. Wait for YouTube to finish updating.");
      }
      return {
        id,
        duration: durationOf(entry, row),
        title: textOf(entry.title).trim() || row.querySelector("#video-title")?.textContent?.trim() || null,
        videoId: typeof entry.videoId === "string" ? entry.videoId : "",
        watched: watchedOf(entry)
      };
    });
    if (new Set(items.map((item) => item.id)).size !== items.length) {
      throw new Error("Queue occurrence identifiers are missing or duplicated.");
    }
    const selected = entries.flatMap((entry, index) => entry.selected === true ? [index] : []);
    if (selected.length !== 1 || data.currentIndex !== selected[0]) {
      throw new Error("Cannot locate the current video in the loaded queue. Try a short, fully loaded queue.");
    }
    const total = typeof data.totalVideos === "number" ? data.totalVideos : null;
    return { items, entries, currentIndex: selected[0], playlistId, total, container, rows, controller };
  }
  var ids = (snapshot) => snapshot.items.map((item) => item.id);
  var delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var nextFrame = () => new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
    setTimeout(resolve, 50);
  });
  function checkSession(snapshot, initial) {
    if (snapshot.playlistId !== initial.playlistId || snapshot.currentIndex !== initial.currentIndex || snapshot.items[snapshot.currentIndex]?.id !== initial.items[initial.currentIndex]?.id) {
      throw new Error("Playback or the queue changed. Sorting stopped; completed moves remain applied.");
    }
  }
  async function reorderPanel(panel, initial, target, signal, report) {
    const original = ids(initial);
    if (target.length !== original.length || new Set(target).size !== target.length || target.some((id) => !original.includes(id)) || !sameOrder(target.slice(0, initial.currentIndex + 1), original.slice(0, initial.currentIndex + 1))) {
      throw new Error("The requested order no longer matches this queue.");
    }
    let expected = ids(initial);
    const plan = planMoves(expected, target, initial.currentIndex + 1);
    let moves = 0;
    for (const { id, after: anchor } of plan) {
      signal.throwIfAborted();
      const before = readSnapshot(panel);
      checkSession(before, initial);
      if (!sameOrder(ids(before), expected)) {
        throw new Error("The queue changed while sorting. Completed moves remain applied; try again.");
      }
      const row = before.rows[expected.indexOf(id)];
      const anchorRow = before.rows[expected.indexOf(anchor)];
      const oldNext = row.nextSibling;
      const nextOrder = expected.filter((other) => other !== id);
      nextOrder.splice(nextOrder.indexOf(anchor) + 1, 0, id);
      const reorder = before.controller.ytReorderableController;
      before.container.insertBefore(row, anchorRow.nextSibling);
      try {
        reorder.handleDrop({ currDragItem: row });
      } catch (error) {
        restoreVisualIfUnchanged(before, row, oldNext, expected);
        throw new Error(`YouTube\u2019s native move failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const deadline = Date.now() + 3500;
      let confirmed = false;
      try {
        for (let first = true; Date.now() < deadline; first = false) {
          if (!first) await delay(25);
          signal.throwIfAborted();
          let after;
          try {
            after = readSnapshot(panel);
          } catch {
            continue;
          }
          checkSession(after, initial);
          if (sameOrder(ids(after), nextOrder)) {
            confirmed = true;
            break;
          }
          if (!sameOrder(ids(after), expected)) {
            throw new Error("Unexpected queue change after a native move. Sorting stopped.");
          }
        }
      } catch (error) {
        restoreVisualIfUnchanged(before, row, oldNext, expected);
        throw error;
      }
      if (!confirmed) {
        restoreVisualIfUnchanged(before, row, oldNext, expected);
        throw new Error("YouTube did not confirm the move in its queue data. Sorting stopped.");
      }
      expected = nextOrder;
      moves++;
      report(`Sorting: ${moves}/${plan.length} moves\u2026`);
      await nextFrame();
    }
    signal.throwIfAborted();
    const final = readSnapshot(panel);
    checkSession(final, initial);
    if (!sameOrder(ids(final), target)) throw new Error("YouTube changed the order before verification finished. Try again.");
    return moves;
  }
  function removeMenuItem(entry, id, playlistId) {
    const items = record(record(entry.menu)?.menuRenderer)?.items;
    for (const item of Array.isArray(items) ? items : []) {
      const menuItem = record(record(item)?.menuServiceItemRenderer);
      const edit = record(record(menuItem?.serviceEndpoint)?.playlistEditEndpoint);
      const actions = Array.isArray(edit?.actions) ? edit.actions : [];
      const action = record(actions[0]);
      if (actions.length === 1 && action?.action === "ACTION_REMOVE_VIDEO" && action.setVideoId === id && edit?.playlistId === playlistId) return menuItem;
    }
    return void 0;
  }
  function removeItems(initial, remove) {
    const playlistId = initial.playlistId;
    const order = ids(initial);
    if (remove.length === 0 || remove.includes(order[initial.currentIndex]) || new Set(remove).size !== remove.length || remove.some((id) => !order.includes(id))) {
      throw new Error("The requested removals no longer match this queue.");
    }
    const items = remove.map((id) => removeMenuItem(initial.entries[order.indexOf(id)], id, playlistId));
    if (items.some((item) => !item)) throw new Error("YouTube offers no remove action for a video here. Nothing was removed.");
    const first = items[0];
    const endpoint = record(first.serviceEndpoint);
    const edit = record(endpoint.playlistEditEndpoint);
    const combined = { ...first, serviceEndpoint: { ...endpoint, playlistEditEndpoint: {
      ...edit,
      actions: items.flatMap((item) => record(record(item.serviceEndpoint).playlistEditEndpoint).actions),
      // The queue drops rows through these client actions, as for YouTube's own menu.
      ...Array.isArray(edit.clientActions) ? { clientActions: [{ playlistRemoveVideosAction: { setVideoIds: [...remove] } }] } : {}
    } } };
    const native = customElements.get("ytd-menu-service-item-renderer") !== void 0;
    const app = document.querySelector("ytd-app");
    const resolver = app && typeof app.resolveCommand !== "function" ? controllerOf(app) : app;
    if (!native && typeof resolver?.resolveCommand !== "function") throw new Error("YouTube\u2019s command handler is unavailable here.");
    try {
      if (native) {
        const item = document.createElement("ytd-menu-service-item-renderer");
        item.hidden = true;
        item.data = combined;
        initial.rows[order.indexOf(remove[0])].append(item);
        try {
          item.click();
        } finally {
          item.remove();
        }
      } else {
        resolver.resolveCommand(combined.serviceEndpoint);
      }
    } catch (error) {
      throw new Error(`YouTube\u2019s native removal failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function afterRemoval(panel, gone, signal) {
    const deadline = Date.now() + 1500;
    for (; ; ) {
      signal.throwIfAborted();
      try {
        const snapshot = readSnapshot(panel);
        if (Date.now() >= deadline || !snapshot.items.some((item) => gone.includes(item.id))) return snapshot;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      await delay(25);
    }
  }
  function restoreVisualIfUnchanged(before, row, oldNext, expected) {
    const contents = before.controller.data?.contents;
    if (!Array.isArray(contents) || row.parentNode !== before.container || oldNext && oldNext.parentNode !== before.container) return;
    const current = contents.flatMap((entry) => {
      const id = record(record(entry)?.playlistPanelVideoRenderer)?.playlistSetVideoId;
      return typeof id === "string" ? [id] : [];
    });
    if (sameOrder(current, expected)) before.container.insertBefore(row, oldNext);
  }

  // src/userscript.ts
  var HOST_TAG = "yt-up-next-duration-sort";
  var running = null;
  var settings = loadSettings();
  var cycles = /* @__PURE__ */ new Map();
  var controls = /* @__PURE__ */ new Map();
  var names = { duration: "Duration", title: "Title", views: "Views", likes: "Likes", uploaded: "Date" };
  var plurals = { duration: "durations", title: "titles", views: "view counts", likes: "like counts", uploaded: "upload dates" };
  var descriptions = {
    duration: { asc: "shortest to longest", desc: "longest to shortest" },
    title: { asc: "A to Z", desc: "Z to A" },
    views: { asc: "fewest to most views", desc: "most to fewest views" },
    likes: { asc: "fewest to most likes", desc: "most to fewest likes" },
    uploaded: { asc: "oldest to newest upload", desc: "newest to oldest upload" }
  };
  var fetched = /* @__PURE__ */ new Set(["views", "likes", "uploaded"]);
  var canFetch = () => settings.fetch && settings.apiKey !== "";
  var unknown = (item, key) => key === "duration" ? item.duration === null : key === "title" ? !item.title : key === "views" ? item.views == null : key === "likes" ? item.likes == null : item.uploadedAt == null;
  var plural = (count2, noun) => `${count2} ${noun}${count2 === 1 ? "" : "s"}`;
  var ids2 = (snapshot) => snapshot.items.map((item) => item.id);
  function matchingCycle(snapshot) {
    const cycle = cycles.get(snapshot.playlistId);
    return cycle && cycle.currentIndex === snapshot.currentIndex && cycle.currentId === snapshot.items[snapshot.currentIndex]?.id && sameOrder(cycle.expected, ids2(snapshot)) ? cycle : void 0;
  }
  function nextStep(cycle, key) {
    return cycle?.key !== key ? "asc" : cycle.phase === "asc" ? "desc" : "undo";
  }
  function refreshControls() {
    for (const [host, refresh] of controls) {
      if (host.isConnected) refresh();
      else controls.delete(host);
    }
  }
  var TRASH = "\uEA81";
  var GLYPH_FONTS = ["Symbols Nerd Font", "Symbols Nerd Font Mono"];
  var glyphFont;
  function findGlyphFont() {
    if (glyphFont !== void 0) return glyphFont;
    const context = document.createElement("canvas").getContext("2d");
    const width = (font) => {
      context.font = `20px ${font}`;
      return context.measureText(TRASH).width;
    };
    glyphFont = context ? GLYPH_FONTS.find((name) => width(`"${name}", monospace`) !== width("monospace") || width(`"${name}", serif`) !== width("serif")) ?? null : null;
    return glyphFont;
  }
  function removalLabel(button, word) {
    const font = findGlyphFont();
    if (!font) {
      button.textContent = `Remove ${word.toLowerCase()}`;
      return;
    }
    const icon = document.createElement("span");
    icon.className = "glyph";
    icon.setAttribute("aria-hidden", "true");
    icon.style.fontFamily = `"${font}"`;
    icon.textContent = TRASH;
    button.replaceChildren(icon, ` ${word}`);
  }
  function nativeSave(panel) {
    const row = panel.querySelector("#playlist-actions");
    if (!row) return null;
    const display = row.style.display;
    row.style.display = "";
    const controls2 = Array.from(row.querySelectorAll('button, a[href], [role="button"]')).filter((control) => control.getClientRects().length > 0);
    row.style.display = display;
    const button = controls2[0];
    return controls2.length === 1 && button instanceof HTMLButtonElement && button.textContent?.trim() && button.closest("#flexible-item-buttons ytd-button-renderer") ? { row, button } : null;
  }
  function mount(panel) {
    if (panel.querySelector(HOST_TAG)) return;
    const host = document.createElement(HOST_TAG);
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
    :host { display: block; padding: 4px; color: var(--yt-spec-text-secondary, #aaa); font: 11px/1.4 system-ui, sans-serif; }
    button { flex: none; border: 1px solid var(--yt-spec-10-percent-layer, #555); border-radius: 4px; padding: 2px 3px; margin: 0; background: transparent; color: inherit; font: 400 10px/14px system-ui, sans-serif; white-space: nowrap; cursor: pointer; }
    .row, .confirm { display: flex; align-items: center; gap: 2px; margin-bottom: 4px; }
    /* One line in YouTube's usual panel; wrap rather than clip in a narrower one. */
    .row { flex-wrap: wrap; }
    button[aria-pressed="true"] { color: var(--yt-spec-text-primary, #eee); }
    button:disabled { opacity: .5; cursor: default; }
    button[hidden], .settings[hidden], .confirm[hidden] { display: none; }
    button:hover:enabled { background: var(--yt-spec-badge-chip-background, #333); color: var(--yt-spec-text-primary, #eee); }
    button:focus-visible, input:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
    .save { display: inline-flex; align-items: center; gap: 3px; }
    .glyph { display: inline-block; height: 14px; line-height: 14px; vertical-align: top; overflow: hidden; }
    .save svg { flex: none; width: 12px !important; height: 12px !important; margin: 1px 0; fill: currentColor; }
    .settings label { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
    .settings .key { display: flex; align-items: center; gap: 4px; max-width: 420px; margin-bottom: 4px; }
    .settings .key button { margin: 0; }
    .settings input[type="password"] { flex: 1; min-width: 0; box-sizing: border-box; padding: 3px 6px; border: 1px solid var(--yt-spec-10-percent-layer, #555); border-radius: 4px; background: transparent; color: var(--yt-spec-text-primary, #eee); font: inherit; }
    /* The knob is a gradient: Firefox draws no ::before on inputs. */
    .settings input[role="switch"] { appearance: none; flex: none; width: 26px; height: 14px; margin: 0; border-radius: 7px; cursor: pointer;
      background: radial-gradient(circle at 7px 50%, #fff 4.5px, transparent 5px) var(--yt-spec-10-percent-layer, #555); }
    .settings input[role="switch"]:checked { background: radial-gradient(circle at 19px 50%, #fff 4.5px, transparent 5px) var(--yt-spec-call-to-action, #3ea6ff); }
    .settings input[role="switch"]:disabled { cursor: default; }
    .settings label:has(input:disabled) { opacity: .5; }
    .settings p { margin: 4px 0; }
    .confirm span { margin-right: 6px; color: var(--yt-spec-text-primary, #eee); }
    .notice { margin: 0 0 4px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `;
    const makeButton = (text) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      return button;
    };
    const buttons = /* @__PURE__ */ new Map();
    for (const key of ["duration", "title", "views", "likes", "uploaded"]) {
      const button = makeButton(names[key]);
      button.dataset.sort = key;
      button.hidden = fetched.has(key);
      buttons.set(key, button);
    }
    const removeWatched = makeButton("");
    removalLabel(removeWatched, "Watched");
    removeWatched.dataset.action = "watched";
    const removeAbove = makeButton("");
    removalLabel(removeAbove, "Above");
    removeAbove.dataset.action = "above";
    const gear = makeButton("\u2699");
    gear.dataset.action = "settings";
    gear.title = "Sort settings";
    gear.setAttribute("aria-label", "Sort settings");
    gear.setAttribute("aria-expanded", "false");
    const form = document.createElement("div");
    form.className = "settings";
    form.hidden = true;
    const toggle = (name, text) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("role", "switch");
      input.dataset.setting = name;
      label.append(input, text);
      form.append(label);
      return input;
    };
    const keyLabel = document.createElement("label");
    keyLabel.htmlFor = "api-key";
    keyLabel.textContent = "YouTube Data API key";
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.id = "api-key";
    keyInput.dataset.setting = "apiKey";
    keyInput.autocomplete = "off";
    keyInput.spellcheck = false;
    keyInput.placeholder = "Paste a key";
    const clearKey = makeButton("Clear");
    clearKey.dataset.action = "clear";
    const saveKey = makeButton("Save");
    saveKey.dataset.action = "save-key";
    const keyRow = document.createElement("div");
    keyRow.className = "key";
    keyRow.append(keyInput, clearKey, saveKey);
    form.append(keyLabel, keyRow);
    const fetchBox = toggle("fetch", "Use API key");
    fetchBox.parentElement.title = "Fetch views, likes and upload dates with this key.";
    const dedupeBox = toggle("dedupe", "Dedupe on sort");
    dedupeBox.parentElement.title = "Remove repeated upcoming videos when sorting.";
    const hint = document.createElement("p");
    form.append(hint);
    const confirmBar = document.createElement("div");
    confirmBar.className = "confirm";
    confirmBar.hidden = true;
    const confirmText = document.createElement("span");
    const confirmYes = makeButton("Remove");
    confirmYes.dataset.action = "confirm";
    const confirmNo = makeButton("Cancel");
    confirmNo.dataset.action = "cancel";
    confirmBar.append(confirmText, confirmYes, confirmNo);
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.className = "sr-only";
    const save = makeButton("");
    save.className = "save";
    save.hidden = true;
    const row = document.createElement("div");
    row.className = "row";
    row.append(save, ...buttons.values(), removeWatched, removeAbove, gear);
    root.append(style, row, confirmBar, status, form);
    for (const type of ["click", "keydown", "keyup", "keypress"]) {
      root.addEventListener(type, (event) => event.stopPropagation());
    }
    const report = (message, attention = false) => {
      status.textContent = message;
      status.className = attention ? "notice" : "sr-only";
    };
    let hiddenRow;
    let saveLook = "";
    save.addEventListener("click", () => {
      nativeSave(panel)?.button.click();
    });
    function syncSave() {
      const native = nativeSave(panel);
      if (hiddenRow && hiddenRow.row !== native?.row) {
        hiddenRow.row.style.display = hiddenRow.display;
        hiddenRow = void 0;
      }
      save.hidden = !native;
      if (!native) return;
      if (!hiddenRow) {
        hiddenRow = { row: native.row, display: native.row.style.display };
        native.row.style.display = "none";
      }
      const label = native.button.textContent.trim();
      const icon = native.button.querySelector("svg");
      if (saveLook !== `${label}|${icon !== null}`) {
        saveLook = `${label}|${icon !== null}`;
        const copy = icon?.cloneNode(true);
        for (const name of ["style", "width", "height"]) copy?.removeAttribute(name);
        save.replaceChildren(...copy ? [copy] : [], label);
      }
      save.setAttribute("aria-label", native.button.getAttribute("aria-label") || label);
      save.title = native.button.getAttribute("aria-label") || label;
      save.disabled = running !== null;
    }
    function fillSettings() {
      settings = loadSettings();
      const available = storageAvailable();
      fetchBox.checked = settings.fetch;
      dedupeBox.checked = settings.dedupe;
      keyInput.value = settings.apiKey;
      for (const input of [fetchBox, keyInput, dedupeBox]) input.disabled = !available;
      updateKeyButtons();
      hint.hidden = available;
      hint.textContent = available ? "" : "Settings need the userscript manager\u2019s storage permission. Reinstall the script to grant it.";
    }
    function updateKeyButtons() {
      fetchBox.disabled = keyInput.disabled || !settings.apiKey;
      fetchBox.checked = settings.fetch && settings.apiKey !== "";
      const typed = keyInput.value.trim();
      saveKey.disabled = keyInput.disabled || !typed || typed === settings.apiKey;
      clearKey.disabled = keyInput.disabled || !settings.apiKey && !keyInput.value;
    }
    gear.addEventListener("click", () => {
      form.hidden = !form.hidden;
      gear.setAttribute("aria-expanded", String(!form.hidden));
      if (!form.hidden) fillSettings();
    });
    const store = (apiKey) => {
      settings = { apiKey, fetch: apiKey !== "" && fetchBox.checked, dedupe: dedupeBox.checked };
      try {
        saveSettings(settings);
      } catch (error) {
        report(error instanceof Error ? error.message : String(error), true);
      }
      updateKeyButtons();
      refreshControls();
    };
    for (const input of [fetchBox, dedupeBox]) input.addEventListener("input", () => store(settings.apiKey));
    keyInput.addEventListener("input", updateKeyButtons);
    saveKey.addEventListener("click", () => {
      keyInput.value = keyInput.value.trim();
      store(keyInput.value);
    });
    clearKey.addEventListener("click", () => {
      keyInput.value = "";
      store("");
    });
    function describe() {
      syncSave();
      let snapshot;
      let problem = "";
      try {
        snapshot = readSnapshot(panel);
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      const cycle = snapshot ? matchingCycle(snapshot) : void 0;
      const upcoming = snapshot?.items.slice(snapshot.currentIndex + 1) ?? [];
      const saved = snapshot !== void 0 && !snapshot.playlistId.startsWith("TLPQ");
      for (const [key, button] of buttons) {
        if (button.dataset.running) continue;
        const active = cycle?.key === key;
        button.textContent = names[key] + (active ? cycle.phase === "asc" ? " \u2191" : cycle.phase === "desc" ? " \u2193" : " \u21B6" : "");
        button.setAttribute("aria-pressed", String(active));
        button.disabled = running !== null;
        button.hidden = fetched.has(key) && !active && !canFetch();
        const step = nextStep(cycle, key);
        const action = step === "undo" ? `Undo ${names[key].toLowerCase()} sorting; restore the order before this cycle.` : `Sort upcoming videos ${descriptions[key][step]}.`;
        button.setAttribute("aria-label", action);
        const scope = snapshot?.total !== null && snapshot?.total !== void 0 && snapshot.total > snapshot.items.length ? `Loaded ${snapshot.items.length} of ${snapshot.total}; only loaded upcoming videos are sorted.` : `${upcoming.length} upcoming loaded videos.`;
        button.title = problem || [
          action,
          "Current video stays fixed.",
          scope,
          saved ? "Native playlist moves can also change the saved playlist order." : "",
          settings.dedupe && step !== "undo" ? "Repeated upcoming videos are removed first." : ""
        ].filter(Boolean).join(" ");
      }
      if (!removeWatched.dataset.running) {
        const count2 = snapshot ? watchedIds(snapshot.items, snapshot.currentIndex).length : 0;
        removalLabel(removeWatched, "Watched");
        removeWatched.disabled = running !== null || count2 === 0;
        const action = count2 === 0 ? "No loaded videos show watch progress." : `Remove ${plural(count2, "video")} that YouTube shows as started from this ${saved ? "saved playlist" : "queue"}. The current video stays.`;
        removeWatched.setAttribute("aria-label", problem || action);
        removeWatched.title = problem || action;
      }
      if (!removeAbove.dataset.running) {
        const count2 = snapshot ? aboveIds(snapshot.items, snapshot.currentIndex).length : 0;
        removalLabel(removeAbove, "Above");
        removeAbove.disabled = running !== null || count2 === 0;
        const action = count2 === 0 ? "No loaded videos are above the current video." : `Remove the ${plural(count2, "video")} above the current video from this ${saved ? "saved playlist" : "queue"}. The current video stays.`;
        removeAbove.setAttribute("aria-label", problem || action);
        removeAbove.title = problem || action;
      }
    }
    async function run(button, stopLabel, action) {
      if (button.dataset.running === "true") {
        running?.abort();
        return;
      }
      if (running) {
        report("Another queue action is running.", true);
        return;
      }
      const abort = new AbortController();
      running = abort;
      button.dataset.running = "true";
      button.textContent = "Stop";
      button.title = stopLabel;
      button.setAttribute("aria-label", stopLabel);
      button.disabled = false;
      refreshControls();
      try {
        settings = loadSettings();
        await action(abort.signal);
      } catch (error) {
        report(abort.signal.aborted ? "Stopped. Completed changes remain applied." : error instanceof Error ? error.message : String(error), !abort.signal.aborted);
        if (!abort.signal.aborted) console.warn("[YouTube Up Next Sort]", error);
      } finally {
        running = null;
        delete button.dataset.running;
        refreshControls();
      }
    }
    function confirmed(count2, signal) {
      confirmText.textContent = `Remove ${plural(count2, "video")} from this saved playlist? This cannot be undone.`;
      confirmBar.hidden = false;
      return new Promise((resolve) => {
        const done = new AbortController();
        const finish = (answer) => {
          done.abort();
          confirmBar.hidden = true;
          resolve(answer);
        };
        confirmYes.addEventListener("click", () => finish(true), { signal: done.signal });
        confirmNo.addEventListener("click", () => finish(false), { signal: done.signal });
        signal.addEventListener("abort", () => finish(false), { signal: done.signal });
      });
    }
    async function remove(snapshot, targets, signal) {
      if (!snapshot.playlistId.startsWith("TLPQ") && !await confirmed(targets.length, signal)) {
        signal.throwIfAborted();
        return false;
      }
      removeItems(snapshot, targets);
      return true;
    }
    for (const [key, button] of buttons) button.addEventListener("click", () => run(button, "Stop sorting", async (signal) => {
      report("Reading upcoming videos\u2026");
      let attempted;
      try {
        let snapshot = readSnapshot(panel);
        const existing = matchingCycle(snapshot);
        const step = nextStep(existing, key);
        let baseline = existing?.key === key ? existing.baseline : ids2(snapshot);
        const repeats = step !== "undo" && settings.dedupe ? duplicateIds(snapshot.items, snapshot.currentIndex) : [];
        let removedCount = 0;
        if (repeats.length > 0) {
          if (!await remove(snapshot, repeats, signal)) {
            report("Cancelled. Nothing was changed.");
            return;
          }
          const before = snapshot.items.length;
          snapshot = await afterRemoval(panel, repeats, signal);
          removedCount = before - snapshot.items.length;
          const kept = new Set(ids2(snapshot));
          baseline = baseline.filter((id) => kept.has(id));
        }
        const removedNote = removedCount > 0 ? `Removed ${plural(removedCount, "repeated video")}. ` : "";
        let items = snapshot.items;
        const upcomingIds = new Set(ids2(snapshot).slice(snapshot.currentIndex + 1));
        if (upcomingIds.size < 2) {
          report(`${removedNote}Load at least two upcoming videos to sort.`, true);
          return;
        }
        if (step !== "undo" && fetched.has(key)) {
          if (!canFetch()) throw new Error("Save an API key and turn on Use API key in the sort settings.");
          report("Fetching video details\u2026");
          const stats = await fetchStats(items.filter((item) => upcomingIds.has(item.id)).map((item) => item.videoId), settings.apiKey, signal);
          items = items.map((item) => ({ ...item, ...stats.get(item.videoId) }));
        }
        if (step !== "undo" && items.every((item) => !upcomingIds.has(item.id) || unknown(item, key))) {
          report(`${removedNote}No ${plurals[key]} are available for the upcoming videos.`, true);
          return;
        }
        const byId = new Map(items.map((item) => [item.id, item]));
        const target = step === "undo" ? baseline : sortUpcoming(
          baseline.map((id) => byId.get(id)),
          snapshot.currentIndex,
          key,
          step
        ).map((item) => item.id);
        const cycle = {
          key,
          phase: "partial",
          baseline,
          expected: ids2(snapshot),
          currentIndex: snapshot.currentIndex,
          currentId: snapshot.items[snapshot.currentIndex].id
        };
        cycles.set(snapshot.playlistId, cycle);
        attempted = { playlistId: snapshot.playlistId, cycle };
        const moves = await reorderPanel(panel, snapshot, target, signal, report);
        if (step === "undo") {
          cycles.delete(snapshot.playlistId);
          report("Restored the order from before this sort cycle.");
        } else {
          cycle.phase = step;
          cycle.expected = target;
          report(`Sorted loaded upcoming videos ${descriptions[key][step]} (${moves} native moves). ${removedNote}`.trim());
        }
      } catch (error) {
        if (attempted) {
          try {
            const after = readSnapshot(panel);
            const { cycle } = attempted;
            const order = ids2(after);
            if (after.playlistId === attempted.playlistId && after.currentIndex === cycle.currentIndex && order.length === cycle.baseline.length && order.every((id) => cycle.baseline.includes(id)) && sameOrder(order.slice(0, after.currentIndex + 1), cycle.baseline.slice(0, after.currentIndex + 1))) {
              cycle.expected = order;
            } else cycles.delete(attempted.playlistId);
          } catch {
            cycles.delete(attempted.playlistId);
          }
        }
        throw error;
      }
    }));
    removeWatched.addEventListener("click", () => run(removeWatched, "Stop removing", async (signal) => {
      report("Reading the queue\u2026");
      const snapshot = readSnapshot(panel);
      const watched = watchedIds(snapshot.items, snapshot.currentIndex);
      if (watched.length === 0) {
        report("No loaded videos show watch progress.", true);
        return;
      }
      if (!await remove(snapshot, watched, signal)) {
        report("Cancelled. Nothing was changed.");
        return;
      }
      report(`Removed ${plural(watched.length, "watched video")}.`);
    }));
    removeAbove.addEventListener("click", () => run(removeAbove, "Stop removing", async (signal) => {
      report("Reading the queue\u2026");
      const snapshot = readSnapshot(panel);
      const above = aboveIds(snapshot.items, snapshot.currentIndex);
      if (above.length === 0) {
        report("No loaded videos are above the current video.", true);
        return;
      }
      if (!await remove(snapshot, above, signal)) {
        report("Cancelled. Nothing was changed.");
        return;
      }
      report(`Removed ${plural(above.length, "video")} above the current video.`);
    }));
    panel.prepend(host);
    controls.set(host, describe);
    describe();
    panel.addEventListener("yt-rendererstamper-finished", () => {
      if (!running) describe();
    });
  }
  var scheduled = false;
  function scan() {
    scheduled = false;
    document.querySelectorAll("ytd-playlist-panel-renderer").forEach(mount);
    if (!running) refreshControls();
  }
  var observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(scan, 250);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("yt-navigate-start", () => {
    running?.abort();
    cycles.clear();
  });
  document.addEventListener("yt-navigate-finish", scan);
  scan();
})();
