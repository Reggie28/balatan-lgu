# Balatan LGU — Municipal Facility Reporting, Maintenance Tracking, and Community Participation System

**Team Dorsett** · Capstone Pre-Proposal implementation
Reggie T. Cabarogias · Ciara T. Goleta · Mia Rose E. Lanuzo

A **Progressive Web Application (PWA)** that lets residents of the Municipality of
Balatan report public facility and infrastructure issues (with photos + GPS), and
gives LGU administrators a decision-support dashboard for tracking, prioritizing,
and planning maintenance.

Built on the stack specified in the approved manuscript: **Node.js**, **Express.js**,
**MySQL**, **REST APIs**, and an **MVC architecture**.

This implementation delivers every module in the pre-proposal, plus the
data-driven and MEO-revision features that set it apart from a plain
reporting form:

| Proposal feature | Where it lives |
|---|---|
| Issue reporting (description, 1-5 photos, auto GPS) | Resident portal `/` |
| Staff reporting (MEO/LGU staff reporting on behalf of an office) | Report form's "Reporting as" toggle |
| Valid-ID verification at registration | `/login` sign-up, admin-reviewed under **Residents** |
| CAPTCHA (Cloudflare Turnstile) on report submission | Report form; server-side fail-closed verification |
| Real-time issue tracking (8-status workflow + history) | Public tracking tab & admin dashboard |
| Offense / suspension policy for fake reports | `userModel.recordOffense()` / **Residents** dashboard tab |
| **Community Impact Index** (frequency, affected count, recurrence) | `src/services/analyticsService.js` → `impactScore()` |
| **Predictive Maintenance Insights** (recurring clusters, next-issue estimate) — rule-based/statistical, not AI/ML | `src/services/analyticsService.js` → `predictions()` |
| Advanced **heatmap** visualization | Admin → *Map & Heatmap* |
| **LGU Transparency Dashboard** (response time, resolution rate, trends) | Admin → *Overview* |
| Admin management (status/urgency/priority, MEO team assignment, CSV export) | Admin → *Manage Reports* |
| Cross-platform PWA (installable, offline shell) | `web/manifest.webmanifest`, `web/sw.js` |

---

## Requirements

**None on Windows** — the package bundles portable Node.js and MySQL runtimes in
the `runtime/` folder, so nothing is installed system-wide. Internet is needed
once during setup (to download the npm dependencies) and for map tiles while
using the app.

On macOS/Linux the bundled runtimes do not apply (they are Windows binaries);
install Node.js ≥ 18 and a MySQL server, then use the `.sh` scripts.

## Quick start

### Windows
```
run.bat        (that's it — double-click and everything happens automatically)
```

On first run it installs the app components (if not already bundled),
initializes the MySQL data directory, loads demo data, starts MySQL + the web
server, and opens the app in the default browser. Later runs skip straight to
starting the app. `setup.bat` still exists to do the preparation ahead of time
(e.g. before going somewhere without internet), but it is optional.

### macOS / Linux
```
chmod +x setup.sh run.sh
./setup.sh
./run.sh
```

Then open:
- **Landing page:** http://127.0.0.1:5000/
- **Resident portal:** http://127.0.0.1:5000/portal
- **Resident sign-in:** http://127.0.0.1:5000/login (demo: `resident@balatan.demo` / `resident2026`)
- **LGU dashboard (hidden URL):** http://127.0.0.1:5000/lgu-admin-2417 — `admin` / `balatan2026`
  (the path is configurable via `BALATAN_ADMIN_PATH`; `/admin` intentionally returns 404)

> The setup script also loads realistic demo data so the dashboard, heatmap and
> predictions have something to show immediately.

---

## Project structure (MVC)

