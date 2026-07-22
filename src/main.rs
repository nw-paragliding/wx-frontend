use axum::{
    extract::{ws, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::env;
use std::hash::{Hash, Hasher};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use tracing::{debug, error, info, warn};

/// Hash the server binary + every file in `static_dir` to produce a hex fingerprint.
/// Changes whenever the binary OR any served file changes — used as the SW cache key.
fn compute_build_hash(static_dir: &Path) -> String {
    let mut hasher = DefaultHasher::new();

    // Include the server binary so Rust-only changes also bust the cache
    if let Ok(exe) = std::env::current_exe() {
        if let Ok(contents) = std::fs::read(&exe) {
            contents.hash(&mut hasher);
        }
    }

    // Include all static files
    let mut entries: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::fs::read_dir(static_dir) {
        for entry in dir.flatten() {
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                entries.push(entry.path());
            }
        }
    }
    entries.sort(); // deterministic order

    for path in &entries {
        if let Ok(contents) = std::fs::read(path) {
            path.file_name().unwrap_or_default().hash(&mut hasher);
            contents.hash(&mut hasher);
        }
    }

    format!("{:016x}", hasher.finish())
}

// ── Config ──────────────────────────────────────────────────────────────────

/// A single ideal wind direction for a station.
///
/// The wind is best from `center_deg`. Within `±green_half` of the center the
/// direction is fully favorable (deep green). Past each green edge the color
/// ramps to the reddest bucket over `ccw_fade` degrees going counter-clockwise
/// (toward lower bearings) and `cw_fade` degrees going clockwise (toward higher
/// bearings). The two sides are independent, so an asymmetric window fits.
#[derive(Clone, Debug, Serialize)]
struct IdealDirection {
    center_deg: f64,
    green_half: f64,
    ccw_fade: f64,
    cw_fade: f64,
}

/// Default fade width (degrees from the green edge to the reddest bucket) used
/// when a direction omits its fade numbers.
const DEFAULT_FADE_WIDTH: f64 = 45.0;

/// Parse one direction spec: four whitespace-separated numbers
/// `center center-width ccw-width cw-width`.
///
/// - `center`        bearing the wind is best from
/// - `center-width`  half-width of the deep-green core (± this many degrees)
/// - `ccw-width`     degrees from the green edge, counter-clockwise, to red
/// - `cw-width`      degrees from the green edge, clockwise, to red
///
/// Trailing numbers may be omitted: 1 = center only, 2 = + core, 3 = + a
/// symmetric fade width used for both sides.
fn parse_ideal_direction(spec: &str, ctx: &str) -> Option<IdealDirection> {
    let mut vals = Vec::new();
    for tok in spec.split_whitespace() {
        match tok.parse::<f64>() {
            Ok(v) => vals.push(v),
            Err(_) => {
                warn!(
                    "STATION_IDEAL_DIRS: non-numeric value '{}' in '{}'",
                    tok, ctx
                );
                return None;
            }
        }
    }
    if vals.is_empty() {
        return None;
    }
    if vals.len() > 4 {
        warn!(
            "STATION_IDEAL_DIRS: expected up to 4 numbers (center center-width \
             ccw-width cw-width), got {} in '{}'",
            vals.len(),
            ctx
        );
    }
    let center_deg = vals[0];
    let green_half = vals.get(1).copied().unwrap_or(0.0).max(0.0);
    let ccw = vals.get(2).copied().unwrap_or(DEFAULT_FADE_WIDTH);
    let cw = vals.get(3).copied().unwrap_or(ccw);
    Some(IdealDirection {
        center_deg,
        green_half,
        ccw_fade: ccw.max(0.0),
        cw_fade: cw.max(0.0),
    })
}

/// Parse the `STATION_IDEAL_DIRS` env var.
///
/// Format: `Name: <dir>[+<dir>...], Name2: ...` where each `<dir>` is four
/// numbers (see [`parse_ideal_direction`]). Stations are separated by `,`, a
/// station's multiple centers by `+`. Example:
/// `NorthLaunch: 337.5 22.5 67.5 45, TigerLZ: 0 20 40 40 + 180 20 40 40`
fn parse_station_ideal_dirs(raw: &str) -> HashMap<String, Vec<IdealDirection>> {
    let mut map: HashMap<String, Vec<IdealDirection>> = HashMap::new();
    if raw.trim().is_empty() {
        return map;
    }
    for station_part in raw.split(',') {
        let station_part = station_part.trim();
        if station_part.is_empty() {
            continue;
        }
        let Some((name, dirs_str)) = station_part.split_once(':') else {
            warn!(
                "STATION_IDEAL_DIRS: skipping malformed entry (no ':'): '{}'",
                station_part
            );
            continue;
        };
        let name = name.trim().to_string();
        if name.is_empty() {
            warn!("STATION_IDEAL_DIRS: skipping entry with empty station name");
            continue;
        }
        let mut dirs = Vec::new();
        for dir_part in dirs_str.split('+') {
            let dir_part = dir_part.trim();
            if dir_part.is_empty() {
                continue;
            }
            if let Some(d) = parse_ideal_direction(dir_part, station_part) {
                dirs.push(d);
            }
        }
        if !dirs.is_empty() {
            map.insert(name, dirs);
        }
    }
    map
}

#[derive(Clone, Debug)]
struct Config {
    influxdb_url: String,
    influxdb_token: String,
    influxdb_org: String,
    influxdb_bucket: String,
    measurement: String,
    stations: Vec<String>,
    speed_multiplier: f64,
    speed_field: String,
    direction_field: String,
    station_tag: String,
    title: String,
    port: u16,
    speed_bucket_count: usize,
    speed_bucket_size: f64,
    petals_per_90deg: usize,
    static_dir: PathBuf,
    humidity_field: Option<String>,
    temperature_field: Option<String>,
    speed_unit: String,
    temperature_unit: String,
    humidity_unit: String,
    station_ideal_dirs: HashMap<String, Vec<IdealDirection>>,
    site_elevation_ft: f64,
    calm_sentinel_stations: HashSet<String>,
    build_hash: String,
}

// Embedded fallbacks for development (used when static_dir files are missing)

impl Config {
    fn from_env() -> Self {
        Self {
            influxdb_url: env::var("INFLUXDB_URL")
                .unwrap_or_else(|_| "http://localhost:8086".into()),
            influxdb_token: env::var("INFLUXDB_TOKEN").unwrap_or_default(),
            influxdb_org: env::var("INFLUXDB_ORG").unwrap_or_else(|_| "default".into()),
            influxdb_bucket: env::var("INFLUXDB_BUCKET").unwrap_or_else(|_| "weather".into()),
            measurement: env::var("INFLUXDB_MEASUREMENT").unwrap_or_else(|_| "drw".into()),
            stations: env::var("STATIONS")
                .unwrap_or_else(|_| "NorthLaunch,SouthLaunch,TigerLZ".into())
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            speed_multiplier: env::var("SPEED_MULTIPLIER")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1.0),
            speed_field: env::var("SPEED_FIELD").unwrap_or_else(|_| "windspeed".into()),
            direction_field: env::var("DIRECTION_FIELD").unwrap_or_else(|_| "direction".into()),
            station_tag: env::var("STATION_TAG").unwrap_or_else(|_| "station".into()),
            title: env::var("TITLE").unwrap_or_else(|_| "Wind Rose".into()),
            port: env::var("PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(80),
            speed_bucket_count: env::var("SPEED_BUCKET_COUNT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(6),
            speed_bucket_size: env::var("SPEED_BUCKET_SIZE")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(4.0),
            static_dir: PathBuf::from(
                env::var("STATIC_DIR").unwrap_or_else(|_| "static".to_string()),
            ),
            petals_per_90deg: env::var("PETALS_PER_90DEG")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(4),
            humidity_field: env::var("HUMIDITY_FIELD").ok().filter(|s| !s.is_empty()),
            temperature_field: env::var("TEMPERATURE_FIELD").ok().filter(|s| !s.is_empty()),
            speed_unit: env::var("SPEED_UNIT").unwrap_or_else(|_| "mph".into()),
            temperature_unit: env::var("TEMPERATURE_UNIT").unwrap_or_else(|_| "°F".into()),
            humidity_unit: env::var("HUMIDITY_UNIT").unwrap_or_else(|_| "%".into()),
            station_ideal_dirs: env::var("STATION_IDEAL_DIRS")
                .map(|v| parse_station_ideal_dirs(&v))
                .unwrap_or_default(),
            site_elevation_ft: env::var("SITE_ELEVATION_FT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.0),
            calm_sentinel_stations: env::var("CALM_SENTINEL_STATIONS")
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            build_hash: String::new(), // filled in after static_dir is known
        }
    }
}

// ── API types ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct WindQuery {
    range: Option<String>,
}

/// A single speed sub-bucket within a directional petal.
#[derive(Serialize, Clone, Debug)]
struct SpeedBucket {
    /// Index into the color palette (0 = slowest)
    index: usize,
    /// How many readings fell in this speed range within this petal
    count: usize,
    /// Upper speed bound for this bucket (mph). Last bucket is open-ended
    /// but we still send the nominal bound; the client knows the last is ">".
    upper_bound: f64,
    /// Fraction of the max-petal count this sub-bucket represents (for radial size)
    petal_rel: f64,
    /// Fraction of total readings across all directions
    total_rel: f64,
}

/// One directional petal of the windrose.
#[derive(Serialize, Clone, Debug)]
struct Petal {
    /// Petal index (0..n_petals)
    idx: usize,
    /// Center angle in degrees (0 = North, clockwise)
    angle: f64,
    /// Total readings in this direction
    count: usize,
    /// Speed sub-buckets, ordered slowest → fastest, only up to the highest
    /// non-zero bucket
    speed_buckets: Vec<SpeedBucket>,
}

/// Pre-computed windrose for a single station.
#[derive(Serialize, Clone, Debug)]
struct WindroseData {
    station: String,
    petals: Vec<Petal>,
    /// Fraction of total readings in the most-populated petal
    max_petal_pct: f64,
    /// Total number of (speed, direction) readings
    total: usize,
    /// Most recent wind speed (after SPEED_MULTIPLIER)
    latest_speed: Option<f64>,
    /// Most recent wind direction, degrees
    latest_dir: Option<f64>,
    /// Most recent humidity reading (if configured)
    humidity: Option<f64>,
    /// Most recent temperature reading (if configured)
    temperature: Option<f64>,
}

/// Response for the batch endpoint — all stations in one shot.
#[derive(Serialize)]
struct BatchResponse {
    stations: HashMap<String, WindroseData>,
}

// ── Timeseries API types ────────────────────────────────────────────────────

/// A single raw data point in the timeseries.
#[derive(Serialize, Clone, Debug)]
struct TimeseriesPoint {
    /// Unix timestamp in seconds
    t: i64,
    /// Wind speed in display units (after SPEED_MULTIPLIER)
    speed: f64,
    /// Wind direction in degrees (0 = North, clockwise)
    dir: f64,
}

/// Timeseries data for a single station.
#[derive(Serialize, Clone)]
struct StationTimeseries {
    points: Vec<TimeseriesPoint>,
}

/// Batch response for the timeseries endpoint — all stations in one shot.
#[derive(Serialize)]
struct TimeseriesBatchResponse {
    stations: HashMap<String, StationTimeseries>,
}

// ── WebSocket message types ─────────────────────────────────────────────────

/// A full snapshot pushed to clients: windrose + recent timeseries for all stations.
#[derive(Serialize, Clone, Debug)]
struct WsSnapshot {
    /// Message type discriminator
    #[serde(rename = "type")]
    msg_type: String,
    /// Unix timestamp when this snapshot was computed
    ts: i64,
    /// Time range used for windrose computation
    range: String,
    /// Windrose data per station
    stations: HashMap<String, WindroseData>,
    /// Recent timeseries points per station (for chart catch-up)
    timeseries: HashMap<String, Vec<TimeseriesPoint>>,
}

/// Shared application state passed to handlers.
#[derive(Clone)]
struct AppState {
    config: Config,
}

#[derive(Serialize)]
struct AppConfig {
    stations: Vec<String>,
    title: String,
    speed_bucket_count: usize,
    speed_bucket_size: f64,
    petals_per_90deg: usize,
    speed_unit: String,
    temperature_unit: String,
    humidity_unit: String,
    ideal_directions: HashMap<String, Vec<IdealDirection>>,
    site_elevation_ft: f64,
    has_forecast: bool,
    build_hash: String,
}

// ── Windrose computation ────────────────────────────────────────────────────

fn compute_windrose(
    station: &str,
    speeds: &[f64],
    directions: &[f64],
    config: &Config,
) -> WindroseData {
    // Filter out bad data where speed == 0
    let filtered: Vec<(f64, f64)> = speeds
        .iter()
        .zip(directions.iter())
        .filter(|(&s, _)| s > 0.0)
        .map(|(&s, &d)| (s, d))
        .collect();

    let n_petals = config.petals_per_90deg * 4;
    let bucket_deg = 360.0 / n_petals as f64;
    let s_buckets = config.speed_bucket_count;
    let s_bucket_size = config.speed_bucket_size;
    let total = filtered.len();

    // Bin each reading into a directional petal
    let mut dir_buckets: Vec<Vec<f64>> = vec![Vec::new(); n_petals];
    for &(spd, dir) in &filtered {
        let d = ((dir % 360.0) + 360.0) % 360.0;
        let mut idx = ((d + bucket_deg / 2.0) % 360.0 / bucket_deg).floor() as usize;
        if idx >= n_petals {
            idx = 0;
        }
        dir_buckets[idx].push(spd);
    }

    // Find the petal with the most readings (for normalization)
    let max_petal_count = dir_buckets.iter().map(|b| b.len()).max().unwrap_or(0);

    let mut petals = Vec::new();
    for (p, arr) in dir_buckets.iter().enumerate() {
        if arr.is_empty() {
            continue;
        }

        // Count readings per speed bucket
        let mut sb_counts = vec![0usize; s_buckets];
        for &spd in arr {
            let si = ((spd / s_bucket_size).floor() as usize).min(s_buckets - 1);
            sb_counts[si] += 1;
        }

        // Find highest non-zero bucket
        let highest = sb_counts.iter().rposition(|&c| c > 0).unwrap_or(0);

        let mut speed_buckets = Vec::new();
        for (j, &count) in sb_counts.iter().enumerate().take(highest + 1) {
            speed_buckets.push(SpeedBucket {
                index: j,
                count,
                upper_bound: s_bucket_size * (j + 1) as f64,
                petal_rel: if max_petal_count > 0 {
                    count as f64 / max_petal_count as f64
                } else {
                    0.0
                },
                total_rel: if total > 0 {
                    count as f64 / total as f64
                } else {
                    0.0
                },
            });
        }

        petals.push(Petal {
            idx: p,
            angle: bucket_deg * p as f64,
            count: arr.len(),
            speed_buckets,
        });
    }

    let max_petal_pct = if total > 0 {
        max_petal_count as f64 / total as f64
    } else {
        0.0
    };

    WindroseData {
        station: station.to_string(),
        petals,
        max_petal_pct,
        total,
        latest_speed: None,
        latest_dir: None,
        humidity: None,
        temperature: None,
    }
}

// ── InfluxDB query ──────────────────────────────────────────────────────────

struct RawWind {
    speeds: Vec<f64>,
    directions: Vec<f64>,
}

/// Pick an `aggregateWindow` duration (seconds) so a query returns roughly
/// <= 500 points across `range`: InfluxDB downsamples (and joins) server-side
/// instead of shipping every raw ~3s reading. Returns ~1s for short ranges,
/// which is below the reporting interval, so there's effectively no loss.
fn downsample_window_secs(range: &str) -> u64 {
    let range_secs: u64 = match range {
        "5m" => 300,
        "15m" => 900,
        "30m" => 1800,
        "1h" => 3600,
        "2h" => 7200,
        "4h" => 14400,
        "8h" => 28800,
        _ => 900,
    };
    range_secs.div_ceil(500).max(1)
}

async fn query_influxdb(config: &Config, station: &str, range: &str) -> Result<RawWind, String> {
    let flux = format!(
        r#"speed = from(bucket: "{bucket}")
  |> range(start: -{range})
  |> filter(fn: (r) => r._measurement == "{measurement}")
  |> filter(fn: (r) => r.{station_tag} == "{station}")
  |> filter(fn: (r) => r._field == "{speed_field}")
  |> aggregateWindow(every: {window}s, fn: last, createEmpty: false)
  |> keep(columns: ["_time", "_value"])
  |> rename(columns: {{_value: "speed"}})

dir = from(bucket: "{bucket}")
  |> range(start: -{range})
  |> filter(fn: (r) => r._measurement == "{measurement}")
  |> filter(fn: (r) => r.{station_tag} == "{station}")
  |> filter(fn: (r) => r._field == "{direction_field}")
  |> aggregateWindow(every: {window}s, fn: last, createEmpty: false)
  |> keep(columns: ["_time", "_value"])
  |> rename(columns: {{_value: "direction"}})

join(tables: {{speed: speed, dir: dir}}, on: ["_time"])
  |> keep(columns: ["speed", "direction"])
  |> yield(name: "result")"#,
        bucket = config.influxdb_bucket,
        range = range,
        window = downsample_window_secs(range),
        measurement = config.measurement,
        station_tag = config.station_tag,
        station = station,
        speed_field = config.speed_field,
        direction_field = config.direction_field,
    );

    debug!("Flux query for station '{}':\n{}", station, flux);

    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/v2/query?org={}",
        config.influxdb_url, config.influxdb_org
    );

    let resp = client
        .post(&url)
        .header("Authorization", format!("Token {}", config.influxdb_token))
        .header("Content-Type", "application/vnd.flux")
        .header("Accept", "application/csv")
        .body(flux)
        .send()
        .await
        .map_err(|e| format!("InfluxDB request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("InfluxDB returned {}: {}", status, body));
    }

    let csv_body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    debug!(
        "InfluxDB CSV response for '{}' ({} bytes):\n{}",
        station,
        csv_body.len(),
        &csv_body[..csv_body.len().min(2000)]
    );

    let mut speeds = Vec::new();
    let mut directions = Vec::new();

    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(csv_body.as_bytes());

    let headers = rdr
        .headers()
        .map_err(|e| format!("CSV header parse error: {}", e))?
        .clone();

    debug!("CSV headers for '{}': {:?}", station, headers);

    let speed_idx = headers.iter().position(|h| h == "speed");
    let direction_idx = headers.iter().position(|h| h == "direction");

    if speed_idx.is_none() || direction_idx.is_none() {
        warn!(
            "Missing columns for '{}': speed_idx={:?}, direction_idx={:?}",
            station, speed_idx, direction_idx
        );
        return Ok(RawWind { speeds, directions });
    }
    let speed_idx = speed_idx.unwrap();
    let direction_idx = direction_idx.unwrap();

    let multiplier = config.speed_multiplier;

    for result in rdr.records() {
        let record = match result {
            Ok(r) => r,
            Err(_) => continue,
        };

        // Skip InfluxDB annotation rows (start with #), but NOT empty-first-column
        // rows — the annotated CSV format uses an empty first column for data rows.
        if let Some(first) = record.get(0) {
            if first.starts_with('#') {
                continue;
            }
        }

        let spd: f64 = match record.get(speed_idx).and_then(|v| v.parse::<f64>().ok()) {
            Some(v) => v * multiplier,
            None => continue,
        };
        let dir: f64 = match record
            .get(direction_idx)
            .and_then(|v| v.parse::<f64>().ok())
        {
            Some(v) => v,
            None => continue,
        };
        // Filter calm sentinel: drop points where speed is effectively zero.
        // Direction is meaningless at zero wind, and the amateur station on
        // TigerLZ reports 0/360 as a "no-data" sentinel.  Using an epsilon
        // rather than exact equality guards against floating-point artifacts.
        if config.calm_sentinel_stations.contains(station) && spd < 0.01 {
            continue;
        }

        speeds.push(spd);
        directions.push(dir);
    }

    info!("Parsed {} data points for '{}'", speeds.len(), station);

    Ok(RawWind { speeds, directions })
}

/// Query the most recent value of a single field from InfluxDB.
async fn query_last_value(
    config: &Config,
    station: &str,
    field: &str,
) -> Result<Option<f64>, String> {
    let flux = format!(
        r#"from(bucket: "{bucket}")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "{measurement}")
  |> filter(fn: (r) => r.{station_tag} == "{station}")
  |> filter(fn: (r) => r._field == "{field}")
  |> last()
  |> keep(columns: ["_value"])
  |> yield(name: "result")"#,
        bucket = config.influxdb_bucket,
        measurement = config.measurement,
        station_tag = config.station_tag,
        station = station,
        field = field,
    );

    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/v2/query?org={}",
        config.influxdb_url, config.influxdb_org
    );

    let resp = client
        .post(&url)
        .header("Authorization", format!("Token {}", config.influxdb_token))
        .header("Content-Type", "application/vnd.flux")
        .header("Accept", "application/csv")
        .body(flux)
        .send()
        .await
        .map_err(|e| format!("last-value request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "InfluxDB returned {} for last {}: {}",
            status, field, body
        ));
    }

    let csv_body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read last-value response: {}", e))?;

    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(csv_body.as_bytes());

    let headers = rdr
        .headers()
        .map_err(|e| format!("CSV header parse error: {}", e))?
        .clone();

    let value_idx = headers.iter().position(|h| h == "_value");
    if value_idx.is_none() {
        return Ok(None);
    }
    let value_idx = value_idx.unwrap();

    for result in rdr.records() {
        let record = match result {
            Ok(r) => r,
            Err(_) => continue,
        };
        if let Some(first) = record.get(0) {
            if first.starts_with('#') {
                continue;
            }
        }
        if let Some(val) = record.get(value_idx).and_then(|v| v.parse::<f64>().ok()) {
            return Ok(Some(val));
        }
    }

    Ok(None)
}

