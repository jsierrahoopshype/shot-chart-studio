// Shot Chart Studio
//
// Vanilla JS. Single page. Picks a player, fetches their column-oriented
// shot shard, renders dots or hex bins on a half-court SVG with filters.

// ---------- Constants ----------
//
// Data lives on the HuggingFace dataset cdechoch/nba-data-archive, under
// shot-chart-shards/. HF serves /resolve/main/<path> with permissive CORS
// for simple GET requests, which is what we need.
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

const STATE = {
  catalog: null,
  playerList: [],
  slugIndex: new Map(),
  selectedPid: null,
  selectedName: null,
  rawShard: null,
  flat: [],
  filters: {
    seasonMin: 1996,
    seasonMax: 2025,
    rg: true,
    po: true,
    periods: { 1: true, 2: true, 3: true, 4: true, ot: true },
    made: true,
    missed: true,
    view: "dots",
  },
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

function pageTitleFor(name) {
  return name ? `${name} Shot Chart - HoopsMatic` : "Shot Chart Studio - HoopsMatic";
}

// ---------- URL state ----------
function readUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const result = {};
  if (p.has("player")) result.player = p.get("player");
  if (p.has("seasonMin")) result.seasonMin = parseInt(p.get("seasonMin"), 10);
  if (p.has("seasonMax")) result.seasonMax = parseInt(p.get("seasonMax"), 10);
  if (p.has("rg")) result.rg = p.get("rg") === "1";
  if (p.has("po")) result.po = p.get("po") === "1";
  if (p.has("periods")) result.periods = p.get("periods").split(",");
  if (p.has("result")) result.result = p.get("result").split(",");
  if (p.has("view")) result.view = p.get("view");
  return result;
}

