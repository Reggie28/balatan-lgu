/* Shared helpers for both the resident portal and the LGU dashboard. */
window.Balatan = (function () {
  const API = "";

  async function api(path, opts = {}) {
    const headers = opts.headers || {};
    // Admin token by default; pages may pass their own Authorization header
    // (the resident portal uses a separate token). Pass anonymous:true for a
    // call that must stay genuinely public regardless of what's in
    // localStorage — e.g. a request made from an admin's own browser must
    // not silently pick up their admin token and see admin-only data.
    const token = opts.anonymous ? null : localStorage.getItem("balatan_token");
    if (token && !headers["Authorization"]) headers["Authorization"] = "Bearer " + token;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    delete opts.anonymous; // not a fetch() option
    const res = await fetch(API + path, { ...opts, headers });
    if (res.status === 204) return null;
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("application/json") ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || ("Request failed: " + res.status));
    return data;
  }

  function toast(msg, type = "") {
    let t = document.getElementById("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = "show " + type;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.className = ""), 3200);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function timeAgo(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    const days = Math.floor(h / 24);
    if (days < 30) return days + "d ago";
    return d.toLocaleDateString();
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString();
  }

  function statusLabel(s) {
    return { pending: "Pending", validation: "Validation", verified: "Verified",
      ongoing: "Ongoing", resolved: "Resolved", fake: "Fake",
      not_in_scope: "Not in Scope", unresolved: "Unresolved" }[s] || s;
  }

  function registerSW() {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () =>
        navigator.serviceWorker.register("/sw.js").catch(() => {}));
      // skipWaiting()+clients.claim() in sw.js hand control of this tab to a
      // new version immediately, but they don't replace JS already loaded in
      // memory -- a tab left open since before a deploy would otherwise keep
      // running old code (e.g. an old app.js) indefinitely. Reload once, the
      // first time a new service worker actually takes over, so a deployed
      // fix reaches already-open tabs instead of silently sitting stale.
      let reloadedForNewSW = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloadedForNewSW) return;
        reloadedForNewSW = true;
        window.location.reload();
      });
    }
  }

  // PWA install prompt handling
  let deferredPrompt = null;
  function setupInstall(bannerId) {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      const b = document.getElementById(bannerId);
      if (b) b.style.display = "block";
    });
  }
  async function triggerInstall(bannerId) {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    const b = document.getElementById(bannerId);
    if (b) b.style.display = "none";
  }

  let CONFIG = null;
  async function config() {
    if (!CONFIG) CONFIG = await api("/api/config");
    return CONFIG;
  }

  // ---- Motion helpers (all respect prefers-reduced-motion) ----
  const motionOK = () =>
    window.matchMedia("(prefers-reduced-motion: no-preference)").matches;

  /** Re-trigger the section entrance animation on a just-shown element. */
  function replayAnim(el) {
    if (!el || !motionOK()) return;
    el.classList.remove("view-anim");
    void el.offsetWidth; // restart the animation
    el.classList.add("view-anim");
  }

  /** Animate a numeric text (e.g. "27.3%", "1.2 d") counting up from 0. */
  function countUp(el, duration = 700) {
    // Hidden tabs pause requestAnimationFrame — keep the real value instead
    // of starting an animation that would freeze at 0.
    if (!motionOK() || document.hidden) return;
    const m = /^([\d.]+)(.*)$/.exec(el.textContent);
    if (!m) return;
    const target = parseFloat(m[1]);
    const suffix = m[2];
    const decimals = (m[1].split(".")[1] || "").length;
    const final = el.textContent;
    const start = performance.now();
    (function tick(now) {
      const p = Math.min(Math.max(now - start, 0) / duration, 1);
      if (p >= 1 || document.hidden) { el.textContent = final; return; }
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = (target * eased).toFixed(decimals) + suffix;
      requestAnimationFrame(tick);
    })(start);
  }

  /** Subtle 3D cursor tilt for cards (skipped on touch / reduced motion). */
  function enableTilt(el, maxDeg = 4) {
    if (!motionOK() || !window.matchMedia("(hover: hover)").matches) return;
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - r.left) / r.width - 0.5;
      const dy = (e.clientY - r.top) / r.height - 0.5;
      el.classList.add("tilting");
      el.style.transform =
        `perspective(600px) rotateX(${(-dy * maxDeg).toFixed(2)}deg)` +
        ` rotateY(${(dx * maxDeg).toFixed(2)}deg)`;
    });
    el.addEventListener("pointerleave", () => {
      el.classList.remove("tilting");
      el.style.transform = "";
    });
  }

  /** Skeleton loading placeholders (n shimmering cards) for a list element. */
  function showSkeleton(el, n = 3) {
    el.innerHTML = Array.from({ length: n }).map(() => `
      <div class="skeleton-card">
        <div class="skeleton line w60"></div>
        <div class="skeleton line w90"></div>
        <div class="skeleton line w40"></div>
      </div>`).join("");
  }

  // ---- Dark / light theme ----
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("balatan_theme", theme);
  }

  /** Wire a header button that flips between light and dark. */
  function initThemeToggle(btnId) {
    applyTheme(localStorage.getItem("balatan_theme") || "light");
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener("click", () => {
      applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    });
  }

  // ---- Reliable geolocation (shared by resident sign-in/registration and
  // report submission — the geofence-critical call sites) ----
  // A single getCurrentPosition() reading is not trustworthy on its own:
  // indoors, or on a device with no real GPS chip, the browser can fall back
  // to Wi-Fi/IP-based positioning with errors of hundreds to thousands of
  // metres. This requests one fix and, if its accuracy is poor, retries once
  // for a better one before giving up — and always reports back what
  // accuracy was actually achieved, instead of silently trusting a bad fix.
  const GEO_ACCURACY_RETRY_M = 500;   // retry once if worse than this
  const GEO_ACCURACY_LOWCONF_M = 2000; // flag as low-confidence beyond this

  function getReliableLocation() {
    if (!navigator.geolocation) return Promise.resolve({ status: "unsupported" });

    const getFix = (timeout) => new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ ok: true, pos }),
        (err) => resolve({ ok: false, err }),
        { enableHighAccuracy: true, timeout, maximumAge: 0 }
      );
    });

    return (async () => {
      const first = await getFix(12000);
      if (!first.ok) {
        const code = first.err && first.err.code;
        if (code === 1) return { status: "denied" };
        if (code === 3) return { status: "timeout" };
        return { status: "unavailable" }; // code 2, POSITION_UNAVAILABLE, or unknown
      }
      let best = first.pos;
      if (best.coords.accuracy > GEO_ACCURACY_RETRY_M) {
        const second = await getFix(8000);
        if (second.ok && second.pos.coords.accuracy < best.coords.accuracy) {
          best = second.pos;
        }
      }
      return {
        status: "ok",
        latitude: best.coords.latitude,
        longitude: best.coords.longitude,
        accuracy: Math.round(best.coords.accuracy),
        lowConfidence: best.coords.accuracy > GEO_ACCURACY_LOWCONF_M,
      };
    })();
  }

  /** Human-readable message for a getReliableLocation() failure status. */
  function locationErrorMessage(status) {
    return {
      denied: "Location permission denied — please allow location access in your browser/device settings and try again.",
      unavailable: "Couldn't determine your location — check that GPS/location services are turned on.",
      timeout: "Location request timed out — please try again.",
      unsupported: "This browser doesn't support location detection.",
    }[status] || "Couldn't determine your location.";
  }

  // ---- Notification bell (shared by the portal and the dashboard) ----
  function initBell({ bellId, panelId, tokenKey }) {
    const bell = document.getElementById(bellId);
    const panel = document.getElementById(panelId);
    if (!bell || !panel) return { refresh: () => {} };

    const authedApi = (path, opts = {}) => {
      const token = localStorage.getItem(tokenKey);
      const headers = { ...(opts.headers || {}) };
      if (token) headers["Authorization"] = "Bearer " + token;
      return api(path, { ...opts, headers });
    };

    async function refresh() {
      if (!localStorage.getItem(tokenKey)) { bell.style.display = "none"; return; }
      try {
        const data = await authedApi("/api/notifications");
        bell.style.display = "";
        const badge = bell.querySelector(".bell-badge");
        badge.textContent = data.unread > 99 ? "99+" : data.unread;
        badge.style.display = data.unread ? "" : "none";
        panel.querySelector(".notif-list").innerHTML = data.notifications.length
          ? data.notifications.map((n) => `
              <div class="notif-item ${n.is_read ? "" : "unread"}">
                <div>${esc(n.message)}</div>
                <div class="when">${timeAgo(n.created_at)}</div>
              </div>`).join("")
          : `<div class="empty" style="padding:18px;">No notifications yet.</div>`;
      } catch { bell.style.display = "none"; }
    }

    bell.addEventListener("click", async (e) => {
      e.stopPropagation();
      const open = panel.classList.toggle("open");
      if (open) {
        await authedApi("/api/notifications/read", { method: "POST" }).catch(() => {});
        refresh();
      }
    });
    document.addEventListener("click", (e) => {
      if (!panel.contains(e.target) && e.target !== bell) panel.classList.remove("open");
    });
    refresh();
    setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 30000);
    return { refresh };
  }

  return { api, toast, esc, timeAgo, fmtDate, statusLabel, registerSW,
    setupInstall, triggerInstall, config, replayAnim, countUp, enableTilt,
    showSkeleton, initThemeToggle, initBell, getReliableLocation, locationErrorMessage };
})();
