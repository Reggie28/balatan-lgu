/*
 * Decision-support analytics for the Balatan LGU system.
 *
 * Implements the three data-driven features called for in the proposal:
 *
 *   - Community Impact Index          -> impactScore() / enrichReports()
 *   - LGU Transparency Dashboard KPIs -> transparencyStats()
 *   - Predictive Maintenance Insights + heatmap -> predictions(), heatmapPoints()
 *
 * All logic is deterministic and based only on the reports stored locally.
 */
const { FACILITY_WEIGHT, CII } = require("../config/config");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const DAY_MS = 86400000;

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function round(x, digits = 0) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Distance between two lat/lng points in metres. */
function haversineM(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v === null || v === undefined)) {
    return Infinity;
  }
  const r = 6371000.0;
  const rad = (x) => (x * Math.PI) / 180;
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const dphi = rad(lat2 - lat1);
  const dlmb = rad(lon2 - lon1);
  const a = Math.sin(dphi / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dlmb / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

/** ~110m grid cell key (at precision 3) for grouping reports by location. */
function cellOf(lat, lng, precision) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    return null;
  }
  return `${lat.toFixed(precision)},${lng.toFixed(precision)}`;
}

// ---------------------------------------------------------------------------
// Community Impact Index — exact formula from the approved manuscript's
// Project Dictionary (Ch.1 §1.6):
//
//   CII = (Frequency x 1.5) + (Affected Count x 2.0) + (Recurrence Score x 1.0)
//
// The score is intentionally NOT normalized to 0-100 — the manuscript defines
// a raw weighted sum, not a percentage. Label bands (Critical/High/Moderate/
// Low) are a presentation-layer convenience configured in config.CII and are
// not part of the manuscript formula itself.
// ---------------------------------------------------------------------------

/**
 * Frequency: number of similar reports (same category) in the same location
 * (within CII.FREQUENCY_RADIUS_M) submitted within the last
 * CII.FREQUENCY_WINDOW_DAYS (30 days per the manuscript). The report being
 * scored is itself one of the "similar reports" at its own location, so it
 * counts toward its own frequency when it falls inside the window.
 */
function frequency(report, allReports) {
  const cutoff = Date.now() - CII.FREQUENCY_WINDOW_DAYS * DAY_MS;
  let count = 0;
  for (const other of allReports) {
    const created = toDate(other.created_at);
    if (!created || created.getTime() < cutoff) continue;
    if (other.category !== report.category) continue;
    const d = haversineM(report.latitude, report.longitude,
                         other.latitude, other.longitude);
    if (d <= CII.FREQUENCY_RADIUS_M) count += 1;
  }
  return count;
}

/**
 * Recurrence Score: number of times the same "asset" has been reported in
 * the past CII.RECURRENCE_WINDOW_DAYS (6 months per the manuscript). The
 * system has no distinct "asset" entity in its schema, so — same asset
 * proxy as the Predictive Maintenance clustering — a ~110m geo-cell plus
 * facility_type stands in for "the same physical facility", regardless of
 * what category of issue is reported against it each time. This is a
 * deliberately different grouping from Frequency (same category, short
 * window) so the two terms carry distinct signal.
 */
function recurrenceScore(report, allReports) {
  const cell = cellOf(report.latitude, report.longitude, CII.RECURRENCE_GRID_PRECISION);
  if (!cell) return 0;
  const cutoff = Date.now() - CII.RECURRENCE_WINDOW_DAYS * DAY_MS;
  let count = 0;
  for (const other of allReports) {
    const created = toDate(other.created_at);
    if (!created || created.getTime() < cutoff) continue;
    if (other.facility_type !== report.facility_type) continue;
    if (cellOf(other.latitude, other.longitude, CII.RECURRENCE_GRID_PRECISION) !== cell) continue;
    count += 1;
  }
  return count;
}

/**
 * Community Impact Index. allReports should be the full report set (not a
 * filtered subset) so Frequency/Recurrence Score reflect the whole dataset
 * regardless of what filter an admin has applied in the UI.
 */
function impactScore(report, allReports) {
  const freq = frequency(report, allReports);
  const affectedCount = report.affected_count || 0;
  const recurrence = recurrenceScore(report, allReports);

  const score = round(
    freq * CII.FREQUENCY_WEIGHT +
    affectedCount * CII.AFFECTED_COUNT_WEIGHT +
    recurrence * CII.RECURRENCE_WEIGHT,
    1
  );

  const t = CII.LABEL_THRESHOLDS;
  let label;
  if (score >= t.critical) label = "Critical";
  else if (score >= t.high) label = "High";
  else if (score >= t.moderate) label = "Moderate";
  else label = "Low";

  return { score, label, frequency: freq, affected_count: affectedCount,
    recurrence_score: recurrence };
}

/** Attach the computed impact index to every report. */
function enrichReports(reports) {
  for (const r of reports) r.impact = impactScore(r, reports);
  return reports;
}

// ---------------------------------------------------------------------------
// LGU Transparency Dashboard
// ---------------------------------------------------------------------------
function hoursBetween(a, b) {
  const da = toDate(a);
  const dbb = toDate(b);
  if (!da || !dbb) return null;
  return (dbb.getTime() - da.getTime()) / 3600000;
}

