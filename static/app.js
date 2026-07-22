/* app.js — Wind Rose Dashboard
 *
 * Vanilla JS (ES5-compatible). No build step.
 * Responsibilities:
 *   - Fetch config, wind data, timeseries from server
 *   - Build DOM (station cells in C1, chart cells in C2)
 *   - Render SVG windroses
 *   - Create/update µPlot scatter charts with shared axes
 *   - Cycling header controls (temp, speed, time range)
 *   - localStorage caching for offline support
 *   - Per-station status indicators
 */

// ── Service Worker ───────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/sw.js")
    .then(function (reg) {
      console.log("SW registered, scope:", reg.scope);
    })
    .catch(function (err) {
      console.warn("SW registration failed:", err);
    });

  // When an updated service worker takes control (after a deploy), reload once
  // so new assets apply immediately instead of lagging a refresh behind. Only
  // when a controller already exists — avoids reloading on the first install.
  if (navigator.serviceWorker.controller) {
    var swReloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (swReloaded) return;
      swReloaded = true;
      location.reload();
    });
  }
}

// ── localStorage helpers ─────────────────────────────────────────
var LS_CFG_KEY = "windrose_cfg_v4";
var LS_DATA_KEY = "windrose_data_v4";
var LS_TS_KEY = "windrose_ts_v4";
var LS_RANGE_KEY = "windrose_range_v4";
var LS_TS_DATA_KEY = "windrose_ts_data_v4";

function lsSave(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) {
    /* quota exceeded */
  }
}
function lsLoad(key) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// ── State ────────────────────────────────────────────────────────
var FALLBACK_STATIONS = ["NorthLaunch", "SouthLaunch", "TigerLZ"];

// CFG is injected by the server-rendered template as a <script> tag.
// This fallback only applies if the template injection is missing (dev/offline).
if (typeof CFG === "undefined") {
  var CFG = {
    stations: FALLBACK_STATIONS,
    title: "Tiger WX",
    speed_bucket_count: 6,
    speed_bucket_size: 4,
    petals_per_90deg: 4,
    speed_unit: "mph",
    temperature_unit: "°F",
    humidity_unit: "%",
    ideal_directions: {},
  };
}
var timeRange = "15m";
var refreshMs = 15000;
var refreshTimer = null;
var stationData = {};
var tsData = {};
var speedCharts = {};
var dirCharts = {};
var timeAxisChart = null;
var LEGEND_COLORS = [];
var lastFetchOk = true;
var lastFetchTs = 0;
var sharedSpeedMax = 0;
var sharedTimeMin = null;
var sharedTimeMax = null;

// ── Color helpers ────────────────────────────────────────────────
// One palette for the whole UI: the footer legend swatches (read from CSS in
// readLegendSwatches below). Windrose petals, speed dots, and direction dots
// all index into LEGEND_COLORS, so they match the legend bar exactly.
function rebuildColors() {
  LEGEND_COLORS = readLegendSwatches(CFG.speed_bucket_count);
}

// The footer legend's discrete swatch palette (read from the --swatch-* CSS
// custom properties). Both the direction dots and the speed dots use these so
// they exactly match the legend bar the pilot sees. Falls back to the literal
// swatch hexes if the computed styles aren't available yet.
var SWATCH_FALLBACK = [
  "#59b95d",
  "#a5cc47",
  "#d9c23a",
  "#e8a33a",
  "#e07538",
  "#d94040",
];
function readLegendSwatches(n) {
  n = n || SWATCH_FALLBACK.length;
  var out = [];
  var cs = null;
  try {
    cs = getComputedStyle(document.documentElement);
  } catch (e) {
    cs = null;
  }
  for (var i = 0; i < n; i++) {
    var v = cs ? cs.getPropertyValue("--swatch-" + (i + 1)).trim() : "";
    out.push(
      v || SWATCH_FALLBACK[i] || SWATCH_FALLBACK[SWATCH_FALLBACK.length - 1],
    );
  }
  return out;
}

// Speed → color: the same 6 discrete legend swatches as the footer bar and the
// direction dots, bucketed by speed_bucket_size (the legend's mph bands).
function speedToColor(mph) {
  var size = CFG.speed_bucket_size || 4;
  var n = LEGEND_COLORS.length || 6;
  if (mph == null || isNaN(mph) || mph < 0)
    return LEGEND_COLORS[0] || SWATCH_FALLBACK[0];
  var idx = Math.floor(mph / size);
  if (idx > n - 1) idx = n - 1;
  return LEGEND_COLORS[idx] || LEGEND_COLORS[n - 1];
}

// Convert a speed in mph (the source/storage unit) to the current display unit.
function convertSpeed(mph) {
  if (mph == null || isNaN(mph)) return mph;
  if (CFG.speed_unit === "kph") return mph * 1.609344;
  if (CFG.speed_unit === "kn") return mph * 0.868976;
  return mph;
}

// Direction → color: discrete legend-swatch buckets. For each ideal direction,
// the reading's signed offset from center selects that side's fade width; within
// the green core (±green_half) it's greenest, then it ramps across `fade` degrees
// beyond the green edge to reddest. With several ideal centers the most-
// favorable (greenest) one wins.
function signedDelta(reading, center) {
  // Result in (-180, 180]; positive = clockwise (higher bearing) from center.
  return ((((reading - center) % 360) + 540) % 360) - 180;
}
function dirToColor(deg, idealDirs) {
  if (!idealDirs || idealDirs.length === 0) return "#3b82f6";
  var n = LEGEND_COLORS.length || 6;
  var best = 1; // 0 = greenest, 1 = reddest
  for (var i = 0; i < idealDirs.length; i++) {
    var dir = idealDirs[i];
    var delta = signedDelta(deg, dir.center_deg);
    var a = Math.abs(delta);
    var g = dir.green_half || 0;
    var fade = delta >= 0 ? dir.cw_fade : dir.ccw_fade;
    if (fade == null) fade = 45;
    var t;
    if (a <= g) t = 0;
    else if (fade <= 0 || a >= g + fade) t = 1;
    else t = (a - g) / fade;
    if (t < best) best = t;
  }
  var idx = Math.round(best * (n - 1));
  if (idx < 0) idx = 0;
  if (idx > n - 1) idx = n - 1;
  return LEGEND_COLORS[idx] || LEGEND_COLORS[n - 1];
}

