// NBA Shot Range Finder (v3.5)
//
// Same as v3.4 minus the season-row modal.

const AGG_URL =
  "https://huggingface.co/datasets/cdechoch/nba-data-archive/resolve/main/shot-chart-shards/aggregates.csv.gz";
const AGG_URL_PLAIN =
  "https://huggingface.co/datasets/cdechoch/nba-data-archive/resolve/main/shot-chart-shards/aggregates.csv";

const COURT = {
  width: 500, height: 470, rimX: 250, rimY: 52.5,
  paintWidth: 160, paintHeight: 190, ftCircleR: 60,
  threeR: 237.5, cornerThreeY: 140, cornerThreeX: 220, restrictedR: 40,
};

const LC_X = COURT.rimX - COURT.cornerThreeX;
const RC_X = COURT.rimX + COURT.cornerThreeX;
const PAINT_LEFT = COURT.rimX - COURT.paintWidth / 2;
const PAINT_RIGHT = COURT.rimX + COURT.paintWidth / 2;
const BACKCOURT_Y = 420;

const ZONE_GROUPS = {
  "Any 3": new Set(["Above the Break 3", "Left Corner 3", "Right Corner 3"]),
  "Any 2": new Set(["Restricted Area", "In The Paint (Non-RA)", "Mid-Range"]),
};

const BREAKDOWN_ZONES = [
  "Restricted Area",
  "In The Paint (Non-RA)",
  "Mid-Range",
  "Left Corner 3",
  "Right Corner 3",
  "Above the Break 3",
  "Backcourt",
];

const LATEST_SEASON = 2025;
const RANDOM_MIN_ATTEMPTS = 500;
const DEFAULT_AREA_ZONE = "Restricted Area";

const STATE = {
  rows: [],
  rowsLoaded: false,
  playerIndex: new Map(),
  catalog: [],
  currentTab: "lookup",

  lookupPid: null,
  lookupName: null,
  lookupAreaZone: null,
  lookupAreaDist: null,
  chartMetric: "fgp",
  comboOpen: false,
  comboActive: -1,
};

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function headshotUrl(pid) {
  return `https://cdn.nba.com/headshots/nba/latest/1040x760/${pid}.png`;
}
function slugify(name) {
  return String(name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function pidFromSlug(s) {
  const m = String(s || "").match(/-(\d+)$/);
  return m ? m[1] : null;
}
function seasonLabel(year) {
  const next = ((year + 1) % 100).toString().padStart(2, "0");
  return `${year}-${next}`;
}

// ---------- CSV load ----------
async function loadAggregates() {
  $("#loading-state").hidden = false;
  let text;
  for (const url of [AGG_URL, AGG_URL_PLAIN]) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      if (url.endsWith(".gz")) {
        const buf = await r.arrayBuffer();
        if (typeof DecompressionStream !== "undefined") {
          const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
          text = await new Response(stream).text();
        } else continue;
      } else {
        text = await r.text();
      }
      if (text) break;
    } catch (e) {
      console.warn("Failed to load", url, e);
    }
  }
  if (!text) throw new Error("Could not load aggregates.csv.");
  parseCsv(text);
  buildCatalog();
  STATE.rowsLoaded = true;
  $("#loading-state").hidden = true;
}

