// Playwright preview script for windrose dashboard
// Usage: node test/preview.mjs [--mobile] [--desktop] [--out filename.png]
//        node test/preview.mjs --serve [--port 3000]
//
// Modes:
//   --serve     Start a dev server you can open in your browser (Ctrl+C to stop)
//   --mobile    Take a mobile screenshot (default if no --desktop)
//   --desktop   Take a desktop screenshot
//   --chart-mode  Click the chart toggle before capturing
//   --port N    Use a fixed port (default: random)
//   --out FILE  Custom output filename
//
// This script:
// 1. Starts a local HTTP server serving static/ files
// 2. Intercepts API calls to inject mock wind data
// 3. In --serve mode: keeps running with live WS push every 15s
// 4. Otherwise: takes a Playwright screenshot for visual inspection

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nunjucks from "nunjucks";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, "..", "static");

// ── Mock data ────────────────────────────────────────────────────────────────

const MOCK_CONFIG = {
  stations: ["NorthLaunch", "SouthLaunch", "TigerLZ"],
  title: "Tiger",
  speed_bucket_count: 6,
  speed_bucket_size: 4.0,
  petals_per_90deg: 4,
  speed_unit: "mph",
  temperature_unit: "°F",
  humidity_unit: "%",
  ideal_directions: {
    NorthLaunch: [{ center_deg: 325, half_width: 25 }],
    SouthLaunch: [{ center_deg: 200, half_width: 25 }],
    TigerLZ: [
      { center_deg: 0, half_width: 25 },
      { center_deg: 180, half_width: 25 },
    ],
  },
  site_elevation_ft: 2021,
  has_forecast: false,
};

function mockPetal(angleDeg, buckets) {
  return {
    angle: angleDeg,
    speed_buckets: buckets.map((b, i) => ({
      index: i,
      count: b.count,
      petal_rel: b.petal_rel,
      total_rel: b.total_rel,
      upper_bound: (i + 1) * 4,
    })),
  };
}

// Generate realistic petals. dominantDirs is an array of
// { angle, strength (0-1), speedProfile: [bucket0..bucket5 weights] }
function generateMockPetals(dominantDirs, bgNoise) {
  const nPetals = 16;
  const step = 360 / nPetals;
  // First pass: compute raw counts per petal so we can find the max
  const rawPetals = [];
  let maxCount = 0;
  for (let i = 0; i < nPetals; i++) {
    const angle = step * i;
    const buckets = [];
    let petalTotal = 0;
    for (let j = 0; j < 6; j++) {
      let count = bgNoise * (0.3 + Math.random() * 0.7); // background noise
      for (const dir of dominantDirs) {
        let diff = Math.abs(angle - dir.angle);
        if (diff > 180) diff = 360 - diff;
        // Gaussian-ish falloff: e^(-(diff/sigma)^2)
        const sigma = dir.spread || 30;
        const w = Math.exp(-((diff / sigma) ** 2));
        const sp = dir.speedProfile || [0.15, 0.25, 0.3, 0.2, 0.07, 0.03];
        count += w * dir.strength * (sp[j] || 0) * 200;
      }
      count = Math.max(0, Math.round(count));
      petalTotal += count;
      buckets.push(count);
    }
    if (petalTotal > maxCount) maxCount = petalTotal;
    rawPetals.push({ angle, buckets, petalTotal });
  }
  // Second pass: convert to petal_rel (fraction of max petal) and total_rel
  const totalAll = rawPetals.reduce((s, p) => s + p.petalTotal, 0) || 1;
  const petals = [];
  for (const rp of rawPetals) {
    const speedBuckets = [];
    for (let j = 0; j < 6; j++) {
      speedBuckets.push({
        count: rp.buckets[j],
        petal_rel: maxCount > 0 ? rp.buckets[j] / maxCount : 0,
        total_rel: rp.buckets[j] / totalAll,
        upper_bound: (j + 1) * 4,
      });
    }
    petals.push(mockPetal(rp.angle, speedBuckets));
  }
  return petals;
}