function writeUrlParams() {
  const p = new URLSearchParams();
  if (STATE.selectedPid) {
    const name = STATE.selectedName || STATE.catalog[String(STATE.selectedPid)]?.name || "";
    const slug = slugify(name);
    p.set("player", slug ? `${slug}-${STATE.selectedPid}` : String(STATE.selectedPid));
  }
  const cat = STATE.selectedPid ? STATE.catalog[String(STATE.selectedPid)] : null;
  if (cat) {
    if (STATE.filters.seasonMin !== cat.first_season) p.set("seasonMin", STATE.filters.seasonMin);
    if (STATE.filters.seasonMax !== cat.last_season) p.set("seasonMax", STATE.filters.seasonMax);
  }
  if (!STATE.filters.rg) p.set("rg", "0");
  if (!STATE.filters.po) p.set("po", "0");
  const enabledPeriods = Object.entries(STATE.filters.periods)
    .filter(([, v]) => v).map(([k]) => k);
  if (enabledPeriods.length < 5) p.set("periods", enabledPeriods.join(","));
  const enabledResults = [];
  if (STATE.filters.made) enabledResults.push("made");
  if (STATE.filters.missed) enabledResults.push("missed");
  if (enabledResults.length < 2) p.set("result", enabledResults.join(","));
  if (STATE.filters.view !== "dots") p.set("view", STATE.filters.view);
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
  const slugIndex = new Map();
  for (const [pid, p] of Object.entries(catalog)) {
    const slug = slugify(p.name);
    list.push([pid, p.name.toLowerCase(), p.name, p.shot_count, p.first_season, p.last_season, slug]);
    slugIndex.set(`${slug}-${pid}`, pid);
  }
  STATE.slugIndex = slugIndex;
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

// ---------- Filtering ----------
function shotMatchesScope(s, f) {
  if (s.season < f.seasonMin || s.season > f.seasonMax) return false;
  if (s.po && !f.po) return false;
  if (!s.po && !f.rg) return false;
  if (s.period >= 5) {
    if (!f.periods.ot) return false;
  } else {
    if (!f.periods[s.period]) return false;
  }
  return true;
}

function shotMatchesView(s, f) {
  if (!shotMatchesScope(s, f)) return false;
  if (s.made && !f.made) return false;
  if (!s.made && !f.missed) return false;
  return true;
}

function shotsForStats() {
  return STATE.flat.filter(s => shotMatchesScope(s, STATE.filters));
}

function shotsForChart() {
  return STATE.flat.filter(s => shotMatchesView(s, STATE.filters));
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
  outer.setAttribute("width", COURT.width);
  outer.setAttribute("height", COURT.height);
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
  const rx = COURT.rimX, ry = COURT.rimY, rr = COURT.restrictedR;
  ra.setAttribute("d", `M ${rx - rr} ${ry} A ${rr} ${rr} 0 0 0 ${rx + rr} ${ry}`);
  g.appendChild(ra);

  const rim = document.createElementNS(NS, "circle");
  rim.setAttribute("cx", COURT.rimX);
  rim.setAttribute("cy", COURT.rimY);
  rim.setAttribute("r", COURT.rimRadius);
  rim.setAttribute("class", "court-rim");
  g.appendChild(rim);

  const bb = document.createElementNS(NS, "line");
  bb.setAttribute("x1", COURT.rimX - 30);
  bb.setAttribute("y1", 40);
  bb.setAttribute("x2", COURT.rimX + 30);
  bb.setAttribute("y2", 40);
  g.appendChild(bb);

  const leftCornerX = COURT.rimX - COURT.cornerThreeX;
  const rightCornerX = COURT.rimX + COURT.cornerThreeX;
  const leftLine = document.createElementNS(NS, "line");
  leftLine.setAttribute("x1", leftCornerX); leftLine.setAttribute("y1", 0);
  leftLine.setAttribute("x2", leftCornerX); leftLine.setAttribute("y2", COURT.cornerThreeY);
  g.appendChild(leftLine);
  const rightLine = document.createElementNS(NS, "line");
  rightLine.setAttribute("x1", rightCornerX); rightLine.setAttribute("y1", 0);
  rightLine.setAttribute("x2", rightCornerX); rightLine.setAttribute("y2", COURT.cornerThreeY);
  g.appendChild(rightLine);

  const arc = document.createElementNS(NS, "path");
  arc.setAttribute(
    "d",
    `M ${leftCornerX} ${COURT.cornerThreeY} A ${COURT.threeR} ${COURT.threeR} 0 0 0 ${rightCornerX} ${COURT.cornerThreeY}`
  );
  g.appendChild(arc);

  const half = document.createElementNS(NS, "line");
  half.setAttribute("x1", 0);
  half.setAttribute("y1", COURT.height);
  half.setAttribute("x2", COURT.width);
  half.setAttribute("y2", COURT.height);
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

function renderDots(filtered) {
  const svg = $("#court");
  const NS = "http://www.w3.org/2000/svg";
  const old = svg.querySelector(".shot-layer");
  if (old) old.remove();
  const layer = document.createElementNS(NS, "g");
  layer.setAttribute("class", "shot-layer");
  const n = filtered.length;
  const r = n > 8000 ? 1.6 : n > 3000 ? 2.0 : 2.6;
  const misses = [];
  const makes = [];
  for (const s of filtered) {
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
      layer.appendChild(c);
    }
  }
  svg.appendChild(layer);
}

function hexColor(fgp) {
  if (fgp == null) return "#cccccc";
  const delta = Math.max(-0.2, Math.min(0.2, fgp - 0.45));
  const t = (delta + 0.2) / 0.4;
  if (t < 0.5) {
    const k = t / 0.5;
    const r = Math.round(201 + (240 - 201) * k);
    const g = Math.round(48 + (240 - 48) * k);
    const b = Math.round(74 + (240 - 74) * k);
    return `rgb(${r},${g},${b})`;
  } else {
    const k = (t - 0.5) / 0.5;
    const r = Math.round(240 + (31 - 240) * k);
    const g = Math.round(240 + (157 - 240) * k);
    const b = Math.round(240 + (85 - 240) * k);
    return `rgb(${r},${g},${b})`;
  }
}

function renderHex(filtered) {
  const svg = $("#court");
  const NS = "http://www.w3.org/2000/svg";
  const old = svg.querySelector(".shot-layer");
  if (old) old.remove();
  const layer = document.createElementNS(NS, "g");
  layer.setAttribute("class", "shot-layer");
  const hexSize = 12;
  const hexW = Math.sqrt(3) * hexSize;
  const hexH = 2 * hexSize;
  const vertSpace = hexH * 0.75;
  const bins = new Map();
  for (const s of filtered) {
    const { sx, sy } = mapShot(s);
    if (sx < 0 || sx > COURT.width || sy < 0 || sy > COURT.height) continue;
    const row = Math.floor(sy / vertSpace);
    const colOffset = row % 2 === 0 ? 0 : hexW / 2;
    const col = Math.floor((sx - colOffset) / hexW);
    const key = `${row}:${col}`;
    let b = bins.get(key);
    if (!b) {
      b = { row, col, made: 0, total: 0, cx: 0, cy: 0 };
      bins.set(key, b);
    }
    b.total++;
    if (s.made) b.made++;
    b.cx += sx; b.cy += sy;
  }
  let maxCount = 0;
  for (const b of bins.values()) if (b.total > maxCount) maxCount = b.total;
  for (const b of bins.values()) {
    if (b.total < 2) continue;
    const cx = b.cx / b.total;
    const cy = b.cy / b.total;
    const fgp = b.made / b.total;
    const size = hexSize * (0.45 + 0.55 * Math.min(1, b.total / Math.max(8, maxCount / 4)));
    const poly = document.createElementNS(NS, "polygon");
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI / 6 + (Math.PI / 3) * i;
      pts.push(`${cx + size * Math.cos(angle)},${cy + size * Math.sin(angle)}`);
    }
    poly.setAttribute("points", pts.join(" "));
    poly.setAttribute("class", "hex");
    poly.setAttribute("fill", hexColor(fgp));
    layer.appendChild(poly);
  }
  svg.appendChild(layer);
}

