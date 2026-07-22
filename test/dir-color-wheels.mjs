// Test rig: circular (compass) representation of the direction-dot colors
// for each station. Confirms the behavior of the REAL dirToColor() shipped in
// static/app.js by sweeping every bearing 0–359° through each station's
// configured ideal direction(s) and painting the resulting color on a wheel.
//
// Usage:
//   node test/dir-color-wheels.mjs [options]
//
// Options (all optional — defaults reproduce the production config):
//   --ideal "<spec>"   Ideal directions, SAME syntax as the STATION_IDEAL_DIRS
//                      env var. Each direction is four numbers:
//                        center  center-width  ccw-width  cw-width
//                      (center bearing; green-core half-width; degrees to red
//                      going counter-clockwise / clockwise). Multiple centers
//                      per station joined by '+', stations by ','. Example:
//                        --ideal "NorthLaunch: 337.5 22.5 67.5 45, TigerLZ: 0 20 40 40 + 180 20 40 40"
//   --buckets N        Number of discrete color steps (default 6). Capped by the
//                      number of --swatch-* colors defined in static/theme.css
//                      (6); extra steps fall back to the reddest swatch.
//   --out FILE         Output PNG filename (default dir-color-wheels.png), handy
//                      for saving side-by-side variants while tuning.
//
// To tune the 6 colors themselves, edit --swatch-1..6 in static/theme.css and
// re-run — the rig reads them live from the real stylesheet.
//
// Output:
//   - test/<out>.png  (visual: one wheel per station + legend)
//   - a text table on stdout (color at each compass point + ideal zones)
//
// N is up, bearing increases clockwise (compass convention). The greenest
// swatch sits on each station's green core; color steps toward red as the
// bearing leaves the core, hitting the reddest bucket at that side's fade width.

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nunjucks from "nunjucks";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, "..", "static");

// Default ideal directions (new markup): center + green core (g) + per-side
// fade widths (w both, or l/r each). Override per-run with --ideal.
const MOCK_CONFIG = {
  stations: ["NorthLaunch", "SouthLaunch", "TigerLZ"],
  title: "Tiger",
  speed_bucket_count: 6,
  speed_bucket_size: 4,
  petals_per_90deg: 4,
  speed_unit: "mph",
  temperature_unit: "°F",
  humidity_unit: "%",
  ideal_directions: {
    NorthLaunch: [
      { center_deg: 337.5, green_half: 22.5, ccw_fade: 45, cw_fade: 22.5 },
    ],
    SouthLaunch: [
      { center_deg: 200, green_half: 20, ccw_fade: 25, cw_fade: 25 },
    ],
    TigerLZ: [
      { center_deg: 0, green_half: 20, ccw_fade: 20, cw_fade: 20 },
      { center_deg: 180, green_half: 20, ccw_fade: 20, cw_fade: 20 },
    ],
  },
  site_elevation_ft: 2021,
  has_forecast: false,
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(MOCK_CONFIG));
        return;
      }
      if (url.pathname === "/api/wind" || url.pathname === "/api/timeseries") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ stations: {} }));
        return;
      }
      let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      filePath = path.join(STATIC_DIR, filePath);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const tpl = fs.readFileSync(filePath, "utf-8");
        const njk = new nunjucks.Environment(null, { autoescape: false });
        const stations = MOCK_CONFIG.stations.map((s) => ({
          id: s,
          label: s.replace(/([a-z])([A-Z])/g, "$1 $2"),
        }));
        const buckets = Array.from({ length: 6 }, (_, i) => ({
          index: i,
          label: i === 5 ? `>${i * 4}` : `${i * 4}-${(i + 1) * 4}`,
        }));
        const html = njk.renderString(tpl, {
          title: "Tiger",
          stations,
          speed_buckets: buckets,
          config_json: JSON.stringify(MOCK_CONFIG),
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      const ext = path.extname(filePath);
      const ct = MIME_TYPES[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": ct });
      res.end(fs.readFileSync(filePath));
    });
    server.listen(0, "127.0.0.1", () => {
      const wss = new WebSocketServer({ server, path: "/ws" });
      wss.on("connection", (ws) => {
        ws.send(
          JSON.stringify({
            type: "snapshot",
            ts: 0,
            range: "15m",
            stations: {},
            timeseries: {},
          }),
        );
      });
      resolve({ server, port: server.address().port });
    });
  });
}