```
balatan-lgu/
├─ launcher.js            # boots the bundled MySQL, then the server
├─ server.js              # Express app: REST API + serves the PWA
├─ package.json
├─ setup.bat / setup.sh   # one-time setup
├─ run.bat / run.sh       # start the app
├─ src/
│  ├─ config/config.js    # settings, facility types & weights, categories, statuses
│  ├─ models/             # MODEL — MySQL data access
│  │  ├─ db.js            #   connection pool + schema + migrations
│  │  ├─ reportModel.js   #   reports, report_photos & status history queries
│  │  ├─ userModel.js     #   residents, offenses/suspension, valid-ID lookups
│  │  ├─ notificationModel.js
│  │  └─ activityModel.js
│  ├─ controllers/        # CONTROLLER — request handling
│  │  ├─ authController.js    # login/register/OTP, admin ID review, offense history
│  │  ├─ reportController.js  # report CRUD, CAPTCHA/suspension/validation gating
│  │  └─ analyticsController.js
│  ├─ routes/api.js       # REST API route definitions
│  ├─ services/           # business logic
│  │  ├─ analyticsService.js  # Impact Index, KPIs, predictions, heatmap
│  │  ├─ mailService.js       # OTP/notice email (console fallback without SMTP)
│  │  └─ turnstileService.js  # Cloudflare Turnstile server-side verification
│  └─ middleware/
│     ├─ auth.js          # bearer-token guard for admin/resident endpoints
│     └─ upload.js        # photo upload rules (multer) — public report photos
│                          #   and the private valid-ID upload, separately
├─ web/                   # VIEW — frontend PWA (no build step)
│  ├─ index.html + js/app.js      # resident portal (report form, tracking, community)
│  ├─ login.html + js/auth.js     # resident sign-in / registration + OTP
│  ├─ admin.html + js/admin.js    # LGU dashboard
│  ├─ css/styles.css
│  ├─ manifest.webmanifest, sw.js # PWA config + service worker
│  ├─ icons/                      # app icons
│  └─ vendor/                     # Leaflet, leaflet.heat, Chart.js (bundled locally)
├─ tools/seed.js          # demo data generator
├─ runtime/               # portable Node.js + MySQL (Windows, nothing global)
└─ data/                  # created at runtime:
   ├─ mysql/              #   MySQL data directory
   ├─ uploads/YYYY-MM/    #   public report photos (served at /uploads)
   └─ private/ids/        #   resident valid-ID photos — NEVER statically
                           #   served; admin-only via GET /api/users/:id/valid-id
```

