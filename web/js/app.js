/* Resident portal: email sign-in (geofenced to Balatan), MEO reporting form
   (with GPS map), and public/personal tracking. */
(function () {
  const { api, toast, esc, timeAgo, fmtDate, statusLabel } = Balatan;
  let map, marker, cfg;
  let user = null;          // signed-in resident, or null
  let activeTab = "report";
  const MAX_PHOTOS = 5;
  let selectedPhotos = [];  // File[] — source of truth for the photo uploader

  const TOKEN_KEY = "balatan_resident_token";

  Balatan.registerSW();
  Balatan.setupInstall("install-banner");

  // Resident-authenticated API call (separate token from the admin one).
  function rapi(path, opts = {}) {
    const token = localStorage.getItem(TOKEN_KEY);
    const headers = { ...(opts.headers || {}) };
    if (token) headers["Authorization"] = "Bearer " + token;
    return api(path, { ...opts, headers });
  }

  // ---- Resident session (sign-in itself lives on /login) ----
  function updateAuthUI() {
    const headerUserBtn = document.getElementById("header-user-btn");
    const logoutLink = document.getElementById("logout-link");
    headerUserBtn.style.display = user ? "" : "none";
    logoutLink.style.display = user ? "" : "none";
    document.getElementById("tab-btn-track").style.display = user ? "" : "none";
    if (user) document.getElementById("header-user").textContent = user.name;
    document.getElementById("submitting-as").textContent =
      user ? `Submitting as ${user.name} (${user.email})` : "";
    // Staff reporting is admin-granted, not self-declared (see loadSession())
    // — an ordinary resident never even sees the toggle, avoiding both the
    // "why do I see a staff option" confusion and self-declared misuse.
    document.getElementById("staff-toggle-fieldset").style.display =
      (user && user.is_staff) ? "" : "none";
    if (!user || !user.is_staff) {
      document.getElementById("f-reporter-type").value = "resident";
      document.getElementById("f-staff-office-wrap").style.display = "none";
      document.querySelectorAll("#reporter-type-toggle .seg-btn").forEach((b, i) => b.classList.toggle("active", i === 0));
    }
    showTab(activeTab);
  }

  function showTab(tab) {
    activeTab = tab;
    const authed = !!user;
    // Signed-in-only tabs fall back to the sign-in prompt.
    if (tab === "track" && !authed) tab = "report";
    document.getElementById("tab-auth").style.display =
      tab === "report" && !authed ? "" : "none";
    document.getElementById("tab-report").style.display =
      tab === "report" && authed ? "" : "none";
    document.getElementById("tab-track").style.display = tab === "track" ? "" : "none";
    document.getElementById("tab-community").style.display = tab === "community" ? "" : "none";
    const shown = { track: "tab-track", community: "tab-community" }[tab]
      || (authed ? "tab-report" : "tab-auth");
    Balatan.replayAnim(document.getElementById(shown));
    if (tab === "report" && authed && map) setTimeout(() => map.invalidateSize(), 50);
  }

  async function loadSession() {
    if (!localStorage.getItem(TOKEN_KEY)) return;
    try {
      const me = await rapi("/api/me");
      if (me.role === "resident") {
        user = { name: me.name, email: me.email, is_staff: false };
        // Staff reporting is admin-granted, not self-declared — look up
        // whether this account is actually eligible before ever showing
        // the toggle (see initReporterTypeToggle()).
        try {
          const profile = await rapi("/api/profile");
          user.is_staff = !!profile.is_staff;
        } catch { /* toggle just stays hidden if this lookup fails */ }
      }
    } catch {
      localStorage.removeItem(TOKEN_KEY); // stale token (server restarted)
    }
  }

  document.getElementById("logout-link").addEventListener("click", async (e) => {
    e.preventDefault();
    try { await rapi("/api/logout", { method: "POST" }); } catch { /* token already gone */ }
    localStorage.removeItem(TOKEN_KEY);
    user = null;
    updateAuthUI();
    toast("Signed out", "success");
  });

  // ---- Tabs (hash-driven so external links like /portal#community work) ----
  function selectTab(tab, pushHash) {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
    showTab(tab);
    if (pushHash !== false) history.replaceState(null, "", "#" + tab);
    if (tab === "track") loadTrack();
    if (tab === "community") { loadCommunity(); loadPublicReports(); }
  }
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => selectTab(t.dataset.tab));
  });

  // ---- Init ----
  async function init() {
    Balatan.initThemeToggle("theme-toggle");
    cfg = await Balatan.config();
    fillSelect("f-category", cfg.categories.map((c) => [c, c]));
    fillSelect("f-facility", cfg.facility_types.map((f) => [f.key, f.label]));
    initBarangayCombobox();
    initReporterTypeToggle();
    initMap();
    initTurnstile();
    await loadSession();
    updateAuthUI();
    // Route from the URL hash (e.g. a landing-page link to #community);
    // default to "report" when there is none or it doesn't apply yet.
    const initial = (location.hash || "").replace("#", "");
    if (["report", "track", "community"].includes(initial)) selectTab(initial, false);
    Balatan.initBell({ bellId: "notif-bell", panelId: "notif-panel", tokenKey: TOKEN_KEY });
  }

  // ---- Reporter type (resident / staff) ----
  function initReporterTypeToggle() {
    const wrap = document.getElementById("reporter-type-toggle");
    const hidden = document.getElementById("f-reporter-type");
    const officeWrap = document.getElementById("f-staff-office-wrap");
    const officeInput = document.getElementById("f-staff-office");
    wrap.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        wrap.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        hidden.value = btn.dataset.value;
        const isStaff = hidden.value === "staff";
        officeWrap.style.display = isStaff ? "" : "none";
        officeInput.required = isStaff;
        if (!isStaff) officeInput.value = "";
      });
    });
  }

  // ---- Barangay searchable combobox ----
  function initBarangayCombobox() {
    const input = document.getElementById("f-barangay-input");
    const hidden = document.getElementById("f-barangay");
    const list = document.getElementById("barangay-list");
    const all = cfg.barangays;

    function render(filterText) {
      const q = (filterText || "").trim().toLowerCase();
      const matches = q ? all.filter((b) => b.toLowerCase().includes(q)) : all;
      list.innerHTML = matches.length
        ? matches.map((b) => `<div class="combobox-item" data-value="${esc(b)}">${esc(b)}</div>`).join("")
        : `<div class="combobox-empty">No barangay matches "${esc(filterText)}"</div>`;
      list.querySelectorAll(".combobox-item").forEach((el) => {
        el.addEventListener("mousedown", (e) => {
          e.preventDefault(); // keep focus, avoid blur closing the list first
          input.value = el.dataset.value;
          hidden.value = el.dataset.value;
          list.classList.remove("open");
        });
      });
      list.classList.add("open");
    }
    input.addEventListener("focus", () => render(input.value));
    input.addEventListener("input", () => { hidden.value = ""; render(input.value); });
    input.addEventListener("blur", () => setTimeout(() => list.classList.remove("open"), 120));
  }

  // ---- Cloudflare Turnstile (report submission only) ----
  // Progressive enhancement: only loaded/rendered when the server has a
  // site key configured (GET /api/config -> turnstile_site_key). With no
  // site key configured, the backend relies on its own explicit dev-bypass
  // (BALATAN_TURNSTILE_DEV_BYPASS) — the frontend has nothing to render and
  // submits without a token, exactly as the backend contract expects.
  let turnstileWidgetId = null;
  function initTurnstile() {
    if (!cfg.turnstile_site_key) return;
    document.getElementById("turnstile-field").style.display = "";
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      turnstileWidgetId = window.turnstile.render("#turnstile-widget", {
        sitekey: cfg.turnstile_site_key,
      });
    };
    document.head.appendChild(script);
  }
  function getTurnstileToken() {
    if (!cfg.turnstile_site_key) return ""; // not configured — backend dev-bypass decides
    if (turnstileWidgetId === null || !window.turnstile) return "";
    return window.turnstile.getResponse(turnstileWidgetId) || "";
  }
  function resetTurnstile() {
    if (turnstileWidgetId !== null && window.turnstile) window.turnstile.reset(turnstileWidgetId);
  }

  // ---- Profile modal (opened from the header user name) ----
  function openProfile() {
    document.getElementById("profile-modal").classList.add("open");
    loadProfileInto();
  }
  Balatan.__closeProfile = () => document.getElementById("profile-modal").classList.remove("open");
  document.getElementById("header-user-btn").addEventListener("click", openProfile);
  document.getElementById("profile-modal").addEventListener("click", (e) => {
    if (e.target.id === "profile-modal") Balatan.__closeProfile();
  });

  async function loadProfileInto() {
    try {
      const p = await rapi("/api/profile");
      document.getElementById("pf-name").value = p.name;
      document.getElementById("pf-contact").value = p.contact || "";
      document.getElementById("pf-barangay").value = p.barangay || "";
      document.getElementById("pf-email").textContent = `Signed up as ${p.email}`;
      const statusBox = document.getElementById("pf-account-status");
      const rows = [];
      rows.push(`<div><strong>ID verification:</strong> ${esc(idStatusLabel(p.id_verification_status))}</div>`);
      rows.push(`<div><strong>Staff reporting:</strong> ${p.is_staff
        ? "Enabled — you can report as MEO/LGU staff"
        : "Not enabled — contact the LGU office if you need staff access"}</div>`);
      if (p.suspended_until && new Date(p.suspended_until) > new Date()) {
        rows.push(`<div class="acct-warn"><strong>Reporting suspended</strong> until ${esc(fmtDate(p.suspended_until))}</div>`);
      }
      if (p.permanently_flagged) {
        rows.push(`<div class="acct-danger"><strong>Account blocked</strong> — contact the LGU office to appeal.</div>`);
      }
      if (p.admin_action_required) {
        rows.push(`<div class="acct-danger"><strong>Administrative Action Required</strong> — ` +
          "following repeated fake reports, your account has been referred for review by the " +
          "LGU/MEO. New report submissions are on hold pending that review; you can still sign " +
          "in and update your profile.</div>");
      }
      statusBox.innerHTML = rows.join("");
      const idHint = document.getElementById("pf-id-hint");
      idHint.className = "hint";
      if (p.id_verification_status === "rejected") {
        idHint.classList.add("acct-danger");
        idHint.textContent = "Your ID was rejected, so new reports are on hold. " +
          "Upload a clear new photo below to send it back for review.";
      } else if (p.id_verification_status === "verified") {
        idHint.textContent = "Verified — no action needed unless your ID has changed.";
      } else {
        idHint.textContent = "Under review by the LGU. You can upload a clearer photo below if needed.";
      }
    } catch (err) { toast(err.message, "error"); }
  }
  function idStatusLabel(s) {
    return { pending: "Under review", verified: "Verified", rejected: "Rejected — see below to re-upload" }[s] || s || "—";
  }

  document.getElementById("profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const p = await rapi("/api/profile", { method: "PATCH", json: {
        name: document.getElementById("pf-name").value.trim(),
        contact: document.getElementById("pf-contact").value.trim(),
        barangay: document.getElementById("pf-barangay").value.trim(),
      }});
      user = { name: p.name, email: p.email, is_staff: !!p.is_staff };
      updateAuthUI();
      toast("Profile saved", "success");
    } catch (err) { toast(err.message, "error"); }
  });

  document.getElementById("id-reupload-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fileInput = document.getElementById("pf-valid-id");
    if (!fileInput.files.length) return;
    const fd = new FormData();
    fd.append("valid_id", fileInput.files[0]);
    try {
      await rapi("/api/profile/valid-id", { method: "POST", body: fd });
      e.target.reset();
      toast("ID uploaded — it's back in the LGU's review queue", "success");
      loadProfileInto();
    } catch (err) { toast(err.message, "error"); }
  });

  document.getElementById("password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await rapi("/api/change-password", { method: "POST", json: {
        current_password: document.getElementById("cp-current").value,
        new_password: document.getElementById("cp-new").value,
      }});
      e.target.reset();
      toast("Password changed", "success");
    } catch (err) { toast(err.message, "error"); }
  });

  function fillSelect(id, pairs, def) {
    const el = document.getElementById(id);
    el.innerHTML = pairs.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
    if (def) el.value = def;
  }

  function reporterBadge(r) {
    return r.reporter_type === "staff"
      ? `<span class="badge status-neutral plain">LGU STAFF</span>`
      : `<span class="badge low plain">RESIDENT</span>`;
  }

  const URGENCY_RANK = { critical: 3, high: 2, medium: 1, low: 0 };

  // ---- Track Reports (signed-in resident's own reports) ----
  async function loadTrack() {
    const list = document.getElementById("my-reports");
    Balatan.showSkeleton(list, 3);
    try {
      const mine = await rapi("/api/reports/mine");
      mine.sort((a, b) => (URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency]) ||
        (new Date(b.created_at) - new Date(a.created_at)));
      list.innerHTML = mine.length
        ? mine.map(trackCard).join("")
        : `<div class="empty">You have not reported anything yet.</div>`;
      list.querySelectorAll(".report-item").forEach((el) =>
        el.addEventListener("click", () => openDetail(el.dataset.id)));
    } catch (err) {
      list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  function reportThumb(r) {
    return r.photo_path
      ? `<img class="ri-thumb" src="/uploads/${esc(r.photo_path)}" alt="" loading="lazy">` : "";
  }

  function trackCard(r) {
    return `
      <div class="report-item ${r.urgency === "critical" ? "pinned" : ""}" data-id="${r.id}">
        <div class="ri-row">
          ${reportThumb(r)}
          <div class="ri-body">
            <div class="top">
              <p class="title">${esc(r.title)}</p>
              <span class="badge status-${r.status}">${statusLabel(r.status)}</span>
            </div>
            <div class="meta">${esc(r.reference)} · ${esc(r.category)} · ${esc(facilityLabel(r.facility_type))} ·
              ${esc(r.barangay || "Balatan")} · ${timeAgo(r.created_at)}</div>
            <div class="badges">
              ${impactBadge(r.impact)}
              <span class="badge ${r.urgency}">${esc(r.urgency)}</span>
              ${r.assigned_team ? `<span class="badge status-ongoing plain">Team: ${esc(r.assigned_team)}</span>` : ""}
            </div>
          </div>
        </div>
      </div>`;
  }

  function facilityLabel(key) {
    const f = (cfg.facility_types || []).find((x) => x.key === key);
    return f ? f.label : key;
  }

  // ---- Community Reports: Nearby Issues + Recent Community Reports ----
  async function loadCommunity() {
    const list = document.getElementById("community-list");
    const status = document.getElementById("community-status");
    if (!user) { list.innerHTML = ""; status.textContent = "Sign in to see issues near you."; return; }
    Balatan.showSkeleton(list, 3);

    const render = (reports, origin) => {
      const open = reports.filter((r) => !["resolved", "fake", "not_in_scope"].includes(r.status));
      let items = open;
      if (origin) {
        items = open
          .filter((r) => r.latitude !== null && r.longitude !== null)
          .map((r) => ({ ...r, _dist: distanceM(origin, r) }))
          .sort((a, b) => a._dist - b._dist)
          .slice(0, 20);
        status.textContent = `Showing ${items.length} open issue(s), closest first.`;
      } else {
        items.sort((a, b) => b.impact.score - a.impact.score);
        items = items.slice(0, 20);
        status.textContent = "Location unavailable — showing open issues by community impact instead.";
      }
      list.innerHTML = items.length
        ? items.map((r) => communityCard(r, !!origin)).join("")
        : `<div class="empty">No open issues right now — great news for Balatan!</div>`;
      list.querySelectorAll(".report-item").forEach((el) =>
        el.addEventListener("click", () => openDetail(el.dataset.id)));
      list.querySelectorAll(".affected-btn").forEach((btn) =>
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleAffected(btn.dataset.id, btn);
        }));
    };

    const reports = await rapi("/api/reports");
    if (!navigator.geolocation) return render(reports, null);
    navigator.geolocation.getCurrentPosition(
      (pos) => render(reports, { lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => render(reports, null),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }
  document.getElementById("community-locate").addEventListener("click", loadCommunity);

  function distanceM(origin, r) {
    const rad = (x) => (x * Math.PI) / 180;
    const a = Math.sin(rad(r.latitude - origin.lat) / 2) ** 2 +
      Math.cos(rad(origin.lat)) * Math.cos(rad(r.latitude)) *
      Math.sin(rad(r.longitude - origin.lng) / 2) ** 2;
    return Math.round(2 * 6371000 * Math.asin(Math.sqrt(a)));
  }

  function fmtDist(m) {
    return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
  }

  function affectedIcon() {
    // A raised hand — "count me in" — clearer at a glance than an abstract shape.
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;">
      <path d="M9 12.5V5a1.5 1.5 0 0 1 3 0v6"/>
      <path d="M12 11V4a1.5 1.5 0 0 1 3 0v7"/>
      <path d="M15 12V7a1.5 1.5 0 0 1 3 0v7a5 5 0 0 1-5 5h-2a5 5 0 0 1-4-2.2l-2.3-3.2a1.5 1.5 0 0 1 2.2-2L8 13"/>
    </svg>`;
  }

  function communityCard(r, withDist) {
    return `
      <div class="report-item" data-id="${r.id}">
        <div class="ri-row">
          ${reportThumb(r)}
          <div class="ri-body">
            <div class="top">
              <p class="title">${esc(r.title)}</p>
              <span class="badge status-${r.status}">${statusLabel(r.status)}</span>
            </div>
            <div class="meta">${esc(r.reference)} · ${esc(r.category)} ·
              ${esc(r.barangay || "Balatan")}${withDist ? ` · ${fmtDist(r._dist)} away` : ""} ·
              ${timeAgo(r.created_at)}</div>
            <div class="badges" style="align-items:center;">
              ${reporterBadge(r)}
              ${impactBadge(r.impact)}
              <button class="affected-btn" data-id="${r.id}">
                ${affectedIcon()} I am affected · <span class="cnt">${r.affected_count || 0}</span>
              </button>
            </div>
          </div>
        </div>
      </div>`;
  }

  async function toggleAffected(id, btn) {
    try {
      const res = await rapi(`/api/reports/${id}/affected`, { method: "POST" });
      btn.classList.toggle("on", res.affected);
      btn.querySelector(".cnt").textContent = res.count;
      toast(res.affected
        ? "Noted — this issue now carries your voice too."
        : "Removed your mark from this issue.", "success");
    } catch (err) { toast(err.message, "error"); }
  }

  // ---- Map + GPS ----
  function initMap() {
    map = L.map("report-map", { attributionControl: true })
      .setView([cfg.center.lat, cfg.center.lng], cfg.zoom);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap contributors",
    }).addTo(map);
    marker = L.marker([cfg.center.lat, cfg.center.lng], { draggable: true }).addTo(map);
    marker.on("dragend", () => setCoords(marker.getLatLng().lat, marker.getLatLng().lng, "Pin placed manually"));
    map.on("click", (e) => { marker.setLatLng(e.latlng); setCoords(e.latlng.lat, e.latlng.lng, "Pin placed manually"); });
  }

  function setCoords(lat, lng, msg) {
    document.getElementById("f-lat").value = lat.toFixed(6);
    document.getElementById("f-lng").value = lng.toFixed(6);
    document.getElementById("gps-status").textContent =
      `${msg} — ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }

  // The map stays collapsed by default so the form is the primary focus —
  // it only needs to be visible/interactive if the resident wants to
  // manually adjust the pin.
  document.getElementById("toggle-map-btn").addEventListener("click", (e) => {
    const wrap = document.getElementById("map-wrap");
    const open = wrap.style.display !== "none";
    wrap.style.display = open ? "none" : "";
    e.target.textContent = open ? "Adjust pin on a map ▾" : "Hide map ▴";
    if (!open) setTimeout(() => map.invalidateSize(), 60);
  });

  document.getElementById("locate-btn").addEventListener("click", () => {
    if (!navigator.geolocation) return toast("Geolocation not supported", "error");
    document.getElementById("gps-status").textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        map.setView([latitude, longitude], 17);
        marker.setLatLng([latitude, longitude]);
        setCoords(latitude, longitude, "GPS location captured");
      },
      () => toast("Could not get your location. Use \"Adjust pin on a map\" instead.", "error"),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // ---- Photo upload: add via button, individually removable ----
  function renderPhotoPreviews() {
    const list = document.getElementById("photo-preview-list");
    const hint = document.getElementById("photo-count-hint");
    list.innerHTML = selectedPhotos.map((file, i) => `
      <div class="photo-thumb">
        <img src="${URL.createObjectURL(file)}" alt="preview">
        <button type="button" class="photo-remove" data-i="${i}" aria-label="Remove photo">×</button>
      </div>`).join("");
    list.querySelectorAll(".photo-remove").forEach((btn) =>
      btn.addEventListener("click", () => {
        selectedPhotos.splice(Number(btn.dataset.i), 1);
        renderPhotoPreviews();
      }));
    hint.textContent = selectedPhotos.length
      ? `${selectedPhotos.length} of ${MAX_PHOTOS} photo(s) selected.`
      : "No photos selected yet.";
  }
  document.getElementById("add-photo-btn").addEventListener("click", () =>
    document.getElementById("f-photo").click());
  document.getElementById("f-photo").addEventListener("change", (e) => {
    const incoming = Array.from(e.target.files || []);
    const room = MAX_PHOTOS - selectedPhotos.length;
    if (incoming.length > room) {
      toast(room <= 0
        ? `You already have ${MAX_PHOTOS} photos — remove one to add another.`
        : `Only ${room} more photo(s) can be added (max ${MAX_PHOTOS}).`, "error");
    }
    selectedPhotos = selectedPhotos.concat(incoming.slice(0, Math.max(room, 0)));
    e.target.value = ""; // allow re-selecting the same file later
    renderPhotoPreviews();
  });

  // ---- Submit ----
  // CURRENT device position for the submission's geofence check (separate
  // from the report's pin, which marks the facility/problem and may
  // legitimately be elsewhere) — uses the shared retrying/accuracy-aware
  // helper (see common.js getReliableLocation); the server remains the
  // actual enforcer when the geofence is active.
  async function getDeviceLocation() {
    const loc = await Balatan.getReliableLocation();
    if (loc.status !== "ok") return {};
    if (loc.lowConfidence) {
      toast(`Location signal is weak (±${loc.accuracy}m accuracy) — submitting anyway.`, "");
    }
    return { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy };
  }

  function showReportBlocked(message) {
    const btn = document.getElementById("submit-btn");
    const status = document.getElementById("report-block-status");
    status.textContent = message;
    status.style.display = "";
    // Suspended/blocked accounts cannot submit — disable the button instead
    // of leaving it clickable for a repeat attempt that will just fail again.
    btn.disabled = true;
    btn.textContent = "Report submission unavailable";
  }

  document.getElementById("report-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("submit-btn");
    if (!document.getElementById("f-barangay").value) {
      toast("Please select a barangay from the list", "error");
      document.getElementById("f-barangay-input").focus();
      return;
    }
    if (!selectedPhotos.length) {
      toast("At least one photo is required", "error");
      return;
    }
    const token = getTurnstileToken();
    if (cfg.turnstile_site_key && !token) {
      toast("Please complete the verification widget before submitting.", "error");
      return;
    }
    // Default the coordinates to the map centre if the user never set one.
    if (!document.getElementById("f-lat").value) {
      const c = marker.getLatLng();
      setCoords(c.lat, c.lng, "Approximate location");
    }
    document.getElementById("report-block-status").style.display = "none";
    let blocked = false;
    btn.disabled = true; btn.textContent = "Submitting…";
    try {
      // Duplicate detection: warn if a similar open issue was already
      // reported nearby (unless the resident chose to submit anyway).
      if (!e.target.dataset.dupChecked) {
        const q = new URLSearchParams({
          latitude: document.getElementById("f-lat").value,
          longitude: document.getElementById("f-lng").value,
          category: document.getElementById("f-category").value,
        });
        const dupes = await api("/api/reports/nearby?" + q.toString());
        if (dupes.length) {
          btn.disabled = false; btn.textContent = "Submit report";
          showDuplicateWarning(dupes);
          return;
        }
      }
      delete e.target.dataset.dupChecked;
      btn.textContent = "Checking your location…";
      const device = await getDeviceLocation();
      const fd = new FormData(e.target);
      fd.delete("photos");
      for (const file of selectedPhotos) fd.append("photos", file);
      if (token) fd.set("turnstile_token", token);
      if (device.latitude !== undefined) {
        fd.append("device_latitude", device.latitude);
        fd.append("device_longitude", device.longitude);
        fd.append("device_accuracy", device.accuracy);
      }
      btn.textContent = "Submitting…";
      const report = await rapi("/api/reports", { method: "POST", body: fd });
      toast("Report submitted! Reference: " + report.reference, "success");
      showConfirmation(report);
      e.target.reset();
      selectedPhotos = [];
      renderPhotoPreviews();
      document.getElementById("f-barangay-input").value = "";
      document.getElementById("f-staff-office-wrap").style.display = "none";
      document.querySelectorAll("#reporter-type-toggle .seg-btn").forEach((b, i) => b.classList.toggle("active", i === 0));
      document.getElementById("gps-status").textContent = "Location not set — tap \"Use my location\" or adjust the pin manually.";
    } catch (err) {
      // A suspended/blocked account gets a persistent notice instead of a
      // transient toast, so the resident isn't tempted to just retry.
      if (err.message && /suspend|blocked/i.test(err.message)) {
        showReportBlocked(err.message);
        blocked = true;
      } else {
        toast(err.message, "error");
      }
    } finally {
      resetTurnstile(); // tokens are single-use regardless of outcome
      // Leave the button disabled (with its "unavailable" message) for a
      // suspension/block response — re-enabling it would invite a retry
      // that will just fail the same way.
      if (!blocked) { btn.disabled = false; btn.textContent = "Submit Report"; }
    }
  });

  function showDuplicateWarning(dupes) {
    openModal(`
      <button class="close-x" onclick="Balatan.__closeModal()">×</button>
      <h3>Possible duplicate report</h3>
      <p class="subhead">A similar issue was already reported near this location:</p>
      <div class="report-list" style="margin-top:12px;">
        ${dupes.map((d) => `
          <div class="report-item" data-id="${d.id}">
            <div class="top"><p class="title">${esc(d.title)}</p>
              <span class="badge status-${d.status}">${statusLabel(d.status)}</span></div>
            <div class="meta">${esc(d.reference)} · ${esc(d.barangay || "Balatan")} · ~${d.distance_m} m away</div>
          </div>`).join("")}
      </div>
      <p class="hint" style="margin-top:10px;">If this is the same problem, there is no need to
        report it again — the LGU already knows about it. If yours is a different issue,
        submit anyway.</p>
      <div style="display:flex;gap:10px;margin-top:14px;">
        <button class="btn secondary" style="flex:1;" onclick="Balatan.__closeModal()">Cancel</button>
        <button class="btn" style="flex:1;" id="dup-submit-anyway">Submit anyway</button>
      </div>`);
    document.getElementById("dup-submit-anyway").addEventListener("click", () => {
      Balatan.__closeModal();
      const form = document.getElementById("report-form");
      form.dataset.dupChecked = "1";
      form.requestSubmit();
    });
    document.querySelectorAll("#detail-content .report-item").forEach((el) =>
      el.addEventListener("click", () => openDetail(el.dataset.id)));
  }

  function showConfirmation(r) {
    openModal(`
      <button class="close-x" onclick="Balatan.__closeModal()">×</button>
      <h3>Report received</h3>
      <p class="subhead">Thank you for helping improve Balatan's public facilities.</p>
      <div class="callout" style="margin-top:14px;">
        <div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);">Reference number</div>
        <div style="font-size:1.35rem;color:var(--primary);font-weight:700;letter-spacing:-0.01em;">${esc(r.reference)}</div>
      </div>
      <p class="hint" style="margin-top:12px;">Keep this number to track the status of your report under
         “Track Reports”.</p>
      <div style="margin-top:8px;">
        ${impactBadge(r.impact)}
        <span class="badge status-${r.status}">${statusLabel(r.status)}</span>
      </div>
      <button class="btn block" style="margin-top:18px;" onclick="Balatan.__closeModal()">Done</button>
    `);
  }

  // ---- Public / community reports list (with search) ----
  async function loadPublicReports(q) {
    const list = document.getElementById("public-reports");
    Balatan.showSkeleton(list, 4);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      // Deliberately anonymous: this list must never pick up a lingering
      // admin token from the same browser (see Balatan.api's anonymous
      // option) — otherwise an admin's own browser would see confirmed-fake
      // reports here that a resident/public visitor correctly never would.
      const reports = await api("/api/reports?" + params.toString(), { anonymous: true });
      if (!reports.length) { list.innerHTML = `<div class="empty">No reports found.</div>`; return; }
      list.innerHTML = reports.map(publicCard).join("");
      list.querySelectorAll(".report-item").forEach((el) =>
        el.addEventListener("click", () => openDetail(el.dataset.id)));
    } catch (err) {
      list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  function publicCard(r) {
    return `
      <div class="report-item ${r.urgency === "critical" ? "pinned" : ""}" data-id="${r.id}">
        <div class="ri-row">
          ${reportThumb(r)}
          <div class="ri-body">
            <div class="top">
              <p class="title">${esc(r.title)}</p>
              <span class="badge status-${r.status}">${statusLabel(r.status)}</span>
            </div>
            <div class="meta">
              ${esc(r.reference)} · ${esc(r.category)} · ${esc(r.barangay || "Balatan")} · ${timeAgo(r.created_at)}
            </div>
            <div class="badges">
              ${reporterBadge(r)}
              ${impactBadge(r.impact)}
              <span class="badge ${r.urgency}">${esc(r.urgency)}</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  function impactBadge(impact) {
    if (!impact) return "";
    return `<span class="badge impact-${impact.label}" title="Community Impact Index">Impact ${impact.score} · ${impact.label}</span>`;
  }

  // ---- Report detail (with mini-map + labeled sections) ----
  let detailMap = null;
  async function openDetail(id) {
    try {
      const r = await rapi("/api/reports/" + id);
      const canAffect = user && !["resolved", "fake", "not_in_scope"].includes(r.status);
      const photos = (r.photos && r.photos.length) ? r.photos.map((p) => p.photo_path)
        : (r.photo_path ? [r.photo_path] : []);
      openModal(`
        <button class="close-x" onclick="Balatan.__closeModal()">×</button>
        <h3>${esc(r.title)}</h3>
        <div class="meta" style="color:var(--muted);font-size:.85rem;">
          ${esc(r.reference)} · ${esc(r.category)} · ${esc(facilityLabel(r.facility_type))}
        </div>
        <div class="badges" style="margin:10px 0;align-items:center;">
          ${reporterBadge(r)}
          <span class="badge status-${r.status}">${statusLabel(r.status)}</span>
          <span class="badge ${r.urgency}">${esc(r.urgency)}</span>
          ${impactBadge(r.impact)}
          ${canAffect ? `
            <button class="affected-btn ${r.i_am_affected ? "on" : ""}" id="detail-affected">
              ${affectedIcon()} I am affected · <span class="cnt">${r.affected_count || 0}</span>
            </button>` : (r.affected_count ? `
            <span class="badge medium plain">${affectedIcon()} ${r.affected_count} affected</span>` : "")}
        </div>

        <h4>Description</h4>
        <p>${esc(r.description) || "<em>No description.</em>"}</p>

        <h4>Location</h4>
        <p><strong>Barangay:</strong> ${esc(r.barangay || "—")}<br>
           <strong>Address / landmark:</strong> ${esc(r.address || "—")}</p>
        ${r.latitude != null ? `<div id="detail-mini-map"></div>` : ""}

        ${photos.length ? `<h4>Photos</h4>
          <div class="photo-preview-list">${photos.map((p) =>
            `<img src="/uploads/${esc(p)}" alt="photo" style="width:120px;height:120px;">`).join("")}</div>` : ""}

        <h4>Workflow</h4>
        <p><strong>Status:</strong> ${statusLabel(r.status)}<br>
           ${r.assigned_team ? `<strong>Assigned team:</strong> ${esc(r.assigned_team)}<br>` : ""}
           <strong>Reported:</strong> ${fmtDate(r.created_at)}</p>

        <h4>Status history</h4>
        <ul class="timeline">
          ${(r.history || []).map((h) => `
            <li><strong>${statusLabel(h.status)}</strong>
              ${h.office ? `<div style="margin-top:4px;"><span class="badge medium plain">${esc(h.office)}</span>${h.reason ? ` <span class="hint" style="display:inline;">— ${esc(h.reason)}</span>` : ""}</div>` : ""}
              <div class="when">${fmtDate(h.created_at)} · ${esc(h.actor || "")}</div>
              ${h.note ? `<div>${esc(h.note)}</div>` : ""}
              ${h.photo_path ? `<img class="progress-photo" src="/uploads/${esc(h.photo_path)}" alt="progress photo">` : ""}
            </li>`).join("")}
        </ul>
      `);
      const btn = document.getElementById("detail-affected");
      if (btn) btn.addEventListener("click", () => toggleAffected(r.id, btn));
      if (r.latitude != null && document.getElementById("detail-mini-map")) {
        if (detailMap) { detailMap.remove(); detailMap = null; }
        detailMap = L.map("detail-mini-map", {
          zoomControl: false, dragging: false, scrollWheelZoom: false, attributionControl: false,
        }).setView([r.latitude, r.longitude], 15);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(detailMap);
        L.marker([r.latitude, r.longitude]).addTo(detailMap);
        setTimeout(() => detailMap.invalidateSize(), 60);
      }
    } catch (err) { toast(err.message, "error"); }
  }

  // ---- Modal plumbing ----
  function openModal(html) {
    document.getElementById("detail-content").innerHTML = html;
    document.getElementById("detail-modal").classList.add("open");
  }
  Balatan.__closeModal = () => {
    document.getElementById("detail-modal").classList.remove("open");
    if (detailMap) { detailMap.remove(); detailMap = null; }
  };
  document.getElementById("detail-modal").addEventListener("click", (e) => {
    if (e.target.id === "detail-modal") Balatan.__closeModal();
  });

  document.getElementById("track-search-btn").addEventListener("click", () =>
    loadPublicReports(document.getElementById("track-search").value.trim()));
  document.getElementById("track-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadPublicReports(e.target.value.trim());
  });

  init().catch((err) => toast("Failed to load: " + err.message, "error"));
})();
