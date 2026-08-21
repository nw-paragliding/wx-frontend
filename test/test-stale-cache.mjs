/* test-stale-cache.mjs — regression tests for stale cached station data.
 *
 * Loads the real static/app.js in a VM with a stub DOM and a controllable
 * clock, then drives refreshAll() / handleWsSnapshot() / hydrateFromLocalStorage()
 * with synthetic payloads.
 *
 * Covers two related bugs:
 *   1. A station reporting no data kept rendering its last known windrose,
 *      while the chart correctly blanked — so the rose showed wind that had
 *      stopped blowing hours earlier.
 *   2. Cached data had no expiry, so an unreachable backend or a stalled
 *      WebSocket left old readings on screen indefinitely.
 *
 * No dependencies — run with:  node test/test-stale-cache.mjs
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "static", "app.js");

const MIN = 60 * 1000;
const T0 = 1787271500000;
const DEAD = "NorthLaunch";
const LIVE = "TigerLZ";
const STATIONS = [DEAD, LIVE];

// ── Fixtures ─────────────────────────────────────────────────────
const rose = (station, total) => ({
  station, total, max_petal_pct: 0.3,
  latest_speed: 11.4, latest_dir: 338,
  petals: [{ idx: 0, angle: 0, count: total, speed_buckets: [] }],
});
const pts = (n) =>
  Array.from({ length: n }, (_, i) => ({ t: 1787270000 + i, speed: 5, dir: 340 }));

// The server omits a station whose query failed, and includes one that was
// queried successfully but had no readings (total 0 / empty points).
const WIND_DEAD_EMPTY = { stations: { [DEAD]: rose(DEAD, 0), [LIVE]: rose(LIVE, 200) } };
const TS_DEAD_EMPTY = { stations: { [DEAD]: { points: [] }, [LIVE]: { points: pts(50) } } };
const WIND_DEAD_ABSENT = { stations: { [LIVE]: rose(LIVE, 200) } };
const TS_DEAD_ABSENT = { stations: { [LIVE]: { points: pts(50) } } };

// ── Harness ──────────────────────────────────────────────────────
function stubEl() {
  return {
    className: "", innerHTML: "", textContent: "", style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, removeEventListener() {}, appendChild() {},
    querySelectorAll: () => [], querySelector: () => null,
    getBoundingClientRect: () => ({ width: 300, height: 200, left: 0, top: 0 }),
    setAttribute() {}, getAttribute: () => null, remove() {},
    offsetWidth: 300, offsetHeight: 200, children: [],
  };
}

function load() {
  const src = fs.readFileSync(APP, "utf8").replace(/\ninit\(\);\s*$/, "\n");
  const store = new Map();
  let NOW = T0;
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
    static now() { return NOW; }
  }
  const ctx = {
    console,
    navigator: { onLine: true },           // no serviceWorker key -> skip SW block
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      getElementById: () => stubEl(), createElement: () => stubEl(),
      addEventListener() {}, body: stubEl(), documentElement: stubEl(),
      querySelectorAll: () => [], querySelector: () => null,
    },
    location: { reload() {}, host: "x", protocol: "https:" },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    requestAnimationFrame: () => 0,
    ResizeObserver: class { observe() {} disconnect() {} },
    WebSocket: class { constructor() { this.readyState = 0; } send() {} close() {} },
    uPlot: class { setData() {} destroy() {} setSize() {} },
    fetch: () => Promise.reject(new Error("no network")),
    Date: FakeDate,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: APP });

  ctx.__setNow = (v) => { NOW = v; };
  ctx.__seed = (k, v) => store.set(k, JSON.stringify(v));

  // Swap the DOM-heavy renderers for spies that record what they were handed.
  const seen = { rose: {}, speed: {}, status: {} };
  ctx.renderWindrose = (wrap, data, st) => { seen.rose[st] = data; };
  ctx.renderMetrics = () => {};
  ctx.renderSpeedChart = (st, p) => { seen.speed[st] = p; };
  ctx.renderDirChart = () => {};
  ctx.renderTimeAxis = () => {};
  ctx.computeSharedScales = () => {};
  ctx.updateStationStatus = (st, ok) => { seen.status[st] = ok; };

  ctx.CFG.stations = STATIONS;
  ctx.timeRange = "15m";
  return { ctx, seen };
}

function withCachedDeadStation() {
  const { ctx, seen } = load();
  ctx.stationData[DEAD] = rose(DEAD, 210);
  ctx.tsData[DEAD] = pts(3);
  ctx.markFresh(DEAD);          // real cached data always carries a stamp
  return { ctx, seen };
}

function routeFetch(ctx, w, t) {
  ctx.fetch = (u) => Promise.resolve({
    ok: true, statusText: "OK",
    json: () => Promise.resolve(u.includes("/api/wind") ? w : t),
  });
}

// ── Runner ───────────────────────────────────────────────────────
let pass = 0, fail = 0;
const check = (name, cond, detail) =>
  cond ? (pass++, console.log("  ok   " + name))
       : (fail++, console.log("  FAIL " + name + (detail ? "  -> " + detail : "")));
const group = (n) => console.log("\n" + n);

// Silence the deliberate offline-path console.error noise.
const realErr = console.error;
console.error = () => {};

group("empty station clears the rose (HTTP)");
{
  const { ctx, seen } = withCachedDeadStation();
  routeFetch(ctx, WIND_DEAD_EMPTY, TS_DEAD_EMPTY);
  await ctx.refreshAll();
  check("rose cleared", !seen.rose[DEAD]);
  check("chart cleared", (seen.speed[DEAD] || []).length === 0);
  check("neighbour still rendered", !!seen.rose[LIVE] && seen.rose[LIVE].total === 200);
  check("evicted from cache object", !(DEAD in ctx.stationData));
}

group("empty station clears the rose (WebSocket)");
{
  const { ctx, seen } = withCachedDeadStation();
  ctx.handleWsSnapshot({
    type: "snapshot", ts: 1, range: "15m",
    stations: WIND_DEAD_EMPTY.stations,
    timeseries: { [DEAD]: [], [LIVE]: pts(50) },
  });
  check("rose cleared", !seen.rose[DEAD]);
  check("chart cleared", (seen.speed[DEAD] || []).length === 0);
  check("neighbour still rendered", !!seen.rose[LIVE]);
}

group("failed query keeps last known (offline tolerance)");
{
  const { ctx, seen } = withCachedDeadStation();
  routeFetch(ctx, WIND_DEAD_ABSENT, TS_DEAD_ABSENT);
  await ctx.refreshAll();
  check("absent station retains rose", !!seen.rose[DEAD] && seen.rose[DEAD].total === 210);
}
{
  const { ctx, seen } = withCachedDeadStation();
  ctx.fetch = () => Promise.reject(new Error("offline"));
  await ctx.refreshAll();
  check("network error retains rose", !!seen.rose[DEAD]);
}

group("cache TTL");
{
  const { ctx } = load();
  check("TTL is a few minutes", ctx.CACHE_TTL_MS === 5 * MIN, String(ctx.CACHE_TTL_MS));
  check("sweep is well under TTL",
    ctx.TTL_SWEEP_MS > 0 && ctx.TTL_SWEEP_MS < ctx.CACHE_TTL_MS, String(ctx.TTL_SWEEP_MS));
}
{
  const { ctx } = load();
  ctx.__seed("windrose_data_v4", { [DEAD]: rose(DEAD, 210) });
  ctx.__seed("windrose_ts_data_v4", { [DEAD]: pts(3) });
  ctx.__seed("windrose_station_ts_v4", { [DEAD]: T0 - 6 * MIN });
  ctx.hydrateFromLocalStorage();
  check("cold load drops cache older than TTL", !ctx.stationData[DEAD]);
  check("cold load drops its points too", !ctx.tsData[DEAD]);
}
{
  const { ctx } = load();
  ctx.__seed("windrose_data_v4", { [DEAD]: rose(DEAD, 210) });
  ctx.__seed("windrose_station_ts_v4", { [DEAD]: T0 - 2 * MIN });
  ctx.hydrateFromLocalStorage();
  check("cold load keeps cache within TTL", !!ctx.stationData[DEAD]);
}
{
  const { ctx } = load();
  ctx.__seed("windrose_data_v4", { [DEAD]: rose(DEAD, 210) });   // no timestamp
  ctx.hydrateFromLocalStorage();
  check("untimestamped legacy cache treated as stale", !ctx.stationData[DEAD]);
}

group("TTL is per-station, not global");
{
  const { ctx } = withCachedDeadStation();
  routeFetch(ctx, WIND_DEAD_ABSENT, TS_DEAD_ABSENT);   // dead station never reports
  ctx.markFresh(LIVE);
  ctx.__setNow(T0 + 6 * MIN);                          // neighbours keep reporting
  await ctx.refreshAll();
  check("dead station expires anyway", !ctx.stationData[DEAD]);
  check("reporting neighbour unaffected", !!ctx.stationData[LIVE]);
}

group("expiry runs without any network traffic (stalled WebSocket)");
{
  const { ctx, seen } = withCachedDeadStation();
  ctx.__setNow(T0 + 6 * MIN);
  check("expireStale reports work", ctx.expireStale() === true);
  ctx.renderAllStations();
  check("rose blanked", !seen.rose[DEAD]);
  check("chart blanked", (seen.speed[DEAD] || []).length === 0);
}

group("offline: shown within TTL, blanked past it");
{
  const { ctx, seen } = withCachedDeadStation();
  ctx.fetch = () => Promise.reject(new Error("offline"));
  ctx.__setNow(T0 + 2 * MIN);
  await ctx.refreshAll();
  check("still shown at 2 min", !!seen.rose[DEAD]);
  ctx.__setNow(T0 + 6 * MIN);
  await ctx.refreshAll();
  check("blanked at 6 min", !seen.rose[DEAD]);
}

console.error = realErr;
console.log("\n" + (fail ? "FAILED" : "PASSED") + `  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