## REST API

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/api/login` | — | Admin sign-in, returns bearer token |
| POST | `/api/register` | geofence | Resident sign-up step 1: validates details + a required valid-ID photo (multipart, field `valid_id`), emails a 6-digit OTP |
| POST | `/api/verify-otp` | — | Resident sign-up step 2: confirms the OTP, creates the account |
| POST | `/api/resident/login` | geofence | Resident sign-in (email + password + GPS position) |
| POST | `/api/forgot-password` / `/api/reset-password` | — | Emailed 6-digit reset code flow |
| GET | `/api/me` | any token | Current session (role, name, email) |
| POST | `/api/logout` | any token | Invalidate token |
| GET | `/api/profile` / `PATCH /api/profile` | resident | View/edit the signed-in resident's profile |
| POST | `/api/change-password` | resident | Change password (requires current password) |
| GET | `/api/config` | — | Reference data: categories, facility types, statuses + status graph, barangays, MEO teams, urgency thresholds, public Turnstile site key |
| POST | `/api/reports` | resident | Submit a report (multipart, 1-5 photos under field `photos`, `turnstile_token`, optional `reporter_type`/`staff_office`) — blocked while suspended/blocked; urgency is always server-computed |
| GET | `/api/reports/nearby` | — | Duplicate-report proximity check |
| GET | `/api/reports/mine` | resident | The signed-in resident's own reports |
| GET | `/api/reports` | — | List/filter reports (`status`, `urgency`, `facility_type`, `category`, `q`) |
| GET | `/api/reports/:id` | — | Report detail (incl. `photos[]`) + history |
| GET | `/api/reports/:id/history` | — | Status timeline |
| PATCH | `/api/reports/:id` | admin | Update status/urgency/priority/`assigned_team` (gated to Ongoing/Resolved/Unresolved) — status changes enforce the workflow graph below |
| POST | `/api/reports/:id/progress` | admin | Add a progress note/photo, optionally tag a concerned office |
| POST | `/api/reports/:id/affected` | resident | Toggle "I am affected" |
| GET | `/api/users` | admin | Resident accounts (report count, strikes, offense/suspension status) |
| PATCH | `/api/users/:id` | admin | Block/unblock, adjust strikes, set `id_verification_status` |
| GET | `/api/users/:id/valid-id` | admin | Stream a resident's valid-ID photo (never a path in JSON) |
| GET | `/api/users/:id/offenses` | admin | A resident's offense/suspension history |
| GET | `/api/notifications` / `POST /api/notifications/read` | any token | In-app notifications |
| GET | `/api/activity` | admin | Audit trail |
| GET | `/api/stats` | admin | LGU performance KPIs for the admin dashboard (resolution rate, response time, trends) — not public |
| GET | `/api/heatmap` | admin | Impact-weighted heatmap points |
| GET | `/api/predictions` | admin | Predictive maintenance clusters |
| GET | `/api/export.csv` | admin | Export all reports as CSV |

## Configuration

Settings live in `src/config/config.js` and can be overridden with environment
variables:

A full template with placeholder values and explanatory comments is in
[`.env.example`](.env.example) — this app has no dotenv dependency, so that
file is a reference only; export the variables you need through your shell,
process manager, or platform's environment-variable settings.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | unset | Set to `production` on a real deployment. Among other effects, this hard-disables `BALATAN_TURNSTILE_DEV_BYPASS` regardless of its own value. |
| `BALATAN_HOST` | `127.0.0.1` | Bind address (use `0.0.0.0` behind a reverse proxy/PaaS) |
| `BALATAN_PORT` | `5000` | Web server port |
| `BALATAN_ADMIN_USER` | `admin` | Admin username — **change before production** |
| `BALATAN_ADMIN_PASS` | `balatan2026` | Admin password — **change before production** |
| `BALATAN_ADMIN_PATH` | `lgu-admin-2417` | Hidden administrator login URL path |
| `BALATAN_DB_HOST` | `127.0.0.1` | MySQL host |
| `BALATAN_DB_PORT` | `3307` | MySQL port (3307 avoids clashing with XAMPP's 3306) |
| `BALATAN_DB_USER` | `root` | MySQL user |
| `BALATAN_DB_PASS` | *(empty)* | MySQL password |
| `BALATAN_DB_NAME` | `balatan_lgu` | Database name |
| `BALATAN_DEMO_DATA` | `1` | Set `0` to skip auto-loading demo data when the DB is empty |
| `BALATAN_NO_BROWSER` | unset | Set `1` to not auto-open the browser on start |
| `BALATAN_GEOFENCE` | `1` | Set `0` to disable the resident sign-in geofence (e.g. demos outside Balatan) |
| `BALATAN_GEOFENCE_KM` | `15` | Geofence radius in km around the municipal center |
| `BALATAN_DEMO_MODE` | unset | Same-day presentation bypass for the geofence check. Demo/local use only — **leave unset in production**; nothing in the code currently prevents it from being left on, so this must be managed operationally. |
| `BALATAN_SMTP_HOST` | unset | SMTP server for sending OTP emails (e.g. `smtp.gmail.com`) |
| `BALATAN_SMTP_PORT` | `587` | SMTP port (465 switches to implicit TLS) |
| `BALATAN_SMTP_USER` / `BALATAN_SMTP_PASS` | unset | SMTP credentials (for Gmail use an App Password) |
| `BALATAN_SMTP_FROM` | SMTP user | From address on OTP emails |
| `BALATAN_TURNSTILE_SITE_KEY` | unset | Cloudflare Turnstile public site key (sent to the frontend via `/api/config`) |
| `BALATAN_TURNSTILE_SECRET_KEY` | unset | Cloudflare Turnstile secret key (server-side only, never exposed). Without it, report submission fails closed. |
| `BALATAN_TURNSTILE_DEV_BYPASS` | unset | Skips real CAPTCHA verification. Development/demo only — automatically ignored whenever `NODE_ENV=production`. |
| `BALATAN_STRIKE_LIMIT` | `3` | Legacy generic strike counter; not used by the offense/suspension policy below |
| `BALATAN_OFFENSE_SUSPENSION_DAYS` | `30` | Suspension length for a resident's 1st fake-report offense |
| `BALATAN_OFFICE_CONTACTS` | `{}` | JSON map of office name → contact email for the optional inter-office coordination notice |

## Resident accounts & geofence

Residents register and sign in with **email + password** (hashed with
**bcrypt**, per the manuscript's security design; a dedicated sign-in page
lives at `/login`). Registration requires uploading a **valid-ID photo**
(stored under `data/private/ids/`, never statically served, reachable only by
an authenticated admin via `GET /api/users/:id/valid-id`); admins review it
and set `id_verification_status` (`pending` / `verified` / `rejected`) from
the **Residents** tab. Sign-up is verified with a **6-digit one-time passcode
(OTP)** emailed to the address (nodemailer): the account is only created after
the code is confirmed, proving the resident owns the email. Codes expire after
10 minutes, allow 5 attempts, and resends are rate-limited. **Without SMTP
configured the app runs in demo-delivery mode** — the code is printed in the
server window so the flow works in local demos.

Submitting a report requires a signed-in resident; the report is linked to the
account (`reports.user_id`) and the reporter name/contact are taken from it.
A resident can also submit **as staff** (a `reporter_type`/`staff_office`
toggle on the same account — not a separate login) when reporting on behalf
of an MEO/LGU office. Tracking reports stays public.

At sign-in (and registration) the browser sends the device's GPS position and
the server verifies it lies within `BALATAN_GEOFENCE_KM` of the municipal
center using the Haversine formula — **sign-in is refused outside the
Municipality of Balatan** or when location access is denied.

Demo resident account (created directly by the seeder, bypassing the normal
sign-up/OTP/valid-ID flow — it exists purely so the portal can be tried
immediately): `resident@balatan.demo` / `resident2026`.

> Note: browsers only expose geolocation on secure origins — `http://localhost`
> and `http://127.0.0.1` work, but plain-HTTP access over LAN
> (`http://192.168.x.x`) will not provide a location, so resident sign-in from
> other devices requires HTTPS (or `BALATAN_GEOFENCE=0` for demos).

