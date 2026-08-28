/*
 * Analytics controller — transparency KPIs, heatmap and predictive
 * maintenance, all computed from the reports stored in MySQL.
 */
const config = require("../config/config");
const reportModel = require("../models/reportModel");
const analytics = require("../services/analyticsService");

/** Public reference data used by both frontends. */
async function getConfig(req, res) {
  res.json({
    municipality: config.MUNICIPALITY_NAME,
    center: config.DEFAULT_CENTER,
    zoom: config.DEFAULT_ZOOM,
    facility_types: config.FACILITY_TYPES,
    categories: config.CATEGORIES,
    statuses: config.STATUSES,
    status_transitions: config.STATUS_TRANSITIONS,
    urgency_levels: config.URGENCY_LEVELS,
    offices: config.OFFICES,
    involvement_reasons: config.INVOLVEMENT_REASONS,
    meo_teams: config.MEO_TEAMS,
    barangays: config.BARANGAYS,
    urgency_thresholds: config.URGENCY_THRESHOLDS,
    // Site keys are meant to be public (only the secret key is private).
    // Empty string when Turnstile is not yet configured.
    turnstile_site_key: config.TURNSTILE.siteKey,
  });
}

async function stats(req, res) {
  res.json(analytics.transparencyStats(await reportModel.allReports()));
}

async function heatmap(req, res) {
  res.json(analytics.heatmapPoints(await reportModel.allReports()));
}

async function predictions(req, res) {
  res.json(analytics.predictions(await reportModel.allReports()));
}

module.exports = { getConfig, stats, heatmap, predictions };
