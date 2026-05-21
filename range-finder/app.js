// NBA Shot Range Finder
//
// Loads the aggregate CSV (~3-5MB gzipped) once on boot. All queries are
// in-memory filters over the parsed rows.

const AGG_URL =
  "https://huggingface.co/datasets/cdechoch/nba-data-archive/resolve/main/shot-chart-shards/aggregates.csv.gz";

// Fallback to the uncompressed CSV if Content-Encoding negotiation goes
// sideways. The browser auto-decompresses .gz fetches in most cases but
// not all (HF generally serves these correctly, but we keep the safety net).
const AGG_URL_PLAIN =
  "https://huggingface.co/datasets/cdechoch/nba-data-archive/resolve/main/shot-chart-shards/aggregates.csv";

const ZONE_GROUPS = {
  "Any 3": new Set(["Above the Break 3", "Left Corner 3", "Right Corner 3"]),
  "Any 2": new Set(["Restricted Area", "In The Paint (Non-RA)", "Mid-Range"]),
};

const STATE = {
  rows: [],          // array of { pid, name, season, type, zone, dist, made, attempts }
  rowsLoaded: false,
  lastResults: [],
};

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

// ---------- CSV load ----------
async function loadAggregates() {
  $("#loading-state").hidden = false;
  $("#empty-state").hidden = true;
  let text;
  // The browser handles Content-Encoding: gzip transparently for .gz
  // assets HF serves. fetch().text() returns decompressed text either way.
  for (const url of [AGG_URL, AGG_URL_PLAIN]) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      // .gz needs explicit binary decode via DecompressionStream because
      // HF serves the .gz file with the .gz extension as-is - it does NOT
      // add a Content-Encoding header that triggers browser decompression.
      // We have to do it manually.
      if (url.endsWith(".gz")) {
        const buf = await r.arrayBuffer();
        if (typeof DecompressionStream !== "undefined") {
          const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
          text = await new Response(stream).text();
        } else {
          // Older browsers: skip .gz and try the plain CSV.
          continue;
        }
      } else {
        text = await r.text();
      }
      if (text) break;
    } catch (e) {
      console.warn("Failed to load", url, e);
    }
  }
  if (!text) {
    throw new Error("Could not load aggregates.csv. Check network or HF availability.");
  }
  parseCsv(text);
  STATE.rowsLoaded = true;
  $("#loading-state").hidden = true;
}

function parseCsv(text) {
  // Simple CSV parser sufficient for our well-controlled output. No
  // embedded commas in fields except possibly in name. We handle quoted
  // fields conservatively.
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
      type: fields[idx.season_type],   // "rg" or "po"
      zone: fields[idx.zone],
      dist: fields[idx.dist_bucket],
      made: parseInt(fields[idx.made], 10) || 0,
      attempts: parseInt(fields[idx.attempts], 10) || 0,
    });
  }
  STATE.rows = out;
}