Facility types (and their impact weights), issue categories, urgency levels and
the default map center are all editable at the top of `src/config/config.js`.

## Community participation & enforcement

- **"I am affected"** — signed-in residents can mark any open issue; every mark
  counts like a corroborating report in the Community Impact Index, so
  community-backed issues rise in priority automatically. The portal's
  **Community** tab lists open issues nearest the resident's location.
- **My account** — personal dashboard: the resident's own reports, profile
  editing, and change-password. Password reset (forgot password) works via a
  6-digit emailed code, like sign-up verification.
- **Notifications** — in-app bells for residents (status changes, strikes,
  nearby issues, "affected" activity on their reports) and admins (new
  reports, "affected" marks, automatic blocks), plus best-effort email
  notices when SMTP is configured.
- **Offense / suspension policy for fake reports** — marking a report *Fake*
  records an offense against its author: the **1st** offense suspends the
  account from submitting new reports for `BALATAN_OFFENSE_SUSPENSION_DAYS`
  (default 30) — sign-in still works during a suspension. The **2nd** offense
  permanently flags and blocks the account (sign-in is refused). Re-validating
  a mistakenly-flagged report reverses that specific offense and its
  consequence. Admins monitor accounts and review offense history in the
  dashboard's **Residents** section.
- **Maintenance extras** — reports can be assigned to a personnel/office
  (`assigned_to`) and, once a report is Ongoing/Resolved/Unresolved, to an
  internal **MEO team** (`assigned_team`, from `config.MEO_TEAMS`); staff can
  attach **progress/completion photos** that appear on the public status
  timeline.
- **UI** — animated landing page at `/` with separate resident/administrator
  portals, skeleton loading placeholders, and a light/dark theme toggle.

## Maintenance workflow

Reports move through an 8-status graph (`config.STATUSES` /
`config.STATUS_TRANSITIONS` — the server enforces every transition, the admin
UI only ever offers the legal next steps):

```
Pending ──────────────┬──────────────────────────► Resolved (immediate-fix shortcut)
   │                  │
   ▼                  │
Validation ───┬────────┼──────► Not in Scope   (terminal — outside MEO's mandate)
   │          │        │
   │          ▼        │
   │        Fake ◄──────┘  (reversible back to Validation; also reverses the
   │          │             offense recorded against the reporter)
   ▼          │
Verified      │
   │          │
   ▼          │
Ongoing ◄──────┴──► Unresolved ──► Ongoing | Resolved
   │
   ▼
Resolved  (terminal)
```