function circularMean(dirs) {
  var sinSum = 0,
    cosSum = 0;
  for (var i = 0; i < dirs.length; i++) {
    var rad = (dirs[i] * Math.PI) / 180;
    sinSum += Math.sin(rad);
    cosSum += Math.cos(rad);
  }
  var meanRad = Math.atan2(sinSum / dirs.length, cosSum / dirs.length);
  var meanDeg = (meanRad * 180) / Math.PI;
  return ((meanDeg % 360) + 360) % 360;
}

// ── SVG rendering ────────────────────────────────────────────────
function polarToXY(cx, cy, angleDeg, r) {
  var a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
}

function cakeSlice(cx, cy, centerAngle, halfAngle, r0, r1) {
  var step = 1;
  var pts = [];
  for (var a = -halfAngle; a < halfAngle - 0.001; a += step) {
    var p = polarToXY(cx, cy, centerAngle + a, r0);
    pts.push(p.x.toFixed(2) + "," + p.y.toFixed(2));
  }
  var pe = polarToXY(cx, cy, centerAngle + halfAngle, r0);
  pts.push(pe.x.toFixed(2) + "," + pe.y.toFixed(2));
  for (var a = halfAngle; a > -halfAngle + 0.001; a -= step) {
    var p = polarToXY(cx, cy, centerAngle + a, r1);
    pts.push(p.x.toFixed(2) + "," + p.y.toFixed(2));
  }
  var ps = polarToXY(cx, cy, centerAngle - halfAngle, r1);
  pts.push(ps.x.toFixed(2) + "," + ps.y.toFixed(2));
  return pts.join(" ");
}

function renderWindrose(roseWrap, data, stationName) {
  var VB = 400;
  var pad = 30;
  var radius = (VB - pad * 2) / 2;
  var cx = VB / 2;
  var cy = VB / 2;
  var nPetals = CFG.petals_per_90deg * 4;
  var halfAngle = 360 / nPetals / 2;
  var rings = 5;

  var s = "";
  s +=
    '<svg viewBox="0 0 ' +
    VB +
    " " +
    VB +
    '" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">';

  s += "<defs>";
  s += '<radialGradient id="bggrad-' + stationName + '" cx="50%" cy="50%">';
  s +=
    '<stop offset="0%" stop-color="#1c2235"/><stop offset="100%" stop-color="#111627"/>';
  s += "</radialGradient>";
  s += "</defs>";

  s +=
    '<circle cx="' +
    cx +
    '" cy="' +
    cy +
    '" r="' +
    radius +
    '" fill="url(#bggrad-' +
    stationName +
    ')"/>';
  s +=
    '<circle cx="' +
    cx +
    '" cy="' +
    cy +
    '" r="' +
    radius +
    '" fill="none" stroke="#232a3a" stroke-width="1"/>';

  for (var i = 1; i < rings; i++) {
    var r = radius * (0.1 + (0.9 * i) / rings);
    s +=
      '<circle cx="' +
      cx +
      '" cy="' +
      cy +
      '" r="' +
      r +
      '" fill="none" stroke="#1e2540" stroke-width="0.5"/>';
  }

  var innerR = radius * 0.04;

  for (var i = 0; i < nPetals; i++) {
    var angle = (360 / nPetals) * i;
    var p0 = polarToXY(cx, cy, angle, innerR);
    var p1 = polarToXY(cx, cy, angle, radius);
    var isCardinal = angle % 90 === 0;
    var isOrdinal = angle % 45 === 0;
    var sw = isCardinal ? 1 : isOrdinal ? 0.5 : 0.3;
    var op = isCardinal ? 0.3 : 0.12;
    s +=
      '<line x1="' +
      p0.x.toFixed(2) +
      '" y1="' +
      p0.y.toFixed(2) +
      '" x2="' +
      p1.x.toFixed(2) +
      '" y2="' +
      p1.y.toFixed(2) +
      '" stroke="#4b5a80" stroke-width="' +
      sw +
      '" opacity="' +
      op +
      '"/>';
  }

  if (data && data.petals) {
    var normalR = radius * 0.96;
    var startR = radius * 0.04;
    for (var i = 0; i < data.petals.length; i++) {
      var petal = data.petals[i];
      var prevR = startR;
      for (var j = 0; j < petal.speed_buckets.length; j++) {
        var sb = petal.speed_buckets[j];
        var r0 = prevR;
        var r1 = prevR + normalR * sb.petal_rel;
        prevR = r1;
        if (sb.count === 0) continue;
        var pts = cakeSlice(cx, cy, petal.angle, halfAngle, r0, r1);
        var col =
          LEGEND_COLORS[sb.index] || LEGEND_COLORS[LEGEND_COLORS.length - 1];
        var lowerBound = Math.round(
          convertSpeed(CFG.speed_bucket_size * sb.index),
        );
        var upperBound = Math.round(convertSpeed(sb.upper_bound));
        var isLast = sb.index === CFG.speed_bucket_count - 1;
        var rangeLabel = isLast
          ? "&gt;" + lowerBound + " " + CFG.speed_unit
          : lowerBound + "-" + upperBound + " " + CFG.speed_unit;
        s +=
          '<polygon points="' +
          pts +
          '" fill="' +
          col +
          '" stroke="#0a0a0a" stroke-width="1.2" ' +
          'data-pct="' +
          (sb.total_rel * 100).toFixed(1) +
          '" ' +
          'data-range="' +
          rangeLabel +
          '" ' +
          'data-station="' +
          stationName +
          '" ' +
          'class="petal" ' +
          'onmouseenter="showTip(event)" onmouseleave="hideTip()" ' +
          'ontouchstart="showTip(event)"/>';
      }
    }
  }

  var cardinals = [
    { a: 0, t: "N", bold: true },
    { a: 90, t: "E", bold: true },
    { a: 180, t: "S", bold: true },
    { a: 270, t: "W", bold: true },
    { a: 45, t: "NE", bold: false },
    { a: 135, t: "SE", bold: false },
    { a: 225, t: "SW", bold: false },
    { a: 315, t: "NW", bold: false },
  ];
  for (var i = 0; i < cardinals.length; i++) {
    var c = cardinals[i];
    var offset = c.bold ? 16 : 15;
    var p = polarToXY(cx, cy, c.a, radius + offset);
    var fs = c.bold ? 15 : 11;
    var fw = c.bold ? 700 : 500;
    var col = c.bold ? "#8494b0" : "#576a88";
    s +=
      '<text x="' +
      p.x.toFixed(2) +
      '" y="' +
      p.y.toFixed(2) +
      '" fill="' +
      col +
      '" font-size="' +
      fs +
      '" font-weight="' +
      fw +
      '" text-anchor="middle" dominant-baseline="middle" ' +
      'style="pointer-events:none">' +
      c.t +
      "</text>";
  }

  s += "<\/svg>";
  roseWrap.innerHTML = s;
}