function parseCsv(text) {
  const lines = text.split("\n");
  const header = lines[0].split(",");
  const idx = {};
  header.forEach((h, i) => { idx[h.trim()] = i; });
  const out = [];
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li];
    if (!line) continue;
    const fields = splitCsvLine(line);
    if (fields.length < 8) continue;
    const pid = parseInt(fields[idx.player_id], 10);
    if (!Number.isFinite(pid)) continue;
    out.push({
      pid,
      name: fields[idx.name],
      season: parseInt(fields[idx.season], 10),
      type: fields[idx.season_type],
      zone: fields[idx.zone],
      dist: fields[idx.dist_bucket],
      made: parseInt(fields[idx.made], 10) || 0,
      attempts: parseInt(fields[idx.attempts], 10) || 0,
    });
  }
  STATE.rows = out;
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += c;
    } else {
      if (c === ",") { out.push(cur); cur = ""; }
      else if (c === '"') inQuote = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function buildCatalog() {
  const map = new Map();
  for (const r of STATE.rows) {
    let entry = map.get(r.pid);
    if (!entry) {
      entry = { pid: r.pid, name: r.name, attempts: 0, minSeason: r.season, maxSeason: r.season };
      map.set(r.pid, entry);
    }
    entry.attempts += r.attempts;
    if (r.season < entry.minSeason) entry.minSeason = r.season;
    if (r.season > entry.maxSeason) entry.maxSeason = r.season;
  }
  STATE.playerIndex = map;
  STATE.catalog = Array.from(map.values()).map(p => ({
    pid: p.pid, name: p.name, lname: p.name.toLowerCase(),
    attempts: p.attempts, minSeason: p.minSeason, maxSeason: p.maxSeason,
    slug: slugify(p.name),
  }));
}

function pickRandomActivePlayer() {
  const latestAttempts = new Map();
  for (const r of STATE.rows) {
    if (r.season !== LATEST_SEASON) continue;
    latestAttempts.set(r.pid, (latestAttempts.get(r.pid) || 0) + r.attempts);
  }
  const candidates = [];
  for (const [pid, att] of latestAttempts) {
    if (att >= RANDOM_MIN_ATTEMPTS) candidates.push(pid);
  }
  if (candidates.length === 0) {
    const ranked = Array.from(latestAttempts.entries()).sort((a, b) => b[1] - a[1]);
    if (ranked.length > 0) return ranked[Math.floor(Math.random() * Math.min(30, ranked.length))][0];
    const top = STATE.catalog.slice().sort((a, b) => b.attempts - a.attempts).slice(0, 30);
    return top[Math.floor(Math.random() * top.length)].pid;
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ============================================================
// TAB 1: LOOK UP A PLAYER
// ============================================================

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
    results = STATE.catalog.slice().sort((a, b) => b.attempts - a.attempts).slice(0, 20);
  } else {
    results = STATE.catalog
      .filter(p => p.lname.includes(q))
      .sort((a, b) => {
        const ai = a.lname.startsWith(q) ? 0 : 1;
        const bi = b.lname.startsWith(q) ? 0 : 1;
        if (ai !== bi) return ai - bi;
        return b.attempts - a.attempts;
      })
      .slice(0, 30);
  }
  if (results.length === 0) {
    ul.innerHTML = '<li class="combo-result" aria-disabled="true" style="color: var(--muted); cursor: default">No players match.</li>';
  } else {
    ul.innerHTML = results.map(p => `
      <li class="combo-result" role="option" data-pid="${p.pid}">
        <img loading="lazy" alt="" src="${headshotUrl(p.pid)}"
             onerror="this.style.visibility='hidden'">
        <span class="r-name">${escapeHtml(p.name)}</span>
        <span class="r-meta">${p.minSeason}-${String(p.maxSeason + 1).slice(2)}, ${p.attempts.toLocaleString()} shots</span>
      </li>
    `).join("");
  }
  STATE.comboActive = -1;
  openCombo();
}
function selectComboItem(el) {
  if (!el || !el.dataset.pid) return;
  const pid = parseInt(el.dataset.pid, 10);
  closeCombo();
  $("#player-search").value = el.querySelector(".r-name")?.textContent || "";
  loadLookupPlayer(pid);
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

function loadLookupPlayer(pid, useDefaultArea = true) {
  STATE.lookupPid = pid;
  const entry = STATE.playerIndex.get(pid);
  STATE.lookupName = entry?.name || "";
  $("#lookup-empty").hidden = true;
  $("#lookup-grid").hidden = false;
  $("#lookup-name").textContent = STATE.lookupName;
  $("#lookup-meta").textContent = `${entry.minSeason}-${String(entry.maxSeason + 1).slice(2)} - ${entry.attempts.toLocaleString()} shots in this dataset`;
  $("#player-search").value = STATE.lookupName;
  if (useDefaultArea) {
    setLookupArea(DEFAULT_AREA_ZONE, null, DEFAULT_AREA_ZONE);
  } else {
    renderLookupTables();
  }
  writeLookupUrl();
}

function setLookupArea(zone, dist, label) {
  STATE.lookupAreaZone = zone || null;
  STATE.lookupAreaDist = dist || null;
  $$("#lookup-court .zone-hit").forEach(h => {
    const matchZone = h.dataset.zone === STATE.lookupAreaZone;
    const matchDist = !STATE.lookupAreaDist || h.dataset.dist === STATE.lookupAreaDist;
    h.classList.toggle("active", matchZone && matchDist);
  });
  if (STATE.lookupAreaZone) {
    $("#lookup-legend").innerHTML = `Showing: <strong>${escapeHtml(label || STATE.lookupAreaZone)}</strong>`;
    $("#lookup-clear-filter").hidden = false;
    $("#season-legend").textContent = `(${label || STATE.lookupAreaZone})`;
  } else {
    $("#lookup-legend").innerHTML = "Showing: <strong>all shots</strong>";
    $("#lookup-clear-filter").hidden = true;
    $("#season-legend").textContent = "(all shots)";
  }
  if (STATE.lookupPid) renderLookupTables();
  writeLookupUrl();
}
function clearLookupArea() { setLookupArea(null, null, null); }

function matchesArea(row) {
  if (!STATE.lookupAreaZone) return true;
  const expanded = ZONE_GROUPS[STATE.lookupAreaZone];
  if (expanded) {
    if (!expanded.has(row.zone)) return false;
  } else if (row.zone !== STATE.lookupAreaZone) {
    return false;
  }
  if (STATE.lookupAreaDist && row.dist !== STATE.lookupAreaDist) return false;
  return true;
}

function renderLookupTables() {
  if (!STATE.lookupPid) return;

  const playerRows = STATE.rows.filter(r => r.pid === STATE.lookupPid);

  let careerMade = 0, careerAtt = 0;
  for (const r of playerRows) { careerMade += r.made; careerAtt += r.attempts; }

  const filteredForHeader = playerRows.filter(matchesArea);
  let hMade = 0, hAtt = 0;
  for (const r of filteredForHeader) { hMade += r.made; hAtt += r.attempts; }
  $("#lookup-stat-att").textContent = hAtt.toLocaleString();
  $("#lookup-stat-made").textContent = hMade.toLocaleString();
  $("#lookup-stat-fgp").textContent = (hAtt ? (hMade / hAtt * 100).toFixed(1) : "0.0") + "%";

  const byZone = new Map();
  for (const z of BREAKDOWN_ZONES) byZone.set(z, { made: 0, att: 0 });
  for (const r of playerRows) {
    if (!byZone.has(r.zone)) byZone.set(r.zone, { made: 0, att: 0 });
    byZone.get(r.zone).made += r.made;
    byZone.get(r.zone).att += r.attempts;
  }
  const zoneRows = BREAKDOWN_ZONES
    .filter(z => byZone.has(z) && byZone.get(z).att > 0)
    .map(z => {
      const b = byZone.get(z);
      const fgp = b.att ? b.made / b.att : 0;
      const attShare = careerAtt ? b.att / careerAtt : 0;
      const makeShare = careerMade ? b.made / careerMade : 0;
      const selected = STATE.lookupAreaZone &&
        (z === STATE.lookupAreaZone ||
         (STATE.lookupAreaZone in ZONE_GROUPS && ZONE_GROUPS[STATE.lookupAreaZone].has(z)));
      return { z, ...b, fgp, attShare, makeShare, selected };
    });

  $("#lookup-zone-body").innerHTML = zoneRows.map(r => `
    <tr class="${r.selected ? "selected" : ""}" data-zone="${escapeHtml(r.z)}">
      <td class="col-name">${escapeHtml(r.z)}</td>
      <td class="col-num">${r.att.toLocaleString()}</td>
      <td class="col-num">${(r.attShare * 100).toFixed(1)}%</td>
      <td class="col-num">${r.made.toLocaleString()}</td>
      <td class="col-num">${(r.makeShare * 100).toFixed(1)}%</td>
      <td class="col-num col-pct">${(r.fgp * 100).toFixed(1)}%</td>
    </tr>
  `).join("");

  const bySeasonArea = new Map();
  const bySeasonTotal = new Map();
  for (const r of playerRows) {
    let total = bySeasonTotal.get(r.season);
    if (!total) { total = { made: 0, att: 0 }; bySeasonTotal.set(r.season, total); }
    total.made += r.made;
    total.att += r.attempts;
    if (matchesArea(r)) {
      let area = bySeasonArea.get(r.season);
      if (!area) { area = { made: 0, att: 0 }; bySeasonArea.set(r.season, area); }
      area.made += r.made;
      area.att += r.attempts;
    }
  }
  const seasonKeys = Array.from(bySeasonTotal.keys()).sort((a, b) => a - b);
  const seasonData = seasonKeys.map(y => {
    const area = bySeasonArea.get(y) || { made: 0, att: 0 };
    const total = bySeasonTotal.get(y);
    const fgp = area.att ? area.made / area.att : 0;
    const attShare = total.att ? area.att / total.att : 0;
    const makeShare = total.made ? area.made / total.made : 0;
    return { year: y, made: area.made, att: area.att, fgp, attShare, makeShare,
             totalAtt: total.att, totalMade: total.made };
  });

  $("#lookup-season-body").innerHTML = seasonData.map(d => `
    <tr>
      <td class="col-name">${seasonLabel(d.year)}</td>
      <td class="col-num">${d.att.toLocaleString()}</td>
      <td class="col-num">${(d.attShare * 100).toFixed(1)}%</td>
      <td class="col-num">${d.made.toLocaleString()}</td>
      <td class="col-num">${(d.makeShare * 100).toFixed(1)}%</td>
      <td class="col-num col-pct">${(d.fgp * 100).toFixed(1)}%</td>
    </tr>
  `).join("");

  renderSeasonChart(seasonData);
}

function renderSeasonChart(seasonData) {
  const svg = $("#season-chart");
  svg.innerHTML = "";
  if (seasonData.length === 0) {
    svg.insertAdjacentHTML("beforeend",
      `<text x="300" y="110" text-anchor="middle" class="label" fill="var(--muted)">No data for this area</text>`);
    return;
  }

  const metric = STATE.chartMetric;
  const metricLabels = {
    fgp: "FG%",
    attShare: "Share of attempts (Att%)",
    makeShare: "Share of makes (Make%)",
  };
  const metricFor = (d) => d[metric];

  const W = 600, H = 220;
  const MARGIN = { top: 14, right: 14, bottom: 28, left: 40 };
  const innerW = W - MARGIN.left - MARGIN.right;
  const innerH = H - MARGIN.top - MARGIN.bottom;

  const minYear = seasonData[0].year;
  const maxYear = seasonData[seasonData.length - 1].year;
  const yearSpan = Math.max(1, maxYear - minYear);
  const xFor = (year) => {
    if (yearSpan === 0) return MARGIN.left + innerW / 2;
    return MARGIN.left + ((year - minYear) / yearSpan) * innerW;
  };

  let maxVal = 0;
  for (const d of seasonData) {
    const v = metricFor(d);
    if (v > maxVal) maxVal = v;
  }
  let yMax;
  if (metric === "fgp") yMax = Math.max(0.4, Math.min(1.0, maxVal + 0.1));
  else yMax = Math.max(0.1, Math.min(1.0, maxVal + 0.05));
  const yMin = 0;
  const yFor = (v) => MARGIN.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  const stepPP = yMax > 0.5 ? 0.1 : 0.05;
  const gridLines = [];
  const yLabels = [];
  for (let p = 0; p <= yMax + 0.001; p += stepPP) {
    const y = yFor(p);
    gridLines.push(`<line x1="${MARGIN.left}" y1="${y}" x2="${W - MARGIN.right}" y2="${y}"/>`);
    yLabels.push(`<text x="${MARGIN.left - 6}" y="${y + 3}" text-anchor="end">${Math.round(p * 100)}%</text>`);
  }
  svg.insertAdjacentHTML("beforeend", `<g class="grid">${gridLines.join("")}</g>`);
  svg.insertAdjacentHTML("beforeend", `<g class="axis">${yLabels.join("")}</g>`);

  const xLabels = [];
  const labelCount = Math.min(seasonData.length, 8);
  const step = Math.max(1, Math.ceil(seasonData.length / labelCount));
  for (let i = 0; i < seasonData.length; i += step) {
    const d = seasonData[i];
    xLabels.push(`<text x="${xFor(d.year)}" y="${H - MARGIN.bottom + 14}" text-anchor="middle">${d.year}</text>`);
  }
  if (seasonData.length > 1) {
    const last = seasonData[seasonData.length - 1];
    xLabels.push(`<text x="${xFor(last.year)}" y="${H - MARGIN.bottom + 14}" text-anchor="middle">${last.year}</text>`);
  }
  svg.insertAdjacentHTML("beforeend", `<g class="axis">${xLabels.join("")}</g>`);

  let baseline = 0;
  if (metric === "fgp") {
    const totAtt = seasonData.reduce((s, d) => s + d.att, 0);
    const totMade = seasonData.reduce((s, d) => s + d.made, 0);
    baseline = totAtt ? totMade / totAtt : 0;
  } else {
    const valid = seasonData.filter(d => d.totalAtt > 0);
    if (valid.length) {
      const sum = valid.reduce((s, d) => s + metricFor(d), 0);
      baseline = sum / valid.length;
    }
  }
  if (baseline > 0) {
    const yb = yFor(baseline);
    svg.insertAdjacentHTML("beforeend",
      `<line class="baseline" x1="${MARGIN.left}" y1="${yb}" x2="${W - MARGIN.right}" y2="${yb}"/>`);
    svg.insertAdjacentHTML("beforeend",
      `<text class="label" x="${W - MARGIN.right - 4}" y="${yb - 4}" text-anchor="end" fill="rgba(0,0,0,0.5)">${(baseline * 100).toFixed(1)}%</text>`);
  }

  if (seasonData.length === 1) {
    const d = seasonData[0];
    svg.insertAdjacentHTML("beforeend",
      `<circle class="point" cx="${xFor(d.year)}" cy="${yFor(metricFor(d))}" r="4"/>`);
    svg.insertAdjacentHTML("beforeend",
      `<text class="label" x="${xFor(d.year)}" y="${yFor(metricFor(d)) - 8}" text-anchor="middle">${(metricFor(d) * 100).toFixed(1)}%</text>`);
  } else {
    const linePts = seasonData.map(d => `${xFor(d.year)},${yFor(metricFor(d))}`).join(" ");
    svg.insertAdjacentHTML("beforeend", `<polyline class="line" points="${linePts}"/>`);
    for (const d of seasonData) {
      svg.insertAdjacentHTML("beforeend",
        `<circle class="point" cx="${xFor(d.year)}" cy="${yFor(metricFor(d))}" r="3">
           <title>${seasonLabel(d.year)}: ${(metricFor(d) * 100).toFixed(1)}% (${d.made}/${d.att})</title>
         </circle>`);
    }
  }

  svg.insertAdjacentHTML("beforeend",
    `<text x="${MARGIN.left}" y="10" class="label" fill="var(--muted)" font-weight="600">${escapeHtml(metricLabels[metric])}</text>`);
}

// ============================================================
// TAB 2: FIND PLAYERS
// ============================================================

function readForm() {
  return {
    zone: $("#q-zone").value,
    dist: $("#q-dist").value,
    seasonMin: parseInt($("#q-season-min").value, 10),
    seasonMax: parseInt($("#q-season-max").value, 10),
    rg: $("#q-rg").checked,
    po: $("#q-po").checked,
    minAttempts: parseInt($("#q-min-attempts").value, 10) || 1,
    sort: $("#q-sort").value,
    limit: parseInt($("#q-limit").value, 10) || 50,
  };
}

function runQuery() {
  if (!STATE.rowsLoaded) {
    $("#q-status").textContent = "Still loading data...";
    return;
  }
  const q = readForm();
  if (!q.rg && !q.po) {
    $("#q-status").textContent = "Pick at least one of Regular or Playoffs.";
    return;
  }
  $("#q-status").textContent = "Running...";

  setTimeout(() => {
    const aggByPid = new Map();
    const expandedZones = q.zone in ZONE_GROUPS ? ZONE_GROUPS[q.zone] : null;

    for (const row of STATE.rows) {
      if (row.season < q.seasonMin || row.season > q.seasonMax) continue;
      if (row.type === "rg" && !q.rg) continue;
      if (row.type === "po" && !q.po) continue;
      if (q.zone) {
        if (expandedZones) {
          if (!expandedZones.has(row.zone)) continue;
        } else if (row.zone !== q.zone) {
          continue;
        }
      }
      if (q.dist && row.dist !== q.dist) continue;

      let agg = aggByPid.get(row.pid);
      if (!agg) {
        agg = { pid: row.pid, name: row.name, made: 0, attempts: 0,
                minSeason: row.season, maxSeason: row.season };
        aggByPid.set(row.pid, agg);
      }
      agg.made += row.made;
      agg.attempts += row.attempts;
      if (row.season < agg.minSeason) agg.minSeason = row.season;
      if (row.season > agg.maxSeason) agg.maxSeason = row.season;
    }

    let results = Array.from(aggByPid.values())
      .filter(a => a.attempts >= q.minAttempts)
      .map(a => ({ ...a, fgp: a.attempts > 0 ? a.made / a.attempts : 0 }));

    switch (q.sort) {
      case "fgp_desc": results.sort((a, b) => b.fgp - a.fgp); break;
      case "fgp_asc":  results.sort((a, b) => a.fgp - b.fgp); break;
      case "att_desc": results.sort((a, b) => b.attempts - a.attempts); break;
      case "made_desc":results.sort((a, b) => b.made - a.made); break;
    }
    results = results.slice(0, q.limit);
    renderResults(results, q);
    writeFindUrl(q);
    $("#q-status").textContent = `${results.length} found.`;
  }, 0);
}

function renderResults(results, q) {
  const panel = $("#results-panel");
  panel.hidden = false;
  $("#find-empty").hidden = true;
  $("#results-title").textContent = `Results - ${results.length} player${results.length === 1 ? "" : "s"}`;

  function studioLink(pid, name) {
    const params = new URLSearchParams();
    const slug = slugify(name);
    params.set("player", slug ? `${slug}-${pid}` : String(pid));
    if (q.seasonMin !== 1996) params.set("seasonMin", q.seasonMin);
    if (q.seasonMax !== 2025) params.set("seasonMax", q.seasonMax);
    if (!q.rg) params.set("rg", "0");
    if (!q.po) params.set("po", "0");
    return `../?${params.toString()}`;
  }

  const body = $("#results-body");
  if (results.length === 0) {
    body.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--muted)">No players match. Try lowering "Min attempts" or widening the season range.</td></tr>`;
    return;
  }
  body.innerHTML = results.map((r, i) => `
    <tr>
      <td class="col-rank">${i + 1}</td>
      <td class="col-headshot">
        <img loading="lazy" alt="" src="${headshotUrl(r.pid)}"
             onerror="this.style.visibility='hidden'">
      </td>
      <td class="col-name">${escapeHtml(r.name)}</td>
      <td class="col-num">${r.minSeason}-${String(r.maxSeason + 1).slice(2)}</td>
      <td class="col-num">${r.attempts.toLocaleString()}</td>
      <td class="col-num">${r.made.toLocaleString()}</td>
      <td class="col-num col-pct">${(r.fgp * 100).toFixed(1)}%</td>
      <td class="col-num col-link"><a href="${studioLink(r.pid, r.name)}">chart &rarr;</a></td>
    </tr>
  `).join("");
}

const PRESETS = {
  "best-3pt": { zone: "Any 3", dist: "", seasonMin: 2015, seasonMax: 2025, rg: true, po: true, minAttempts: 500, sort: "fgp_desc", limit: 50, label: "Best 3PT shooters since 2015 (500+ attempts)" },
  "best-rim": { zone: "Restricted Area", dist: "", seasonMin: 1996, seasonMax: 2025, rg: true, po: true, minAttempts: 1000, sort: "fgp_desc", limit: 50, label: "Top finishers at the rim (1000+ attempts)" },
  "best-midrange": { zone: "Mid-Range", dist: "", seasonMin: 1996, seasonMax: 2025, rg: true, po: true, minAttempts: 1000, sort: "fgp_desc", limit: 50, label: "Best mid-range shooters (1000+ attempts)" },
  "best-corner3": { zone: "Left Corner 3", dist: "", seasonMin: 1996, seasonMax: 2025, rg: true, po: true, minAttempts: 200, sort: "fgp_desc", limit: 50, label: "Best left corner 3 shooters (200+ attempts)" },
  "best-deep3": { zone: "Above the Break 3", dist: "25+", seasonMin: 1996, seasonMax: 2025, rg: true, po: true, minAttempts: 500, sort: "fgp_desc", limit: 50, label: "Best deep 3 shooters (25+ ft, 500+ attempts)" },
  "worst-3pt": { zone: "Any 3", dist: "", seasonMin: 1996, seasonMax: 2025, rg: true, po: true, minAttempts: 1000, sort: "fgp_asc", limit: 50, label: "Worst 3PT shooters (high volume, 1000+ attempts)" },
  "most-volume": { zone: "", dist: "", seasonMin: 1996, seasonMax: 2025, rg: true, po: true, minAttempts: 1, sort: "att_desc", limit: 50, label: "Most prolific scorers (all shots)" },
};

function applyPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  $("#q-zone").value = p.zone;
  $("#q-dist").value = p.dist;
  $("#q-season-min").value = p.seasonMin;
  $("#q-season-max").value = p.seasonMax;
  $("#q-rg").checked = p.rg;
  $("#q-po").checked = p.po;
  $("#q-min-attempts").value = p.minAttempts;
  $("#q-sort").value = p.sort;
  $("#q-limit").value = p.limit;
  $("#find-legend").innerHTML = `Preset: <strong>${escapeHtml(p.label)}</strong>`;
  $$("#find-court .zone-hit").forEach(h => h.classList.remove("active"));
  runQuery();
}

