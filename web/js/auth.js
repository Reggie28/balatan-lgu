/* Resident sign-in page: email + password login (geofenced to Balatan) and
   two-step registration with email OTP verification. On success the resident
   is sent back to the portal. */
(function () {
  const { api, toast, getReliableLocation, locationErrorMessage } = Balatan;
  const TOKEN_KEY = "balatan_resident_token";

  Balatan.registerSW();

  function authStatus(msg) {
    document.getElementById("auth-status").textContent = msg || "";
  }

  function showAuthView(which) {
    for (const id of ["auth-login", "auth-register", "auth-otp",
                      "auth-forgot", "auth-reset"]) {
      document.getElementById(id).style.display = id === which ? "" : "none";
    }
    authStatus("");
  }

  function signedIn(res) {
    localStorage.setItem(TOKEN_KEY, res.token);
    toast(`Welcome, ${res.user.name}!`, "success");
    setTimeout(() => { window.location.href = "/"; }, 400);
  }

  async function doAuth(kind, btn) {
    btn.disabled = true;
    const original = btn.textContent;
    try {
      authStatus("Checking your location…");
      btn.textContent = "Checking location…";
      const loc = await getReliableLocation();
      if (loc.status !== "ok") {
        // Still a best-effort field: the server is the actual enforcer and
        // will reply with its own message if a position is required and
        // missing. This just tells the resident *why* before that round trip.
        authStatus(locationErrorMessage(loc.status));
      } else if (loc.lowConfidence) {
        authStatus(`Location found, but signal is weak (±${loc.accuracy}m accuracy) — verifying…`);
      }
      const coords = loc.status === "ok"
        ? { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy }
        : {};
      btn.textContent = kind === "login" ? "Signing in…" : "Sending code…";
      let res;
      if (kind === "login") {
        const payload = { email: document.getElementById("login-email").value.trim(),
          password: document.getElementById("login-password").value, ...coords };
        res = await api("/api/resident/login", { method: "POST", json: payload });
      } else {
        // Registration is multipart: the Phase 3 backend requires a valid-ID
        // photo (uploadId.single("valid_id")) alongside the account fields.
        const idFile = document.getElementById("reg-valid-id").files[0];
        if (!idFile) {
          authStatus("A valid ID photo is required to register");
          toast("A valid ID photo is required to register", "error");
          btn.disabled = false;
          btn.textContent = original;
          return;
        }
        const fd = new FormData();
        fd.append("name", document.getElementById("reg-name").value.trim());
        fd.append("email", document.getElementById("reg-email").value.trim());
        fd.append("password", document.getElementById("reg-password").value);
        fd.append("contact", document.getElementById("reg-contact").value.trim());
        fd.append("barangay", document.getElementById("reg-barangay").value.trim());
        fd.append("valid_id", idFile);
        if (coords.latitude !== undefined) {
          fd.append("latitude", coords.latitude);
          fd.append("longitude", coords.longitude);
          fd.append("accuracy", coords.accuracy);
        }
        res = await api("/api/register", { method: "POST", body: fd });
      }
      if (res.otp_required) {
        // Sign-up step 2: confirm the emailed one-time passcode.
        document.getElementById("otp-email").textContent = res.email;
        document.getElementById("otp-code").value = "";
        showAuthView("auth-otp");
        document.getElementById("otp-code").focus();
        return;
      }
      signedIn(res);
    } catch (err) {
      authStatus(err.message);
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  document.getElementById("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    doAuth("login", document.getElementById("login-btn"));
  });
  document.getElementById("register-form").addEventListener("submit", (e) => {
    e.preventDefault();
    doAuth("register", document.getElementById("register-btn"));
  });

  document.getElementById("otp-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("otp-btn");
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Verifying…";
    try {
      const res = await api("/api/verify-otp", { method: "POST", json: {
        email: document.getElementById("otp-email").textContent,
        code: document.getElementById("otp-code").value.trim(),
      }});
      signedIn(res);
    } catch (err) {
      authStatus(err.message);
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
  document.getElementById("otp-resend").addEventListener("click", (e) => {
    e.preventDefault();
    showAuthView("auth-register");
    toast("Press “Create account” again to get a new code", "");
  });
  document.getElementById("otp-back").addEventListener("click", (e) => {
    e.preventDefault();
    showAuthView("auth-register");
  });
  document.getElementById("show-register").addEventListener("click", (e) => {
    e.preventDefault();
    showAuthView("auth-register");
  });
  document.getElementById("show-login").addEventListener("click", (e) => {
    e.preventDefault();
    showAuthView("auth-login");
  });

  // ---- Forgot / reset password ----
  document.getElementById("show-forgot").addEventListener("click", (e) => {
    e.preventDefault();
    showAuthView("auth-forgot");
  });
  document.getElementById("forgot-back").addEventListener("click", (e) => {
    e.preventDefault();
    showAuthView("auth-login");
  });
  document.getElementById("reset-back").addEventListener("click", (e) => {
    e.preventDefault();
    showAuthView("auth-login");
  });
  document.getElementById("forgot-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("forgot-btn");
    btn.disabled = true;
    try {
      const res = await api("/api/forgot-password", { method: "POST", json: {
        email: document.getElementById("forgot-email").value.trim(),
      }});
      document.getElementById("reset-email").textContent = res.email;
      showAuthView("auth-reset");
      document.getElementById("reset-code").focus();
    } catch (err) {
      authStatus(err.message);
      toast(err.message, "error");
    } finally { btn.disabled = false; }
  });
  document.getElementById("reset-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("reset-btn");
    btn.disabled = true;
    try {
      await api("/api/reset-password", { method: "POST", json: {
        email: document.getElementById("reset-email").textContent,
        code: document.getElementById("reset-code").value.trim(),
        new_password: document.getElementById("reset-password").value,
      }});
      toast("Password reset — sign in with your new password", "success");
      showAuthView("auth-login");
    } catch (err) {
      authStatus(err.message);
      toast(err.message, "error");
    } finally { btn.disabled = false; }
  });

  // Already signed in? Straight back to the portal.
  if (localStorage.getItem(TOKEN_KEY)) {
    api("/api/me", { headers: { Authorization:
      "Bearer " + localStorage.getItem(TOKEN_KEY) } })
      .then((me) => { if (me.role === "resident") window.location.href = "/"; })
      .catch(() => localStorage.removeItem(TOKEN_KEY));
  }
})();
