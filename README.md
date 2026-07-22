# wx-frontend

A lightweight, mobile-first **wind dashboard** for paragliding pilots. A single Rust
(`axum`) binary queries InfluxDB 2, computes wind-rose data server-side, and serves a
self-contained dark-mode SPA — no build step, no framework.

Built for the Northwest Paragliding Club at Tiger Mountain (Issaquah, WA).

> **Status:** early / in progress. The wind-rose and time-series chart views work; the
> forecast view and some roadmap items are not built yet.

## Features

- **Wind rose per station** — SVG petals bucketed by speed, with a live stats overlay
  (gust/lull as configurable percentiles, average, temperature, humidity).
- **Time-series scatter charts** — speed and direction over time, rendered with
  [µPlot](https://github.com/leeoniya/uPlot) (vendored locally, no CDN).
- **Selectable time range** — 5m / 15m / 30m / 1h / 2h, driving both the rose and charts.
- **Auto-refresh** with a green/amber/red connection status indicator.
- **Real-time push** over a WebSocket (`/ws`), with HTTP polling as a fallback.
- **Offline support** via a service worker + `localStorage`.
- **Server-side computation** — the API returns ~2–3 KB of pre-bucketed JSON per refresh
  instead of raw data, and queries all stations concurrently.

## Architecture

```
Browser (SPA)  ──►  GET /              index.html + inline SVG rose
               ──►  GET /api/config    stations, units, display config
               ──►  GET /api/wind      pre-computed wind-rose JSON (all stations)
               ──►  GET /api/timeseries raw (speed, dir) points, downsampled
               ◄─►  WS  /ws            real-time point + windrose push
                        │
                        ▼
                   windrose-rs (axum)  ──►  InfluxDB 2  (Flux / v2 query API)
```

## Files

```
Cargo.toml
Dockerfile              # Multi-stage: rust builder → debian slim runtime
docker-compose.yml      # Reads config from a local .env (not committed)
env.example             # All config vars with comments
src/
  main.rs               # Server: config, InfluxDB query, windrose math, HTTP + WS handlers
static/
  index.html            # SPA markup
  app.js                # Data fetching, rendering, WebSocket handling
  app.css / layout.css / theme.css
  sw.js                 # Service worker (offline support)
  uPlot.min.js / uPlot.min.css   # Vendored charting library
```

## Running locally

```sh
export INFLUXDB_URL=http://localhost:8086
export INFLUXDB_TOKEN=...        # required; do not commit real tokens
export PORT=8080
cargo run
# → http://localhost:8080
```

Static files are served from disk (`STATIC_DIR`, default `./static/`) — edit and refresh,
no rebuild needed. For verbose logging (shows Flux queries and raw CSV):

```sh
RUST_LOG=windrose_rs=debug cargo run
```

## Configuration

All configuration is via environment variables. For deployment, put them in a `.env` file
next to `docker-compose.yml`. **Never commit real credentials** — copy `env.example` to
`.env` and fill it in.

### Core

| Variable | Default | Description |
|---|---|---|
| `INFLUXDB_URL` | `http://localhost:8086` | InfluxDB 2 base URL |
| `INFLUXDB_TOKEN` | *(empty)* | InfluxDB API token |
| `INFLUXDB_ORG` | `default` | InfluxDB organization |
| `INFLUXDB_BUCKET` | `weather` | Bucket containing wind data |
| `INFLUXDB_MEASUREMENT` | `drw` | Measurement name |
| `SPEED_FIELD` | `windspeed` | Field name for wind speed (source units, pre-multiplier) |
| `DIRECTION_FIELD` | `direction` | Field name for wind direction (degrees, 0=N clockwise) |
| `STATION_TAG` | `station` | Tag key that identifies the station |
| `STATIONS` | `NorthLaunch,SouthLaunch,TigerLZ` | Comma-separated station tag values |
| `CALM_SENTINEL_STATIONS` | *(empty)* | Stations where `speed == 0` and `direction == 360` are sensor "no-data" sentinels and are excluded |
| `SPEED_MULTIPLIER` | `1.0` | Server-side multiplier for raw speed. `2.236936` for m/s→mph, `0.621371` for km/h→mph. Read when the container is **created** — recreate (`docker compose up -d`), don't just restart |
| `TITLE` | `Wind Rose` | Page title shown top-left |
| `PORT` | `80` | HTTP listen port |

### Windrose display

| Variable | Default | Description |
|---|---|---|
| `SPEED_BUCKET_COUNT` | `6` | Number of speed color bands |
| `SPEED_BUCKET_SIZE` | `4` | Width of each speed band in display units (last band is open-ended) |
| `PETALS_PER_90DEG` | `4` | Direction resolution. 4 = 16 petals |

### Optional fields, charts, units, runtime

| Variable | Default | Description |
|---|---|---|
| `HUMIDITY_FIELD` | *(unset)* | InfluxDB field for humidity; if set, latest value is shown |
| `TEMPERATURE_FIELD` | *(unset)* | InfluxDB field for temperature; if set, latest value is shown |
| `STATION_IDEAL_DIRS` | *(unset)* | Ideal wind directions per station for direction-dot colors. Per direction: `center center-width ccw-width cw-width`. Multiple centers joined with `+`, stations with `,` |
| `SITE_ELEVATION_FT` | `0` | Site elevation (feet), for future cloudbase calculations |
| `SPEED_UNIT` | `mph` | Displayed next to wind speed |
| `TEMPERATURE_UNIT` | `°F` | Displayed next to temperature |
| `HUMIDITY_UNIT` | `%` | Displayed next to humidity |
| `STATIC_DIR` | `static` | Directory containing the static assets |
| `RUST_LOG` | `windrose_rs=info` | Log level (`windrose_rs=debug` shows Flux + raw CSV) |

See [`env.example`](env.example) for the full annotated list.

## Deployment

Build and run with Docker Compose (provide a `.env` with your InfluxDB connection):

```sh
docker compose up -d --build
```

The image is a multi-stage build (Rust binary layer separate from the static assets), so
CSS/JS-only changes rebuild in seconds.

## License

TBD.