// ---------- Stats ----------
function recomputeStats() {
  const pool = shotsForStats();
  let total = pool.length;
  let made = 0;
  let threeAtt = 0;
  let threeMade = 0;
  for (const s of pool) {
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

// ---------- Render orchestration ----------
function renderAll() {
  const forChart = shotsForChart();
  recomputeStats();
  if (STATE.filters.view === "hex") {
    renderHex(forChart);
  } else {
    renderDots(forChart);
  }
  writeUrlParams();
}

const renderDeferred = debounce(renderAll, 16);

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
  STATE.selectedPid = pid;
  STATE.selectedName = STATE.catalog[String(pid)]?.name || "";
  $("#loading-state").hidden = false;
  $("#loading-state").textContent = "Loading shots\u2026";
  $("#chart-area").hidden = true;
  $("#filter-panel").hidden = true;
  $("#empty-state").hidden = true;

  try {
    const shard = await loadShard(pid);
    STATE.rawShard = shard;
    STATE.flat = decodeShard(shard);

    const cat = STATE.catalog[String(pid)];
    const first = cat?.first_season ?? 1996;
    const last = cat?.last_season ?? 2025;

    if (!INITIAL_URL_APPLIED) {
      applyInitialFilters(first, last);
      INITIAL_URL_APPLIED = true;
    } else {
      STATE.filters.seasonMin = first;
      STATE.filters.seasonMax = last;
      STATE.filters.rg = true;
      STATE.filters.po = true;
      STATE.filters.periods = { 1: true, 2: true, 3: true, 4: true, ot: true };
      STATE.filters.made = true;
      STATE.filters.missed = true;
    }

    syncFilterUI(first, last);

    $("#stats-name").textContent = shard.name;
    $("#stats-meta").textContent = `${first}-${last} - ${shard.shot_count.toLocaleString()} career shots`;
    document.title = pageTitleFor(shard.name);

    let metaDesc = document.querySelector('meta[name="description"]');
    if (!metaDesc) {
      metaDesc = document.createElement("meta");
      metaDesc.setAttribute("name", "description");
      document.head.appendChild(metaDesc);
    }
    metaDesc.setAttribute(
      "content",
      `Interactive NBA shot chart for ${shard.name} (${first}-${last}). ${shard.shot_count.toLocaleString()} career shots, filter by season, period, regular season vs playoffs.`
    );

    $("#loading-state").hidden = true;
    $("#filter-panel").hidden = false;
    $("#chart-area").hidden = false;

    drawCourtLines();
    renderAll();
  } catch (e) {
    console.error(e);
    $("#loading-state").textContent = `Could not load this player. ${e.message || e}`;
  }
}

function applyInitialFilters(first, last) {
  const u = readUrlParams();
  STATE.filters.seasonMin = u.seasonMin ?? first;
  STATE.filters.seasonMax = u.seasonMax ?? last;
  if (u.rg !== undefined) STATE.filters.rg = u.rg;
  if (u.po !== undefined) STATE.filters.po = u.po;
  if (u.periods) {
    const set = new Set(u.periods);
    STATE.filters.periods = {
      1: set.has("1"),
      2: set.has("2"),
      3: set.has("3"),
      4: set.has("4"),
      ot: set.has("ot"),
    };
  }
  if (u.result) {
    const set = new Set(u.result);
    STATE.filters.made = set.has("made");
    STATE.filters.missed = set.has("missed");
  }
  if (u.view) STATE.filters.view = u.view;
}

function syncFilterUI(first, last) {
  const sMin = $("#season-min");
  const sMax = $("#season-max");
  sMin.min = first; sMin.max = last; sMin.value = STATE.filters.seasonMin;
  sMax.min = first; sMax.max = last; sMax.value = STATE.filters.seasonMax;
  $("#season-min-label").textContent = STATE.filters.seasonMin;
  $("#season-max-label").textContent = STATE.filters.seasonMax;
  $$('[data-filter]').forEach(el => { el.checked = STATE.filters[el.dataset.filter]; });
  $$('[data-period]').forEach(el => {
    const p = el.dataset.period === "ot" ? "ot" : Number(el.dataset.period);
    el.checked = !!STATE.filters.periods[p];
  });
  $$('[data-result]').forEach(el => { el.checked = STATE.filters[el.dataset.result]; });
  $$('.seg-btn').forEach(b => { b.classList.toggle("active", b.dataset.view === STATE.filters.view); });
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

  $("#season-min").addEventListener("input", (e) => {
    let v = Number(e.target.value);
    if (v > STATE.filters.seasonMax) v = STATE.filters.seasonMax;
    STATE.filters.seasonMin = v;
    e.target.value = v;
    $("#season-min-label").textContent = v;
    renderDeferred();
  });
  $("#season-max").addEventListener("input", (e) => {
    let v = Number(e.target.value);
    if (v < STATE.filters.seasonMin) v = STATE.filters.seasonMin;
    STATE.filters.seasonMax = v;
    e.target.value = v;
    $("#season-max-label").textContent = v;
    renderDeferred();
  });

  $$('[data-filter]').forEach(el => {
    el.addEventListener("change", () => {
      STATE.filters[el.dataset.filter] = el.checked;
      renderAll();
    });
  });
  $$('[data-period]').forEach(el => {
    el.addEventListener("change", () => {
      const p = el.dataset.period === "ot" ? "ot" : Number(el.dataset.period);
      STATE.filters.periods[p] = el.checked;
      renderAll();
    });
  });
  $$('[data-result]').forEach(el => {
    el.addEventListener("change", () => {
      STATE.filters[el.dataset.result] = el.checked;
      renderAll();
    });
  });
  $$('.seg-btn').forEach(b => {
    b.addEventListener("click", () => {
      STATE.filters.view = b.dataset.view;
      $$('.seg-btn').forEach(x => x.classList.toggle("active", x === b));
      renderAll();
    });
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
}

// ---------- Boot ----------
async function boot() {
  document.title = pageTitleFor(null);
  try {
    STATE.catalog = await loadCatalog();
    STATE.playerList = buildPlayerIndex(STATE.catalog);
    wireEvents();

    const u = readUrlParams();
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
