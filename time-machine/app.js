// NBA Time Machine
//
// Vanilla JS. Animated season-by-season shot chart playback.
// Reuses the same data layer as Shot Chart Studio: fetches per-player
// shards from cdechoch/nba-data-archive on HuggingFace, decodes the
// column-oriented format, then renders one season at a time on a
// half-court SVG with a timeline scrubber.

// ---------- Constants ----------
const HF_DATASET_BASE =
  "https://huggingface.co/datasets/cdechoch/nba-data-archive/resolve/main/shot-chart-shards";

const CATALOG_URL = `${HF_DATASET_BASE}/players.json`;

function shardUrl(pid) {
  const prefix = Math.floor(Number(pid) / 100);
  return `${HF_DATASET_BASE}/players/${prefix}/${pid}.json`;
}

const COURT = {
  width: 500,
  height: 470,
  rimX: 250,
  rimY: 52.5,
  rimRadius: 7.5,
  paintWidth: 160,
  paintHeight: 190,
  ftCircleR: 60,
  threeR: 237.5,
  cornerThreeY: 140,
  cornerThreeX: 220,
  restrictedR: 40,
};

const ZONE_LEAGUE_AVG = {
  "Restricted Area": 0.62,
  "In The Paint (Non-RA)": 0.42,
  "Mid-Range": 0.40,
  "Above the Break 3": 0.355,
  "Left Corner 3": 0.385,
  "Right Corner 3": 0.385,
  "Backcourt": 0.03,
};
const DEFAULT_ZONE_AVG = 0.42;
const DELTA_RANGE = 0.10;

// Animation timing. One "tick" advances one season. At 1x speed, we hold
// each season for SEASON_HOLD_MS milliseconds, with a short fade in/out.
const SEASON_HOLD_MS = 1100;
const TRAIL_SEASONS = 3;  // how many prior seasons to keep visible in trail mode

// ---------- State ----------
const STATE = {
  catalog: null,
  playerList: [],
  selectedPid: null,
  selectedName: null,
  rawShard: null,
  flat: [],
  seasons: [],          // sorted unique season list for the current player
  seasonIndex: 0,       // current pointer in `seasons`
  shotsBySeason: new Map(),  // season -> shot array
  filters: {
    rg: true,
    po: true,
    view: "dots",
    mode: "keyframe",
  },
  playing: false,
  playTimer: null,
  speed: 1,
  comboOpen: false,
  comboActive: -1,
};

let INITIAL_URL_APPLIED = false;

// ---------- Utilities ----------
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function headshotUrl(pid) {
  return `https://cdn.nba.com/headshots/nba/latest/1040x760/${pid}.png`;
}

function slugify(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function pidFromSlug(s) {
  const m = String(s || "").match(/-(\d+)$/);
  return m ? m[1] : null;
}

// "2024-25" style season label from a start year.
function seasonLabel(year) {
  const next = ((year + 1) % 100).toString().padStart(2, "0");
  return `${year}-${next}`;
}

function pageTitleFor(name) {
  return name ? `${name} Time Machine - HoopsMatic` : "NBA Time Machine - HoopsMatic";
}

// ---------- URL state ----------
function readUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const result = {};
  if (p.has("player")) result.player = p.get("player");
  if (p.has("season")) result.season = parseInt(p.get("season"), 10);
  if (p.has("view")) result.view = p.get("view");
  if (p.has("mode")) result.mode = p.get("mode");
  if (p.has("rg")) result.rg = p.get("rg") === "1";
  if (p.has("po")) result.po = p.get("po") === "1";
  if (p.has("speed")) result.speed = parseFloat(p.get("speed"));
  return result;
}