// ── Tooltip ──────────────────────────────────────────────────────
var tooltipEl = document.getElementById("tooltip");

function showTip(evt) {
  var el = evt.target;
  tooltipEl.innerHTML =
    '<span class="tt-val">' +
    el.getAttribute("data-pct") +
    "%</span> of readings<br>" +
    el.getAttribute("data-range");
  tooltipEl.style.display = "block";
  positionTip(evt);
}
function hideTip() {
  tooltipEl.style.display = "none";
}
function positionTip(evt) {
  var x = (evt.touches ? evt.touches[0].clientX : evt.clientX) + 12;
  var y = (evt.touches ? evt.touches[0].clientY : evt.clientY) - 10;
  tooltipEl.style.left = Math.min(x, window.innerWidth - 140) + "px";
  tooltipEl.style.top = Math.min(y, window.innerHeight - 50) + "px";
}
document.addEventListener("mousemove", function (e) {
  if (tooltipEl.style.display === "block") positionTip(e);
});

// ── DOM setup ────────────────────────────────────────────────────
function buildGrid() {
  var grid = document.getElementById("grid");
  grid.innerHTML = "";

  // Column 1: stations
  var c1 = document.createElement("div");
  c1.id = "c1";
  c1.className = "col aspect-square";

  for (var i = 0; i < CFG.stations.length; i++) {
    var st = CFG.stations[i];
    var label = st.replace(/([a-z])([A-Z])/g, "$1 $2");
    var cell = document.createElement("div");
    cell.className = "cell station-cell";
    cell.id = "station-" + st;
    cell.setAttribute("data-station", st);
    cell.innerHTML =
      '<div class="station-header">' +
      '<span class="station-status live" id="status-' +
      st +
      '"></span>' +
      '<span class="station-name">' +
      label +
      "</span>" +
      "</div>" +
      '<div class="station-body">' +
      '<div class="station-metrics" id="metrics-' +
      st +
      '"></div>' +
      '<div class="rose-wrap" id="rose-' +
      st +
      '"></div>' +
      "</div>";
    c1.appendChild(cell);
  }

  // Column 2: charts
  var c2 = document.createElement("div");
  c2.id = "c2";
  c2.className = "col";

  for (var i = 0; i < CFG.stations.length; i++) {
    var st = CFG.stations[i];
    var cell = document.createElement("div");
    cell.className = "cell chart-cell";
    cell.innerHTML =
      '<div class="chart-wrap" id="speedChart-' +
      st +
      '"></div>' +
      '<div class="chart-wrap" id="dirChart-' +
      st +
      '"></div>';
    c2.appendChild(cell);
  }

  grid.appendChild(c1);
  grid.appendChild(c2);

  // Footer/legend lives inside C1 — aligned with windrose column.
  var footer = document.createElement("footer");
  footer.className = "footer";
  footer.innerHTML = '<span class="footer-legend" id="legend"></span>';
  c1.appendChild(footer);

  // Matching empty footer in C2 — same height/background, no content.
  var footer2 = document.createElement("footer");
  footer2.className = "footer";
  c2.appendChild(footer2);

  buildLegend();

  // Render empty windroses and mock metrics so layout is visible without backend
  for (var i = 0; i < CFG.stations.length; i++) {
    var st = CFG.stations[i];
    var roseWrap = document.getElementById("rose-" + st);
    if (roseWrap) renderWindrose(roseWrap, null, st);
    renderMetrics(st);
  }
}

function buildLegend() {
  var leg = document.getElementById("legend");
  if (!leg) return;
  var html = "";
  for (var i = 0; i < CFG.speed_bucket_count; i++) {
    var lo = Math.round(convertSpeed(CFG.speed_bucket_size * i));
    var hi = Math.round(convertSpeed(CFG.speed_bucket_size * (i + 1)));
    var isLast = i === CFG.speed_bucket_count - 1;
    var label = isLast ? ">" + lo : lo + "-" + hi;
    html +=
      '<span class="legend-item">' +
      '<span class="legend-swatch s' +
      (i + 1) +
      '"></span>' +
      '<span class="legend-label">' +
      label +
      "</span>" +
      "</span>";
  }
  leg.innerHTML = html;
}

// ── Metrics rendering ────────────────────────────────────────────
function renderMetrics(station) {
  var el = document.getElementById("metrics-" + station);
  if (!el) return;
  var d = stationData[station];

  // Direction first: DIR label, degrees as the value, cardinal as the unit.
  var dirVal = "--";
  var dirUnit = "";
  if (d && d.latest_dir != null) {
    dirVal = String(Math.round(d.latest_dir));
    dirUnit = compassName(d.latest_dir);
  }
  var html = metricChip("dir", dirVal, dirUnit);

  // Speed (latest reading), converted to display units
  var speedVal =
    d && d.latest_speed != null
      ? convertSpeed(d.latest_speed).toFixed(0)
      : "--";
  html += metricChip("speed", speedVal, CFG.speed_unit);

  // Temp (server sends Celsius; convert at display time)
  var tempVal = "--";
  if (d && d.temperature != null) {
    var temp = d.temperature;
    if (CFG.temperature_unit === "\u00b0F") temp = (temp * 9) / 5 + 32;
    tempVal = temp.toFixed(0);
  }
  html += metricChip("temp", tempVal, CFG.temperature_unit);

  // Humidity
  var humVal = d && d.humidity != null ? d.humidity.toFixed(0) : "--";
  html += metricChip("hum", humVal, CFG.humidity_unit);

  el.innerHTML = '<span class="metric-group">' + html + "</span>";
}