// Compress a 360-entry color array into conic-gradient hard-stop segments.
// Bearing 0 = top of the wheel; CSS conic-gradient also starts at top and runs
// clockwise, so bearing maps 1:1 to gradient angle.
function conicStops(colors) {
  const runs = [];
  let start = 0;
  for (let i = 1; i <= 360; i++) {
    if (i === 360 || colors[i] !== colors[start]) {
      runs.push(`${colors[start]} ${start}deg ${i}deg`);
      start = i;
    }
  }
  return runs.join(", ");
}

const SIZE = 260; // wheel-wrap box
const C = SIZE / 2; // center
const R_RING = 100; // outer ring radius
const R_CARD = 118; // cardinal label radius

function polar(bearingDeg, radius) {
  const rad = (bearingDeg * Math.PI) / 180;
  return { x: C + radius * Math.sin(rad), y: C - radius * Math.cos(rad) };
}

function tickEl(bearing, cls) {
  const p = polar(bearing, R_RING);
  return `<div class="${cls}" style="left:${p.x}px;top:${p.y}px;transform:translate(-50%,-50%) rotate(${bearing}deg)"></div>`;
}

function wheelHtml(label, d) {
  const stops = conicStops(d.colors);
  const cardinals = [
    ["N", 0],
    ["E", 90],
    ["S", 180],
    ["W", 270],
  ]
    .map(([t, b]) => {
      const p = polar(b, R_CARD);
      return `<span class="card" style="left:${p.x}px;top:${p.y}px">${t}</span>`;
    })
    .join("");
  // White tick = center; green ticks = green-core edges; red ticks = fade edges.
  let marks = "";
  for (const z of d.zones) {
    marks += tickEl(z.center, "tick");
    marks +=
      tickEl(z.center - z.green, "tick-g") +
      tickEl(z.center + z.green, "tick-g");
    marks +=
      tickEl(z.center - z.green - z.ccw, "tick-r") +
      tickEl(z.center + z.green + z.cw, "tick-r");
  }
  const caption = d.zones
    .map(
      (z) =>
        `${z.center}\u00b0 \u00b7 green \u00b1${z.green}\u00b0 \u00b7 fade ${z.ccw}/${z.cw}\u00b0`,
    )
    .join("<br>");
  return `
    <div class="station">
      <div class="title">${label}</div>
      <div class="wrap">
        <div class="wheel" style="background:conic-gradient(${stops})"></div>
        <div class="hub"></div>
        ${marks}
        ${cardinals}
      </div>
      <div class="caption">${caption}</div>
    </div>`;
}

function legendHtml(dirColors) {
  const items = dirColors
    .map((c) => `<span class="sw" style="background:${c}"></span>`)
    .join("");
  return `<div class="legend"><span class="leg-title">Favorability</span><span class="leg-end">on ideal</span>${items}<span class="leg-end">fade edge</span></div>`;
}

