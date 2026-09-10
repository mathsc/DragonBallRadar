/* ==========================================================================
   Dragon Radar — a GPS treasure-hunt radar.

   Plain static site: no build step, no dependencies. Everything the player
   needs is this file plus targets.txt.

   Notes worth knowing before editing:
   - Geolocation only works in a secure context: HTTPS or localhost. Opening
     index.html straight off the disk (file://) will never get a fix.
   - ?sim=lat,lon overrides the GPS entirely, for testing on a desktop.
   ========================================================================== */

'use strict';

/* ---- constants ---------------------------------------------------------- */

const M_PER_DEG_LAT = 110540;                       // local flat-earth approx
const ZOOM_LADDER = [50, 100, 250, 500, 1000, 2500, 10000]; // metres, scope radius
const AUTO_PAD = 1.12;                              // 12% breathing room
const AUTO_MIN_RANGE = 50;                          // don't zoom past this
const FOUND_RADIUS = 15;                            // metres = "you're on it"

// Grid spacing per ladder step, so the grid never turns to mush.
const GRID_SPACING = {
  50: 10, 100: 20, 250: 50, 500: 100, 1000: 200, 2500: 500, 10000: 2000,
};

// Used when targets.txt can't be fetched (e.g. file://) so the radar always
// renders something rather than an empty scope.
const FALLBACK_TARGETS = [
  { lat: 47.5596, lon: 7.5886, label: 'Rathaus', desc: '' },
  { lat: 47.5479, lon: 7.5901, label: 'Bahnhof SBB', desc: '' },
];

/* ---- state -------------------------------------------------------------- */

const scope = document.getElementById('scope');
const ctx = scope.getContext('2d');
const radarBox = document.getElementById('radar');
const stage = document.getElementById('stage');
const zoomBtn = document.getElementById('zoom');
const brand = document.getElementById('brand');
const hud = document.getElementById('hud');
const hudTarget = document.getElementById('hud-target');
const hudStatus = document.getElementById('hud-status');

let targets = [];
let me = null;              // { lat, lon, accuracy }
let zoomIndex = -1;         // -1 = AUTO, otherwise index into ZOOM_LADDER
let currentRange = 500;     // metres, resolved each frame
let status = { text: 'Waiting for GPS…', error: false };
let cssSize = 0;            // logical px width/height of the canvas
let hitAreas = [];          // where each dot landed this frame, for tapping
let selected = null;        // target whose detail sheet is open

const sheet = document.getElementById('sheet');
const sheetName = document.getElementById('sheet-name');
const sheetDesc = document.getElementById('sheet-desc');
const sheetMeta = document.getElementById('sheet-meta');
const sheetClose = document.getElementById('sheet-close');

/* ---- target list -------------------------------------------------------- */

/**
 * Parse the targets file:
 *
 *     lat, lon, label | description
 *
 * The description is optional and starts at the first "|", which is why it
 * isn't just a fourth comma-separated field — labels are allowed to contain
 * commas. Use \n inside a description for a line break.
 *
 * Malformed lines are skipped rather than thrown, so one bad row on hunt day
 * never blanks the whole radar.
 */
function parseTargets(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const bar = line.indexOf('|');
    const head = bar === -1 ? line : line.slice(0, bar);
    const desc = bar === -1 ? '' : line.slice(bar + 1).trim().replace(/\\n/g, '\n');

    const parts = head.split(',');
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;

    const label = parts.slice(2).join(',').trim();
    out.push({
      lat, lon, desc,
      label: label || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    });
  }
  return out;
}