function metricChip(label, val, unit) {
  return (
    '<span class="metric-chip">' +
    '<span class="metric-label">' +
    label +
    "</span>" +
    '<span class="metric-val">' +
    val +
    "</span>" +
    '<span class="metric-unit">' +
    unit +
    "</span>" +
    "</span>"
  );
}

// ── Timeseries charts ────────────────────────────────────────────
function handleNewTimeseries(station, points) {
  tsData[station] = points;
  computeSharedScales();
  renderSpeedChart(station, points);
  renderDirChart(station, points);
  renderTimeAxis();
}

function fmtTime(ts) {
  var d = new Date(ts * 1000);
  var h = d.getHours();
  var m = d.getMinutes();
  var ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return h + ":" + (m < 10 ? "0" : "") + m + ampm;
}

var Y_SIZE = 30;
var X_SIZE = 20;
var AXIS_FONT = "10px system-ui, sans-serif";

// Scatter-dot radius: held constant in CSS pixels (so dots aren't tiny on
// hi-dpi screens) and nudged up a little on taller charts (mobile).
function dotRadius(u) {
  var dpr = window.devicePixelRatio || 1;
  var hCss = u.bbox.height / dpr;
  var cssR = Math.max(2.0, Math.min(3.0, hCss / 56));
  return cssR * dpr;
}

// ── Synced cursor readout ───────────────────────────────
// One shared key syncs the cursor x across every chart, so hovering one moves
// the crosshair on all of them. Instead of a floating tooltip, each chart labels
// the reading under the cursor: the vertical line tracks the mouse; the dot and
// label snap to the nearest data point.
var CURSOR_SYNC_KEY = "wx";

function ensureReadout(u) {
  if (u._cdot) return;
  u._chline = document.createElement("div");
  u._chline.className = "cursor-hline";
  u._cdot = document.createElement("div");
  u._cdot.className = "cursor-dot";
  u._clbl = document.createElement("div");
  u._clbl.className = "cursor-label";
  u.over.appendChild(u._chline);
  u.over.appendChild(u._cdot);
  u.over.appendChild(u._clbl);
}
function hideReadout(u) {
  if (u._chline) u._chline.style.display = "none";
  if (u._cdot) u._cdot.style.display = "none";
  if (u._clbl) u._clbl.style.display = "none";
}
// fmt(data, idx) -> { y: <value on the y scale>, text: <label> } or null.
function updateReadout(u, fmt) {
  ensureReadout(u);
  var idx = u.cursor.idx;
  if (idx == null) return hideReadout(u);
  var t = u.data[0][idx];
  if (t == null) return hideReadout(u);
  var info = fmt(u.data, idx);
  if (!info) return hideReadout(u);
  var px = u.valToPos(t, "x");
  var py = u.valToPos(info.y, "y");
  // Dot on the data point + a faint horizontal line at its value.
  u._cdot.style.left = px + "px";
  u._cdot.style.top = py + "px";
  u._cdot.style.display = "block";
  u._chline.style.top = py + "px";
  u._chline.style.display = "block";
  // Value label sits on the y-axis at the snapped value (CSS pins it to the
  // left gutter); only its vertical position changes.
  u._clbl.textContent = info.text;
  u._clbl.style.top = py + "px";
  u._clbl.style.display = "block";
}

function makeSpeedOpts(el, station, hideXAxis) {
  var rect = el.getBoundingClientRect();
  return {
    width: Math.floor(rect.width) || 300,
    height: Math.floor(rect.height) || 150,
    pxAlign: false,
    padding: [8, 0, 8, 0],
    cursor: {
      show: true,
      x: true,
      y: false,
      drag: { x: false, y: false },
      points: { show: false },
      sync: { key: CURSOR_SYNC_KEY, setSeries: false, scales: ["x", null] },
    },
    legend: { show: false },
    axes: [
      {
        stroke: "#4a5a78",
        grid: { stroke: "rgba(42,50,70,0.5)", width: 1 },
        ticks: {
          stroke: hideXAxis ? "transparent" : "rgba(42,50,70,0.3)",
          width: 1,
        },
        font: AXIS_FONT,
        size: hideXAxis ? 0 : X_SIZE,
        incrs: [
          60, 120, 180, 300, 600, 900, 1200, 1800, 3600, 7200, 14400, 21600,
          43200, 86400,
        ],
        values: hideXAxis
          ? function () {
              return [];
            }
          : function (u, vals) {
              return vals.map(fmtTime);
            },
      },
      {
        stroke: "#8c98ac",
        grid: { stroke: "rgba(42,50,70,0.5)", width: 1 },
        ticks: { stroke: "rgba(42,50,70,0.3)", width: 1 },
        font: AXIS_FONT,
        label: null,
        size: Y_SIZE,
        splits: function () {
          var top = Math.max(sharedSpeedMax, 20);
          var pad = top * 0.1 || 1;
          var max = top + pad;
          var step = 5;
          if (max > 50) step = 10;
          var out = [];
          for (var v = 0; v <= max; v += step) out.push(v);
          return out;
        },
        values: function (u, vals) {
          return vals.map(function (v) {
            return Math.round(convertSpeed(v));
          });
        },
      },
    ],
    series: [
      {},
      {
        label: "Speed",
        stroke: "transparent",
        width: 1,
        paths: function () {
          return null;
        },
        points: { show: false },
      },
    ],
    hooks: {
      drawSeries: [
        function (u, sidx) {
          if (sidx !== 1) return;
          var ctx = u.ctx;
          var xData = u.data[0];
          var yData = u.data[1];
          if (!xData || !yData) return;
          var r = dotRadius(u);
          ctx.save();
          for (var i = 0; i < xData.length; i++) {
            if (yData[i] == null) continue;
            var cx = u.valToPos(xData[i], "x", true);
            var cy = u.valToPos(yData[i], "y", true);
            ctx.fillStyle = speedToColor(yData[i]);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        },
      ],
      setCursor: [
        function (u) {
          updateReadout(u, function (data, idx) {
            var spd = data[1][idx];
            if (spd == null) return null;
            return { y: spd, text: convertSpeed(spd).toFixed(0) };
          });
        },
      ],
    },
    scales: {
      x: {
        range: function () {
          if (sharedTimeMin != null && sharedTimeMax != null) {
            return [sharedTimeMin, sharedTimeMax];
          }
          return [null, null];
        },
      },
      y: {
        range: function () {
          var top = Math.max(sharedSpeedMax, 20);
          var pad = top * 0.1 || 1;
          return [0, top + pad];
        },
      },
    },
  };
}

function compassLabel(deg) {
  var names = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
  ];
  var d = ((deg % 360) + 360) % 360;
  var idx = Math.round(d / 22.5) % 16;
  var snapDeg = idx * 22.5;
  if (Math.abs(d - snapDeg) < 0.1 || Math.abs(d - snapDeg - 360) < 0.1) {
    return names[idx];
  }
  return Math.round(d) + "\u00b0";
}

