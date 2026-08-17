/* Brix and Bros — canvas rendering: textured terrain, Bros, vacuums, effects */
(function () {
  const G = (globalThis.G = globalThis.G || {});
  const TAU = Math.PI * 2;

  /* ---------- utils ---------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Memoised because the answer is a constant and the question is asked ~450
     times a frame — once per tint, per character, per frame — which is 700-odd
     throwaway strings a frame purely for the garbage collector to clean up. The
     inputs are a fixed palette crossed with a handful of small offsets, so the
     table stops growing almost immediately. */
  const shadeCache = new Map();
  function shade(hex, amt) {
    const key = hex + '|' + amt;
    const hit = shadeCache.get(key);
    if (hit !== undefined) return hit;
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, (n >> 16) + amt));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amt));
    const b = Math.max(0, Math.min(255, (n & 0xff) + amt));
    const out = `rgb(${r},${g},${b})`;
    shadeCache.set(key, out);
    return out;
  }

  /* A soft round glow, drawn once and kept. The crystal and torch glows sit at
     fixed positions with fixed radii and only their opacity moves, but each one
     was building a fresh radial gradient every frame — on a cavern level that is
     15 gradient objects and 15 large gradient-filled arcs per frame, 900 objects
     a second, and it measured as a 60% increase on the cost of an otherwise
     empty frame. Blitting a sprite at a varying globalAlpha is the same picture. */
  const glowCache = new Map();
  function glowSprite(radius, inner, rgb) {
    const key = radius + '|' + inner + '|' + rgb;
    const hit = glowCache.get(key);
    if (hit) return hit;
    const cv = document.createElement('canvas');
    cv.width = cv.height = radius * 2;
    const c = cv.getContext('2d');
    const gr = c.createRadialGradient(radius, radius, inner, radius, radius, radius);
    gr.addColorStop(0, `rgba(${rgb},1)`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    c.fillStyle = gr;
    c.beginPath(); c.arc(radius, radius, radius, 0, TAU); c.fill();
    glowCache.set(key, cv);
    return cv;
  }

  /* ---------- sprite sheets ----------
     A vacuum is forty-odd fills and strokes of vector art, and a late
     endless wave fields ninety of them at once. Rebuilt from scratch sixty
     times a second, that measured as 26ms of a 33ms frame — the CPU never got
     a moment off, which is exactly what a phone battery notices. Two thirds of
     an hour on a level 2 run and 11% of the battery was gone.

     But the animal is the SAME PICTURE every frame. What changes is where it
     is, which way it points, and the handful of parts that genuinely move. So
     the still half is painted once into an offscreen canvas — one per (type,
     stealth state, freckle pattern) — and blitted from then on; only the tail,
     the flipper and the glows are still drawn by hand.

     Baked at the device's own pixel scale, so the blit is 1:1 and the picture
     is exactly as crisp as the vector art was. The scale is re-read at the top
     of every frame and the sheets are thrown away when it really moves — a
     resize, a rotation, entering fullscreen. */
  const spriteCache = new Map();
  let spriteScale = 0;
  let spritePixels = 0;      // what the cache is holding, in device pixels

  function syncSpriteScale(ctx) {
    let s = 1;
    if (ctx.getTransform) { const m = ctx.getTransform(); s = Math.abs(m.a) || 1; }
    /* Quantised to eighths. A ResizeObserver tick can move the real scale by a
       thousandth, and rebuilding every sheet for a difference nobody can see
       is the exact cost this cache exists to avoid. */
    const q = Math.max(0.5, Math.min(3, Math.round(s * 8) / 8));
    if (q !== spriteScale) { spriteScale = q; spriteCache.clear(); spritePixels = 0; }
  }

  /* A board is at most a few dozen Bros and a dozen species of vacuum,
     two sheets apiece — but a hundred waves upgrade through a lot of tier
     combinations, and each one they leave behind is a bitmap nothing will look
     at again. So the sheets in use are kept and the abandoned ones are dropped:
     a Map iterates in insertion order and a hit re-inserts, which makes the
     front of it exactly the sheets nothing has drawn for the longest.

     Budgeted in PIXELS, not in sheets. It was a count, 320, and a count cannot
     size this: a pip row is 30x10 and a MEGAVAC is 300x170, and under a
     count they take one slot each. What made that bite was adding the pip,
     tail, flipper and pile sheets — small ones, but about ninety more entries,
     which pushed a heavy board's working set past 320. Past it, the cache
     evicts sheets it will need again LATER IN THE SAME FRAME, so it rebuilds
     nearly three hundred canvases every frame, forever, and the optimisation
     costs more than the drawing it replaced. It fails off a cliff rather than
     degrading: measured at 100 towers it was zero rebuilds a frame, and at 110
     it was 292.

     A pixel budget cannot be wrong in that way, because it is measuring the
     thing that actually costs. Eight million device pixels is about 32MB and
     roughly two and a half screens' worth; the largest board the placement
     rules allow — 288 towers on the roomiest map, every species alive — works
     out at about 5.5 million, so there is real headroom rather than a number
     that happened to fit the board it was tested on. */
  const SPRITE_PIXELS = 8e6;

  /* `pad` is [left, right, top, bottom] around the origin, in the units the
     paint callback draws in. The callback gets a context already centred on
     that origin and scaled to device pixels, so it can be lifted verbatim out
     of the code that used to draw straight to the screen. */
  function sprite(key, pad, paint) {
    const hit = spriteCache.get(key);
    if (hit) {
      spriteCache.delete(key);
      spriteCache.set(key, hit);
      return hit;
    }
    const s = spriteScale || 1;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil((pad[0] + pad[1]) * s));
    cv.height = Math.max(1, Math.ceil((pad[2] + pad[3]) * s));
    const c = cv.getContext('2d');
    c.setTransform(s, 0, 0, s, pad[0] * s, pad[2] * s);
    paint(c);
    const px = cv.width * cv.height;
    const sp = { cv, x: -pad[0], y: -pad[2], w: cv.width / s, h: cv.height / s, px };
    /* Drop the oldest until the newcomer fits. Never the newcomer itself — it
       is about to be drawn — so a single sheet larger than the whole budget
       leaves the cache holding just that one rather than an empty map it
       refills every frame. */
    while (spritePixels + px > SPRITE_PIXELS && spriteCache.size) {
      const oldest = spriteCache.keys().next().value;
      spritePixels -= spriteCache.get(oldest).px;
      spriteCache.delete(oldest);
    }
    spritePixels += px;
    spriteCache.set(key, sp);
    return sp;
  }

  function blitSprite(ctx, sp) { ctx.drawImage(sp.cv, sp.x, sp.y, sp.w, sp.h); }

  let noiseTile = null;
  function getNoiseTile() {
    if (noiseTile) return noiseTile;
    noiseTile = document.createElement('canvas');
    noiseTile.width = noiseTile.height = 96;
    const c = noiseTile.getContext('2d');
    const rnd = mulberry32(1234567);
    for (let i = 0; i < 1500; i++) {
      const v = 120 + rnd() * 135 | 0;
      c.fillStyle = `rgba(${v},${v},${v},${0.5 + rnd() * 0.5})`;
      c.fillRect(rnd() * 96, rnd() * 96, 1.4, 1.4);
    }
    return noiseTile;
  }

  /* ---------- snowfall ---------- */
  const flakes = [];
  for (let i = 0; i < 42; i++) {
    // stored normalised (0-1) so the same flakes cover any tier's map size
    flakes.push({ fx: Math.random(), fy: Math.random(), r: 1 + Math.random() * 2, s: 12 + Math.random() * 25, drift: Math.random() * TAU });
  }
  /* Forty-two dots in one colour at one opacity, and they were forty-two
     separate rasterisations a frame — the same bill on a wave 1 board as on a
     wave 100 one, which is the sort of cost that never shows up in a profile
     because it never changes. One path, one fill. The moveTo before each arc
     matters: without it the subpaths are joined by lines and the snow becomes
     a cat's cradle. */
  function drawSnowfall(ctx, t) {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    for (const f of flakes) {
      const y = (f.fy * G.H + t * f.s) % G.H;
      const x = f.fx * G.W + Math.sin(t + f.drift) * 15;
      ctx.moveTo(x + f.r, y);
      ctx.arc(x, y, f.r, 0, TAU);
    }
    ctx.fill();
  }

  /* ========================================================
     TERRAIN — static map art, painted once per level
     ======================================================== */
  const terrCache = new Map(); // `${levelId}@${w}` -> {canvas, meta}

  function waterHit(level, x, y, pad) {
    pad = pad || 0;
    for (const w of level.water) {
      if (w.rect) {
        if (x >= w.rect.x - pad && x <= w.rect.x + w.rect.w + pad && y >= w.rect.y - pad && y <= w.rect.y + w.rect.h + pad) return true;
      } else if ((x - w.x) ** 2 + (y - w.y) ** 2 <= (w.r + pad) ** 2) return true;
    }
    return false;
  }

  function pathDistOk(paths, x, y, min) {
    for (const pts of paths) {
      for (let i = 0; i < pts.length - 1; i++) {
        const ax = pts[i].x, ay = pts[i].y;
        const dx = pts[i + 1].x - ax, dy = pts[i + 1].y - ay;
        const len2 = dx * dx + dy * dy;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        const px = ax + dx * t, py = ay + dy * t;
        if ((x - px) ** 2 + (y - py) ** 2 < min * min) return false;
      }
    }
    return true;
  }

  /* `flooded` builds the same battlefield with its tracks running as water —
     the heavy tide of deep endless. It is a separate cache entry, so the swap
     costs one re-render the first time the tide comes in and nothing after. */
  function getTerrain(level, w, flooded) {
    const key = level.id + '@' + w + (flooded ? '@sea' : '');
    let t = terrCache.get(key);
    if (!t) {
      t = buildTerrain(level, w, Math.round(w * G.H / G.W), flooded);
      /* Two entries, oldest out. Each of these is a full-size canvas — 3.9MB on
         a tier 1 battlefield, 5.6MB on tier 3 — and nothing ever evicted them,
         so playing through a tier without reloading accumulated 40-60MB of
         bitmaps the game would never look at again. Two is what a live battle
         actually needs: the battlefield, and its flooded twin when the heavy tide
         comes in. Anything beyond that is a level you have left. */
      while (terrCache.size >= 2) terrCache.delete(terrCache.keys().next().value);
      terrCache.set(key, t);
    }
    return t;
  }

  function buildTerrain(level, w, h, flooded) {
    const cvs = document.createElement('canvas');
    cvs.width = w; cvs.height = h;
    const c = cvs.getContext('2d');
    const s = w / G.W;
    c.save();
    c.scale(s, s);
    const th = level.theme;
    const rnd = mulberry32(910 + G.LEVELS.indexOf(level) * 7717);
    const meta = { torches: [], crystals: [] };

    // --- base snowfield ---
    const bg = c.createLinearGradient(0, 0, 0, G.H);
    bg.addColorStop(0, th.snow);
    bg.addColorStop(1, th.ice);
    c.fillStyle = bg;
    c.fillRect(0, 0, G.W, G.H);

    // low sun from the top-left: warm light there, cool blue toward bottom-right
    // (dark caverns get pale moonlight instead of sun)
    const dk = !!th.dark;
    const sun = c.createLinearGradient(0, 0, G.W, G.H);
    sun.addColorStop(0, dk ? 'rgba(196,214,255,0.12)' : 'rgba(255,244,214,0.30)');
    sun.addColorStop(0.45, 'rgba(255,244,214,0)');
    sun.addColorStop(1, dk ? 'rgba(10,16,40,0.22)' : 'rgba(58,92,160,0.16)');
    c.fillStyle = sun;
    c.fillRect(0, 0, G.W, G.H);

    // big wind-carved ice plates: subtle tone shifts with a crisp lit edge
    for (let i = 0; i < 7; i++) {
      const px = rnd() * G.W, py = rnd() * G.H;
      const pr = 130 + rnd() * 240;
      const pts = [];
      const n = 7 + (rnd() * 4 | 0);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU;
        const rr = pr * (0.6 + rnd() * 0.5);
        pts.push([px + Math.cos(a) * rr, py + Math.sin(a) * rr * 0.7]);
      }
      const plate = () => {
        c.beginPath();
        c.moveTo((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
        for (let k = 1; k <= n; k++) {
          const [ax, ay] = pts[k % n], [bx, by] = pts[(k + 1) % n];
          c.quadraticCurveTo(ax, ay, (ax + bx) / 2, (ay + by) / 2);
        }
        c.closePath();
      };
      c.fillStyle = rnd() > 0.5
        ? (dk ? 'rgba(215,225,255,0.08)' : 'rgba(255,255,255,0.22)')
        : (dk ? 'rgba(10,18,48,0.14)' : 'rgba(96,132,186,0.10)');
      plate(); c.fill();
      c.save();
      c.translate(0, -2);
      c.strokeStyle = dk ? 'rgba(215,225,255,0.14)' : 'rgba(255,255,255,0.35)'; c.lineWidth = 1.4;
      plate(); c.stroke();
      c.restore();
    }

    // rolling drifts: soft light/shadow lobes sculpt the surface
    for (let i = 0; i < 30; i++) {
      const x = rnd() * G.W, y = rnd() * G.H;
      const rx = 90 + rnd() * 200, ry = 26 + rnd() * 60;
      const ang = (rnd() - 0.5) * 0.8;
      const light = rnd() > 0.45;
      const gr = c.createRadialGradient(0, 0, 4, 0, 0, rx);
      gr.addColorStop(0, light
        ? (dk ? 'rgba(210,222,255,0.16)' : 'rgba(255,255,255,0.42)')
        : (dk ? 'rgba(8,14,40,0.24)' : 'rgba(76,112,168,0.22)'));
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      c.save();
      c.translate(x, y); c.rotate(ang); c.scale(1, ry / rx);
      c.fillStyle = gr;
      c.beginPath(); c.arc(0, 0, rx, 0, TAU); c.fill();
      c.restore();
    }

    // ice cracks
    c.strokeStyle = th.props === 'crystals' ? 'rgba(140,190,240,0.16)' : 'rgba(70,110,160,0.10)';
    c.lineWidth = 1.3;
    for (let i = 0; i < 9; i++) {
      let x = rnd() * G.W, y = rnd() * G.H;
      c.beginPath(); c.moveTo(x, y);
      const segs = 3 + (rnd() * 4 | 0);
      let ang = rnd() * TAU;
      for (let sgi = 0; sgi < segs; sgi++) {
        ang += (rnd() - 0.5) * 1.2;
        const len = 26 + rnd() * 60;
        x += Math.cos(ang) * len; y += Math.sin(ang) * len;
        c.lineTo(x, y);
        if (rnd() > 0.65) { // branch
          const bx = x + Math.cos(ang + 0.9) * 22, by = y + Math.sin(ang + 0.9) * 22;
          c.moveTo(x, y); c.lineTo(bx, by); c.moveTo(x, y);
        }
      }
      c.stroke();
    }

    // sparse ground bricks
    for (let i = 0; i < 46; i++) {
      const x = rnd() * G.W, y = rnd() * G.H;
      c.fillStyle = `rgba(110,125,140,${0.10 + rnd() * 0.12})`;
      c.beginPath(); c.ellipse(x, y, 1.5 + rnd() * 2.6, 1 + rnd() * 1.8, rnd() * 3, 0, TAU); c.fill();
    }

    // --- water ---
    for (const wt of level.water) drawWaterBody(c, wt, th, rnd);

    // --- path(s) ---
    for (const pts of level.paths) {
      if (flooded) drawPathFlooded(c, pts, th, rnd);
      else drawPathTextured(c, pts, th, rnd);
    }

    // entrance arrows
    for (const pts of level.paths) {
      const p = pathPoint(pts, 8);
      c.save();
      c.translate(p.x, p.y); c.rotate(p.ang);
      c.fillStyle = 'rgba(205,70,70,0.85)';
      c.beginPath(); c.moveTo(18, 0); c.lineTo(-6, -12); c.lineTo(-6, 12); c.closePath(); c.fill();
      c.restore();
    }

    // home fort
    const pts0 = level.paths[0];
    const end = pts0[pts0.length - 1];
    drawFort(c, Math.min(G.W - 44, Math.max(44, end.x)), Math.min(G.H - 40, Math.max(40, end.y)), 36, true);

    // blockers
    for (const b of level.blockers) {
      drawBlocker(c, b);
      if (b.kind === 'crystal') meta.crystals.push({ x: b.x, y: b.y, r: b.r });
    }

    // --- scenery props ---
    scatterProps(c, level, rnd, meta);

    // --- film grain + vignette ---
    c.restore(); // back to device pixels
    c.save();
    c.globalCompositeOperation = 'soft-light';
    c.globalAlpha = 0.4;
    c.fillStyle = c.createPattern(getNoiseTile(), 'repeat');
    c.fillRect(0, 0, w, h);
    c.restore();
    const vig = c.createRadialGradient(w / 2, h / 2, h * 0.42, w / 2, h / 2, w * 0.7);
    vig.addColorStop(0, 'rgba(20,35,60,0)');
    vig.addColorStop(1, th.props === 'crystals' ? 'rgba(8,12,30,0.42)' : 'rgba(20,35,60,0.24)');
    c.fillStyle = vig;
    c.fillRect(0, 0, w, h);

    return { canvas: cvs, meta };
  }

  function pathPoint(pts, d) {
    let rem = d;
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
      const len = Math.hypot(dx, dy);
      if (rem <= len) return { x: pts[i].x + (dx / len) * rem, y: pts[i].y + (dy / len) * rem, ang: Math.atan2(dy, dx) };
      rem -= len;
    }
    const dx = pts[pts.length - 1].x - pts[pts.length - 2].x, dy = pts[pts.length - 1].y - pts[pts.length - 2].y;
    return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, ang: Math.atan2(dy, dx) };
  }
  function pathLength(pts) {
    let L = 0;
    for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    return L;
  }

  function drawWaterBody(c, wt, th, rnd) {
    const deep = th.deep || '#2e6da4';
    const shore = th.shore || '#bfe0ea';
    if (wt.rect) {
      const { x, y, w, h } = wt.rect;
      const ph1 = rnd() * TAU, ph2 = rnd() * TAU;
      const topY = (xx) => y + Math.sin(xx * 0.045 + ph1) * 5;
      const botY = (xx) => y + h + Math.sin(xx * 0.05 + ph2) * 5;
      // one closed river shape with gently waving banks; pad also widens the
      // ends so mid-map pools keep their shore band on all four sides
      const river = (pad) => {
        c.beginPath();
        c.moveTo(x - pad, topY(x) - pad);
        for (let xx = x + 20; xx <= x + w; xx += 20) c.lineTo(xx, topY(xx) - pad);
        c.lineTo(x + w + pad, topY(x + w) - pad);
        c.lineTo(x + w + pad, botY(x + w) + pad);
        for (let xx = x + w - 20; xx >= x; xx -= 20) c.lineTo(xx, botY(xx) + pad);
        c.lineTo(x - pad, botY(x) + pad);
        c.closePath();
      };
      // shore halo with a crisp dark contour
      c.fillStyle = shore;
      river(9); c.fill();
      c.strokeStyle = 'rgba(20,42,72,0.35)'; c.lineWidth = 2.5;
      c.stroke();
      const gr = c.createLinearGradient(0, y, 0, y + h);
      gr.addColorStop(0, shade(deep, 55));
      gr.addColorStop(0.5, deep);
      gr.addColorStop(1, shade(deep, 25));
      c.fillStyle = gr;
      river(0); c.fill();
      // static current lines
      c.strokeStyle = 'rgba(255,255,255,0.18)';
      c.lineWidth = 1.5;
      for (let i = 0; i < 6; i++) {
        const yy = y + 14 + (h - 28) * (i / 5);
        c.beginPath();
        for (let xx = x; xx <= x + w; xx += 46) {
          const dy = Math.sin(xx * 0.05 + i * 2.2) * 3;
          if (xx === x) c.moveTo(xx, yy + dy); else c.lineTo(xx, yy + dy);
        }
        c.stroke();
      }
      // recessed bank: dark inner shadow along the top, light lip along the bottom
      c.strokeStyle = 'rgba(15,35,60,0.35)';
      c.lineWidth = 5;
      c.beginPath();
      for (let xx = x; xx <= x + w; xx += 20) { const yy = topY(xx) + 4; xx === x ? c.moveTo(xx, yy) : c.lineTo(xx, yy); }
      c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.4)';
      c.lineWidth = 2.5;
      c.beginPath();
      for (let xx = x; xx <= x + w; xx += 20) { const yy = botY(xx) + 10; xx === x ? c.moveTo(xx, yy) : c.lineTo(xx, yy); }
      c.stroke();
      // foam hugging both banks
      c.strokeStyle = 'rgba(255,255,255,0.6)';
      c.lineWidth = 2;
      c.setLineDash([8, 10]);
      c.beginPath();
      for (let xx = x; xx <= x + w; xx += 20) { const yy = topY(xx) + 2; xx === x ? c.moveTo(xx, yy) : c.lineTo(xx, yy); }
      c.stroke();
      c.beginPath();
      for (let xx = x; xx <= x + w; xx += 20) { const yy = botY(xx) - 2; xx === x ? c.moveTo(xx, yy) : c.lineTo(xx, yy); }
      c.stroke();
      c.setLineDash([]);
      // floes
      for (let i = 0; i < Math.max(2, w / 400 | 0); i++) drawFloe(c, x + 40 + rnd() * (w - 80), y + 18 + rnd() * (h - 36), 10 + rnd() * 14, rnd);
    } else {
      // shore ring with a crisp dark contour
      c.fillStyle = shore;
      c.beginPath(); c.arc(wt.x, wt.y, wt.r + 8, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(20,42,72,0.35)'; c.lineWidth = 2.5;
      c.stroke();
      // shallow bright rim, deep vivid centre
      const gr = c.createRadialGradient(wt.x, wt.y, wt.r * 0.1, wt.x, wt.y, wt.r);
      gr.addColorStop(0, shade(deep, -18));
      gr.addColorStop(0.55, deep);
      gr.addColorStop(0.9, shade(deep, 48));
      gr.addColorStop(1, shade(deep, 72));
      c.fillStyle = gr;
      c.beginPath(); c.arc(wt.x, wt.y, wt.r, 0, TAU); c.fill();
      // recessed basin: dark crescent up top, light lip at the bottom
      c.strokeStyle = 'rgba(15,35,60,0.35)';
      c.lineWidth = 6;
      c.beginPath(); c.arc(wt.x, wt.y + 2, wt.r - 3, Math.PI * 1.1, Math.PI * 1.9); c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.45)';
      c.lineWidth = 2.5;
      c.beginPath(); c.arc(wt.x, wt.y, wt.r + 8, Math.PI * 0.15, Math.PI * 0.85); c.stroke();
      // foam ring
      c.strokeStyle = 'rgba(255,255,255,0.6)';
      c.lineWidth = 2;
      c.setLineDash([7, 9]);
      c.beginPath(); c.arc(wt.x, wt.y, wt.r - 3, 0, TAU); c.stroke();
      c.setLineDash([]);
      // sun glitter across the middle
      c.fillStyle = 'rgba(255,255,255,0.35)';
      for (let i = 0; i < 9; i++) {
        const a = rnd() * TAU, rr = rnd() * wt.r * 0.55;
        c.beginPath();
        c.ellipse(wt.x + Math.cos(a) * rr, wt.y + Math.sin(a) * rr * 0.8, 2.4 + rnd() * 2.6, 1 + rnd(), 0, 0, TAU);
        c.fill();
      }
      if (wt.r > 78) {
        drawFloe(c, wt.x - wt.r * 0.35, wt.y + wt.r * 0.3, wt.r * 0.16, rnd);
        drawFloe(c, wt.x + wt.r * 0.42, wt.y - wt.r * 0.28, wt.r * 0.13, rnd);
      }
    }
  }

  function drawFloe(c, x, y, r, rnd) {
    c.save();
    c.translate(x, y);
    c.rotate(rnd() * TAU);
    c.fillStyle = 'rgba(235,245,252,0.92)';
    c.beginPath();
    const n = 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const rr = r * (0.75 + rnd() * 0.4);
      const px = Math.cos(a) * rr, py = Math.sin(a) * rr * 0.75;
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.closePath(); c.fill();
    c.fillStyle = 'rgba(160,195,225,0.5)';
    c.beginPath(); c.ellipse(0, r * 0.28, r * 0.7, r * 0.2, 0, 0, TAU); c.fill();
    c.restore();
  }

  /* The track as a channel of seawater. Same palette and the same deep→shallow
     gradient the pools use (th.deep / th.shore), so a flooded path and a pond
     read as one body of water. Geometry is untouched: identical width, identical
     centreline — only the paint changes, so nothing about placement moves. */
  function drawPathFlooded(c, pts, th, rnd) {
    const deep = th.deep || '#2e6da4';
    const shore = th.shore || '#bfe0ea';
    const trace = () => {
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) c.lineTo(p.x, p.y);
    };
    c.lineJoin = 'round'; c.lineCap = 'round';

    // wet sand halo, then the crisp dark contour the pools carry
    trace(); c.strokeStyle = shore; c.lineWidth = G.PATH_HALF * 2 + 11; c.stroke();
    trace(); c.strokeStyle = 'rgba(20,42,72,0.38)'; c.lineWidth = G.PATH_HALF * 2 + 13; c.stroke();
    trace(); c.strokeStyle = shore; c.lineWidth = G.PATH_HALF * 2 + 8; c.stroke();

    // the water itself — vertical gradient, exactly as drawWaterBody mixes it
    const gr = c.createLinearGradient(0, 0, 0, G.H);
    gr.addColorStop(0, shade(deep, 55));
    gr.addColorStop(0.5, deep);
    gr.addColorStop(1, shade(deep, 25));
    trace(); c.strokeStyle = gr; c.lineWidth = G.PATH_HALF * 2 + 2; c.stroke();

    // recessed bank: dark inner shadow just inside the edge
    c.save();
    c.globalAlpha = 0.5;
    trace(); c.strokeStyle = 'rgba(12,30,54,0.55)'; c.lineWidth = G.PATH_HALF * 2 + 2; c.stroke();
    c.restore();
    trace(); c.strokeStyle = gr; c.lineWidth = G.PATH_HALF * 2 - 7; c.stroke();

    const total = pathLength(pts);

    // current lines running with the channel, and a few drifting ice chips
    c.strokeStyle = 'rgba(255,255,255,0.16)';
    c.lineWidth = 1.5;
    for (const off of [-9, 0, 9]) {
      c.beginPath();
      for (let d = 6; d < total; d += 15) {
        const p = pathPoint(pts, d);
        const nx = Math.cos(p.ang + Math.PI / 2), ny = Math.sin(p.ang + Math.PI / 2);
        const wob = Math.sin(d * 0.055 + off) * 3;
        const x = p.x + nx * (off + wob), y = p.y + ny * (off + wob);
        d === 6 ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      c.stroke();
    }
    for (let d = 20; d < total; d += 60 + rnd() * 90) {
      const p = pathPoint(pts, d);
      const nx = Math.cos(p.ang + Math.PI / 2), ny = Math.sin(p.ang + Math.PI / 2);
      const off = (rnd() - 0.5) * (G.PATH_HALF - 6);
      const x = p.x + nx * off, y = p.y + ny * off;
      const r = 2.5 + rnd() * 3.5;
      c.fillStyle = 'rgba(226,242,252,0.75)';
      c.beginPath(); c.ellipse(x, y, r, r * 0.62, rnd() * TAU, 0, TAU); c.fill();
    }
  }

  function drawPathTextured(c, pts, th, rnd) {
    const trace = () => {
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) c.lineTo(p.x, p.y);
    };
    c.lineJoin = 'round'; c.lineCap = 'round';

    // soft drop shadow (light from top-left → shadow falls down-right)
    c.save();
    c.translate(3, 6);
    trace();
    c.strokeStyle = 'rgba(40,60,90,0.16)';
    c.lineWidth = G.PATH_HALF * 2 + 10;
    c.stroke();
    c.restore();

    // crisp dark contour ring so the track pops off the snow
    trace(); c.strokeStyle = shade(th.pathEdge || '#b0a284', -52); c.lineWidth = G.PATH_HALF * 2 + 11; c.stroke();

    // raised-edge bevel: dark base peeking below, then border, body, lit core
    c.save();
    c.translate(0, 3);
    trace(); c.strokeStyle = shade(th.pathEdge || '#b0a284', -34); c.lineWidth = G.PATH_HALF * 2 + 6; c.stroke();
    c.restore();
    trace(); c.strokeStyle = th.pathEdge || '#b0a284'; c.lineWidth = G.PATH_HALF * 2 + 6; c.stroke();
    trace(); c.strokeStyle = th.pathColor; c.lineWidth = G.PATH_HALF * 2 - 2; c.stroke();
    c.save();
    c.translate(0, -2);
    trace(); c.strokeStyle = 'rgba(255,255,255,0.22)'; c.lineWidth = G.PATH_HALF * 2 - 8; c.stroke();
    c.restore();
    trace(); c.strokeStyle = th.pathCore || 'rgba(255,255,255,0.35)'; c.lineWidth = G.PATH_HALF * 2 - 18; c.stroke();

    const total = pathLength(pts);

    // transverse ruts
    c.strokeStyle = 'rgba(80,60,30,0.10)';
    c.lineWidth = 2;
    for (let d = 18; d < total; d += 23) {
      const p = pathPoint(pts, d);
      const nx = Math.cos(p.ang + Math.PI / 2), ny = Math.sin(p.ang + Math.PI / 2);
      const wob = (rnd() - 0.5) * 6;
      c.beginPath();
      c.moveTo(p.x + nx * (-G.PATH_HALF + 7 + wob), p.y + ny * (-G.PATH_HALF + 7 + wob));
      c.lineTo(p.x + nx * (G.PATH_HALF - 7 + wob), p.y + ny * (G.PATH_HALF - 7 + wob));
      c.stroke();
    }

    // piled snow banks scalloping the edges — irregular clumps, not beads
    for (let d = 12; d < total; d += 22 + rnd() * 26) {
      const p = pathPoint(pts, d);
      for (const side of [-1, 1]) {
        if (rnd() > 0.66) continue;
        const nx = Math.cos(p.ang + Math.PI / 2) * side, ny = Math.sin(p.ang + Math.PI / 2) * side;
        const off = G.PATH_HALF + 2 + rnd() * 5;
        const bx = p.x + nx * off, by = p.y + ny * off;
        const brx = 3 + rnd() * 6, bry = 2 + rnd() * 3;
        c.fillStyle = th.dark ? 'rgba(8,14,40,0.30)' : 'rgba(120,150,195,0.28)';
        c.beginPath(); c.ellipse(bx + 1.5, by + 2, brx, bry, p.ang + (rnd() - 0.5) * 0.6, 0, TAU); c.fill();
        c.fillStyle = th.dark
          ? `rgba(196,208,244,${0.2 + rnd() * 0.14})`
          : `rgba(255,255,255,${0.6 + rnd() * 0.35})`;
        c.beginPath(); c.ellipse(bx, by, brx, bry, p.ang + (rnd() - 0.5) * 0.6, 0, TAU); c.fill();
      }
    }

    // bricks + paw prints on the track
    for (let d = 10; d < total; d += 16) {
      const p = pathPoint(pts, d);
      if (rnd() > 0.6) {
        const nx = Math.cos(p.ang + Math.PI / 2), ny = Math.sin(p.ang + Math.PI / 2);
        const off = (rnd() - 0.5) * (G.PATH_HALF * 1.3);
        c.fillStyle = `rgba(100,88,64,${0.12 + rnd() * 0.14})`;
        c.beginPath(); c.arc(p.x + nx * off, p.y + ny * off, 1.2 + rnd() * 1.6, 0, TAU); c.fill();
      }
    }
    c.fillStyle = 'rgba(110,95,70,0.20)';
    for (let d = 26; d < total; d += 58) {
      const p = pathPoint(pts, d);
      const nx = Math.cos(p.ang + Math.PI / 2), ny = Math.sin(p.ang + Math.PI / 2);
      c.beginPath(); c.arc(p.x + nx * 8, p.y + ny * 8, 2.6, 0, TAU); c.fill();
      c.beginPath(); c.arc(p.x - nx * 8, p.y - ny * 8, 2.6, 0, TAU); c.fill();
    }
  }

  /* ---------- scenery props ---------- */
  function scatterProps(c, level, rnd, meta) {
    const kind = level.theme.props || 'pines';
    const place = (n, minPath, fn, sizeMin, sizeVar) => {
      for (let i = 0; i < n; i++) {
        for (let tries = 0; tries < 40; tries++) {
          const x = 30 + rnd() * (G.W - 60), y = 40 + rnd() * (G.H - 80);
          if (!pathDistOk(level.paths, x, y, minPath)) continue;
          if (waterHit(level, x, y, 26)) continue;
          let nearBlocker = false;
          for (const b of level.blockers) if ((x - b.x) ** 2 + (y - b.y) ** 2 < (b.r + 26) ** 2) nearBlocker = true;
          if (nearBlocker) continue;
          fn(c, x, y, sizeMin + rnd() * sizeVar, rnd);
          break;
        }
      }
    };

    if (kind === 'pines') {
      place(13, G.PATH_HALF + 42, drawPine, 16, 14);
      place(10, G.PATH_HALF + 34, drawTuft, 5, 4);
      place(6, G.PATH_HALF + 34, drawStone, 5, 6);
    } else if (kind === 'reeds') {
      // reeds hug the river banks
      for (const wt of level.water) {
        if (!wt.rect) continue;
        for (let i = 0; i < 12; i++) {
          const x = wt.rect.x + 30 + rnd() * (wt.rect.w - 60);
          const y = rnd() > 0.5 ? wt.rect.y - 10 - rnd() * 8 : wt.rect.y + wt.rect.h + 10 + rnd() * 8;
          if (!pathDistOk(level.paths, x, y, G.PATH_HALF + 20)) continue;
          drawReeds(c, x, y, 10 + rnd() * 7, rnd);
        }
      }
      place(5, G.PATH_HALF + 42, drawPine, 15, 12);
      place(5, G.PATH_HALF + 34, drawStone, 5, 5);
    } else if (kind === 'floes') {
      place(9, G.PATH_HALF + 34, drawShardCluster, 7, 8);
      place(4, G.PATH_HALF + 42, drawPine, 14, 10);
      place(5, G.PATH_HALF + 34, drawStone, 5, 5);
    } else if (kind === 'village') {
      place(3, G.PATH_HALF + 48, drawSnowman, 13, 4);
      place(6, G.PATH_HALF + 42, drawPine, 15, 13);
      place(6, G.PATH_HALF + 34, drawTuft, 5, 4);
    } else if (kind === 'crystals') {
      for (let i = 0; i < 11; i++) {
        for (let tries = 0; tries < 40; tries++) {
          const x = 30 + rnd() * (G.W - 60), y = 40 + rnd() * (G.H - 80);
          if (!pathDistOk(level.paths, x, y, G.PATH_HALF + 36)) continue;
          drawCrystalShard(c, x, y, 8 + rnd() * 12, rnd);
          meta.crystals.push({ x, y, r: 14 });
          break;
        }
      }
      place(7, G.PATH_HALF + 32, drawStone, 5, 7);
    } else if (kind === 'bay') {
      place(4, G.PATH_HALF + 40, drawBarrel, 9, 4);
      place(5, G.PATH_HALF + 38, drawDriftwood, 14, 10);
      place(4, G.PATH_HALF + 40, drawReeds, 10, 6);
      place(3, G.PATH_HALF + 34, drawStone, 5, 6);
    } else if (kind === 'dead') {
      place(6, G.PATH_HALF + 42, drawDeadTree, 16, 12);
      place(7, G.PATH_HALF + 32, drawStone, 5, 8);
      place(4, G.PATH_HALF + 32, drawTuft, 4, 4);
    } else if (kind === 'workshop') {
      place(4, G.PATH_HALF + 44, drawPine, 15, 12);
      place(2, G.PATH_HALF + 48, drawSnowman, 12, 4);
      place(5, G.PATH_HALF + 34, drawTuft, 5, 4);
      // torch-lit track near the home stretch
      const pts = level.paths[0];
      const total = pathLength(pts);
      for (let i = 0; i < 5; i++) {
        const p = pathPoint(pts, total * (0.45 + i * 0.12));
        const side = i % 2 === 0 ? 1 : -1;
        const nx = Math.cos(p.ang + Math.PI / 2) * side, ny = Math.sin(p.ang + Math.PI / 2) * side;
        const tx = p.x + nx * (G.PATH_HALF + 16), ty = p.y + ny * (G.PATH_HALF + 16);
        drawTorchBase(c, tx, ty);
        meta.torches.push({ x: tx, y: ty });
      }
    }

    // frame the map edges with scenery so the world doesn't just fade out
    const edgeFn = kind === 'crystals' ? drawCrystalShard : kind === 'dead' ? drawDeadTree : drawPine;
    for (let i = 0; i < 16; i++) {
      for (let tries = 0; tries < 30; tries++) {
        const side = (rnd() * 4) | 0;
        let x, y;
        if (side === 0) { x = rnd() * G.W; y = 16 + rnd() * 26; }
        else if (side === 1) { x = rnd() * G.W; y = G.H - 14 - rnd() * 26; }
        else if (side === 2) { x = 16 + rnd() * 26; y = rnd() * G.H; }
        else { x = G.W - 16 - rnd() * 26; y = rnd() * G.H; }
        if (!pathDistOk(level.paths, x, y, G.PATH_HALF + 28)) continue;
        if (waterHit(level, x, y, 30)) continue;
        edgeFn(c, x, y, (kind === 'crystals' ? 7 : 11) + rnd() * 7, rnd);
        break;
      }
    }
  }

  function propShadow(c, x, y, rx) {
    c.fillStyle = 'rgba(25,42,62,0.10)';
    c.beginPath(); c.ellipse(x + rx * 0.4, y + 2, rx * 1.15, rx * 0.4, 0, 0, TAU); c.fill();
    c.fillStyle = 'rgba(25,42,62,0.16)';
    c.beginPath(); c.ellipse(x + rx * 0.22, y + 1, rx, rx * 0.34, 0, 0, TAU); c.fill();
  }
  function drawPine(c, x, y, s, rnd) {
    propShadow(c, x, y + s * 0.9, s * 0.8);
    c.fillStyle = '#7a5535';
    c.fillRect(x - s * 0.11, y + s * 0.5, s * 0.22, s * 0.45);
    c.strokeStyle = '#4e3520'; c.lineWidth = 1.2;
    c.strokeRect(x - s * 0.11, y + s * 0.5, s * 0.22, s * 0.45);
    const green = ['#2f7c56', '#399165', '#2b6d4c'][(rnd() * 3) | 0];
    const dark = shade(green, -38);
    for (let i = 0; i < 3; i++) {
      const w = s * (1.08 - i * 0.26), yy = y + s * 0.55 - i * s * 0.52;
      c.fillStyle = green;
      c.beginPath(); c.moveTo(x - w * 0.66, yy); c.lineTo(x, yy - s * 0.8); c.lineTo(x + w * 0.66, yy); c.closePath(); c.fill();
      c.strokeStyle = dark; c.lineWidth = 1.5; c.stroke();
      c.fillStyle = '#f6fbff';
      c.beginPath(); c.moveTo(x - w * 0.36, yy - s * 0.3); c.lineTo(x, yy - s * 0.8); c.lineTo(x + w * 0.36, yy - s * 0.3);
      c.quadraticCurveTo(x, yy - s * 0.14, x - w * 0.36, yy - s * 0.3); c.closePath(); c.fill();
    }
  }
  function drawTuft(c, x, y, s, rnd) {
    c.strokeStyle = 'rgba(130,150,120,0.75)';
    c.lineWidth = 1.4;
    for (let i = -2; i <= 2; i++) {
      c.beginPath();
      c.moveTo(x, y);
      c.quadraticCurveTo(x + i * s * 0.32, y - s * 0.8, x + i * s * 0.55, y - s * (1 + rnd() * 0.4));
      c.stroke();
    }
  }
  function drawStone(c, x, y, s, rnd) {
    propShadow(c, x, y + s * 0.4, s);
    c.fillStyle = ['#98a2ab', '#8b959f', '#a3adb5'][(rnd() * 3) | 0];
    c.beginPath();
    c.moveTo(x - s, y + s * 0.4);
    c.lineTo(x - s * 0.5, y - s * 0.5); c.lineTo(x + s * 0.2, y - s * 0.7); c.lineTo(x + s * 0.9, y - s * 0.1);
    c.lineTo(x + s, y + s * 0.4);
    c.closePath(); c.fill();
    c.strokeStyle = '#5b6771'; c.lineWidth = 1.4; c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.75)';
    c.beginPath(); c.moveTo(x - s * 0.5, y - s * 0.5); c.lineTo(x + s * 0.2, y - s * 0.7); c.lineTo(x + s * 0.35, y - s * 0.4); c.lineTo(x - s * 0.25, y - s * 0.22); c.closePath(); c.fill();
  }
  function drawReeds(c, x, y, s, rnd) {
    c.strokeStyle = '#5f7d4f';
    c.lineWidth = 1.6;
    for (let i = -2; i <= 2; i++) {
      const tip = y - s * (1.2 + rnd() * 0.5);
      c.beginPath();
      c.moveTo(x + i * 2.4, y);
      c.quadraticCurveTo(x + i * 3.5, y - s, x + i * 4.5, tip);
      c.stroke();
      if (Math.abs(i) === 1) {
        c.fillStyle = '#7a5a38';
        c.beginPath(); c.ellipse(x + i * 4.5, tip, 2, 5, 0, 0, TAU); c.fill();
      }
    }
  }
  function drawSnowman(c, x, y, s, rnd) {
    propShadow(c, x, y + s * 0.8, s * 0.9);
    c.fillStyle = '#f7fafc';
    c.beginPath(); c.arc(x, y + s * 0.35, s * 0.62, 0, TAU); c.fill();
    c.beginPath(); c.arc(x, y - s * 0.45, s * 0.42, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(120,150,180,0.4)'; c.lineWidth = 1;
    c.beginPath(); c.arc(x, y + s * 0.35, s * 0.62, 0, TAU); c.stroke();
    c.fillStyle = '#1a1d21';
    c.beginPath(); c.arc(x - s * 0.13, y - s * 0.52, s * 0.05, 0, TAU); c.fill();
    c.beginPath(); c.arc(x + s * 0.13, y - s * 0.52, s * 0.05, 0, TAU); c.fill();
    c.fillStyle = '#f0862c';
    c.beginPath(); c.moveTo(x, y - s * 0.44); c.lineTo(x + s * 0.42, y - s * 0.38); c.lineTo(x, y - s * 0.34); c.closePath(); c.fill();
    c.strokeStyle = '#6b4f35'; c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(x - s * 0.55, y + s * 0.1); c.lineTo(x - s * 1.0, y - s * 0.3); c.stroke();
    c.beginPath(); c.moveTo(x + s * 0.55, y + s * 0.1); c.lineTo(x + s * 1.0, y - s * 0.3); c.stroke();
    c.strokeStyle = '#d9534f'; c.lineWidth = s * 0.14;
    c.beginPath(); c.moveTo(x - s * 0.34, y - s * 0.12); c.lineTo(x + s * 0.34, y - s * 0.08); c.stroke();
  }
  function drawCrystalShard(c, x, y, s, rnd) {
    propShadow(c, x, y + s * 0.35, s * 0.8);
    const cols = ['#8fd0f0', '#a8b8f0', '#c39bea'];
    for (let i = -1; i <= 1; i++) {
      const h = s * (i === 0 ? 1.7 : 1.1);
      const col = cols[(rnd() * 3) | 0];
      c.fillStyle = col;
      c.beginPath();
      c.moveTo(x + i * s * 0.5 - s * 0.28, y + s * 0.3);
      c.lineTo(x + i * s * 0.5 + i * s * 0.2, y - h);
      c.lineTo(x + i * s * 0.5 + s * 0.28, y + s * 0.3);
      c.closePath(); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.5)';
      c.beginPath();
      c.moveTo(x + i * s * 0.5 - s * 0.1, y + s * 0.1);
      c.lineTo(x + i * s * 0.5 + i * s * 0.2, y - h);
      c.lineTo(x + i * s * 0.5 + s * 0.06, y + s * 0.05);
      c.closePath(); c.fill();
    }
  }
  function drawBarrel(c, x, y, s, rnd) {
    propShadow(c, x, y + s * 0.6, s * 0.8);
    c.fillStyle = '#7a5c3e';
    c.beginPath();
    c.moveTo(x - s * 0.55, y - s * 0.6);
    c.quadraticCurveTo(x - s * 0.75, y, x - s * 0.55, y + s * 0.6);
    c.lineTo(x + s * 0.55, y + s * 0.6);
    c.quadraticCurveTo(x + s * 0.75, y, x + s * 0.55, y - s * 0.6);
    c.closePath(); c.fill();
    c.fillStyle = '#8d6c49';
    c.beginPath(); c.ellipse(x, y - s * 0.6, s * 0.55, s * 0.16, 0, 0, TAU); c.fill();
    c.strokeStyle = '#4f3b26'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(x - s * 0.68, y - s * 0.2); c.lineTo(x + s * 0.68, y - s * 0.2); c.stroke();
    c.beginPath(); c.moveTo(x - s * 0.68, y + s * 0.2); c.lineTo(x + s * 0.68, y + s * 0.2); c.stroke();
  }
  function drawDriftwood(c, x, y, s, rnd) {
    c.save();
    c.translate(x, y); c.rotate((rnd() - 0.5) * 1.4);
    propShadow(c, 0, 3, s);
    c.strokeStyle = '#7d6248'; c.lineCap = 'round';
    c.lineWidth = s * 0.22;
    c.beginPath(); c.moveTo(-s, 0); c.quadraticCurveTo(0, -s * 0.25, s, s * 0.1); c.stroke();
    c.lineWidth = s * 0.12;
    c.beginPath(); c.moveTo(s * 0.1, -s * 0.05); c.lineTo(s * 0.45, -s * 0.45); c.stroke();
    c.restore();
  }
  function drawDeadTree(c, x, y, s, rnd) {
    propShadow(c, x, y + s * 0.75, s * 0.6);
    c.strokeStyle = '#5d4a38'; c.lineCap = 'round';
    c.lineWidth = s * 0.16;
    c.beginPath(); c.moveTo(x, y + s * 0.75); c.lineTo(x, y - s * 0.55); c.stroke();
    c.lineWidth = s * 0.09;
    c.beginPath(); c.moveTo(x, y - s * 0.1); c.lineTo(x - s * 0.5, y - s * 0.7); c.stroke();
    c.beginPath(); c.moveTo(x, y - s * 0.35); c.lineTo(x + s * 0.45, y - s * 0.9); c.stroke();
    c.beginPath(); c.moveTo(x - s * 0.5, y - s * 0.7); c.lineTo(x - s * 0.72, y - s * 1.05); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = s * 0.05;
    c.beginPath(); c.moveTo(x, y - s * 0.55); c.lineTo(x, y - s * 0.2); c.stroke();
  }
  function drawShardCluster(c, x, y, s, rnd) {
    propShadow(c, x, y + s * 0.3, s * 0.9);
    c.fillStyle = 'rgba(215,235,250,0.95)';
    for (let i = -1; i <= 1; i++) {
      const h = s * (i === 0 ? 1.4 : 0.9);
      c.beginPath();
      c.moveTo(x + i * s * 0.55 - s * 0.25, y + s * 0.3);
      c.lineTo(x + i * s * 0.55 + i * s * 0.15, y - h);
      c.lineTo(x + i * s * 0.55 + s * 0.25, y + s * 0.3);
      c.closePath(); c.fill();
    }
    c.fillStyle = 'rgba(150,190,225,0.4)';
    c.beginPath(); c.ellipse(x, y + s * 0.32, s, s * 0.26, 0, 0, TAU); c.fill();
  }
  function drawTorchBase(c, x, y) {
    propShadow(c, x, y + 12, 8);
    c.strokeStyle = '#6b4f35'; c.lineWidth = 4; c.lineCap = 'round';
    c.beginPath(); c.moveTo(x, y + 12); c.lineTo(x, y - 10); c.stroke();
    c.fillStyle = '#4f3b26';
    c.beginPath(); c.moveTo(x - 6, y - 8); c.lineTo(x + 6, y - 8); c.lineTo(x + 4, y - 15); c.lineTo(x - 4, y - 15); c.closePath(); c.fill();
  }

  /* ---------- animated scenery ---------- */
  function drawSceneryFX(ctx, level, meta, t) {
    const th = level.theme;

    if (th.aurora) {
      ctx.save();
      ctx.globalAlpha = 0.15;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(0, 55 + i * 42);
        for (let x = 0; x <= G.W; x += 40) {
          ctx.lineTo(x, 55 + i * 42 + Math.sin(x * 0.01 + t * 0.7 + i * 2) * 30);
        }
        ctx.strokeStyle = ['#5ee8a8', '#7fb7f7', '#c98ef2'][i];
        ctx.lineWidth = 18;
        ctx.stroke();
      }
      ctx.restore();
    }

    // living water: drifting highlight + twinkles
    for (let wi = 0; wi < level.water.length; wi++) {
      const wt = level.water[wi];
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 2;
      if (wt.rect) {
        const { x, y, w, h } = wt.rect;
        for (let i = 0; i < 3; i++) {
          const xx = x + ((t * 34 + i * w / 3) % w);
          const yy = y + h * (0.25 + 0.5 * ((i * 0.37 + 0.2) % 1));
          ctx.beginPath();
          ctx.moveTo(xx - 22, yy);
          ctx.quadraticCurveTo(xx, yy + Math.sin(t * 2 + i) * 3, xx + 22, yy);
          ctx.stroke();
        }
      } else {
        for (let i = 0; i < 2; i++) {
          const a = t * 0.5 + wi * 2 + i * Math.PI;
          const rr = wt.r * (0.45 + 0.2 * i);
          const xx = wt.x + Math.cos(a) * rr * 0.5, yy = wt.y + Math.sin(a) * rr * 0.4;
          ctx.beginPath();
          ctx.moveTo(xx - 16, yy);
          ctx.quadraticCurveTo(xx, yy + Math.sin(t * 2.4 + i) * 3, xx + 16, yy);
          ctx.stroke();
        }
        const tw = (Math.sin(t * 2.6 + wi * 1.7) + 1) / 2;
        ctx.fillStyle = `rgba(255,255,255,${0.25 + tw * 0.4})`;
        ctx.beginPath();
        ctx.arc(wt.x + Math.cos(wi * 2.3) * wt.r * 0.5, wt.y + Math.sin(wi * 1.4) * wt.r * 0.4, 1.8 + tw, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    if (th.storm) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.13)';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      for (let i = 0; i < 11; i++) {
        const x = ((t * 340 + i * 173) % (G.W + 320)) - 160;
        const y = (i * 97) % G.H;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 85, y + 22);
        ctx.stroke();
      }
      ctx.restore();
    }

    for (let i = 0; i < meta.crystals.length; i++) {
      const cr = meta.crystals[i];
      const pulse = 0.14 + 0.08 * Math.sin(t * 2 + i * 1.8);
      const sprite = glowSprite(34, 2, '140,215,245');
      ctx.globalAlpha = Math.min(1, pulse * 2);
      ctx.drawImage(sprite, cr.x - 34, cr.y - 8 - 34);
      ctx.globalAlpha = 1;
    }

    for (let i = 0; i < meta.torches.length; i++) {
      const to = meta.torches[i];
      const fl = Math.sin(t * 9 + i * 2.4) * 2;
      const sprite = glowSprite(42, 2, '255,180,80');
      ctx.globalAlpha = 0.34;
      ctx.drawImage(sprite, to.x - 42, to.y - 18 - 42);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffb347';
      ctx.beginPath();
      ctx.moveTo(to.x - 4, to.y - 15);
      ctx.quadraticCurveTo(to.x - 5 + fl, to.y - 26, to.x, to.y - 30 - fl);
      ctx.quadraticCurveTo(to.x + 5 + fl, to.y - 26, to.x + 4, to.y - 15);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffe08a';
      ctx.beginPath();
      ctx.moveTo(to.x - 2, to.y - 16);
      ctx.quadraticCurveTo(to.x + fl * 0.5, to.y - 22, to.x, to.y - 25);
      ctx.quadraticCurveTo(to.x + 2 + fl * 0.5, to.y - 21, to.x + 2, to.y - 16);
      ctx.closePath(); ctx.fill();
    }
  }

  /* ---------- fort & blockers ---------- */
  function drawFort(ctx, x, y, r, home) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(25,42,62,0.16)';
    ctx.beginPath(); ctx.ellipse(r * 0.25, 4, r * 1.15, r * 0.36, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = home ? '#f4f9fd' : '#e8f0f7';
    ctx.beginPath(); ctx.arc(0, 0, r, Math.PI, 0); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#b9cbdc'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, r, Math.PI, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-r, 0); ctx.lineTo(r, 0); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.6, Math.PI, 0); ctx.stroke();
    ctx.fillStyle = '#4a5a6a';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.32, Math.PI, 0); ctx.closePath(); ctx.fill();
    if (home) {
      ctx.fillStyle = '#e05252';
      ctx.fillRect(-3, -r - 14, 3, 14);
      ctx.beginPath(); ctx.moveTo(0, -r - 14); ctx.lineTo(16, -r - 10); ctx.lineTo(0, -r - 6); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  function drawBlocker(ctx, b) {
    ctx.save();
    ctx.translate(b.x, b.y);
    if (b.kind === 'fort') { ctx.restore(); drawFort(ctx, b.x, b.y, b.r); return; }
    if (b.kind === 'crystal') {
      ctx.restore();
      drawCrystalShard(ctx, b.x, b.y, b.r * 0.85, mulberry32(b.x * 7 + b.y));
      return;
    }
    if (b.kind === 'wreck') {
      ctx.rotate(-0.25);
      ctx.fillStyle = '#6b4f35';
      ctx.beginPath();
      ctx.moveTo(-b.r, 0); ctx.quadraticCurveTo(0, b.r * 0.9, b.r, 0);
      ctx.lineTo(b.r * 0.75, -b.r * 0.45); ctx.lineTo(-b.r * 0.75, -b.r * 0.45); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#57402b';
      ctx.fillRect(-4, -b.r * 1.3, 5, b.r * 0.9);
      ctx.fillStyle = '#c9b9a2';
      ctx.beginPath(); ctx.moveTo(1, -b.r * 1.3); ctx.lineTo(b.r * 0.7, -b.r * 0.8); ctx.lineTo(1, -b.r * 0.6); ctx.closePath(); ctx.fill();
    } else if (b.kind === 'crack') {
      ctx.restore();
      drawCrackedIce(ctx, b.x, b.y, b.r, mulberry32(b.x * 31 + b.y * 7));
      return;
    } else if (b.kind === 'glacier') {
      ctx.restore();
      drawGlacierWall(ctx, b.x, b.y, b.r, mulberry32(b.x * 17 + b.y * 3));
      return;
    } else { // rock
      ctx.restore();
      drawStone(ctx, b.x, b.y, b.r * 0.9, mulberry32(b.x * 13 + b.y));
      return;
    }
    ctx.restore();
  }

  /* Cracked ice: a dark fracture pool with plates tilted out of it. Reads as
     "you cannot stand here" without looking like another boulder. */
  function drawCrackedIce(c, x, y, r, rnd) {
    c.save();
    // the hole itself
    const g = c.createRadialGradient(x, y, r * 0.15, x, y, r);
    g.addColorStop(0, 'rgba(16,42,74,0.85)');
    g.addColorStop(0.65, 'rgba(30,72,116,0.6)');
    g.addColorStop(1, 'rgba(120,170,210,0.12)');
    c.fillStyle = g;
    c.beginPath();
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const rr = r * (0.72 + rnd() * 0.34);
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr * 0.82;
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    }
    c.closePath(); c.fill();
    // fracture lines radiating out
    c.strokeStyle = 'rgba(226,240,252,0.55)';
    c.lineWidth = 1.3;
    for (let i = 0; i < 6; i++) {
      const a = rnd() * TAU;
      c.beginPath();
      c.moveTo(x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.25);
      const mx = x + Math.cos(a + 0.3) * r * 0.8, my = y + Math.sin(a + 0.3) * r * 0.65;
      c.lineTo(mx, my);
      c.lineTo(x + Math.cos(a - 0.2) * r * 1.25, y + Math.sin(a - 0.2) * r * 1.0);
      c.stroke();
    }
    // tilted plates around the rim
    for (let i = 0; i < 4; i++) {
      const a = rnd() * TAU, rr = r * (0.72 + rnd() * 0.3);
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr * 0.82;
      const s = r * (0.26 + rnd() * 0.2);
      c.fillStyle = 'rgba(232,244,255,0.92)';
      c.strokeStyle = 'rgba(96,140,180,0.8)'; c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(px - s, py); c.lineTo(px - s * 0.3, py - s * 0.75);
      c.lineTo(px + s * 0.9, py - s * 0.35); c.lineTo(px + s * 0.4, py + s * 0.4);
      c.closePath(); c.fill(); c.stroke();
    }
    c.restore();
  }

  /* Glacier wall: a slab of blue ice shoved up out of the snow. Drawn tall so
     a chain of them reads as one ridge running across the field. */
  function drawGlacierWall(c, x, y, r, rnd) {
    c.save();
    propShadow(c, x + r * 0.15, y + r * 0.5, r * 0.95);
    const top = y - r * (0.95 + rnd() * 0.35);
    // main slab
    const g = c.createLinearGradient(x - r, top, x + r, y + r * 0.5);
    g.addColorStop(0, '#dff0fb');
    g.addColorStop(0.45, '#a8cfe8');
    g.addColorStop(1, '#6f9dc2');
    c.fillStyle = g;
    c.strokeStyle = '#4d7799';
    c.lineWidth = 1.8;
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(x - r, y + r * 0.42);
    c.lineTo(x - r * 0.78, top + r * 0.3);
    c.lineTo(x - r * 0.16, top);
    c.lineTo(x + r * 0.5, top + r * 0.42);
    c.lineTo(x + r, y + r * 0.28);
    c.lineTo(x + r * 0.82, y + r * 0.5);
    c.lineTo(x - r * 0.8, y + r * 0.52);
    c.closePath(); c.fill(); c.stroke();
    // lit facet down the sunward face
    c.fillStyle = 'rgba(255,255,255,0.55)';
    c.beginPath();
    c.moveTo(x - r * 0.78, top + r * 0.3);
    c.lineTo(x - r * 0.16, top);
    c.lineTo(x - r * 0.05, y + r * 0.1);
    c.lineTo(x - r * 0.72, y + r * 0.3);
    c.closePath(); c.fill();
    // shadowed cleft
    c.fillStyle = 'rgba(40,86,128,0.35)';
    c.beginPath();
    c.moveTo(x + r * 0.5, top + r * 0.42);
    c.lineTo(x + r, y + r * 0.28);
    c.lineTo(x + r * 0.82, y + r * 0.5);
    c.lineTo(x + r * 0.36, y + r * 0.2);
    c.closePath(); c.fill();
    // rime along the crest
    c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.lineWidth = 2.2;
    c.beginPath();
    c.moveTo(x - r * 0.78, top + r * 0.3);
    c.lineTo(x - r * 0.16, top);
    c.lineTo(x + r * 0.5, top + r * 0.42);
    c.stroke();
    c.restore();
  }

  /* ================= BROS =================
     up = one tier count per upgrade path (0-3 each). Upgrades change the look:
     the first path grows the prop (glowing at max), the second adds a
     sash → cape → gold-trimmed cape, and veterans stand a bit taller.

     The third path rides on the SECOND path's dressing rather than inventing a
     third costume. The rule of two means a Bro only ever wears two paths at
     once, so what the silhouette needs to say is "how far along", not "which of
     three" — the coloured pips above its head already answer that. */
  /* ---- the figure ----
     A brick figure is boxes, and boxes are what makes it read at 20 pixels:
     legs block, tapered torso, cylinder head, one stud on top. Everything sits
     on a fixed vertical layout so the eyes, the mouth, the hats and the pips
     all know where the head is without being told:

        HEAD_TOP  -0.94 ┬ head (always yellow, whatever the Bro wears)
        FACE      -0.44 │   eyes and mouth are placed off this
        HEAD_BOT  -0.20 ┴
        SHOULDER  -0.16 ┬ torso, tapering wider toward the hips
        HIP        0.30 ┼ legs block
        FOOT       0.94 ┴

     The whole thing is lit from the top-left, matching the cast shadow drawn
     underneath it, so flat plastic still looks moulded rather than printed. */
  const HEAD_TOP = -0.94, HEAD_BOT = -0.20, HIP = 0.30, FOOT = 0.94;
  const SKIN = '#f2c033';           // the one colour every Bro shares

  /* A brick-shaped panel: a rectangle whose top and bottom edges can differ in
     width, so a torso can taper without four separate paths. */
  function panel(ctx, yTop, yBot, halfTop, halfBot, rad) {
    ctx.beginPath();
    ctx.moveTo(-halfTop + rad, yTop);
    ctx.lineTo(halfTop - rad, yTop);
    ctx.quadraticCurveTo(halfTop, yTop, halfTop + (halfBot - halfTop) * 0.1, yTop + rad);
    ctx.lineTo(halfBot, yBot - rad);
    ctx.quadraticCurveTo(halfBot, yBot, halfBot - rad, yBot);
    ctx.lineTo(-halfBot + rad, yBot);
    ctx.quadraticCurveTo(-halfBot, yBot, -halfBot, yBot - rad);
    ctx.lineTo(-halfTop - (halfBot - halfTop) * 0.1, yTop + rad);
    ctx.quadraticCurveTo(-halfTop, yTop, -halfTop + rad, yTop);
    ctx.closePath();
  }

  /* The still half of a Bro: the gear on its back, the legs, the torso and the
     head. A dozen fills, none of which changes between frames — so in a battle
     it is baked into a sprite (see the cache at the top of the file) and
     blitted. The shop icons still draw it the long way; they are painted once,
     not sixty times a second, and at sizes the battle never asks for. */
  function paintBroBody(ctx, r, look, tierA, tierB, clsColor) {
    const torso = look.tint || '#2f6fb5';
    const legs = look.belly || '#2b3a4a';
    const ink = shade(torso.startsWith('#') ? torso : '#2f6fb5', -70);
    const lw = Math.max(1, r * 0.085);

    // back-mounted gear, drawn before the body so it sits behind it
    if (look.prop === 'jetpack') {
      ctx.fillStyle = look.propColor || '#e07b39';
      rounded(ctx, -r * 0.74, -r * 0.30, r * 0.30, r * 0.86, r * 0.12);
      rounded(ctx, r * 0.44, -r * 0.30, r * 0.30, r * 0.86, r * 0.12);
      ctx.fillStyle = '#b8b0a4';
      rounded(ctx, -r * 0.74, -r * 0.38, r * 0.30, r * 0.16, r * 0.06);
      rounded(ctx, r * 0.44, -r * 0.38, r * 0.30, r * 0.16, r * 0.06);
    }
    if (look.prop === 'periscope') {           // the rover's antenna mast
      ctx.fillStyle = '#7d8a96';
      ctx.fillRect(r * 0.52, -r * 1.62, r * 0.13, r * 1.2);
      ctx.fillStyle = '#c9d4dd';
      ctx.beginPath(); ctx.arc(r * 0.585, -r * 1.66, r * 0.15, 0, TAU); ctx.fill();
    }

    /* ---- legs ---- */
    ctx.fillStyle = legs;
    panel(ctx, HIP * r, FOOT * r, r * 0.44, r * 0.50, r * 0.07);
    ctx.fill();
    ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.stroke();
    // the gap between the two legs, and the darker boot band along the bottom
    ctx.fillStyle = shade(legs.startsWith('#') ? legs : '#2b3a4a', -40);
    ctx.fillRect(-r * 0.05, HIP * r + r * 0.22, r * 0.10, r * 0.72);
    ctx.globalAlpha = 0.5;
    ctx.fillRect(-r * 0.50, FOOT * r - r * 0.16, r * 1.0, r * 0.16);
    ctx.globalAlpha = 1;
    // hip plate — the little step where the legs meet the torso
    ctx.fillStyle = shade(legs.startsWith('#') ? legs : '#2b3a4a', 22);
    rounded(ctx, -r * 0.46, HIP * r - r * 0.02, r * 0.92, r * 0.16, r * 0.05);

    /* ---- torso ---- */
    ctx.fillStyle = torso;
    panel(ctx, HEAD_BOT * r + r * 0.04, HIP * r + r * 0.02, r * 0.34, r * 0.47, r * 0.07);
    ctx.fill();
    ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.stroke();
    // moulded shading: light down the left face, shadow down the right
    ctx.save();
    panel(ctx, HEAD_BOT * r + r * 0.04, HIP * r + r * 0.02, r * 0.34, r * 0.47, r * 0.07);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(-r * 0.5, -r, r * 0.22, r * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(r * 0.22, -r, r * 0.3, r * 2);

    /* ---- the gear path, worn on the chest ----
       Tier 1 is a printed torso stripe in the class colour; tier 2 adds the
       cape (drawn in drawBro, behind everything); tier 3 gilds the stripe. */
    if (tierB >= 1) {
      ctx.strokeStyle = clsColor; ctx.lineWidth = r * 0.17; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-r * 0.34, HEAD_BOT * r + r * 0.16); ctx.lineTo(r * 0.30, HIP * r - r * 0.04); ctx.stroke();
      if (tierB >= 3) {
        ctx.strokeStyle = '#ffd166'; ctx.lineWidth = r * 0.05;
        ctx.beginPath(); ctx.moveTo(-r * 0.34, HEAD_BOT * r + r * 0.16); ctx.lineTo(r * 0.30, HIP * r - r * 0.04); ctx.stroke();
      }
    }
    ctx.restore();

    /* ---- neck stud ---- */
    ctx.fillStyle = shade(torso.startsWith('#') ? torso : '#2f6fb5', 30);
    rounded(ctx, -r * 0.13, HEAD_BOT * r - r * 0.02, r * 0.26, r * 0.12, r * 0.05);

    /* ---- head ----
       Always the same yellow, on every Bro in the game. It is the one thing
       that says these are all the same kind of thing, so nothing is allowed to
       recolour it — hats go on top, they do not replace it. */
    ctx.fillStyle = SKIN;
    rounded(ctx, -r * 0.40, HEAD_TOP * r, r * 0.80, (HEAD_BOT - HEAD_TOP) * r, r * 0.20);
    ctx.strokeStyle = '#9a7412'; ctx.lineWidth = lw;
    // rounded() only fills, so re-trace the outline
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-r * 0.40 + r * 0.20, HEAD_TOP * r);
    ctx.arcTo(r * 0.40, HEAD_TOP * r, r * 0.40, HEAD_BOT * r, r * 0.20);
    ctx.arcTo(r * 0.40, HEAD_BOT * r, -r * 0.40, HEAD_BOT * r, r * 0.20);
    ctx.arcTo(-r * 0.40, HEAD_BOT * r, -r * 0.40, HEAD_TOP * r, r * 0.20);
    ctx.arcTo(-r * 0.40, HEAD_TOP * r, r * 0.40, HEAD_TOP * r, r * 0.20);
    ctx.closePath(); ctx.stroke();
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(-r * 0.42, HEAD_TOP * r, r * 0.18, r);
    ctx.fillStyle = 'rgba(0,0,0,0.13)';
    ctx.fillRect(r * 0.24, HEAD_TOP * r, r * 0.2, r);
    ctx.restore();

    // the stud on top of the head
    ctx.fillStyle = shade(SKIN, -18);
    ctx.beginPath(); ctx.ellipse(0, HEAD_TOP * r, r * 0.15, r * 0.07, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = SKIN;
    ctx.beginPath(); ctx.ellipse(0, HEAD_TOP * r - r * 0.05, r * 0.15, r * 0.07, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#9a7412'; ctx.lineWidth = Math.max(0.8, r * 0.05);
    ctx.beginPath(); ctx.ellipse(0, HEAD_TOP * r - r * 0.05, r * 0.15, r * 0.07, 0, 0, TAU); ctx.stroke();
  }

  /* One arm and its C-shaped hand, swinging from the shoulder. Drawn live
     rather than baked because it is the only part of a Bro that moves. */
  function paintArm(ctx, r, side, torso, ink) {
    ctx.save();
    ctx.scale(side, 1);
    ctx.fillStyle = torso;
    ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.beginPath();
    ctx.moveTo(r * 0.30, -r * 0.12);
    ctx.quadraticCurveTo(r * 0.70, -r * 0.06, r * 0.68, r * 0.30);
    ctx.lineTo(r * 0.48, r * 0.32);
    ctx.quadraticCurveTo(r * 0.50, r * 0.06, r * 0.26, r * 0.10);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // hand: an open C, the way a brick figure's grip actually looks
    ctx.fillStyle = SKIN; ctx.strokeStyle = '#9a7412';
    ctx.lineWidth = Math.max(1.4, r * 0.11); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(r * 0.60, r * 0.40, r * 0.13, -2.2, 1.5); ctx.stroke();
    ctx.restore();
  }

  /* The hat, and the gold halo a maxed gear path puts around it. shadowBlur is
     the most expensive thing a 2D context can be asked for, and it was being
     asked for once per capstone Bro per frame; baked, it costs nothing. */
  /* The headgear was laid out around a penguin's head, which sat lower and
     rounder than a brick figure's does. Rather than re-draw nineteen hats to
     new coordinates, the whole set is nudged up onto the top of the cylinder
     and scaled so it overhangs the head the way a moulded hat piece does —
     0.52r of hat brim on 0.40r of head. */
  function paintBroHat(ctx, r, look, tierB) {
    const put = () => {
      ctx.save();
      ctx.translate(0, -r * 0.13);
      drawHat(ctx, r, look, 0);
      ctx.restore();
    };
    if (tierB >= 3) {
      ctx.save();
      ctx.shadowColor = 'rgba(255,209,102,0.85)'; ctx.shadowBlur = r * 0.5;
      put();
      ctx.restore();
    } else {
      put();
    }
  }

  function drawBro(ctx, x, y, r0, typeId, aim, t, up, cache) {
    const look = (typeId && G.LOOKS[typeId]) || {};
    const tierA = up ? (up[0] || 0) : 0;
    const tierB = up ? Math.max(up[1] || 0, up[2] || 0) : 0;
    const tiers = tierA + tierB;
    const r = r0 * (look.scale || 1) * (1 + tiers * 0.03);
    const body = look.tint || '#2f6fb5';
    const ink = shade(body.startsWith('#') ? body : '#2f6fb5', -70);
    const twDef = typeId && G.TOWERS[typeId];
    const clsColor = (twDef && G.CLASSES[twDef.cls] && G.CLASSES[twDef.cls].color) || '#e05252';
    /* Keyed on everything the baked art depends on, and on nothing else. r is
       a function of the type and the tiers, so it does not need to be in it. */
    const skey = cache ? typeId + '|' + tierA + '|' + tierB : null;

    ctx.save();
    ctx.translate(x, y);

    // directional cast shadow (light from top-left)
    ctx.fillStyle = 'rgba(25,42,62,0.10)';
    ctx.beginPath(); ctx.ellipse(r * 0.3, r * 0.8, r * 1.15, r * 0.46, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(25,42,62,0.20)';
    ctx.beginPath(); ctx.ellipse(r * 0.16, r * 0.76, r * 0.9, r * 0.36, 0, 0, TAU); ctx.fill();

    // veteran ground ring (4+ total tiers)
    if (tiers >= 4) {
      ctx.strokeStyle = clsColor;
      ctx.save(); ctx.globalAlpha = 0.4 + Math.sin(t * 2.5) * 0.12;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(r * 0.1, r * 0.76, r * 1.05, r * 0.42, 0, 0, TAU); ctx.stroke();
      ctx.restore();
    }

    // gear-path cape billows out behind (tier 2+), gold-trimmed at tier 3
    if (tierB >= 2) {
      const sway = Math.sin(t * 2.2) * r * 0.07;
      ctx.fillStyle = shade(clsColor, -12);
      ctx.beginPath();
      ctx.moveTo(-r * 0.34, -r * 0.62);
      ctx.quadraticCurveTo(-r * 1.3, -r * 0.1 + sway, -r * 1.12, r * 0.72 + sway);
      ctx.quadraticCurveTo(-r * 0.55, r * 0.95, -r * 0.12, r * 0.7);
      ctx.lineTo(r * 0.05, -r * 0.5);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = tierB >= 3 ? '#ffd166' : shade(clsColor, -46);
      ctx.lineWidth = r * (tierB >= 3 ? 0.1 : 0.06);
      ctx.stroke();
    }

    /* The pad box has to clear everything paintBroBody draws: the head stud at
       HEAD_TOP−0.05, the boots at FOOT, the jetpack tanks at ±0.74 and the
       rover's antenna at −1.66. Under-measure any of these and the sprite is
       silently cropped — no error, just a Bro with no aerial. */
    if (skey) {
      const tall = look.prop === 'periscope' ? r * 1.85 : r * 1.15;
      blitSprite(ctx, sprite('fig|' + skey, [r * 0.95, r * 0.95, tall, r * 1.1],
        (c) => paintBroBody(c, r, look, tierA, tierB, clsColor)));
    } else {
      paintBroBody(ctx, r, look, tierA, tierB, clsColor);
    }

    // arms swing a little; the right one holds whatever the Bro is armed with
    const swing = Math.sin(t * 4) * 0.12;
    ctx.save(); ctx.translate(0, r * swing * 0.25); paintArm(ctx, r, -1, body, ink); ctx.restore();
    ctx.save(); ctx.translate(0, -r * swing * 0.25); paintArm(ctx, r, 1, body, ink); ctx.restore();

    if (look.cheeks) {
      ctx.fillStyle = look.cheeks;
      ctx.beginPath(); ctx.ellipse(-r * 0.30, -r * 0.33, r * 0.09, r * 0.06, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(r * 0.30, -r * 0.33, r * 0.09, r * 0.06, 0, 0, TAU); ctx.fill();
    }

    /* The face is printed on, so it is flat black on yellow — no gloss, no
       gradient. The eyes still slide a little toward the aim, which is the one
       liberty taken with it: a whole row of Bros staring at the same vacuum is
       worth more than being strict about it. */
    const lx = aim != null ? Math.cos(aim) * r * 0.045 : 0;
    const ly = aim != null ? Math.sin(aim) * r * 0.03 : 0;
    ctx.fillStyle = '#20242a';
    ctx.beginPath(); ctx.ellipse(-r * 0.15 + lx, -r * 0.50 + ly, r * 0.075, r * 0.09, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(r * 0.15 + lx, -r * 0.50 + ly, r * 0.075, r * 0.09, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.arc(-r * 0.17 + lx, -r * 0.53 + ly, r * 0.025, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(r * 0.13 + lx, -r * 0.53 + ly, r * 0.025, 0, TAU); ctx.fill();
    // a printed smile
    ctx.strokeStyle = '#20242a'; ctx.lineWidth = Math.max(1, r * 0.055); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, -r * 0.38, r * 0.16, 0.45, Math.PI - 0.45); ctx.stroke();

    // oversized hat & weapon: role reads at a glance. The weapon grows with
    // its path, and a maxed path glows gold.
    if (skey) {
      blitSprite(ctx, sprite('hat|' + skey, [r * 1.5, r * 1.5, r * 2.4, r * 1.3],
        (c) => paintBroHat(c, r, look, tierB)));
    } else {
      paintBroHat(ctx, r, look, tierB);
    }
    const propS = 1 + tierA * 0.13;
    const propR = r * 1.32 * propS;
    if (tierA >= 3) {
      ctx.save();
      ctx.shadowColor = 'rgba(255,209,102,0.85)'; ctx.shadowBlur = r * 0.55;
      drawProp(ctx, propR, look, aim, t, propS);
      ctx.restore();
    } else {
      drawProp(ctx, propR, look, aim, t, propS);
    }
    drawRoleExtras(ctx, r, typeId, t, tierA, tierB);

    ctx.restore();
  }

  /* extra per-role flourishes so each Bro's job is unmistakable;
     a few of them thicken up as the weapon path (tierA) grows */
  function drawRoleExtras(ctx, r, typeId, t, tierA, tierB) {
    tierA = tierA || 0; tierB = tierB || 0;
    switch (typeId) {
      case 'slush': // glue tank strapped to the hip, with a sight glass
        ctx.fillStyle = '#2e8fa3';
        rounded(ctx, -r * 0.92, -r * 0.16, r * 0.34, r * 0.72, r * 0.10);
        ctx.fillStyle = 'rgba(160,235,250,0.85)';
        rounded(ctx, -r * 0.86, -r * 0.04, r * 0.22, r * 0.34, r * 0.06);
        ctx.fillStyle = '#1c6b7c';
        rounded(ctx, -r * 0.92, -r * 0.22, r * 0.34, r * 0.10, r * 0.04);
        break;
      case 'artillery': // shell pile grows with the Shells path
        ctx.fillStyle = '#2f3b47';
        for (let i = 0; i < 3 + tierA; i++) {
          ctx.beginPath();
          ctx.ellipse(-r * 0.9 + i * r * 0.26, r * 0.78, r * 0.12, r * 0.2, 0.3, 0, TAU);
          ctx.fill();
        }
        break;
      case 'icewall': { // a stack of spare bricks at the feet
        const cols = ['#c8443c', '#3f7fd4', '#e8b93c'];
        for (let i = 0; i < 3; i++) {
          const bw = r * 0.30, bh = r * 0.16;
          const bx = -r * 0.95 + (i % 2) * r * 0.14, by = r * 0.76 - i * bh;
          ctx.fillStyle = cols[i];
          ctx.fillRect(bx, by - bh, bw, bh);
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.fillRect(bx, by - bh, bw, bh * 0.3);
          ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = Math.max(0.7, r * 0.03);
          ctx.strokeRect(bx, by - bh, bw, bh);
        }
        break;
      }
      case 'sunpriest': { // radiating sun rays around the halo — more with power
        const rays = 6 + tierA * 2;
        ctx.save();
        ctx.translate(0, -r * 1.4);
        ctx.rotate(t * 0.8);
        ctx.strokeStyle = 'rgba(255,209,102,0.8)';
        ctx.lineWidth = r * 0.07;
        ctx.lineCap = 'round';
        for (let i = 0; i < rays; i++) {
          const a = (i / rays) * TAU;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6 * 0.5);
          ctx.lineTo(Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85 * 0.5);
          ctx.stroke();
        }
        ctx.restore();
        break;
      }
      case 'blizzard': { // orbiting loose bricks — a thicker swarm when upgraded
        const n = 4 + tierA;
        const cols = ['#c8443c', '#3f7fd4', '#e8b93c', '#3fae6a'];
        for (let i = 0; i < n; i++) {
          const a = t * 2.2 + (i * TAU) / n;
          const px = Math.cos(a) * r * 1.25, py = Math.sin(a) * r * 0.7 - r * 0.15;
          ctx.save(); ctx.translate(px, py); ctx.rotate(a * 1.6);
          ctx.fillStyle = cols[i % cols.length];
          ctx.fillRect(-r * 0.11, -r * 0.07, r * 0.22, r * 0.14);
          ctx.fillStyle = 'rgba(255,255,255,0.4)';
          ctx.fillRect(-r * 0.11, -r * 0.07, r * 0.22, r * 0.05);
          ctx.restore();
        }
        break;
      }
      case 'drummer': { // visible beat shockwave
        const beat = (t * 1.5) % 1;
        ctx.strokeStyle = `rgba(224,101,63,${(1 - beat) * 0.5})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(0, r * 0.3, r * (0.5 + beat * 1.3), 0, TAU); ctx.stroke();
        break;
      }
      case 'harpoon': { // scope glint
        const wink = Math.max(0, Math.sin(t * 2.2));
        ctx.strokeStyle = `rgba(255,255,255,${wink})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(r * 0.62, -r * 0.5); ctx.lineTo(r * 0.9, -r * 0.5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(r * 0.76, -r * 0.64); ctx.lineTo(r * 0.76, -r * 0.36); ctx.stroke();
        break;
      }
      case 'shadow': // tracking ninja scarf
        ctx.fillStyle = 'rgba(192,57,43,0.85)';
        ctx.beginPath();
        ctx.moveTo(-r * 0.4, -r * 0.5);
        ctx.quadraticCurveTo(-r * 1.1, -r * 0.4 + Math.sin(t * 5) * r * 0.12, -r * 1.5, -r * 0.62 + Math.sin(t * 5) * r * 0.2);
        ctx.quadraticCurveTo(-r * 1.05, -r * 0.28, -r * 0.4, -r * 0.34);
        ctx.closePath(); ctx.fill();
        break;
    }
  }

  function rounded(ctx, x, y, w, h, rad) {
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath(); ctx.fill();
  }

  function drawHat(ctx, r, look, t) {
    const c = look.hatColor || '#e05252';
    switch (look.hat) {
      case 'scarf':
        ctx.fillStyle = c;
        ctx.fillRect(-r * 0.55, -r * 0.18, r * 1.1, r * 0.22);
        ctx.fillRect(r * 0.2, -r * 0.02, r * 0.22, r * 0.5);
        break;
      case 'captain':
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.ellipse(0, -r * 0.8, r * 0.52, r * 0.24, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = c;
        ctx.fillRect(-r * 0.52, -r * 0.84, r * 1.04, r * 0.16);
        ctx.fillStyle = '#ffd166';
        ctx.beginPath(); ctx.arc(0, -r * 0.76, r * 0.06, 0, TAU); ctx.fill();
        break;
      case 'sailor':
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.ellipse(0, -r * 0.74, r * 0.46, r * 0.2, 0, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.ellipse(0, -r * 0.86, r * 0.3, r * 0.16, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#3f7fd4'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(0, -r * 0.74, r * 0.46, r * 0.2, 0, Math.PI * 0.1, Math.PI * 0.9); ctx.stroke();
        break;
      case 'helmet':
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.arc(0, -r * 0.62, r * 0.55, Math.PI * 1.05, -Math.PI * 0.05); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(0, -r * 0.62, r * 0.55, Math.PI * 1.05, -Math.PI * 0.05); ctx.stroke();
        ctx.fillRect(-r * 0.55, -r * 0.6, r * 1.1, r * 0.1);
        break;
      case 'goggles':
        ctx.fillStyle = '#2b3138';
        ctx.fillRect(-r * 0.55, -r * 0.56, r * 1.1, r * 0.14);
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.arc(-r * 0.26, -r * 0.46, r * 0.19, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(r * 0.26, -r * 0.46, r * 0.19, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#1a1d21'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(-r * 0.26, -r * 0.46, r * 0.19, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.arc(r * 0.26, -r * 0.46, r * 0.19, 0, TAU); ctx.stroke();
        break;
      case 'earmuffs':
        ctx.strokeStyle = '#4a5a6a'; ctx.lineWidth = r * 0.1;
        ctx.beginPath(); ctx.arc(0, -r * 0.5, r * 0.55, Math.PI * 1.15, -Math.PI * 0.15); ctx.stroke();
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.arc(-r * 0.55, -r * 0.42, r * 0.2, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(r * 0.55, -r * 0.42, r * 0.2, 0, TAU); ctx.fill();
        break;
      case 'souwester':
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.ellipse(0, -r * 0.66, r * 0.68, r * 0.24, 0, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(0, -r * 0.7, r * 0.42, Math.PI, 0); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(0, -r * 0.66, r * 0.68, r * 0.24, 0, 0, Math.PI); ctx.stroke();
        break;
      case 'aviator':
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.arc(0, -r * 0.58, r * 0.52, Math.PI, 0); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#5d6d7e'; ctx.lineWidth = r * 0.1;
        ctx.beginPath(); ctx.arc(0, -r * 0.86, r * 0.26, Math.PI * 0.9, Math.PI * 0.1, true); ctx.stroke();
        ctx.fillStyle = '#9fd8e8';
        ctx.beginPath(); ctx.arc(-r * 0.14, -r * 0.9, r * 0.11, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(r * 0.14, -r * 0.9, r * 0.11, 0, TAU); ctx.fill();
        break;
      case 'officer':
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.ellipse(0, -r * 0.88, r * 0.5, r * 0.2, 0, 0, TAU); ctx.fill();
        ctx.fillRect(-r * 0.5, -r * 0.86, r, r * 0.22);
        ctx.fillStyle = '#c0392b';
        ctx.fillRect(-r * 0.5, -r * 0.66, r, r * 0.08);
        ctx.fillStyle = '#ffd166';
        ctx.beginPath(); ctx.arc(0, -r * 0.78, r * 0.07, 0, TAU); ctx.fill();
        break;
      case 'wizard':
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.moveTo(-r * 0.5, -r * 0.62); ctx.lineTo(r * 0.5, -r * 0.62); ctx.lineTo(r * 0.08, -r * 1.45); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#ffd76a';
        ctx.beginPath(); ctx.arc(r * 0.12, -r * 1.36, r * 0.1, 0, TAU); ctx.fill();
        break;
      case 'hood':
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.moveTo(-r * 0.72, 0);
        ctx.quadraticCurveTo(-r * 0.9, -r * 1.1, 0, -r * 1.14);
        ctx.quadraticCurveTo(r * 0.9, -r * 1.1, r * 0.72, 0);
        ctx.quadraticCurveTo(r * 0.4, -r * 0.28, 0, -r * 0.26);
        ctx.quadraticCurveTo(-r * 0.4, -r * 0.28, -r * 0.72, 0);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.beginPath(); ctx.ellipse(0, -r * 0.5, r * 0.44, r * 0.3, 0, 0, TAU); ctx.fill();
        break;
      case 'crown':
        ctx.fillStyle = c;
        for (let i = -2; i <= 2; i++) {
          const bx = i * r * 0.22;
          const h = (i === 0 ? r * 0.55 : Math.abs(i) === 1 ? r * 0.42 : r * 0.3);
          ctx.beginPath();
          ctx.moveTo(bx - r * 0.1, -r * 0.62); ctx.lineTo(bx, -r * 0.62 - h); ctx.lineTo(bx + r * 0.1, -r * 0.62);
          ctx.closePath(); ctx.fill();
        }
        ctx.fillStyle = '#5b9bd4';
        ctx.fillRect(-r * 0.52, -r * 0.68, r * 1.04, r * 0.12);
        break;
      case 'headband':
        ctx.fillStyle = c;
        ctx.fillRect(-r * 0.54, -r * 0.62, r * 1.08, r * 0.14);
        ctx.beginPath(); ctx.moveTo(r * 0.5, -r * 0.56); ctx.lineTo(r * 0.85, -r * 0.4); ctx.lineTo(r * 0.72, -r * 0.6); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#3a3f46';
        ctx.beginPath(); ctx.ellipse(0, -r * 0.16, r * 0.42, r * 0.2, 0, 0, TAU); ctx.fill();
        break;
      case 'halo':
        ctx.strokeStyle = c; ctx.lineWidth = r * 0.09;
        ctx.save(); ctx.globalAlpha = 0.9 + Math.sin(t * 3) * 0.1;
        ctx.beginPath(); ctx.ellipse(0, -r * 1.18, r * 0.42, r * 0.13, 0, 0, TAU); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = c;
        ctx.fillRect(-r * 0.4, -r * 0.2, r * 0.8, r * 0.1);
        break;
      case 'straw':
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.ellipse(0, -r * 0.64, r * 0.72, r * 0.2, 0, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(0, -r * 0.68, r * 0.4, Math.PI, 0); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#8a5a33'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(-r * 0.4, -r * 0.7); ctx.lineTo(r * 0.4, -r * 0.7); ctx.stroke();
        break;
      case 'headset':
        ctx.strokeStyle = '#3a3f46'; ctx.lineWidth = r * 0.1;
        ctx.beginPath(); ctx.arc(0, -r * 0.48, r * 0.56, Math.PI * 1.1, -Math.PI * 0.1); ctx.stroke();
        ctx.fillStyle = c;
        rounded(ctx, -r * 0.72, -r * 0.6, r * 0.24, r * 0.36, r * 0.08);
        rounded(ctx, r * 0.48, -r * 0.6, r * 0.24, r * 0.36, r * 0.08);
        ctx.strokeStyle = c; ctx.lineWidth = r * 0.06;
        ctx.beginPath(); ctx.moveTo(r * 0.58, -r * 0.32); ctx.quadraticCurveTo(r * 0.4, -r * 0.05, r * 0.16, -r * 0.05); ctx.stroke();
        break;
      case 'hardhat':
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.arc(0, -r * 0.6, r * 0.5, Math.PI, 0); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.ellipse(0, -r * 0.6, r * 0.66, r * 0.14, 0, 0, Math.PI); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(-r * 0.08, -r * 1.06, r * 0.16, r * 0.4);
        break;
      case 'mohawk':
        ctx.fillStyle = c;
        for (let i = -2; i <= 2; i++) {
          ctx.beginPath();
          ctx.moveTo(i * r * 0.14 - r * 0.07, -r * 0.6);
          ctx.quadraticCurveTo(i * r * 0.14 + (i * 0.06 * r), -r * 1.25, i * r * 0.14 + r * 0.07, -r * 0.6);
          ctx.closePath(); ctx.fill();
        }
        ctx.fillRect(-r * 0.4, -r * 0.24, r * 0.18, r * 0.06);
        ctx.fillRect(r * 0.22, -r * 0.24, r * 0.18, r * 0.06);
        break;
      case 'beanie':
      default:
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.arc(0, -r * 0.6, r * 0.48, Math.PI, 0); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(0, -r * 1.05, r * 0.12, 0, TAU); ctx.fill();
        break;
    }
  }

  /* r carries the upgrade growth; rb is the un-grown radius so held props
     (staffs, flags) stay anchored in the flipper while their size scales */
  function drawProp(ctx, r, look, aim, t, s) {
    const rb = r / (s || 1);
    const c = look.propColor || '#7d8a96';
    switch (look.prop) {
      case 'sling':
        ctx.strokeStyle = '#8a5a33'; ctx.lineWidth = r * 0.11; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(r * 0.62, r * 0.1); ctx.lineTo(r * 0.62, -r * 0.34);
        ctx.moveTo(r * 0.62, -r * 0.34); ctx.lineTo(r * 0.46, -r * 0.58);
        ctx.moveTo(r * 0.62, -r * 0.34); ctx.lineTo(r * 0.8, -r * 0.58);
        ctx.stroke();
        break;
      case 'boulder': {
        // a grey stone wheel the knight rolls, resting on the ground beside it
        const bx = -r * 0.70, by = r * 0.48, br = r * 0.30;
        ctx.fillStyle = '#8d97a2';
        ctx.beginPath(); ctx.arc(bx, by, br, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#5b656f'; ctx.lineWidth = Math.max(1, r * 0.06); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath(); ctx.ellipse(bx - br * 0.32, by - br * 0.36, br * 0.34, br * 0.2, -0.5, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        ctx.beginPath(); ctx.arc(bx + br * 0.3, by + br * 0.22, br * 0.16, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(bx - br * 0.1, by + br * 0.44, br * 0.11, 0, TAU); ctx.fill();
        break;
      }
      case 'blades':
        // steel blades orbiting the spinner, not ice shards
        ctx.fillStyle = '#cfd8e0';
        ctx.strokeStyle = '#7a8794'; ctx.lineWidth = Math.max(0.8, r * 0.03);
        for (let i = 0; i < 3; i++) {
          const a = t * 2 + (i * TAU) / 3;
          const px = Math.cos(a) * r * 1.05, py = Math.sin(a) * r * 0.55 + r * 0.1;
          ctx.save(); ctx.translate(px, py); ctx.rotate(a + 0.8);
          ctx.beginPath(); ctx.moveTo(r * 0.26, 0); ctx.lineTo(-r * 0.12, -r * 0.09); ctx.lineTo(-r * 0.12, r * 0.09);
          ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.restore();
        }
        break;
      case 'cannon': case 'howitzer': {
        const big = look.prop === 'howitzer';
        ctx.save(); ctx.rotate(aim != null ? aim : -0.5);
        ctx.fillStyle = c;
        rounded(ctx, r * 0.2, -r * (big ? 0.2 : 0.14), r * (big ? 1.15 : 0.85), r * (big ? 0.4 : 0.28), r * 0.09);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        rounded(ctx, r * 0.2, -r * (big ? 0.2 : 0.14), r * (big ? 1.15 : 0.85), r * (big ? 0.14 : 0.1), r * 0.05);
        ctx.fillStyle = '#1f2830';
        rounded(ctx, r * (big ? 1.2 : 0.92), -r * (big ? 0.24 : 0.17), r * 0.18, r * (big ? 0.48 : 0.34), r * 0.06);
        ctx.restore();
        break;
      }
      case 'hose':
        ctx.save(); ctx.rotate(aim != null ? aim : -0.5);
        ctx.fillStyle = c;
        rounded(ctx, r * 0.2, -r * 0.12, r * 0.7, r * 0.24, r * 0.1);
        ctx.fillStyle = '#67d4f5';
        ctx.beginPath(); ctx.arc(r * 0.95, 0, r * 0.13, 0, TAU); ctx.fill();
        ctx.restore();
        break;
      case 'harpoongun':
        ctx.save(); ctx.rotate(aim != null ? aim : -0.5);
        ctx.fillStyle = c;
        rounded(ctx, r * 0.1, -r * 0.1, r * 1.3, r * 0.2, r * 0.08);
        ctx.fillStyle = '#31404e';
        rounded(ctx, r * 0.45, -r * 0.28, r * 0.36, r * 0.16, r * 0.07);
        ctx.strokeStyle = '#d8dee4'; ctx.lineWidth = r * 0.08; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(r * 1.4, 0); ctx.lineTo(r * 1.75, 0); ctx.stroke();
        ctx.fillStyle = '#d8dee4';
        ctx.beginPath(); ctx.moveTo(r * 1.9, 0); ctx.lineTo(r * 1.62, -r * 0.14); ctx.lineTo(r * 1.62, r * 0.14); ctx.closePath(); ctx.fill();
        ctx.restore();
        break;
      case 'staff': case 'crookstaff': {
        const px = rb * 0.66;
        ctx.strokeStyle = '#6b4f35'; ctx.lineWidth = r * 0.12; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(px, rb * 0.6); ctx.lineTo(px, -r * 0.7); ctx.stroke();
        if (look.prop === 'crookstaff') {
          ctx.beginPath(); ctx.arc(px - r * 0.14, -r * 0.7, r * 0.15, 0, Math.PI * 1.4); ctx.stroke();
        }
        const glow = 0.65 + Math.sin(t * 4) * 0.25;
        ctx.fillStyle = look.propColor || '#5ee8a8';
        ctx.save(); ctx.globalAlpha = glow * 0.35;
        ctx.beginPath(); ctx.arc(px, -r * 0.86, r * 0.34, 0, TAU); ctx.fill();
        ctx.restore();
        ctx.save(); ctx.globalAlpha = glow;
        ctx.beginPath(); ctx.arc(px, -r * 0.86, r * 0.16, 0, TAU); ctx.fill();
        ctx.restore();
        break;
      }
      case 'orb': {
        const bob = Math.sin(t * 2.5) * r * 0.08;
        const glow = 0.65 + Math.sin(t * 4) * 0.25;
        ctx.fillStyle = c;
        ctx.save(); ctx.globalAlpha = glow * 0.3;
        ctx.beginPath(); ctx.arc(0, -r * 1.55 + bob, r * 0.4, 0, TAU); ctx.fill();
        ctx.restore();
        ctx.save(); ctx.globalAlpha = glow;
        ctx.beginPath(); ctx.arc(0, -r * 1.55 + bob, r * 0.18, 0, TAU); ctx.fill();
        ctx.restore();
        break;
      }
      case 'shuriken':
        ctx.save();
        ctx.translate(r * 0.7, -r * 0.1); ctx.rotate(t * 3);
        ctx.fillStyle = '#cfd8e0';
        for (let i = 0; i < 4; i++) {
          ctx.rotate(Math.PI / 2);
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(r * 0.3, -r * 0.08); ctx.lineTo(r * 0.3, r * 0.08); ctx.closePath(); ctx.fill();
        }
        ctx.restore();
        break;
      case 'stud': {
        // a single 2×2 brick held up in the hand — the currency, made solid
        const c2 = look.propColor || '#e8b93c';
        ctx.save(); ctx.translate(r * 0.52, r * 0.20);
        const w = r * 0.19, h = r * 0.17;
        ctx.fillStyle = shade(c2, -30);
        rounded(ctx, -w, -h * 0.2, w * 2, h, r * 0.04);
        ctx.fillStyle = c2;
        rounded(ctx, -w, -h * 0.55, w * 2, h * 0.6, r * 0.04);
        ctx.fillStyle = shade(c2, 26);
        ctx.beginPath(); ctx.ellipse(-w * 0.45, -h * 0.62, w * 0.34, h * 0.2, 0, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.ellipse(w * 0.45, -h * 0.62, w * 0.34, h * 0.2, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = shade(c2, -60); ctx.lineWidth = Math.max(0.8, r * 0.035);
        ctx.beginPath(); ctx.rect(-w, -h * 0.55, w * 2, h * 1.15); ctx.stroke();
        ctx.restore();
        break;
      }
      case 'drumsticks': {
        const beat = Math.sin(t * 9);
        ctx.strokeStyle = c; ctx.lineWidth = r * 0.1; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-r * 0.5, r * 0.1); ctx.lineTo(-r * 0.85, r * 0.5 - beat * r * 0.18);
        ctx.moveTo(r * 0.5, r * 0.1); ctx.lineTo(r * 0.85, r * 0.5 + beat * r * 0.18);
        ctx.stroke();
        ctx.fillStyle = '#e8dcc8';
        ctx.beginPath(); ctx.arc(-r * 0.85, r * 0.5 - beat * r * 0.18, r * 0.09, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(r * 0.85, r * 0.5 + beat * r * 0.18, r * 0.09, 0, TAU); ctx.fill();
        break;
      }
      case 'pickaxe':
        ctx.save(); ctx.translate(r * 0.7, -r * 0.05); ctx.rotate(0.6 + Math.sin(t * 3) * 0.1);
        ctx.strokeStyle = c; ctx.lineWidth = r * 0.11; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(0, r * 0.45); ctx.lineTo(0, -r * 0.45); ctx.stroke();
        ctx.strokeStyle = '#8b98a5'; ctx.lineWidth = r * 0.13;
        ctx.beginPath(); ctx.arc(0, -r * 0.1, r * 0.4, Math.PI * 1.25, Math.PI * 1.75); ctx.stroke();
        ctx.restore();
        break;
      case 'flag': {
        const px = rb * 0.7;
        ctx.strokeStyle = '#8a5a33'; ctx.lineWidth = r * 0.1; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(px, rb * 0.5); ctx.lineTo(px, -r * 0.75); ctx.stroke();
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.moveTo(px + r * 0.04, -r * 0.75); ctx.lineTo(px + r * 0.65, -r * 0.55); ctx.lineTo(px + r * 0.04, -r * 0.35); ctx.closePath(); ctx.fill();
        break;
      }
    }
  }

  /* ---------- special tower bodies ---------- */
  function drawTowerBody(ctx, game, tw, t) {
    const pos = game.towerPos(tw);

    if (tw.type === 'torpedo' || tw.type === 'depth') {
      ctx.save();
      ctx.translate(tw.x, tw.y);
      ctx.fillStyle = tw.type === 'torpedo' ? '#5a748c' : '#7a5c3e';
      ctx.beginPath(); ctx.ellipse(0, 10, 26, 10, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath(); ctx.ellipse(0, 7, 22, 5, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }
    if (tw.type === 'fort') { drawFort(ctx, tw.x, tw.y + 4, 24); }
    else if (tw.type === 'vendor') {
      ctx.save(); ctx.translate(tw.x, tw.y);
      ctx.fillStyle = '#8a5a33'; ctx.fillRect(-24, -4, 48, 18);
      ctx.fillStyle = '#d9534f'; ctx.fillRect(-26, -14, 52, 10);
      ctx.fillStyle = '#f8f9fa'; ctx.fillRect(-26, -14, 13, 10); ctx.fillRect(0, -14, 13, 10);
      ctx.fillStyle = '#9fd8e8';
      ctx.beginPath(); ctx.ellipse(-8, 3, 7, 3, 0.3, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(6, 3, 7, 3, -0.2, 0, TAU); ctx.fill();
      ctx.restore();
    } else if (tw.type === 'sonar') {
      ctx.save(); ctx.translate(tw.x, tw.y);
      ctx.fillStyle = '#5d6d7e'; ctx.fillRect(-2.5, -22, 5, 22);
      ctx.save(); ctx.translate(0, -22); ctx.rotate(t * 1.5);
      ctx.fillStyle = '#cdd8e0';
      ctx.beginPath(); ctx.arc(0, 0, 11, -1.1, 1.1); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#3fae6a';
      ctx.beginPath(); ctx.arc(4, 0, 2.5, 0, TAU); ctx.fill();
      ctx.restore(); ctx.restore();
      const ping = (t % 2) / 2;
      ctx.save();
      ctx.globalAlpha = 0.25 * (1 - ping);
      ctx.strokeStyle = '#3fae6a'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(tw.x, tw.y, ping * tw.calc.range, 0, TAU); ctx.stroke();
      ctx.restore();
    }

    // heroes stand on a softly pulsing gold ring
    if (tw.hero) {
      const pulse = 0.5 + Math.sin(t * 2.2) * 0.15;
      ctx.save();
      ctx.globalAlpha = 0.35 * pulse + 0.2;
      const grd = ctx.createRadialGradient(tw.x, tw.y + 8, 4, tw.x, tw.y + 8, 26);
      grd.addColorStop(0, 'rgba(255,209,102,0.55)');
      grd.addColorStop(1, 'rgba(255,209,102,0)');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.ellipse(tw.x, tw.y + 8, 26, 14, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(255,209,102,0.8)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(tw.x, tw.y + 10, 20, 10, 0, 0, TAU); ctx.stroke();
      ctx.restore();
    }

    const small = tw.type === 'fort' || tw.type === 'vendor';
    const pr = small ? 11 : 15;
    let px = small ? pos.x + 20 : pos.x;
    let py = small ? pos.y + 8 : pos.y;
    // recoil kick: jump back from the shot, spring back over ~0.16s
    const fireF = tw.lastShot != null ? Math.max(0, 1 - (game.time - tw.lastShot) / 0.16) : 0;
    if (fireF > 0 && tw.aim != null) {
      px -= Math.cos(tw.aim) * 5.5 * fireF;
      py -= Math.sin(tw.aim) * 5.5 * fireF;
    }
    drawBro(ctx, px, py, pr, tw.type, tw.aim, t + tw.id, tw.up, true);

    if (tw.type === 'jetpack') {
      ctx.save();
      ctx.translate(pos.x, pos.y + 14);
      ctx.fillStyle = `rgba(255,${150 + Math.sin(t * 20) * 60 | 0},60,0.7)`;
      ctx.beginPath(); ctx.moveTo(-4, 0); ctx.lineTo(4, 0); ctx.lineTo(0, 12 + Math.sin(t * 25) * 4); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    if (tw.type === 'drummer') {
      ctx.save(); ctx.translate(tw.x, tw.y + 10);
      ctx.fillStyle = '#8a5a33';
      ctx.beginPath(); ctx.ellipse(0, 0, 14, 8, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#d8c8a8';
      ctx.beginPath(); ctx.ellipse(0, -4, 14, 6, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }

    /* Tier pips, one colour per path — gold, cyan, violet. With the rule of two
       there are never more than five, and the two colours present tell you at a
       glance which pair this Bro committed to without opening its card. */
    const PIP = ['#ffd166', '#6fd7f5', '#c08cf0'];
    const ups = tw.up || [];
    const total = (ups[0] || 0) + (ups[1] || 0) + (ups[2] || 0);
    if (total > 0) {
      const used = ups.filter((v) => v > 0).length;
      const half = ((total - 1) * 8 + 5 * (used - 1)) / 2;
      /* The row is a function of the upgrade spread and nothing else — not the
         clock, not the aim, not where the Bro stands. By wave 100 nearly
         every Bro on the board is wearing the full five, which was two
         hundred little diamonds a frame, each one a fill and a stroke of its
         own. A board only ever shows a dozen different spreads, so one sheet
         each covers the lot and the row costs a single blit. */
      ctx.save();
      ctx.translate(tw.x, tw.y - 34);
      blitSprite(ctx, sprite('pip|' + ups.join(','), [half + 5, half + 5, 5, 5], (c) => {
        let ppx = -half;
        for (let p = 0; p < ups.length; p++) {
          if (!ups[p]) continue;
          for (let i = 0; i < ups[p]; i++) { drawPip(c, ppx, 0, PIP[p]); ppx += 8; }
          ppx += 5;
        }
      }));
      ctx.restore();
    }

    // hero level badge: a gold star shield above the champion
    if (tw.hero) {
      const lvl = game.heroLevel || 1;
      const bx = tw.x, by = tw.y - 40;
      ctx.save();
      ctx.fillStyle = '#1d2733';
      ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.roundRect(bx - 13, by - 8, 26, 16, 8); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffd166';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('★' + lvl, bx, by + 0.5);
      ctx.restore();
    }
  }

  function drawPip(ctx, x, y, col) {
    ctx.fillStyle = col;
    ctx.strokeStyle = 'rgba(10,18,28,0.6)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - 3.6); ctx.lineTo(x + 3.2, y); ctx.lineTo(x, y + 3.6); ctx.lineTo(x - 3.2, y);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  /* ================= VACUUMS ================= */
  function vacBody(ctx, r) {
    ctx.beginPath();
    ctx.moveTo(r * 0.6, -r * 0.55);
    ctx.quadraticCurveTo(r * 1.15, 0, r * 0.6, r * 0.55);
    ctx.quadraticCurveTo(0, r * 0.75, -r * 1.05, r * 0.3);
    ctx.lineTo(-r * 1.05, -r * 0.3);
    ctx.quadraticCurveTo(0, -r * 0.75, r * 0.6, -r * 0.55);
    ctx.closePath();
  }

  /* Everything below is drawn nose-right and belly-down, and the caller turns
     it down the track. Which way the animal is FACING is therefore a mirror,
     never a rotation past vertical: rotating a right-facing drawing by 180°
     puts its belly on the ceiling, and that is what had the whole pack
     swimming on its back down every leg of the track that runs right to left.

     Mirrored across its own spine instead — nose still leads, belly still
     down. Keyed on the segment's angle rather than the wobbled one: the wobble
     is ±0.07 either side, so on a vertical leg an angle-with-wobble crosses
     zero eight times a second and the vacuum would strobe. */
  function facesLeft(ang) { return Math.cos(ang) < 0; }

  /* The still half of a vacuum: body, markings, head, and whatever its
     species wears. Painted once per (type, stealth, freckles) into a sprite and
     blitted after that — see the sprite cache at the top of this file. The
     parts that actually move (tail, flipper, snort, pulses) are not in here;
     drawVac still draws those by hand every frame. */
  function paintVac(ctx, type, r, hidden, variant) {
    const def = G.ENEMIES[type];
    const col = def.color;
    const boss = !!def.boss;
    ctx.globalAlpha = hidden ? 0.45 : 1;

    // speedster: motion-blur ghost track
    if (type === 'speedster') {
      for (let gi = 2; gi >= 1; gi--) {
        ctx.save();
        ctx.translate(-r * 0.6 * gi, 0);
        ctx.globalAlpha = (hidden ? 0.45 : 1) * (gi === 1 ? 0.16 : 0.08);
        ctx.fillStyle = col;
        vacBody(ctx, r);
        ctx.fill();
        ctx.restore();
      }
    }

    // body base
    ctx.fillStyle = col;
    vacBody(ctx, r);
    ctx.fill();

    // shading inside the body: dark back, light belly, spots
    ctx.save();
    vacBody(ctx, r);
    ctx.clip();
    ctx.fillStyle = shade(col, -22);
    ctx.globalAlpha = 0.55;
    ctx.beginPath(); ctx.ellipse(-r * 0.05, -r * 0.42, r * 0.95, r * 0.34, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = shade(col, 34);
    ctx.beginPath(); ctx.ellipse(0, r * 0.4, r * 0.9, r * 0.34, 0, 0, TAU); ctx.fill();
    // glossy spine highlight — sells the rounded body
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.ellipse(-r * 0.02, -r * 0.2, r * 0.8, r * 0.17, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.45;
    ctx.beginPath(); ctx.ellipse(r * 0.7, -r * 0.22, r * 0.2, r * 0.1, 0.3, 0, TAU); ctx.fill();
    /* Mottled spots. Seeded off the sprite's freckle variant rather than off
       the individual animal: a pack of three patterns reads exactly as varied
       as a pack of ninety did, and it is the difference between three sheets
       per species and one per vacuum on the field. */
    if (!boss && type !== 'stealth') {
      const rnd = mulberry32(variant * 31013 + def.rank * 977);
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = shade(col, -30);
      const n = 4 + (rnd() * 4 | 0);
      for (let i = 0; i < n; i++) {
        const sx = (rnd() * 2 - 1) * r * 0.72;
        const sy = (rnd() * 2 - 1) * r * 0.4;
        ctx.beginPath();
        ctx.ellipse(sx, sy, r * (0.07 + rnd() * 0.09), r * (0.05 + rnd() * 0.06), rnd() * 3, 0, TAU);
        ctx.fill();
      }
    }
    // barnacles for the big ones
    if (type === 'colossus' || type === 'leviathan') {
      const rnd = mulberry32(def.rank * 31337);
      ctx.globalAlpha = 0.9;
      for (let i = 0; i < 7; i++) {
        const sx = (rnd() * 2 - 1) * r * 0.7, sy = -r * 0.15 - rnd() * r * 0.4;
        ctx.fillStyle = '#b8b4a4';
        ctx.beginPath(); ctx.arc(sx, sy, r * 0.05 + rnd() * r * 0.04, 0, TAU); ctx.fill();
        ctx.fillStyle = '#7d7a6d';
        ctx.beginPath(); ctx.arc(sx, sy, r * 0.022, 0, TAU); ctx.fill();
      }
    }
    ctx.restore();

    // bold cartoon outline
    ctx.strokeStyle = shade(col, -58);
    ctx.globalAlpha = hidden ? 0.4 : 0.9;
    ctx.lineWidth = Math.max(1.6, r * 0.13);
    vacBody(ctx, r);
    ctx.stroke();
    ctx.globalAlpha = hidden ? 0.45 : 1;

    // head (ghosted like the body when the vacuum is unrevealed stealth)
    const ghost = hidden ? 0.45 : 1;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(r * 0.75, 0, r * 0.48, 0, TAU); ctx.fill();
    ctx.strokeStyle = shade(col, -58); ctx.globalAlpha = 0.85 * ghost; ctx.lineWidth = Math.max(1.4, r * 0.11);
    ctx.beginPath(); ctx.arc(r * 0.75, 0, r * 0.48, -1.9, 1.9); ctx.stroke();
    // head gloss
    ctx.globalAlpha = 0.3 * ghost; ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.ellipse(r * 0.62, -r * 0.24, r * 0.2, r * 0.1, -0.4, 0, TAU); ctx.fill();
    ctx.globalAlpha = ghost;
    // muzzle
    ctx.fillStyle = shade(col, 38);
    ctx.beginPath(); ctx.ellipse(r * 1.02, r * 0.12, r * 0.26, r * 0.19, 0.15, 0, TAU); ctx.fill();
    // nose + nostrils
    ctx.fillStyle = '#22252b';
    ctx.beginPath(); ctx.ellipse(r * 1.17, r * 0.0, r * 0.075, r * 0.055, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(r * 1.1, r * 0.12); ctx.lineTo(r * 1.02, r * 0.2); ctx.stroke();
    // eye + glint + brow
    ctx.fillStyle = '#15181d';
    ctx.beginPath(); ctx.arc(r * 0.68, -r * 0.17, r * 0.1, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.arc(r * 0.71, -r * 0.21, r * 0.032, 0, TAU); ctx.fill();
    ctx.strokeStyle = shade(col, -40); ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(r * 0.68, -r * 0.2, r * 0.16, -2.6, -0.9); ctx.stroke();
    // whiskers
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(r * 1.0, r * 0.12);
      ctx.quadraticCurveTo(r * 1.2, r * 0.12 + i * r * 0.06, r * 1.38, r * 0.1 + i * r * 0.15);
      ctx.stroke();
    }

    /* --- type identity --- */
    switch (type) {
      case 'pup':
        ctx.fillStyle = '#15181d'; // extra-big puppy eye
        ctx.beginPath(); ctx.arc(r * 0.68, -r * 0.17, r * 0.13, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath(); ctx.arc(r * 0.73, -r * 0.23, r * 0.05, 0, TAU); ctx.fill();
        break;
      case 'juvenile': {
        ctx.fillStyle = shade(col, -34);
        for (let i = 0; i < 3; i++) {
          ctx.beginPath(); ctx.arc(r * (0.86 + i * 0.08), r * 0.2 + (i % 2) * r * 0.05, r * 0.025, 0, TAU); ctx.fill();
        }
        break;
      }
      case 'speedster':
        // swim goggles
        ctx.strokeStyle = '#2b3138'; ctx.lineWidth = r * 0.05;
        ctx.beginPath(); ctx.moveTo(r * 0.4, -r * 0.32); ctx.lineTo(r * 0.95, -r * 0.28); ctx.stroke();
        ctx.fillStyle = 'rgba(130,220,255,0.9)';
        ctx.beginPath(); ctx.ellipse(r * 0.68, -r * 0.18, r * 0.13, r * 0.11, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#20262e'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.ellipse(r * 0.68, -r * 0.18, r * 0.13, r * 0.11, 0, 0, TAU); ctx.stroke();
        // speed streaks
        ctx.strokeStyle = 'rgba(150,200,235,0.7)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(-r * 1.35, -r * 0.18); ctx.lineTo(-r * 1.95, -r * 0.18); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-r * 1.3, r * 0.14); ctx.lineTo(-r * 1.8, r * 0.14); ctx.stroke();
        break;
      case 'bull': {
        // big shaggy mane ruff
        ctx.fillStyle = shade(col, -26);
        ctx.beginPath();
        ctx.arc(r * 0.42, 0, r * 0.62, -2.3, 2.3);
        ctx.quadraticCurveTo(r * 0.0, 0, r * 0.42 + Math.cos(-2.3) * r * 0.62, Math.sin(-2.3) * r * 0.62);
        ctx.fill();
        ctx.strokeStyle = shade(col, -44); ctx.lineWidth = 1.6;
        for (let i = -3; i <= 3; i++) {
          ctx.beginPath();
          ctx.moveTo(r * 0.42 + Math.cos(i * 0.42 + Math.PI) * r * 0.28, Math.sin(i * 0.42) * r * 0.34);
          ctx.lineTo(r * 0.42 + Math.cos(i * 0.42 + Math.PI) * r * 0.62, Math.sin(i * 0.42) * r * 0.66);
          ctx.stroke();
        }
        break;
      }
      case 'stealth':
        // cowl + glowing eyes
        ctx.fillStyle = 'rgba(20,28,44,0.85)';
        ctx.beginPath(); ctx.arc(r * 0.7, -r * 0.08, r * 0.42, Math.PI, 0); ctx.closePath(); ctx.fill();
        ctx.fillStyle = hidden ? 'rgba(120,220,255,0.7)' : 'rgba(140,235,255,0.95)';
        ctx.beginPath(); ctx.arc(r * 0.68, -r * 0.16, r * 0.07, 0, TAU); ctx.fill();
        break;
      case 'armored':
        // riveted helm + back plate
        ctx.fillStyle = '#a9b3bd';
        ctx.beginPath(); ctx.arc(r * 0.75, -r * 0.06, r * 0.5, Math.PI * 1.05, -Math.PI * 0.12); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#6f7a86'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(r * 0.75, -r * 0.06, r * 0.5, Math.PI * 1.05, -Math.PI * 0.12); ctx.stroke();
        ctx.fillStyle = '#9aa5b0';
        ctx.beginPath(); ctx.moveTo(-r * 0.85, -r * 0.28); ctx.quadraticCurveTo(-r * 0.1, -r * 0.75, r * 0.32, -r * 0.42);
        ctx.lineTo(r * 0.25, -r * 0.05); ctx.quadraticCurveTo(-r * 0.2, -r * 0.4, -r * 0.85, -r * 0.02); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#6f7a86';
        ctx.beginPath(); ctx.moveTo(-r * 0.85, -r * 0.28); ctx.quadraticCurveTo(-r * 0.1, -r * 0.75, r * 0.32, -r * 0.42); ctx.stroke();
        ctx.fillStyle = '#5d6873';
        for (let i = 0; i < 4; i++) {
          ctx.beginPath(); ctx.arc(-r * 0.6 + i * r * 0.28, -r * 0.36 + Math.sin(i) * r * 0.05, r * 0.035, 0, TAU); ctx.fill();
        }
        break;
      case 'regen': {
        // the still half: two mossy patches. The rings and the cross pulse, so
        // they are drawn live in drawVacLive.
        ctx.fillStyle = 'rgba(110,210,140,0.6)';
        ctx.beginPath(); ctx.ellipse(-r * 0.35, -r * 0.3, r * 0.2, r * 0.13, 0.4, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.ellipse(r * 0.1, -r * 0.42, r * 0.16, r * 0.1, -0.3, 0, TAU); ctx.fill();
        break;
      }
      case 'brute':
        // heavy spiked collar + glowing angry eye + scars
        ctx.fillStyle = '#3a3f46';
        for (let i = -2; i <= 2; i++) {
          const a = i * 0.42;
          const bx = r * 0.42 + Math.cos(a + Math.PI) * r * 0.46;
          const by = Math.sin(a) * r * 0.52;
          ctx.save(); ctx.translate(bx, by); ctx.rotate(a + Math.PI);
          ctx.beginPath(); ctx.moveTo(0, -r * 0.13); ctx.lineTo(r * 0.34, 0); ctx.lineTo(0, r * 0.13); ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#5d6873';
          ctx.beginPath(); ctx.moveTo(0, -r * 0.13); ctx.lineTo(r * 0.17, -r * 0.04); ctx.lineTo(0, r * 0.02); ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#3a3f46';
          ctx.restore();
        }
        ctx.strokeStyle = shade(col, -46); ctx.lineWidth = r * 0.08;
        ctx.beginPath(); ctx.moveTo(r * 0.48, -r * 0.36); ctx.lineTo(r * 0.88, -r * 0.2); ctx.stroke();
        ctx.fillStyle = 'rgba(255,90,70,0.95)'; // burning glare
        ctx.beginPath(); ctx.arc(r * 0.68, -r * 0.17, r * 0.08, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(240,225,205,0.6)'; ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.moveTo(-r * 0.4, -r * 0.44); ctx.lineTo(-r * 0.16, -r * 0.2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-r * 0.32, -r * 0.44); ctx.lineTo(-r * 0.08, -r * 0.2); ctx.stroke();
        break;
      case 'beachmaster':
        drawTusks(ctx, r, 0.9);
        // grand mane
        ctx.fillStyle = shade(col, -24);
        ctx.beginPath(); ctx.arc(r * 0.35, 0, r * 0.58, -2.4, 2.4); ctx.quadraticCurveTo(-r * 0.1, 0, r * 0.35 + Math.cos(-2.4) * r * 0.58, Math.sin(-2.4) * r * 0.58); ctx.fill();
        ctx.strokeStyle = shade(col, -40); ctx.lineWidth = 1.4;
        for (let i = -3; i <= 3; i++) {
          ctx.beginPath();
          ctx.moveTo(r * 0.35 + Math.cos(i * 0.36 + Math.PI) * r * 0.3, Math.sin(i * 0.36) * r * 0.34);
          ctx.lineTo(r * 0.35 + Math.cos(i * 0.36 + Math.PI) * r * 0.58, Math.sin(i * 0.36) * r * 0.6);
          ctx.stroke();
        }
        scarPair(ctx, r);
        break;
      case 'colossus':
        drawTusks(ctx, r, 1.25);
        // kelp drape
        ctx.strokeStyle = 'rgba(60,130,80,0.85)'; ctx.lineWidth = r * 0.07; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-r * 0.3, -r * 0.55); ctx.quadraticCurveTo(-r * 0.15, 0, -r * 0.35, r * 0.55); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(r * 0.1, -r * 0.6); ctx.quadraticCurveTo(r * 0.25, -r * 0.1, r * 0.08, r * 0.35); ctx.stroke();
        scarPair(ctx, r);
        break;
      case 'emperor':
        drawTusks(ctx, r, 1.35);
        // royal mantle
        ctx.fillStyle = 'rgba(120,70,180,0.4)';
        ctx.beginPath(); ctx.ellipse(-r * 0.2, -r * 0.28, r * 0.75, r * 0.34, 0, 0, TAU); ctx.fill();
        // grand crown with jewels
        ctx.fillStyle = '#ffd166';
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          ctx.moveTo(r * 0.75 + (i - 0.5) * r * 0.22, -r * 0.46);
          ctx.lineTo(r * 0.75 + i * r * 0.22, -r * 0.46 - (i === 0 ? r * 0.44 : r * 0.3));
          ctx.lineTo(r * 0.75 + (i + 0.5) * r * 0.22, -r * 0.46);
          ctx.closePath(); ctx.fill();
        }
        ctx.fillRect(r * 0.75 - r * 0.33, -r * 0.5, r * 0.66, r * 0.1);
        ctx.fillStyle = '#e0606a';
        ctx.beginPath(); ctx.arc(r * 0.75, -r * 0.45, r * 0.05, 0, TAU); ctx.fill();
        ctx.fillStyle = '#67d4f5';
        ctx.beginPath(); ctx.arc(r * 0.53, -r * 0.45, r * 0.04, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(r * 0.97, -r * 0.45, r * 0.04, 0, TAU); ctx.fill();
        // glowing eye
        ctx.fillStyle = '#ffd166';
        ctx.beginPath(); ctx.arc(r * 0.68, -r * 0.17, r * 0.06, 0, TAU); ctx.fill();
        break;
      case 'leviathan':
        drawTusks(ctx, r, 1.5);
        // seaweed; the rune cracks and the gaze pulse are drawn live
        ctx.strokeStyle = 'rgba(50,120,90,0.9)'; ctx.lineWidth = r * 0.06; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-r * 0.55, -r * 0.5); ctx.quadraticCurveTo(-r * 0.4, 0, -r * 0.6, r * 0.5); ctx.stroke();
        scarPair(ctx, r);
        break;
    }
  }

  /* The half that has to be redrawn: anything whose shape or brightness is a
     function of the clock. Everything here sits clear of the head and the
     silhouette, so drawing it over the blitted sprite lands the same picture
     the old single pass did. */
  function drawVacLive(ctx, e, r, t, ghost) {
    switch (e.type) {
      case 'bull': {
        // angry snort puffs from the nose
        const ph = (t * 1.1 + e.wob) % 1;
        if (ph < 0.4) {
          const pf = ph / 0.4;
          ctx.fillStyle = `rgba(255,255,255,${(1 - pf) * 0.7})`;
          ctx.beginPath(); ctx.arc(r * (1.3 + pf * 0.5), -r * 0.06, r * 0.09 + pf * r * 0.1, 0, TAU); ctx.fill();
          ctx.beginPath(); ctx.arc(r * (1.28 + pf * 0.45), r * 0.18, r * 0.07 + pf * r * 0.09, 0, TAU); ctx.fill();
        }
        break;
      }
      case 'regen': {
        const pulse = 0.5 + Math.sin(t * 5) * 0.3;
        ctx.strokeStyle = `rgba(110,230,150,${pulse * 0.75})`;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, r * 1.18, 0, TAU); ctx.stroke();
        ctx.strokeStyle = `rgba(110,230,150,${pulse * 0.3})`;
        ctx.beginPath(); ctx.arc(0, 0, r * (1.3 + pulse * 0.15), 0, TAU); ctx.stroke();
        // floating heal cross
        ctx.fillStyle = `rgba(140,255,170,${pulse})`;
        const cy = -r * 0.85 - Math.sin(t * 3) * r * 0.08;
        ctx.fillRect(-r * 0.05, cy - r * 0.16, r * 0.1, r * 0.32);
        ctx.fillRect(-r * 0.16, cy - r * 0.05, r * 0.32, r * 0.1);
        break;
      }
      case 'leviathan':
        // rune cracks, breathing
        ctx.globalAlpha = 0.5 + Math.sin(t * 2.5) * 0.3;
        ctx.strokeStyle = '#6fe8e0';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(-r * 0.75, -r * 0.1);
        ctx.lineTo(-r * 0.5, -r * 0.32); ctx.lineTo(-r * 0.28, -r * 0.16); ctx.lineTo(-r * 0.02, -r * 0.4);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(r * 0.15, r * 0.3); ctx.lineTo(r * 0.35, r * 0.08); ctx.lineTo(r * 0.52, r * 0.22);
        ctx.stroke();
        ctx.globalAlpha = ghost;
        // glowing gaze
        ctx.fillStyle = `rgba(110,235,225,${0.7 + Math.sin(t * 4) * 0.3})`;
        ctx.beginPath(); ctx.arc(r * 0.68, -r * 0.17, r * 0.07, 0, TAU); ctx.fill();
        break;
    }
  }

  /* The tail flukes are four quadratics, and they were being flattened afresh
     for every animal on the field — ninety bezier fills a frame for a shape
     that is the same shape every time. The wag is a rigid turn about the hip,
     so the turn stays live and only the outline is baked.

     This sheet, paintVacFlipper's and paintHeavyTail's are keyed on the species
     alone while baking in `r` and `col`, which is only correct because both are
     copied straight off the ENEMIES table when the animal spawns and nothing
     in the codebase ever writes to them afterwards. Give a vacuum a size that
     varies — a giant modifier, a curve that swells them in deep endless — and
     these three sheets go silently wrong, with every animal of the species
     wearing whichever one was baked first. Put the varying thing in the key. */
  function paintVacTail(ctx, r, col) {
    ctx.fillStyle = shade(col, -12);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-r * 0.35, -r * 0.12, -r * 0.6, -r * 0.42);
    ctx.quadraticCurveTo(-r * 0.42, -r * 0.05, -r * 0.38, 0);
    ctx.quadraticCurveTo(-r * 0.42, r * 0.05, -r * 0.6, r * 0.42);
    ctx.quadraticCurveTo(-r * 0.35, r * 0.12, 0, 0);
    ctx.closePath(); ctx.fill();
  }

  /* The stealth fade is painted INTO this sheet rather than applied to the blit,
     and the sheet is keyed on it. The webbing strokes lie on top of the fill,
     and three translucent passes laid on the screen one after another are not
     the same picture as three laid into a sheet that is then faded once — an
     unrevealed stealth vacuum would have grown darker ribs. */
  function paintVacFlipper(ctx, r, col, hidden) {
    ctx.globalAlpha = hidden ? 0.45 : 1;
    ctx.fillStyle = shade(col, -18);
    ctx.beginPath();
    ctx.ellipse(0, r * 0.2, r * 0.16, r * 0.4, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = shade(col, -34); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, r * 0.1); ctx.lineTo(0, r * 0.5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-r * 0.07, r * 0.12); ctx.lineTo(-r * 0.09, r * 0.48); ctx.stroke();
  }

  function drawVac(ctx, game, e, t) {
    const def = G.ENEMIES[e.type];
    const p = G.samplePath(game.paths[e.pathIdx], e.dist);
    const wob = Math.sin(t * 8 + e.wob) * 0.07;
    const r = e.size;
    const hidden = e.stealth && e.revealUntil <= game.time;
    const col = def.color;
    const ghost = hidden ? 0.45 : 1;

    /* boss menace glow — a cached sprite at a moving opacity, not a fresh
       radial gradient and a big gradient-filled arc every frame */
    if (e.boss) {
      const glowCol = e.type === 'leviathan' ? '80,215,230' : '225,70,70';
      const rad = Math.round(r * 1.75);
      const gs = glowSprite(rad, Math.round(r * 0.4), glowCol);
      ctx.save();
      ctx.globalAlpha = (0.3 + Math.sin(t * 3) * 0.08) * 0.5;
      ctx.drawImage(gs, p.x - rad, p.y - rad);
      ctx.restore();
    }

    ctx.save();
    ctx.translate(p.x, p.y);
    if (hidden) ctx.globalAlpha = 0.45;
    const ang = p.ang + wob;
    ctx.rotate(ang);
    const squish = Math.sin(t * 7 + e.wob) * 0.025;
    ctx.scale(1 + squish, 1 - squish);

    // cast shadow, offset toward world down-right regardless of facing
    const sdx = Math.cos(-ang) * 4 - Math.sin(-ang) * 6;
    const sdy = Math.sin(-ang) * 4 + Math.cos(-ang) * 6;
    ctx.fillStyle = 'rgba(25,42,62,0.10)';
    ctx.beginPath(); ctx.ellipse(sdx * 1.4, r * 0.42 + sdy, r * 1.3, r * 0.44, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(25,42,62,0.18)';
    ctx.beginPath(); ctx.ellipse(sdx, r * 0.44 + sdy * 0.6, r * 1.08, r * 0.36, 0, 0, TAU); ctx.fill();

    /* Facing, after the shadow so the shadow keeps pointing at the world's
       ground rather than at the animal's. See facesLeft. */
    if (facesLeft(p.ang)) ctx.scale(1, -1);

    // heavies get their own body entirely, then fall through to the shared
    // status pips and health bar below
    if (e.heavy) {
      drawHeavyBody(ctx, e, r, col, t);
      ctx.restore();
      drawEnemyStatus(ctx, game, e, def, r, p, t);
      return;
    }

    // tail flippers — under the body, so they go on before the sprite
    const tailWag = Math.sin(t * 10 + e.wob) * 0.3;
    ctx.save();
    ctx.translate(-r * 1.02, 0); ctx.rotate(tailWag);
    blitSprite(ctx, sprite('tail|' + e.type, [r * 0.7, r * 0.1, r * 0.5, r * 0.5],
      (c) => paintVacTail(c, r, col)));
    ctx.restore();

    /* The animal itself, in one blit. Three freckle patterns per species is
       all the variety ninety individually-seeded vacuums ever showed. */
    const variant = ((e.wob * 1000) | 0) % 3;
    const key = 'seal|' + e.type + '|' + (hidden ? 'h' : '') + variant;
    ctx.globalAlpha = 1;
    blitSprite(ctx, sprite(key, [r * 2.4, r * 1.7, r * 1.25, r * 1.05],
      (c) => paintVac(c, e.type, r, hidden, variant)));

    // front flipper — clear of the head, so it can go on over the sprite
    ctx.save();
    ctx.translate(-r * 0.05, r * 0.34);
    ctx.rotate(0.55 + wob * 1.6);
    blitSprite(ctx, sprite('flip|' + e.type + (hidden ? '|h' : ''),
      [r * 0.2 + 2, r * 0.2 + 2, r * 0.25 + 2, r * 0.65 + 2],
      (c) => paintVacFlipper(c, r, col, hidden)));
    ctx.restore();
    ctx.globalAlpha = ghost;

    drawVacLive(ctx, e, r, t, ghost);

    ctx.restore();
    drawEnemyStatus(ctx, game, e, def, r, p, t);
  }

  /* slow/stun/poison pips and the health bar — drawn upright, never rotated,
     shared by the vacuums and the heavies */
  function drawEnemyStatus(ctx, game, e, def, r, p, t) {
    /* An untouched vacuum has nothing to say. Most of a wave is untouched
       most of the time, and this was still opening and closing a context state
       for every one of them, every frame, to draw nothing. */
    if (e.hp >= e.maxHp && e.slowUntil <= game.time && e.stunUntil <= game.time &&
        e.dotUntil <= game.time && e.vulnUntil <= game.time && e.bleedUntil <= game.time) return;
    ctx.save();
    ctx.translate(p.x, p.y);
    if (e.slowUntil > game.time) {
      ctx.fillStyle = 'rgba(110,190,240,0.32)';
      ctx.beginPath(); ctx.arc(0, 0, r * 1.1, 0, TAU); ctx.fill();
    }
    if (e.stunUntil > game.time) {
      ctx.fillStyle = '#bfe8ff';
      for (let i = 0; i < 3; i++) {
        const a = t * 4 + (i * TAU) / 3;
        ctx.beginPath(); ctx.arc(Math.cos(a) * r * 0.9, -r - 6 + Math.sin(a) * 3, 2.5, 0, TAU); ctx.fill();
      }
    }
    if (e.dotUntil > game.time) {
      ctx.fillStyle = 'rgba(180,110,220,0.85)';
      ctx.beginPath(); ctx.arc(r * 0.5, -r * 0.9, 3, 0, TAU); ctx.fill();
    }
    /* Marked for the whole crew. "+30% damage from every source" is otherwise
       invisible — you buy the capstone and nothing on screen changes — so a
       marked vacuum wears a target reticle until it wears off. */
    if (e.vulnUntil > game.time) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,190,90,0.9)';
      ctx.lineWidth = 1.8;
      ctx.rotate(t * 1.6);
      const rr = r * 1.25;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU;
        ctx.beginPath();
        ctx.arc(0, 0, rr, a + 0.22, a + TAU / 4 - 0.22);
        ctx.stroke();
      }
      ctx.restore();
    }
    // Bleeding around the barb (Extractor Lance) — bosses only, so it stays rare
    if (e.bleedUntil > game.time) {
      ctx.fillStyle = `rgba(230,80,80,${0.5 + Math.sin(t * 6) * 0.3})`;
      ctx.beginPath(); ctx.arc(-r * 0.5, -r * 0.9, 3, 0, TAU); ctx.fill();
    }
    if (e.hp < e.maxHp) {
      const w = Math.max(24, r * 1.6);
      ctx.fillStyle = 'rgba(8,14,22,0.55)';
      rounded(ctx, -w / 2, -r - 12, w, 5, 2.5);
      const frac = Math.max(0, e.hp / e.maxHp);
      ctx.fillStyle = frac > 0.5 ? '#5fc26e' : frac > 0.25 ? '#e8b84a' : '#e05252';
      if (w * frac > 3) rounded(ctx, -w / 2, -r - 12, w * frac, 5, 2.5);
      if (e.boss) {
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(20,30,44,0.85)';
        ctx.fillText(def.name, 0, -r - 18);
      }
    }
    ctx.restore();
  }

  /* An heavy seen from above: long torpedo body, flukes at the stern, pectoral
     fins swept back, the dorsal blade standing proud of the water, and the
     markings that make the animal unmistakable — white eye ovals at the bow
     and the grey saddle behind the fin. Drawn nose-right, like every other
     creature here, so the caller's rotation carries it down the track.

     Split the same way the vacuums are: the wake, the flukes and the
     pectorals swim, so they are drawn every frame; the hull and its markings
     are a sprite. Everything that moves is astern of everything that does not,
     which is why the live half can go on first and the blit can finish the
     job in one call. */
  function paintHeavyBody(ctx, type, r, col) {
    const ink = '#0b1119';
    const belly = '#f4f9ff';

    /* Pectoral fins, swept back. They used to paddle by 0.12 of a radian on
       top of their 0.5 rest angle — seven degrees, next to the flukes' twenty,
       on a fin a fifth the size. Baked at rest: what reads as swimming is the
       tail, and this keeps the animal to two blits. */
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(r * 0.18, side * r * 0.42);
      ctx.rotate(side * 0.5);
      ctx.fillStyle = shade(col, -10);
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1.2, r * 0.045);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(-r * 0.1, side * r * 0.42, -r * 0.5, side * r * 0.56);
      ctx.quadraticCurveTo(-r * 0.28, side * r * 0.16, -r * 0.16, 0);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    // body — dark above, gradient to a lit crown along the back
    const bodyGrad = ctx.createLinearGradient(0, -r * 0.6, 0, r * 0.6);
    bodyGrad.addColorStop(0, shade(col, 46));
    bodyGrad.addColorStop(0.45, col);
    bodyGrad.addColorStop(1, shade(col, -18));
    ctx.fillStyle = bodyGrad;
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(1.6, r * 0.07);
    ctx.beginPath();
    ctx.moveTo(r * 1.06, 0);                                    // snout
    ctx.quadraticCurveTo(r * 0.86, -r * 0.46, r * 0.2, -r * 0.54);
    ctx.quadraticCurveTo(-r * 0.44, -r * 0.56, -r * 0.94, -r * 0.2);
    ctx.quadraticCurveTo(-r * 1.0, 0, -r * 0.94, r * 0.2);
    ctx.quadraticCurveTo(-r * 0.44, r * 0.56, r * 0.2, r * 0.54);
    ctx.quadraticCurveTo(r * 0.86, r * 0.46, r * 1.06, 0);
    ctx.closePath(); ctx.fill(); ctx.stroke();

    // grey saddle patch behind the dorsal
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#93a7bd';
    ctx.beginPath();
    ctx.ellipse(-r * 0.44, 0, r * 0.3, r * 0.34, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    // white eye ovals — the marking that says "heavy" instantly
    for (const side of [-1, 1]) {
      ctx.fillStyle = belly;
      ctx.strokeStyle = 'rgba(11,17,25,0.55)';
      ctx.lineWidth = Math.max(0.8, r * 0.025);
      ctx.beginPath();
      ctx.ellipse(r * 0.56, side * r * 0.3, r * 0.2, r * 0.12, side * -0.24, 0, TAU);
      ctx.fill(); ctx.stroke();
    }
    // eyes
    for (const side of [-1, 1]) {
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.arc(r * 0.66, side * r * 0.26, Math.max(1.1, r * 0.05), 0, TAU);
      ctx.fill();
    }
    // gloss along the back
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(r * 0.2, -r * 0.3, r * 0.5, r * 0.11, -0.1, 0, TAU);
    ctx.fill();
    ctx.restore();

    /* Dorsal fin — tall blade, upright on the bulls and kings. It used to lean
       with the swim by 0.05 of a radian, which on a blade this size moves its
       tip by a twentieth of the animal's length. Baked upright: nothing on
       screen is measurably different and it keeps the hull to one blit. */
    const finH = type === 'heavy_king' ? 1.15 : type === 'heavy_great' ? 0.95 : 0.78;
    ctx.save();
    ctx.translate(-r * 0.06, 0);
    ctx.fillStyle = shade(col, 16);
    ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1.4, r * 0.06); ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(r * 0.26, 0);
    ctx.quadraticCurveTo(r * 0.1, -r * finH * 0.62, -r * 0.3, -r * finH);
    ctx.quadraticCurveTo(-r * 0.22, -r * finH * 0.34, -r * 0.3, 0);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // lit edge down the blade
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = '#dfe9f5'; ctx.lineWidth = Math.max(1, r * 0.035);
    ctx.beginPath();
    ctx.moveTo(r * 0.2, -r * 0.06);
    ctx.quadraticCurveTo(r * 0.06, -r * finH * 0.6, -r * 0.28, -r * finH * 0.94);
    ctx.stroke();
    ctx.restore();

    // the MEGAVAC bares its teeth
    if (type === 'heavy_king') {
      ctx.fillStyle = belly;
      ctx.strokeStyle = 'rgba(11,17,25,0.6)';
      ctx.lineWidth = Math.max(0.8, r * 0.02);
      for (let i = 0; i < 7; i++) {
        const f = i / 6;
        const x = r * (1.02 - f * 0.34);
        const y = (-r * 0.16 + f * r * 0.32) * 0.9;
        ctx.beginPath();
        ctx.moveTo(x, y - r * 0.035);
        ctx.lineTo(x + r * 0.075, y);
        ctx.lineTo(x, y + r * 0.035);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
  }

  /* The wake: a bow spray and a churned track astern. Two big soft ellipses,
     and an heavy is a big animal — thirty of them in a deep endless wave meant
     sixty large alpha fills a frame, which measured as the single most
     expensive thing left on the board. The churn used to bob by a sixth of a
     radius with the swim; it is painted at rest instead, and the flukes wag
     over the top of it, which is what actually reads as swimming. */
  function paintHeavyWake(ctx, r) {
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = 'rgba(232,246,255,0.55)';
    ctx.beginPath();
    ctx.ellipse(-r * 1.5, 0, r * 0.72, r * 0.5, 0, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.32;
    ctx.beginPath();
    ctx.ellipse(-r * 2.15, 0, r * 0.5, r * 0.3, 0, 0, TAU);
    ctx.fill();
  }

  /* The last piece of the heavy still being drawn by hand, and the most
     expensive: five quadratics filled and then stroked again, on an animal the
     deep endless tide fields thirty of at once. The wag is a rigid turn about
     the tail stock, so the turn stays live and the outline is baked — which
     leaves an heavy costing three blits and no vector work at all. */
  function paintHeavyTail(ctx, r, col) {
    ctx.fillStyle = shade(col, -6);
    ctx.strokeStyle = '#0b1119'; ctx.lineWidth = Math.max(1.4, r * 0.055); ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(r * 0.12, 0);
    ctx.quadraticCurveTo(-r * 0.28, -r * 0.1, -r * 0.66, -r * 0.5);
    ctx.quadraticCurveTo(-r * 0.3, -r * 0.14, -r * 0.24, 0);
    ctx.quadraticCurveTo(-r * 0.3, r * 0.14, -r * 0.66, r * 0.5);
    ctx.quadraticCurveTo(-r * 0.28, r * 0.1, r * 0.12, 0);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  function drawHeavyBody(ctx, e, r, col, t) {
    const swim = Math.sin(t * 3.4 + e.wob);

    blitSprite(ctx, sprite('heavywake|' + e.type, [r * 2.75, r * 0.1, r * 0.6, r * 0.6],
      (c) => paintHeavyWake(c, r)));

    // tail stock + flukes
    ctx.save();
    ctx.translate(-r * 0.92, 0);
    ctx.rotate(swim * 0.34);
    blitSprite(ctx, sprite('heavytail|' + e.type, [r * 0.75, r * 0.22, r * 0.6, r * 0.6],
      (c) => paintHeavyTail(c, r, col)));
    ctx.restore();

    blitSprite(ctx, sprite('heavy|' + e.type, [r * 1.15, r * 1.2, r * 1.35, r * 0.85],
      (c) => paintHeavyBody(c, e.type, r, col)));
  }

  function drawTusks(ctx, r, s) {
    ctx.fillStyle = '#f2e9d4';
    ctx.beginPath();
    ctx.moveTo(r * 0.98, r * 0.2);
    ctx.quadraticCurveTo(r * 1.05, r * 0.5 * s, r * 1.18, r * 0.58 * s);
    ctx.quadraticCurveTo(r * 1.16, r * 0.34, r * 1.16, r * 0.22);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(r * 0.8, r * 0.24);
    ctx.quadraticCurveTo(r * 0.84, r * 0.52 * s, r * 0.94, r * 0.62 * s);
    ctx.quadraticCurveTo(r * 0.95, r * 0.36, r * 0.97, r * 0.24);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(120,100,70,0.4)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(r * 1.02, r * 0.3); ctx.quadraticCurveTo(r * 1.08, r * 0.45 * s, r * 1.16, r * 0.54 * s); ctx.stroke();
  }
  function scarPair(ctx, r) {
    ctx.strokeStyle = 'rgba(240,225,205,0.55)'; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(-r * 0.15, -r * 0.5); ctx.lineTo(r * 0.12, -r * 0.24); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-r * 0.05, -r * 0.52); ctx.lineTo(r * 0.22, -r * 0.26); ctx.stroke();
  }

  /* ---------- projectiles & effects ---------- */
  /* Reused between frames; see the note on zEnemies at the bottom of the file. */
  const shotOwners = new Map();
  function drawProjectiles(ctx, game) {
    if (!game.projectiles.length) return;
    /* Every shot in the air had to be asked which Bro fired it, and the
       answer was a fresh closure and a walk down the whole tower list. A busy
       board keeps a hundred shots alive over forty Bros, so that was four
       thousand comparisons a frame to recover a word that never changes for the
       life of the shot. One pass over the towers instead. A shot whose Bro
       has been sold mid-flight still finds nothing and still falls back to a
       grey pebble, exactly as before. */
    shotOwners.clear();
    for (const tw of game.towers) shotOwners.set(tw.id, tw.type);
    for (const pr of game.projectiles) {
      if (pr.kind === 'lob') {
        const f = pr.t / pr.T;
        const x = pr.sx + (pr.tx - pr.sx) * f;
        const y = pr.sy + (pr.ty - pr.sy) * f - Math.sin(f * Math.PI) * 90;
        ctx.fillStyle = 'rgba(30,50,70,0.18)';
        ctx.beginPath(); ctx.ellipse(pr.sx + (pr.tx - pr.sx) * f, pr.sy + (pr.ty - pr.sy) * f + 4, 6, 2.5, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#3b4a58';
        ctx.beginPath(); ctx.arc(x, y, 7, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.beginPath(); ctx.arc(x - 2, y - 2, 2.5, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(200,80,80,0.35)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(pr.tx, pr.ty, 10, 0, TAU); ctx.stroke();
      } else {
        const type = shotOwners.get(pr.owner) || 'pebble';
        // motion streak behind every shot
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(pr.x - pr.vx * 0.05, pr.y - pr.vy * 0.05);
        ctx.lineTo(pr.x, pr.y);
        ctx.stroke();
        ctx.save();
        ctx.translate(pr.x, pr.y);
        ctx.rotate(Math.atan2(pr.vy, pr.vx));
        if (type === 'torpedo') {
          ctx.fillStyle = '#37474f'; ctx.fillRect(-8, -3, 16, 6);
          ctx.fillStyle = '#e05252'; ctx.fillRect(4, -3, 4, 6);
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.beginPath(); ctx.arc(-10, 0, 3, 0, TAU); ctx.fill();
        } else if (type === 'snowball' || type === 'pebble') {
          ctx.fillStyle = type === 'snowball' ? '#f4f8fb' : '#8d9aa5';
          ctx.beginPath(); ctx.arc(0, 0, type === 'snowball' ? 8 : 4, 0, TAU); ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1; ctx.stroke();
        } else if (type === 'aurora' || type === 'witch') {
          const col = type === 'aurora' ? '#9be8c8' : '#c98ef2';
          ctx.fillStyle = col;
          ctx.save(); ctx.globalAlpha = 0.3;
          ctx.beginPath(); ctx.ellipse(-6, 0, 14, 6, 0, 0, TAU); ctx.fill();
          ctx.restore();
          ctx.beginPath(); ctx.ellipse(0, 0, 9, 4, 0, 0, TAU); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
          ctx.beginPath(); ctx.ellipse(-2, 0, 4, 2, 0, 0, TAU); ctx.fill();
        } else if (type === 'shards' || type === 'shadow') {
          ctx.fillStyle = '#bfe3f2';
          ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -3); ctx.lineTo(-2, 0); ctx.lineTo(-4, 3); ctx.closePath(); ctx.fill();
        } else if (type === 'glacier') {
          ctx.fillStyle = '#a8c8e8';
          ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(2, -6); ctx.lineTo(-6, -3); ctx.lineTo(-5, 4); ctx.lineTo(2, 6); ctx.closePath(); ctx.fill();
        } else if (type === 'slush') {
          ctx.fillStyle = 'rgba(130,210,235,0.85)';
          ctx.beginPath(); ctx.arc(0, 0, 6, 0, TAU); ctx.fill();
        } else {
          ctx.fillStyle = '#5d6d7e';
          ctx.beginPath(); ctx.arc(0, 0, 4, 0, TAU); ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  function drawEffects(ctx, game) {
    for (const fx of game.effects) {
      const f = fx.life / fx.max;
      if (fx.kind === 'boom') {
        const spread = fx.r * (1.25 - f);
        ctx.fillStyle = `rgba(255,180,90,${f * 0.55})`;
        ctx.beginPath(); ctx.arc(fx.x, fx.y, spread, 0, TAU); ctx.fill();
        ctx.fillStyle = `rgba(255,240,200,${f * 0.8})`;
        ctx.beginPath(); ctx.arc(fx.x, fx.y, spread * 0.45, 0, TAU); ctx.fill();
        ctx.strokeStyle = `rgba(255,240,220,${f * 0.9})`; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(fx.x, fx.y, spread, 0, TAU); ctx.stroke();
        // flying debris sparks
        ctx.fillStyle = `rgba(255,200,120,${f})`;
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * TAU + fx.x * 0.01;
          const d = spread * 1.25;
          ctx.beginPath(); ctx.arc(fx.x + Math.cos(a) * d, fx.y + Math.sin(a) * d, 3.2 * f + 1, 0, TAU); ctx.fill();
        }
      } else if (fx.kind === 'storm') {
        ctx.strokeStyle = `rgba(140,200,255,${f * 0.7})`; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(fx.x, fx.y, fx.r * (1 - f * 0.5), 0, TAU); ctx.stroke();
        ctx.fillStyle = `rgba(200,230,255,${f * 0.12})`;
        ctx.beginPath(); ctx.arc(fx.x, fx.y, fx.r, 0, TAU); ctx.fill();
      } else if (fx.kind === 'ray' || fx.kind === 'snipeTrack') {
        const beam = fx.kind === 'ray';
        ctx.lineCap = 'round';
        ctx.strokeStyle = beam ? `rgba(255,200,90,${f * 0.3})` : `rgba(200,220,240,${f * 0.3})`;
        ctx.lineWidth = beam ? 11 : 7;
        ctx.beginPath(); ctx.moveTo(fx.x, fx.y); ctx.lineTo(fx.tx, fx.ty); ctx.stroke();
        ctx.strokeStyle = beam ? `rgba(255,200,90,${f * 0.85})` : `rgba(210,228,244,${f * 0.85})`;
        ctx.lineWidth = beam ? 5 : 3;
        ctx.beginPath(); ctx.moveTo(fx.x, fx.y); ctx.lineTo(fx.tx, fx.ty); ctx.stroke();
        ctx.strokeStyle = `rgba(255,255,255,${f})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(fx.x, fx.y); ctx.lineTo(fx.tx, fx.ty); ctx.stroke();
        // impact flash at the target end
        ctx.fillStyle = `rgba(255,245,220,${f * 0.9})`;
        ctx.beginPath(); ctx.arc(fx.tx, fx.ty, (beam ? 10 : 7) * (1.4 - f), 0, TAU); ctx.fill();
      } else if (fx.kind === 'pop') {
        ctx.fillStyle = `rgba(255,255,255,${f})`;
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * TAU;
          const d = (1 - f) * 26;
          ctx.beginPath(); ctx.arc(fx.x + Math.cos(a) * d, fx.y + Math.sin(a) * d, 3.6 * f, 0, TAU); ctx.fill();
        }
      } else if (fx.kind === 'devour') {
        // a red bloom in the water and a ring of spray where the vacuum was
        ctx.fillStyle = `rgba(168,32,38,${f * 0.5})`;
        ctx.beginPath(); ctx.arc(fx.x, fx.y, (1 - f) * (fx.r + 16) + 6, 0, TAU); ctx.fill();
        ctx.fillStyle = `rgba(240,250,255,${f * 0.85})`;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU + fx.r;
          const d = (1 - f) * 22 + 4;
          ctx.beginPath(); ctx.arc(fx.x + Math.cos(a) * d, fx.y + Math.sin(a) * d, 2.6 * f, 0, TAU); ctx.fill();
        }
      } else if (fx.kind === 'bossDeath') {
        ctx.fillStyle = `rgba(255,190,90,${f * 0.6})`;
        ctx.beginPath(); ctx.arc(fx.x, fx.y, (1 - f) * 90 + 20, 0, TAU); ctx.fill();
      } else if (fx.kind === 'muzzle') {
        // star-burst flash at the muzzle
        const d = 20 + (1 - f) * 8;
        ctx.save();
        ctx.translate(fx.x + Math.cos(fx.a) * d, fx.y + Math.sin(fx.a) * d);
        ctx.rotate(fx.a);
        ctx.fillStyle = `rgba(255,215,120,${f * 0.9})`;
        ctx.beginPath();
        ctx.moveTo(-5, 0); ctx.lineTo(5, -7); ctx.lineTo(16, 0); ctx.lineTo(5, 7);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = `rgba(255,255,240,${f})`;
        ctx.beginPath(); ctx.arc(2, 0, 5 * f + 2, 0, TAU); ctx.fill();
        ctx.restore();
      } else if (fx.kind === 'hit') {
        ctx.strokeStyle = `rgba(255,255,255,${f * 0.95})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(fx.x, fx.y, 12 * (1 - f) + 3, 0, TAU); ctx.stroke();
        ctx.fillStyle = `rgba(255,255,255,${f})`;
        ctx.beginPath(); ctx.arc(fx.x, fx.y, 3.5 * f + 1.5, 0, TAU); ctx.fill();
      } else if (fx.kind === 'leak') {
        ctx.fillStyle = `rgba(224,82,82,${f * 0.6})`;
        ctx.beginPath(); ctx.arc(fx.x, fx.y, (1 - f) * 40 + 10, 0, TAU); ctx.fill();
      } else if (fx.kind === 'knock') {
        /* Knockback. The vacuum jumps backwards down the track, which on its
           own reads as a glitch — this is the shove that explains it. */
        if (fx.e && !fx.e.dead) {
          const p = G.samplePath(game.paths[fx.e.pathIdx], fx.e.dist);
          ctx.strokeStyle = `rgba(210,235,255,${f * 0.85})`;
          ctx.lineWidth = 2.5;
          for (let i = 0; i < 3; i++) {
            const r = fx.e.size + 4 + i * 5 + (1 - f) * 8;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, Math.PI * 0.72, Math.PI * 1.28);
            ctx.stroke();
          }
        }
      } else if (fx.kind === 'spikeHit') {
        ctx.fillStyle = `rgba(180,220,250,${f})`;
        ctx.beginPath(); ctx.arc(fx.x, fx.y, 6 * (1 - f) + 2, 0, TAU); ctx.fill();
      }
    }
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const tx of game.texts) {
      if (tx.e && !tx.anchored) {
        const p = G.samplePath(game.paths[tx.e.pathIdx], tx.e.dist);
        tx.x = p.x; tx.y = p.y; tx.anchored = true;
      }
      ctx.fillStyle = `rgba(90,180,110,${tx.life})`;
      ctx.fillText(tx.txt, tx.x, tx.y - (0.9 - tx.life) * 40 - 10);
    }
  }

  /* Ground zones — craters, slicks, wakes, aurora fire, corrupt stains,
     squalls, quagmires. Drawn under everything, on the track itself, because
     the whole point is that the ground is doing the work: a patch you cannot
     see is a slow you cannot explain. Each tone is its own hue so a burning
     crater never reads as a chilling one. */
  const ZONE_TONES = {
    ice:    { fill: 'rgba(150, 214, 245, 0.20)', edge: 'rgba(190, 234, 255, 0.55)' },
    fire:   { fill: 'rgba(255, 150, 60, 0.20)',  edge: 'rgba(255, 200, 120, 0.55)' },
    aurora: { fill: 'rgba(110, 235, 175, 0.20)', edge: 'rgba(160, 255, 210, 0.55)' },
    curse:  { fill: 'rgba(160, 110, 220, 0.22)', edge: 'rgba(200, 160, 245, 0.55)' },
    oil:    { fill: 'rgba(40, 50, 70, 0.30)',    edge: 'rgba(120, 140, 175, 0.5)' },
    slush:  { fill: 'rgba(90, 190, 210, 0.24)',  edge: 'rgba(150, 225, 240, 0.55)' },
  };
  function drawZones(ctx, game, t) {
    if (!game.zones || !game.zones.length) return;
    ctx.save();
    /* One fill per patch, and no outline.
       A translucent circle costs FILL RATE, not JS, so nothing here is won by
       being clever about the arc calls — measured, batching every patch of a
       tone into a single path saved 0.3ms on forty big ones and cost 2.4ms on
       a hundred and sixty small ones, because the rasteriser then has to
       resolve the whole self-overlapping path at once. Straightforward is
       faster and it reads better.

       The dashed outline is gone. On a full-range ring that was a ~1,250px
       stroked, dashed path per patch per frame, and it bought a shimmer nobody
       asked for. The fill alone says "this ground is doing something".

       What actually keeps this cheap is upstream: dropZone refreshes a patch
       that is already there instead of stacking another on top of it. */
    ctx.lineWidth = 1.4;
    for (const z of game.zones) {
      const life = Math.max(0, Math.min(1, (z.until - game.time) / (z.life || 1)));
      const tone = ZONE_TONES[z.tone] || ZONE_TONES.ice;
      ctx.globalAlpha = 0.3 + life * 0.7;
      ctx.fillStyle = tone.fill;
      ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, TAU); ctx.fill();
    }
    ctx.restore();   // takes the alpha back with it
  }

  function paintSpikePile(ctx, n) {
    ctx.fillStyle = '#cfe4f4';
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const d = 7;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * d - 3, Math.sin(a) * d + 2);
      ctx.lineTo(Math.cos(a) * d, Math.sin(a) * d - 9);
      ctx.lineTo(Math.cos(a) * d + 3, Math.sin(a) * d + 2);
      ctx.closePath(); ctx.fill();
    }
  }

  function drawSpikes(ctx, game, t) {
    for (const p of game.piles) {
      ctx.save();
      ctx.translate(p.x, p.y);
      if (p.mine) {
        /* A drift mine: a dark float with a blinking eye. It has to read as
           "do not walk here" at a glance, and nothing like a wall of spikes. */
        ctx.fillStyle = '#1b2735';
        ctx.beginPath(); ctx.arc(0, 0, 8, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#5a7086'; ctx.lineWidth = 1.5;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU + t * 0.4;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * 7, Math.sin(a) * 7);
          ctx.lineTo(Math.cos(a) * 12, Math.sin(a) * 12);
          ctx.stroke();
        }
        ctx.fillStyle = `rgba(255,90,80,${0.45 + Math.sin(t * 5) * 0.35})`;
        ctx.beginPath(); ctx.arc(0, 0, 3, 0, TAU); ctx.fill();
      } else if (p.decoy) {
        // An ice-double of the diver: a glittering shard that shatters underfoot
        ctx.globalAlpha = 0.55 + Math.sin(t * 4) * 0.2;
        ctx.fillStyle = '#bfe8ff';
        ctx.beginPath();
        ctx.moveTo(0, -14); ctx.lineTo(7, 0); ctx.lineTo(0, 13); ctx.lineTo(-7, 0);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = '#e8f6ff';
        for (let i = 0; i < p.charges; i++) {
          ctx.beginPath(); ctx.arc(-5 + i * 5, -18, 1.6, 0, TAU); ctx.fill();
        }
      } else {
        /* A plain spike pile has no clock in it at all: how many spikes, and
           that is the whole of it. Six possible piles, and an icewall board can
           carry forty of them at once. */
        const n = Math.min(6, Math.ceil(p.charges / 2) + 1);
        blitSprite(ctx, sprite('pile|' + n, [11, 11, 17, 10], (c) => paintSpikePile(c, n)));
      }
      ctx.restore();
    }
  }

  /* Everything this Bro CANNOT shoot: the wedge of ground each standing
     obstacle hides from it, clipped to its range. Without this the sight rule
     is invisible — you build, the Bro refuses to fire, and nothing on
     screen tells you why. Drawn for the selected Bro and for the
     placement ghost, so you can see the dead ground before you spend studs. */
  function drawSightShadow(ctx, game, x, y, range, tone) {
    if (!game.sightBlockers || !game.sightBlockers.length || !(range > 0) || range >= 5000) return;
    let drew = false;
    ctx.save();
    for (const o of game.sightBlockers) {
      const dx = o.x - x, dy = o.y - y;
      const d = Math.hypot(dx, dy);
      if (d <= o.r || d - o.r > range) continue;      // inside it, or too far to matter
      const half = Math.asin(Math.min(1, o.r / d));
      const th = Math.atan2(dy, dx);
      const tan = Math.sqrt(Math.max(1, d * d - o.r * o.r));   // where the shadow starts
      const a0 = th - half, a1 = th + half;
      if (!drew) {
        ctx.fillStyle = tone || 'rgba(214,72,72,0.30)';
        drew = true;
      }
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a0) * tan, y + Math.sin(a0) * tan);
      ctx.lineTo(x + Math.cos(a0) * range, y + Math.sin(a0) * range);
      ctx.arc(x, y, range, a0, a1);
      ctx.lineTo(x + Math.cos(a1) * tan, y + Math.sin(a1) * tan);
      ctx.closePath();
      ctx.fill();
      // outline the culprit so it is obvious which lump is in the way
      ctx.save();
      ctx.strokeStyle = 'rgba(240,120,120,0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  /* ---------- range circles & placement ghost ---------- */
  function drawOverlays(ctx, game) {
    const sel = game.selected;
    const hov = game.hoverTower;
    if (hov && hov !== sel && !game.placingType) {
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(hov.x, hov.y, 24, 0, TAU); ctx.stroke();
      if (hov.calc.range > 0 && hov.calc.range < 5000) {
        ctx.strokeStyle = 'rgba(120,170,220,0.22)';
        ctx.beginPath(); ctx.arc(hov.x, hov.y, hov.calc.range * hov.buff.range, 0, TAU); ctx.stroke();
      }
    }
    if (sel) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash([9, 7]);
      ctx.lineDashOffset = -clock * 26;
      ctx.beginPath(); ctx.arc(sel.x, sel.y, 25, 0, TAU); ctx.stroke();
      ctx.restore();
      if (sel.calc.range > 0 && sel.calc.range < 5000) {
        const range = sel.calc.range * sel.buff.range;
        ctx.fillStyle = 'rgba(120,170,220,0.12)';
        ctx.strokeStyle = 'rgba(120,170,220,0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sel.x, sel.y, range, 0, TAU); ctx.fill(); ctx.stroke();
        // howitzers and storms arc over terrain, so they cast no shadow
        if (!G.arcsOverTerrain(sel.calc)) drawSightShadow(ctx, game, sel.x, sel.y, range);
      }
      if (sel.calc.minRange) {
        ctx.fillStyle = 'rgba(220,120,120,0.12)';
        ctx.beginPath(); ctx.arc(sel.x, sel.y, sel.calc.minRange, 0, TAU); ctx.fill();
      }
    }
    if (game.placingType) {
      const def = G.TOWERS[game.placingType];
      const { x, y } = game.mouse;
      if (x > -100) {
        const ok = game.canPlace(game.placingType, x, y);
        /* Effective range, not the raw stat — the ghost was drawing the
           pre-nerf circle and promising reach the placed Bro wouldn't have. */
        const range = (G.computeEffective(game.placingType, [0, 0, 0]).range || 60);
        ctx.fillStyle = ok ? 'rgba(110,200,130,0.15)' : 'rgba(220,110,110,0.18)';
        ctx.strokeStyle = ok ? 'rgba(110,200,130,0.6)' : 'rgba(220,110,110,0.6)';
        ctx.lineWidth = 2;
        if (range > 0 && range < 5000) {
          ctx.beginPath(); ctx.arc(x, y, range, 0, TAU); ctx.fill(); ctx.stroke();
          // show the dead ground BEFORE the studs is spent
          if (!G.arcsOverTerrain(def.stats)) drawSightShadow(ctx, game, x, y, range);
        }
        ctx.globalAlpha = 0.75;
        drawBro(ctx, x, y, 15, game.placingType, null, 0);
        ctx.globalAlpha = 1;
        if (!ok) {
          ctx.strokeStyle = '#d04545'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(x - 12, y - 12); ctx.lineTo(x + 12, y + 12); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x + 12, y - 12); ctx.lineTo(x - 12, y + 12); ctx.stroke();
        }
      }
    }

    if (game.paused) {
      ctx.fillStyle = 'rgba(10,16,26,0.45)';
      ctx.fillRect(0, 0, G.W, G.H);
      ctx.textAlign = 'center';
      ctx.font = '800 46px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillText('⏸  PAUSED', G.W / 2, G.H / 2 - 10);
      ctx.font = '500 17px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText('Press P or Esc to continue', G.W / 2, G.H / 2 + 26);
    }
  }

  /* ---------- main render ---------- */
  let clock = 0;
  /* Reused between frames instead of two fresh arrays a frame. At ninety
     vacuums and thirty Bros that is 7,200 throwaway array slots a second
     handed to the garbage collector for nothing. */
  const zEnemies = [], zTowers = [];
  function ordered(into, from, key) {
    into.length = 0;
    for (let i = 0; i < from.length; i++) into.push(from[i]);
    into.sort(key);
    return into;
  }

  G.render = function (ctx, game, dt) {
    clock += dt;
    syncSpriteScale(ctx);
    const terr = getTerrain(game.level, G.W, game.endless && game.wave >= G.HEAVY_WAVE);
    ctx.drawImage(terr.canvas, 0, 0, G.W, G.H);
    drawSceneryFX(ctx, game.level, terr.meta, clock);
    drawZones(ctx, game, clock);
    drawSpikes(ctx, game, clock);
    const sorted = ordered(zEnemies, game.enemies, (a, b) => a.dist - b.dist);
    // painter's order: lower towers draw over higher ones for a depth cue
    for (const t of ordered(zTowers, game.towers, (a, b) => a.y - b.y)) drawTowerBody(ctx, game, t, clock);
    for (const e of sorted) drawVac(ctx, game, e, clock);
    drawProjectiles(ctx, game);
    drawEffects(ctx, game);
    drawSnowfall(ctx, clock);
    drawOverlays(ctx, game);
  };

  /* ---------- shop icons ---------- */
  G.drawTowerIcon = function (canvas, typeId, up) {
    const ctx = canvas.getContext('2d');
    const s = canvas.width;
    ctx.clearRect(0, 0, s, s);
    if (typeId === 'fort') {
      drawFort(ctx, s / 2, s / 2 + 6, s * 0.3);
      drawBro(ctx, s * 0.74, s * 0.66, s * 0.15, typeId, null, 0, up);
    } else if (typeId === 'vendor') {
      ctx.save(); ctx.translate(s / 2, s / 2);
      ctx.fillStyle = '#8a5a33'; ctx.fillRect(-s * 0.32, 0, s * 0.64, s * 0.22);
      ctx.fillStyle = '#d9534f'; ctx.fillRect(-s * 0.36, -s * 0.14, s * 0.72, s * 0.14);
      ctx.fillStyle = '#f8f9fa'; ctx.fillRect(-s * 0.36, -s * 0.14, s * 0.18, s * 0.14); ctx.fillRect(0, -s * 0.14, s * 0.18, s * 0.14);
      ctx.restore();
      drawBro(ctx, s * 0.72, s * 0.68, s * 0.16, typeId, null, 0, up);
    } else if (typeId === 'torpedo' || typeId === 'depth') {
      ctx.fillStyle = typeId === 'torpedo' ? '#5a748c' : '#7a5c3e';
      ctx.beginPath(); ctx.ellipse(s / 2, s * 0.72, s * 0.36, s * 0.13, 0, 0, TAU); ctx.fill();
      drawBro(ctx, s / 2, s / 2, s * 0.27, typeId, null, 0, up);
    } else {
      drawBro(ctx, s / 2, s / 2 + 2, s * 0.28, typeId, null, 0, up);
    }
  };

  /* ---------- level thumbnails (real terrain, scaled) ---------- */
  G.drawLevelThumb = function (canvas, level) {
    const ctx = canvas.getContext('2d');
    // thumbs are drawn for every level at once — borrow the world size, then restore
    const keepW = G.W, keepH = G.H;
    G.setDims(level);
    const terr = getTerrain(level, canvas.width);
    ctx.drawImage(terr.canvas, 0, 0, canvas.width, canvas.height);
    const p0 = level.paths[0];
    const sx = canvas.width / G.W, sy = canvas.height / G.H;
    ctx.fillStyle = '#d9534f';
    ctx.beginPath(); ctx.arc(Math.max(5, Math.min(canvas.width - 5, p0[0].x * sx)), Math.max(5, Math.min(canvas.height - 5, p0[0].y * sy)), 3.5, 0, TAU); ctx.fill();
    const pe = p0[p0.length - 1];
    ctx.fillStyle = '#5fc26e';
    ctx.beginPath(); ctx.arc(Math.max(5, Math.min(canvas.width - 5, pe.x * sx)), Math.max(5, Math.min(canvas.height - 5, pe.y * sy)), 3.5, 0, TAU); ctx.fill();
    G.W = keepW; G.H = keepH;
  };
})();
