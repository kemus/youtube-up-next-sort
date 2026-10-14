// ==UserScript==
// @name         YouTube Up Next — Shortest First
// @namespace    urn:kemus:youtube-up-next-sort
// @version      0.4.0
// @description  Sort upcoming videos by duration or title, and optionally by views, likes, or upload date. Remove watched or repeated videos.
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
  function loadSettings() {
    if (!storageAvailable()) return { apiKey: "", fetch: false, dedupe: false };
    const apiKey = GM_getValue("apiKey", "");
    return {
      apiKey: typeof apiKey === "string" ? apiKey : "",
      fetch: GM_getValue("fetch", false) === true,
      dedupe: GM_getValue("dedupe", false) === true
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
  function sameOrder(left, right) {
    return left.length === right.length && left.every((id, index) => id === right[index]);
  }

  // src/stats.ts
  var ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";
  var BATCH = 50;
  var cache = /* @__PURE__ */ new Map();
  function count(value) {
    const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(number) ? number : null;
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
    const missing = [...new Set(videoIds)].filter((id) => id && !cache.has(id));
    for (let start = 0; start < missing.length; start += BATCH) {
      const batch = missing.slice(start, start + BATCH);
      const query = new URLSearchParams({
        part: "snippet,statistics",
        fields: "items(id,snippet/publishedAt,statistics(viewCount,likeCount))",
        id: batch.join(","),
        key: apiKey
      });
      let response;
      try {
        response = await fetch(`${ENDPOINT}?${query}`, { signal, credentials: "omit" });
      } catch (error) {
        signal.throwIfAborted();
        throw new Error(`Could not reach the YouTube Data API: ${error instanceof Error ? error.message : String(error)}`);
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(failure(response.status, body));
      const items = body?.items;
      if (!Array.isArray(items)) throw new Error("The YouTube Data API returned an unexpected response.");
      for (const item of items) {
        if (typeof item.id !== "string") continue;
        const published = typeof item.snippet?.publishedAt === "string" ? Date.parse(item.snippet.publishedAt) : NaN;
        cache.set(item.id, {
          views: count(item.statistics?.viewCount),
          likes: count(item.statistics?.likeCount),
          uploadedAt: Number.isFinite(published) ? published : null
        });
      }
      for (const id of batch) if (!cache.has(id)) cache.set(id, { views: null, likes: null, uploadedAt: null });
    }
    return new Map(videoIds.flatMap((id) => cache.has(id) ? [[id, cache.get(id)]] : []));
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
    let moves = 0;
    for (let position = initial.currentIndex + 1; position < target.length; position++) {
      signal.throwIfAborted();
      const before = readSnapshot(panel);
      checkSession(before, initial);
      if (!sameOrder(ids(before), expected)) {
        throw new Error("The queue changed while sorting. Completed moves remain applied; try again.");
      }
      if (expected[position] === target[position]) continue;
      const from = expected.indexOf(target[position]);
      const row = before.rows[from];
      const oldNext = row.nextSibling;
      const nextOrder = [...expected];
      nextOrder.splice(position, 0, nextOrder.splice(from, 1)[0]);
      const reorder = before.controller.ytReorderableController;
      before.container.insertBefore(row, before.rows[position]);
      try {
        reorder.handleDrop({ currDragItem: row });
      } catch (error) {
        restoreVisualIfUnchanged(before, row, oldNext, expected);
        throw new Error(`YouTube\u2019s native move failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const deadline = Date.now() + 3500;
      let confirmed = false;
      try {
        while (Date.now() < deadline) {
          await delay(100);
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
      report(`Sorting: ${position - initial.currentIndex}/${target.length - initial.currentIndex - 1} upcoming positions checked\u2026`);
      await delay(350);
    }
    signal.throwIfAborted();
    const final = readSnapshot(panel);
    checkSession(final, initial);
    if (!sameOrder(ids(final), target)) throw new Error("YouTube changed the order before verification finished. Try again.");
    return moves;
  }
  function removeEndpoint(entry, id, playlistId) {
    const items = record(record(entry.menu)?.menuRenderer)?.items;
    for (const item of Array.isArray(items) ? items : []) {
      const endpoint = record(record(record(item)?.menuServiceItemRenderer)?.serviceEndpoint);
      const edit = record(endpoint?.playlistEditEndpoint);
      const actions = Array.isArray(edit?.actions) ? edit.actions : [];
      const action = record(actions[0]);
      if (actions.length === 1 && action?.action === "ACTION_REMOVE_VIDEO" && action.setVideoId === id && edit?.playlistId === playlistId) return endpoint;
    }
    return void 0;
  }
  async function removeItems(panel, initial, remove, signal, report) {
    const playlistId = initial.playlistId;
    const currentId = initial.items[initial.currentIndex].id;
    let expected = ids(initial);
    if (remove.includes(currentId) || new Set(remove).size !== remove.length || remove.some((id) => !expected.includes(id))) {
      throw new Error("The requested removals no longer match this queue.");
    }
    const app = document.querySelector("ytd-app");
    const resolver = app && typeof app.resolveCommand !== "function" ? controllerOf(app) : app;
    if (typeof resolver?.resolveCommand !== "function") throw new Error("YouTube\u2019s command handler is unavailable here.");
    const sameSession = (snapshot) => {
      if (snapshot.playlistId !== playlistId || snapshot.items[snapshot.currentIndex]?.id !== currentId) {
        throw new Error("Playback or the queue changed. Removing stopped; completed removals remain applied.");
      }
    };
    let removed = 0;
    for (const id of remove) {
      signal.throwIfAborted();
      const before = readSnapshot(panel);
      sameSession(before);
      if (!sameOrder(ids(before), expected)) {
        throw new Error("The queue changed while removing. Completed removals remain applied; try again.");
      }
      const endpoint = removeEndpoint(before.entries[expected.indexOf(id)], id, playlistId);
      if (!endpoint) throw new Error("YouTube offers no remove action for a video here. Removing stopped.");
      const nextOrder = expected.filter((other) => other !== id);
      try {
        resolver.resolveCommand(endpoint);
      } catch (error) {
        throw new Error(`YouTube\u2019s native removal failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const deadline = Date.now() + 3500;
      let confirmed = false;
      while (Date.now() < deadline) {
        await delay(100);
        signal.throwIfAborted();
        let after;
        try {
          after = readSnapshot(panel);
        } catch {
          continue;
        }
        sameSession(after);
        if (sameOrder(ids(after), nextOrder)) {
          confirmed = true;
          break;
        }
        if (!sameOrder(ids(after), expected)) {
          throw new Error("Unexpected queue change after a native removal. Removing stopped.");
        }
      }
      if (!confirmed) throw new Error("YouTube did not confirm the removal in its queue data. Removing stopped.");
      expected = nextOrder;
      removed++;
      report(`Removing: ${removed}/${remove.length} videos\u2026`);
      await delay(350);
    }
    return removed;
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
  var names = { duration: "Duration", title: "Title", views: "Views", likes: "Likes", uploaded: "Uploaded" };
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
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
    :host { display: block; padding: 4px 8px; color: var(--yt-spec-text-secondary, #aaa); font: 11px/1.4 system-ui, sans-serif; }
    button { border: 1px solid var(--yt-spec-10-percent-layer, #555); border-radius: 4px; padding: 3px 7px; margin: 0 4px 4px 0; background: transparent; color: inherit; font: 400 11px/16px system-ui, sans-serif; cursor: pointer; }
    button[aria-pressed="true"] { color: var(--yt-spec-text-primary, #eee); }
    button:disabled { opacity: .5; cursor: default; }
    button[hidden], .settings[hidden], .confirm[hidden] { display: none; }
    button:hover:enabled { background: var(--yt-spec-badge-chip-background, #333); color: var(--yt-spec-text-primary, #eee); }
    button:focus-visible, input:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
    .save { display: inline-flex; align-items: center; gap: 4px; vertical-align: top; }
    .save svg { width: 14px; height: 14px; fill: currentColor; }
    .settings label { display: block; margin: 3px 0; }
    .settings input[type="password"] { display: block; box-sizing: border-box; width: 100%; max-width: 320px; margin-top: 2px; padding: 3px 6px; border: 1px solid var(--yt-spec-10-percent-layer, #555); border-radius: 4px; background: transparent; color: var(--yt-spec-text-primary, #eee); font: inherit; }
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
    const removeWatched = makeButton("Remove watched");
    removeWatched.dataset.action = "watched";
    const gear = makeButton("\u2699");
    gear.dataset.action = "settings";
    gear.title = "Sort settings";
    gear.setAttribute("aria-label", "Sort settings");
    gear.setAttribute("aria-expanded", "false");
    const form = document.createElement("div");
    form.className = "settings";
    form.hidden = true;
    const field = (name, type, text) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = type;
      input.dataset.setting = name;
      if (type === "checkbox") label.append(input, ` ${text}`);
      else label.append(text, input);
      form.append(label);
      return input;
    };
    const fetchBox = field("fetch", "checkbox", "Fetch views, likes and upload dates when one of those sorts is clicked");
    const keyInput = field("apiKey", "password", "YouTube Data API key");
    keyInput.autocomplete = "off";
    keyInput.spellcheck = false;
    const dedupeBox = field("dedupe", "checkbox", "Remove repeated videos when sorting");
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
    root.append(style, save, ...buttons.values(), removeWatched, gear, confirmBar, status, form);
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
        save.replaceChildren(...icon ? [icon.cloneNode(true)] : [], label);
      }
      save.setAttribute("aria-label", native.button.getAttribute("aria-label") || label);
      save.title = native.button.getAttribute("aria-label") || label;
      save.disabled = running !== null;
    }
    function fillSettings() {
      settings = loadSettings();
      const available = storageAvailable();
      fetchBox.checked = settings.fetch;
      keyInput.value = settings.apiKey;
      dedupeBox.checked = settings.dedupe;
      for (const input of [fetchBox, keyInput, dedupeBox]) input.disabled = !available;
      hint.textContent = available ? "Fetching costs 1 API quota unit per 50 videos. Your userscript manager stores the key; YouTube cannot read it." : "Settings need the userscript manager\u2019s storage permission. Reinstall the script to grant it.";
    }
    gear.addEventListener("click", () => {
      form.hidden = !form.hidden;
      gear.setAttribute("aria-expanded", String(!form.hidden));
      if (!form.hidden) fillSettings();
    });
    for (const input of [fetchBox, keyInput, dedupeBox]) input.addEventListener("input", () => {
      settings = { apiKey: keyInput.value.trim(), fetch: fetchBox.checked, dedupe: dedupeBox.checked };
      try {
        saveSettings(settings);
      } catch (error) {
        report(error instanceof Error ? error.message : String(error), true);
      }
      refreshControls();
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
          fetched.has(key) ? "Details come from the YouTube Data API when clicked." : "",
          settings.dedupe && step !== "undo" ? "Repeated upcoming videos are removed first." : ""
        ].filter(Boolean).join(" ");
      }
      if (!removeWatched.dataset.running) {
        const count2 = snapshot ? watchedIds(snapshot.items, snapshot.currentIndex).length : 0;
        removeWatched.textContent = "Remove watched";
        removeWatched.disabled = running !== null || count2 === 0;
        const action = count2 === 0 ? "No loaded videos show watch progress." : `Remove ${plural(count2, "video")} that YouTube shows as started from this ${saved ? "saved playlist" : "queue"}. The current video stays.`;
        removeWatched.setAttribute("aria-label", problem || action);
        removeWatched.title = problem || action;
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
      await removeItems(panel, snapshot, targets, signal, report);
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
        if (repeats.length > 0) {
          if (!await remove(snapshot, repeats, signal)) {
            report("Cancelled. Nothing was changed.");
            return;
          }
          snapshot = readSnapshot(panel);
          baseline = baseline.filter((id) => !repeats.includes(id));
        }
        const removedNote = repeats.length > 0 ? `Removed ${plural(repeats.length, "repeated video")}. ` : "";
        let items = snapshot.items;
        const upcomingIds = new Set(ids2(snapshot).slice(snapshot.currentIndex + 1));
        if (upcomingIds.size < 2) {
          report(`${removedNote}Load at least two upcoming videos to sort.`, true);
          return;
        }
        if (step !== "undo" && fetched.has(key)) {
          if (!canFetch()) throw new Error("Turn on fetching and enter an API key in the sort settings.");
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