// Nearest 16-point compass name for any bearing (used in tooltips).
function compassName(deg) {
  var names = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
  ];
  var d = ((deg % 360) + 360) % 360;
  return names[Math.round(d / 22.5) % 16];
}

function makeDirOpts(el, station) {
  var rect = el.getBoundingClientRect();
  var idealDirs = CFG.ideal_directions[station] || [];
  return {
    width: Math.floor(rect.width) || 300,
    height: Math.floor(rect.height) || 150,
    pxAlign: false,
    padding: [8, 0, 8, 0],
    cursor: {
      show: true,
      x: true,
      y: false,
      drag: { x: false, y: false },
      points: { show: false },
      sync: { key: CURSOR_SYNC_KEY, setSeries: false, scales: ["x", null] },
    },
    legend: { show: false },
    axes: [
      {
        stroke: "#4a5a78",
        grid: { stroke: "rgba(42,50,70,0.5)", width: 1 },
        ticks: { stroke: "transparent", width: 1 },
        font: AXIS_FONT,
        size: 0,
        incrs: [
          60, 120, 180, 300, 600, 900, 1200, 1800, 3600, 7200, 14400, 21600,
          43200, 86400,
        ],
        values: function () {
          return [];
        },
      },
      {
        stroke: "#8c98ac",
        grid: { stroke: "rgba(42,50,70,0.5)", width: 1 },
        ticks: { stroke: "rgba(42,50,70,0.3)", width: 1 },
        font: AXIS_FONT,
        label: null,
        size: Y_SIZE,
        values: function (u, vals) {
          return vals.map(function (v) {
            return compassLabel(v);
          });
        },
        splits: function () {
          return [0, 90, 180, 270, 360];
        },
      },
    ],
    series: [
      {},
      {
        label: "Dir",
        stroke: "transparent",
        width: 1,
        paths: function () {
          return null;
        },
        points: { show: false },
      },
    ],
    hooks: {
      drawSeries: [
        function (u, sidx) {
          if (sidx !== 1) return;
          var ctx = u.ctx;
          var xData = u.data[0];
          var yData = u.data[1];
          if (!xData || !yData) return;
          var r = dotRadius(u);
          ctx.save();
          for (var i = 0; i < xData.length; i++) {
            if (yData[i] == null) continue;
            var cx = u.valToPos(xData[i], "x", true);
            var cy = u.valToPos(yData[i], "y", true);
            ctx.fillStyle = dirToColor(
              ((yData[i] % 360) + 360) % 360,
              idealDirs,
            );
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        },
      ],
      setCursor: [
        function (u) {
          updateReadout(u, function (data, idx) {
            var dir = data[1][idx];
            if (dir == null) return null;
            return { y: dir, text: compassName(dir) };
          });
        },
      ],
    },
    scales: {
      x: {
        range: function () {
          if (sharedTimeMin != null && sharedTimeMax != null) {
            return [sharedTimeMin, sharedTimeMax];
          }
          return [null, null];
        },
      },
      y: {
        range: [0, 360],
        auto: false,
      },
    },
  };
}

function renderSpeedChart(station, points) {
  var wrap = document.getElementById("speedChart-" + station);
  if (!wrap) return;
  var rect = wrap.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;

  var times, speeds, dirs;
  if (!points || points.length === 0) {
    if (sharedTimeMin != null && sharedTimeMax != null) {
      times = [sharedTimeMin, sharedTimeMax];
      speeds = [null, null];
      dirs = [null, null];
    } else {
      return;
    }
  } else {
    times = new Array(points.length);
    speeds = new Array(points.length);
    dirs = new Array(points.length);
    for (var i = 0; i < points.length; i++) {
      times[i] = points[i].t;
      speeds[i] = points[i].speed;
      dirs[i] = ((points[i].dir % 360) + 360) % 360;
    }
  }
  var data = [times, speeds, dirs];
  // All speed charts hide x-axis; only the last direction chart shows it
  var hideX = true;

  if (speedCharts[station] && speedCharts[station]._hideX !== hideX) {
    speedCharts[station].destroy();
    delete speedCharts[station];
  }

  if (speedCharts[station]) {
    speedCharts[station].setSize({
      width: Math.floor(rect.width),
      height: Math.floor(rect.height),
    });
    speedCharts[station].setData(data);
  } else {
    var opts = makeSpeedOpts(wrap, station, hideX);
    opts.series.push({ show: false, label: "dir" });
    speedCharts[station] = new uPlot(opts, data, wrap);
    speedCharts[station]._hideX = hideX;
    speedCharts[station].over.addEventListener("mouseleave", function () {
      hideReadout(speedCharts[station]);
    });
    observeResize(wrap, speedCharts, station);
  }
}

function renderDirChart(station, points) {
  var wrap = document.getElementById("dirChart-" + station);
  if (!wrap) return;
  var rect = wrap.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;

  var times, dirs, speeds;
  if (!points || points.length === 0) {
    if (sharedTimeMin != null && sharedTimeMax != null) {
      times = [sharedTimeMin, sharedTimeMax];
      dirs = [null, null];
      speeds = [null, null];
    } else {
      return;
    }
  } else {
    times = new Array(points.length);
    dirs = new Array(points.length);
    speeds = new Array(points.length);
    for (var i = 0; i < points.length; i++) {
      times[i] = points[i].t;
      dirs[i] = ((points[i].dir % 360) + 360) % 360;
      speeds[i] = points[i].speed;
    }
  }
  var data = [times, dirs, speeds];

  if (dirCharts[station]) {
    dirCharts[station].setSize({
      width: Math.floor(rect.width),
      height: Math.floor(rect.height),
    });
    dirCharts[station].setData(data);
  } else {
    var opts = makeDirOpts(wrap, station);
    opts.series.push({ show: false, label: "spd" });
    dirCharts[station] = new uPlot(opts, data, wrap);
    dirCharts[station].over.addEventListener("mouseleave", function () {
      hideReadout(dirCharts[station]);
    });
    observeResize(wrap, dirCharts, station);
  }
}

// ── Time axis (shared x-labels in the C2 footer) ────────────────
// A dedicated axis-only uPlot that shares the data charts' time range and
// left gutter (Y_SIZE), so its time labels line up under the scatter points.
function makeTimeAxisOpts(el) {
  var rect = el.getBoundingClientRect();
  var h = Math.floor(rect.height) || 24;
  return {
    width: Math.floor(rect.width) || 300,
    height: h,
    pxAlign: false,
    padding: [0, 0, 0, 0],
    cursor: {
      show: true,
      x: true,
      y: false,
      points: { show: false },
      drag: { x: false, y: false },
      sync: { key: CURSOR_SYNC_KEY, setSeries: false, scales: ["x", null] },
    },
    hooks: {
      setCursor: [
        function (u) {
          ensureReadout(u);
          u._clbl.classList.add("cursor-time");
          var left = u.cursor.left;
          if (left == null || left < 0) return hideReadout(u);
          var t = u.posToVal(left, "x");
          if (t == null || isNaN(t)) return hideReadout(u);
          u._clbl.textContent = fmtTime(t);
          u._clbl.style.left = left + "px";
          u._clbl.style.top = Math.round(u.over.clientHeight / 2) + "px";
          u._clbl.style.display = "block";
          if (u._cdot) u._cdot.style.display = "none";
          if (u._chline) u._chline.style.display = "none";
        },
      ],
    },
    legend: { show: false },
    scales: {
      x: {
        range: function () {
          if (sharedTimeMin != null && sharedTimeMax != null) {
            return [sharedTimeMin, sharedTimeMax];
          }
          return [null, null];
        },
      },
      y: { range: [0, 1] },
    },
    axes: [
      {
        stroke: "#8c98ac",
        grid: { show: false },
        ticks: { show: false },
        font: AXIS_FONT,
        gap: 0,
        // Plot occupies the top portion so labels land at the footer's center.
        size: Math.max(2, Math.round(h / 2) + 5),
        incrs: [
          60, 120, 180, 300, 600, 900, 1200, 1800, 3600, 7200, 14400, 21600,
          43200, 86400,
        ],
        values: function (u, vals) {
          return vals.map(fmtTime);
        },
      },
      {
        // Invisible left gutter matching the data charts' y-axis width.
        scale: "y",
        stroke: "transparent",
        grid: { show: false },
        ticks: { show: false },
        size: Y_SIZE,
        gap: 0,
        splits: function () {
          return [];
        },
        values: function () {
          return [];
        },
      },
    ],
    series: [
      {},
      {
        stroke: "transparent",
        points: { show: false },
        paths: function () {
          return null;
        },
      },
    ],
  };
}

function renderTimeAxis() {
  var el = document.getElementById("timeAxis");
  if (!el) return;
  var rect = el.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 4) return;
  if (sharedTimeMin == null || sharedTimeMax == null) return;
  var data = [
    [sharedTimeMin, sharedTimeMax],
    [null, null],
  ];
  if (timeAxisChart) {
    timeAxisChart.setSize({
      width: Math.floor(rect.width),
      height: Math.floor(rect.height),
    });
    timeAxisChart.setData(data);
  } else {
    timeAxisChart = new uPlot(makeTimeAxisOpts(el), data, el);
    observeResize(el, { _: timeAxisChart }, "_");
  }
}