function writeUrlParams() {
  const p = new URLSearchParams();
  if (STATE.selectedPid) {
    const name = STATE.selectedName || STATE.catalog[String(STATE.selectedPid)]?.name || "";
    const slug = slugify(name);
    p.set("player", slug ? `${slug}-${STATE.selectedPid}` : String(STATE.selectedPid));
  }
  if (STATE.seasons.length && STATE.seasonIndex >= 0) {
    p.set("season", STATE.seasons[STATE.seasonIndex]);
  }
  if (STATE.filters.view !== "dots") p.set("view", STATE.filters.view);
  if (STATE.filters.mode !== "keyframe") p.set("mode", STATE.filters.mode);
  if (!STATE.filters.rg) p.set("rg", "0");
  if (!STATE.filters.po) p.set("po", "0");
  if (STATE.speed !== 1) p.set("speed", STATE.speed);
  const qs = p.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

// ---------- Fetching ----------
async function fetchJson(url, label) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${label}: HTTP ${r.status}`);
  return r.json();
}

async function loadCatalog() {
  return fetchJson(CATALOG_URL, "catalog");
}

async function loadShard(pid) {
  return fetchJson(shardUrl(pid), `shard for ${pid}`);
}

function buildPlayerIndex(catalog) {
  const list = [];
  for (const [pid, p] of Object.entries(catalog)) {
    const slug = slugify(p.name);
    list.push([pid, p.name.toLowerCase(), p.name, p.shot_count, p.first_season, p.last_season, slug]);
  }
  return list;
}

function decodeShard(shard) {
  const cols = shard.shots;
  const n = cols.x.length;
  const zoneCodes = shard.zone_codes || [];
  const flat = new Array(n);
  for (let i = 0; i < n; i++) {
    flat[i] = {
      x: cols.x[i],
      y: cols.y[i],
      made: cols.m[i] === 1,
      three: cols["3"][i] === 1,
      season: cols.s[i],
      po: cols.po[i] === 1,
      period: cols.p[i],
      zone: zoneCodes[cols.z[i]] || "",
    };
  }
  return flat;
}

// Build a season -> shots map honoring the current scope (RG/PO).
function rebuildSeasonBuckets() {
  const map = new Map();
  for (const s of STATE.flat) {
    if (s.po && !STATE.filters.po) continue;
    if (!s.po && !STATE.filters.rg) continue;
    if (!map.has(s.season)) map.set(s.season, []);
    map.get(s.season).push(s);
  }
  STATE.shotsBySeason = map;
  STATE.seasons = Array.from(map.keys()).sort((a, b) => a - b);
}

// ---------- Court rendering ----------
function drawCourtLines() {
  const svg = $("#court");
  svg.innerHTML = "";
  const NS = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "court-lines");

  const outer = document.createElementNS(NS, "rect");
  outer.setAttribute("x", 0); outer.setAttribute("y", 0);
  outer.setAttribute("width", COURT.width); outer.setAttribute("height", COURT.height);
  g.appendChild(outer);

  const paint = document.createElementNS(NS, "rect");
  paint.setAttribute("x", COURT.rimX - COURT.paintWidth / 2);
  paint.setAttribute("y", 0);
  paint.setAttribute("width", COURT.paintWidth);
  paint.setAttribute("height", COURT.paintHeight);
  g.appendChild(paint);

  const ftc = document.createElementNS(NS, "circle");
  ftc.setAttribute("cx", COURT.rimX);
  ftc.setAttribute("cy", COURT.paintHeight);
  ftc.setAttribute("r", COURT.ftCircleR);
  g.appendChild(ftc);

  const ra = document.createElementNS(NS, "path");
  ra.setAttribute("d", `M ${COURT.rimX - COURT.restrictedR} ${COURT.rimY} A ${COURT.restrictedR} ${COURT.restrictedR} 0 0 0 ${COURT.rimX + COURT.restrictedR} ${COURT.rimY}`);
  g.appendChild(ra);

  const rim = document.createElementNS(NS, "circle");
  rim.setAttribute("cx", COURT.rimX); rim.setAttribute("cy", COURT.rimY);
  rim.setAttribute("r", COURT.rimRadius);
  rim.setAttribute("class", "court-rim");
  g.appendChild(rim);

  const bb = document.createElementNS(NS, "line");
  bb.setAttribute("x1", COURT.rimX - 30); bb.setAttribute("y1", 40);
  bb.setAttribute("x2", COURT.rimX + 30); bb.setAttribute("y2", 40);
  g.appendChild(bb);

  const lcX = COURT.rimX - COURT.cornerThreeX;
  const rcX = COURT.rimX + COURT.cornerThreeX;
  const ll = document.createElementNS(NS, "line");
  ll.setAttribute("x1", lcX); ll.setAttribute("y1", 0);
  ll.setAttribute("x2", lcX); ll.setAttribute("y2", COURT.cornerThreeY);
  g.appendChild(ll);
  const rl = document.createElementNS(NS, "line");
  rl.setAttribute("x1", rcX); rl.setAttribute("y1", 0);
  rl.setAttribute("x2", rcX); rl.setAttribute("y2", COURT.cornerThreeY);
  g.appendChild(rl);

  const arc = document.createElementNS(NS, "path");
  arc.setAttribute(
    "d",
    `M ${lcX} ${COURT.cornerThreeY} A ${COURT.threeR} ${COURT.threeR} 0 0 0 ${rcX} ${COURT.cornerThreeY}`
  );
  g.appendChild(arc);

  const half = document.createElementNS(NS, "line");
  half.setAttribute("x1", 0); half.setAttribute("y1", COURT.height);
  half.setAttribute("x2", COURT.width); half.setAttribute("y2", COURT.height);
  half.setAttribute("class", "court-rim");
  g.appendChild(half);

  const center = document.createElementNS(NS, "path");
  center.setAttribute(
    "d",
    `M ${COURT.rimX - 60} ${COURT.height} A 60 60 0 0 1 ${COURT.rimX + 60} ${COURT.height}`
  );
  g.appendChild(center);

  svg.appendChild(g);
}

function mapShot(s) {
  return { sx: COURT.rimX + s.x, sy: COURT.rimY + s.y };
}

// ---------- Shot rendering ----------
//
// We always remove the previous shot-layer before drawing a new one, so
// repeated renderAll() calls don't pile up SVG elements.
function clearShotLayer() {
  const svg = $("#court");
  const old = svg.querySelector(".shot-layer");
  if (old) old.remove();
}

function appendShotLayer() {
  const svg = $("#court");
  const NS = "http://www.w3.org/2000/svg";
  const layer = document.createElementNS(NS, "g");
  layer.setAttribute("class", "shot-layer");
  svg.appendChild(layer);
  return layer;
}

function renderDotsSet(layer, shots, opacity) {
  const NS = "http://www.w3.org/2000/svg";
  const n = shots.length;
  const r = n > 4000 ? 1.8 : n > 1500 ? 2.2 : 2.8;
  // Draw misses first then makes.
  const misses = [];
  const makes = [];
  for (const s of shots) {
    if (s.made) makes.push(s); else misses.push(s);
  }
  for (const set of [misses, makes]) {
    for (const s of set) {
      const { sx, sy } = mapShot(s);
      if (sx < 0 || sx > COURT.width || sy < 0 || sy > COURT.height) continue;
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", sx);
      c.setAttribute("cy", sy);
      c.setAttribute("r", r);
      c.setAttribute("class", s.made ? "shot-made" : "shot-missed");
      if (opacity != null && opacity !== 1) c.setAttribute("opacity", opacity);
      layer.appendChild(c);
    }
  }
}

function rampColor(t) {
  if (t < 0.5) {
    const k = t / 0.5;
    return `rgb(${Math.round(201 + (240 - 201) * k)},${Math.round(48 + (240 - 48) * k)},${Math.round(74 + (240 - 74) * k)})`;
  } else {
    const k = (t - 0.5) / 0.5;
    return `rgb(${Math.round(240 + (31 - 240) * k)},${Math.round(240 + (157 - 240) * k)},${Math.round(240 + (85 - 240) * k)})`;
  }
}

function hexColor(fgp, zoneAvg) {
  if (fgp == null) return "#cccccc";
  const baseline = (zoneAvg == null) ? DEFAULT_ZONE_AVG : zoneAvg;
  const delta = Math.max(-DELTA_RANGE, Math.min(DELTA_RANGE, fgp - baseline));
  const t = (delta + DELTA_RANGE) / (2 * DELTA_RANGE);
  return rampColor(t);
}

function renderHexSet(layer, shots, opacity) {
  const NS = "http://www.w3.org/2000/svg";
  const hexSize = 13;
  const hexW = Math.sqrt(3) * hexSize;
  const hexH = 2 * hexSize;
  const vertSpace = hexH * 0.75;
  const bins = new Map();
  for (const s of shots) {
    const { sx, sy } = mapShot(s);
    if (sx < 0 || sx > COURT.width || sy < 0 || sy > COURT.height) continue;
    const row = Math.floor(sy / vertSpace);
    const colOffset = row % 2 === 0 ? 0 : hexW / 2;
    const col = Math.floor((sx - colOffset) / hexW);
    const key = `${row}:${col}`;
    let b = bins.get(key);
    if (!b) {
      b = { row, col, made: 0, total: 0, cx: 0, cy: 0, zones: {} };
      bins.set(key, b);
    }
    b.total++;
    if (s.made) b.made++;
    b.cx += sx; b.cy += sy;
    if (s.zone) b.zones[s.zone] = (b.zones[s.zone] || 0) + 1;
  }
  let maxCount = 0;
  for (const b of bins.values()) if (b.total > maxCount) maxCount = b.total;
  for (const b of bins.values()) {
    if (b.total < 2) continue;
    const cx = b.cx / b.total;
    const cy = b.cy / b.total;
    const fgp = b.made / b.total;
    let bestZone = null, bestCount = 0;
    for (const [z, c] of Object.entries(b.zones)) {
      if (c > bestCount) { bestZone = z; bestCount = c; }
    }
    const zoneAvg = bestZone ? ZONE_LEAGUE_AVG[bestZone] : DEFAULT_ZONE_AVG;
    const size = hexSize * (0.45 + 0.55 * Math.min(1, b.total / Math.max(8, maxCount / 4)));
    const poly = document.createElementNS(NS, "polygon");
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI / 6 + (Math.PI / 3) * i;
      pts.push(`${cx + size * Math.cos(angle)},${cy + size * Math.sin(angle)}`);
    }
    poly.setAttribute("points", pts.join(" "));
    poly.setAttribute("class", "hex");
    poly.setAttribute("fill", hexColor(fgp, zoneAvg));
    if (opacity != null && opacity !== 1) poly.setAttribute("opacity", opacity);
    layer.appendChild(poly);
  }
}

// ---------- Per-frame render ----------
function renderFrame() {
  if (STATE.seasons.length === 0) return;
  if (STATE.seasonIndex < 0) STATE.seasonIndex = 0;
  if (STATE.seasonIndex >= STATE.seasons.length) STATE.seasonIndex = STATE.seasons.length - 1;

  const currentSeason = STATE.seasons[STATE.seasonIndex];
  const currentShots = STATE.shotsBySeason.get(currentSeason) || [];

  clearShotLayer();
  const layer = appendShotLayer();

  if (STATE.filters.mode === "trail") {
    // Render up to TRAIL_SEASONS prior seasons at decreasing opacity,
    // then the current season at full opacity on top.
    for (let offset = TRAIL_SEASONS; offset >= 1; offset--) {
      const idx = STATE.seasonIndex - offset;
      if (idx < 0) continue;
      const yr = STATE.seasons[idx];
      const shots = STATE.shotsBySeason.get(yr) || [];
      const op = 0.18 * (1 - (offset - 1) / TRAIL_SEASONS) + 0.05;
      if (STATE.filters.view === "hex") {
        renderHexSet(layer, shots, op);
      } else {
        renderDotsSet(layer, shots, op);
      }
    }
  }

  // Current season on top.
  if (STATE.filters.view === "hex") {
    renderHexSet(layer, currentShots, 1);
  } else {
    renderDotsSet(layer, currentShots, 1);
  }

  // Update season label + stats.
  $("#season-overlay-label").textContent = seasonLabel(currentSeason);
  recomputeStats(currentShots);

  // Sync scrubber.
  const scrubber = $("#scrubber");
  if (Number(scrubber.value) !== STATE.seasonIndex) {
    scrubber.value = STATE.seasonIndex;
  }
  updateScrubberMarks();

  writeUrlParams();
}

// ---------- Stats ----------
function recomputeStats(shots) {
  let total = shots.length;
  let made = 0;
  let threeAtt = 0;
  let threeMade = 0;
  for (const s of shots) {
    if (s.made) made++;
    if (s.three) {
      threeAtt++;
      if (s.made) threeMade++;
    }
  }
  const fgp = total ? made / total : 0;
  const efg = total ? (made + 0.5 * threeMade) / total : 0;
  const threeP = threeAtt ? threeMade / threeAtt : 0;

  $("#stat-shots").textContent = total.toLocaleString();
  $("#stat-made").textContent = made.toLocaleString();
  $("#stat-fgp").textContent = (fgp * 100).toFixed(1) + "%";
  $("#stat-efg").textContent = (efg * 100).toFixed(1) + "%";
  $("#stat-3pt").textContent = `${threeMade}/${threeAtt}`;
  $("#stat-3pp").textContent = (threeP * 100).toFixed(1) + "%";
}

// ---------- Scrubber + season marks ----------
function updateScrubberMarks() {
  const wrap = $("#scrubber-marks");
  if (STATE.seasons.length === 0) {
    wrap.innerHTML = "";
    return;
  }
  // Show first, last, and roughly evenly spaced years in between.
  // For short careers (<6 seasons) just show every year.
  const seasons = STATE.seasons;
  let marks;
  if (seasons.length <= 6) {
    marks = seasons.map((y, i) => ({ year: y, idx: i }));
  } else {
    const step = (seasons.length - 1) / 5;
    const idxs = new Set();
    for (let k = 0; k <= 5; k++) idxs.add(Math.round(k * step));
    marks = Array.from(idxs).sort((a, b) => a - b).map(i => ({ year: seasons[i], idx: i }));
  }
  wrap.innerHTML = marks.map(m =>
    `<span class="mark" data-idx="${m.idx}" title="${seasonLabel(m.year)}">${m.year}</span>`
  ).join("");
}

// ---------- Animation loop ----------
function startPlayback() {
  STATE.playing = true;
  $("#play-toggle").classList.add("playing");
  $("#play-toggle").setAttribute("aria-label", "Pause");

  const tick = () => {
    if (!STATE.playing) return;
    if (STATE.seasonIndex >= STATE.seasons.length - 1) {
      // End of timeline: stop. (Could loop here if desired.)
      stopPlayback();
      return;
    }
    STATE.seasonIndex++;
    renderFrame();
    STATE.playTimer = setTimeout(tick, SEASON_HOLD_MS / STATE.speed);
  };

  STATE.playTimer = setTimeout(tick, SEASON_HOLD_MS / STATE.speed);
}

function stopPlayback() {
  STATE.playing = false;
  if (STATE.playTimer) {
    clearTimeout(STATE.playTimer);
    STATE.playTimer = null;
  }
  $("#play-toggle").classList.remove("playing");
  $("#play-toggle").setAttribute("aria-label", "Play");
}

// ---------- Combo / autocomplete ----------
function openCombo() {
  STATE.comboOpen = true;
  $("#player-results").hidden = false;
  $(".combo").setAttribute("aria-expanded", "true");
}
function closeCombo() {
  STATE.comboOpen = false;
  STATE.comboActive = -1;
  $("#player-results").hidden = true;
  $(".combo").setAttribute("aria-expanded", "false");
}
function renderComboResults(query) {
  const ul = $("#player-results");
  const q = query.trim().toLowerCase();
  let results;
  if (q.length === 0) {
    results = STATE.playerList.slice().sort((a, b) => b[3] - a[3]).slice(0, 20);
  } else {
    results = STATE.playerList
      .filter(p => p[1].includes(q))
      .sort((a, b) => {
        const ai = a[1].startsWith(q) ? 0 : 1;
        const bi = b[1].startsWith(q) ? 0 : 1;
        if (ai !== bi) return ai - bi;
        return b[3] - a[3];
      })
      .slice(0, 30);
  }
  if (results.length === 0) {
    ul.innerHTML = '<li class="combo-result" aria-disabled="true" style="color: var(--muted); cursor: default">No players match.</li>';
  } else {
    ul.innerHTML = results.map(([pid, _l, name, count, first, last]) => `
      <li class="combo-result" role="option" data-pid="${pid}">
        <img loading="lazy" alt="" src="${headshotUrl(pid)}"
             onerror="this.style.visibility='hidden'">
        <span class="r-name">${escapeHtml(name)}</span>
        <span class="r-meta">${first}-${String(last).slice(2)}, ${count.toLocaleString()} shots</span>
      </li>
    `).join("");
  }
  STATE.comboActive = -1;
  openCombo();
}
function selectComboItem(el) {
  if (!el || !el.dataset.pid) return;
  const pid = el.dataset.pid;
  closeCombo();
  $("#player-search").value = el.querySelector(".r-name")?.textContent || "";
  loadPlayer(pid);
}
function setActiveCombo(delta) {
  const items = $$(".combo-result[data-pid]");
  if (items.length === 0) return;
  let i = STATE.comboActive + delta;
  if (i < 0) i = items.length - 1;
  if (i >= items.length) i = 0;
  items.forEach((el, idx) => el.setAttribute("aria-selected", idx === i ? "true" : "false"));
  items[i].scrollIntoView({ block: "nearest" });
  STATE.comboActive = i;
}

// ---------- Player loading ----------
async function loadPlayer(pid) {
  stopPlayback();
  STATE.selectedPid = pid;
  STATE.selectedName = STATE.catalog[String(pid)]?.name || "";
  $("#loading-state").hidden = false;
  $("#loading-state").textContent = "Loading shots\u2026";
  $("#chart-area").hidden = true;
  $("#timeline-panel").hidden = true;
  $("#empty-state").hidden = true;

  try {
    const shard = await loadShard(pid);
    STATE.rawShard = shard;
    STATE.flat = decodeShard(shard);
    rebuildSeasonBuckets();

    if (STATE.seasons.length === 0) {
      $("#loading-state").textContent = "No shots in the current scope.";
      return;
    }

    // Apply URL params on first load only.
    if (!INITIAL_URL_APPLIED) {
      const u = readUrlParams();
      if (u.season != null) {
        const idx = STATE.seasons.indexOf(u.season);
        STATE.seasonIndex = idx >= 0 ? idx : 0;
      } else {
        STATE.seasonIndex = 0;
      }
      INITIAL_URL_APPLIED = true;
    } else {
      STATE.seasonIndex = 0;
    }

    $("#stats-name").textContent = shard.name;
    $("#stats-meta").textContent =
      `${STATE.seasons[0]}-${STATE.seasons[STATE.seasons.length - 1]} - ${shard.shot_count.toLocaleString()} career shots`;
    document.title = pageTitleFor(shard.name);

    let metaDesc = document.querySelector('meta[name="description"]');
    if (!metaDesc) {
      metaDesc = document.createElement("meta");
      metaDesc.setAttribute("name", "description");
      document.head.appendChild(metaDesc);
    }
    metaDesc.setAttribute(
      "content",
      `Animated career shot chart for ${shard.name}, season by season from ${STATE.seasons[0]} to ${STATE.seasons[STATE.seasons.length - 1]}.`
    );

    // Update scrubber range.
    const scrubber = $("#scrubber");
    scrubber.min = 0;
    scrubber.max = STATE.seasons.length - 1;
    scrubber.value = STATE.seasonIndex;

    $("#loading-state").hidden = true;
    $("#chart-area").hidden = false;
    $("#timeline-panel").hidden = false;

    drawCourtLines();
    renderFrame();
  } catch (e) {
    console.error(e);
    $("#loading-state").textContent = `Could not load this player. ${e.message || e}`;
  }
}

// ---------- Event wiring ----------
function wireEvents() {
  const search = $("#player-search");
  search.addEventListener("focus", () => renderComboResults(search.value));
  search.addEventListener("input", debounce(() => renderComboResults(search.value), 120));
  search.addEventListener("keydown", (e) => {
    if (!STATE.comboOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      renderComboResults(search.value);
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveCombo(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveCombo(-1); }
    else if (e.key === "Enter") {
      const items = $$(".combo-result[data-pid]");
      const active = items[STATE.comboActive] || items[0];
      if (active) { e.preventDefault(); selectComboItem(active); }
    } else if (e.key === "Escape") { closeCombo(); }
  });
  $("#player-results").addEventListener("click", (e) => {
    const item = e.target.closest(".combo-result[data-pid]");
    if (item) selectComboItem(item);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".panel-picker")) closeCombo();
  });
  $("#player-clear").addEventListener("click", () => {
    search.value = "";
    search.focus();
    renderComboResults("");
  });

  // View / mode toggles
  $$('[data-view]').forEach(b => {
    b.addEventListener("click", () => {
      STATE.filters.view = b.dataset.view;
      $$('[data-view]').forEach(x => x.classList.toggle("active", x === b));
      renderFrame();
    });
  });
  $$('[data-mode]').forEach(b => {
    b.addEventListener("click", () => {
      STATE.filters.mode = b.dataset.mode;
      $$('[data-mode]').forEach(x => x.classList.toggle("active", x === b));
      renderFrame();
    });
  });

  // Scope checkboxes
  $("#scope-rg").addEventListener("change", (e) => {
    STATE.filters.rg = e.target.checked;
    rebuildSeasonBuckets();
    if (STATE.seasonIndex >= STATE.seasons.length) STATE.seasonIndex = STATE.seasons.length - 1;
    const scrubber = $("#scrubber");
    scrubber.max = Math.max(0, STATE.seasons.length - 1);
    renderFrame();
  });
  $("#scope-po").addEventListener("change", (e) => {
    STATE.filters.po = e.target.checked;
    rebuildSeasonBuckets();
    if (STATE.seasonIndex >= STATE.seasons.length) STATE.seasonIndex = STATE.seasons.length - 1;
    const scrubber = $("#scrubber");
    scrubber.max = Math.max(0, STATE.seasons.length - 1);
    renderFrame();
  });

  // Playback controls
  $("#play-toggle").addEventListener("click", () => {
    if (STATE.playing) {
      stopPlayback();
    } else {
      // If at the end, restart from beginning.
      if (STATE.seasonIndex >= STATE.seasons.length - 1) {
        STATE.seasonIndex = 0;
        renderFrame();
      }
      startPlayback();
    }
  });
  $("#prev-season").addEventListener("click", () => {
    stopPlayback();
    if (STATE.seasonIndex > 0) {
      STATE.seasonIndex--;
      renderFrame();
    }
  });
  $("#next-season").addEventListener("click", () => {
    stopPlayback();
    if (STATE.seasonIndex < STATE.seasons.length - 1) {
      STATE.seasonIndex++;
      renderFrame();
    }
  });
  $("#scrubber").addEventListener("input", (e) => {
    stopPlayback();
    STATE.seasonIndex = Number(e.target.value);
    renderFrame();
  });
  $("#scrubber-marks").addEventListener("click", (e) => {
    const mark = e.target.closest(".mark[data-idx]");
    if (mark) {
      stopPlayback();
      STATE.seasonIndex = Number(mark.dataset.idx);
      renderFrame();
    }
  });
  $("#speed-select").addEventListener("change", (e) => {
    STATE.speed = Number(e.target.value);
    if (STATE.playing) {
      stopPlayback();
      startPlayback();
    }
    writeUrlParams();
  });

  $("#copy-link").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      $("#copy-status").textContent = "Copied.";
      setTimeout(() => { $("#copy-status").textContent = ""; }, 2000);
    } catch {
      $("#copy-status").textContent = "Press Ctrl+C to copy.";
    }
  });

  // Keyboard shortcuts: space = play/pause, left/right = step
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === " ") {
      e.preventDefault();
      $("#play-toggle").click();
    } else if (e.key === "ArrowLeft") {
      $("#prev-season").click();
    } else if (e.key === "ArrowRight") {
      $("#next-season").click();
    }
  });
}

// ---------- Boot ----------
async function boot() {
  document.title = pageTitleFor(null);
  try {
    STATE.catalog = await loadCatalog();
    STATE.playerList = buildPlayerIndex(STATE.catalog);
    wireEvents();

    const u = readUrlParams();
    if (u.view) {
      STATE.filters.view = u.view;
      $$('[data-view]').forEach(b => b.classList.toggle("active", b.dataset.view === u.view));
    }
    if (u.mode) {
      STATE.filters.mode = u.mode;
      $$('[data-mode]').forEach(b => b.classList.toggle("active", b.dataset.mode === u.mode));
    }
    if (u.rg === false) {
      STATE.filters.rg = false;
      $("#scope-rg").checked = false;
    }
    if (u.po === false) {
      STATE.filters.po = false;
      $("#scope-po").checked = false;
    }
    if (u.speed) {
      STATE.speed = u.speed;
      $("#speed-select").value = String(u.speed);
    }

    if (u.player) {
      let pid = pidFromSlug(u.player);
      if (pid && !STATE.catalog[pid]) pid = null;
      if (!pid && /^\d+$/.test(u.player) && STATE.catalog[u.player]) pid = u.player;
      if (!pid) {
        const match = STATE.playerList.find(p => p[6] === slugify(u.player));
        if (match) pid = match[0];
      }
      if (pid) {
        $("#player-search").value = STATE.catalog[pid].name;
        await loadPlayer(pid);
      }
    }
  } catch (e) {
    console.error(e);
    $("#empty-state").textContent = `Could not load player catalog. ${e.message || e}`;
  }
}

boot();
