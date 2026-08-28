/*
 * Populate the database with realistic demo reports around Balatan so the
 * dashboard, heatmap, impact index and predictions have data to display.
 *
 *   node launcher.js --seed            # add demo data (skips if already seeded)
 *   node launcher.js --seed --reset    # wipe DB then reseed
 *
 * (Run through launcher.js so the bundled MySQL is started first.)
 */
const db = require("../src/models/db");
const reportModel = require("../src/models/reportModel");
const userModel = require("../src/models/userModel");

// Demo resident account so the portal can be tried immediately.
const DEMO_RESIDENT = {
  name: "Juan Dela Cruz",
  email: "resident@balatan.demo",
  password: "resident2026",
  barangay: "Poblacion I",
};

// Demo staff account — pre-granted staff reporting access (see
// userModel.setStaffEligibility()) so the staff-reporting flow can be tried
// immediately too, without an admin having to grant it by hand first.
const DEMO_STAFF = {
  name: "Maria Santos",
  email: "staff@balatan.demo",
  password: "staff2026",
  barangay: "Poblacion (Siramag)",
};

// Deterministic PRNG (mulberry32) so reseeding gives comparable demo data.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const randint = (a, b) => a + Math.floor(rand() * (b - a + 1));
const uniform = (a, b) => a + rand() * (b - a);
const choice = (arr) => arr[Math.floor(rand() * arr.length)];

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

const BARANGAYS = [
  ["Poblacion I", 13.3193, 123.2247],
  ["Cabungan", 13.3350, 123.2100],
  ["Camangahan", 13.3050, 123.2400],
  ["Coguit", 13.3280, 123.2050],
  ["Duran", 13.3100, 123.2300],
  ["San Isidro", 13.3400, 123.2350],
  ["Tapol", 13.2980, 123.2180],
];

const SCENARIOS = [
  ["Large pothole on national road", "Road / Pothole", "road",
    "Deep pothole causing tricycles to swerve into oncoming traffic.", "high", 400],
  ["Flooding near public market", "Flooding / Drainage", "drainage",
    "Clogged drainage floods the market entrance during rain.", "high", 600],
  ["Broken streetlight along highway", "Lighting", "streetlight",
    "Streetlight out for two weeks, area very dark at night.", "medium", 150],
  ["Leaking water pipe", "Water Supply", "water_supply",
    "Main pipe leaking, low pressure for nearby households.", "high", 300],
  ["Damaged health center roof", "Structural Damage", "health_center",
    "Roof leaks over the waiting area during rain.", "critical", 500],
  ["Cracked school walkway", "Structural Damage", "school",
    "Walkway cracked and uneven, risk for students.", "medium", 250],
  ["Uncollected garbage pile", "Sanitation / Waste", "waste",
    "Garbage not collected for several days, foul smell.", "medium", 200],
  ["Power line leaning dangerously", "Power / Electrical", "electricity",
    "Post tilted after storm, wires very low.", "critical", 350],
  ["Broken bridge railing", "Safety Hazard", "bridge",
    "Railing broken, dangerous for pedestrians.", "high", 220],
  ["Vandalized barangay hall wall", "Vandalism", "government_building",
    "Graffiti and broken window at the barangay hall.", "low", 80],
];

const NAMES = ["Juan D.", "Maria S.", "Pedro G.", "Ana L.", "Jose R.",
  "Rosa M.", "Mark T.", "Grace P.", "Niña C.", "Ramon V."];

const STATUS_FLOW = ["pending", "validation", "verified", "ongoing", "resolved"];

const OFFICES = [
  "Municipal Engineering Office",
  "MENRO (Environment & Natural Resources)",
  "General Services Office",
  "Water District",
  "Barangay Maintenance Crew",
];

/** Rewrite timestamps and advance status so KPIs look realistic. */
async function backdate(id, createdDt, urgency) {
  const steps = randint(0, 4); // how far through the workflow
  const status = STATUS_FLOW[steps];
  const ack = steps >= 1
    ? new Date(createdDt.getTime() + uniform(2, 48) * HOUR_MS) : null;
  const resolved = status === "resolved"
    ? new Date(createdDt.getTime() + uniform(1, 20) * DAY_MS) : null;

  const assigned = steps >= 2 ? choice(OFFICES) : "";
  await db.query(
    `UPDATE reports SET created_at=?, updated_at=?, status=?,
       acknowledged_at=?, resolved_at=?, assigned_to=? WHERE id=?`,
    [createdDt, createdDt, status, ack, resolved, assigned, id]
  );

  // Reset the auto-created history row to match the backdated time.
  await db.query("DELETE FROM status_history WHERE report_id=?", [id]);
  let t = createdDt;
  await db.query(
    `INSERT INTO status_history (report_id, status, note, actor, created_at)
     VALUES (?, 'pending', 'Report submitted', 'Resident', ?)`,
    [id, t]
  );
  for (const s of STATUS_FLOW.slice(1, steps + 1)) {
    t = new Date(t.getTime() + uniform(4, 72) * HOUR_MS);
    await db.query(
      `INSERT INTO status_history (report_id, status, note, actor, created_at)
       VALUES (?, ?, ?, 'admin', ?)`,
      [id, s, `Status set to ${s}`, t]
    );
  }
}

async function seed({ reset = false } = {}) {
  if (reset) {
    await db.resetDb();
    console.log("Database reset.");
  } else {
    await db.initDb();
  }
  if ((await userModel.countUsers()) === 0) {
    await userModel.createUser(DEMO_RESIDENT);
    console.log(`Demo resident account: ${DEMO_RESIDENT.email} / ${DEMO_RESIDENT.password}`);
    const staffUser = await userModel.createUser(DEMO_STAFF);
    await userModel.setStaffEligibility(staffUser.id, true);
    console.log(`Demo staff account: ${DEMO_STAFF.email} / ${DEMO_STAFF.password} (staff-enabled)`);
  }

  if ((await reportModel.countReports()) > 0) {
    console.log("Database already has data; skipping seed. Use --reset to wipe.");
    return;
  }

  const now = Date.now();
  let created = 0;
  // Create recurring clusters (drives predictions + impact frequency) plus
  // scattered singles.
  for (const [title, category, facility, desc, urgency, residents] of SCENARIOS) {
    const brgy = choice(BARANGAYS);
    const clusterSize = choice([1, 2, 3, 4]);
    for (let i = 0; i < clusterSize; i++) {
      const daysAgo = randint(0, 85);
      const report = await reportModel.createReport({
        title,
        description: desc,
        category,
        facility_type: facility,
        latitude: Number((brgy[1] + uniform(-0.0008, 0.0008)).toFixed(6)),
        longitude: Number((brgy[2] + uniform(-0.0008, 0.0008)).toFixed(6)),
        address: `${brgy[0]}, Balatan, Camarines Sur`,
        barangay: brgy[0],
        photo_path: "",
        reporter_name: choice(NAMES),
        reporter_contact: "",
        affected_residents: residents + randint(-50, 100),
        urgency,
      });
      // Backdate the created_at + walk it through a random status.
      await backdate(report.id, new Date(now - daysAgo * DAY_MS), urgency);
      created += 1;
    }
  }
  console.log(`Seeded ${created} demo reports across ${BARANGAYS.length} barangays.`);
}

module.exports = { seed };

if (require.main === module) {
  seed({ reset: process.argv.includes("--reset") })
    .then(() => db.closeDb())
    .catch((err) => { console.error(err); process.exit(1); });
}