// ============================================================
// COURT DRAWING (area picker)
// ============================================================

function drawCourt(svgSelector, onClickHit) {
  const svg = $(svgSelector);
  svg.innerHTML = "";
  const NS = "http://www.w3.org/2000/svg";

  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "court-lines");

  const outer = document.createElementNS(NS, "rect");
  outer.setAttribute("x", 0); outer.setAttribute("y", 0);
  outer.setAttribute("width", COURT.width); outer.setAttribute("height", COURT.height);
  g.appendChild(outer);

  const paint = document.createElementNS(NS, "rect");
  paint.setAttribute("x", PAINT_LEFT); paint.setAttribute("y", 0);
  paint.setAttribute("width", COURT.paintWidth); paint.setAttribute("height", COURT.paintHeight);
  g.appendChild(paint);

  const ftc = document.createElementNS(NS, "circle");
  ftc.setAttribute("cx", COURT.rimX); ftc.setAttribute("cy", COURT.paintHeight);
  ftc.setAttribute("r", COURT.ftCircleR);
  g.appendChild(ftc);

  const ra = document.createElementNS(NS, "path");
  ra.setAttribute("d", `M ${COURT.rimX - COURT.restrictedR} ${COURT.rimY} A ${COURT.restrictedR} ${COURT.restrictedR} 0 0 0 ${COURT.rimX + COURT.restrictedR} ${COURT.rimY}`);
  g.appendChild(ra);

  const rim = document.createElementNS(NS, "circle");
  rim.setAttribute("cx", COURT.rimX); rim.setAttribute("cy", COURT.rimY); rim.setAttribute("r", 7.5);
  rim.setAttribute("class", "court-rim");
  g.appendChild(rim);

  const bb = document.createElementNS(NS, "line");
  bb.setAttribute("x1", COURT.rimX - 30); bb.setAttribute("y1", 40);
  bb.setAttribute("x2", COURT.rimX + 30); bb.setAttribute("y2", 40);
  g.appendChild(bb);

  const ll = document.createElementNS(NS, "line");
  ll.setAttribute("x1", LC_X); ll.setAttribute("y1", 0);
  ll.setAttribute("x2", LC_X); ll.setAttribute("y2", COURT.cornerThreeY);
  g.appendChild(ll);
  const rl = document.createElementNS(NS, "line");
  rl.setAttribute("x1", RC_X); rl.setAttribute("y1", 0);
  rl.setAttribute("x2", RC_X); rl.setAttribute("y2", COURT.cornerThreeY);
  g.appendChild(rl);
  const arc = document.createElementNS(NS, "path");
  arc.setAttribute("d", `M ${LC_X} ${COURT.cornerThreeY} A ${COURT.threeR} ${COURT.threeR} 0 0 0 ${RC_X} ${COURT.cornerThreeY}`);
  g.appendChild(arc);

  const half = document.createElementNS(NS, "line");
  half.setAttribute("x1", 0); half.setAttribute("y1", COURT.height);
  half.setAttribute("x2", COURT.width); half.setAttribute("y2", COURT.height);
  half.setAttribute("class", "court-rim");
  g.appendChild(half);

  const center = document.createElementNS(NS, "path");
  center.setAttribute("d", `M ${COURT.rimX - 60} ${COURT.height} A 60 60 0 0 1 ${COURT.rimX + 60} ${COURT.height}`);
  g.appendChild(center);

  svg.appendChild(g);

  addZone(svg, "Backcourt", "Backcourt", "backcourt", `0,${BACKCOURT_Y} 500,${BACKCOURT_Y} 500,470 0,470`);
  addZoneATB3(svg);
  addZone(svg, "Left Corner 3", "Left Corner 3", "22-25", `0,0 ${LC_X},0 ${LC_X},${COURT.cornerThreeY} 0,${COURT.cornerThreeY}`);
  addZone(svg, "Right Corner 3", "Right Corner 3", "22-25", `${RC_X},0 500,0 500,${COURT.cornerThreeY} ${RC_X},${COURT.cornerThreeY}`);
  addZoneMidrange(svg);
  addZoneNonRA(svg);
  addZoneRA(svg);

  svg.addEventListener("click", (e) => {
    const hit = e.target.closest(".zone-hit");
    if (!hit) return;
    $$(`${svgSelector} .zone-hit`).forEach(h => h.classList.remove("active"));
    hit.classList.add("active");
    if (onClickHit) {
      onClickHit({
        zone: hit.dataset.zone || "",
        dist: hit.dataset.dist || "",
        label: hit.dataset.label || "this area",
      });
    }
  });
}