/// Fetch raw timestamped (speed, direction) points from InfluxDB for one station.
/// Returns points sorted by time with SPEED_MULTIPLIER already applied to speeds.
async fn query_timeseries(
    config: &Config,
    station: &str,
    range: &str,
) -> Result<Vec<TimeseriesPoint>, String> {
    let flux = format!(
        r#"speed = from(bucket: "{bucket}")
  |> range(start: -{range})
  |> filter(fn: (r) => r._measurement == "{measurement}")
  |> filter(fn: (r) => r.{station_tag} == "{station}")
  |> filter(fn: (r) => r._field == "{speed_field}")
  |> aggregateWindow(every: {window}s, fn: last, createEmpty: false)
  |> keep(columns: ["_time", "_value"])
  |> rename(columns: {{_value: "speed"}})

dir = from(bucket: "{bucket}")
  |> range(start: -{range})
  |> filter(fn: (r) => r._measurement == "{measurement}")
  |> filter(fn: (r) => r.{station_tag} == "{station}")
  |> filter(fn: (r) => r._field == "{direction_field}")
  |> aggregateWindow(every: {window}s, fn: last, createEmpty: false)
  |> keep(columns: ["_time", "_value"])
  |> rename(columns: {{_value: "direction"}})

join(tables: {{speed: speed, dir: dir}}, on: ["_time"])
  |> keep(columns: ["_time", "speed", "direction"])
  |> sort(columns: ["_time"])
  |> yield(name: "result")"#,
        bucket = config.influxdb_bucket,
        range = range,
        window = downsample_window_secs(range),
        measurement = config.measurement,
        station_tag = config.station_tag,
        station = station,
        speed_field = config.speed_field,
        direction_field = config.direction_field,
    );

    debug!("Timeseries Flux query for '{}':\n{}", station, flux);

    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/v2/query?org={}",
        config.influxdb_url, config.influxdb_org
    );

    let resp = client
        .post(&url)
        .header("Authorization", format!("Token {}", config.influxdb_token))
        .header("Content-Type", "application/vnd.flux")
        .header("Accept", "application/csv")
        .body(flux)
        .send()
        .await
        .map_err(|e| format!("InfluxDB timeseries request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "InfluxDB returned {} for timeseries: {}",
            status, body
        ));
    }

    let csv_body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read timeseries response: {}", e))?;

    debug!(
        "Timeseries CSV for '{}' ({} bytes):\n{}",
        station,
        csv_body.len(),
        &csv_body[..csv_body.len().min(2000)]
    );

    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(csv_body.as_bytes());

    let headers = rdr
        .headers()
        .map_err(|e| format!("CSV header parse error: {}", e))?
        .clone();

    let time_idx = headers.iter().position(|h| h == "_time");
    let speed_idx = headers.iter().position(|h| h == "speed");
    let direction_idx = headers.iter().position(|h| h == "direction");

    if time_idx.is_none() || speed_idx.is_none() || direction_idx.is_none() {
        warn!(
            "Timeseries missing columns for '{}': time={:?}, speed={:?}, dir={:?}",
            station, time_idx, speed_idx, direction_idx
        );
        return Ok(Vec::new());
    }
    let time_idx = time_idx.unwrap();
    let speed_idx = speed_idx.unwrap();
    let direction_idx = direction_idx.unwrap();

    let multiplier = config.speed_multiplier;
    let mut points = Vec::new();

    for result in rdr.records() {
        let record = match result {
            Ok(r) => r,
            Err(_) => continue,
        };

        // Skip InfluxDB annotation rows
        if let Some(first) = record.get(0) {
            if first.starts_with('#') {
                continue;
            }
        }

        // Parse RFC3339 timestamp → Unix seconds
        let time_str = match record.get(time_idx) {
            Some(v) if !v.is_empty() => v,
            _ => continue,
        };
        // InfluxDB returns RFC3339 like "2024-01-15T12:34:56.789Z"
        // Parse manually: split at 'T', handle date and time parts
        let unix_sec = match parse_rfc3339_to_unix(time_str) {
            Some(t) => t,
            None => {
                debug!("Timeseries: failed to parse timestamp '{}'", time_str);
                continue;
            }
        };

        let spd: f64 = match record.get(speed_idx).and_then(|v| v.parse::<f64>().ok()) {
            Some(v) => v * multiplier,
            None => continue,
        };
        let dir: f64 = match record
            .get(direction_idx)
            .and_then(|v| v.parse::<f64>().ok())
        {
            Some(v) => v,
            None => continue,
        };

        // Filter calm sentinel: drop points where speed is effectively zero.
        // Direction is meaningless at zero wind, and the amateur station on
        // TigerLZ reports 0/360 as a "no-data" sentinel.  Using an epsilon
        // rather than exact equality guards against floating-point artifacts.
        if config.calm_sentinel_stations.contains(station) && spd < 0.01 {
            continue;
        }

        points.push(TimeseriesPoint {
            t: unix_sec,
            speed: spd,
            dir,
        });
    }

    info!(
        "Timeseries: parsed {} points for '{}'",
        points.len(),
        station
    );

    Ok(points)
}