function pageHtml(stations, data, dirColors) {
  const wheels = stations
    .map((s) => wheelHtml(data[s].label, data[s]))
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { --bg:#0b0e14; --fg:#e0e0e0; --fg-dim:#8c98ac; --line:#1c2331; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--fg);
      font-family: 'Inter', system-ui, -apple-system, sans-serif; }
    .sheet { padding: 22px 26px 26px; }
    h1 { font-size: 16px; font-weight: 700; margin: 0 0 2px; letter-spacing:.3px; }
    .sub { font-size: 12px; color: var(--fg-dim); margin: 0 0 18px; }
    .row { display:flex; gap:40px; justify-content:center; }
    .station { display:flex; flex-direction:column; align-items:center; }
    .title { font-size: 13px; font-weight:700; letter-spacing:.6px;
      text-transform:uppercase; margin-bottom:10px; }
    .wrap { position:relative; width:${SIZE}px; height:${SIZE}px; }
    .wheel { position:absolute; inset:${C - R_RING}px; border-radius:50%;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.06); }
    .hub { position:absolute; left:50%; top:50%; width:92px; height:92px;
      transform:translate(-50%,-50%); border-radius:50%; background:var(--bg);
      box-shadow: 0 0 0 1px var(--line); }
    .card { position:absolute; transform:translate(-50%,-50%);
      font-size:12px; font-weight:700; color:var(--fg-dim); }
    .tick, .tick-g, .tick-r { position:absolute; border-radius:2px;
      box-shadow:0 0 0 1px rgba(0,0,0,.55); }
    .tick { width:3px; height:26px; background:#ffffff; }
    .tick-g { width:2px; height:15px; background:#bfe9cb; }
    .tick-r { width:2px; height:15px; background:#f0b1b1; }
    .caption { margin-top:10px; font-size:11px; line-height:1.5;
      color:var(--fg-dim); text-align:center; }
    .legend { display:flex; align-items:center; justify-content:center;
      gap:5px; margin-top:24px; font-size:12px; color:var(--fg-dim);
      flex-wrap:wrap; }
    .leg-title { color:var(--fg); font-weight:600; margin-right:8px; }
    .leg-end { color:var(--fg-dim); margin:0 6px; }
    .sw { width:22px; height:11px; border-radius:2px; display:inline-block; }
  </style></head><body><div class="sheet">
    <h1>Direction &rarr; color mapping (per station)</h1>
    <p class="sub">Real dirToColor() swept over every bearing. N up, clockwise. White tick = ideal center, green ticks = green-core edges, red ticks = fade (red) edges.</p>
    <div class="row">${wheels}</div>
    ${legendHtml(dirColors)}
  </div></body></html>`;
}

const COMPASS = [
  ["N", 0],
  ["NE", 45],
  ["E", 90],
  ["SE", 135],
  ["S", 180],
  ["SW", 225],
  ["W", 270],
  ["NW", 315],
];

function angularDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function printTable(stations, data, dirColors) {
  const reddest = dirColors[dirColors.length - 1];
  console.log("\nDirection color behavior (confirmation table)\n");
  console.log(
    `  Swatch palette (greenest \u2192 reddest): ${dirColors.join(" ")}`,
  );
  for (const s of stations) {
    const d = data[s];
    const zoneDesc = d.zones
      .map((z) => `${z.center}\u00b0 core${z.green} ccw${z.ccw} cw${z.cw}`)
      .join(", ");
    console.log(`\n  ${d.label}  [${zoneDesc}]`);
    for (const [name, deg] of COMPASS) {
      const dist = Math.min(...d.zones.map((z) => angularDist(deg, z.center)));
      const color = d.colors[deg];
      const bucket = dirColors.indexOf(color);
      const bar = "#".repeat(bucket + 1).padEnd(6, "\u00b7");
      console.log(
        `    ${name.padEnd(2)} ${String(deg).padStart(3)}\u00b0  dist ${String(
          Math.round(dist),
        ).padStart(3)}\u00b0  bucket ${bucket} ${bar}  ${color}`,
      );
    }
  }
  // Sanity assertions
  let ok = true;
  for (const s of stations) {
    const d = data[s];
    // (A) Each center bearing is the greenest swatch.
    for (const z of d.zones) {
      const onIdeal = d.colors[((Math.round(z.center) % 360) + 360) % 360];
      if (onIdeal !== dirColors[0]) {
        ok = false;
        console.log(
          `\n  \u2717 ${d.label}: ${z.center}\u00b0 (center) is ${onIdeal}, expected greenest ${dirColors[0]}`,
        );
      }
    }
    // (B) A bearing past every zone's green core + fade is reddest.
    const maxRed = Math.max(
      ...d.zones.map((z) => z.green + Math.max(z.ccw, z.cw)),
    );
    let far = null;
    for (let b = 0; b < 360 && far === null; b++) {
      if (Math.min(...d.zones.map((z) => angularDist(b, z.center))) > maxRed)
        far = b;
    }
    if (far !== null && d.colors[far] !== reddest) {
      ok = false;
      console.log(
        `  \u2717 ${d.label}: ${far}\u00b0 (beyond every fade width) is ${d.colors[far]}, expected reddest ${reddest}`,
      );
    }
  }
  console.log(
    ok
      ? "\n  \u2713 Centers are greenest; bearings beyond every fade width are reddest."
      : "\n  \u2717 Behavior mismatch (see above).",
  );
  return ok;
}

// ── CLI args ────────────────────────────────────────────
// Mirror the Rust STATION_IDEAL_DIRS parser: "Name: center center-width ccw cw + ..."
function parseDir(spec) {
  const nums = spec.trim().split(/\s+/).map(Number);
  if (!nums.length || !Number.isFinite(nums[0])) return null;
  const center = nums[0];
  const green = Number.isFinite(nums[1]) ? nums[1] : 0;
  const ccw = Number.isFinite(nums[2]) ? nums[2] : 45;
  const cw = Number.isFinite(nums[3]) ? nums[3] : ccw;
  return {
    center_deg: center,
    green_half: Math.max(green, 0),
    ccw_fade: Math.max(ccw, 0),
    cw_fade: Math.max(cw, 0),
  };
}
function parseIdealDirs(str) {
  const ideal = {};
  const order = [];
  for (const part of str.split(",")) {
    const ci = part.indexOf(":");
    if (ci < 0) continue;
    const name = part.slice(0, ci).trim();
    const spec = part.slice(ci + 1).trim();
    if (!name || !spec) continue;
    const dirs = spec.split("+").map(parseDir).filter(Boolean);
    if (dirs.length) {
      ideal[name] = dirs;
      order.push(name);
    }
  }
  return { ideal, order };
}

const argv = process.argv.slice(2);
function argVal(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

const idealArg = argVal("--ideal");
if (idealArg) {
  const { ideal, order } = parseIdealDirs(idealArg);
  if (order.length) {
    MOCK_CONFIG.ideal_directions = ideal;
    MOCK_CONFIG.stations = order;
  } else {
    console.error(`Could not parse --ideal "${idealArg}"; using defaults.`);
  }
}
const bucketsArg = argVal("--buckets");
if (bucketsArg && Number.isFinite(Number(bucketsArg))) {
  MOCK_CONFIG.speed_bucket_count = Number(bucketsArg);
}
const outFile = argVal("--out") || "dir-color-wheels.png";

async function main() {
  const { server, port } = await startServer();
  const url = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  // 1. Load the real app so CFG, LEGEND_COLORS (from --swatch-* CSS) and
  //    dirToColor() are all initialized exactly as in production.
  const appCtx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  const appPage = await appCtx.newPage();
  appPage.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await appPage.goto(url, { waitUntil: "networkidle" });
  await appPage.waitForTimeout(1500);

  const result = await appPage.evaluate(() => {
    const CFG = window.CFG;
    const data = {};
    CFG.stations.forEach((st) => {
      const dirs = CFG.ideal_directions[st] || [];
      const colors = [];
      for (let d = 0; d < 360; d++) colors.push(window.dirToColor(d, dirs));
      data[st] = {
        label: st.replace(/([a-z])([A-Z])/g, "$1 $2"),
        zones: dirs.map((x) => ({
          center: x.center_deg,
          green: x.green_half,
          ccw: x.ccw_fade,
          cw: x.cw_fade,
        })),
        colors,
      };
    });
    return { stations: CFG.stations, data, dirColors: window.LEGEND_COLORS };
  });
  await appCtx.close();

  // 2. Render the wheels on a clean page and screenshot.
  const rigCtx = await browser.newContext({
    viewport: { width: 980, height: 540 },
    deviceScaleFactor: 2,
  });
  const rigPage = await rigCtx.newPage();
  await rigPage.setContent(
    pageHtml(result.stations, result.data, result.dirColors),
    { waitUntil: "networkidle" },
  );
  await rigPage.waitForTimeout(300);
  const outPath = path.join(__dirname, outFile);
  await rigPage.screenshot({ path: outPath, fullPage: true });
  console.log(`Wheel image: ${outPath}`);

  const ok = printTable(result.stations, result.data, result.dirColors);

  await browser.close();
  server.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