// ── ResizeObserver ───────────────────────────────────────────────
var chartRO = new ResizeObserver(function (entries) {
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var el = entry.target;
    var w = Math.floor(entry.contentRect.width);
    var h = Math.floor(entry.contentRect.height);
    if (w < 10 || h < 10) continue;
    var chart = el._uplot;
    if (chart) chart.setSize({ width: w, height: h });
  }
});
function observeResize(wrap, chartMap, station) {
  Object.defineProperty(wrap, "_uplot", {
    get: function () {
      return chartMap[station] || null;
    },
    configurable: true,
  });
  chartRO.observe(wrap);
}

function computeSharedScales() {
  var globalMax = 0;
  var tMin = Infinity;
  var tMax = -Infinity;
  for (var st in tsData) {
    var pts = tsData[st];
    if (!pts || pts.length === 0) continue;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].speed > globalMax) globalMax = pts[i].speed;
      if (pts[i].t < tMin) tMin = pts[i].t;
      if (pts[i].t > tMax) tMax = pts[i].t;
    }
  }
  sharedSpeedMax = globalMax;
  if (tMin !== Infinity && tMax !== -Infinity) {
    sharedTimeMin = tMin;
    sharedTimeMax = tMax;
  } else {
    sharedTimeMin = null;
    sharedTimeMax = null;
  }
}