/// Parse an RFC3339 timestamp string to Unix seconds.
/// Handles formats like "2024-01-15T12:34:56Z" and "2024-01-15T12:34:56.789Z".
fn parse_rfc3339_to_unix(s: &str) -> Option<i64> {
    // Split "2024-01-15T12:34:56.789Z" into date and time parts
    let s = s.trim().trim_end_matches('Z');
    let (date_part, time_part) = s.split_once('T')?;

    let mut date_iter = date_part.split('-');
    let year: i64 = date_iter.next()?.parse().ok()?;
    let month: i64 = date_iter.next()?.parse().ok()?;
    let day: i64 = date_iter.next()?.parse().ok()?;

    // Take only HH:MM:SS, ignore fractional seconds
    let time_core = time_part.split('.').next()?;
    let mut time_iter = time_core.split(':');
    let hour: i64 = time_iter.next()?.parse().ok()?;
    let min: i64 = time_iter.next()?.parse().ok()?;
    let sec: i64 = time_iter.next()?.parse().ok()?;

    // Days from year 1 to the start of `year`, then adjust for Unix epoch (1970)
    // Using a simplified algorithm for dates after 1970
    let mut days: i64 = 0;
    // Years
    for y in 1970..year {
        days += if is_leap_year(y) { 366 } else { 365 };
    }
    // Months
    let month_days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for m in 1..month {
        days += month_days[(m - 1) as usize];
        if m == 2 && is_leap_year(year) {
            days += 1;
        }
    }
    // Days (1-indexed)
    days += day - 1;

    Some(days * 86400 + hour * 3600 + min * 60 + sec)
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// Downsample a timeseries to approximately `target` points using nth-point selection.
/// Preserves the first and last points, and selects evenly spaced points in between.
fn downsample(points: Vec<TimeseriesPoint>, target: usize) -> Vec<TimeseriesPoint> {
    let n = points.len();
    if n <= target || target < 2 {
        return points;
    }
    let mut result = Vec::with_capacity(target);
    result.push(points[0].clone());
    let step = (n - 1) as f64 / (target - 1) as f64;
    for i in 1..target - 1 {
        let idx = (i as f64 * step).round() as usize;
        result.push(points[idx].clone());
    }
    result.push(points[n - 1].clone());
    result
}

/// Fetch raw data from InfluxDB for one station and compute the windrose.
async fn fetch_and_compute(
    config: &Config,
    station: &str,
    range: &str,
) -> Result<WindroseData, String> {
    let raw = query_influxdb(config, station, range).await?;
    let mut data = compute_windrose(station, &raw.speeds, &raw.directions, config);

    // Fetch humidity + temperature concurrently if configured
    let hum_fut = async {
        if let Some(ref field) = config.humidity_field {
            query_last_value(config, station, field)
                .await
                .ok()
                .flatten()
        } else {
            None
        }
    };
    let temp_fut = async {
        if let Some(ref field) = config.temperature_field {
            query_last_value(config, station, field)
                .await
                .ok()
                .flatten()
        } else {
            None
        }
    };

    // Latest wind speed + direction for the "current conditions" info block.
    let speed_fut = async {
        query_last_value(config, station, &config.speed_field)
            .await
            .ok()
            .flatten()
            .map(|v| v * config.speed_multiplier)
    };
    let dir_fut = async {
        query_last_value(config, station, &config.direction_field)
            .await
            .ok()
            .flatten()
    };

    let (hum, temp, latest_speed, latest_dir) = tokio::join!(hum_fut, temp_fut, speed_fut, dir_fut);
    data.humidity = hum;
    data.temperature = temp;
    data.latest_speed = latest_speed;
    data.latest_dir = latest_dir;

    Ok(data)
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn serve_static_file(
    path: &std::path::Path,
    content_type: &'static str,
    cache_control: &'static str,
) -> Response {
    match tokio::fs::read_to_string(path).await {
        Ok(body) => {
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static(cache_control),
            );
            (StatusCode::OK, headers, body).into_response()
        }
        Err(e) => {
            warn!("Static file {:?} not on disk: {}", path, e);
            (StatusCode::NOT_FOUND, "file not found").into_response()
        }
    }
}

async fn handle_index(State(state): State<AppState>) -> Response {
    let config = &state.config;
    let template_path = config.static_dir.join("index.html");
    let template_str = match tokio::fs::read_to_string(&template_path).await {
        Ok(s) => s,
        Err(e) => {
            warn!("Template file {:?} not found: {}", template_path, e);
            return (StatusCode::NOT_FOUND, "template not found").into_response();
        }
    };

    let mut env = minijinja::Environment::new();
    env.add_template("index.html", &template_str).unwrap();
    let tmpl = env.get_template("index.html").unwrap();

    // Build station context objects
    let stations: Vec<serde_json::Value> = config
        .stations
        .iter()
        .map(|st| {
            // Space only at camelCase boundaries (lower -> upper), so acronyms
            // like "LZ" stay intact: "TigerLZ" -> "Tiger LZ".
            let chars: Vec<char> = st.chars().collect();
            let mut label = String::new();
            for (i, &c) in chars.iter().enumerate() {
                if i > 0 && c.is_uppercase() && chars[i - 1].is_lowercase() {
                    label.push(' ');
                }
                label.push(c);
            }
            serde_json::json!({ "id": st, "label": label })
        })
        .collect();

    // Build speed bucket labels for the legend
    let speed_buckets: Vec<serde_json::Value> = (0..config.speed_bucket_count)
        .map(|i| {
            let lower = (i as f64) * config.speed_bucket_size;
            let upper = lower + config.speed_bucket_size;
            let label = if i == config.speed_bucket_count - 1 {
                format!(">{}", lower.round() as i64)
            } else {
                format!("{}\u{2013}{}", lower.round() as i64, upper.round() as i64)
            };
            serde_json::json!({ "index": i, "label": label })
        })
        .collect();

    // Build the CFG JSON that was previously fetched via /api/config
    let app_config = AppConfig {
        stations: config.stations.clone(),
        title: config.title.clone(),
        speed_bucket_count: config.speed_bucket_count,
        speed_bucket_size: config.speed_bucket_size,
        petals_per_90deg: config.petals_per_90deg,
        speed_unit: config.speed_unit.clone(),
        temperature_unit: config.temperature_unit.clone(),
        humidity_unit: config.humidity_unit.clone(),
        ideal_directions: config.station_ideal_dirs.clone(),
        site_elevation_ft: config.site_elevation_ft,
        has_forecast: false,
        build_hash: config.build_hash.clone(),
    };
    let config_json = serde_json::to_string(&app_config).unwrap_or_else(|_| "{}".into());

    let ctx = minijinja::context! {
        title => config.title,
        stations => stations,
        speed_buckets => speed_buckets,
        config_json => config_json,
    };

    match tmpl.render(ctx) {
        Ok(body) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            );
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=3600, stale-while-revalidate=86400"),
            );
            (StatusCode::OK, headers, body).into_response()
        }
        Err(e) => {
            error!("Template render error: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "template error").into_response()
        }
    }
}