function transparencyStats(reports) {
  const total = reports.length;
  const byStatus = {};
  const byUrgency = {};
  const byCategory = {};
  const byFacility = {};
  const bump = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };

  const responseHours = [];
  const resolutionHours = [];
  let resolved = 0;

  for (const r of reports) {
    bump(byStatus, r.status);
    bump(byUrgency, r.urgency);
    bump(byCategory, r.category);
    bump(byFacility, r.facility_type);

    const rt = hoursBetween(r.created_at, r.acknowledged_at);
    if (rt !== null && rt >= 0) responseHours.push(rt);
    if (r.status === "resolved") {
      resolved += 1;
      const st = hoursBetween(r.created_at, r.resolved_at);
      if (st !== null && st >= 0) resolutionHours.push(st);
    }
  }

  const avg = (xs) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 1) : 0.0);

  // Reports per week for the last 12 weeks (trend line).
  const weeks = 12;
  const now = Date.now();
  const buckets = new Array(weeks).fill(0);
  const labels = [];
  for (let i = 0; i < weeks; i++) {
    const start = new Date(now - (weeks - i) * 7 * DAY_MS);
    labels.push(start.toLocaleDateString("en-US", {
      month: "short", day: "2-digit", timeZone: "UTC",
    }));
  }
  for (const r of reports) {
    const created = toDate(r.created_at);
    if (!created) continue;
    const deltaWeeks = Math.floor((now - created.getTime()) / DAY_MS / 7);
    if (deltaWeeks >= 0 && deltaWeeks < weeks) {
      buckets[weeks - 1 - deltaWeeks] += 1;
    }
  }

  return {
    total,
    open: total - (byStatus.resolved || 0) - (byStatus.fake || 0) - (byStatus.not_in_scope || 0),
    resolved,
    resolution_rate: total ? round((100.0 * resolved) / total, 1) : 0.0,
    avg_response_hours: avg(responseHours),
    avg_resolution_hours: avg(resolutionHours),
    by_status: byStatus,
    by_urgency: byUrgency,
    by_category: byCategory,
    by_facility: byFacility,
    trend: { labels, counts: buckets },
  };
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------
/** [[lat, lng, intensity], ...] weighted by impact for Leaflet.heat. */
function heatmapPoints(reports) {
  enrichReports(reports);
  const pts = [];
  for (const r of reports) {
    if (r.latitude === null || r.latitude === undefined ||
        r.longitude === null || r.longitude === undefined) continue;
    if (r.status === "resolved" || r.status === "fake") continue;
    // CII is an unbounded raw score, not a 0-100 percentage — normalize
    // against the "Critical" label threshold for a 0..1 heat intensity.
    // This is a rendering choice only; it does not change the CII score.
    const intensity = Math.min(1, Math.max(0.15, r.impact.score / CII.LABEL_THRESHOLDS.critical));
    pts.push([r.latitude, r.longitude, round(intensity, 3)]);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Predictive Maintenance Insights (trend-based/statistical, not ML — see
// web/js/admin.js for the "Typical Recurrence Interval" display wording).
// ---------------------------------------------------------------------------
const GRID_PRECISION = 3; // ~110m cells
const PREDICT_MIN_REPORTS = 2;

/**
 * Detect recurring problem areas and estimate when the next issue is likely.
 * Groups reports by geo-cell + facility type, then scores each cluster by
 * volume, recency trend and facility importance.
 */
function predictions(reports) {
  const groups = new Map();
  for (const r of reports) {
    const cell = cellOf(r.latitude, r.longitude, GRID_PRECISION);
    if (!cell) continue;
    const key = `${cell}|${r.facility_type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const now = Date.now();
  const results = [];
  for (const [key, items] of groups) {
    if (items.length < PREDICT_MIN_REPORTS) continue;
    const facility = key.split("|")[1];
    const dates = items
      .map((x) => toDate(x.created_at))
      .filter(Boolean)
      .sort((a, b) => a - b);
    if (dates.length < PREDICT_MIN_REPORTS) continue;

    const daysAgo = (d) => Math.floor((now - d.getTime()) / DAY_MS);
    const recent = dates.filter((d) => daysAgo(d) <= 30).length;
    const prev = dates.filter((d) => daysAgo(d) > 30 && daysAgo(d) <= 60).length;
    const trend = recent - prev;
    const trendLabel = trend > 0 ? "rising" : trend < 0 ? "declining" : "steady";

    // Mean interval between successive reports -> predicted next occurrence.
    const intervals = [];
    for (let i = 1; i < dates.length; i++) {
      intervals.push(Math.floor((dates[i] - dates[i - 1]) / DAY_MS));
    }
    let meanInterval = intervals.length
      ? intervals.reduce((a, b) => a + b, 0) / intervals.length
      : 30;
    meanInterval = Math.max(meanInterval, 1);
    const predictedNext = new Date(dates[dates.length - 1].getTime() + meanInterval * DAY_MS);

    const weight = FACILITY_WEIGHT[facility] ?? 0.5;
    const risk = items.length * weight * (1 + Math.max(trend, 0) * 0.5);

    const lat = items.reduce((s, x) => s + x.latitude, 0) / items.length;
    const lng = items.reduce((s, x) => s + x.longitude, 0) / items.length;
    const cats = {};
    for (const x of items) cats[x.category] = (cats[x.category] || 0) + 1;
    const topCategory = Object.keys(cats).reduce((a, b) => (cats[b] > cats[a] ? b : a));

    results.push({
      latitude: round(lat, 6),
      longitude: round(lng, 6),
      facility_type: facility,
      top_category: topCategory,
      report_count: items.length,
      reports_30d: recent,
      reports_prev_30d: prev,
      trend: trendLabel,
      risk_score: round(risk, 2),
      last_report: dates[dates.length - 1].toISOString().slice(0, 10),
      predicted_next: predictedNext.toISOString().slice(0, 10),
      mean_interval_days: round(meanInterval, 1),
      example_address: items[0].address || items[0].barangay || "",
    });
  }

  results.sort((a, b) => b.risk_score - a.risk_score);
  return results;
}

module.exports = { haversineM, frequency, recurrenceScore, impactScore,
  enrichReports, transparencyStats, heatmapPoints, predictions };