// North Launch: strong W-WNW wind, moderate speeds peaking at 8-12 mph
const northLaunchPetals = generateMockPetals(
  [
    {
      angle: 260,
      strength: 1.0,
      spread: 25,
      speedProfile: [0.05, 0.15, 0.35, 0.3, 0.1, 0.05],
    },
    {
      angle: 280,
      strength: 0.4,
      spread: 20,
      speedProfile: [0.1, 0.25, 0.3, 0.25, 0.08, 0.02],
    },
    {
      angle: 350,
      strength: 0.15,
      spread: 15,
      speedProfile: [0.3, 0.4, 0.2, 0.08, 0.02, 0.0],
    },
  ],
  2,
);

// South Launch: WSW-SW wind, stronger gusts
const southLaunchPetals = generateMockPetals(
  [
    {
      angle: 240,
      strength: 1.0,
      spread: 22,
      speedProfile: [0.05, 0.12, 0.25, 0.3, 0.18, 0.1],
    },
    {
      angle: 260,
      strength: 0.6,
      spread: 25,
      speedProfile: [0.08, 0.18, 0.3, 0.28, 0.12, 0.04],
    },
    {
      angle: 350,
      strength: 0.12,
      spread: 15,
      speedProfile: [0.35, 0.35, 0.2, 0.08, 0.02, 0.0],
    },
  ],
  2,
);

// Tiger LZ: variable winds, multiple directions, lots of light-speed petals
const tigerLZPetals = generateMockPetals(
  [
    {
      angle: 120,
      strength: 0.8,
      spread: 35,
      speedProfile: [0.2, 0.35, 0.25, 0.12, 0.06, 0.02],
    },
    {
      angle: 160,
      strength: 0.5,
      spread: 30,
      speedProfile: [0.15, 0.3, 0.28, 0.18, 0.07, 0.02],
    },
    {
      angle: 200,
      strength: 0.3,
      spread: 25,
      speedProfile: [0.25, 0.35, 0.25, 0.1, 0.04, 0.01],
    },
    {
      angle: 280,
      strength: 0.25,
      spread: 20,
      speedProfile: [0.3, 0.35, 0.2, 0.1, 0.04, 0.01],
    },
    {
      angle: 60,
      strength: 0.2,
      spread: 20,
      speedProfile: [0.35, 0.35, 0.2, 0.08, 0.02, 0.0],
    },
  ],
  4,
);

// ── Mock timeseries data ─────────────────────────────────────────────────────

// Generate mock timeseries points for a station.
// dominantDir: primary wind direction in degrees
// avgSpeed: average speed in mph
// gustSpeed: max gust speed
// variability: how much direction wanders (degrees)
function generateMockTimeseries(
  dominantDir,
  avgSpeed,
  gustSpeed,
  variability,
  rangeMinutes,
) {
  const points = [];
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - rangeMinutes * 60;
  // Cap at ~500 points (like the server's downsample), but stretch the interval
  // so the points still span the full requested window.
  const count = Math.min(Math.floor((rangeMinutes * 60) / 3), 500);
  const interval = (rangeMinutes * 60) / count;

  for (let i = 0; i < count; i++) {
    const t = startTime + i * interval;
    // Slowly drifting direction with noise
    const drift = Math.sin((i / count) * Math.PI * 2) * variability * 0.5;
    const noise = (Math.random() - 0.5) * variability;
    let dir = dominantDir + drift + noise;
    dir = ((dir % 360) + 360) % 360;

    // Speed: sinusoidal trend with random gusts
    const trend =
      avgSpeed + Math.sin((i / count) * Math.PI * 3) * (avgSpeed * 0.3);
    const gustChance = Math.random();
    let speed;
    if (gustChance > 0.95) {
      speed = gustSpeed * (0.8 + Math.random() * 0.2);
    } else if (gustChance < 0.05) {
      speed = avgSpeed * 0.2 * Math.random();
    } else {
      speed = Math.max(0.5, trend + (Math.random() - 0.5) * avgSpeed * 0.6);
    }

    points.push({
      t,
      speed: Math.round(speed * 10) / 10,
      dir: Math.round(dir),
    });
  }
  return points;
}