async fn handle_sw(State(state): State<AppState>) -> Response {
    let config = &state.config;
    // SW spec: browsers cap this at 24h anyway, but no-cache ensures
    // the browser always revalidates so deploys pick up quickly.
    // Inject the content hash into the __BUILD_HASH__ placeholder
    // so every deploy automatically gets a fresh SW cache name.
    let path = config.static_dir.join("sw.js");
    match tokio::fs::read_to_string(&path).await {
        Ok(body) => {
            let body = body.replace("__BUILD_HASH__", &config.build_hash);
            let mut headers = HeaderMap::new();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/javascript; charset=utf-8"),
            );
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            (StatusCode::OK, headers, body).into_response()
        }
        Err(e) => {
            warn!("Static file {:?} not on disk: {}", path, e);
            (StatusCode::NOT_FOUND, "file not found").into_response()
        }
    }
}

async fn handle_uplot_js(State(state): State<AppState>) -> Response {
    let config = &state.config;
    serve_static_file(
        &config.static_dir.join("uPlot.min.js"),
        "application/javascript; charset=utf-8",
        "public, max-age=31536000, stale-while-revalidate=86400",
    )
    .await
}

async fn handle_uplot_css(State(state): State<AppState>) -> Response {
    let config = &state.config;
    serve_static_file(
        &config.static_dir.join("uPlot.min.css"),
        "text/css; charset=utf-8",
        "public, max-age=31536000, stale-while-revalidate=86400",
    )
    .await
}