function splitCsvLine(line) {
  // Minimal CSV split with support for quoted fields containing commas.
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else {
        cur += c;
      }
    } else {
      if (c === ",") { out.push(cur); cur = ""; }
      else if (c === '"') inQuote = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ---------- Free-text parser ----------
//
// Recognizes a handful of common patterns and pre-fills the form fields
// so the user can adjust before running. Unrecognized parts are silently
// ignored.
const ZONE_KEYWORDS = [
  // [keyword regex, exact zone or "Any 3"/"Any 2"]
  [/\bcorner ?3s?\b|\bcorner ?3 ?point\b/i, "Any 3"],  // We'll refine via context if "left"/"right"
  [/\bleft corner ?3\b/i, "Left Corner 3"],
  [/\bright corner ?3\b/i, "Right Corner 3"],
  [/\babove ?the ?break ?3s?\b|\batb ?3s?\b/i, "Above the Break 3"],
  [/\b3 ?point\b|\bthrees\b|\bthree-?pointers?\b|\b3s\b/i, "Any 3"],
  [/\bmid ?range\b|\bmid-?range\b/i, "Mid-Range"],
  [/\brestricted area\b|\bat the rim\b|\bat ?rim\b/i, "Restricted Area"],
  [/\bin the paint\b|\bpaint\b/i, "In The Paint (Non-RA)"],
  [/\bbackcourt\b|\bheaves?\b|\bhalf ?court\b/i, "Backcourt"],
  [/\blayups?\b|\bdunks?\b/i, "Restricted Area"],
  [/\b2 ?point\b|\btwos\b|\btwo-?pointers?\b/i, "Any 2"],
];

function parseFreeText(s) {
  if (!s) return { changes: [], unmatched: s };
  let q = s.toLowerCase();
  const result = {
    zone: null,
    dist: null,
    seasonMin: null, seasonMax: null,
    minAttempts: null,
    sort: null,
    changes: [],
  };

  // Sort direction
  if (/\b(best|top|elite|most accurate)\b/.test(q)) {
    result.sort = "fgp_desc";
    result.changes.push("sort: FG% desc");
  } else if (/\b(worst|cold|bottom|least accurate)\b/.test(q)) {
    result.sort = "fgp_asc";
    result.changes.push("sort: FG% asc");
  } else if (/\bmost (volume|attempts|shots)\b|\bhighest ?volume\b/.test(q)) {
    result.sort = "att_desc";
    result.changes.push("sort: attempts desc");
  } else if (/\bmost makes?\b|\bmost made\b/.test(q)) {
    result.sort = "made_desc";
    result.changes.push("sort: makes desc");
  }

  // Min attempts: "<N>+ shots" or "minimum N" or "at least N"
  let m = q.match(/(\d{2,5})\s*\+\s*(?:shots|attempts|tries)/);
  if (m) {
    result.minAttempts = parseInt(m[1], 10);
    result.changes.push(`min attempts: ${m[1]}`);
  } else {
    m = q.match(/(?:minimum|min|at least)\s*(\d{2,5})/);
    if (m) {
      result.minAttempts = parseInt(m[1], 10);
      result.changes.push(`min attempts: ${m[1]}`);
    }
  }

  // Year range patterns
  // since 2015, 2015+, last N years, 2015-2024
  const thisYear = 2025;  // current season start year as of build
  m = q.match(/(?:since|from)\s*(\d{4})/);
  if (m) {
    result.seasonMin = parseInt(m[1], 10);
    result.changes.push(`since ${m[1]}`);
  }
  m = q.match(/\b(\d{4})\s*\+\b/);
  if (m && !result.seasonMin) {
    result.seasonMin = parseInt(m[1], 10);
    result.changes.push(`since ${m[1]}`);
  }
  m = q.match(/last\s*(\d{1,2})\s*(?:years|seasons)/);
  if (m) {
    result.seasonMin = thisYear - parseInt(m[1], 10) + 1;
    result.changes.push(`last ${m[1]} seasons (${result.seasonMin}+)`);
  }
  m = q.match(/(\d{4})\s*[-\u2013]\s*(\d{4})/);
  if (m) {
    result.seasonMin = parseInt(m[1], 10);
    result.seasonMax = parseInt(m[2], 10);
    result.changes.push(`seasons ${m[1]}-${m[2]}`);
  }

  // Zone keywords
  for (const [re, zone] of ZONE_KEYWORDS) {
    if (re.test(q)) {
      result.zone = zone;
      result.changes.push(`zone: ${zone}`);
      break;
    }
  }
  // Refine: if "any 3" matched but the text also mentions "corner", keep "Any 3"
  // but the user might want a side-specific - leave as-is, they can edit.

  // Distance buckets
  m = q.match(/from\s+(\d{1,2})(?:\s*(?:to|[-\u2013])\s*(\d{1,2}))?\s*(?:ft|feet)/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : null;
    result.dist = mapToDistBucket(a, b);
    if (result.dist) result.changes.push(`distance: ${result.dist} ft`);
  }
  m = q.match(/(\d{1,2})\+\s*(?:feet|ft)/);
  if (m && !result.dist) {
    const a = parseInt(m[1], 10);
    if (a >= 25) result.dist = "25+";
    else if (a >= 22) result.dist = "22-25";
    else if (a >= 16) result.dist = "16-22";
    else if (a >= 10) result.dist = "10-16";
    else if (a >= 3) result.dist = "3-10";
    if (result.dist) result.changes.push(`distance: ${result.dist} ft`);
  }

  return result;
}

function mapToDistBucket(a, b) {
  // Heuristic: a-b range to closest bucket key.
  if (b == null) {
    if (a < 3) return "0-3";
    if (a < 10) return "3-10";
    if (a < 16) return "10-16";
    if (a < 22) return "16-22";
    if (a < 25) return "22-25";
    return "25+";
  }
  if (a < 3 && b <= 3) return "0-3";
  if (a < 10 && b <= 10) return "3-10";
  if (a < 16 && b <= 16) return "10-16";
  if (a < 22 && b <= 22) return "16-22";
  if (a < 25 && b <= 25) return "22-25";
  return "25+";
}

function applyParsedToForm(parsed) {
  if (parsed.zone) $("#q-zone").value = parsed.zone;
  if (parsed.dist) $("#q-dist").value = parsed.dist;
  if (parsed.seasonMin) $("#q-season-min").value = parsed.seasonMin;
  if (parsed.seasonMax) $("#q-season-max").value = parsed.seasonMax;
  if (parsed.minAttempts) $("#q-min-attempts").value = parsed.minAttempts;
  if (parsed.sort) $("#q-sort").value = parsed.sort;

  const feedback = $("#parse-feedback");
  if (parsed.changes.length) {
    feedback.hidden = false;
    feedback.textContent = "Parsed: " + parsed.changes.join(", ");
  } else {
    feedback.hidden = false;
    feedback.textContent = "Didn't find a pattern I recognize - adjust the fields and run.";
  }
}

// ---------- Query engine ----------
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

  // Use setTimeout(0) to yield so the "Running..." text actually paints
  // before the synchronous filter runs.
  setTimeout(() => {
    const aggByPid = new Map();
    const expandedZones = q.zone in ZONE_GROUPS ? ZONE_GROUPS[q.zone] : null;

    for (const row of STATE.rows) {
      // Season filter
      if (row.season < q.seasonMin || row.season > q.seasonMax) continue;
      // Type filter
      if (row.type === "rg" && !q.rg) continue;
      if (row.type === "po" && !q.po) continue;
      // Zone filter
      if (q.zone) {
        if (expandedZones) {
          if (!expandedZones.has(row.zone)) continue;
        } else if (row.zone !== q.zone) {
          continue;
        }
      }
      // Distance filter
      if (q.dist && row.dist !== q.dist) continue;

      // Aggregate per player
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
      .map(a => ({
        ...a,
        fgp: a.attempts > 0 ? a.made / a.attempts : 0,
      }));

    switch (q.sort) {
      case "fgp_desc": results.sort((a, b) => b.fgp - a.fgp); break;
      case "fgp_asc":  results.sort((a, b) => a.fgp - b.fgp); break;
      case "att_desc": results.sort((a, b) => b.attempts - a.attempts); break;
      case "made_desc":results.sort((a, b) => b.made - a.made); break;
    }
    results = results.slice(0, q.limit);
    STATE.lastResults = results;

    renderResults(results, q);
    writeUrlParams(q);
    $("#q-status").textContent = `${results.length} found.`;
  }, 0);
}

function renderResults(results, q) {
  const panel = $("#results-panel");
  panel.hidden = false;
  $("#empty-state").hidden = true;
  $("#results-title").textContent = `Results - ${results.length} player${results.length === 1 ? "" : "s"}`;

  const body = $("#results-body");
  if (results.length === 0) {
    body.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--muted)">No players match. Try lowering "Min attempts" or widening the season range.</td></tr>`;
    return;
  }

  // Build link to Shot Chart Studio with reasonable filters preserved.
  // We can pass player+season range, scope. The Studio doesn't filter by
  // zone/distance, so the player just lands there with the seasons set.
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
      <td class="col-link"><a href="${studioLink(r.pid, r.name)}">chart &rarr;</a></td>
    </tr>
  `).join("");
}

// ---------- URL state ----------
function writeUrlParams(q) {
  const p = new URLSearchParams();
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

function readUrlParams() {
  const p = new URLSearchParams(window.location.search);
  if (p.has("zone")) $("#q-zone").value = p.get("zone");
  if (p.has("dist")) $("#q-dist").value = p.get("dist");
  if (p.has("smin")) $("#q-season-min").value = p.get("smin");
  if (p.has("smax")) $("#q-season-max").value = p.get("smax");
  if (p.get("rg") === "0") $("#q-rg").checked = false;
  if (p.get("po") === "0") $("#q-po").checked = false;
  if (p.has("ma")) $("#q-min-attempts").value = p.get("ma");
  if (p.has("sort")) $("#q-sort").value = p.get("sort");
  if (p.has("limit")) $("#q-limit").value = p.get("limit");
  return p.toString() !== "";
}

// ---------- Event wiring ----------
function wireEvents() {
  $("#q-run").addEventListener("click", runQuery);
  $("#freetext-parse").addEventListener("click", () => {
    const text = $("#freetext").value;
    const parsed = parseFreeText(text);
    applyParsedToForm(parsed);
  });
  $("#freetext").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const parsed = parseFreeText($("#freetext").value);
      applyParsedToForm(parsed);
      runQuery();
    }
  });
  // Allow Enter inside form fields to trigger query.
  $$('.qr-input, .qr-input').forEach(el => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runQuery();
      }
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
  wireEvents();
  try {
    await loadAggregates();
    const hasUrlState = readUrlParams();
    if (hasUrlState) {
      runQuery();
    }
  } catch (e) {
    console.error(e);
    $("#empty-state").textContent = `Could not load data. ${e.message || e}`;
  }
}

boot();