function addZone(svg, label, zone, dist, pointsStr) {
  const NS = "http://www.w3.org/2000/svg";
  const p = document.createElementNS(NS, "polygon");
  p.setAttribute("points", pointsStr);
  p.setAttribute("class", "zone-hit");
  p.dataset.label = label;
  p.dataset.zone = zone;
  p.dataset.dist = dist;
  svg.appendChild(p);
}

function addZoneATB3(svg) {
  const NS = "http://www.w3.org/2000/svg";
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", `
    M ${LC_X} ${COURT.cornerThreeY}
    L ${RC_X} ${COURT.cornerThreeY}
    L ${RC_X} ${BACKCOURT_Y}
    L ${LC_X} ${BACKCOURT_Y}
    Z
    M ${LC_X} ${COURT.cornerThreeY}
    A ${COURT.threeR} ${COURT.threeR} 0 0 0 ${RC_X} ${COURT.cornerThreeY}
    Z
  `);
  p.setAttribute("fill-rule", "evenodd");
  p.setAttribute("class", "zone-hit");
  p.dataset.label = "Above the Break 3";
  p.dataset.zone = "Above the Break 3";
  p.dataset.dist = "25+";
  svg.appendChild(p);
}

function addZoneMidrange(svg) {
  const NS = "http://www.w3.org/2000/svg";
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", `
    M ${LC_X} 0
    L ${LC_X} ${COURT.cornerThreeY}
    A ${COURT.threeR} ${COURT.threeR} 0 0 0 ${RC_X} ${COURT.cornerThreeY}
    L ${RC_X} 0
    Z
    M ${PAINT_LEFT} 0
    L ${PAINT_RIGHT} 0
    L ${PAINT_RIGHT} ${COURT.paintHeight}
    L ${PAINT_LEFT} ${COURT.paintHeight}
    Z
  `);
  p.setAttribute("fill-rule", "evenodd");
  p.setAttribute("class", "zone-hit");
  p.dataset.label = "Mid-Range";
  p.dataset.zone = "Mid-Range";
  p.dataset.dist = "";
  svg.appendChild(p);
}

function addZoneNonRA(svg) {
  const NS = "http://www.w3.org/2000/svg";
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", `
    M ${PAINT_LEFT} 0
    L ${PAINT_RIGHT} 0
    L ${PAINT_RIGHT} ${COURT.paintHeight}
    L ${PAINT_LEFT} ${COURT.paintHeight}
    Z
    M ${COURT.rimX - COURT.restrictedR} ${COURT.rimY}
    A ${COURT.restrictedR} ${COURT.restrictedR} 0 0 0 ${COURT.rimX + COURT.restrictedR} ${COURT.rimY}
    Z
  `);
  p.setAttribute("class", "zone-hit");
  p.setAttribute("fill-rule", "evenodd");
  p.dataset.label = "Paint (non-RA)";
  p.dataset.zone = "In The Paint (Non-RA)";
  p.dataset.dist = "3-10";
  svg.appendChild(p);
}

function addZoneRA(svg) {
  const NS = "http://www.w3.org/2000/svg";
  const p = document.createElementNS(NS, "path");
  const r = COURT.restrictedR;
  p.setAttribute("d", `
    M ${COURT.rimX - r} ${COURT.rimY}
    A ${r} ${r} 0 0 0 ${COURT.rimX + r} ${COURT.rimY}
    L ${COURT.rimX + r} 0
    L ${COURT.rimX - r} 0
    Z
  `);
  p.setAttribute("class", "zone-hit");
  p.dataset.label = "Restricted Area";
  p.dataset.zone = "Restricted Area";
  p.dataset.dist = "0-3";
  svg.appendChild(p);
}

// ============================================================
// TABS + URL STATE
// ============================================================

function switchTab(name) {
  STATE.currentTab = name;
  $$("nav.tabs .tab").forEach(t => {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
  $("#tab-lookup").hidden = name !== "lookup";
  $("#tab-find").hidden = name !== "find";
  writeUrl();
}

function setMetric(metric) {
  STATE.chartMetric = metric;
  $$(".metric-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.metric === metric);
  });
  if (STATE.lookupPid) renderLookupTables();
}

function writeUrl() {
  if (STATE.currentTab === "lookup") writeLookupUrl();
  else writeFindUrl(readForm());
}

function writeLookupUrl() {
  const p = new URLSearchParams();
  p.set("tab", "lookup");
  if (STATE.lookupPid) {
    const slug = slugify(STATE.lookupName);
    p.set("player", slug ? `${slug}-${STATE.lookupPid}` : String(STATE.lookupPid));
  }
  if (STATE.lookupAreaZone) p.set("zone", STATE.lookupAreaZone);
  if (STATE.lookupAreaDist) p.set("dist", STATE.lookupAreaDist);
  const qs = p.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

function writeFindUrl(q) {
  const p = new URLSearchParams();
  p.set("tab", "find");
  if (q.zone) p.set("zone", q.zone);
  if (q.dist) p.set("dist", q.dist);
  if (q.seasonMin !== 1996) p.set("smin", q.seasonMin);
  if (q.seasonMax !== 2025) p.set("smax", q.seasonMax);
  if (!q.rg) p.set("rg", "0");
  if (!q.po) p.set("po", "0");
  if (q.minAttempts !== 200) p.set("ma", q.minAttempts);
  if (q.sort !== "fgp_desc") p.set("sort", q.sort);
  if (q.limit !== 50) p.set("limit", q.limit);
  const qs = p.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

function readUrl() {
  const p = new URLSearchParams(window.location.search);
  const tab = p.get("tab") || "lookup";
  if (tab === "find") {
    if (p.has("zone")) $("#q-zone").value = p.get("zone");
    if (p.has("dist")) $("#q-dist").value = p.get("dist");
    if (p.has("smin")) $("#q-season-min").value = p.get("smin");
    if (p.has("smax")) $("#q-season-max").value = p.get("smax");
    if (p.get("rg") === "0") $("#q-rg").checked = false;
    if (p.get("po") === "0") $("#q-po").checked = false;
    if (p.has("ma")) $("#q-min-attempts").value = p.get("ma");
    if (p.has("sort")) $("#q-sort").value = p.get("sort");
    if (p.has("limit")) $("#q-limit").value = p.get("limit");
    switchTab("find");
    if (p.toString().split("&").length > 1) runQuery();
    return false;
  }
  switchTab("lookup");
  if (p.has("player")) {
    const player = p.get("player");
    let pid = pidFromSlug(player);
    if (pid) pid = parseInt(pid, 10);
    if (!pid && /^\d+$/.test(player)) pid = parseInt(player, 10);
    if (!pid) {
      const slug = slugify(player);
      const match = STATE.catalog.find(c => c.slug === slug);
      if (match) pid = match.pid;
    }
    if (pid && STATE.playerIndex.has(pid)) {
      const hasArea = p.has("zone") || p.has("dist");
      loadLookupPlayer(pid, !hasArea);
      if (hasArea) {
        setLookupArea(p.get("zone") || null, p.get("dist") || null, p.get("zone"));
      }
      return true;
    }
  }
  return false;
}

// ============================================================
// EVENT WIRING
// ============================================================

function wireEvents() {
  $$("nav.tabs .tab").forEach(t => {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  });

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
  $("#lookup-clear-filter").addEventListener("click", clearLookupArea);

  $("#lookup-zone-body").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-zone]");
    if (!tr) return;
    const zone = tr.dataset.zone;
    if (STATE.lookupAreaZone === zone) clearLookupArea();
    else setLookupArea(zone, null, zone);
  });

  $$(".metric-tab").forEach(t => {
    t.addEventListener("click", () => setMetric(t.dataset.metric));
  });

  $("#q-run").addEventListener("click", runQuery);
  $$('.preset-btn').forEach(btn => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
  });
  $$('.qr-input').forEach(el => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); runQuery(); }
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

// ============================================================
// BOOT
// ============================================================

async function boot() {
  drawCourt("#lookup-court", (hit) => {
    setLookupArea(hit.zone, hit.dist, hit.label);
  });
  drawCourt("#find-court", (hit) => {
    $("#find-legend").innerHTML = `Filtering: <strong>${escapeHtml(hit.label)}</strong>`;
    $("#q-zone").value = hit.zone;
    $("#q-dist").value = hit.dist;
    runQuery();
  });
  wireEvents();
  try {
    await loadAggregates();
    const loadedFromUrl = readUrl();
    if (!loadedFromUrl) {
      const pid = pickRandomActivePlayer();
      if (pid) loadLookupPlayer(pid, true);
    }
  } catch (e) {
    console.error(e);
    $("#lookup-empty").textContent = `Could not load data. ${e.message || e}`;
    $("#find-empty").textContent = `Could not load data. ${e.message || e}`;
  }
}

boot();