function generateMockTimeseriesResponse(rangeMinutes) {
  return {
    stations: {
      NorthLaunch: {
        points: generateMockTimeseries(280, 11, 18, 30, rangeMinutes),
      },
      SouthLaunch: {
        points: generateMockTimeseries(210, 10, 19, 25, rangeMinutes),
      },
      TigerLZ: {
        points: generateMockTimeseries(160, 6, 15, 60, rangeMinutes),
      },
    },
  };
}

const MOCK_WIND = {
  stations: {
    NorthLaunch: {
      petals: northLaunchPetals,
      total: 500,
      latest_speed: 11,
      latest_dir: 290,
      gust: 15,
      lull: 7,
      temperature: 3,
      humidity: 82,
    },
    SouthLaunch: {
      petals: southLaunchPetals,
      total: 420,
      latest_speed: 10,
      latest_dir: 205,
      gust: 16,
      lull: 3,
      temperature: 5,
      humidity: 76,
    },
    TigerLZ: {
      petals: tigerLZPetals,
      total: 380,
      latest_speed: 6,
      latest_dir: 190,
      gust: 15,
      lull: 2,
      temperature: 10,
      humidity: 78,
    },
  },
};

// ── Static file server ───────────────────────────────────────────────────────

const RANGE_MINUTES = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "8h": 480,
};

// Build a WS snapshot JSON string with mock timeseries for the given range.
function buildSnapshot(range) {
  const minutes = RANGE_MINUTES[range] || 15;
  const tsResp = generateMockTimeseriesResponse(minutes);
  const tsMap = {};
  if (tsResp.stations) {
    for (const [k, v] of Object.entries(tsResp.stations)) {
      tsMap[k] = v.points;
    }
  }
  return JSON.stringify({
    type: "snapshot",
    ts: Math.floor(Date.now() / 1000),
    range,
    stations: MOCK_WIND.stations,
    timeseries: tsMap,
  });
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function startServer(listenPort) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (!isServe) console.log(`[server] ${req.method} ${url.pathname}`);

      // API mock: /api/config
      if (url.pathname === "/api/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(MOCK_CONFIG));
        return;
      }

      // API mock: /api/wind
      if (url.pathname === "/api/wind") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(MOCK_WIND));
        return;
      }

      // API mock: /api/timeseries
      if (url.pathname === "/api/timeseries") {
        const rangeStr = url.searchParams.get("range") || "15m";
        const rangeMap = { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "2h": 120 };
        const rangeMinutes = rangeMap[rangeStr] || 15;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(generateMockTimeseriesResponse(rangeMinutes)));
        return;
      }

      // Static files
      let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      filePath = path.join(STATIC_DIR, filePath);
      if (!isServe)
        console.log(
          `[server] Static file: ${filePath} (exists: ${fs.existsSync(filePath)})`,
        );

      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      // Render index.html through nunjucks (mirrors Rust server's minijinja SSR)
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const templateStr = fs.readFileSync(filePath, "utf-8");
        const njkEnv = new nunjucks.Environment(null, { autoescape: false });
        const stations = MOCK_CONFIG.stations.map((st) => ({
          id: st,
          label: st.replace(/([a-z])([A-Z])/g, "$1 $2"),
        }));
        const speedBuckets = [];
        for (let i = 0; i < MOCK_CONFIG.speed_bucket_count; i++) {
          const lo = MOCK_CONFIG.speed_bucket_size * i;
          const hi = lo + MOCK_CONFIG.speed_bucket_size;
          const isLast = i === MOCK_CONFIG.speed_bucket_count - 1;
          speedBuckets.push({
            index: i,
            label: isLast
              ? `>${Math.round(lo)}`
              : `${Math.round(lo)}\u2013${Math.round(hi)}`,
          });
        }
        const rendered = njkEnv.renderString(templateStr, {
          title: MOCK_CONFIG.title,
          stations,
          speed_buckets: speedBuckets,
          config_json: JSON.stringify(MOCK_CONFIG),
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(rendered);
        return;
      }

      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    });

    server.listen(listenPort || 0, "127.0.0.1", () => {
      const port = server.address().port;

      // Attach WebSocket server for /ws path
      const wss = new WebSocketServer({ server, path: "/ws" });
      server._wss = wss;
      wss.on("connection", (ws) => {
        console.log("[ws] Client connected");
        ws._range = "15m";
        // Send initial snapshot immediately (catch-up)
        ws.send(buildSnapshot(ws._range));
        // Honor per-connection range changes, like the real server.
        ws.on("message", (data) => {
          try {
            const m = JSON.parse(data.toString());
            if (m && m.range && RANGE_MINUTES[m.range]) {
              ws._range = m.range;
              if (ws.readyState === 1) ws.send(buildSnapshot(ws._range));
            }
          } catch (e) {
            /* ignore */
          }
        });
      });

      resolve({ server, port });
    });
  });
}

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isServe = args.includes("--serve");
const isMobile = args.includes("--mobile") || !args.includes("--desktop");
const isDesktop = args.includes("--desktop");
const chartMode = args.includes("--chart-mode");
const outIdx = args.indexOf("--out");
const outFile = outIdx !== -1 ? args[outIdx + 1] : null;
const widthIdx = args.indexOf("--width");
const customWidth = widthIdx !== -1 ? parseInt(args[widthIdx + 1], 10) : null;
const heightIdx = args.indexOf("--height");
const customHeight =
  heightIdx !== -1 ? parseInt(args[heightIdx + 1], 10) : null;