async function loadTargets() {
  try {
    // Cache-buster: without it, a coordinate edit pushed to Pages can stay
    // invisible on a phone for minutes.
    const res = await fetch(`targets.txt?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseTargets(await res.text());
    targets = parsed.length ? parsed : FALLBACK_TARGETS;
  } catch (err) {
    console.warn('targets.txt unavailable, using fallback list:', err);
    targets = FALLBACK_TARGETS;
  }
}

/* ---- geometry ----------------------------------------------------------- */

/** Metres east/north of the player. Equirectangular — plenty for a hunt. */
function offsetMeters(target) {
  const mPerDegLon = 111320 * Math.cos(me.lat * Math.PI / 180);
  return {
    east: (target.lon - me.lon) * mPerDegLon,
    north: (target.lat - me.lat) * M_PER_DEG_LAT,
  };
}

function distanceTo(target) {
  const { east, north } = offsetMeters(target);
  return Math.hypot(east, north);
}

/** The range (scope radius in metres) for the current zoom mode. */
function resolveRange() {
  if (zoomIndex >= 0) return ZOOM_LADDER[zoomIndex];
  if (!me || !targets.length) return 500;

  const farthest = Math.max(...targets.map(distanceTo));
  return Math.max(AUTO_MIN_RANGE, farthest * AUTO_PAD);
}

/** Grid spacing in metres — exact for ladder steps, nearest step for AUTO. */
function gridSpacing(range) {
  let best = ZOOM_LADDER[0];
  for (const step of ZOOM_LADDER) {
    if (Math.abs(step - range) < Math.abs(best - range)) best = step;
  }
  return GRID_SPACING[best];
}

function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

/* ---- layout ------------------------------------------------------------- */

/** Largest square that fits the stage, then a DPR-correct canvas inside it. */
function resize() {
  // Fit the artwork's own aspect ratio (read from CSS, so swapping the frame
  // needs no code change) into the space the chrome leaves behind.
  const [aw, ah] = getComputedStyle(document.documentElement)
    .getPropertyValue('--frame-aspect').split('/').map(Number);
  const aspect = (aw > 0 && ah > 0) ? aw / ah : 1;

  // Measured against the viewport rather than #stage, because #stage now
  // takes its height from the radar — asking it would be circular.
  const bodyStyle = getComputedStyle(document.body);
  const padY = parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom);
  const availH = document.body.clientHeight - padY
                 - brand.offsetHeight - hud.offsetHeight;

  const pad = 10;   // keep the frame off the screen edges
  const width = Math.max(120, Math.min(stage.clientWidth, availH * aspect) - pad);
  radarBox.style.width = `${width}px`;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  cssSize = scope.clientWidth;
  const px = Math.round(cssSize * dpr);
  if (scope.width !== px) {
    scope.width = px;
    scope.height = px;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/* ---- drawing ------------------------------------------------------------ */

function drawGrid(cx, cy, radius, range, spacing) {
  const scale = radius / range;
  const stepPx = spacing * scale;
  if (stepPx < 4) return;

  // Offset the grid by the player's own position so it slides underneath
  // them as they walk. That drift is what sells the effect.
  let offX = 0, offY = 0;
  if (me) {
    const mPerDegLon = 111320 * Math.cos(me.lat * Math.PI / 180);
    const eastM = me.lon * mPerDegLon;
    const northM = me.lat * M_PER_DEG_LAT;
    offX = -((eastM % spacing) * scale);
    offY = (northM % spacing) * scale;
  }

  ctx.save();
  ctx.strokeStyle = 'rgba(78, 232, 142, 0.30)';
  ctx.lineWidth = 1;
  ctx.beginPath();

  // Sweep the full width once. (Mirroring around the centre instead would
  // double up lines whenever the drift offset is non-zero.)
  const reach = radius + stepPx;
  const phase = (v) => ((v % stepPx) + stepPx) % stepPx;

  for (let x = phase(offX) - reach - stepPx; x <= reach; x += stepPx) {
    ctx.moveTo(cx + x, cy - reach); ctx.lineTo(cx + x, cy + reach);
  }
  for (let y = phase(offY) - reach - stepPx; y <= reach; y += stepPx) {
    ctx.moveTo(cx - reach, cy + y); ctx.lineTo(cx + reach, cy + y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawRings(cx, cy, radius) {
  ctx.save();
  ctx.strokeStyle = 'rgba(140, 255, 190, 0.16)';
  ctx.lineWidth = 1;
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * frac, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
  ctx.stroke();
  ctx.restore();
}

function drawTargets(cx, cy, radius, range, t) {
  const scale = radius / range;
  hitAreas = [];

  for (const target of targets) {
    const { east, north } = offsetMeters(target);
    const dist = Math.hypot(east, north);

    let px = east * scale;
    let py = -north * scale;
    let clamped = false;

    // Beyond range: pin to the rim so the player still has a direction to
    // walk in, just dimmer and smaller than a real in-range contact.
    const rPx = Math.hypot(px, py);
    if (rPx > radius * 0.94) {
      const k = (radius * 0.94) / (rPx || 1);
      px *= k; py *= k;
      clamped = true;
    }

    const found = dist <= FOUND_RADIUS;
    const speed = found ? 9 : 3.2;
    const blink = 0.55 + 0.45 * Math.sin(t * speed);
    const alpha = clamped ? 0.30 + 0.20 * blink : (found ? 1 : 0.55 + 0.45 * blink);
    const size = (clamped ? 3.5 : found ? 8 : 6) * (cssSize / 340);

    const r = Math.max(2, size);
    hitAreas.push({ target, x: cx + px, y: cy + py, r });

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(255, 214, 40, 0.95)';
    ctx.shadowBlur = (found ? 26 : 14) * (cssSize / 340);
    ctx.fillStyle = found ? '#fff6b0' : '#ffd426';
    ctx.beginPath();
    ctx.arc(cx + px, cy + py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Ring the target whose details are open, so the sheet and the dot are
    // visibly the same thing.
    if (selected === target) {
      ctx.save();
      ctx.strokeStyle = '#fff6b0';
      ctx.lineWidth = Math.max(1.5, 2 * (cssSize / 340));
      ctx.beginPath();
      ctx.arc(cx + px, cy + py, r + 6 * (cssSize / 340), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function drawMe(cx, cy, radius, range, t) {
  const scale = radius / range;

  // Accuracy halo — explains to the player why the dot wanders.
  if (me.accuracy) {
    const aPx = Math.min(me.accuracy * scale, radius);
    if (aPx > 3) {
      ctx.save();
      ctx.fillStyle = 'rgba(120, 220, 255, 0.10)';
      ctx.strokeStyle = 'rgba(120, 220, 255, 0.30)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, aPx, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  const pulse = 0.7 + 0.3 * Math.sin(t * 2.4);
  const r = Math.max(2.5, 4 * (cssSize / 340));
  ctx.save();
  ctx.globalAlpha = pulse;
  ctx.shadowColor = 'rgba(180, 255, 255, 0.9)';
  ctx.shadowBlur = 14;
  ctx.fillStyle = '#e8ffff';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function draw(now) {
  const t = now / 1000;
  const size = cssSize;
  const cx = size / 2, cy = size / 2;
  const radius = size / 2;

  ctx.clearRect(0, 0, size, size);

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();

  ctx.fillStyle = '#062d16';
  ctx.fillRect(0, 0, size, size);

  currentRange = resolveRange();
  drawGrid(cx, cy, radius, currentRange, gridSpacing(currentRange));
  drawRings(cx, cy, radius);
  if (me) {
    drawTargets(cx, cy, radius, currentRange, t);
    drawMe(cx, cy, radius, currentRange, t);
  }

  ctx.restore();
}

/* ---- readout ------------------------------------------------------------ */

function updateHud() {
  // Resolve here too, so the label never lags a frame behind (e.g. right
  // after targets.txt loads).
  currentRange = resolveRange();

  zoomBtn.textContent = zoomIndex >= 0
    ? formatDistance(ZOOM_LADDER[zoomIndex])
    : `AUTO · ${formatDistance(currentRange)}`;

  if (me && targets.length) {
    let nearest = targets[0], best = Infinity;
    for (const target of targets) {
      const d = distanceTo(target);
      if (d < best) { best = d; nearest = target; }
    }
    hudTarget.textContent = best <= FOUND_RADIUS
      ? `◉ ${nearest.label} — HERE`
      : `${nearest.label} · ${formatDistance(best)}`;
  } else if (targets.length) {
    hudTarget.textContent = `${targets.length} target${targets.length > 1 ? 's' : ''} loaded`;
  }

  hudStatus.textContent = status.text;
  hudStatus.classList.toggle('error', status.error);

  refreshSheetMeta();
}

/* ---- target detail sheet ------------------------------------------------ */

function openSheet(target) {
  selected = target;
  sheetName.textContent = target.label;

  const hasDesc = Boolean(target.desc);
  sheetDesc.textContent = hasDesc ? target.desc : 'No description for this target.';
  sheetDesc.classList.toggle('empty', !hasDesc);

  refreshSheetMeta();
  sheet.hidden = false;
  sheetClose.focus();
}

function closeSheet() {
  selected = null;
  sheet.hidden = true;
}

/** Distance keeps ticking down while the sheet is open and you walk. */
function refreshSheetMeta() {
  if (!selected) return;
  const coords = `${selected.lat.toFixed(5)}, ${selected.lon.toFixed(5)}`;
  sheetMeta.innerHTML = me
    ? `<b>${formatDistance(distanceTo(selected))}</b> away · ${coords}`
    : `${coords} · waiting for GPS`;
}

/**
 * Which dot did the player tap? Uses the positions recorded by the last
 * frame, with a generous radius — dots are small and fingers are not.
 */
function targetAt(x, y) {
  let best = null, bestDist = Infinity;
  for (const hit of hitAreas) {
    const d = Math.hypot(hit.x - x, hit.y - y);
    const reach = Math.max(hit.r + 16, 22);
    if (d <= reach && d < bestDist) { best = hit.target; bestDist = d; }
  }
  return best;
}

scope.addEventListener('click', (ev) => {
  const rect = scope.getBoundingClientRect();
  // Guard against the canvas being scaled by CSS relative to its drawing box.
  const k = cssSize / (rect.width || cssSize);
  const target = targetAt((ev.clientX - rect.left) * k, (ev.clientY - rect.top) * k);
  if (target) openSheet(target);
});

sheetClose.addEventListener('click', closeSheet);

// Tapping the dimmed backdrop closes; tapping the card itself must not.
sheet.addEventListener('click', (ev) => {
  if (ev.target === sheet) closeSheet();
});

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !sheet.hidden) closeSheet();
});

/* ---- geolocation -------------------------------------------------------- */

function startTracking() {
  // ?sim=lat,lon — pin the position for desktop testing / previewing a hunt.
  const sim = new URLSearchParams(location.search).get('sim');
  if (sim) {
    const [lat, lon] = sim.split(',').map(Number);
    if (isFinite(lat) && isFinite(lon)) {
      me = { lat, lon, accuracy: 5 };
      status = { text: `SIMULATED · ${lat.toFixed(5)}, ${lon.toFixed(5)}`, error: false };
      return;
    }
  }

  if (!navigator.geolocation) {
    status = { text: 'This browser has no GPS support.', error: true };
    return;
  }

  navigator.geolocation.watchPosition(
    (pos) => {
      me = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      status = { text: `GPS live · ±${Math.round(me.accuracy)} m`, error: false };
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        status = { text: 'Location blocked — allow it in your browser settings.', error: true };
      } else if (err.code === err.TIMEOUT) {
        status = { text: 'GPS is slow — step outside and wait…', error: true };
      } else {
        status = { text: 'No GPS fix. Needs HTTPS and location on.', error: true };
      }
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

/* ---- wiring ------------------------------------------------------------- */

// AUTO -> 50 m -> ... -> 2500 m -> AUTO. Not persisted: every fresh load
// starts in AUTO, which is what you want on hunt day.
zoomBtn.addEventListener('click', () => {
  zoomIndex = zoomIndex + 1 >= ZOOM_LADDER.length ? -1 : zoomIndex + 1;
  updateHud();
});

window.addEventListener('resize', resize);
// Re-measure once fonts/layout settle, so the first sizing isn't off.
window.addEventListener('load', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 150));

function frame(now) {
  draw(now);
  requestAnimationFrame(frame);
}

resize();
startTracking();
loadTargets().then(updateHud);
setInterval(updateHud, 250);
requestAnimationFrame(frame);