// ── Data fetching ────────────────────────────────────────────────
function fetchTimeseries() {
  return fetch("/api/timeseries?range=" + timeRange)
    .then(function (r) {
      if (!r.ok) throw new Error(r.statusText);
      return r.json();
    })
    .then(function (batch) {
      var map = batch.stations || {};
      for (var i = 0; i < CFG.stations.length; i++) {
        var st = CFG.stations[i];
        if (map[st] && map[st].points) {
          tsData[st] = map[st].points;
        }
      }
      computeSharedScales();
      for (var i = 0; i < CFG.stations.length; i++) {
        var st = CFG.stations[i];
        var pts = tsData[st] && tsData[st].length > 0 ? tsData[st] : [];
        renderSpeedChart(st, pts);
        renderDirChart(st, pts);
      }
      renderTimeAxis();
      lsSave(LS_TS_DATA_KEY, tsData);
    })
    .catch(function (e) {
      console.error("Timeseries fetch error", e);
    });
}

function updateStationStatus(station, ok) {
  var dot = document.getElementById("status-" + station);
  if (!dot) return;
  if (ok) {
    dot.className = "station-status live";
  } else {
    dot.className =
      "station-status " + (navigator.onLine ? "stale" : "offline");
  }
}

function refreshAll() {
  var windPromise = fetch("/api/wind?range=" + timeRange)
    .then(function (r) {
      if (!r.ok) throw new Error(r.statusText);
      return r.json();
    })
    .then(function (batch) {
      var map = batch.stations || {};
      var gotData = false;
      for (var i = 0; i < CFG.stations.length; i++) {
        var st = CFG.stations[i];
        var cell = document.getElementById("station-" + st);
        if (!cell) continue;
        if (map[st] && map[st].total > 0) {
          stationData[st] = map[st];
          gotData = true;
          updateStationStatus(st, true);
        } else if (!stationData[st]) {
          updateStationStatus(st, false);
        }
        var roseWrap = document.getElementById("rose-" + st);
        if (roseWrap) renderWindrose(roseWrap, stationData[st], st);
        renderMetrics(st);
      }
      if (gotData) {
        lsSave(LS_DATA_KEY, stationData);
        lsSave(LS_TS_KEY, Date.now());
        lsSave(LS_RANGE_KEY, timeRange);
      }
    })
    .catch(function (e) {
      console.error("Fetch error", e);
      for (var i = 0; i < CFG.stations.length; i++) {
        var st = CFG.stations[i];
        updateStationStatus(st, false);
        var cell = document.getElementById("station-" + st);
        if (cell && stationData[st]) {
          var roseWrap = document.getElementById("rose-" + st);
          if (roseWrap) renderWindrose(roseWrap, stationData[st], st);
          renderMetrics(st);
        }
      }
    });

  var tsPromise = fetchTimeseries();
  return Promise.all([windPromise, tsPromise]);
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  if (refreshMs > 0) {
    refreshTimer = setInterval(refreshAll, refreshMs);
  }
}

// ── WebSocket connection ─────────────────────────────────────────
var wsConn = null;
var wsReconnectDelay = 1000;

function handleWsSnapshot(msg) {
  // msg matches WsSnapshot: { type, ts, range, stations, timeseries }
  // Ignore a snapshot for a different range than the one selected (e.g. a stale
  // one still in flight right after a range change).
  if (msg.range && msg.range !== timeRange) return;
  var map = msg.stations || {};
  var gotData = false;
  for (var i = 0; i < CFG.stations.length; i++) {
    var st = CFG.stations[i];
    if (map[st] && map[st].total > 0) {
      stationData[st] = map[st];
      gotData = true;
      updateStationStatus(st, true);
    }
    var roseWrap = document.getElementById("rose-" + st);
    if (roseWrap) renderWindrose(roseWrap, stationData[st], st);
    renderMetrics(st);
  }
  if (gotData) {
    lsSave(LS_DATA_KEY, stationData);
    lsSave(LS_TS_KEY, Date.now());
  }

  // Handle timeseries data
  var tsMap = msg.timeseries || {};
  for (var i = 0; i < CFG.stations.length; i++) {
    var st = CFG.stations[i];
    if (tsMap[st] && tsMap[st].length > 0) {
      tsData[st] = tsMap[st];
    }
  }
  computeSharedScales();
  for (var i = 0; i < CFG.stations.length; i++) {
    var st = CFG.stations[i];
    var pts = tsData[st] && tsData[st].length > 0 ? tsData[st] : [];
    renderSpeedChart(st, pts);
    renderDirChart(st, pts);
  }
  renderTimeAxis();
  lsSave(LS_TS_DATA_KEY, tsData);
}

// Tell the server which time range this client wants (the server pushes
// per-connection snapshots at that range).
function wsRequestRange() {
  if (wsConn && wsConn.readyState === 1) {
    wsConn.send(JSON.stringify({ range: timeRange }));
  }
}

function connectWS() {
  var proto = location.protocol === "https:" ? "wss:" : "ws:";
  var url = proto + "//" + location.host + "/ws";
  try {
    wsConn = new WebSocket(url);
  } catch (e) {
    console.warn("WS connect failed, falling back to polling", e);
    refreshAll().then(scheduleRefresh);
    return;
  }

  wsConn.onopen = function () {
    console.log("WS connected");
    wsReconnectDelay = 1000;
    wsRequestRange();
    // Stop HTTP polling if it was running as fallback
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };

  wsConn.onmessage = function (ev) {
    try {
      var msg = JSON.parse(ev.data);
      if (msg.type === "snapshot") {
        handleWsSnapshot(msg);
      } else if (msg.type === "reload") {
        console.log("Live reload triggered");
        location.reload();
      }
    } catch (e) {
      console.warn("WS message parse error", e);
    }
  };

  wsConn.onclose = function () {
    console.log("WS disconnected, reconnecting in", wsReconnectDelay, "ms");
    wsConn = null;
    setTimeout(connectWS, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
  };

  wsConn.onerror = function () {
    // onclose will fire after this — it handles reconnect
  };
}

// ── Segmented controls ────────────────────────────────────────────
function setupSegControl(id, current, onChange) {
  var seg = document.getElementById(id);
  if (!seg) return;
  var values = seg.getAttribute("data-values").split(",");
  var idx = values.indexOf(current);
  if (idx < 0) idx = 0;
  seg.innerHTML = "";
  var btns = [];
  for (var i = 0; i < values.length; i++) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "seg-btn" + (i === idx ? " active" : "");
    b.setAttribute("data-idx", i);
    b.textContent = values[i];
    seg.appendChild(b);
    btns.push(b);
  }
  seg.addEventListener("click", function (e) {
    var b = e.target.closest(".seg-btn");
    if (!b) return;
    var ni = parseInt(b.getAttribute("data-idx"), 10);
    if (ni === idx) return;
    idx = ni;
    for (var j = 0; j < btns.length; j++) {
      btns[j].classList.toggle("active", j === idx);
    }
    onChange(values[idx]);
  });
}

