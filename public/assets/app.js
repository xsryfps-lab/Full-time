/* =============================================================
   FULL-TIME — shared shell + utilities
   Loaded by every page. Injects the sidebar/topbar so the nav
   markup lives in exactly one place, and provides small render
   helpers (dial gauge, line/bar charts, toasts, fetch wrapper)
   used across pages to avoid duplicating them per-file.
   ============================================================= */

const NAV_SECTIONS = [
  {
    label: "Predict",
    items: [
      { href: "/dashboard.html", label: "Dashboard", icon: "grid" },
      { href: "/analyze.html", label: "Match Analysis", icon: "target" },
      { href: "/parlay.html", label: "Parlay Builder", icon: "layers" },
      { href: "/live.html", label: "Live Matches", icon: "activity" },
      { href: "/history.html", label: "History", icon: "clock" },
    ],
  },
  {
    label: "Insight",
    items: [
      { href: "/statistics.html", label: "Statistics", icon: "bar-chart" },
      { href: "/models.html", label: "Model Performance", icon: "cpu" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/settings.html", label: "Settings", icon: "sliders", adminOnly: true },
      { href: "/database.html", label: "Database", icon: "database", adminOnly: true },
      { href: "/backup.html", label: "Backup & Restore", icon: "download", adminOnly: true },
      { href: "/health.html", label: "System Health", icon: "heart", adminOnly: true },
      { href: "/users.html", label: "Users & Limits", icon: "users", adminOnly: true },
      { href: "/about.html", label: "About the Engine", icon: "info" },
    ],
  },
];

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.6" fill="currentColor"/>',
  activity: '<path d="M2 12h4l2-7 4 14 2-7h8" fill="none"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  "bar-chart": '<path d="M4 20V10M12 20V4M20 20v-7"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M6 2v0"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  sliders: '<path d="M4 6h9M4 12h5M4 18h13"/><circle cx="16" cy="6" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="18" r="2"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
  download: '<path d="M12 3v13m0 0l-4-4m4 4l4-4"/><path d="M4 19h16"/>',
  heart: '<path d="M12 21s-7-4.5-9.5-9C1 8 2.5 4 6.5 4 9 4 11 5.5 12 7c1-1.5 3-3 5.5-3 4 0 5.5 4 4 8-2.5 4.5-9.5 9-9.5 9z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v0.5"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 17.5l9 5 9-5"/>',
  users: '<path d="M17 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 5 18.5V20"/><circle cx="9.5" cy="8" r="3.2"/><path d="M19 20v-1.5a3 3 0 0 0-2-2.83"/><path d="M15 4.2a3.2 3.2 0 0 1 0 6"/>',
};

