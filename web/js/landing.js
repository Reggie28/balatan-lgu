/* Animated landing page: scroll-triggered reveals. */
(function () {
  Balatan.registerSW();
  Balatan.initThemeToggle("theme-toggle");

  // Scroll-triggered reveal (IntersectionObserver; instant when reduced motion).
  const reduced = !window.matchMedia("(prefers-reduced-motion: no-preference)").matches;
  const targets = document.querySelectorAll(".reveal");
  if (reduced || !("IntersectionObserver" in window)) {
    targets.forEach((el) => el.classList.add("shown"));
  } else {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("shown");
          io.unobserve(e.target);
        }
      }
    }, { threshold: 0.15 });
    targets.forEach((el) => io.observe(el));
  }
})();