function setupMenu() {
  var toggle = document.getElementById("menuToggle");
  var panel = document.getElementById("settingsPanel");
  if (!toggle || !panel) return;
  function close() {
    panel.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
  }
  toggle.addEventListener("click", function (e) {
    e.stopPropagation();
    var open = !panel.classList.contains("open");
    panel.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
  // Clicks inside the panel keep it open; picking re-renders in place.
  panel.addEventListener("click", function (e) {
    e.stopPropagation();
  });
  document.addEventListener("click", close);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });
}

// ── Config ───────────────────────────────────────────────────────
// Restore only the user's saved display preferences (units + time range) from a
// previous session. Everything else (stations, ideal_directions, color
// thresholds, bucket config) is authoritative from the server-rendered CFG and
// must NEVER be overwritten by a possibly-stale cached copy.
function applyCfg(cfg) {
  if (!cfg) return;
  if (cfg.speed_unit) CFG.speed_unit = cfg.speed_unit;
  if (cfg.temperature_unit) CFG.temperature_unit = cfg.temperature_unit;
  if (cfg.humidity_unit) CFG.humidity_unit = cfg.humidity_unit;
  if (cfg.range) timeRange = cfg.range;
}

// Persist the user's display choices so they survive reloads/restarts.
function savePrefs() {
  lsSave(LS_CFG_KEY, {
    temperature_unit: CFG.temperature_unit,
    speed_unit: CFG.speed_unit,
    range: timeRange,
  });
}

function hydrateFromLocalStorage() {
  var cachedCfg = lsLoad(LS_CFG_KEY);
  if (cachedCfg) applyCfg(cachedCfg);

  var cachedData = lsLoad(LS_DATA_KEY);
  var cachedTs = lsLoad(LS_TS_KEY);
  if (cachedData && typeof cachedData === "object") {
    for (var key in cachedData) {
      var d = cachedData[key];
      if (!d || !d.petals) {
        delete cachedData[key];
      }
    }
    stationData = cachedData;
    if (cachedTs) {
      lastFetchTs = cachedTs;
      lastFetchOk = false;
    }
  }

  var cachedTsData = lsLoad(LS_TS_DATA_KEY);
  if (cachedTsData && typeof cachedTsData === "object") {
    tsData = cachedTsData;
  }
}

// ── Init ─────────────────────────────────────────────────────────
function init() {
  hydrateFromLocalStorage();

  // CFG is already inlined by the server template. If a cached config
  // exists in localStorage from a previous session, merge it (handles
  // unit preferences the user may have changed).
  var cachedCfg = lsLoad(LS_CFG_KEY);
  if (cachedCfg) applyCfg(cachedCfg);

  document.getElementById("appTitle").textContent = CFG.title;
  document.title = CFG.title;
  rebuildColors();
  // Rebuild the legend so it matches the user's restored speed unit
  // (the server renders it in the default unit).
  buildLegend();

  // Grid is already rendered by the server template.
  // Render empty windroses so layout is visible before data arrives.
  for (var i = 0; i < CFG.stations.length; i++) {
    var st = CFG.stations[i];
    var roseWrap = document.getElementById("rose-" + st);
    if (roseWrap) renderWindrose(roseWrap, null, st);
    renderMetrics(st);
  }

  // Render cached data immediately
  for (var i = 0; i < CFG.stations.length; i++) {
    var st = CFG.stations[i];
    if (stationData[st]) {
      var cell = document.getElementById("station-" + st);
      if (cell) {
        var roseWrap = document.getElementById("rose-" + st);
        if (roseWrap) renderWindrose(roseWrap, stationData[st], st);
        renderMetrics(st);
      }
    }
    if (tsData[st] && tsData[st].length > 0) {
      handleNewTimeseries(st, tsData[st]);
    }
  }

  // Settings menu (opened from the gear button)
  setupMenu();
  setupSegControl("tempSeg", CFG.temperature_unit, function (val) {
    CFG.temperature_unit = val;
    savePrefs();
    for (var i = 0; i < CFG.stations.length; i++) {
      renderMetrics(CFG.stations[i]);
    }
  });

  setupSegControl("speedSeg", CFG.speed_unit, function (val) {
    CFG.speed_unit = val;
    savePrefs();
    buildLegend();
    for (var i = 0; i < CFG.stations.length; i++) {
      var st = CFG.stations[i];
      renderMetrics(st);
      var roseWrap = document.getElementById("rose-" + st);
      if (roseWrap && stationData[st])
        renderWindrose(roseWrap, stationData[st], st);
      if (tsData[st] && tsData[st].length > 0)
        handleNewTimeseries(st, tsData[st]);
    }
  });

  setupSegControl("rangeSeg", timeRange, function (val) {
    timeRange = val;
    savePrefs();
    wsRequestRange();
    stationData = {};
    tsData = {};
    for (var sk in speedCharts) {
      speedCharts[sk].destroy();
      delete speedCharts[sk];
    }
    for (var dk in dirCharts) {
      dirCharts[dk].destroy();
      delete dirCharts[dk];
    }
    for (var ci = 0; ci < CFG.stations.length; ci++) {
      var cst = CFG.stations[ci];
      var sw = document.getElementById("speedChart-" + cst);
      if (sw) sw.innerHTML = "";
      var dw = document.getElementById("dirChart-" + cst);
      if (dw) dw.innerHTML = "";
    }
    refreshAll();
  });

  // Do one HTTP fetch for immediate data, then switch to WebSocket push
  refreshAll().then(function () {
    connectWS();
  });
}

init();