const portIdx = args.indexOf("--port");
const fixedPort = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : null;

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { server, port } = await startServer(fixedPort);
  const baseURL = `http://127.0.0.1:${port}`;

  if (isServe) {
    console.log(`\n  🌬️  Windrose dev server running at:\n`);
    console.log(`     ${baseURL}\n`);
    console.log(`  Mock data with live WebSocket push every 15s.`);
    console.log(`  Live reload on file changes in static/.`);
    console.log(`  Press Ctrl+C to stop.\n`);

    // Watch static/ for changes and notify clients to reload
    const watchDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "static",
    );
    let reloadTimeout = null;
    fs.watch(watchDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      // Debounce rapid saves
      if (reloadTimeout) clearTimeout(reloadTimeout);
      reloadTimeout = setTimeout(() => {
        console.log(`  [reload] ${filename} changed — refreshing clients`);
        const wss = server._wss;
        if (!wss) return;
        wss.clients.forEach((ws) => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: "reload" }));
        });
      }, 150);
    });

    // Push updated snapshots every 15s to simulate live data, each client at
    // its own selected range.
    setInterval(() => {
      const wss = server._wss;
      if (!wss) return;
      wss.clients.forEach((ws) => {
        if (ws.readyState === 1) ws.send(buildSnapshot(ws._range || "15m"));
      });
    }, 15000);
    return; // keep process alive
  }

  console.log(`Mock server running at ${baseURL}`);

  const browser = await chromium.launch();

  const screenshots = [];

  if (isMobile && !isDesktop) {
    // Mobile viewport (default)
    const ctx = await browser.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    await page.goto(baseURL, { waitUntil: "networkidle" });
    // Wait for rendering
    await page.waitForTimeout(1500);

    if (chartMode) {
      await page.click("#viewChartBtn");
      await page.waitForTimeout(1000);
    }

    const filename = outFile || "preview-mobile.png";
    const outPath = path.join(__dirname, filename);
    await page.screenshot({ path: outPath, fullPage: false });
    screenshots.push(outPath);
    console.log(`Mobile screenshot: ${outPath}`);
    await ctx.close();
  }

  if (isDesktop) {
    const dw = customWidth || 1280;
    const dh = customHeight || 800;
    const ctx = await browser.newContext({
      viewport: { width: dw, height: dh },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    await page.goto(baseURL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);

    if (chartMode) {
      await page.click("#viewChartBtn");
      await page.waitForTimeout(1000);
    }

    // Debug: check chart container sizes and uPlot state
    const debugInfo = await page.evaluate(() => {
      const info = {};
      const stations = ["NorthLaunch", "SouthLaunch", "TigerLZ"];
      for (const st of stations) {
        const speedCol = document.getElementById("speedChart-" + st);
        const dirCol = document.getElementById("dirChart-" + st);
        const speedWrap = speedCol
          ? speedCol.querySelector(".chart-wrap")
          : null;
        const dirWrap = dirCol ? dirCol.querySelector(".chart-wrap") : null;
        info[st] = {
          speedWrap: speedWrap ? speedWrap.getBoundingClientRect() : null,
          dirWrap: dirWrap ? dirWrap.getBoundingClientRect() : null,
          speedWrapChildren: speedWrap ? speedWrap.children.length : 0,
          dirWrapChildren: dirWrap ? dirWrap.children.length : 0,
        };
        // Check actual uPlot data for speed chart
        if (typeof speedCharts !== "undefined" && speedCharts[st]) {
          var u = speedCharts[st];
          var d = u.data;
          info[st].speedChartData = {
            seriesCount: d.length,
            xLen: d[0] ? d[0].length : 0,
            yLen: d[1] ? d[1].length : 0,
            xFirst5: d[0] ? d[0].slice(0, 5) : [],
            yFirst5: d[1] ? d[1].slice(0, 5) : [],
            yMin: d[1] ? Math.min(...d[1]) : null,
            yMax: d[1] ? Math.max(...d[1]) : null,
            scalesY: u.scales.y,
            bbox: {
              left: u.bbox.left,
              top: u.bbox.top,
              width: u.bbox.width,
              height: u.bbox.height,
            },
          };
        }
        // Check actual uPlot data for dir chart
        if (typeof dirCharts !== "undefined" && dirCharts[st]) {
          var ud = dirCharts[st];
          var dd = ud.data;
          info[st].dirChartData = {
            yFirst5: dd[1] ? dd[1].slice(0, 5) : [],
            yMin: dd[1] ? Math.min(...dd[1]) : null,
            yMax: dd[1] ? Math.max(...dd[1]) : null,
            scalesY: ud.scales.y,
          };
        }
      }
      info._uPlotDefined = typeof uPlot !== "undefined";
      info._tsData =
        typeof tsData !== "undefined" ? Object.keys(tsData) : "undefined";
      info._speedCharts =
        typeof speedCharts !== "undefined"
          ? Object.keys(speedCharts)
          : "undefined";
      // Check raw tsData sample
      if (typeof tsData !== "undefined" && tsData["NorthLaunch"]) {
        var pts = tsData["NorthLaunch"];
        info._tsDataSample = pts.slice(0, 3);
      }
      return info;
    });
    console.log("DEBUG chart info:", JSON.stringify(debugInfo, null, 2));

    const filename = outFile || "preview-desktop.png";
    const outPath = path.join(__dirname, filename);
    await page.screenshot({ path: outPath, fullPage: false });
    screenshots.push(outPath);
    console.log(`Desktop screenshot: ${outPath}`);
    await ctx.close();
  }

  await browser.close();
  server.close();

  console.log("Done. Screenshots:", screenshots);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