The first move away from Pending records the LGU response time; Resolved
records the resolution time. Open issues = everything not Resolved, Fake, or
Not in Scope (Unresolved still counts as open — it can return to Ongoing or
move to Resolved). Every sign-in, account creation, submission and admin
action is recorded in the `activity_log` audit trail (visible on the admin
Overview).

## How the analytics work

**Community Impact Index (CII)** — the exact formula from the approved
manuscript's Project Dictionary (Ch.1 §1.6), unbounded (not normalized to
0-100):
```
CII = (Frequency × 1.5) + (Affected Count × 2.0) + (Recurrence Score × 1.0)
```
- *Frequency* — similar reports within 150 m in the last 30 days
- *Affected Count* — residents who pressed "I am affected" on the report
- *Recurrence Score* — recurrence within the same ~110 m grid cell + facility
  type over the last 180 days

The label thresholds (Critical ≥20, High ≥10, Moderate ≥4, else Low) are a
presentation-layer choice on top of the formula, not part of the manuscript
formula itself — see `config.CII.LABEL_THRESHOLDS`.

**Predictive Maintenance** groups reports into ~110 m geo-cells by facility type,
compares the last 30 days vs the previous 30 (trend), and estimates the next likely
occurrence from the average interval between past reports. Clusters are ranked by a
risk score (volume × facility weight × rising trend). This is a **rule-based /
statistical** calculation (plain arithmetic over stored reports) — the system
does not use any machine-learning library or model.

## CAPTCHA (Cloudflare Turnstile)

