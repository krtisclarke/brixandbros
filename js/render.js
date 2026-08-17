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
  /* Raised from 8e6 when the Bros were drawn half again as large. A sheet's
     cost is r², so the figures went from ~4k device pixels each to ~10k, and
     the old ceiling left a heavy board close enough to the cliff described
     above to fall off it. Twenty-two million is about 88MB and still well under
     what the drawing it replaces would cost. */
  const SPRITE_PIXELS = 2.2e7;

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
  /* Dust in the air, lit by the low sun. It was snow; it is the same drifting
     motes at a fraction of the opacity, because a board covered in vacuum
     cleaners should look like somewhere that needs vacuuming — and because
     bright white specks on a green plate read as a rendering fault. */
  function drawSnowfall(ctx, t) {
    ctx.fillStyle = 'rgba(255,250,235,0.22)';
    ctx.beginPath();
    for (const f of flakes) {
      const y = (f.fy * G.H + t * f.s * 0.35) % G.H;
      const x = f.fx * G.W + Math.sin(t * 0.6 + f.drift) * 22;
      ctx.moveTo(x + f.r * 0.7, y);
      ctx.arc(x, y, f.r * 0.7, 0, TAU);
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

    /* --- the baseplate ---
       The whole board is one giant building plate, and the studs are what say
       so. They are drawn once into this canvas and never again — the terrain
       is baked per battlefield, not per frame — so a thousand of them cost
       nothing at all after the first paint.

       STUD_PITCH is the only number that matters here. Too fine and it reads as
       texture noise at phone size; too coarse and the board stops looking like
       a building plate and starts looking like polka dots. 32 puts 40 studs
       across a tier-1 map, which is close to what a real plate of this
       proportion would carry. */
    const dk = !!th.dark;
    const bg = c.createLinearGradient(0, 0, 0, G.H);
    bg.addColorStop(0, th.snow);
    bg.addColorStop(1, th.ice);
    c.fillStyle = bg;
    c.fillRect(0, 0, G.W, G.H);

    // low sun from the top-left, the same direction everything else is lit from
    const sun = c.createLinearGradient(0, 0, G.W, G.H);
    sun.addColorStop(0, dk ? 'rgba(196,214,255,0.10)' : 'rgba(255,250,225,0.22)');
    sun.addColorStop(0.45, 'rgba(255,244,214,0)');
    sun.addColorStop(1, dk ? 'rgba(10,16,40,0.26)' : 'rgba(40,60,90,0.18)');
    c.fillStyle = sun;
    c.fillRect(0, 0, G.W, G.H);

    const STUD_PITCH = 32, STUD_R = 9.5;
    /* Plate seams every eight studs. Real plates come in fixed sizes and butt
       up against each other, and the seam is the difference between "a board
       built out of plates" and "a green rectangle with dots on it". */
    const SEAM = STUD_PITCH * 8;
    c.strokeStyle = dk ? 'rgba(8,14,34,0.30)' : 'rgba(20,32,50,0.13)';
    c.lineWidth = 1.5;
    for (let x = SEAM; x < G.W; x += SEAM) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, G.H); c.stroke(); }
    for (let y = SEAM; y < G.H; y += SEAM) { c.beginPath(); c.moveTo(0, y); c.lineTo(G.W, y); c.stroke(); }

    for (let gy = STUD_PITCH / 2; gy < G.H; gy += STUD_PITCH) {
      for (let gx = STUD_PITCH / 2; gx < G.W; gx += STUD_PITCH) {
        // the shadow the stud casts down-right, then the stud, then its highlight
        c.fillStyle = dk ? 'rgba(6,10,26,0.42)' : 'rgba(24,38,58,0.20)';
        c.beginPath(); c.arc(gx + 1.6, gy + 2.0, STUD_R, 0, TAU); c.fill();
        c.fillStyle = dk ? 'rgba(190,205,240,0.10)' : 'rgba(255,255,255,0.20)';
        c.beginPath(); c.arc(gx, gy, STUD_R, 0, TAU); c.fill();
        c.strokeStyle = dk ? 'rgba(210,225,255,0.16)' : 'rgba(255,255,255,0.42)';
        c.lineWidth = 1.4;
        c.beginPath(); c.arc(gx - 0.4, gy - 0.6, STUD_R - 0.8, Math.PI * 0.85, Math.PI * 1.85); c.stroke();
      }
    }

    /* A few plates in a slightly different shade, snapped to the seam grid.
       Nobody builds a big board out of one colour of plate, and the variation
       is what stops the whole thing reading as printed wallpaper. */
    for (let i = 0; i < 6; i++) {
      const px = Math.floor(rnd() * (G.W / SEAM)) * SEAM;
      const py = Math.floor(rnd() * (G.H / SEAM)) * SEAM;
      const wide = SEAM * (1 + (rnd() * 2 | 0));
      c.fillStyle = rnd() > 0.5
        ? (dk ? 'rgba(200,215,250,0.05)' : 'rgba(255,255,255,0.10)')
        : (dk ? 'rgba(6,12,34,0.10)' : 'rgba(30,48,74,0.07)');
      c.fillRect(px, py, wide, SEAM);
    }

    // scattered loose bricks, dropped on the plate and never tidied away
    const looseCols = ['#c8443c', '#3f7fd4', '#e8b93c', '#3fae6a', '#f2f4f6'];
    for (let i = 0; i < 26; i++) {
      const x = rnd() * G.W, y = rnd() * G.H;
      c.save();
      c.translate(x, y); c.rotate(rnd() * 3);
      c.globalAlpha = 0.55 + rnd() * 0.3;
      c.fillStyle = 'rgba(20,32,50,0.25)';
      c.fillRect(-5, -3, 12, 7);
      c.fillStyle = looseCols[(rnd() * looseCols.length) | 0];
      c.fillRect(-6, -4, 12, 7);
      c.fillStyle = 'rgba(255,255,255,0.35)';
      c.fillRect(-6, -4, 12, 2.2);
      c.restore();
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

  /* ---- pools, built rather than poured ----
     Water in a brick build is transparent blue plates set into the board, and
     the thing that sells it is that the studs LINE UP with the ground around
     them. So this draws on the same STUD_PITCH grid the baseplate uses, offset
     by nothing — a pool is part of the same plate, in a different colour.

     What it deliberately does not have: gradients, foam, current lines and sun
     glitter. Those were painting a liquid. Everything here is a flat plate with
     a highlight on the stud, exactly like the green around it. */
  function studGrid(c, x0, y0, x1, y1, clip, col, alpha) {
    const P = 32, R = 9.5;
    const gx0 = Math.floor((x0 - P) / P) * P + P / 2;
    const gy0 = Math.floor((y0 - P) / P) * P + P / 2;
    for (let gy = gy0; gy < y1 + P; gy += P) {
      for (let gx = gx0; gx < x1 + P; gx += P) {
        if (clip && !clip(gx, gy)) continue;
        c.globalAlpha = alpha * 0.55;
        c.fillStyle = 'rgba(6,26,50,0.9)';
        c.beginPath(); c.arc(gx + 1.6, gy + 2.0, R, 0, TAU); c.fill();
        c.globalAlpha = alpha;
        c.fillStyle = col;
        c.beginPath(); c.arc(gx, gy, R, 0, TAU); c.fill();
        c.globalAlpha = alpha * 0.9;
        c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 1.4;
        c.beginPath(); c.arc(gx - 0.4, gy - 0.6, R - 0.8, Math.PI * 0.85, Math.PI * 1.85); c.stroke();
      }
    }
    c.globalAlpha = 1;
  }

  function drawWaterBody(c, wt, th, rnd) {
    const deep = th.deep || '#2e6da4';
    const shore = th.shore || '#bfe0ea';

    if (wt.rect) {
      const { x, y, w, h } = wt.rect;
      /* A channel is built out of whole plates, so its banks step on the grid
         rather than waving. Straight edges are what make it read as assembled;
         a wobbly bank is a river, and there are no rivers on a building
         plate. */
      const P = 32;
      const top = Math.round(y / P) * P, bot = Math.round((y + h) / P) * P;

      // the shallow band along each bank, one plate wide
      c.fillStyle = shore;
      c.fillRect(x, top - P, w, P);
      c.fillRect(x, bot, w, P);
      // the deep channel
      c.fillStyle = deep;
      c.fillRect(x, top, w, bot - top);

      c.save();
      c.beginPath(); c.rect(x, top - P, w, (bot - top) + P * 2); c.clip();
      studGrid(c, x, top - P, x + w, bot + P, null, 'rgba(150,215,255,0.30)', 1);
      c.restore();

      // the raised lip where the plate steps down into the channel
      c.strokeStyle = 'rgba(255,255,255,0.45)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(x, top + 1); c.lineTo(x + w, top + 1); c.stroke();
      c.strokeStyle = 'rgba(8,28,54,0.45)'; c.lineWidth = 2.5;
      c.beginPath(); c.moveTo(x, top - P + 1); c.lineTo(x + w, top - P + 1); c.stroke();
      c.beginPath(); c.moveTo(x, bot + P - 1); c.lineTo(x + w, bot + P - 1); c.stroke();

      for (let i = 0; i < Math.max(2, w / 400 | 0); i++) {
        drawFloe(c, x + 40 + rnd() * (w - 80), top + 18 + rnd() * ((bot - top) - 36), 10 + rnd() * 14, rnd);
      }
    } else {
      /* A round pool is built the way a builder actually builds one: a ring of
         shallow plate around a deeper middle, both stepped to the grid. */
      const R = wt.r;
      c.fillStyle = shore;
      c.beginPath(); c.arc(wt.x, wt.y, R + 10, 0, TAU); c.fill();
      c.fillStyle = deep;
      c.beginPath(); c.arc(wt.x, wt.y, R, 0, TAU); c.fill();
      c.fillStyle = shade(deep, -22);
      c.beginPath(); c.arc(wt.x, wt.y, R * 0.55, 0, TAU); c.fill();

      c.save();
      c.beginPath(); c.arc(wt.x, wt.y, R + 10, 0, TAU); c.clip();
      studGrid(c, wt.x - R - 12, wt.y - R - 12, wt.x + R + 12, wt.y + R + 12, null,
        'rgba(150,215,255,0.30)', 1);
      c.restore();

      // stepped rim: a bright lip on the near side, a dark one on the far
      c.strokeStyle = 'rgba(8,28,54,0.45)'; c.lineWidth = 2.5;
      c.beginPath(); c.arc(wt.x, wt.y, R + 10, 0, TAU); c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.40)'; c.lineWidth = 2;
      c.beginPath(); c.arc(wt.x, wt.y, R, Math.PI * 0.12, Math.PI * 0.88); c.stroke();
      c.strokeStyle = 'rgba(8,28,54,0.30)'; c.lineWidth = 2;
      c.beginPath(); c.arc(wt.x, wt.y, R, Math.PI * 1.12, Math.PI * 1.88); c.stroke();

      if (R > 78) {
        drawFloe(c, wt.x - R * 0.35, wt.y + R * 0.3, R * 0.16, rnd);
        drawFloe(c, wt.x + R * 0.42, wt.y - R * 0.28, R * 0.13, rnd);
      }
    }
  }


  /* Bricks that fell in the pool. This was an ice floe, then a raft of pale
     plates that still read as one — white angular shapes on blue is an iceberg
     whatever the code calls it. So they are small, they are primary-coloured,
     they sit at scattered angles, and each one carries its two studs: at any
     size the thing your eye picks up is "brick", not "ice". */
  function drawFloe(c, x, y, r, rnd) {
    c.save();
    c.translate(x, y);
    const cols = ['#c8443c', '#3f7fd4', '#e8b93c', '#3fae6a'];
    const n = 2 + ((rnd() * 2) | 0);
    for (let i = 0; i < n; i++) {
      c.save();
      c.translate((rnd() - 0.5) * r * 1.4, (rnd() - 0.5) * r * 1.1);
      c.rotate(rnd() * TAU);
      const w = r * 0.62, h = r * 0.44;
      c.fillStyle = 'rgba(10,32,56,0.30)';
      c.fillRect(-w / 2 + r * 0.06, -h / 2 + r * 0.08, w, h);
      brickBit(c, 0, 0, w, h, cols[(rnd() * cols.length) | 0]);
      c.restore();
    }
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

    /* The track is SMOOTH TILE, and that is the whole idea.

       It read as a street before — centre line, kerbs, tarmac — which is a
       thing you drive on rather than a thing you built. The contrast a brick
       builder actually uses for a path is texture, not colour: flat tile with
       no studs, laid across a plate that has them. Studs everywhere, none on
       the path, and the path reads as laid without a single road marking.

       So this draws the tiles themselves — a butt joint every tile length, and
       one running down the middle where two rows of tile meet. */
    const TILE = 26;
    c.strokeStyle = 'rgba(20,26,34,0.22)';
    c.lineWidth = 1.2;
    for (let d = TILE; d < total; d += TILE) {
      const p = pathPoint(pts, d);
      const nx = Math.cos(p.ang + Math.PI / 2), ny = Math.sin(p.ang + Math.PI / 2);
      c.beginPath();
      c.moveTo(p.x + nx * -(G.PATH_HALF - 3), p.y + ny * -(G.PATH_HALF - 3));
      c.lineTo(p.x + nx * (G.PATH_HALF - 3), p.y + ny * (G.PATH_HALF - 3));
      c.stroke();
      // each tile catches the light along its leading edge
      c.strokeStyle = 'rgba(255,255,255,0.14)';
      c.beginPath();
      c.moveTo(p.x + nx * -(G.PATH_HALF - 3) + 1, p.y + ny * -(G.PATH_HALF - 3) + 1);
      c.lineTo(p.x + nx * (G.PATH_HALF - 3) + 1, p.y + ny * (G.PATH_HALF - 3) + 1);
      c.stroke();
      c.strokeStyle = 'rgba(20,26,34,0.22)';
    }

    // the seam down the middle, where the two rows of tile butt together
    c.strokeStyle = 'rgba(20,26,34,0.16)';
    c.lineWidth = 1.2;
    trace(); c.stroke();

    /* The tiles sit slightly proud of the plate, so the edge gets a lit lip on
       the sunward side and a shadow on the other. This is what makes the path
       read as laid ON the board rather than cut INTO it — the job the kerb
       studs were doing, done the way a real edge does it. */
    c.save();
    c.translate(-1.2, -1.6);
    trace(); c.strokeStyle = 'rgba(255,255,255,0.20)'; c.lineWidth = G.PATH_HALF * 2 + 3; c.stroke();
    c.restore();
    c.save();
    c.translate(1.2, 1.6);
    trace(); c.strokeStyle = 'rgba(14,22,34,0.20)'; c.lineWidth = G.PATH_HALF * 2 + 3; c.stroke();
    c.restore();
    trace(); c.strokeStyle = th.pathColor; c.lineWidth = G.PATH_HALF * 2 - 2; c.stroke();

    // faint wear down the two lines the wheels actually follow
    c.strokeStyle = 'rgba(18,24,32,0.07)';
    c.lineWidth = 7;
    for (const side of [-1, 1]) {
      c.beginPath();
      for (let d = 0; d <= total; d += 12) {
        const p = pathPoint(pts, d);
        const nx = Math.cos(p.ang + Math.PI / 2) * side * 9, ny = Math.sin(p.ang + Math.PI / 2) * side * 9;
        d ? c.lineTo(p.x + nx, p.y + ny) : c.moveTo(p.x + nx, p.y + ny);
      }
      c.stroke();
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
  /* A brick laid flat, seen from the same low angle everything else is: the
     top face, a lit front edge and two studs. Every prop below is built out of
     these, which is the point — the scenery has to look assembled, not grown. */
  function brickBlock(c, x, y, w, h, col, studs) {
    const top = shade(col, 26), side = shade(col, -34), edge = shade(col, -62);
    c.fillStyle = side;
    c.fillRect(x - w / 2, y - h, w, h);
    c.fillStyle = col;
    c.fillRect(x - w / 2, y - h, w, h * 0.62);
    c.fillStyle = top;
    c.fillRect(x - w / 2, y - h, w, h * 0.22);
    c.strokeStyle = edge; c.lineWidth = 1.1;
    c.strokeRect(x - w / 2, y - h, w, h);
    if (studs !== 0) {
      const n = studs || 2;
      for (let i = 0; i < n; i++) {
        const sx = x - w / 2 + w * ((i + 0.5) / n);
        c.fillStyle = top;
        c.beginPath(); c.ellipse(sx, y - h - h * 0.16, w / (n * 2.7), h * 0.16, 0, 0, TAU); c.fill();
        c.strokeStyle = edge; c.lineWidth = 0.9;
        c.beginPath(); c.ellipse(sx, y - h - h * 0.16, w / (n * 2.7), h * 0.16, 0, 0, TAU); c.stroke();
      }
    }
  }

  // a brick tree: a stacked trunk under three plates of foliage
  function drawPine(c, x, y, s, rnd) {
    propShadow(c, x, y + s * 0.9, s * 0.8);
    const green = ['#2f7c56', '#399165', '#2b6d4c'][(rnd() * 3) | 0];
    brickBlock(c, x, y + s * 0.95, s * 0.34, s * 0.5, '#7a5535', 1);
    for (let i = 0; i < 3; i++) {
      const w = s * (1.28 - i * 0.34), yy = y + s * 0.5 - i * s * 0.44;
      brickBlock(c, x, yy, w, s * 0.34, green, 0);
    }
    // the topper: one stud standing proud, like a real plate tree
    c.fillStyle = shade(green, 34);
    c.beginPath(); c.ellipse(x, y - s * 0.60, s * 0.13, s * 0.07, 0, 0, TAU); c.fill();
  }

  // brick flowers: a stem plate with a coloured stud on top
  function drawTuft(c, x, y, s, rnd) {
    const petals = ['#c8443c', '#e8b93c', '#f2f4f6', '#d96fa8'];
    for (let i = -1; i <= 1; i++) {
      const h = s * (1.1 + rnd() * 0.5);
      const px = x + i * s * 0.62;
      c.strokeStyle = '#3fae6a'; c.lineWidth = Math.max(1.4, s * 0.16); c.lineCap = 'round';
      c.beginPath(); c.moveTo(px, y); c.lineTo(px, y - h); c.stroke();
      const col = petals[(rnd() * petals.length) | 0];
      c.fillStyle = col;
      c.beginPath(); c.arc(px, y - h, s * 0.34, 0, TAU); c.fill();
      c.strokeStyle = shade(col, -50); c.lineWidth = 1; c.stroke();
      c.fillStyle = shade(col, 40);
      c.beginPath(); c.arc(px, y - h - s * 0.06, s * 0.14, 0, TAU); c.fill();
    }
  }

  // a pile of loose bricks nobody put away
  function drawStone(c, x, y, s, rnd) {
    propShadow(c, x, y + s * 0.4, s);
    const cols = ['#98a2ab', '#c8443c', '#3f7fd4', '#e8b93c'];
    for (let i = 0; i < 3; i++) {
      brickBlock(c,
        x + (rnd() - 0.5) * s * 0.9,
        y + s * 0.4 - i * s * 0.42,
        s * (1.0 + rnd() * 0.5), s * 0.4,
        cols[(rnd() * cols.length) | 0], 2);
    }
  }

  // brick plants: stems with leaf plates, for the water margins
  function drawReeds(c, x, y, s, rnd) {
    for (let i = -1; i <= 1; i++) {
      const px = x + i * s * 0.42, h = s * (1.2 + rnd() * 0.5);
      c.strokeStyle = '#3d7a4e'; c.lineWidth = Math.max(1.4, s * 0.13); c.lineCap = 'round';
      c.beginPath(); c.moveTo(px, y); c.lineTo(px + i * s * 0.2, y - h); c.stroke();
      c.fillStyle = '#4f9b5f';
      for (let k = 0; k < 2; k++) {
        const ly = y - h * (0.45 + k * 0.35);
        c.beginPath();
        c.ellipse(px + i * s * 0.12 + (k % 2 ? s * 0.3 : -s * 0.3), ly, s * 0.3, s * 0.11, k % 2 ? -0.4 : 0.4, 0, TAU);
        c.fill();
      }
    }
  }

  // a little brick figure on a plinth — the statue in the square
  function drawSnowman(c, x, y, s, rnd) {
    propShadow(c, x, y + s * 0.8, s * 0.9);
    brickBlock(c, x, y + s * 0.85, s * 1.5, s * 0.3, '#9aa4ae', 3);
    brickBlock(c, x, y + s * 0.55, s * 1.1, s * 0.26, '#b4bec8', 0);
    // legs, torso, head — the same figure the player fields, cast in one colour
    const cast = ['#c8443c', '#3f7fd4', '#e8b93c'][(rnd() * 3) | 0];
    c.fillStyle = shade(cast, -30);
    c.fillRect(x - s * 0.3, y - s * 0.1, s * 0.6, s * 0.66);
    c.fillStyle = cast;
    c.fillRect(x - s * 0.26, y - s * 0.62, s * 0.52, s * 0.54);
    c.fillStyle = shade(cast, -46);
    c.fillRect(x - s * 0.52, y - s * 0.5, s * 0.2, s * 0.4);
    c.fillRect(x + s * 0.32, y - s * 0.5, s * 0.2, s * 0.4);
    c.fillStyle = '#f2c033';
    c.fillRect(x - s * 0.24, y - s * 1.1, s * 0.48, s * 0.5);
    c.fillStyle = shade('#f2c033', -20);
    c.beginPath(); c.ellipse(x, y - s * 1.14, s * 0.1, s * 0.05, 0, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(20,30,44,0.5)'; c.lineWidth = 1;
    c.strokeRect(x - s * 0.24, y - s * 1.1, s * 0.48, s * 0.5);
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
  /* The Home Build — the thing the whole game is about protecting, and the
     small brick houses that stand around the map as no-build blockers. Same
     drawing, two sizes: a stepped brick tower with a door and a flag. */
  function drawFort(ctx, x, y, r, home) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(25,42,62,0.18)';
    ctx.beginPath(); ctx.ellipse(r * 0.25, 6, r * 1.15, r * 0.36, 0, 0, TAU); ctx.fill();

    const wall = home ? '#d94f42' : '#c8443c';
    const stone = home ? '#e8eaec' : '#d6d9dc';

    // three courses, each stepped in — a tower built rather than an igloo
    const courses = [
      { w: r * 2.0, h: r * 0.46, col: stone },
      { w: r * 1.66, h: r * 0.42, col: wall },
      { w: r * 1.28, h: r * 0.38, col: stone },
    ];
    let by = r * 0.2;
    for (const cs of courses) {
      ctx.fillStyle = shade(cs.col, -34);
      ctx.fillRect(-cs.w / 2, by - cs.h, cs.w, cs.h);
      ctx.fillStyle = cs.col;
      ctx.fillRect(-cs.w / 2, by - cs.h, cs.w, cs.h * 0.66);
      ctx.fillStyle = shade(cs.col, 26);
      ctx.fillRect(-cs.w / 2, by - cs.h, cs.w, cs.h * 0.2);
      ctx.strokeStyle = shade(cs.col, -60); ctx.lineWidth = 1.4;
      ctx.strokeRect(-cs.w / 2, by - cs.h, cs.w, cs.h);
      // studs along the top of the course
      const n = Math.max(2, Math.round(cs.w / (r * 0.42)));
      for (let i = 0; i < n; i++) {
        const sx = -cs.w / 2 + cs.w * ((i + 0.5) / n);
        ctx.fillStyle = shade(cs.col, 30);
        ctx.beginPath(); ctx.ellipse(sx, by - cs.h - cs.h * 0.13, r * 0.13, r * 0.06, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = shade(cs.col, -60); ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.ellipse(sx, by - cs.h - cs.h * 0.13, r * 0.13, r * 0.06, 0, 0, TAU); ctx.stroke();
      }
      by -= cs.h;
    }

    // the doorway the pack is heading for
    ctx.fillStyle = '#2f3b47';
    ctx.beginPath();
    ctx.moveTo(-r * 0.30, r * 0.2);
    ctx.lineTo(-r * 0.30, -r * 0.10);
    ctx.quadraticCurveTo(0, -r * 0.34, r * 0.30, -r * 0.10);
    ctx.lineTo(r * 0.30, r * 0.2);
    ctx.closePath(); ctx.fill();

    if (home) {
      ctx.fillStyle = '#8b98a5';
      ctx.fillRect(-2, -r * 1.35, 3, r * 0.62);
      ctx.fillStyle = '#e8b93c';
      ctx.beginPath();
      ctx.moveTo(1, -r * 1.35); ctx.lineTo(r * 0.62, -r * 1.2); ctx.lineTo(1, -r * 1.05);
      ctx.closePath(); ctx.fill();
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
    // plates prised up around the rim, where the board has come apart
    for (let i = 0; i < 4; i++) {
      const a = rnd() * TAU, rr = r * (0.72 + rnd() * 0.3);
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr * 0.82;
      const s = r * (0.26 + rnd() * 0.2);
      c.fillStyle = ['#9aa4ae', '#c8443c', '#3f7fd4'][(rnd() * 3) | 0];
      c.strokeStyle = 'rgba(40,54,70,0.8)'; c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(px - s, py); c.lineTo(px - s * 0.3, py - s * 0.75);
      c.lineTo(px + s * 0.9, py - s * 0.35); c.lineTo(px + s * 0.4, py + s * 0.4);
      c.closePath(); c.fill(); c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.35)';
      c.beginPath();
      c.moveTo(px - s, py); c.lineTo(px - s * 0.3, py - s * 0.75);
      c.lineTo(px + s * 0.2, py - s * 0.52); c.lineTo(px - s * 0.5, py - s * 0.16);
      c.closePath(); c.fill();
    }
    c.restore();
  }

  /* A built brick wall. Was a glacier slab, and it does the same job: drawn
     tall and squared off so a chain of them reads as one wall running across
     the board, with the courses offset like real brickwork. */
  function drawGlacierWall(c, x, y, r, rnd) {
    c.save();
    propShadow(c, x + r * 0.15, y + r * 0.5, r * 0.95);
    const cols = ['#9aa4ae', '#8b959f', '#a6b0ba'];
    const courses = 4;
    const ch = r * 0.42;
    for (let i = 0; i < courses; i++) {
      const cy = y + r * 0.5 - i * ch;
      const off = (i % 2) * r * 0.34;               // running bond
      for (let k = -1; k <= 1; k++) {
        const bx = x + k * r * 0.68 + off - r * 0.17;
        const bw = r * 0.66;
        const col = cols[(rnd() * cols.length) | 0];
        c.fillStyle = shade(col, -34);
        c.fillRect(bx - bw / 2, cy - ch, bw, ch);
        c.fillStyle = col;
        c.fillRect(bx - bw / 2, cy - ch, bw, ch * 0.66);
        c.fillStyle = shade(col, 24);
        c.fillRect(bx - bw / 2, cy - ch, bw, ch * 0.2);
        c.strokeStyle = shade(col, -60); c.lineWidth = 1.2;
        c.strokeRect(bx - bw / 2, cy - ch, bw, ch);
      }
    }
    // studs along the crest, so it is plainly a wall you could build on
    const topY = y + r * 0.5 - courses * ch;
    for (let k = -2; k <= 2; k++) {
      const sx = x + k * r * 0.34;
      c.fillStyle = 'rgba(200,210,220,0.95)';
      c.beginPath(); c.ellipse(sx, topY - r * 0.06, r * 0.14, r * 0.07, 0, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(70,80,92,0.8)'; c.lineWidth = 1;
      c.beginPath(); c.ellipse(sx, topY - r * 0.06, r * 0.14, r * 0.07, 0, 0, TAU); c.stroke();
    }
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

    /* ---- legs ----
       Drawn as two separate legs rather than one block with a line down it.
       At battle size the line was invisible and the whole lower half read as a
       dark smudge; two shapes with a real gap between them read as legs even
       when they are twelve pixels tall. */
    const legDark = shade(legs.startsWith('#') ? legs : '#2b3a4a', -34);
    const legLit = shade(legs.startsWith('#') ? legs : '#2b3a4a', 28);
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? -r * 0.46 : r * 0.06;
      ctx.fillStyle = legs;
      rounded(ctx, x0, HIP * r + r * 0.06, r * 0.40, (FOOT - HIP) * r - r * 0.06, r * 0.06);
      // the lit face down the sunward side of each leg
      ctx.fillStyle = side < 0 ? legLit : legDark;
      ctx.fillRect(x0, HIP * r + r * 0.06, r * 0.10, (FOOT - HIP) * r - r * 0.06);
      // the boot: a darker band with its own lip, so the figure has a footing
      ctx.fillStyle = legDark;
      rounded(ctx, x0 - r * 0.02, FOOT * r - r * 0.20, r * 0.44, r * 0.20, r * 0.05);
      ctx.fillStyle = shade(legs.startsWith('#') ? legs : '#2b3a4a', -8);
      ctx.fillRect(x0 - r * 0.02, FOOT * r - r * 0.20, r * 0.44, r * 0.06);
      ctx.strokeStyle = ink; ctx.lineWidth = lw * 0.9;
      ctx.beginPath(); ctx.rect(x0, HIP * r + r * 0.06, r * 0.40, (FOOT - HIP) * r - r * 0.06); ctx.stroke();
    }
    // hip plate — the step where the legs meet the torso, and the belt on it
    ctx.fillStyle = shade(legs.startsWith('#') ? legs : '#2b3a4a', 22);
    rounded(ctx, -r * 0.48, HIP * r - r * 0.06, r * 0.96, r * 0.20, r * 0.05);
    ctx.strokeStyle = ink; ctx.lineWidth = lw * 0.9;
    ctx.beginPath(); ctx.rect(-r * 0.48, HIP * r - r * 0.06, r * 0.96, r * 0.20); ctx.stroke();

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
     rather than baked because it is the only part of a Bro that moves.

     Redrawn once the figures were made half again as large and the arms turned
     out to be the thing that had not survived: they were the same colour as the
     torso and only stuck out 0.2r past it, so at battle size they read as a
     thickening of the outline rather than as limbs. Now they clear the torso by
     half a radius, carry a shoulder that sits proud of it, and are shaded a
     step darker so the join is visible. */
  function paintArm(ctx, r, side, torso, ink) {
    const dark = shade(torso.startsWith('#') ? torso : '#2f6fb5', -22);
    ctx.save();
    ctx.scale(side, 1);
    ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, r * 0.075);

    // upper arm, swept down and out from the shoulder
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(r * 0.30, -r * 0.14);
    ctx.quadraticCurveTo(r * 0.78, -r * 0.10, r * 0.86, r * 0.26);
    ctx.lineTo(r * 0.62, r * 0.36);
    ctx.quadraticCurveTo(r * 0.58, r * 0.06, r * 0.26, r * 0.12);
    ctx.closePath(); ctx.fill(); ctx.stroke();

    // shoulder cap, sitting proud of the torso so the joint reads
    ctx.fillStyle = torso;
    ctx.beginPath(); ctx.ellipse(r * 0.34, -r * 0.04, r * 0.14, r * 0.16, -0.3, 0, TAU);
    ctx.fill(); ctx.stroke();

    // hand: an open C, the way a brick figure's grip actually looks
    ctx.fillStyle = SKIN; ctx.strokeStyle = '#9a7412';
    ctx.lineWidth = Math.max(1.6, r * 0.13); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(r * 0.78, r * 0.44, r * 0.15, -2.1, 1.6); ctx.stroke();
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

    /* The gear-path cape (tier 2+), gold-trimmed at tier 3. Pulled in and back
       from where it was: at the old drawing size it read as a flourish, and at
       the new one it was swallowing the figure it was supposed to decorate. It
       now hangs behind the shoulders instead of wrapping round them. */
    if (tierB >= 2) {
      const sway = Math.sin(t * 2.2) * r * 0.05;
      ctx.fillStyle = shade(clsColor, -12);
      ctx.beginPath();
      ctx.moveTo(-r * 0.30, -r * 0.20);
      ctx.quadraticCurveTo(-r * 0.98, r * 0.10 + sway, -r * 0.80, r * 0.80 + sway);
      ctx.quadraticCurveTo(-r * 0.40, r * 0.92, -r * 0.10, r * 0.72);
      ctx.lineTo(r * 0.04, -r * 0.16);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = tierB >= 3 ? '#ffd166' : shade(clsColor, -46);
      ctx.lineWidth = r * (tierB >= 3 ? 0.08 : 0.05);
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
    /* A maxed weapon path glows gold. This used to be a live shadowBlur, which
       is the single most expensive thing a 2D context can be asked for and
       costs in proportion to the AREA it blurs — so when the figures were drawn
       half again as large it went from affordable to 29fps on a board of a
       hundred capstone Bros.

       The prop rotates with the aim and animates with the clock, so it cannot
       be baked. The glow behind it can: it is a soft gold disc, which is
       exactly what glowSprite already caches for the boss menace halo. One
       blit instead of a blur, and the picture is the same. Measured back at a
       flat 60. */
    if (tierA >= 3) {
      const gr = Math.round(propR * 0.95);
      const gs = glowSprite(gr, Math.round(gr * 0.25), '255,209,102');
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.drawImage(gs, Math.cos(aim != null ? aim : -0.5) * propR * 0.5 - gr,
        Math.sin(aim != null ? aim : -0.5) * propR * 0.5 - gr);
      ctx.restore();
    }
    drawProp(ctx, propR, look, aim, t, propS);
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

    /* How big a Bro is DRAWN, which is deliberately not how much room it takes
       up. Placement is governed by G.TOWER_R (20) in the engine and nothing
       here touches it — so raising this makes the figures bigger and easier to
       read without moving a single build spot or changing what fits where.
       They overlap a little when packed tight, which is the price of being
       able to see what you built. */
    const small = tw.type === 'fort' || tw.type === 'vendor';
    const pr = small ? 20 : 28;
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

  /* ================= VACUUMS =================
     Third attempt, and the lesson from the second is in the proportions.

     Attempt one was a profile drawing, which fought a board seen from above.
     Attempt two moved overhead but kept a big rounded body as the main mass,
     hung a dark wedge off the front for the head and put a round lamp in the
     middle of the body — the result read as a radiator with a dial on it.

     What actually makes a vacuum recognisable from above is one thing: THE
     FLOOR HEAD IS THE WIDEST PART OF THE MACHINE, and it is a flat slab, not a
     bulge. Everything here is arranged to say that. The head is more than twice
     the width of the body and only a third as deep, its suction slot runs the
     full width of its leading edge, and the body sits small and central behind
     it on a short neck. The silhouette is a T.

     Layout, in radii, nose-right:

        x = +1.22 ─┐ front lip of the floor head, suction slot along it
        x = +0.62 ─┘ back of the head            |y| up to 1.05 — the widest point
        x = +0.42 ─┐ front of the body
        x = -0.62 ─┘ back of the body            |y| up to 0.52
        x = -1.70    the grip on the end of the handle

     The light lives on the front lip where a real one does, not in the middle
     of the body — and it still does the job of a face, because the front lip is
     where the eye goes first. */
  const VAC_FORM = {
    pup:         { form: 'hand' },
    juvenile:    { form: 'stick' },
    adult:       { form: 'upright' },
    speedster:   { form: 'robo' },
    bull:        { form: 'upright', bulk: 1.14, vents: true },
    stealth:     { form: 'upright', quiet: true },
    armored:     { form: 'can',     plated: true },
    regen:       { form: 'can',     cyclone: true },
    brute:       { form: 'drum' },
    beachmaster: { form: 'drum',    tank: true },
    colossus:    { form: 'drum',    pad: true },
    emperor:     { form: 'can',     stack: true },
    leviathan:   { form: 'drum',    pipes: true },
  };

  /* The proportions each form uses. headHW is the number that matters: it is
     what makes the machine read, and it is always well clear of bodyHW. */
  function vacGeom(spec) {
    const f = (spec && spec.form) || 'upright';
    const b = (spec && spec.bulk) || 1;
    const g = {
      hand:    { headHW: 0.62, headX0: 0.30, headX1: 0.86, bodyHW: 0.34, bodyX0: -0.46, bodyX1: 0.26, handle: -0.86, round: 0.16 },
      stick:   { headHW: 0.78, headX0: 0.56, headX1: 1.10, bodyHW: 0.30, bodyX0: -0.52, bodyX1: 0.40, handle: -1.86, round: 0.14 },
      upright: { headHW: 1.05, headX0: 0.62, headX1: 1.22, bodyHW: 0.52, bodyX0: -0.62, bodyX1: 0.42, handle: -1.70, round: 0.18 },
      can:     { headHW: 0.92, headX0: 0.66, headX1: 1.20, bodyHW: 0.64, bodyX0: -0.78, bodyX1: 0.34, handle: -1.55, round: 0.30 },
      drum:    { headHW: 1.16, headX0: 0.66, headX1: 1.26, bodyHW: 0.80, bodyX0: -0.86, bodyX1: 0.40, handle: -1.35, round: 0.42 },
      robo:    { headHW: 0, headX0: 0, headX1: 0, bodyHW: 0.94, bodyX0: -0.98, bodyX1: 0.98, handle: 0, round: 0.94 },
    }[f];
    return { f, headHW: g.headHW * b, headX0: g.headX0, headX1: g.headX1,
             bodyHW: g.bodyHW * b, bodyX0: g.bodyX0 * b, bodyX1: g.bodyX1,
             handle: g.handle, round: g.round };
  }

  /* The body shell — the one shape the fill, the shading clip and the cartoon
     outline all share, so they can never drift apart. */
  function vacBody(ctx, r, spec) {
    const G2 = vacGeom(spec);
    if (G2.f === 'robo') {
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.98, r * 0.94, 0, 0, TAU);
      return;
    }
    const rad = r * G2.round;
    ctx.beginPath();
    ctx.moveTo(r * G2.bodyX0 + rad, -r * G2.bodyHW);
    ctx.arcTo(r * G2.bodyX1, -r * G2.bodyHW, r * G2.bodyX1, r * G2.bodyHW, rad);
    ctx.arcTo(r * G2.bodyX1, r * G2.bodyHW, r * G2.bodyX0, r * G2.bodyHW, rad);
    ctx.arcTo(r * G2.bodyX0, r * G2.bodyHW, r * G2.bodyX0, -r * G2.bodyHW, rad);
    ctx.arcTo(r * G2.bodyX0, -r * G2.bodyHW, r * G2.bodyX1, -r * G2.bodyHW, rad);
    ctx.closePath();
  }

  /* Everything is drawn nose-right, and the caller turns it down the track.
     Which way the machine is FACING is therefore a mirror, never a rotation
     past vertical: rotating a right-facing drawing by 180° puts it upside
     down, and that is what had the whole pack driving on its roof on every leg
     of the track that runs right to left. Keyed on the segment's angle rather
     than the wobbled one, because the wobble is ±0.07 either side and on a
     vertical leg an angle-with-wobble crosses zero eight times a second. */
  function facesLeft(ang) { return Math.cos(ang) < 0; }

  /* The still half of a vacuum — which is nearly all of it, and deliberately:
     these are machines rolling down a track, not animals, so there is no gait
     to animate. Only the brush roll turns. Painted once per (type, stealth,
     wear pattern) into a sprite and blitted after that. */
  function paintVac(ctx, type, r, hidden, variant) {
    const def = G.ENEMIES[type];
    const col = def.color;
    const boss = !!def.boss;
    const spec = VAC_FORM[type] || { form: 'upright' };
    const G2 = vacGeom(spec);
    const f = G2.f;
    const ink = shade(col, -60);
    const lw = Math.max(1.4, r * 0.09);
    ctx.globalAlpha = hidden ? 0.45 : 1;

    // Robo-Vac: afterimages, because it is twice as fast as anything else and
    // that has to be legible before it arrives
    if (f === 'robo') {
      for (let gi = 2; gi >= 1; gi--) {
        ctx.save();
        ctx.translate(-r * 0.55 * gi, 0);
        ctx.globalAlpha = (hidden ? 0.45 : 1) * (gi === 1 ? 0.18 : 0.08);
        ctx.fillStyle = col;
        vacBody(ctx, r, spec); ctx.fill();
        ctx.restore();
      }
    }

    /* ---- the handle, straight back, thin ---- */
    if (f !== 'robo' && f !== 'hand') {
      ctx.strokeStyle = shade(col, -34);
      ctx.lineWidth = Math.max(1.8, r * (f === 'stick' ? 0.11 : 0.14));
      ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(r * (G2.bodyX0 + 0.1), 0); ctx.lineTo(r * G2.handle, 0); ctx.stroke();
      // the grip: a bar across the end. Perpendicular, so it survives being
      // twelve pixels wide, and it is what makes the line a handle.
      ctx.strokeStyle = '#2b3138';
      ctx.lineWidth = Math.max(2.4, r * 0.17);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(r * G2.handle, -r * 0.34); ctx.lineTo(r * G2.handle, r * 0.34);
      ctx.stroke();
    }
    if (f === 'hand') {                        // a handheld: a stubby grip
      ctx.strokeStyle = '#2b3138'; ctx.lineWidth = Math.max(2, r * 0.20); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(r * G2.bodyX0, 0); ctx.lineTo(r * (G2.handle), 0); ctx.stroke();
    }

    /* ---- the floor head ----
       The widest thing on the machine and the reason it reads. Drawn first so
       the body sits on top of it, which is also how they are actually built. */
    if (f !== 'robo') {
      const hw = G2.headHW, x0 = G2.headX0, x1 = G2.headX1;

      // the short neck joining head to body
      ctx.fillStyle = shade(col, -26);
      ctx.fillRect(r * (x0 - 0.26), -r * G2.bodyHW * 0.55, r * 0.30, r * G2.bodyHW * 1.10);

      // wheels at the back corners, sticking out past the head
      ctx.fillStyle = '#23282f';
      for (const s of [-1, 1]) {
        rounded(ctx, r * (x0 - 0.04), s * r * hw - (s > 0 ? 0 : r * 0.20), r * 0.22, r * 0.20, r * 0.06);
      }

      // the slab itself: rounded at the back, square across the front
      ctx.fillStyle = shade(col, -14);
      ctx.beginPath();
      ctx.moveTo(r * (x0 + 0.10), -r * hw);
      ctx.lineTo(r * (x1 - 0.06), -r * hw);
      ctx.quadraticCurveTo(r * x1, -r * hw, r * x1, -r * hw * 0.86);
      ctx.lineTo(r * x1, r * hw * 0.86);
      ctx.quadraticCurveTo(r * x1, r * hw, r * (x1 - 0.06), r * hw);
      ctx.lineTo(r * (x0 + 0.10), r * hw);
      ctx.quadraticCurveTo(r * x0, r * hw, r * x0, r * hw * 0.7);
      ctx.lineTo(r * x0, -r * hw * 0.7);
      ctx.quadraticCurveTo(r * x0, -r * hw, r * (x0 + 0.10), -r * hw);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.stroke();

      // lit along its back edge, shaded along the front — a flat slab, lit from
      // the top-left like everything else on the board
      ctx.save();
      ctx.beginPath();
      ctx.rect(r * x0, -r * hw, r * (x1 - x0), r * hw * 2);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.20)';
      ctx.fillRect(r * x0, -r * hw, r * 0.16, r * hw * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.fillRect(r * (x1 - 0.20), -r * hw, r * 0.20, r * hw * 2);
      ctx.restore();

      /* The suction slot, the full width of the leading edge. This is the
         single most identifying mark on the machine and the mechanic the game
         runs on — the mouth that swallows things. */
      ctx.fillStyle = '#0f1319';
      rounded(ctx, r * (x1 - 0.20), -r * hw * 0.80, r * 0.15, r * hw * 1.60, r * 0.05);
      ctx.fillStyle = 'rgba(150,200,235,0.20)';
      rounded(ctx, r * (x1 - 0.185), -r * hw * 0.74, r * 0.05, r * hw * 1.48, r * 0.03);

      // the headlight, on the front lip where a real one is
      const lightY = -r * hw * 0.52;
      const lr = r * (boss ? 0.13 : 0.10);
      ctx.fillStyle = 'rgba(255,240,180,0.35)';
      ctx.beginPath(); ctx.arc(r * (x1 - 0.32), lightY, lr * 2.0, 0, TAU); ctx.fill();
      ctx.fillStyle = spec.quiet ? '#6ec8e8' : boss ? '#ff6a4a' : '#ffe08a';
      ctx.beginPath(); ctx.arc(r * (x1 - 0.32), lightY, lr, 0, TAU); ctx.fill();
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(0.9, r * 0.035);
      ctx.beginPath(); ctx.arc(r * (x1 - 0.32), lightY, lr, 0, TAU); ctx.stroke();
    }

    /* ---- the body ---- */
    ctx.fillStyle = col;
    vacBody(ctx, r, spec); ctx.fill();

    ctx.save();
    vacBody(ctx, r, spec); ctx.clip();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = shade(col, 46);
    ctx.beginPath(); ctx.ellipse(-r * 0.15, -r * G2.bodyHW * 0.66, r * 0.62, r * G2.bodyHW * 0.40, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = shade(col, -30);
    ctx.beginPath(); ctx.ellipse(r * 0.05, r * G2.bodyHW * 0.72, r * 0.70, r * G2.bodyHW * 0.42, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;

    /* Scuffs, seeded off the sprite's wear pattern rather than the individual
       machine: three patterns read as varied as ninety did, and it is the
       difference between three sheets per species and one per vacuum. */
    if (!boss) {
      const rnd = mulberry32(variant * 31013 + def.rank * 977);
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = shade(col, -50);
      for (let i = 0, n = 3 + (rnd() * 3 | 0); i < n; i++) {
        ctx.beginPath();
        ctx.ellipse((rnd() * 2 - 1) * r * 0.4, (rnd() * 2 - 1) * r * G2.bodyHW * 0.6,
          r * (0.04 + rnd() * 0.06), r * (0.03 + rnd() * 0.03), rnd() * 3, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    /* The dust window, with the bricks it has already swallowed visible inside.
       It sits along the body rather than across it, so it reads as a bag rather
       than as a panel bolted on. */
    if (f !== 'robo') {
      const ww = r * (G2.bodyX1 - G2.bodyX0) * 0.62, wh = r * G2.bodyHW * 0.92;
      ctx.fillStyle = 'rgba(230,242,250,0.42)';
      rounded(ctx, r * G2.bodyX0 + r * 0.14, -wh / 2, ww, wh, r * 0.07);
      const rnd2 = mulberry32(def.rank * 7717 + variant * 131);
      for (let i = 0, bits = 2 + (def.rank > 8 ? 2 : 0); i < bits; i++) {
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.translate(r * G2.bodyX0 + r * 0.24 + rnd2() * (ww - r * 0.22), (rnd2() - 0.5) * wh * 0.62);
        ctx.rotate(rnd2() * 3);
        brickBit(ctx, 0, 0, r * 0.19, r * 0.14, LOAD_COLS[(rnd2() * 3) | 0]);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // bold cartoon outline, the same weight the Bros wear
    ctx.strokeStyle = ink;
    ctx.globalAlpha = hidden ? 0.4 : 0.9;
    ctx.lineWidth = Math.max(1.6, r * 0.11);
    vacBody(ctx, r, spec); ctx.stroke();
    ctx.globalAlpha = hidden ? 0.45 : 1;

    /* ---- the one detail that tells this species from the last ---- */
    if (spec.vents) {                          // Heavy Upright: cooling slots
      ctx.fillStyle = shade(col, -52);
      for (let i = 0; i < 3; i++) {
        ctx.fillRect(r * (G2.bodyX0 + 0.06 + i * 0.10), -r * G2.bodyHW * 0.46, r * 0.045, r * G2.bodyHW * 0.92);
      }
    }
    if (spec.quiet) {                          // Silent Runner: foam shroud
      ctx.fillStyle = 'rgba(200,214,228,0.5)';
      rounded(ctx, r * (G2.bodyX0 - 0.02), -r * G2.bodyHW * 1.14, r * (G2.bodyX1 - G2.bodyX0), r * G2.bodyHW * 0.36, r * 0.07);
      rounded(ctx, r * (G2.bodyX0 - 0.02), r * G2.bodyHW * 0.78, r * (G2.bodyX1 - G2.bodyX0), r * G2.bodyHW * 0.36, r * 0.07);
    }
    if (spec.plated) {                         // Steel Canister: riveted plate
      ctx.fillStyle = '#a9b3bd';
      rounded(ctx, r * (G2.bodyX0 + 0.08), -r * G2.bodyHW * 0.66, r * (G2.bodyX1 - G2.bodyX0 - 0.20), r * G2.bodyHW * 1.32, r * 0.09);
      ctx.strokeStyle = '#6f7a86'; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.rect(r * (G2.bodyX0 + 0.08), -r * G2.bodyHW * 0.66, r * (G2.bodyX1 - G2.bodyX0 - 0.20), r * G2.bodyHW * 1.32); ctx.stroke();
      ctx.fillStyle = '#5d6873';
      for (const sy of [-0.46, 0.46]) for (let i = 0; i < 3; i++) {
        ctx.beginPath(); ctx.arc(r * (G2.bodyX0 + 0.22 + i * 0.28), sy * r * G2.bodyHW, r * 0.042, 0, TAU); ctx.fill();
      }
    }
    if (spec.cyclone) {                        // Cyclone: the bin that empties itself
      ctx.save();
      ctx.strokeStyle = 'rgba(120,235,160,0.9)'; ctx.lineWidth = Math.max(1.2, r * 0.06);
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) {
        const a = i * 0.42, rad = r * 0.04 + i * r * 0.010;
        const px = -r * 0.16 + Math.cos(a) * rad, py = Math.sin(a) * rad;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }
    if (spec.tank) {                           // Carpet Cleaner: solution tank
      ctx.fillStyle = 'rgba(150,225,240,0.7)';
      rounded(ctx, r * (G2.bodyX0 + 0.06), -r * G2.bodyHW * 0.5, r * 0.46, r * G2.bodyHW, r * 0.09);
      ctx.strokeStyle = shade(col, -46); ctx.lineWidth = lw * 0.7;
      ctx.beginPath(); ctx.rect(r * (G2.bodyX0 + 0.06), -r * G2.bodyHW * 0.5, r * 0.46, r * G2.bodyHW); ctx.stroke();
    }
    if (spec.pad) {                            // Floor Buffer: the spinning pad
      ctx.fillStyle = '#d8dee4';
      ctx.beginPath(); ctx.arc(r * 0.92, 0, r * 0.92, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#8b98a5'; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.strokeStyle = 'rgba(120,136,152,0.7)'; ctx.lineWidth = 1.2;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        ctx.beginPath();
        ctx.moveTo(r * 0.92 + Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3);
        ctx.lineTo(r * 0.92 + Math.cos(a) * r * 0.84, Math.sin(a) * r * 0.84);
        ctx.stroke();
      }
    }
    if (spec.stack) {                          // The Extractor: exhaust stacks
      for (const sy of [-0.5, 0, 0.5]) {
        ctx.fillStyle = '#4a5560';
        ctx.beginPath(); ctx.arc(r * (G2.bodyX0 + 0.20), sy * r * G2.bodyHW, r * 0.12, 0, TAU); ctx.fill();
        ctx.fillStyle = '#20262e';
        ctx.beginPath(); ctx.arc(r * (G2.bodyX0 + 0.20), sy * r * G2.bodyHW, r * 0.06, 0, TAU); ctx.fill();
      }
    }
    if (spec.pipes) {                          // Central Unit: plumbed into the wall
      ctx.strokeStyle = '#8b98a5'; ctx.lineWidth = Math.max(2, r * 0.15); ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(r * (G2.bodyX0 + 0.1), -r * G2.bodyHW * 0.5);
      ctx.quadraticCurveTo(-r * 1.35, -r * 0.9, -r * 1.85, -r * 0.35);
      ctx.stroke();
      ctx.strokeStyle = '#5d6873'; ctx.lineWidth = Math.max(1, r * 0.045);
      for (let i = 0; i < 4; i++) {
        const px = -r * (0.85 + i * 0.26), py = -r * (0.70 + Math.sin(i) * 0.06);
        ctx.beginPath(); ctx.moveTo(px, py - r * 0.10); ctx.lineTo(px, py + r * 0.10); ctx.stroke();
      }
    }
    if (f === 'robo') {                        // Robo-Vac: bumper, brush, sensor
      ctx.strokeStyle = shade(col, -52); ctx.lineWidth = Math.max(1.6, r * 0.10);
      ctx.beginPath(); ctx.arc(0, 0, r * 0.80, -1.25, 1.25); ctx.stroke();
      ctx.fillStyle = '#12161c';
      rounded(ctx, r * 0.52, -r * 0.44, r * 0.14, r * 0.88, r * 0.05);
      ctx.fillStyle = '#2b3138';
      ctx.beginPath(); ctx.arc(-r * 0.18, 0, r * 0.24, 0, TAU); ctx.fill();
      ctx.fillStyle = '#5d6873';
      ctx.beginPath(); ctx.arc(-r * 0.18, 0, r * 0.11, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffe08a';
      ctx.beginPath(); ctx.arc(r * 0.62, -r * 0.30, r * 0.09, 0, TAU); ctx.fill();
    }

    /* Bosses and heavies wear the same yellow-and-black hazard tape, because
       "this one is different" has to be one signal the player learns once, not
       four they learn separately. Along the floor head, where it is widest. */
    if (boss && f !== 'robo') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(r * G2.headX0, -r * G2.headHW, r * (G2.headX1 - G2.headX0), r * G2.headHW * 2);
      ctx.clip();
      ctx.globalAlpha = 0.9;
      for (let i = -7; i <= 7; i++) {
        ctx.fillStyle = i % 2 ? '#1c1f24' : '#f2c14e';
        ctx.beginPath();
        ctx.moveTo(r * G2.headX0, r * (i * 0.22) * G2.headHW);
        ctx.lineTo(r * (G2.headX0 + 0.18), r * (i * 0.22) * G2.headHW);
        ctx.lineTo(r * (G2.headX0 + 0.18), r * (i * 0.22 + 0.11) * G2.headHW);
        ctx.lineTo(r * G2.headX0, r * (i * 0.22 + 0.11) * G2.headHW);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
  }
  /* The half that has to be redrawn: anything whose shape or brightness is a
     function of the clock. Everything here sits clear of the head and the
     silhouette, so drawing it over the blitted sprite lands the same picture
     the old single pass did. */
  function drawVacLive(ctx, e, r, t, ghost) {
    switch (e.type) {
      case 'bull': {
        // exhaust puffing out of the back of an overworked motor
        const ph = (t * 1.1 + e.wob) % 1;
        if (ph < 0.4) {
          const pf = ph / 0.4;
          ctx.fillStyle = `rgba(210,215,220,${(1 - pf) * 0.55})`;
          ctx.beginPath(); ctx.arc(-r * (1.0 + pf * 0.45), -r * (0.5 + pf * 0.3), r * 0.10 + pf * r * 0.12, 0, TAU); ctx.fill();
          ctx.beginPath(); ctx.arc(-r * (0.85 + pf * 0.35), -r * (0.32 + pf * 0.2), r * 0.07 + pf * r * 0.08, 0, TAU); ctx.fill();
        }
        break;
      }
      case 'regen': {
        // the self-emptying bin: it visibly clears itself and comes back
        const pulse = 0.5 + Math.sin(t * 5) * 0.3;
        ctx.strokeStyle = `rgba(110,230,150,${pulse * 0.75})`;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, r * 1.18, 0, TAU); ctx.stroke();
        ctx.strokeStyle = `rgba(110,230,150,${pulse * 0.3})`;
        ctx.beginPath(); ctx.arc(0, 0, r * (1.3 + pulse * 0.15), 0, TAU); ctx.stroke();
        ctx.fillStyle = `rgba(140,255,170,${pulse})`;
        const cy = -r * 0.95 - Math.sin(t * 3) * r * 0.08;
        ctx.fillRect(-r * 0.05, cy - r * 0.16, r * 0.1, r * 0.32);
        ctx.fillRect(-r * 0.16, cy - r * 0.05, r * 0.32, r * 0.1);
        break;
      }
      case 'stealth': {
        // a motor you cannot hear, running anyway: the ready light breathes
        ctx.fillStyle = `rgba(110,200,232,${0.45 + Math.sin(t * 3) * 0.3})`;
        ctx.beginPath(); ctx.arc(-r * 0.62, -r * 0.34, r * 0.07, 0, TAU); ctx.fill();
        break;
      }
      case 'emperor': {
        // heat shimmer off the exhaust stacks
        ctx.globalAlpha = ghost * (0.3 + Math.sin(t * 4) * 0.2);
        ctx.fillStyle = 'rgba(255,180,120,0.8)';
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          ctx.arc(r * (-0.30 + i * 0.34), -r * (1.30 + ((t * 0.5 + i * 0.3) % 1) * 0.4), r * 0.09, 0, TAU);
          ctx.fill();
        }
        ctx.globalAlpha = ghost;
        break;
      }
      case 'leviathan':
        // the pipe glows where it draws off the wall, breathing
        ctx.globalAlpha = 0.5 + Math.sin(t * 2.5) * 0.3;
        ctx.strokeStyle = '#6fe8e0';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(-r * 0.55, -r * 0.62);
        ctx.quadraticCurveTo(-r * 1.25, -r * 1.1, -r * 1.75, -r * 0.55);
        ctx.stroke();
        ctx.globalAlpha = ghost;
        break;
    }
  }

  /* The power cord, trailing off the back. Baked because it does not move —
     a vacuum has no gait, which is most of why the pack is cheaper to draw
     than the animals were.

     This sheet and paintHeavyCord's are keyed on the species alone while baking
     in `r` and `col`, which is only correct because both are copied straight
     off the ENEMIES table when the machine spawns and nothing in the codebase
     ever writes to them afterwards. Give a vacuum a size that varies — a giant
     modifier, a curve that swells them in deep endless — and these sheets go
     silently wrong, with every machine of the species wearing whichever one was
     baked first. Put the varying thing in the key. */
  function paintVacCord(ctx, r, col) {
    ctx.strokeStyle = '#2b3138';
    ctx.lineWidth = Math.max(1.2, r * 0.07);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.1);
    ctx.quadraticCurveTo(-r * 0.34, -r * 0.34, -r * 0.62, -r * 0.06);
    ctx.quadraticCurveTo(-r * 0.82, r * 0.14, -r * 1.05, r * 0.02);
    ctx.stroke();
    // the plug on the end, still hopefully looking for a socket
    ctx.fillStyle = '#f2f4f6';
    rounded(ctx, -r * 1.20, -r * 0.09, r * 0.17, r * 0.18, r * 0.04);
    ctx.fillStyle = '#8b98a5';
    ctx.fillRect(-r * 1.28, -r * 0.05, r * 0.08, r * 0.04);
    ctx.fillRect(-r * 1.28, r * 0.02, r * 0.08, r * 0.04);
  }

  /* The brush roll under the floor head — the one part of a vacuum that turns,
     so the one part drawn live. The stripes are what make the rotation read;
     a plain cylinder spinning is a plain cylinder. */
  function drawVacBrush(ctx, r, spin, hidden) {
    ctx.save();
    ctx.globalAlpha = hidden ? 0.45 : 1;
    const bw = r * 0.34;
    ctx.fillStyle = '#3a3f46';
    ctx.beginPath(); ctx.ellipse(0, 0, bw, r * 0.10, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#c9b98a'; ctx.lineWidth = Math.max(1, r * 0.05);
    for (let i = 0; i < 3; i++) {
      const ph = (spin + i / 3) % 1;
      const x = -bw + ph * bw * 2;
      ctx.globalAlpha = (hidden ? 0.45 : 1) * (0.35 + Math.sin(ph * Math.PI) * 0.55);
      ctx.beginPath(); ctx.moveTo(x, -r * 0.09); ctx.lineTo(x, r * 0.09); ctx.stroke();
    }
    ctx.restore();
  }

  /* How big a vacuum is DRAWN. `e.size` is the hitbox — the engine tests a
     projectile against `(e.size + 6)²` and a heavy's maw against `size * 0.9` —
     so it must not move, or the game gets easier and every tuned number goes
     with it. Only the picture scales.

     The Bros were drawn half again as large and then larger still, and left
     alone the pack would have looked like toys beside them. 1.45 on the small
     machines is chosen so the drawing lands almost exactly on `size + 6`: an
     Upright draws at 18.9 and is hit at 19, which means a projectile that looks
     like it grazed the shell did. The multiplier eases off toward the big ones,
     because a MEGAVAC at full scale would eat a fifth of the board. */
  function vacDrawR(size) {
    const k = 1.45 - 0.25 * Math.max(0, Math.min(1, (size - 20) / 54));
    return size * k;
  }

  function drawVac(ctx, game, e, t) {
    const def = G.ENEMIES[e.type];
    const p = G.samplePath(game.paths[e.pathIdx], e.dist);
    const wob = Math.sin(t * 8 + e.wob) * 0.07;
    const r = vacDrawR(e.size);
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

    /* The power cord, snaking away behind. Seen from above it lies flat on the
       board, so it starts past the end of the handle rather than at the top of
       a body that no longer has a top. */
    ctx.save();
    ctx.translate(-r * 1.85, 0);
    blitSprite(ctx, sprite('cord|' + e.type + '|' + Math.round(r), [r * 1.5, r * 0.2, r * 0.5, r * 0.5],
      (c) => paintVacCord(c, r, col)));
    ctx.restore();

    /* The machine itself, in one blit. Three wear patterns per species is all
       the variety ninety individually-seeded vacuums ever showed.

       PAD BOX. Measured against the furthest thing any form actually draws,
       not against the body — that was the bug. The old box gave 1.1r below the
       axis when a drum's floor head reaches 1.16r and its wheels stick out to
       1.36r, so every wide machine had one side of its head sliced off square.
       Nothing errors; the sprite is simply cropped, and a machine missing half
       its head reads as a different, smaller machine. The four extremes:

         back    Stick Vac handle −1.86r, Central Unit wall pipe −1.85r
         front   Floor Buffer's spinning pad, a circle out to +1.84r
         sides   drum floor head 1.16r plus its wheels, 1.36r

       `r` IS IN THE KEY. It is constant per species today, so this adds no
       sheets — but the cache returns whatever was baked first for a key and
       ignores the size it is asked for, so the day anything scales a vacuum
       (a giant modifier, a deep-endless curve) every machine of that species
       would silently wear the first size drawn. Cheap insurance against a bug
       that is invisible in the code and obvious on the screen. */
    const variant = ((e.wob * 1000) | 0) % 3;
    const key = 'vac|' + e.type + '|' + Math.round(r) + '|' + (hidden ? 'h' : '') + variant;
    ctx.globalAlpha = 1;
    blitSprite(ctx, sprite(key, [r * 2.15, r * 2.10, r * 1.55, r * 1.55],
      (c) => paintVac(c, e.type, r, hidden, variant)));

    /* The brush roll, spanning the mouth of the floor head. From above it lies
       ACROSS the machine rather than along it, so it is drawn turned a quarter
       turn — the same helper, rotated, rather than a second one that could
       drift out of step with the first.

       It turns with distance travelled rather than with the clock, so a clogged
       vacuum visibly slows down instead of spinning merrily on the spot. */
    if (e.type !== 'speedster') {
      ctx.save();
      ctx.translate(r * 1.06, 0);
      ctx.rotate(Math.PI / 2);
      drawVacBrush(ctx, r * 1.9, ((e.dist || 0) / Math.max(4, r * 0.9)) % 1, hidden);
      ctx.restore();
    }
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

  /* A heavy seen from above: a steel drum on four casters, the clamped lid, a
     wide intake mouth at the bow and the ribbed hose coiling back over its own
     shoulder. Drawn nose-right, like everything else here, so the caller's
     rotation carries it down the track.

     Where the ordinary machines are profile drawings, these are plan views —
     the same split the game has always had between the small pack and the big
     ones, kept because at this size a wide flat top-down drum reads as
     enormous where a tall profile just reads as far away.

     Nothing about a heavy is animated except the intake, which is the whole
     threat: this is the thing that swallows the pack. The hull, the casters and
     the hose are one sprite. */
  function paintHeavyBody(ctx, type, r, col) {
    const ink = '#0b1119';
    const steel = '#8d99a6';

    /* Casters, one at each corner, splayed the way loaded castors actually
       sit. Baked at rest — a caster that swivelled would be motion nobody
       asked for on a machine whose menace is that it never hurries. */
    for (const side of [-1, 1]) {
      for (const fore of [-0.52, 0.34]) {
        ctx.save();
        ctx.translate(r * fore, side * r * 0.62);
        ctx.fillStyle = '#2b3138';
        ctx.beginPath(); ctx.ellipse(0, 0, r * 0.17, r * 0.11, side * 0.3, 0, TAU); ctx.fill();
        ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, r * 0.035); ctx.stroke();
        ctx.fillStyle = '#5d6873';
        ctx.beginPath(); ctx.arc(0, 0, r * 0.05, 0, TAU); ctx.fill();
        ctx.restore();
      }
    }

    /* The hose: off the back of the drum, over the shoulder and forward to the
       intake. Ribbed, because a smooth tube reads as a handle. */
    ctx.strokeStyle = shade(col, 26);
    ctx.lineWidth = Math.max(2, r * 0.19); ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-r * 0.78, -r * 0.30);
    ctx.quadraticCurveTo(-r * 1.15, -r * 0.72, -r * 0.35, -r * 0.80);
    ctx.quadraticCurveTo(r * 0.45, -r * 0.86, r * 0.86, -r * 0.44);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(10,17,25,0.35)'; ctx.lineWidth = Math.max(0.8, r * 0.03);
    for (let i = 0; i <= 9; i++) {
      const u = i / 9;
      const x = -0.78 + u * 1.64, y = -0.30 - Math.sin(u * Math.PI) * 0.52 - u * 0.14;
      ctx.beginPath();
      ctx.moveTo(r * x, r * (y - 0.09));
      ctx.lineTo(r * x, r * (y + 0.09));
      ctx.stroke();
    }

    /* The drum. A hard-edged cylinder rather than the soft hull that was here:
       every curve on this thing is a manufacturing radius, not an animal. */
    const drum = ctx.createLinearGradient(0, -r * 0.7, 0, r * 0.7);
    drum.addColorStop(0, shade(col, 52));
    drum.addColorStop(0.4, shade(col, 12));
    drum.addColorStop(1, shade(col, -26));
    ctx.fillStyle = drum;
    ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1.6, r * 0.07);
    ctx.beginPath();
    ctx.ellipse(-r * 0.10, 0, r * 0.92, r * 0.66, 0, 0, TAU);
    ctx.fill(); ctx.stroke();

    // the clamped lid: a ring inset from the rim, with four latches
    ctx.strokeStyle = shade(col, -40); ctx.lineWidth = Math.max(1.2, r * 0.05);
    ctx.beginPath(); ctx.ellipse(-r * 0.10, 0, r * 0.66, r * 0.46, 0, 0, TAU); ctx.stroke();
    ctx.fillStyle = steel;
    for (let i = 0; i < 4; i++) {
      const a = 0.7 + i * (Math.PI / 2);
      ctx.save();
      ctx.translate(-r * 0.10 + Math.cos(a) * r * 0.80, Math.sin(a) * r * 0.56);
      ctx.rotate(a);
      ctx.fillRect(-r * 0.07, -r * 0.10, r * 0.14, r * 0.20);
      ctx.restore();
    }

    // motor housing on the lid, with the cooling grille
    ctx.fillStyle = steel;
    ctx.beginPath(); ctx.ellipse(-r * 0.10, 0, r * 0.34, r * 0.26, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, r * 0.04); ctx.stroke();
    ctx.strokeStyle = 'rgba(10,17,25,0.55)'; ctx.lineWidth = Math.max(0.8, r * 0.03);
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(-r * 0.10 + i * r * 0.10, -r * 0.20);
      ctx.lineTo(-r * 0.10 + i * r * 0.10, r * 0.20);
      ctx.stroke();
    }

    /* The intake at the bow. This is what the whole machine is FOR, and what
       the mechanic needs the player to read instantly: an open mouth that
       swallows anything smaller than itself. Black, wide, and lit from inside. */
    ctx.fillStyle = '#0a0f16';
    ctx.beginPath();
    ctx.moveTo(r * 0.74, -r * 0.44);
    ctx.quadraticCurveTo(r * 1.34, -r * 0.30, r * 1.34, 0);
    ctx.quadraticCurveTo(r * 1.34, r * 0.30, r * 0.74, r * 0.44);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = steel; ctx.lineWidth = Math.max(1.4, r * 0.06); ctx.stroke();
    // the suction, drawn as rings pulled toward the throat
    ctx.strokeStyle = 'rgba(150,200,235,0.35)'; ctx.lineWidth = Math.max(1, r * 0.04);
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.ellipse(r * (0.86 + i * 0.12), 0, r * 0.05, r * (0.30 - i * 0.06), 0, 0, TAU);
      ctx.stroke();
    }

    /* The hazard chevrons along the flank — the same yellow-and-black the four
       bosses wear, so "this one is different" stays one signal. */
    ctx.save();
    ctx.beginPath(); ctx.ellipse(-r * 0.10, 0, r * 0.92, r * 0.66, 0, 0, TAU); ctx.clip();
    ctx.globalAlpha = 0.85;
    for (let i = -5; i <= 5; i++) {
      ctx.fillStyle = i % 2 ? '#1c1f24' : '#f2c14e';
      ctx.beginPath();
      ctx.moveTo(r * (-0.10 + i * 0.20), r * 0.42);
      ctx.lineTo(r * (0.00 + i * 0.20), r * 0.42);
      ctx.lineTo(r * (-0.10 + i * 0.20), r * 0.70);
      ctx.lineTo(r * (-0.20 + i * 0.20), r * 0.70);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();

    // the biggest one in the room gets a second pair of eyes and a name plate
    if (type === 'heavy_king') {
      ctx.fillStyle = '#ff5a3c';
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.arc(r * 0.62, side * r * 0.30, r * 0.09, 0, TAU); ctx.fill();
      }
      ctx.fillStyle = '#f2c14e';
      rounded(ctx, -r * 0.72, -r * 0.12, r * 0.30, r * 0.24, r * 0.04);
    }
  }

  /* The dust cloud a heavy kicks up behind it. */
  function paintHeavyWake(ctx, r) {
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = 'rgba(198,206,214,0.55)';
    ctx.beginPath();
    ctx.ellipse(-r * 1.5, 0, r * 0.72, r * 0.5, 0, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.24;
    ctx.beginPath();
    ctx.ellipse(-r * 2.15, 0, r * 0.5, r * 0.3, 0, 0, TAU);
    ctx.fill();
  }

  /* The trailing cable and its plug — the heavy version of the small machines'
     cord, and the last piece drawn separately so the hull stays one blit. */
  function paintHeavyCord(ctx, r, col) {
    ctx.strokeStyle = '#1c2027';
    ctx.lineWidth = Math.max(1.6, r * 0.09); ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(r * 0.16, 0);
    ctx.quadraticCurveTo(-r * 0.24, -r * 0.22, -r * 0.62, -r * 0.06);
    ctx.quadraticCurveTo(-r * 0.86, r * 0.08, -r * 1.10, r * 0.16);
    ctx.stroke();
    ctx.fillStyle = '#f2f4f6';
    rounded(ctx, -r * 1.28, r * 0.06, r * 0.20, r * 0.20, r * 0.05);
  }

  function drawHeavyBody(ctx, e, r, col, t) {
    blitSprite(ctx, sprite('heavywake|' + e.type + '|' + Math.round(r), [r * 2.75, r * 0.1, r * 0.7, r * 0.7],
      (c) => paintHeavyWake(c, r)));

    ctx.save();
    ctx.translate(-r * 0.92, 0);
    blitSprite(ctx, sprite('heavycord|' + e.type + '|' + Math.round(r), [r * 1.45, r * 0.25, r * 0.4, r * 0.4],
      (c) => paintHeavyCord(c, r, col)));
    ctx.restore();

    /* Pad box measured against the furthest thing the hull draws: the hose
       crest at −0.86r above the axis, the casters at ±0.73r, the intake to
       +1.34r and the hose tail to −1.15r behind. */
    blitSprite(ctx, sprite('heavy|' + e.type + '|' + Math.round(r), [r * 1.40, r * 1.55, r * 1.10, r * 1.05],
      (c) => paintHeavyBody(c, e.type, r, col)));

    /* The throat, pulsing. The one live element, and it is the mechanic: this
       is the machine that eats the pack, so the mouth is what moves. */
    const suck = 0.5 + Math.sin(t * 5 + e.wob) * 0.5;
    ctx.save();
    ctx.globalAlpha = 0.25 + suck * 0.35;
    ctx.fillStyle = 'rgba(150,205,240,0.9)';
    ctx.beginPath();
    ctx.ellipse(r * (1.16 - suck * 0.16), 0, r * 0.07, r * (0.10 + suck * 0.16), 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /* ---------- projectiles & effects ---------- */
  /* Reused between frames; see the note on zEnemies at the bottom of the file. */
  const shotOwners = new Map();
  /* One brick, drawn small and centred, for anything that flies or scatters:
     shots, catapult loads, the debris a vacuum bursts into, the bits rattling
     around inside a dust window. Top face lit, front face plain, dark edge, two
     studs — the same four notes as every other brick on the board, at a size
     where four notes is all that fits. */
  const LOAD_COLS = ['#c8443c', '#3f7fd4', '#e8b93c'];
  function brickBit(ctx, x, y, w, h, col) {
    ctx.fillStyle = shade(col, -34);
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.fillStyle = col;
    ctx.fillRect(x - w / 2, y - h / 2, w, h * 0.64);
    ctx.fillStyle = shade(col, 32);
    ctx.fillRect(x - w / 2, y - h / 2, w, h * 0.22);
    ctx.strokeStyle = shade(col, -62); ctx.lineWidth = 0.9;
    ctx.strokeRect(x - w / 2, y - h / 2, w, h);
    ctx.fillStyle = shade(col, 32);
    for (const sx of [-w * 0.24, w * 0.24]) {
      ctx.beginPath(); ctx.ellipse(x + sx, y - h / 2 - h * 0.13, w * 0.17, h * 0.13, 0, 0, TAU); ctx.fill();
    }
  }

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
        ctx.beginPath(); ctx.ellipse(pr.sx + (pr.tx - pr.sx) * f, pr.sy + (pr.ty - pr.sy) * f + 4, 7, 3, 0, 0, TAU); ctx.fill();
        /* A catapult load: three bricks tumbling together, not a cannonball.
           The spin comes off how far along the arc it is, so a shot that hangs
           in the air longer turns more. */
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(f * 7);
        for (let i = 0; i < 3; i++) brickBit(ctx, (i - 1) * 4, i % 2 ? -3 : 3, 9, 6, LOAD_COLS[i]);
        ctx.restore();
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
          // a bolt: a body with a stud nose, the way a brick projectile is built
          ctx.fillStyle = '#4a5560'; rounded(ctx, -8, -3.5, 14, 7, 2);
          ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(-8, -3.5, 14, 2.4);
          ctx.fillStyle = '#e05252';
          ctx.beginPath(); ctx.arc(7, 0, 3.4, 0, TAU); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.55)';
          ctx.beginPath(); ctx.arc(6, -1, 1.3, 0, TAU); ctx.fill();
        } else if (type === 'snowball') {
          // the Boulder Knight's stone wheel, rolling
          ctx.fillStyle = '#8d97a2';
          ctx.beginPath(); ctx.arc(0, 0, 8, 0, TAU); ctx.fill();
          ctx.strokeStyle = '#5b656f'; ctx.lineWidth = 1.6; ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.4)';
          ctx.beginPath(); ctx.arc(-2.5, -2.8, 2.6, 0, TAU); ctx.fill();
          ctx.fillStyle = 'rgba(0,0,0,0.18)';
          ctx.beginPath(); ctx.arc(2.6, 2.2, 1.8, 0, TAU); ctx.fill();
        } else if (type === 'pebble') {
          ctx.rotate(pr.x * 0.06 + pr.y * 0.06);        // a thrown 1x1, end over end
          brickBit(ctx, 0, 0, 9, 7, '#c8443c');
        } else if (type === 'aurora' || type === 'witch') {
          /* A trans round stud — the piece a brick set uses for energy — with
             the glow behind it and the bright disc on top that says the plastic
             is see-through. */
          const col = type === 'aurora' ? '#7ee8b4' : '#c98ef2';
          ctx.save(); ctx.globalAlpha = 0.35;
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.arc(-3, 0, 9, 0, TAU); ctx.fill();
          ctx.restore();
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.arc(0, 0, 5.5, 0, TAU); ctx.fill();
          ctx.strokeStyle = shade(col, -50); ctx.lineWidth = 1; ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.beginPath(); ctx.arc(0, 0, 2.4, 0, TAU); ctx.fill();
        } else if (type === 'harpoon') {
          // a laser bar: a trans rod with a hot core
          ctx.fillStyle = 'rgba(120,220,255,0.45)'; rounded(ctx, -10, -3, 22, 6, 3);
          ctx.fillStyle = '#eaf9ff'; rounded(ctx, -8, -1.2, 18, 2.4, 1.2);
        } else if (type === 'shards' || type === 'shadow') {
          ctx.fillStyle = '#cfd8e0';                     // a steel blade
          ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-4, -3.4); ctx.lineTo(-2, 0); ctx.lineTo(-4, 3.4); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = '#7a8794'; ctx.lineWidth = 0.9; ctx.stroke();
        } else if (type === 'glacier') {
          ctx.rotate(pr.x * 0.05);
          brickBit(ctx, 0, 0, 11, 8, '#9aa4ae');
        } else if (type === 'slush') {
          // a blob of glue, still stringing off the nozzle
          ctx.fillStyle = 'rgba(150,225,240,0.85)';
          ctx.beginPath(); ctx.arc(0, 0, 6, 0, TAU); ctx.fill();
          ctx.beginPath(); ctx.ellipse(-6, 0, 5, 2, 0, 0, TAU); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.beginPath(); ctx.arc(-1.5, -1.8, 1.8, 0, TAU); ctx.fill();
        } else {
          /* The default, and what most shots use: a stud. A 1x1 round plate is
             THE brick projectile, so an unnamed shot is one of those rather
             than an anonymous grey dot. */
          ctx.fillStyle = '#c9d2da';
          ctx.beginPath(); ctx.arc(0, 0, 5, 0, TAU); ctx.fill();
          ctx.strokeStyle = '#7d8892'; ctx.lineWidth = 1; ctx.stroke();
          ctx.fillStyle = '#eef2f6';
          ctx.beginPath(); ctx.arc(-0.6, -0.8, 2.4, 0, TAU); ctx.fill();
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
        /* A vacuum coming apart. It used to be white puffs, which is what a
           popped balloon does; a machine on a brick board bursts into bricks,
           and they tumble as they fly. */
        ctx.save();
        ctx.globalAlpha = Math.min(1, f * 1.4);
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * TAU + fx.x * 0.01;
          const d = (1 - f) * 30;
          ctx.save();
          ctx.translate(fx.x + Math.cos(a) * d, fx.y + Math.sin(a) * d);
          ctx.rotate(a + (1 - f) * 5);
          brickBit(ctx, 0, 0, 8 * f + 2, 6 * f + 1.5, LOAD_COLS[i % 3]);
          ctx.restore();
        }
        ctx.restore();
      } else if (fx.kind === 'devour') {
        /* An intake taking a whole machine. The bricks are dragged INWARD as
           this fades rather than thrown out, which is the difference between
           being eaten and being killed. */
        ctx.fillStyle = `rgba(60,70,84,${f * 0.45})`;
        ctx.beginPath(); ctx.arc(fx.x, fx.y, (1 - f) * (fx.r + 16) + 6, 0, TAU); ctx.fill();
        ctx.save();
        ctx.globalAlpha = f * 0.9;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU + fx.r;
          const d = f * 24 + 4;
          ctx.save();
          ctx.translate(fx.x + Math.cos(a) * d, fx.y + Math.sin(a) * d);
          ctx.rotate(a);
          brickBit(ctx, 0, 0, 6, 4.5, LOAD_COLS[i % 3]);
          ctx.restore();
        }
        ctx.restore();
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
        ctx.fillStyle = `rgba(232,185,60,${f})`;   // a stud chipping off
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
    ice:    { fill: 'rgba(176, 168, 148, 0.26)', edge: 'rgba(226, 214, 182, 0.55)' },  // grit, not frost
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

  /* The hazard on the track. It was a ring of white ice spikes, which was the
     most Tundra-looking thing left in the game — and the brick replacement
     writes itself, because everyone already knows exactly what standing on an
     upturned brick feels like. Studs up, scattered, in primary colours. */
  function paintSpikePile(ctx, n) {
    const cols = ['#c8443c', '#3f7fd4', '#e8b93c', '#3fae6a'];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + 0.4;
      const bx = Math.cos(a) * 8, by = Math.sin(a) * 6.4;
      const col = cols[i % cols.length];
      const w = 9, h = 6;
      ctx.fillStyle = 'rgba(16,26,40,0.30)';
      ctx.fillRect(bx - w / 2 + 1.4, by - h / 2 + 1.8, w, h);
      ctx.fillStyle = shade(col, -30);
      ctx.fillRect(bx - w / 2, by - h / 2, w, h);
      ctx.fillStyle = col;
      ctx.fillRect(bx - w / 2, by - h / 2, w, h * 0.55);
      ctx.strokeStyle = shade(col, -60); ctx.lineWidth = 0.9;
      ctx.strokeRect(bx - w / 2, by - h / 2, w, h);
      // the studs, pointing at the ceiling and at whatever rolls over them
      for (const sx of [-2.2, 2.2]) {
        ctx.fillStyle = shade(col, 34);
        ctx.beginPath(); ctx.ellipse(bx + sx, by - h / 2 - 1.1, 1.9, 1.1, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = shade(col, -55); ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.ellipse(bx + sx, by - h / 2 - 1.1, 1.9, 1.1, 0, 0, TAU); ctx.stroke();
      }
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
        /* The Shadow Ninja's double: a Bro built out of transparent bricks,
           standing in the road. It was an ice shard, which said nothing about
           who left it there — this is plainly a copy of the thing that did. */
        ctx.globalAlpha = 0.5 + Math.sin(t * 4) * 0.18;
        ctx.fillStyle = '#9fd8ef'; ctx.fillRect(-5, 0, 10, 11);          // legs
        ctx.fillStyle = '#b4e2f5'; ctx.fillRect(-4.5, -8, 9, 9);         // torso
        ctx.fillStyle = '#8fcfe8';
        ctx.fillRect(-8, -7, 3, 7); ctx.fillRect(5, -7, 3, 7);           // arms
        ctx.fillStyle = '#d8f2fc'; ctx.fillRect(-4, -17, 8, 9);          // head
        ctx.beginPath(); ctx.ellipse(0, -18, 2.4, 1.2, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1;
        ctx.strokeRect(-4, -17, 8, 9);
        ctx.fillStyle = '#e8f6ff';
        for (let i = 0; i < p.charges; i++) {
          ctx.beginPath(); ctx.arc(-5 + i * 5, -23, 1.6, 0, TAU); ctx.fill();
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
        drawBro(ctx, x, y, 28, game.placingType, null, 0);
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