async fn handle_config(State(state): State<AppState>) -> Response {
    let config = &state.config;
    let body = serde_json::to_string(&AppConfig {
        stations: config.stations.clone(),
        title: config.title.clone(),
        speed_bucket_count: config.speed_bucket_count,
        speed_bucket_size: config.speed_bucket_size,
        petals_per_90deg: config.petals_per_90deg,
        speed_unit: config.speed_unit.clone(),
        temperature_unit: config.temperature_unit.clone(),
        humidity_unit: config.humidity_unit.clone(),
        ideal_directions: config.station_ideal_dirs.clone(),
        site_elevation_ft: config.site_elevation_ft,
        has_forecast: false,
        build_hash: config.build_hash.clone(),
    })
    .unwrap_or_else(|_| "{}".into());

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    (StatusCode::OK, headers, body).into_response()
}

/// Timeseries endpoint: fetches raw timestamped (speed, direction) points
/// for all configured stations in parallel, with server-side downsampling.
///
/// `GET /api/timeseries?range=15m`
async fn handle_timeseries(
    State(state): State<AppState>,
    Query(params): Query<WindQuery>,
) -> Response {
    let config = &state.config;
    let range = params.range.unwrap_or_else(|| "15m".into());
    let range = if VALID_RANGES.contains(&range.as_str()) {
        range
    } else {
        "15m".into()
    };

    // Fire all station queries concurrently
    let futures: Vec<_> = config
        .stations
        .iter()
        .map(|st| {
            let cfg = config.clone();
            let station = st.clone();
            let range = range.clone();
            tokio::spawn(async move { query_timeseries(&cfg, &station, &range).await })
        })
        .collect();

    let mut stations_map: HashMap<String, StationTimeseries> = HashMap::new();
    let mut errors: Vec<String> = Vec::new();

    for (i, handle) in futures.into_iter().enumerate() {
        match handle.await {
            Ok(Ok(points)) => {
                // Downsample if needed: target ~500 points per station
                let points = downsample(points, 500);
                stations_map.insert(config.stations[i].clone(), StationTimeseries { points });
            }
            Ok(Err(e)) => {
                error!("Timeseries query error for {}: {}", config.stations[i], e);
                errors.push(format!("{}: {}", config.stations[i], e));
            }
            Err(e) => {
                error!(
                    "Timeseries task join error for {}: {}",
                    config.stations[i], e
                );
                errors.push(format!("{}: task failed", config.stations[i]));
            }
        }
    }

    if stations_map.is_empty() && !errors.is_empty() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            [(header::CONTENT_TYPE, "application/json")],
            serde_json::json!({"error": errors.join("; ")}).to_string(),
        )
            .into_response();
    }

    let body = serde_json::to_string(&TimeseriesBatchResponse {
        stations: stations_map,
    })
    .unwrap_or_else(|_| "{}".into());

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    (StatusCode::OK, headers, body).into_response()
}

