// Test: no text elements overlap the windrose SVG in any viewport.
// Usage: node test/test-no-overlap.mjs
//
// Verifies that .station-header and .station-metrics bounding boxes
// do not intersect the .rose-wrap SVG bounding box for every station
// cell, at both desktop and mobile viewport sizes.

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nunjucks from "nunjucks";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, "..", "static");

// Minimal config — only need enough to render the template
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
    NorthLaunch: [{ center_deg: 325, half_width: 25 }],
    SouthLaunch: [{ center_deg: 200, half_width: 25 }],
    TigerLZ: [{ center_deg: 0, half_width: 25 }],
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
      if (url.pathname === "/api/wind") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ stations: {} }));
        return;
      }
      if (url.pathname === "/api/timeseries") {
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

function rectsOverlap(a, b) {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

async function checkOverlap(page, label) {
  const results = await page.evaluate(() => {
    const cells = document.querySelectorAll(".station-cell");
    const issues = [];
    cells.forEach((cell, i) => {
      const svg = cell.querySelector(".rose-wrap svg");
      if (!svg) return; // no SVG rendered (empty data) — skip
      const svgRect = svg.getBoundingClientRect();
      if (svgRect.width === 0 || svgRect.height === 0) return;

      const header = cell.querySelector(".station-header");
      const metrics = cell.querySelector(".station-metrics");

      if (header) {
        const hR = header.getBoundingClientRect();
        if (
          hR.width > 0 &&
          hR.height > 0 &&
          hR.left < svgRect.right &&
          hR.right > svgRect.left &&
          hR.top < svgRect.bottom &&
          hR.bottom > svgRect.top
        ) {
          issues.push({
            cell: i,
            element: "station-header",
            elRect: {
              left: hR.left,
              right: hR.right,
              top: hR.top,
              bottom: hR.bottom,
            },
            svgRect: {
              left: svgRect.left,
              right: svgRect.right,
              top: svgRect.top,
              bottom: svgRect.bottom,
            },
          });
        }
      }

      if (metrics) {
        const mR = metrics.getBoundingClientRect();
        if (
          mR.width > 0 &&
          mR.height > 0 &&
          mR.left < svgRect.right &&
          mR.right > svgRect.left &&
          mR.top < svgRect.bottom &&
          mR.bottom > svgRect.top
        ) {
          issues.push({
            cell: i,
            element: "station-metrics",
            elRect: {
              left: mR.left,
              right: mR.right,
              top: mR.top,
              bottom: mR.bottom,
            },
            svgRect: {
              left: svgRect.left,
              right: svgRect.right,
              top: svgRect.top,
              bottom: svgRect.bottom,
            },
          });
        }
      }
    });
    return issues;
  });

  if (results.length > 0) {
    console.error(`  ✗ ${label}: ${results.length} overlap(s) found`);
    for (const r of results) {
      console.error(
        `    cell[${r.cell}] .${r.element} overlaps SVG`,
        `\n      el:  L=${r.elRect.left.toFixed(1)} R=${r.elRect.right.toFixed(1)} T=${r.elRect.top.toFixed(1)} B=${r.elRect.bottom.toFixed(1)}`,
        `\n      svg: L=${r.svgRect.left.toFixed(1)} R=${r.svgRect.right.toFixed(1)} T=${r.svgRect.top.toFixed(1)} B=${r.svgRect.bottom.toFixed(1)}`,
      );
    }
    return false;
  }
  console.log(`  ✓ ${label}: no overlaps`);
  return true;
}

async function checkLegendNotClipped(page, label) {
  const result = await page.evaluate(() => {
    const legend = document.querySelector(".footer-legend");
    if (!legend) return { ok: true, reason: "no legend" };
    const items = legend.querySelectorAll(".legend-item");
    if (items.length === 0) return { ok: true, reason: "no items" };
    const legendRect = legend.getBoundingClientRect();
    // Check every legend-item is fully within the visible area
    // (allow 1px tolerance for sub-pixel rendering)
    const clipped = [];
    items.forEach((item, i) => {
      const r = item.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.right > legendRect.right + 1 || r.left < legendRect.left - 1) {
        clipped.push({
          index: i,
          text: item.textContent.trim(),
          itemRight: r.right,
          legendRight: legendRect.right,
          itemLeft: r.left,
          legendLeft: legendRect.left,
        });
      }
    });
    return {
      ok: clipped.length === 0,
      clipped,
      legendW: Math.round(legendRect.width),
      scrollW: legend.scrollWidth,
      clientW: legend.clientWidth,
    };
  });

  if (!result.ok) {
    console.error(
      `  ✗ ${label}: legend content clipped (${result.clipped.length} items)`,
    );
    console.error(
      `    legend width=${result.legendW} scrollW=${result.scrollW} clientW=${result.clientW}`,
    );
    for (const c of result.clipped) {
      console.error(
        `    item[${c.index}] "${c.text}" right=${c.itemRight.toFixed(1)} > legendRight=${c.legendRight.toFixed(1)}`,
      );
    }
    return false;
  }
  console.log(`  ✓ ${label}: legend fully visible`);
  return true;
}

async function checkColumnGap(page, label) {
  // Verify windrose (rose-wrap) never touches or overlaps graphs (chart-wrap)
  // or metrics (station-metrics) — there must be a gap.
  const result = await page.evaluate(() => {
    const issues = [];
    const MIN_GAP = 2; // minimum 2px gap required
    const roses = document.querySelectorAll(".rose-wrap");
    const charts = document.querySelectorAll(".chart-wrap");
    const metrics = document.querySelectorAll(".station-metrics");

    roses.forEach((rose, ri) => {
      const rr = rose.getBoundingClientRect();
      if (rr.width === 0 || rr.height === 0) return;
      // Check against charts
      charts.forEach((chart, ci) => {
        const cr = chart.getBoundingClientRect();
        if (cr.width === 0 || cr.height === 0) return;
        // Only check horizontal adjacency (same row-ish)
        const vertOverlap = rr.top < cr.bottom && rr.bottom > cr.top;
        if (vertOverlap) {
          const hGap = Math.min(
            Math.abs(cr.left - rr.right),
            Math.abs(rr.left - cr.right),
          );
          if (hGap < MIN_GAP) {
            issues.push({ type: "rose-chart", rose: ri, chart: ci, gap: hGap });
          }
        }
      });
      // Check against metrics in the SAME cell
      const cell = rose.closest(".station-cell");
      if (cell) {
        const met = cell.querySelector(".station-metrics");
        if (met) {
          const mr = met.getBoundingClientRect();
          if (mr.width > 0 && mr.height > 0) {
            const hGap = Math.abs(rr.left - mr.right);
            if (hGap < MIN_GAP && rr.left > mr.left) {
              issues.push({ type: "rose-metrics", rose: ri, gap: hGap });
            }
          }
        }
      }
    });
    return issues;
  });

  if (result.length > 0) {
    console.error(`  ✗ ${label}: ${result.length} gap violation(s)`);
    for (const r of result) {
      console.error(
        `    ${r.type} gap=${r.gap.toFixed(1)}px (min ${2}px required)`,
      );
    }
    return false;
  }
  console.log(`  ✓ ${label}: column gaps OK`);
  return true;
}

async function checkChartWrapHeights(page, label) {
  const result = await page.evaluate(() => {
    const wraps = [...document.querySelectorAll("#c2 .chart-wrap")];
    if (wraps.length === 0) return { ok: true, reason: "no chart wraps" };
    const heights = wraps.map((w) => {
      const r = w.getBoundingClientRect();
      return { id: w.id, h: Math.round(r.height * 10) / 10 };
    });
    // All chart-wraps should have equal height (within 2px tolerance)
    const uniqueHeights = [...new Set(heights.map((h) => h.h))];
    const minH = Math.min(...uniqueHeights);
    const maxH = Math.max(...uniqueHeights);
    const equal = maxH - minH <= 2;
    return { ok: equal, heights, minH, maxH, diff: maxH - minH };
  });

  if (!result.ok) {
    console.error(
      `  ✗ ${label}: chart-wrap heights unequal (diff=${result.diff.toFixed(1)}px)`,
    );
    for (const h of result.heights) {
      console.error(`    ${h.id}: ${h.h}px`);
    }
    return false;
  }
  console.log(`  ✓ ${label}: chart-wrap heights equal (${result.minH}px)`);
  return true;
}

async function main() {
  const { server, port } = await startServer();
  const url = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  let allPassed = true;

  const viewports = [
    { label: "Desktop 1280×800", width: 1280, height: 800, scale: 1 },
    { label: "Desktop 1920×1080", width: 1920, height: 1080, scale: 1 },
    { label: "Tablet 768×1024", width: 768, height: 1024, scale: 2 },
    { label: "Mobile 375×812", width: 375, height: 812, scale: 2 },
    { label: "Mobile 390×844", width: 390, height: 844, scale: 2 },
  ];

  console.log("Testing: no text overlaps windrose SVG\n");

  for (const vp of viewports) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.scale,
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const passed = await checkOverlap(page, vp.label);
    if (!passed) allPassed = false;
    await ctx.close();
  }

  console.log("\nTesting: legend content not clipped\n");

  for (const vp of viewports) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.scale,
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const passed = await checkLegendNotClipped(page, vp.label);
    if (!passed) allPassed = false;
    await ctx.close();
  }

  console.log("\nTesting: windrose-column gap enforcement\n");

  for (const vp of viewports) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.scale,
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const passed = await checkColumnGap(page, vp.label);
    if (!passed) allPassed = false;
    await ctx.close();
  }

  console.log("\nTesting: chart-wrap body heights equal\n");

  // Only test desktop/tablet where C2 charts are visible side-by-side
  const wideViewports = viewports.filter((vp) => vp.width >= 768);
  for (const vp of wideViewports) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.scale,
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const passed = await checkChartWrapHeights(page, vp.label);
    if (!passed) allPassed = false;
    await ctx.close();
  }

  await browser.close();
  server.close();

  console.log(
    allPassed ? "\n✓ All viewports passed" : "\n✗ Some viewports failed",
  );
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