Report submission is protected by [Cloudflare
Turnstile](https://developers.cloudflare.com/turnstile/): the resident portal
renders the widget when `BALATAN_TURNSTILE_SITE_KEY` is configured (fetched
publicly via `/api/config`), collects a `turnstile_token`, and the backend
verifies it server-side against Cloudflare before creating the report
(`src/services/turnstileService.js`).

- **No secret key configured** → submission **fails closed** (rejected) —
  this is deliberate, not a bug.
- `BALATAN_TURNSTILE_DEV_BYPASS=1` skips verification for local testing only.
  It is automatically ignored whenever `NODE_ENV=production`, but should
  still be left unset/`0` in any real deployment as defense in depth.
- The secret key is never sent to the frontend or returned by any API
  response — only the public site key is exposed via `/api/config`.

## Data, resetting & backup

- Reports live in the bundled MySQL server (database `balatan_lgu`, stored under
  `data/mysql/`). Public report photos go to `data/uploads/YYYY-MM/`.
  Resident **valid-ID photos** go to `data/private/ids/` — this directory is
  never statically served and contains personal documents (RA 10173 /
  Data Privacy Act scope); handle any copy of it with the same care as the
  database itself.
- To reseed demo data: `runtime\node\node.exe launcher.js --seed --reset`
  (or `npm run seed:reset` if Node is on your PATH). **This destroys existing
  data** — never run it against a real deployment's database.
- The bundled MySQL listens only on `127.0.0.1:3307` with the root user and no
  password — it is never reachable from the network.
- **Backup**: this project does not currently include backup tooling. Before
  any production deployment, back up (a) the MySQL database (e.g.
  `mysqldump`), (b) `data/uploads/`, and (c) `data/private/ids/` — on
  whatever schedule and to whatever secure storage your deployment
  environment requires. Restoring is the reverse: restore the database dump,
  then restore both upload directories before starting the app.

## Editing the app

- **Business logic / scoring:** `src/services/analyticsService.js`, `src/config/config.js`
- **API routes:** `src/routes/api.js` + `src/controllers/`
- **Database queries:** `src/models/reportModel.js`
- **Resident UI:** `web/index.html` + `web/js/app.js`
- **Admin UI:** `web/admin.html` + `web/js/admin.js`
- **Styling:** `web/css/styles.css`

No build step is required — edit a file and refresh the browser. (If the service
worker serves a stale asset during development, hard-refresh with `Ctrl+Shift+R`.)

## Production deployment

This section is for an actual internet-facing deployment (not local demos).

**1. Prerequisites**
- A Linux/Windows/macOS host able to run Node.js and reach a MySQL server.
- A MySQL 8.x database (the bundled portable MySQL in `runtime/` is
  Windows-only and intended for local/demo single-box use).
- (Recommended) A reverse proxy or PaaS in front of the app for TLS.

**2. Node.js version**
`package.json` declares `"engines": { "node": "20.x" }`. Install dependencies
with `npm install`.

**3. MySQL**
Provision a database and a dedicated app user (not `root`), then point
`BALATAN_DB_HOST` / `BALATAN_DB_PORT` / `BALATAN_DB_USER` / `BALATAN_DB_PASS`
/ `BALATAN_DB_NAME` at it. Schema and migrations run automatically and
idempotently at startup (`src/models/db.js`) — no manual SQL is required, and
existing data is never dropped or reset by a normal start.

**4. Environment variables**
See the [Configuration](#configuration) table above and
[`.env.example`](.env.example). At minimum for production: `NODE_ENV=production`,
a non-default `BALATAN_ADMIN_USER`/`BALATAN_ADMIN_PASS`, real
`BALATAN_DB_*`, and either real Turnstile keys or an accepted fail-closed
report-submission state until they're supplied.

**5. Turnstile setup**
Create a Cloudflare Turnstile site, then set `BALATAN_TURNSTILE_SITE_KEY` and
`BALATAN_TURNSTILE_SECRET_KEY`. Leave `BALATAN_TURNSTILE_DEV_BYPASS` unset.

**6. SMTP setup**
Set `BALATAN_SMTP_HOST`/`PORT`/`USER`/`PASS`/`FROM` for real OTP/notice
email delivery. Without SMTP, codes print to the server console — acceptable
for local demos only.

**7. Production startup**
```
node launcher.js     # bundled-MySQL path (Windows only)
node server.js        # when MySQL is already running/managed separately
```
Use a process manager (systemd, pm2, your PaaS's process model, etc.) to keep
the app running and restart it on failure — none is bundled with the project.

**8. Reverse proxy / TLS**
The app intentionally does not terminate HTTPS itself — it expects a reverse
proxy or PaaS in front of it:
```
Internet → HTTPS/TLS → Reverse proxy / PaaS → Node.js app (BALATAN_HOST/PORT) → MySQL
```
Set `BALATAN_HOST=0.0.0.0` so the proxy can reach the app on its own network.

**9. Required directories**
`data/uploads/`, `data/private/ids/`, and (if using bundled MySQL)
`data/mysql/` are all created automatically on startup — no manual setup
needed.

**10. Production smoke test**
After deploying: admin login → `/api/me` → submit one test report (clearly
labeled) → confirm it appears in `/api/reports` and the admin dashboard →
confirm `GET /api/users/:id/valid-id` requires admin auth → confirm
`/data/private/ids/...` is not reachable directly → check server logs for the
Turnstile/demo-mode startup diagnostics.

**11. Backup**
See [Data, resetting & backup](#data-resetting--backup) above.

**12. Troubleshooting basics**
- *App won't start / "MySQL did not become ready"* — confirm `BALATAN_DB_*`
  point at a reachable MySQL, or that the bundled MySQL's port isn't already
  in use.
- *Report submission always fails with a CAPTCHA error* — no Turnstile secret
  key is configured; this is fail-closed by design, not a bug. Configure real
  keys or explicitly enable the dev bypass for local testing only.
- *OTP codes never arrive by email* — SMTP isn't configured; codes are
  printed to the server console instead (check there first).
- *A 500 response just says "Server error"* — this is intentional (Phase 6
  hardening): the real error and stack trace are logged server-side only,
  never sent to the client. Check the server console/logs for the detail.
- *Admin dashboard shows nothing after logging in* — confirm the token in
  `localStorage` is being verified against `/api/me`, and that the browser
  can reach `/api/config`.

## Notes & limitations (per the proposal)

- Requires internet for the base map tiles and, when configured, the
  Turnstile widget/verification; the rest works offline.
- Impact and predictive insights improve as more reports accumulate.
- This is a decision-support and monitoring tool — it does not replace official
  inspections or engineering assessments.

## Tech stack

**Node.js · Express.js · MySQL (mysql2) · multer · REST API · MVC** ·
Leaflet + leaflet.heat · Chart.js · vanilla-JS PWA.
Portable runtimes are bundled so the whole system runs from one folder in the
resource-constrained environments described in the proposal.