/// Batch endpoint: fetches all configured stations in parallel, returns
/// pre-computed windrose data for each.  One request per refresh cycle.
///
/// `GET /api/wind?range=15m`
async fn handle_wind(State(state): State<AppState>, Query(params): Query<WindQuery>) -> Response {
    let config = &state.config;
    let range = params.range.unwrap_or_else(|| "15m".into());
    let range = if VALID_RANGES.contains(&range.as_str()) {
        range
    } else {
        "15m".into()
    };

    // Fire all station queries concurrently
    let futures: Vec<_> = config
        .stations
        .iter()
        .map(|st| {
            let cfg = config.clone();
            let station = st.clone();
            let range = range.clone();
            tokio::spawn(async move { fetch_and_compute(&cfg, &station, &range).await })
        })
        .collect();

    let mut stations_map: HashMap<String, WindroseData> = HashMap::new();
    let mut errors: Vec<String> = Vec::new();

    for (i, handle) in futures.into_iter().enumerate() {
        match handle.await {
            Ok(Ok(data)) => {
                stations_map.insert(config.stations[i].clone(), data);
            }
            Ok(Err(e)) => {
                error!("Query error for {}: {}", config.stations[i], e);
                errors.push(format!("{}: {}", config.stations[i], e));
            }
            Err(e) => {
                error!("Task join error for {}: {}", config.stations[i], e);
                errors.push(format!("{}: task failed", config.stations[i]));
            }
        }
    }

    if stations_map.is_empty() && !errors.is_empty() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            [(header::CONTENT_TYPE, "application/json")],
            serde_json::json!({"error": errors.join("; ")}).to_string(),
        )
            .into_response();
    }

    let body = serde_json::to_string(&BatchResponse {
        stations: stations_map,
    })
    .unwrap_or_else(|_| "{}".into());

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    // Don't let intermediary proxies cache stale data, but the SW handles
    // offline fallback on the client side.
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    (StatusCode::OK, headers, body).into_response()
}

