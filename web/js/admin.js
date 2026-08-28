/* LGU administration dashboard: auth, operational overview, report
   management, map + report-type heatmap, and predictive maintenance. */
(function () {
  const { api, toast, esc, timeAgo, fmtDate, statusLabel } = Balatan;
  let cfg, charts = {}, adminMap, markerLayer, heatLayer, currentReports = [];
  let bell = null;

  Balatan.registerSW();
  Balatan.initThemeToggle("theme-toggle");

  // ---------- Auth ----------
  function isAuthed() { return !!localStorage.getItem("balatan_token"); }

  function showDashboard() {
    document.getElementById("login-view").style.display = "none";
    document.getElementById("dash-view").style.display = "";
    document.getElementById("logout-link").style.display = "";
    boot();
    if (!bell) {
      bell = Balatan.initBell({ bellId: "notif-bell", panelId: "notif-panel",
        tokenKey: "balatan_token" });
    } else {
      bell.refresh();
    }
  }
  function showLogin() {
    document.getElementById("login-view").style.display = "";
    document.getElementById("dash-view").style.display = "none";
    document.getElementById("logout-link").style.display = "none";
  }

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const res = await api("/api/login", {
        method: "POST",
        json: { username: document.getElementById("login-user").value,
                password: document.getElementById("login-pass").value },
      });
      localStorage.setItem("balatan_token", res.token);
      showDashboard();
      toast("Welcome, " + res.username, "success");
    } catch (err) { toast(err.message, "error"); }
  });

  document.getElementById("logout-link").addEventListener("click", async (e) => {
    e.preventDefault();
    try { await api("/api/logout", { method: "POST" }); } catch (_) {}
    localStorage.removeItem("balatan_token");
    showLogin();
  });

  // ---------- Navigation ----------
  const PAGE_META = {
    overview: ["Overview", "Municipal Engineering Office reporting at a glance"],
    reports: ["Manage reports", "Review, validate, assign, and update MEO reports"],
    teams: ["Assigned Teams", "What each MEO team is currently responsible for"],
    map: ["Map & heatmap", "Geographic distribution by report type"],
    predict: ["Predictive maintenance", "Recurring issue clusters and historical trend analysis"],
    users: ["Manage Accounts", "Resident account monitoring, ID verification, offense history"],
  };

  function selectTab(tab, filter) {
    document.querySelectorAll(".nav-item").forEach((x) =>
      x.classList.toggle("active", x.dataset.tab === tab));
    document.getElementById("nav-reports-btn").parentElement.classList.toggle("open", tab === "reports");
    document.getElementById("nav-teams-btn").parentElement.classList.toggle("open", tab === "teams");
    ["overview", "reports", "teams", "map", "predict", "users"].forEach((name) => {
      document.getElementById("tab-" + name).style.display = tab === name ? "" : "none";
    });
    Balatan.replayAnim(document.getElementById("tab-" + tab));
    const meta = PAGE_META[tab] || ["", ""];
    document.getElementById("page-title").textContent = meta[0];
    document.getElementById("page-sub").textContent = meta[1];
    if (tab === "map") setTimeout(initMap, 60);
    if (tab === "predict") loadPredictions();
    if (tab === "reports") {
      applyReportFilter(filter || {});
      loadReports();
    }
    if (tab === "teams") loadTeamReports((filter && filter.team) || "");
    if (tab === "overview") loadOverview();
    if (tab === "users") loadUsers();
  }

  /** Jump to Manage Reports pre-filtered — used by clickable overview cards
   * and the "Manage reports" sidebar status sub-menu. Also keeps the
   * sub-menu's own active highlight and the filter panel's dropdown in sync,
   * whichever entry point was used. */
  function applyReportFilter({ status, sort }) {
    document.getElementById("rf-status").value = status || "";
    document.getElementById("rf-sort").value = sort || "priority";
    document.querySelectorAll(".nav-subitem").forEach((el) =>
      el.classList.toggle("active", el.dataset.status === (status || "")));
  }

  document.getElementById("nav-reports-btn").addEventListener("click", () => {
    const group = document.getElementById("nav-reports-btn").parentElement;
    const alreadyOnReports = document.getElementById("tab-reports").style.display !== "none";
    if (alreadyOnReports) {
      // Already viewing Manage reports — just toggle the sub-menu, keep
      // whatever filter is currently applied (don't reset to "All reports").
      group.classList.toggle("open");
    } else {
      selectTab("reports", { status: "" });
    }
  });
  document.querySelectorAll("#reports-submenu .nav-subitem").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      selectTab("reports", { status: el.dataset.status, sort: "priority" });
    }));

  document.getElementById("nav-teams-btn").addEventListener("click", () => {
    const group = document.getElementById("nav-teams-btn").parentElement;
    const alreadyOnTeams = document.getElementById("tab-teams").style.display !== "none";
    if (alreadyOnTeams) {
      group.classList.toggle("open");
    } else {
      selectTab("teams", { team: "" });
    }
  });

  // ---------- Assigned Teams (each MEO team's current workload) ----------
  /** Populated once cfg.meo_teams is known (see boot()) — mirrors the
   * "Manage reports" status sub-menu pattern, one sub-item per MEO team. */
  function populateTeamsSubmenu() {
    const submenu = document.getElementById("teams-submenu");
    submenu.innerHTML = `<button class="nav-subitem active" data-team="">All teams</button>` +
      (cfg.meo_teams || []).map((t) =>
        `<button class="nav-subitem" data-team="${esc(t)}">${esc(t)}</button>`).join("");
    submenu.querySelectorAll(".nav-subitem").forEach((el) =>
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        selectTab("teams", { team: el.dataset.team });
      }));
  }

  function applyTeamFilter(team) {
    document.querySelectorAll("#teams-submenu .nav-subitem").forEach((el) =>
      el.classList.toggle("active", el.dataset.team === (team || "")));
  }

  async function loadTeamReports(team) {
    applyTeamFilter(team);
    const list = document.getElementById("teams-reports");
    Balatan.showSkeleton(list, 3);
    try {
      const all = await api("/api/reports");
      // Assigned Teams is about current workload, not the whole backlog —
      // only reports that actually have a team on them show up here, same
      // as "Assigned Team" itself only being settable once a report is
      // Ongoing/Resolved/Unresolved.
      const assigned = all.filter((r) => r.assigned_team && (!team || r.assigned_team === team));
      list.innerHTML = assigned.length
        ? assigned.map(adminCard).join("")
        : `<div class="empty">${team ? `No reports currently assigned to ${esc(team)}.` : "No reports have an assigned team yet."}</div>`;
      list.querySelectorAll(".report-item").forEach((el) =>
        el.addEventListener("click", () => openManage(el.dataset.id)));
    } catch (err) {
      list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  // ---------- Resident account monitoring (Manage Accounts) ----------
  // Three-attempt fake-report policy: 1st offense = Warning (no account
  // side effect), 2nd = temporary suspension, 3rd+ = Administrative Action
  // (never an automatic permanent block/legal penalty — that call is the
  // LGU/MEO's, this just flags it for their review).
  let lastUsers = [];
  function acctStatusBadge(u) {
    if (u.permanently_flagged) return `<span class="badge status-fake">Permanently flagged (legacy)</span>`;
    if (u.blocked) return `<span class="badge status-fake">Blocked</span>`;
    if (u.admin_action_required) return `<span class="badge status-fake">⚠ Administrative Action Required</span>`;
    if (u.suspended_until && new Date(u.suspended_until) > new Date())
      return `<span class="badge high">Suspended until ${esc(fmtDate(u.suspended_until))}</span>`;
    return `<span class="badge status-resolved">Active</span>`;
  }
  /** "Total fake-report offenses" / "current offense level" — shown next to
   * the account status badge so admin doesn't have to open the Offenses
   * modal just to see where an account stands. */
  function ordinal(n) {
    if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
    return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
  }
  function offenseSummary(u) {
    const n = u.offense_count || 0;
    if (!n) return "";
    const tier = n === 1 ? "Warning" : n === 2 ? "Suspension" : "Administrative Action";
    return `<div class="hint" style="display:block;margin-top:4px;">${n} fake-report offense${n === 1 ? "" : "s"} · current level: ${ordinal(n)} — ${esc(tier)}</div>`;
  }
  function idStatusBadge(s) {
    const map = { pending: ["status-validation", "Pending review"],
      verified: ["status-resolved", "Verified"], rejected: ["status-fake", "Rejected"] };
    const [cls, label] = map[s] || ["status-neutral", s || "—"];
    return `<span class="badge ${cls} plain">${esc(label)}</span>`;
  }
  /** OCR name-check hint (best-effort, never authoritative) shown alongside
   * the manual ID verification status. */
  function idNameMatchHint(m) {
    if (m === 1) return `<span class="hint" style="display:block;">OCR: name matches</span>`;
    if (m === 0) return `<span class="hint" style="display:block;color:var(--c-red,#c0392b);">⚠ OCR: name mismatch</span>`;
    return "";
  }

  async function loadUsers() {
    const box = document.getElementById("users-table");
    Balatan.showSkeleton(box, 3);
    try {
      const users = await api("/api/users");
      lastUsers = users;
      if (!users.length) {
        box.innerHTML = `<div class="empty">No resident accounts yet.</div>`;
        return;
      }
      box.innerHTML = `
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Resident</th><th>Barangay</th><th>Reports</th>
            <th>ID verification</th><th>Staff access</th><th>Account status</th><th></th></tr></thead>
          <tbody>
            ${users.map((u) => `
              <tr>
                <td><strong>${esc(u.name)}</strong><br>
                  <span class="muted-cell">${esc(u.email)}</span></td>
                <td>${esc(u.barangay || "—")}</td>
                <td>${u.report_count}</td>
                <td>${idStatusBadge(u.id_verification_status)}${idNameMatchHint(u.id_name_match)}</td>
                <td>${u.is_staff
                  ? `<span class="badge status-ongoing plain">Staff-enabled</span>`
                  : `<span class="badge status-neutral plain">Resident only</span>`}</td>
                <td>${acctStatusBadge(u)}${offenseSummary(u)}</td>
                <td style="min-width:220px;">
                  <div style="display:flex;flex-wrap:wrap;gap:6px;">
                  <button class="btn small secondary" data-view-id="${u.id}">View ID</button>
                  <button class="btn small secondary" data-offenses="${u.id}">Offenses</button>
                  <button class="btn small secondary" data-staff="${u.id}" data-is-staff="${u.is_staff ? 1 : 0}">
                    ${u.is_staff ? "Revoke staff" : "Grant staff"}</button>
                  <button class="btn small ${u.blocked ? "" : "secondary"}"
                        data-id="${u.id}" data-blocked="${u.blocked}">
                    ${u.blocked ? "Unblock" : "Block"}</button>
                  </div>
                </td>
              </tr>`).join("")}
          </tbody>
        </table></div>`;
      box.querySelectorAll("button[data-id]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          const blocking = btn.dataset.blocked === "0";
          if (blocking && !confirm("Block this resident from signing in and reporting?")) return;
          try {
            await api("/api/users/" + btn.dataset.id, {
              method: "PATCH",
              json: blocking ? { blocked: true } : { blocked: false, strikes: 0 },
            });
            toast(blocking ? "Account blocked" : "Account unblocked", "success");
            loadUsers();
          } catch (err) { toast(err.message, "error"); }
        }));
      box.querySelectorAll("button[data-staff]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          const granting = btn.dataset.isStaff === "0";
          try {
            await api("/api/users/" + btn.dataset.staff, {
              method: "PATCH", json: { is_staff: granting },
            });
            toast(granting ? "Staff access granted" : "Staff access revoked", "success");
            loadUsers();
          } catch (err) { toast(err.message, "error"); }
        }));
      box.querySelectorAll("button[data-view-id]").forEach((btn) =>
        btn.addEventListener("click", () => viewValidId(btn.dataset.viewId)));
      box.querySelectorAll("button[data-offenses]").forEach((btn) =>
        btn.addEventListener("click", () => viewOffenses(btn.dataset.offenses)));
    } catch (err) {
      box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  /** Streams the private valid-ID image via an authenticated fetch (an <img
   * src> can't carry the Authorization header) and shows it in a modal, with
   * verify/reject controls. Never displays or logs the raw filesystem path. */
  async function viewValidId(userId) {
    openModal(`<button class="close-x" onclick="Balatan.__closeAdmin()">×</button>
      <h3>Valid ID</h3><p class="hint">Loading…</p>`);
    try {
      const token = localStorage.getItem("balatan_token");
      const resp = await fetch(`/api/users/${userId}/valid-id`, {
        headers: { Authorization: "Bearer " + token },
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || "No ID on file for this account");
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const user = lastUsers.find((u) => String(u.id) === String(userId));
      const ocrLine = user && user.id_name_match === 0
        ? `<p class="hint" style="color:var(--c-red,#c0392b);">⚠ Automated OCR check did not find this resident's name on the ID — review carefully before verifying.</p>`
        : user && user.id_name_match === 1
        ? `<p class="hint">Automated OCR check found a matching name on the ID (informational only — not a substitute for manual review).</p>`
        : "";
      openModal(`
        <button class="close-x" onclick="Balatan.__closeAdmin()">×</button>
        <h3>Valid ID</h3>
        <p class="hint">Confidential — visible to authorized administrators only.</p>
        ${ocrLine}
        <img src="${url}" alt="Valid ID" style="max-width:100%;border-radius:var(--radius-sm);border:1px solid var(--border);margin:10px 0;">
        <div style="display:flex;gap:10px;">
          <button class="btn" id="id-verify-btn">Mark verified</button>
          <button class="btn secondary" id="id-reject-btn">Reject</button>
        </div>`);
      document.getElementById("id-verify-btn").addEventListener("click", () => setIdStatus(userId, "verified"));
      document.getElementById("id-reject-btn").addEventListener("click", () => setIdStatus(userId, "rejected"));
    } catch (err) {
      openModal(`<button class="close-x" onclick="Balatan.__closeAdmin()">×</button>
        <h3>Valid ID</h3><p class="hint">${esc(err.message)}</p>`);
    }
  }
  async function setIdStatus(userId, status) {
    try {
      await api(`/api/users/${userId}`, { method: "PATCH", json: { id_verification_status: status } });
      toast(`ID marked ${status}`, "success");
      Balatan.__closeAdmin();
      loadUsers();
    } catch (err) { toast(err.message, "error"); }
  }

  async function viewOffenses(userId) {
    openModal(`<button class="close-x" onclick="Balatan.__closeAdmin()">×</button>
      <h3>Offense history</h3><p class="hint">Loading…</p>`);
    try {
      const rows = await api(`/api/users/${userId}/offenses`);
      const user = lastUsers.find((u) => String(u.id) === String(userId));
      const actionBanner = user && user.admin_action_required
        ? `<div class="acct-danger" style="margin:10px 0;padding:10px;border:1px solid currentColor;border-radius:var(--radius-sm,6px);">
             ⚠ <strong>Administrative Action Required</strong> — this account has reached its
             3rd+ fake-report offense. New report submissions are on hold pending LGU/MEO review.
           </div>`
        : "";
      openModal(`
        <button class="close-x" onclick="Balatan.__closeAdmin()">×</button>
        <h3>Offense history</h3>
        <p class="hint">Fake-report offenses recorded against this account. Not visible to
          the public or the resident's own view beyond a general status notice.</p>
        ${actionBanner}
        ${rows.length ? `<ul class="timeline">${rows.map((o) => `
          <li><strong>Offense #${o.offense_number}</strong> — ${esc(o.action_taken)}
            <div class="when">${fmtDate(o.created_at)} · report ${o.report_id ? "#" + o.report_id : "—"} · by ${esc(o.actor || "admin")}</div>
            ${o.reason ? `<div>${esc(o.reason)}</div>` : ""}
            ${o.suspended_until ? `<div class="hint">Suspended until ${esc(fmtDate(o.suspended_until))}</div>` : ""}
          </li>`).join("")}</ul>` : `<div class="empty">No offenses recorded.</div>`}
      `);
    } catch (err) {
      openModal(`<button class="close-x" onclick="Balatan.__closeAdmin()">×</button>
        <h3>Offense history</h3><p class="hint">${esc(err.message)}</p>`);
    }
  }

  // "Manage reports" and "Assigned Teams" each have their own listener
  // above (they also open/close a sub-menu), so both are excluded here to
  // avoid double-firing — without this, this generic handler would re-fire
  // right after theirs and immediately force the sub-menu back open.
  document.querySelectorAll(".nav-item").forEach((t) => {
    if (t.id === "nav-reports-btn" || t.id === "nav-teams-btn") return;
    t.addEventListener("click", () => selectTab(t.dataset.tab));
  });

  // ---------- Boot ----------
  async function boot() {
    cfg = await Balatan.config();
    fillFilter("rf-status", cfg.statuses.map((s) => [s, statusLabel(s)]));
    fillFilter("rf-urgency", cfg.urgency_levels.map((u) => [u, cap(u)]));
    fillFilter("rf-facility", cfg.facility_types.map((f) => [f.key, f.label]));
    renderMapLegend();
    document.querySelectorAll("#heatmap-mode-toggle .seg-btn").forEach((btn) =>
      btn.addEventListener("click", () => {
        document.querySelectorAll("#heatmap-mode-toggle .seg-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        mapColorMode = btn.dataset.mode;
        renderMapLegend();
        if (mapReady) refreshMap();
      }));
    populateTeamsSubmenu();
    await loadOverview();
    await loadReports();
    document.getElementById("export-btn").addEventListener("click", exportCsv);
    // Light polling for near real-time updates.
    setInterval(() => {
      const active = document.querySelector(".nav-item.active").dataset.tab;
      if (active === "overview") loadOverview();
      if (active === "reports") loadReports();
    }, 20000);
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function fillFilter(id, pairs) {
    const el = document.getElementById(id);
    pairs.forEach(([v, l]) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = l; el.appendChild(o);
    });
  }

  // ---------- Overview: clickable operational cards ----------
  async function loadOverview() {
    const s = await api("/api/stats");
    renderOpCards(s);
    renderCharts(s);
    loadAttention();
    loadActivity();
    const badge = document.getElementById("nav-open-count");
    if (badge) badge.textContent = s.open || "";
  }

  // Recommended operational set: what MEO needs to act on today. Fake is
  // deliberately excluded as a headline metric (it's an enforcement outcome,
  // not a workload item); total-report count is not the headline either —
  // recent/pending work is.
  const OP_CARDS = [
    { key: "recent", label: "Recent Reports", status: null, sort: "newest" },
    { key: "pending", label: "Pending", status: "pending", sort: "newest" },
    { key: "validation", label: "Validation", status: "validation", sort: "newest" },
    { key: "verified", label: "Verified", status: "verified", sort: "newest" },
    { key: "ongoing", label: "Ongoing", status: "ongoing", sort: "priority" },
    { key: "unresolved", label: "Unresolved", status: "unresolved", sort: "newest" },
  ];
  function renderOpCards(s) {
    const counts = { recent: s.total, ...s.by_status };
    document.getElementById("op-card-grid").innerHTML = OP_CARDS.map((c) => `
      <button class="op-card" data-status="${c.status || ""}" data-sort="${c.sort}">
        <div class="label">${c.label}</div>
        <div class="value">${counts[c.key] || 0}</div>
      </button>`).join("");
    document.querySelectorAll(".op-card").forEach((el) => {
      Balatan.countUp(el.querySelector(".value"));
      el.addEventListener("click", () =>
        selectTab("reports", { status: el.dataset.status, sort: el.dataset.sort }));
    });
  }

  async function loadActivity() {
    const box = document.getElementById("activity-list");
    try {
      const entries = await api("/api/activity");
      if (!entries.length) {
        box.innerHTML = `<div class="empty">No activity recorded yet.</div>`;
        return;
      }
      box.innerHTML = `<ul class="timeline">` + entries.slice(0, 12).map((a) => `
        <li><strong>${esc(a.actor)}</strong> — ${esc(a.action)}
          ${a.detail ? `<div>${esc(a.detail)}</div>` : ""}
          <div class="when">${fmtDate(a.created_at)} · ${esc(a.role)}</div>
        </li>`).join("") + `</ul>`;
    } catch (err) {
      box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  async function loadAttention() {
    const box = document.getElementById("attention-list");
    const reports = await api("/api/reports");
    const open = reports.filter((r) => !["resolved", "fake", "not_in_scope"].includes(r.status));
    const rank = { critical: 3, high: 2, medium: 1, low: 0 };
    const items = open
      .filter((r) => r.priority || r.urgency === "critical" || (r.impact && r.impact.label === "Critical"))
      .sort((a, b) => (b.priority - a.priority) || (rank[b.urgency] - rank[a.urgency]) ||
        ((b.impact?.score || 0) - (a.impact?.score || 0)))
      .slice(0, 6);
    if (!items.length) {
      box.innerHTML = `<div class="empty">Nothing needs urgent attention. All critical issues are resolved.</div>`;
      return;
    }
    box.innerHTML = items.map(adminCard).join("");
    box.querySelectorAll(".report-item").forEach((el) =>
      el.addEventListener("click", () => openManage(el.dataset.id)));
  }

  function fmtHours(h) {
    if (!h) return "—";
    if (h < 24) return h.toFixed(1) + " h";
    return (h / 24).toFixed(1) + " d";
  }

  const PALETTE = ["#1d5b8f", "#2372a8", "#7c5cbf", "#2b8a63", "#b7791f",
    "#cf6a2e", "#c23b52", "#64748b", "#2f8f8f", "#a58a3a"];

  // Facility-type color mapping for the map/heatmap (Section 28) — reuses
  // the existing palette, distinct from urgency/status colors.
  const FACILITY_COLOR = {
    road: "#2372a8", bridge: "#1d5b8f", municipal_building: "#7c5cbf",
    public_facility: "#2b8a63", drainage_system: "#cf6a2e", streetlight: "#b7791f",
    water_facility: "#2f8f8f", electrical_facility: "#a58a3a",
    government_structure: "#c23b52", municipal_equipment: "#64748b", other: "#94a3b8",
  };
  function facilityColor(key) { return FACILITY_COLOR[key] || "#94a3b8"; }

  // Risk (CII impact) color mapping — the map/heatmap's alternate mode,
  // toggled against the report-type mode above.
  const RISK_COLOR = { Critical: "#c23b52", High: "#cf6a2e", Moderate: "#b7791f", Low: "#2b8a63" };
  function riskColor(impact) { return (impact && RISK_COLOR[impact.label]) || "#94a3b8"; }

  // "type" (default) or "risk" — which of the two color schemes the map
  // and heatmap currently use, per the panel's requested toggle.
  let mapColorMode = "type";
  function renderMapLegend() {
    const legend = document.getElementById("map-legend");
    const hint = document.getElementById("map-mode-hint");
    if (mapColorMode === "risk") {
      legend.innerHTML = Object.entries(RISK_COLOR).map(([label, color]) =>
        `<span><span class="dot" style="background:${color}"></span>${esc(label)}</span>`).join("");
      hint.innerHTML = `Markers and heat zones are colored by <strong>Community Impact Index
        risk level</strong> (Critical/High/Moderate/Low), so the most urgent concentrations
        stand out first.`;
    } else {
      legend.innerHTML = (cfg.facility_types || []).map((f) =>
        `<span><span class="dot" style="background:${facilityColor(f.key)}"></span>${esc(f.label)}</span>`).join("");
      hint.innerHTML = `Markers and heat zones are colored by <strong>facility/infrastructure
        type</strong>, so concentrations of a specific issue (e.g. streetlights, drainage) are
        immediately visible for planning.`;
    }
  }

  function renderCharts(s) {
    makeChart("chart-status", "doughnut",
      Object.keys(s.by_status).map(statusLabel), Object.values(s.by_status));
    makeChart("chart-category", "bar",
      Object.keys(s.by_category), Object.values(s.by_category));
    makeChart("chart-urgency", "doughnut",
      Object.keys(s.by_urgency).map(cap), Object.values(s.by_urgency),
      urgencyColors(Object.keys(s.by_urgency)));
    makeLine("chart-trend", s.trend.labels, s.trend.counts);
  }

  const URGENCY_COLOR = { low: "#2b8a63", medium: "#b7791f", high: "#cf6a2e", critical: "#c23b52" };
  function urgencyColors(keys) { return keys.map((k) => URGENCY_COLOR[k] || "#64748b"); }

  function makeChart(id, type, labels, data, colors) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), {
      type,
      data: { labels, datasets: [{ data, backgroundColor: colors || PALETTE,
        borderWidth: 2, borderColor: "#fff" }] },
      options: { responsive: true, maintainAspectRatio: false,
        cutout: type === "doughnut" ? "62%" : undefined,
        plugins: { legend: { display: type === "doughnut", position: "right",
          labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: "circle",
            padding: 14, font: { size: 12 } } } },
        scales: type === "bar" ? { y: { beginAtZero: true, ticks: { precision: 0 } },
          x: { ticks: { font: { size: 10 } } } } : {} },
    });
  }

  function makeLine(id, labels, data) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), {
      type: "line",
      data: { labels, datasets: [{ label: "Reports", data, borderColor: "#1d5b8f",
        backgroundColor: "rgba(29,91,143,.10)", fill: true, tension: .3,
        pointRadius: 2, pointBackgroundColor: "#1d5b8f", borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
    });
  }

  // ---------- Manage reports ----------
  async function loadReports() {
    const p = new URLSearchParams();
    const q = document.getElementById("rf-q").value.trim();
    const st = document.getElementById("rf-status").value;
    const ur = document.getElementById("rf-urgency").value;
    const fa = document.getElementById("rf-facility").value;
    const rt = document.getElementById("rf-reporter-type").value;
    if (q) p.set("q", q);
    if (st) p.set("status", st);
    if (ur) p.set("urgency", ur);
    if (fa) p.set("facility_type", fa);
    currentReports = await api("/api/reports?" + p.toString());
    if (rt) currentReports = currentReports.filter((r) => r.reporter_type === rt);
    const sorters = {
      priority: null, // server default: priority first, then newest
      newest: (a, b) => new Date(b.created_at) - new Date(a.created_at),
      oldest: (a, b) => new Date(a.created_at) - new Date(b.created_at),
      impact: (a, b) => b.impact.score - a.impact.score,
      residents: (a, b) => (b.affected_residents || 0) - (a.affected_residents || 0),
    };
    const sortBy = document.getElementById("rf-sort").value;
    if (sorters[sortBy]) currentReports.sort(sorters[sortBy]);
    const list = document.getElementById("admin-reports");
    if (!currentReports.length) { list.innerHTML = `<div class="empty">No reports match.</div>`; return; }
    list.innerHTML = currentReports.map(adminCard).join("");
    list.querySelectorAll(".report-item").forEach((el) =>
      el.addEventListener("click", () => openManage(el.dataset.id)));
  }

  function reporterBadge(r) {
    return r.reporter_type === "staff"
      ? `<span class="badge status-neutral plain">LGU STAFF</span>`
      : `<span class="badge low plain">RESIDENT</span>`;
  }

  function adminCard(r) {
    return `
      <div class="report-item ${r.priority || r.urgency === "critical" ? "pinned" : ""}" data-id="${r.id}">
        <div class="top">
          <p class="title">${esc(r.title)}</p>
          <span class="badge status-${r.status}">${statusLabel(r.status)}</span>
        </div>
        <div class="meta">${esc(r.reference)} · ${esc(r.category)} · ${esc(r.barangay || "—")} ·
          ${esc(r.facilityLabel || facilityLabel(r.facility_type))} · ${timeAgo(r.created_at)}</div>
        <div class="badges">
          ${reporterBadge(r)}
          ${r.priority ? `<span class="badge medium plain">Priority</span>` : ""}
          ${impactBadge(r.impact)}
          <span class="badge ${r.urgency}">${esc(r.urgency)}</span>
          ${r.assigned_team ? `<span class="badge status-ongoing plain">${esc(r.assigned_team)}</span>` : ""}
        </div>
      </div>`;
  }

  function facilityLabel(key) {
    const f = (cfg.facility_types || []).find((x) => x.key === key);
    return f ? f.label : key;
  }
  function infoIcon(targetId, title) {
    return `<button type="button" class="info-btn" data-info="${targetId}" title="${esc(title)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/>
        <path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
    </button>`;
  }
  function impactBadge(impact, ciiDetailsId) {
    if (!impact) return "";
    return `<span class="badge impact-${impact.label}">Impact ${impact.score} · ${impact.label}</span>${
      ciiDetailsId ? infoIcon(ciiDetailsId, "How is Impact calculated?") : ""}`;
  }

  async function openManage(id) {
    const r = await api("/api/reports/" + id);
    // Only the current status plus its legal next steps (per the confirmed
    // MEO workflow graph) are selectable — the server enforces the same
    // graph, so any legal shortcut (e.g. Pending -> Resolved or -> Fake or
    // -> Not in Scope, when the transition table allows it) is available
    // here without forcing every report through every status.
    const validNext = (cfg.status_transitions && cfg.status_transitions[r.status]) || [];
    const statusChoices = [r.status, ...validNext];
    const statusOpts = statusChoices.map((s) =>
      `<option value="${s}" ${s === r.status ? "selected" : ""}>${statusLabel(s)}</option>`).join("");
    const statusHint = validNext.length
      ? `Next step${validNext.length > 1 ? "s" : ""}: ${validNext.map(statusLabel).join(" or ")}`
      : "This is a final status and cannot be changed.";
    const urgencyOpts = cfg.urgency_levels.map((u) =>
      `<option value="${u}" ${u === r.urgency ? "selected" : ""}>${cap(u)}</option>`).join("");
    const TEAM_ELIGIBLE = ["ongoing", "resolved", "unresolved"];
    const teamOpts = (cfg.meo_teams || []).map((t) =>
      `<option value="${esc(t)}" ${t === r.assigned_team ? "selected" : ""}>${esc(t)}</option>`).join("");
    const photos = (r.photos && r.photos.length) ? r.photos.map((p) => p.photo_path)
      : (r.photo_path ? [r.photo_path] : []);

    openModal(`
      <button class="close-x" onclick="Balatan.__closeAdmin()">×</button>
      <h3>${esc(r.title)}</h3>
      <p class="subhead">${esc(r.reference)}</p>

      <h4>Report Information</h4>
      <div class="badges" style="margin:6px 0 10px;">
        ${reporterBadge(r)}
        ${r.priority ? `<span class="badge medium plain">Priority</span>` : ""}
        ${impactBadge(r.impact, "cii-details")}
        <span class="badge status-${r.status}">${statusLabel(r.status)}</span>
        <span class="badge ${r.urgency}">${esc(r.urgency)}</span>
      </div>
      <div class="info-panel" id="cii-details" style="display:none;">
        <p class="drivers">CII = Frequency × 1.5 + Affected Count × 2.0 + Recurrence Score × 1.0 —
           Frequency: <strong>${r.impact.frequency}</strong> ·
           Affected Count (community-confirmed via "I am affected"): <strong>${r.impact.affected_count}</strong> ·
           Recurrence Score: <strong>${r.impact.recurrence_score}</strong> ·
           CII: <strong>${r.impact.score}</strong></p>
      </div>
      <p>
        <strong>Reporter:</strong> ${esc(r.reporter_name || "Anonymous")}${r.reporter_contact ? " · " + esc(r.reporter_contact) : ""}<br>
        ${r.reporter_type === "staff" && r.staff_office ? `<strong>Office:</strong> ${esc(r.staff_office)}<br>` : ""}
        <strong>Category:</strong> ${esc(r.category)} &nbsp; <strong>Facility:</strong> ${esc(facilityLabel(r.facility_type))}<br>
        <strong>Affected residents:</strong> ${r.affected_residents ?? "—"} ${infoIcon("affected-note", "What's the difference from Affected Count?")} &nbsp;
        <strong>Date submitted:</strong> ${fmtDate(r.created_at)}
      </p>
      <div class="info-panel" id="affected-note" style="display:none;">
        <p class="hint">"Affected residents" above is the reporter's own estimate at submission
          (used only for automatic urgency) — a separate number from the community-confirmed
          "Affected Count" used in the CII formula.</p>
      </div>
      <p>${esc(r.description) || "<em>No description provided.</em>"}</p>

      <h4>Location</h4>
      <p><strong>Barangay:</strong> ${esc(r.barangay || "—")}<br>
         <strong>Address / landmark:</strong> ${esc(r.address || "—")}</p>
      ${r.latitude != null ? `<div id="manage-mini-map" class="mini-map"></div>` : ""}

      ${photos.length ? `<h4>Evidence</h4>
        <div class="photo-preview-list">${photos.map((p) =>
          `<img src="/uploads/${esc(p)}" alt="photo" style="width:120px;height:120px;">`).join("")}</div>` : ""}

      <h4>Workflow</h4>
      <div class="inline-form">
        <div class="field-row">
          <div><label>Status</label><select id="m-status">${statusOpts}</select>
            <div class="hint" style="margin-top:4px;">${esc(statusHint)}</div></div>
          <div><label>Urgency</label><select id="m-urgency">${urgencyOpts}</select></div>
        </div>
        <label id="m-team-label">Assigned Team${TEAM_ELIGIBLE.includes(r.status) ? "" : " (available once Ongoing)"}</label>
        <select id="m-assigned-team" ${TEAM_ELIGIBLE.includes(r.status) ? "" : "disabled"}>
          <option value="">— Unassigned —</option>
          ${teamOpts}
        </select>
        <label>Note (added to history)</label>
        <textarea id="m-note" placeholder="e.g. Crew dispatched, materials requested"></textarea>

        <label>Photo evidence (optional — repair / completion)</label>
        <input type="file" id="m-photo" accept="image/*" />

        <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;">
          <button class="btn" id="m-save">Save update</button>
          <button class="btn ${r.priority ? "secondary" : "accent"}" id="m-pin">
            ${r.priority ? "Remove priority" : "Mark as priority"}</button>
        </div>
      </div>

      <h4>Status history</h4>
      <ul class="timeline">
        ${(r.history || []).map((h) => `
          <li><strong>${statusLabel(h.status)}</strong>
            ${h.office ? `<div style="margin-top:4px;"><span class="badge medium plain">${esc(h.office)}</span>${h.reason ? ` <span class="hint" style="display:inline;">— ${esc(h.reason)}</span>` : ""}</div>` : ""}
            <div class="when">${fmtDate(h.created_at)} · ${esc(h.actor || "")}</div>
            ${h.note ? `<div>${esc(h.note)}</div>` : ""}
            ${h.photo_path ? `<img class="progress-photo" src="/uploads/${esc(h.photo_path)}" alt="progress photo">` : ""}</li>`).join("")}
      </ul>
    `);

    if (r.latitude != null && document.getElementById("manage-mini-map")) {
      const mm = L.map("manage-mini-map", {
        zoomControl: false, dragging: false, scrollWheelZoom: false, attributionControl: false,
      }).setView([r.latitude, r.longitude], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(mm);
      L.marker([r.latitude, r.longitude]).addTo(mm);
      setTimeout(() => mm.invalidateSize(), 60);
    }

    // Re-check team-assignment eligibility against whatever status is
    // currently picked (not just the report's status when the panel
    // opened), so choosing "Ongoing" in this same panel immediately
    // unlocks team assignment too.
    document.getElementById("m-status").addEventListener("change", (e) => {
      const eligible = TEAM_ELIGIBLE.includes(e.target.value);
      document.getElementById("m-assigned-team").disabled = !eligible;
      document.getElementById("m-team-label").textContent =
        "Assigned Team" + (eligible ? "" : " (available once Ongoing)");
    });

    // One "Save update" action covers everything in this panel — the
    // status/urgency/team change (+ note), and, if provided, a repair-
    // evidence photo. These map to two different backend calls (a report
    // update vs. a history/progress entry), but the admin only needs to
    // press one button; each call only fires if there's actually something
    // in it to save.
    document.getElementById("m-save").addEventListener("click", async () => {
      const status = document.getElementById("m-status").value;
      const urgency = document.getElementById("m-urgency").value;
      const note = document.getElementById("m-note").value.trim();
      const teamSel = document.getElementById("m-assigned-team");
      const teamChanged = !teamSel.disabled && teamSel.value !== (r.assigned_team || "");
      const file = document.getElementById("m-photo").files[0];

      const hasCoreUpdate = status !== r.status || urgency !== r.urgency || teamChanged || note;
      const hasProgressUpdate = !!file;
      if (!hasCoreUpdate && !hasProgressUpdate) {
        return toast("Nothing to save — change a field, add a note, or attach a photo first.", "error");
      }

      try {
        if (hasCoreUpdate) {
          const body = { status, urgency, note };
          if (!teamSel.disabled) body.assigned_team = teamSel.value;
          await api("/api/reports/" + id, { method: "PATCH", json: body });
        }
        if (hasProgressUpdate) {
          const fd = new FormData();
          fd.append("photo", file);
          await api(`/api/reports/${id}/progress`, { method: "POST", body: fd });
        }
        toast("Report updated", "success");
        Balatan.__closeAdmin();
        loadReports();
        loadOverview();
      } catch (err) { toast(err.message, "error"); }
    });
    document.getElementById("m-pin").addEventListener("click", async () => {
      await patch(id, { priority: r.priority ? 0 : 1 });
    });
  }

  async function patch(id, body) {
    try {
      await api("/api/reports/" + id, { method: "PATCH", json: body });
      toast("Report updated", "success");
      Balatan.__closeAdmin();
      loadReports();
      loadOverview();
    } catch (err) { toast(err.message, "error"); }
  }

  // ---------- Map & heatmap (colored by report/facility type) ----------
  let mapReady = false;
  async function initMap() {
    if (!mapReady) {
      adminMap = L.map("admin-map").setView([cfg.center.lat, cfg.center.lng], cfg.zoom);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: "© OpenStreetMap contributors",
      }).addTo(adminMap);
      markerLayer = L.layerGroup().addTo(adminMap);
      mapReady = true;
    }
    adminMap.invalidateSize();
    await refreshMap();
  }

  /** Grouping key + color for the current map mode — "type" groups by
   * facility (what kind of issue), "risk" groups by CII impact label (how
   * urgent), per the panel-requested toggle. */
  function mapGroupKey(r) { return mapColorMode === "risk" ? (r.impact && r.impact.label) : r.facility_type; }
  function mapGroupColor(key, r) { return mapColorMode === "risk" ? riskColor(r.impact) : facilityColor(key); }

  async function refreshMap() {
    const reports = await api("/api/reports");
    markerLayer.clearLayers();
    const bounds = [];
    reports.forEach((r) => {
      if (r.latitude == null || r.longitude == null) return;
      bounds.push([r.latitude, r.longitude]);
      const color = mapGroupColor(r.facility_type, r);
      const m = L.circleMarker([r.latitude, r.longitude], {
        radius: 8, color: "#fff", weight: 2, fillColor: color, fillOpacity: .9,
      }).bindPopup(`<strong>${esc(r.title)}</strong><br>${esc(r.reference)}<br>
        ${esc(facilityLabel(r.facility_type))} · ${statusLabel(r.status)}<br>
        Impact ${r.impact.score} (${r.impact.label})`);
      markerLayer.addLayer(m);
    });

    // Grouped heat layers per facility type or risk level (depending on
    // mode) so the heatmap communicates WHAT/HOW URGENT is concentrated
    // somewhere, not just how intensely reported an area is.
    if (heatLayer) { adminMap.removeLayer(heatLayer); }
    heatLayer = L.layerGroup();
    const byGroup = {};
    reports.forEach((r) => {
      if (r.latitude == null || r.longitude == null) return;
      const key = mapGroupKey(r) || "other";
      (byGroup[key] = byGroup[key] || []).push(r);
    });
    Object.entries(byGroup).forEach(([, group]) => {
      const color = mapGroupColor(group[0].facility_type, group[0]);
      const pts = group.map((r) => [r.latitude, r.longitude, 0.6]);
      L.heatLayer(pts, {
        radius: 30, blur: 20, maxZoom: 17, minOpacity: 0.35,
        gradient: { 0.3: color, 1: color },
      }).addTo(heatLayer);
    });
    heatLayer.addTo(adminMap);
    if (bounds.length) adminMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }

  document.getElementById("toggle-heat").addEventListener("click", () => {
    if (!heatLayer) return;
    if (adminMap.hasLayer(heatLayer)) adminMap.removeLayer(heatLayer);
    else heatLayer.addTo(adminMap);
  });
  document.getElementById("toggle-markers").addEventListener("click", () => {
    if (!markerLayer) return;
    if (adminMap.hasLayer(markerLayer)) adminMap.removeLayer(markerLayer);
    else markerLayer.addTo(adminMap);
  });

  // ---------- Predictions ----------
  async function loadPredictions() {
    const box = document.getElementById("predict-table");
    box.innerHTML = `<div class="empty">Analyzing…</div>`;
    const rows = await api("/api/predictions");
    if (!rows.length) {
      box.innerHTML = `<div class="empty">Not enough clustered reports yet to identify recurring issues.</div>`;
      return;
    }
    box.innerHTML = `
      <div class="table-wrap">
      <table class="data">
        <thead><tr>
          <th>Risk</th><th>Location / facility</th><th>Common issue</th>
          <th>Reports</th><th>Last 30d</th><th>Trend</th><th>Last report</th><th>Typical Recurrence Interval</th>
        </tr></thead>
        <tbody>
        ${rows.map((r) => `
          <tr>
            <td><strong>${r.risk_score}</strong></td>
            <td>${esc(r.example_address || "—")}<br><span class="muted-cell">${esc(facilityLabel(r.facility_type))}</span></td>
            <td>${esc(r.top_category)}</td>
            <td>${r.report_count}</td>
            <td>${r.reports_30d}</td>
            <td class="trend-${r.trend}">${cap(r.trend)}</td>
            <td>${r.last_report}</td>
            <td><strong>~${r.mean_interval_days} days</strong><br><span class="muted-cell">based on ${r.report_count} past reports; next around ${r.predicted_next}</span></td>
          </tr>`).join("")}
        </tbody>
      </table>
      </div>`;
  }

  // ---------- Export ----------
  function exportCsv() {
    const token = localStorage.getItem("balatan_token");
    window.open("/api/export.csv?token=" + encodeURIComponent(token), "_blank");
  }
  document.getElementById("rf-apply").addEventListener("click", loadReports);
  document.getElementById("rf-sort").addEventListener("change", loadReports);

  // Real-time dashboard: refresh the visible section every 30 seconds.
  setInterval(() => {
    if (document.visibilityState !== "visible" || !isAuthed()) return;
    const active = document.querySelector(".nav-item.active");
    if (!active) return;
    if (active.dataset.tab === "overview") loadOverview();
    if (active.dataset.tab === "reports") loadReports();
    if (active.dataset.tab === "teams") {
      const current = document.querySelector("#teams-submenu .nav-subitem.active");
      loadTeamReports(current ? current.dataset.team : "");
    }
    if (active.dataset.tab === "predict") loadPredictions();
    if (active.dataset.tab === "users") loadUsers();
  }, 30000);
  document.getElementById("rf-q").addEventListener("keydown", (e) => { if (e.key === "Enter") loadReports(); });

  // ---------- Modal ----------
  function openModal(html) {
    document.getElementById("admin-modal-content").innerHTML = html;
    document.getElementById("admin-modal").classList.add("open");
  }
  Balatan.__closeAdmin = () => document.getElementById("admin-modal").classList.remove("open");
  document.getElementById("admin-modal").addEventListener("click", (e) => {
    if (e.target.id === "admin-modal") Balatan.__closeAdmin();
    const infoBtn = e.target.closest(".info-btn");
    if (infoBtn) {
      const panel = document.getElementById(infoBtn.dataset.info);
      if (panel) panel.style.display = panel.style.display === "none" ? "" : "none";
    }
  });

  // ---------- Start ----------
  // A token merely existing in localStorage proves nothing — verify it
  // against the server (GET /api/me) before rendering the dashboard shell,
  // so a stale/forged/expired token can never bypass admin auth client-side.
  async function verifyAndStart() {
    if (!isAuthed()) return showLogin();
    try {
      const me = await api("/api/me");
      if (me && me.role === "admin") return showDashboard();
    } catch (_) { /* falls through to the invalid-session branch below */ }
    localStorage.removeItem("balatan_token");
    showLogin();
  }
  verifyAndStart();
})();