function iconSvg(name, extra = "") {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICONS[name] || ""}</svg>`;
}

function currentPage() {
  return location.pathname.split("/").pop() || "dashboard.html";
}

function injectShell(pageTitle, pageSubtitle) {
  const page = currentPage();
  const navHtml = NAV_SECTIONS.map(
    (section) => `
    <div class="nav-group-label">${section.label}</div>
    ${section.items
      .map(
        (item) => `
      <a class="nav-link ${item.href.endsWith(page) ? "active" : ""}" href="${item.href}" ${item.adminOnly ? 'data-admin-only="true"' : ""}>
        ${iconSvg(item.icon)}<span>${item.label}</span>
      </a>`
      )
      .join("")}
  `
  ).join("");

  document.body.insertAdjacentHTML(
    "afterbegin",
    `
    <div class="shell">
      <div class="sidebar-scrim" id="sidebarScrim"></div>
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-brand">
          <div class="brand-dot"></div>
          <div class="brand-name">Full-Time</div>
          <div class="brand-tag">v3</div>
        </div>
        <nav class="nav-scroll">${navHtml}</nav>
        <div class="sidebar-foot">
          <div id="userBadgeSlot"></div>
          <div id="usageBadgeSlot"></div>
          <span class="status-chip" id="sidebarStatus" data-admin-only="true"><span class="pip"></span><span>Checking&hellip;</span></span>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="hamburger" id="hamburgerBtn" aria-label="Toggle navigation">${iconSvg("menu")}</button>
          <div>
            <div class="page-title">${pageTitle}</div>
            ${pageSubtitle ? `<div class="page-subtitle">${pageSubtitle}</div>` : ""}
          </div>
          <div class="topbar-spacer"></div>
          <div class="topbar-actions" id="topbarActions"></div>
        </header>
        <main class="content" id="pageContent"></main>
      </div>
    </div>
    <div class="toast-stack" id="toastStack"></div>
  `
  );

  const hamburger = document.getElementById("hamburgerBtn");
  const sidebar = document.getElementById("sidebar");
  const scrim = document.getElementById("sidebarScrim");
  const toggle = () => {
    sidebar.classList.toggle("open");
    scrim.classList.toggle("open");
  };
  hamburger.addEventListener("click", toggle);
  scrim.addEventListener("click", toggle);

  // injectShell itself stays fully synchronous (every page's script relies
  // on #pageContent existing the instant injectShell returns) — the auth
  // check runs afterward, unawaited, and patches the shell once it resolves.
  checkAuthAndUpdateShell();
}

// -----------------------------------------------------------------------
// Auth — session check, admin-only nav pruning, username/usage badges.
// Deliberately NOT part of injectShell's synchronous body (see comment
// above); every existing page's script continues to work unmodified.
// -----------------------------------------------------------------------

let CURRENT_USER = null;
function currentUser() {
  return CURRENT_USER;
}

async function checkAuthAndUpdateShell() {
  let user;
  try {
    const res = await api("/api/auth/me");
    user = res.user;
  } catch {
    location.replace("/login.html?next=" + encodeURIComponent(location.pathname));
    return;
  }
  CURRENT_USER = user;

  if (user.role !== "admin") {
    document.querySelectorAll('[data-admin-only="true"]').forEach((el) => el.remove());
  } else {
    refreshSidebarStatus();
  }

  const userBadgeSlot = document.getElementById("userBadgeSlot");
  if (userBadgeSlot) {
    userBadgeSlot.innerHTML = `
      <div class="user-badge">
        <span>${escapeHTML(user.username)}</span>
        <span class="badge ${user.role === "admin" ? "gold" : ""}" style="margin-left:6px;">${user.role}</span>
        <a href="#" id="logoutLink" class="text-sm faint" style="margin-left:10px;">Log out</a>
      </div>
    `;
    const logoutLink = document.getElementById("logoutLink");
    if (logoutLink) {
      logoutLink.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
          await api("/api/auth/logout", { method: "POST" });
        } catch {}
        location.replace("/login.html");
      });
    }
  }

  const usageBadgeSlot = document.getElementById("usageBadgeSlot");
  if (usageBadgeSlot && user.role !== "admin" && user.usageToday && user.usageToday.limit !== null) {
    usageBadgeSlot.innerHTML = `<div class="text-sm faint">Today: ${user.usageToday.used}/${user.usageToday.limit} analyses used</div>`;
  }

  window.dispatchEvent(new CustomEvent("authready", { detail: user }));
}

async function refreshSidebarStatus() {
  const el = document.getElementById("sidebarStatus");
  if (!el) return;
  try {
    const health = await api("/api/system/health");
    if (health.allProvidersConfigured) {
      el.className = "status-chip";
      el.innerHTML = `<span class="pip"></span><span>All systems ready</span>`;
    } else {
      el.className = "status-chip warn";
      el.innerHTML = `<span class="pip"></span><span>Some keys missing</span>`;
    }
  } catch {
    el.className = "status-chip bad";
    el.innerHTML = `<span class="pip"></span><span>Backend unreachable</span>`;
  }
}

/* ---------- fetch wrapper ---------- */

async function api(path, options) {
  const res = await fetch(path, options);
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = body?.error || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/* ---------- toasts ---------- */

function toast(message, type = "info") {
  const stack = document.getElementById("toastStack");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.3s";
    setTimeout(() => el.remove(), 300);
  }, 3800);
}

/* ---------- number count-up ---------- */

function animateNumber(el, target, { suffix = "", decimals = 0, duration = 700 } = {}) {
  if (target === null || target === undefined || Number.isNaN(target)) {
    el.textContent = "—";
    return;
  }
  const start = 0;
  const startTime = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const val = start + (target - start) * eased;
    el.textContent = val.toFixed(decimals) + suffix;
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ---------- Confidence Dial (signature element) ---------- */
/* A semi-circular scoreboard-style gauge, 0-100, gold->teal gradient sweep. */

function renderDial(container, value, { size = 168, label = "", colorFrom = "#e8b34d", colorTo = "#34d1b6" } = {}) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const r = size / 2 - 14;
  const cx = size / 2;
  const cy = size / 2;
  const startAngle = 180;
  const sweepAngle = 180 * (v / 100);
  const circumference = Math.PI * r;
  const gradId = "dialGrad" + Math.random().toString(36).slice(2, 8);

  const arcPath = describeArc(cx, cy, r, 180, 360);

  container.innerHTML = `
    <div class="dial-wrap">
      <div class="dial">
        <svg width="${size}" height="${size / 2 + 20}" viewBox="0 0 ${size} ${size / 2 + 20}">
          <defs>
            <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="${colorFrom}"/>
              <stop offset="100%" stop-color="${colorTo}"/>
            </linearGradient>
          </defs>
          <path class="dial-arc-bg" d="${arcPath}" fill="none" stroke-width="10"/>
          <path class="dial-arc-fill" d="${arcPath}" fill="none" stroke-width="10"
                stroke="url(#${gradId})"
                stroke-dasharray="${circumference}"
                stroke-dashoffset="${circumference}"/>
        </svg>
      </div>
      <div class="dial-value">${value === null || value === undefined ? "—" : ""}</div>
      ${label ? `<div class="dial-label">${label}</div>` : ""}
    </div>
  `;

  const fillPath = container.querySelector(".dial-arc-fill");
  const valueEl = container.querySelector(".dial-value");
  requestAnimationFrame(() => {
    fillPath.style.strokeDashoffset = String(circumference * (1 - v / 100));
  });
  if (value !== null && value !== undefined) {
    animateNumber(valueEl, value, { suffix: "%", duration: 900 });
  }
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 180) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function describeArc(cx, cy, r, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  return `M ${start.x} ${start.y} A ${r} ${r} 0 0 0 ${end.x} ${end.y}`;
}

/* ---------- small SVG line chart ---------- */

function renderLineChart(container, points, { width = 640, height = 200, color = "#e8b34d", yMin = 0, yMax = 100, formatY = (v) => v } = {}) {
  if (!points || points.length < 2) {
    container.innerHTML = `<div class="empty-state text-sm">Not enough data yet to chart a trend.</div>`;
    return;
  }
  const padL = 34, padB = 22, padT = 10, padR = 10;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const stepX = innerW / (points.length - 1);
  const scaleY = (v) => padT + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${padL + i * stepX} ${scaleY(p.value)}`).join(" ");
  const areaPath = `${path} L ${padL + (points.length - 1) * stepX} ${padT + innerH} L ${padL} ${padT + innerH} Z`;

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = padT + innerH * f;
    const val = yMax - (yMax - yMin) * f;
    return `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="var(--line)" stroke-width="1"/>
            <text x="4" y="${y + 3}" font-size="9" fill="var(--text-faint)" font-family="var(--font-mono)">${formatY(val)}</text>`;
  }).join("");

  const gradId = "lineGrad" + Math.random().toString(36).slice(2, 8);

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" style="overflow:visible">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      <path d="${areaPath}" fill="url(#${gradId})" stroke="none"/>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
  `;
}

/* ---------- small SVG bar chart ---------- */

function renderBarChart(container, bars, { width = 640, height = 200, color = "#34d1b6", yMax = 100, formatValue = (v) => `${v}%` } = {}) {
  if (!bars || !bars.length) {
    container.innerHTML = `<div class="empty-state text-sm">No data yet.</div>`;
    return;
  }
  const padL = 34, padB = 30, padT = 14, padR = 10;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const gap = 14;
  const barW = (innerW - gap * (bars.length - 1)) / bars.length;

  const barsHtml = bars.map((b, i) => {
    const x = padL + i * (barW + gap);
    const v = b.value ?? 0;
    const h = (v / yMax) * innerH;
    const y = padT + innerH - h;
    return `
      <g>
        <rect x="${x}" y="${y}" width="${barW}" height="${Math.max(2, h)}" rx="4" fill="${b.value === null ? 'var(--line)' : color}" opacity="${b.value === null ? 0.3 : 0.9}"/>
        <text x="${x + barW / 2}" y="${padT + innerH + 15}" font-size="9.5" fill="var(--text-faint)" text-anchor="middle" font-family="var(--font-mono)">${b.label}</text>
        ${b.value !== null ? `<text x="${x + barW / 2}" y="${y - 6}" font-size="10" fill="var(--text-dim)" text-anchor="middle" font-family="var(--font-mono)">${formatValue(v)}</text>` : ""}
      </g>`;
  }).join("");

  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none">${barsHtml}</svg>`;
}

/* ---------- misc formatting helpers ---------- */

function fmtPct(v, dp = 0) {
  return v === null || v === undefined ? "—" : `${v.toFixed(dp)}%`;
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function timeAgo(iso) {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
function escapeHTML(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