// ── WebSocket handler ────────────────────────────────────────────────────────

/// Time ranges accepted by the API and the WS range selector.
const VALID_RANGES: &[&str] = &["5m", "15m", "30m", "1h", "2h", "4h", "8h"];

/// Parse a client WS control message like `{"range":"1h"}`, returning the range
/// only if it is one of [`VALID_RANGES`].
fn parse_range_message(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let r = v.get("range")?.as_str()?;
    if VALID_RANGES.contains(&r) {
        Some(r.to_string())
    } else {
        None
    }
}

async fn handle_ws(State(state): State<AppState>, ws_upgrade: ws::WebSocketUpgrade) -> Response {
    ws_upgrade.on_upgrade(move |socket| ws_connection(socket, state))
}

async fn ws_connection(mut socket: ws::WebSocket, state: AppState) {
    let config = state.config;
    // Each connection tracks its own range; the client sends {"range":"1h"} to
    // change it. The interval's first tick fires immediately, so the client gets
    // a catch-up snapshot on connect, then a fresh one every 15s.
    let mut range = "15m".to_string();
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));

    loop {
        tokio::select! {
            _ = interval.tick() => {
                if let Some(json) = compute_snapshot(&config, &range).await {
                    if socket.send(ws::Message::Text(json.into())).await.is_err() {
                        break; // client disconnected
                    }
                }
            }
            // Handle incoming messages from the client (range changes).
            msg = socket.recv() => {
                match msg {
                    Some(Ok(ws::Message::Text(text))) => {
                        if let Some(new_range) = parse_range_message(&text.to_string()) {
                            if new_range != range {
                                range = new_range;
                                interval.reset();
                                // Push fresh data at the new range right away.
                                if let Some(json) = compute_snapshot(&config, &range).await {
                                    if socket.send(ws::Message::Text(json.into())).await.is_err() {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    Some(Ok(ws::Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
}

// ── Snapshot computation ─────────────────────────────────────────

/// Fetch windrose + timeseries for all stations at `range` and serialize a
/// [`WsSnapshot`] to JSON. Returns `None` if no station returned any data.
async fn compute_snapshot(config: &Config, range: &str) -> Option<String> {
    let wind_futures: Vec<_> = config
        .stations
        .iter()
        .map(|st| {
            let cfg = config.clone();
            let station = st.clone();
            let range = range.to_string();
            tokio::spawn(async move { fetch_and_compute(&cfg, &station, &range).await })
        })
        .collect();

    let ts_futures: Vec<_> = config
        .stations
        .iter()
        .map(|st| {
            let cfg = config.clone();
            let station = st.clone();
            let range = range.to_string();
            tokio::spawn(async move { query_timeseries(&cfg, &station, &range).await })
        })
        .collect();

    let mut stations_map: HashMap<String, WindroseData> = HashMap::new();
    let mut ts_map: HashMap<String, Vec<TimeseriesPoint>> = HashMap::new();

    for (i, handle) in wind_futures.into_iter().enumerate() {
        match handle.await {
            Ok(Ok(data)) => {
                stations_map.insert(config.stations[i].clone(), data);
            }
            Ok(Err(e)) => debug!("WS snapshot: query error for {}: {}", config.stations[i], e),
            Err(e) => debug!("WS snapshot: task error for {}: {}", config.stations[i], e),
        }
    }

    for (i, handle) in ts_futures.into_iter().enumerate() {
        match handle.await {
            Ok(Ok(points)) => {
                ts_map.insert(config.stations[i].clone(), points);
            }
            Ok(Err(e)) => debug!("WS snapshot: ts error for {}: {}", config.stations[i], e),
            Err(e) => debug!(
                "WS snapshot: ts task error for {}: {}",
                config.stations[i], e
            ),
        }
    }

    if stations_map.is_empty() {
        return None;
    }

    let snapshot = WsSnapshot {
        msg_type: "snapshot".to_string(),
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
        range: range.to_string(),
        stations: stations_map,
        timeseries: ts_map,
    };

    serde_json::to_string(&snapshot).ok()
}

// ── Main ────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "windrose_rs=info".into()),
        )
        .init();

    let mut config = Config::from_env();

    config.build_hash = compute_build_hash(&config.static_dir);

    info!(
        "Starting windrose-rs [{}] on port {}",
        config.build_hash, config.port
    );
    info!("Static dir: {:?}", config.static_dir);
    info!("InfluxDB: {}", config.influxdb_url);
    info!("Stations: {:?}", config.stations);
    info!(
        "Windrose: {} petals, {} speed buckets x {} {}",
        config.petals_per_90deg * 4,
        config.speed_bucket_count,
        config.speed_bucket_size,
        config.speed_unit,
    );
    if config.humidity_field.is_some() {
        info!("Humidity field: {:?}", config.humidity_field);
    }
    if config.temperature_field.is_some() {
        info!("Temperature field: {:?}", config.temperature_field);
    }
    if !config.station_ideal_dirs.is_empty() {
        info!("Ideal directions: {:?}", config.station_ideal_dirs);
    }

    let state = AppState {
        config: config.clone(),
    };

    let app = Router::new()
        .route("/", get(handle_index))
        .route("/ws", get(handle_ws))
        .route("/sw.js", get(handle_sw))
        .route("/uPlot.min.js", get(handle_uplot_js))
        .route("/uPlot.min.css", get(handle_uplot_css))
        .route("/api/config", get(handle_config))
        .route("/api/wind", get(handle_wind))
        .route("/api/timeseries", get(handle_timeseries))
        .fallback_service(
            tower_http::services::ServeDir::new(&state.config.static_dir)
                .append_index_html_on_directories(false),
        )
        .layer(tower_http::compression::CompressionLayer::new())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    info!("Listening on {}", addr);
    axum::serve(listener, app).await.unwrap();
}
