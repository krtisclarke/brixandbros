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
    const meta = { torches: [], crystals: [], fountains: [], pads: [], wheels: [] };

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
       is what stops the whole thing reading as printed wallpaper. The alphas
       were a third of this once, and under the film grain they vanished —
       every board read as one sheet of green. They need to be plainly visible
       to say "this floor was assembled". */
    for (let i = 0; i < 9; i++) {
      const px = Math.floor(rnd() * (G.W / SEAM)) * SEAM;
      const py = Math.floor(rnd() * (G.H / SEAM)) * SEAM;
      const wide = SEAM * (1 + (rnd() * 2 | 0));
      c.fillStyle = rnd() > 0.5
        ? (dk ? 'rgba(200,215,250,0.10)' : 'rgba(255,255,255,0.16)')
        : (dk ? 'rgba(6,12,34,0.16)' : 'rgba(30,48,74,0.12)');
      c.fillRect(px, py, wide, SEAM);
    }
    /* Two odd-coloured plates, because real boards never come colour-matched.
       The warm tint is skipped on the dark maps: a butterscotch square on
       black stone doesn't read as a mismatched plate, it reads as a board
       from a different set. Those get a cool tint or nothing. */
    for (let i = 0; i < 2; i++) {
      const px = Math.floor(rnd() * (G.W / SEAM)) * SEAM;
      const py = Math.floor(rnd() * (G.H / SEAM)) * SEAM;
      c.fillStyle = dk ? 'rgba(120,150,235,0.07)'
        : (rnd() > 0.5 ? 'rgba(232,185,60,0.10)' : 'rgba(120,180,255,0.09)');
      c.fillRect(px, py, SEAM, SEAM);
    }

    // scattered loose bricks, dropped on the plate and never tidied away
    const looseCols = ['#c8443c', '#3f7fd4', '#e8b93c', '#3fae6a', '#f2f4f6'];
    const nLoose = Math.round(26 * (G.W * G.H) / (1280 * 800));
    for (let i = 0; i < nLoose; i++) {
      const x = rnd() * G.W, y = rnd() * G.H;
      // not on a roof, a platform or down a service pit
      if (G.inDecoZone(level.id, x, y, 6)) continue;
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

    /* Flat landmark prints go down BEFORE the track: a roof, a platform, a
       pit. The track then runs visibly over them, which is the whole point on
       Rooftop Run — the road has to climb across the building, not around it.
       Anything that stands up waits for the `paint` pass below. */
    const deco = DECOS[level.id];
    if (deco && deco.under) deco.under(c, level, rnd, meta);

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

    /* Ion storm: a band of charged air across the middle of the board. It
       was doing nothing at all in the baked terrain — the only static trace
       of a "permanent ion storm" was one crystal cluster — while the animated
       streaks alone are too thin to say weather. This is the sky the streaks
       fly through. */
    if (th.storm) {
      const st = c.createLinearGradient(0, G.H * 0.18, 0, G.H * 0.86);
      st.addColorStop(0, 'rgba(150,110,225,0)');
      st.addColorStop(0.45, dk ? 'rgba(150,120,235,0.20)' : 'rgba(158,120,230,0.15)');
      st.addColorStop(1, 'rgba(120,150,235,0)');
      c.fillStyle = st;
      c.fillRect(0, 0, G.W, G.H);
      // and the discharge scars it leaves on the plate
      c.strokeStyle = dk ? 'rgba(196,170,255,0.20)' : 'rgba(150,110,220,0.22)';
      c.lineWidth = 2.2; c.lineCap = 'round';
      for (let i = 0; i < 9; i++) {
        const bx = 60 + rnd() * (G.W - 120), by = G.H * 0.2 + rnd() * G.H * 0.6;
        c.beginPath(); c.moveTo(bx, by);
        let px = bx, py = by;
        for (let k = 0; k < 3; k++) {
          px += (rnd() - 0.5) * 60; py += (rnd() - 0.5) * 50;
          c.lineTo(px, py);
        }
        c.stroke();
      }
    }

    // rough landings, printed on the deck — the spaceport tier only
    if (level.tier === 2 && !flooded) {
      for (let i = 0; i < 5; i++) {
        for (let tries = 0; tries < 30; tries++) {
          const x = 60 + rnd() * (G.W - 120), y = 70 + rnd() * (G.H - 140);
          if (!pathDistOk(level.paths, x, y, G.PATH_HALF + 30)) continue;
          if (waterHit(level, x, y, 30)) continue;
          drawCrater(c, x, y, 12 + rnd() * 14, rnd);
          break;
        }
      }
    }

    // blockers — a hand-placed one may wear its battlefield's costume
    for (const b of level.blockers) {
      if (!(deco && deco.skin && deco.skin(c, b, rnd))) drawBlocker(c, b);
      if (b.kind === 'crystal') meta.crystals.push({ x: b.x, y: b.y, r: b.r });
    }

    // --- scenery props ---
    scatterProps(c, level, rnd, meta);

    // --- the landmarks the battlefield is named for ---
    if (deco) deco.paint(c, level, rnd, meta);

    /* --- film grain + vignette ---
       Both an eyelash lighter than they were: at 0.4 the grain greyed every
       plate towards the same porridge, and the charm pass above is exactly
       the colour it was eating. */
    c.restore(); // back to device pixels
    c.save();
    c.globalCompositeOperation = 'soft-light';
    c.globalAlpha = 0.26;
    c.fillStyle = c.createPattern(getNoiseTile(), 'repeat');
    c.fillRect(0, 0, w, h);
    c.restore();
    const vig = c.createRadialGradient(w / 2, h / 2, h * 0.42, w / 2, h / 2, w * 0.7);
    vig.addColorStop(0, 'rgba(20,35,60,0)');
    vig.addColorStop(1, th.dark ? 'rgba(8,12,30,0.38)' : 'rgba(20,35,60,0.17)');
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
    // scattered props stay out of the landmarks' ground (G.DECO_ZONES, data.js)
    const inKeep = (x, y) => G.inDecoZone(level.id, x, y, 18);
    const place = (n, minPath, fn, sizeMin, sizeVar) => {
      for (let i = 0; i < n; i++) {
        for (let tries = 0; tries < 40; tries++) {
          const x = 30 + rnd() * (G.W - 60), y = 40 + rnd() * (G.H - 80);
          const size = sizeMin + rnd() * sizeVar;
          if (!pathDistOk(level.paths, x, y, minPath)) continue;
          /* Padded by the prop's own size: every one of these draws UPWARD
             from its base point, so a barrel whose foot cleared a pool by
             20px still stood its body in the water. */
          if (waterHit(level, x, y, 26 + size)) continue;
          if (inKeep(x, y)) continue;
          let nearBlocker = false;
          for (const b of level.blockers) if ((x - b.x) ** 2 + (y - b.y) ** 2 < (b.r + 26) ** 2) nearBlocker = true;
          if (nearBlocker) continue;
          fn(c, x, y, size, rnd);
          break;
        }
      }
    };

    if (kind === 'pines') {
      place(13, G.PATH_HALF + 42, drawPine, 16, 14);
      place(15, G.PATH_HALF + 34, drawTuft, 5, 4);
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
      place(11, G.PATH_HALF + 34, drawTuft, 5, 4);
    } else if (kind === 'crystals') {
      /* This branch grew its own placement loop and so never picked up the
         guards `place` carries — which is why glowing shards sprouted through
         the subway platform and out of open water. */
      for (let i = 0; i < 11; i++) {
        for (let tries = 0; tries < 40; tries++) {
          const x = 30 + rnd() * (G.W - 60), y = 40 + rnd() * (G.H - 80);
          if (!pathDistOk(level.paths, x, y, G.PATH_HALF + 36)) continue;
          if (waterHit(level, x, y, 26)) continue;
          if (inKeep(x, y)) continue;
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
    } else if (kind === 'industrial') {
      /* Bare winter trees on a fuel yard were a leftover from the game this
         used to be. A yard is drums, pipe and dropped brick. */
      place(9, G.PATH_HALF + 38, drawBarrel, 9, 5);
      place(7, G.PATH_HALF + 34, drawStone, 5, 7);
      place(4, G.PATH_HALF + 44, (cc, x, y, sz, r) => drawPipeRun(cc, x - sz * 2.4, y, x + sz * 2.4, y, sz * 0.8), 9, 4);
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
    const edgeFn = kind === 'crystals' ? drawCrystalShard
      : kind === 'dead' ? drawDeadTree
      : kind === 'industrial' ? drawStone   // a yard is fenced with dropped brick, not pines
      : drawPine;
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
        if (inKeep(x, y)) continue;
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

  /* ========================================================
     LANDMARKS — the builds that make a battlefield its name
     ========================================================
     Every battlefield is named after a place, and until these existed the
     place wasn't there: Fountain Square had no fountain, The Docks no dock,
     The Moat no castle. Each painter below is a micro-build in the same
     visual language as the props — front face, lit top, studs where a stud
     would show — and the DECOS table at the bottom dresses each board by
     hand. All of it bakes into the terrain canvas, so a battlefield full of
     landmarks costs exactly what an empty one did.

     Placement rule: nothing may crowd the track (the build clearance is
     PATH_HALF + TOWER_R + 12 ≈ 58px from the centreline) and nothing tall
     sits where it would read as buildable ground. Flat prints (pads,
     carpets, tunnel mouths, craters) are exempt — paint on the plate never
     blocks anything, and never looks like it should. */

  const HOUSE_WALLS = ['#f2f4f6', '#e8b93c', '#7ec8e8', '#f2f4f6'];
  const HOUSE_ROOFS = ['#c8443c', '#3f7fd4', '#c8443c', '#d9822b'];

  // the classic set-piece: bright walls, sloped roof, chimney — home in two bricks
  function drawHouse(c, x, y, s, rnd) {
    const pick = (rnd() * HOUSE_WALLS.length) | 0;
    const wall = HOUSE_WALLS[pick], roof = HOUSE_ROOFS[pick];
    const w = s * 2.2, wh = s * 1.05, rh = s * 0.85;
    propShadow(c, x, y + 2, w * 0.55);
    // walls with a lit face and a shaded side
    c.fillStyle = shade(wall, -30); c.fillRect(x - w / 2, y - wh, w, wh);
    c.fillStyle = wall; c.fillRect(x - w / 2, y - wh, w * 0.82, wh);
    c.strokeStyle = shade(wall, -58); c.lineWidth = 1.2; c.strokeRect(x - w / 2, y - wh, w, wh);
    // door and two windows
    c.fillStyle = '#7a5535';
    c.fillRect(x - s * 0.22, y - wh * 0.62, s * 0.44, wh * 0.62);
    c.fillStyle = shade('#7a5535', 30);
    c.fillRect(x - s * 0.22, y - wh * 0.62, s * 0.44, wh * 0.1);
    for (const wx of [x - w * 0.32, x + w * 0.3]) {
      c.fillStyle = '#f2f4f6'; c.fillRect(wx - s * 0.19, y - wh * 0.82, s * 0.38, s * 0.34);
      c.fillStyle = '#8fd0f0'; c.fillRect(wx - s * 0.14, y - wh * 0.82 + s * 0.05, s * 0.28, s * 0.24);
      c.strokeStyle = 'rgba(30,40,54,0.6)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(wx, y - wh * 0.82 + s * 0.05); c.lineTo(wx, y - wh * 0.82 + s * 0.29); c.stroke();
    }
    // the roof: two slope courses stepping in, then a ridge that catches the sun
    c.fillStyle = shade(roof, -26);
    c.beginPath(); c.moveTo(x - w * 0.58, y - wh); c.lineTo(x - w * 0.38, y - wh - rh * 0.55); c.lineTo(x + w * 0.38, y - wh - rh * 0.55); c.lineTo(x + w * 0.58, y - wh); c.closePath(); c.fill();
    c.fillStyle = roof;
    c.beginPath(); c.moveTo(x - w * 0.38, y - wh - rh * 0.55); c.lineTo(x - w * 0.2, y - wh - rh); c.lineTo(x + w * 0.2, y - wh - rh); c.lineTo(x + w * 0.38, y - wh - rh * 0.55); c.closePath(); c.fill();
    c.strokeStyle = shade(roof, 32); c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(x - w * 0.2, y - wh - rh); c.lineTo(x + w * 0.2, y - wh - rh); c.stroke();
    // chimney with its one proud stud
    c.fillStyle = shade(roof, -40); c.fillRect(x + w * 0.24, y - wh - rh - s * 0.28, s * 0.24, s * 0.34);
    c.fillStyle = shade(roof, -12); c.fillRect(x + w * 0.24, y - wh - rh - s * 0.28, s * 0.24, s * 0.1);
    c.beginPath(); c.ellipse(x + w * 0.24 + s * 0.12, y - wh - rh - s * 0.3, s * 0.08, s * 0.04, 0, 0, TAU);
    c.fillStyle = shade(roof, -30); c.fill();
  }

  // a barrel-roofed shed wide enough to park a shuttle in
  function drawHangar(c, x, y, s, rnd) {
    const w = s * 2.9, wh = s * 1.25;
    propShadow(c, x, y + 2, w * 0.55);
    c.fillStyle = '#77808a'; c.fillRect(x - w / 2, y - wh * 0.55, w, wh * 0.55);
    c.fillStyle = '#9aa4ae';
    c.beginPath(); c.moveTo(x - w / 2, y - wh * 0.55);
    c.quadraticCurveTo(x, y - wh * 1.25, x + w / 2, y - wh * 0.55);
    c.closePath(); c.fill();
    c.strokeStyle = '#5a636d'; c.lineWidth = 1.3;
    c.beginPath(); c.moveTo(x - w / 2, y - wh * 0.55);
    c.quadraticCurveTo(x, y - wh * 1.25, x + w / 2, y - wh * 0.55);
    c.lineTo(x + w / 2, y); c.lineTo(x - w / 2, y); c.closePath(); c.stroke();
    // ribs over the curve, then the big door with its hazard frame
    for (let i = -1; i <= 1; i++) {
      c.beginPath(); c.moveTo(x + i * w * 0.3, y - wh * (i ? 0.98 : 1.08) + wh * 0.35);
      c.lineTo(x + i * w * 0.3, y - wh * 0.55); c.stroke();
    }
    c.fillStyle = '#3a4450'; c.fillRect(x - w * 0.28, y - wh * 0.62, w * 0.56, wh * 0.62);
    c.fillStyle = '#e8b93c'; c.fillRect(x - w * 0.28, y - wh * 0.66, w * 0.56, wh * 0.07);
    c.strokeStyle = 'rgba(240,244,248,0.35)'; c.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      c.beginPath(); c.moveTo(x - w * 0.28, y - wh * 0.62 + i * wh * 0.15); c.lineTo(x + w * 0.28, y - wh * 0.62 + i * wh * 0.15); c.stroke();
    }
  }

  /* The town fountain. `R` is the BASIN radius, and on Fountain Square that
     is the map's pool radius — the pool IS the fountain, rather than a small
     ornament dropped into the middle of a lake.

     Built as a fountain is built and read from above: a stone kerb ring with
     studs on it, then tiers stepping up to the middle. The old version put a
     side-on pedestal in the centre of a top-down board, which is why it read
     as a manhole cover. Every tier here is a circle seen from overhead, and
     depth comes from the lit rim on each one. */
  function drawFountain(c, x, y, R, meta) {
    // the stone kerb, laid over the pool's own rim
    c.fillStyle = '#8b959f';
    c.beginPath(); c.arc(x, y, R + 10, 0, TAU); c.fill();
    c.fillStyle = '#a6b0ba';
    c.beginPath(); c.arc(x, y, R + 10, Math.PI * 0.92, Math.PI * 1.92); c.fill();
    c.fillStyle = '#5db4e4'; c.beginPath(); c.arc(x, y, R - 2, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(20,34,52,0.55)'; c.lineWidth = 2;
    c.beginPath(); c.arc(x, y, R + 10, 0, TAU); c.stroke();
    c.beginPath(); c.arc(x, y, R - 2, 0, TAU); c.stroke();
    // studs around the kerb — the basin is built, not carved
    const n = Math.max(12, Math.round(R / 9));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const sx = x + Math.cos(a) * (R + 4), sy = y + Math.sin(a) * (R + 4);
      c.fillStyle = '#c2ccd4';
      c.beginPath(); c.arc(sx, sy, R * 0.045 + 1.5, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(60,70,84,0.7)'; c.lineWidth = 0.9;
      c.beginPath(); c.arc(sx, sy, R * 0.045 + 1.5, 0, TAU); c.stroke();
    }
    // two tiers stepping up out of the water, each a lit disc from above
    const tier = (rr, top, lip) => {
      c.fillStyle = 'rgba(12,32,56,0.28)';
      c.beginPath(); c.ellipse(x + rr * 0.09, y + rr * 0.12, rr, rr, 0, 0, TAU); c.fill();
      c.fillStyle = lip; c.beginPath(); c.arc(x, y, rr, 0, TAU); c.fill();
      c.fillStyle = top; c.beginPath(); c.arc(x, y, rr * 0.82, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.45)'; c.lineWidth = 2;
      c.beginPath(); c.arc(x, y, rr, Math.PI * 0.95, Math.PI * 1.95); c.stroke();
      c.strokeStyle = 'rgba(30,44,62,0.5)'; c.lineWidth = 1.4;
      c.beginPath(); c.arc(x, y, rr, 0, TAU); c.stroke();
    };
    tier(R * 0.56, '#4fa8dc', '#9aa4ae');
    tier(R * 0.3, '#63bce8', '#b4bec8');
    // the spout the water actually comes out of
    c.fillStyle = '#c2ccd4';
    c.beginPath(); c.arc(x, y, R * 0.12, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(60,70,84,0.75)'; c.lineWidth = 1.2;
    c.beginPath(); c.arc(x, y, R * 0.12, 0, TAU); c.stroke();
    c.fillStyle = '#e8f6ff';
    c.beginPath(); c.arc(x - R * 0.03, y - R * 0.03, R * 0.06, 0, TAU); c.fill();
    if (meta) meta.fountains.push({ x, y, s: R });
  }

  // planks out over the water, on posts, going somewhere worth going
  function drawJetty(c, x, y, s, ang) {
    c.save();
    c.translate(x, y); c.rotate(ang || 0);
    const L = s * 3.4, W = s * 0.95;
    c.fillStyle = 'rgba(10,30,52,0.28)'; c.fillRect(0, -W / 2 + 3, L, W);
    c.fillStyle = '#a9825a'; c.fillRect(0, -W / 2, L, W);
    c.fillStyle = 'rgba(255,240,210,0.25)'; c.fillRect(0, -W / 2, L, W * 0.24);
    c.strokeStyle = 'rgba(70,50,30,0.55)'; c.lineWidth = 1.1;
    for (let d = s * 0.5; d < L; d += s * 0.5) {
      c.beginPath(); c.moveTo(d, -W / 2); c.lineTo(d, W / 2); c.stroke();
    }
    c.strokeRect(0, -W / 2, L, W);
    c.fillStyle = '#6b4f35';
    for (const px of [s * 0.3, L * 0.55, L - s * 0.25]) {
      for (const side of [-1, 1]) {
        c.beginPath(); c.arc(px, side * (W / 2 + 2), s * 0.13, 0, TAU); c.fill();
      }
    }
    c.restore();
  }

  // a tug the size of a bathtub: red hull, white deck, one blue cabin brick
  function drawBoat(c, x, y, s, rnd) {
    c.save();
    c.translate(x, y); c.rotate((rnd ? (rnd() - 0.5) * 0.5 : 0));
    c.fillStyle = 'rgba(8,26,48,0.3)';
    c.beginPath(); c.ellipse(s * 0.1, s * 0.28, s * 1.5, s * 0.5, 0, 0, TAU); c.fill();
    c.fillStyle = '#a03830';
    c.beginPath(); c.moveTo(-s * 1.3, 0); c.quadraticCurveTo(0, s * 0.72, s * 1.3, 0);
    c.lineTo(s * 1.5, -s * 0.2); c.lineTo(-s * 1.3, -s * 0.2); c.closePath(); c.fill();
    c.fillStyle = '#c8443c'; c.fillRect(-s * 1.3, -s * 0.5, s * 2.8, s * 0.34);
    c.fillStyle = '#f2f4f6'; c.fillRect(-s * 0.9, -s * 0.72, s * 1.6, s * 0.26);
    brickBlock(c, s * 0.05, -s * 0.7, s * 0.85, s * 0.5, '#3f7fd4', 2);
    c.fillStyle = '#2f3b47'; c.fillRect(-s * 0.62, -s * 1.06, s * 0.2, s * 0.36);
    c.fillStyle = '#e8b93c'; c.beginPath(); c.ellipse(-s * 0.52, -s * 1.1, s * 0.11, s * 0.05, 0, 0, TAU); c.fill();
    c.restore();
  }

  /* Parapets where the track crosses water: two low walls of grey brick
     with studs on top, following the path itself. `broken` knocks the middle
     out and tips a few bricks into the water — a causeway that lost its
     argument with time. */
  function drawBridgeRails(c, pts, dMid, len, rnd, broken) {
    for (const side of [-1, 1]) {
      for (let d = dMid - len / 2; d <= dMid + len / 2; d += 13) {
        if (broken && Math.abs(d - dMid) < len * 0.18) continue;
        const p = pathPoint(pts, d);
        const nx = Math.cos(p.ang + Math.PI / 2), ny = Math.sin(p.ang + Math.PI / 2);
        const bx = p.x + nx * side * (G.PATH_HALF + 9);
        const by = p.y + ny * side * (G.PATH_HALF + 9);
        c.save();
        c.translate(bx, by); c.rotate(p.ang);
        c.fillStyle = '#6b7580'; c.fillRect(-6.5, -4, 13, 9);
        c.fillStyle = '#9aa4ae'; c.fillRect(-6.5, -6, 13, 6);
        c.strokeStyle = 'rgba(40,50,62,0.7)'; c.lineWidth = 1; c.strokeRect(-6.5, -6, 13, 11);
        c.fillStyle = '#b4bec8';
        c.beginPath(); c.ellipse(0, -6, 3.4, 1.9, 0, 0, TAU); c.fill();
        c.restore();
      }
      if (broken) {
        const p = pathPoint(pts, dMid + (rnd() - 0.5) * len * 0.2);
        const nx = Math.cos(p.ang + Math.PI / 2), ny = Math.sin(p.ang + Math.PI / 2);
        brickBit(c, p.x + nx * side * (G.PATH_HALF + 16), p.y + ny * side * (G.PATH_HALF + 16), 11, 7, '#9aa4ae');
      }
    }
  }

  // a smooth landing circle painted on the deck — the one place with no studs
  function drawLandingPad(c, x, y, s, meta) {
    c.fillStyle = 'rgba(40,46,56,0.88)';
    c.beginPath(); c.arc(x, y, s, 0, TAU); c.fill();
    c.strokeStyle = '#e8b93c'; c.lineWidth = s * 0.07;
    c.beginPath(); c.arc(x, y, s * 0.82, 0, TAU); c.stroke();
    c.strokeStyle = 'rgba(240,244,248,0.8)'; c.lineWidth = s * 0.05;
    c.beginPath(); c.arc(x, y, s * 0.3, 0, TAU); c.stroke();
    // hazard ticks at the compass points
    c.strokeStyle = '#e8b93c'; c.lineWidth = s * 0.09;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + TAU / 8;
      c.beginPath();
      c.moveTo(x + Math.cos(a) * s * 0.9, y + Math.sin(a) * s * 0.9);
      c.lineTo(x + Math.cos(a) * s, y + Math.sin(a) * s);
      c.stroke();
    }
    if (meta) meta.pads.push({ x, y, r: s });
  }

  // an industrial tank: one big cylinder, hooped, with a hazard stripe
  function drawTank(c, x, y, s, col) {
    const w = s * 1.5, h = s * 1.9;
    propShadow(c, x, y + 2, w * 0.62);
    c.fillStyle = shade(col, -36); c.fillRect(x - w / 2, y - h, w, h);
    c.fillStyle = col; c.fillRect(x - w / 2, y - h, w * 0.68, h);
    c.fillStyle = shade(col, 30); c.fillRect(x - w * 0.34, y - h, w * 0.16, h);
    c.fillStyle = shade(col, 14);
    c.beginPath(); c.ellipse(x, y - h, w / 2, w * 0.2, 0, 0, TAU); c.fill();
    c.strokeStyle = shade(col, -58); c.lineWidth = 1.3;
    c.beginPath(); c.ellipse(x, y - h, w / 2, w * 0.2, 0, 0, TAU); c.stroke();
    c.strokeRect(x - w / 2, y - h, w, h);
    for (const hy of [y - h * 0.66, y - h * 0.33]) {
      c.beginPath(); c.moveTo(x - w / 2, hy); c.lineTo(x + w / 2, hy); c.stroke();
    }
    // hazard stripe at the base
    c.save();
    c.beginPath(); c.rect(x - w / 2, y - h * 0.16, w, h * 0.16); c.clip();
    c.fillStyle = '#e8b93c'; c.fillRect(x - w / 2, y - h * 0.16, w, h * 0.16);
    c.fillStyle = '#2f3b47';
    for (let d = -w; d < w; d += w * 0.3) {
      c.beginPath(); c.moveTo(x + d, y); c.lineTo(x + d + w * 0.15, y - h * 0.16);
      c.lineTo(x + d + w * 0.25, y - h * 0.16); c.lineTo(x + d + w * 0.1, y); c.closePath(); c.fill();
    }
    c.restore();
    c.fillStyle = shade(col, 24);
    c.beginPath(); c.ellipse(x, y - h - w * 0.12, w * 0.14, w * 0.07, 0, 0, TAU); c.fill();
  }

  // the rocket every spaceport keeps out front: white body, red nose, real fins
  function drawRocket(c, x, y, s) {
    propShadow(c, x, y + 2, s * 0.9);
    c.fillStyle = '#c8443c';
    for (const side of [-1, 1]) {
      c.beginPath();
      c.moveTo(x + side * s * 0.34, y - s * 0.9);
      c.lineTo(x + side * s * 0.86, y - s * 0.1);
      c.lineTo(x + side * s * 0.86, y); c.lineTo(x + side * s * 0.34, y - s * 0.28);
      c.closePath(); c.fill();
    }
    c.fillStyle = '#5a636d';
    c.beginPath(); c.moveTo(x - s * 0.26, y - s * 0.14); c.lineTo(x + s * 0.26, y - s * 0.14);
    c.lineTo(x + s * 0.18, y + s * 0.08); c.lineTo(x - s * 0.18, y + s * 0.08); c.closePath(); c.fill();
    c.fillStyle = '#d6d9dc'; c.fillRect(x - s * 0.34, y - s * 1.9, s * 0.68, s * 1.78);
    c.fillStyle = '#f2f4f6'; c.fillRect(x - s * 0.34, y - s * 1.9, s * 0.4, s * 1.78);
    c.strokeStyle = '#8b98a5'; c.lineWidth = 1.2;
    c.strokeRect(x - s * 0.34, y - s * 1.9, s * 0.68, s * 1.78);
    c.fillStyle = '#c8443c';
    c.beginPath(); c.moveTo(x - s * 0.34, y - s * 1.9);
    c.quadraticCurveTo(x, y - s * 2.65, x + s * 0.34, y - s * 1.9); c.closePath(); c.fill();
    c.fillStyle = '#3f7fd4'; c.beginPath(); c.arc(x, y - s * 1.5, s * 0.17, 0, TAU); c.fill();
    c.strokeStyle = '#f2f4f6'; c.lineWidth = 1.6;
    c.beginPath(); c.arc(x, y - s * 1.5, s * 0.17, 0, TAU); c.stroke();
  }

  // a lattice gantry leaning over whatever it services
  function drawGantry(c, x, y, s, dir) {
    dir = dir || 1;
    propShadow(c, x, y + 2, s * 0.7);
    c.strokeStyle = '#8b959f'; c.lineWidth = Math.max(2, s * 0.09); c.lineCap = 'round';
    const H = s * 2.7;
    c.beginPath(); c.moveTo(x - s * 0.28, y); c.lineTo(x - s * 0.28, y - H); c.stroke();
    c.beginPath(); c.moveTo(x + s * 0.28, y); c.lineTo(x + s * 0.28, y - H); c.stroke();
    c.lineWidth = Math.max(1.2, s * 0.05);
    for (let i = 0; i < 4; i++) {
      const yy = y - H * (i + 0.5) / 4.5;
      c.beginPath(); c.moveTo(x - s * 0.28, yy); c.lineTo(x + s * 0.28, yy - H * 0.09); c.stroke();
      c.beginPath(); c.moveTo(x + s * 0.28, yy); c.lineTo(x - s * 0.28, yy - H * 0.09); c.stroke();
    }
    c.lineWidth = Math.max(2, s * 0.09);
    c.beginPath(); c.moveTo(x, y - H); c.lineTo(x + dir * s * 1.15, y - H); c.stroke();
    c.beginPath(); c.moveTo(x + dir * s * 1.05, y - H); c.lineTo(x + dir * s * 1.05, y - H * 0.8); c.stroke();
    c.fillStyle = '#e8b93c';
    c.beginPath(); c.moveTo(x + dir * s * 1.05, y - H * 0.8); c.lineTo(x + dir * s * 0.95, y - H * 0.72); c.lineTo(x + dir * s * 1.15, y - H * 0.72); c.closePath(); c.fill();
    c.fillStyle = '#c8443c'; c.beginPath(); c.arc(x, y - H, s * 0.1, 0, TAU); c.fill();
  }

  /* A castle tower: round grey body, arrow slit, crenellated crown — and a
     cone roof with a pennant when it guards somewhere still lived-in.
     opts: { dark, roof: colour|false, glow } */
  function drawCastleTower(c, x, y, s, opts) {
    opts = opts || {};
    /* The dark stone used to be #4a4550, which on the black-plate maps it was
       invented for disappeared into the board — a keep nobody could see is
       not a landmark. Lifted until it separates while still reading black. */
    const col = opts.dark ? '#6b6478' : '#9aa4ae';
    const w = s * 1.35, h = s * 1.9;
    propShadow(c, x, y + 2, w * 0.6);
    c.fillStyle = shade(col, -34); c.fillRect(x - w / 2, y - h, w, h);
    c.fillStyle = col; c.fillRect(x - w / 2, y - h, w * 0.66, h);
    c.fillStyle = shade(col, 22); c.fillRect(x - w * 0.34, y - h, w * 0.16, h);
    c.strokeStyle = shade(col, -58); c.lineWidth = 1.3; c.strokeRect(x - w / 2, y - h, w, h);
    // brick courses
    c.strokeStyle = shade(col, -44); c.lineWidth = 0.9;
    for (let i = 1; i < 4; i++) {
      c.beginPath(); c.moveTo(x - w / 2, y - h * i / 4); c.lineTo(x + w / 2, y - h * i / 4); c.stroke();
    }
    // arrow slit, lit from inside if the keep is dark
    c.fillStyle = opts.glow || '#2f3b47';
    c.fillRect(x - s * 0.06, y - h * 0.72, s * 0.12, h * 0.3);
    // crenellated crown: merlons with a stud on each
    const my = y - h;
    c.fillStyle = shade(col, -10);
    c.fillRect(x - w * 0.62, my - s * 0.34, w * 1.24, s * 0.34);
    c.strokeStyle = shade(col, -58); c.strokeRect(x - w * 0.62, my - s * 0.34, w * 1.24, s * 0.34);
    for (let i = -1; i <= 1; i++) {
      const mx = x + i * w * 0.42;
      c.fillStyle = shade(col, 6); c.fillRect(mx - s * 0.14, my - s * 0.62, s * 0.28, s * 0.3);
      c.strokeStyle = shade(col, -58); c.strokeRect(mx - s * 0.14, my - s * 0.62, s * 0.28, s * 0.3);
      c.fillStyle = shade(col, 28);
      c.beginPath(); c.ellipse(mx, my - s * 0.64, s * 0.09, s * 0.05, 0, 0, TAU); c.fill();
    }
    if (opts.roof) {
      c.fillStyle = opts.roof;
      c.beginPath(); c.moveTo(x - w * 0.55, my - s * 0.6);
      c.lineTo(x, my - s * 1.7); c.lineTo(x + w * 0.55, my - s * 0.6); c.closePath(); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.22)';
      c.beginPath(); c.moveTo(x - w * 0.3, my - s * 0.6); c.lineTo(x, my - s * 1.7); c.lineTo(x - w * 0.02, my - s * 0.6); c.closePath(); c.fill();
      c.strokeStyle = '#8b98a5'; c.lineWidth = 1.6;
      c.beginPath(); c.moveTo(x, my - s * 1.7); c.lineTo(x, my - s * 2.05); c.stroke();
      c.fillStyle = '#e8b93c';
      c.beginPath(); c.moveTo(x, my - s * 2.05); c.lineTo(x + s * 0.42, y - h - s * 1.93); c.lineTo(x, my - s * 1.8); c.closePath(); c.fill();
    }
  }

  // a run of curtain wall between two points, courses offset like real brickwork
  function drawCurtainWall(c, x1, y1, x2, y2, s, dark) {
    const col = dark ? '#6b6478' : '#9aa4ae';
    const len = Math.hypot(x2 - x1, y2 - y1), ang = Math.atan2(y2 - y1, x2 - x1);
    c.save();
    c.translate(x1, y1); c.rotate(ang);
    const h = s * 1.15;
    c.fillStyle = 'rgba(25,42,62,0.16)'; c.fillRect(3, -h + 6, len, h);
    c.fillStyle = shade(col, -34); c.fillRect(0, -h, len, h);
    c.fillStyle = col; c.fillRect(0, -h, len, h * 0.62);
    c.fillStyle = shade(col, 22); c.fillRect(0, -h, len, h * 0.18);
    c.strokeStyle = shade(col, -58); c.lineWidth = 1.2; c.strokeRect(0, -h, len, h);
    c.strokeStyle = shade(col, -44); c.lineWidth = 0.8;
    for (let d = s * 0.55; d < len; d += s * 0.55) {
      c.beginPath(); c.moveTo(d, -h); c.lineTo(d, 0); c.stroke();
    }
    // battlements
    for (let d = s * 0.3; d < len - s * 0.2; d += s * 0.62) {
      c.fillStyle = shade(col, 6); c.fillRect(d, -h - s * 0.26, s * 0.3, s * 0.26);
      c.strokeStyle = shade(col, -58); c.strokeRect(d, -h - s * 0.26, s * 0.3, s * 0.26);
    }
    c.restore();
  }

  // dais, gold seat, red velvet — the chair the whole tier is marching on
  function drawThrone(c, x, y, s) {
    // red carpet running toward the seat, gold-edged, printed flat
    const carpet = s * 1.7;   // stops short of the pool below the dais
    c.fillStyle = 'rgba(160,44,40,0.55)'; c.fillRect(x - s * 0.55, y, s * 1.1, carpet);
    c.strokeStyle = 'rgba(232,185,60,0.7)'; c.lineWidth = 2;
    c.strokeRect(x - s * 0.55, y, s * 1.1, carpet);
    // two stepped dais plates, studs along the leading edge
    brickBlock(c, x, y + s * 0.4, s * 2.6, s * 0.34, '#b4bec8', 5);
    brickBlock(c, x, y + s * 0.08, s * 2.0, s * 0.3, '#d6d9dc', 4);
    // the throne itself
    c.fillStyle = shade('#e8b93c', -38); c.fillRect(x - s * 0.6, y - s * 1.5, s * 1.2, s * 1.28);
    c.fillStyle = '#e8b93c'; c.fillRect(x - s * 0.6, y - s * 1.5, s * 0.85, s * 1.28);
    c.strokeStyle = shade('#e8b93c', -60); c.lineWidth = 1.2;
    c.strokeRect(x - s * 0.6, y - s * 1.5, s * 1.2, s * 1.28);
    c.fillStyle = '#c8443c'; c.fillRect(x - s * 0.42, y - s * 1.28, s * 0.84, s * 0.8);
    c.fillStyle = shade('#c8443c', 24); c.fillRect(x - s * 0.42, y - s * 1.28, s * 0.84, s * 0.16);
    for (const side of [-1, 1]) {
      brickBlock(c, x + side * s * 0.72, y - s * 0.2, s * 0.3, s * 0.5, '#d4a92c', 1);
    }
    c.fillStyle = '#f2d060';
    c.beginPath(); c.ellipse(x - s * 0.38, y - s * 1.54, s * 0.1, s * 0.06, 0, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(x + s * 0.38, y - s * 1.54, s * 0.1, s * 0.06, 0, 0, TAU); c.fill();
    c.beginPath(); c.moveTo(x - s * 0.14, y - s * 1.52); c.lineTo(x, y - s * 1.78); c.lineTo(x + s * 0.14, y - s * 1.52); c.closePath(); c.fill();
  }

  /* An aqueduct span: pillars under a water channel, arches between.
     `broken` ends the run mid-arch with rubble below the break. */
  function drawArches(c, x, y, s, n, broken) {
    const aw = s * 1.25, h = s * 1.85;
    propShadow(c, x + (n * aw) / 2, y + 2, n * aw * 0.5);
    for (let i = 0; i <= n; i++) {
      if (broken && i === n) {
        for (let k = 0; k < 3; k++) {
          brickBit(c, x + i * aw - s * 0.2 + k * s * 0.32, y - s * 0.1 - (k % 2) * s * 0.2, s * 0.34, s * 0.22, '#b9a88a');
        }
        continue;
      }
      const px = x + i * aw;
      c.fillStyle = shade('#c9b28c', -38); c.fillRect(px - s * 0.19, y - h, s * 0.38, h);
      c.fillStyle = '#c9b28c'; c.fillRect(px - s * 0.19, y - h, s * 0.24, h);
      c.strokeStyle = shade('#c9b28c', -60); c.lineWidth = 1; c.strokeRect(px - s * 0.19, y - h, s * 0.38, h);
    }
    // arches between pillars
    c.strokeStyle = shade('#c9b28c', -46); c.lineWidth = s * 0.14;
    for (let i = 0; i < n - (broken ? 1 : 0); i++) {
      c.beginPath();
      c.arc(x + i * aw + aw / 2, y - h * 0.52, aw * 0.36, Math.PI, 0);
      c.stroke();
    }
    // the channel on top, a paler stone with a blue thread of water
    const L = (n - (broken ? 0.55 : 0)) * aw;
    c.fillStyle = shade('#c9b28c', -30); c.fillRect(x - s * 0.3, y - h - s * 0.42, L + s * 0.4, s * 0.42);
    c.fillStyle = '#d8c4a0'; c.fillRect(x - s * 0.3, y - h - s * 0.42, L + s * 0.4, s * 0.26);
    c.fillStyle = '#5db4e4'; c.fillRect(x - s * 0.22, y - h - s * 0.34, L + s * 0.28, s * 0.12);
    c.strokeStyle = shade('#c9b28c', -60); c.lineWidth = 1.1;
    c.strokeRect(x - s * 0.3, y - h - s * 0.42, L + s * 0.4, s * 0.42);
  }

  // a pennant on a pole — the cheapest way a road becomes a procession
  function drawBanner(c, x, y, s, col) {
    propShadow(c, x, y + 2, s * 0.35);
    c.strokeStyle = '#5a636d'; c.lineWidth = Math.max(1.6, s * 0.12); c.lineCap = 'round';
    c.beginPath(); c.moveTo(x, y); c.lineTo(x, y - s * 2.3); c.stroke();
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(x + s * 0.06, y - s * 2.25); c.lineTo(x + s * 1.15, y - s * 1.98);
    c.lineTo(x + s * 0.72, y - s * 1.75); c.lineTo(x + s * 1.15, y - s * 1.52);
    c.lineTo(x + s * 0.06, y - s * 1.25); c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.3)';
    c.beginPath(); c.moveTo(x + s * 0.06, y - s * 2.25); c.lineTo(x + s * 1.15, y - s * 1.98);
    c.lineTo(x + s * 0.06, y - s * 1.85); c.closePath(); c.fill();
    c.fillStyle = '#e8b93c';
    c.beginPath(); c.ellipse(x, y - s * 2.36, s * 0.12, s * 0.09, 0, 0, TAU); c.fill();
  }

  // corrugated freight, stacked the way freight always ends up: almost neatly
  function drawContainers(c, x, y, s, rnd) {
    const cols = ['#c8443c', '#3f7fd4', '#e8b93c', '#3fae6a'];
    propShadow(c, x, y + 2, s * 1.6);
    const box = (bx, by, col) => {
      const w = s * 1.8, h = s * 0.8;
      c.fillStyle = shade(col, -34); c.fillRect(bx - w / 2, by - h, w, h);
      c.fillStyle = col; c.fillRect(bx - w / 2, by - h, w * 0.72, h);
      c.fillStyle = shade(col, 22); c.fillRect(bx - w / 2, by - h, w, h * 0.18);
      c.strokeStyle = shade(col, -58); c.lineWidth = 1.1; c.strokeRect(bx - w / 2, by - h, w, h);
      c.strokeStyle = shade(col, -40); c.lineWidth = 0.8;
      for (let d = -w * 0.32; d <= w * 0.36; d += w * 0.17) {
        c.beginPath(); c.moveTo(bx + d, by - h * 0.82); c.lineTo(bx + d, by - h * 0.05); c.stroke();
      }
    };
    box(x - s * 0.15, y, cols[(rnd() * 4) | 0]);
    box(x + s * 1.1, y - s * 0.06, cols[(rnd() * 4) | 0]);
    box(x + s * 0.45, y - s * 0.82, cols[(rnd() * 4) | 0]);
  }

  // a standing stone with a rune of light down its face
  function drawObelisk(c, x, y, s, glow) {
    propShadow(c, x, y + 2, s * 0.5);
    c.fillStyle = '#3a3540';
    c.beginPath();
    c.moveTo(x - s * 0.42, y); c.lineTo(x - s * 0.2, y - s * 2.1);
    c.lineTo(x + s * 0.2, y - s * 2.1); c.lineTo(x + s * 0.42, y); c.closePath(); c.fill();
    c.fillStyle = '#524c5a';
    c.beginPath();
    c.moveTo(x - s * 0.42, y); c.lineTo(x - s * 0.2, y - s * 2.1);
    c.lineTo(x - s * 0.02, y - s * 2.1); c.lineTo(x - s * 0.1, y); c.closePath(); c.fill();
    c.strokeStyle = glow || '#8fb4ff'; c.lineWidth = 1.6; c.lineCap = 'round';
    c.beginPath(); c.moveTo(x, y - s * 1.85); c.lineTo(x, y - s * 0.4); c.stroke();
    c.fillStyle = glow || '#8fb4ff';
    c.beginPath(); c.arc(x, y - s * 1.95, s * 0.09, 0, TAU); c.fill();
  }

  // dish on a mount, listening to something the board can't see
  function drawDish(c, x, y, s) {
    propShadow(c, x, y + 2, s * 0.7);
    brickBlock(c, x, y, s * 1.1, s * 0.5, '#77808a', 2);
    c.strokeStyle = '#8b959f'; c.lineWidth = s * 0.14; c.lineCap = 'round';
    c.beginPath(); c.moveTo(x, y - s * 0.5); c.lineTo(x + s * 0.3, y - s * 1.1); c.stroke();
    c.save();
    c.translate(x + s * 0.42, y - s * 1.3); c.rotate(-0.5);
    c.fillStyle = '#e8eaec'; c.beginPath(); c.ellipse(0, 0, s * 0.85, s * 0.45, 0, 0, TAU); c.fill();
    c.fillStyle = '#c2ccd2'; c.beginPath(); c.ellipse(-s * 0.12, 0, s * 0.6, s * 0.3, 0, 0, TAU); c.fill();
    c.strokeStyle = '#8b98a5'; c.lineWidth = 1.2;
    c.beginPath(); c.ellipse(0, 0, s * 0.85, s * 0.45, 0, 0, TAU); c.stroke();
    c.fillStyle = '#c8443c'; c.beginPath(); c.arc(0, 0, s * 0.09, 0, TAU); c.fill();
    c.restore();
  }

  // an observatory dome with its shutter cracked open
  function drawDome(c, x, y, s, glow) {
    propShadow(c, x, y + 2, s * 1.1);
    c.fillStyle = '#5a636d'; c.fillRect(x - s * 1.05, y - s * 0.5, s * 2.1, s * 0.5);
    c.fillStyle = '#77808a'; c.fillRect(x - s * 1.05, y - s * 0.5, s * 2.1, s * 0.16);
    c.fillStyle = '#8b959f';
    c.beginPath(); c.arc(x, y - s * 0.5, s * 1.0, Math.PI, 0); c.closePath(); c.fill();
    c.fillStyle = '#a6b0ba';
    c.beginPath(); c.arc(x - s * 0.2, y - s * 0.5, s * 0.75, Math.PI, Math.PI * 1.6); c.stroke();
    c.fillStyle = glow || '#8fd0f0';
    c.beginPath();
    c.moveTo(x + s * 0.1, y - s * 1.48); c.lineTo(x + s * 0.42, y - s * 1.32);
    c.lineTo(x + s * 0.32, y - s * 0.52); c.lineTo(x + s * 0.06, y - s * 0.52);
    c.closePath(); c.fill();
    c.strokeStyle = '#5a636d'; c.lineWidth = 1.2;
    c.beginPath(); c.arc(x, y - s * 0.5, s * 1.0, Math.PI, 0); c.stroke();
  }

  // the tunnel the pack pours out of, printed flat so nothing has to duck
  function drawTunnelMouth(c, x, y, facing) {
    c.save();
    c.translate(x, y); c.rotate(facing || 0);
    c.fillStyle = 'rgba(12,16,26,0.85)';
    c.beginPath(); c.ellipse(0, 0, 30, G.PATH_HALF + 4, 0, -Math.PI / 2, Math.PI / 2); c.fill();
    c.strokeStyle = '#8b959f'; c.lineWidth = 7;
    c.beginPath(); c.ellipse(0, 0, 34, G.PATH_HALF + 8, 0, -Math.PI / 2, Math.PI / 2); c.stroke();
    c.strokeStyle = 'rgba(40,50,62,0.8)'; c.lineWidth = 1.4;
    c.beginPath(); c.ellipse(0, 0, 38, G.PATH_HALF + 12, 0, -Math.PI / 2, Math.PI / 2); c.stroke();
    c.beginPath(); c.ellipse(0, 0, 30, G.PATH_HALF + 4, 0, -Math.PI / 2, Math.PI / 2); c.stroke();
    // keystone
    c.fillStyle = '#b4bec8';
    c.fillRect(28, -7, 12, 14);
    c.strokeStyle = 'rgba(40,50,62,0.8)'; c.strokeRect(28, -7, 12, 14);
    c.restore();
  }

  // rooftop furniture: a humming grey box with a fan you can almost hear
  function drawACUnit(c, x, y, s) {
    propShadow(c, x, y + 2, s * 0.9);
    brickBlock(c, x, y, s * 1.7, s * 0.85, '#8b959f', 0);
    c.strokeStyle = '#5a636d'; c.lineWidth = 1.4;
    c.beginPath(); c.arc(x - s * 0.35, y - s * 0.45, s * 0.26, 0, TAU); c.stroke();
    c.beginPath(); c.moveTo(x - s * 0.35 - s * 0.18, y - s * 0.45); c.lineTo(x - s * 0.35 + s * 0.18, y - s * 0.45); c.stroke();
    c.beginPath(); c.moveTo(x - s * 0.35, y - s * 0.45 - s * 0.18); c.lineTo(x - s * 0.35, y - s * 0.45 + s * 0.18); c.stroke();
    c.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      c.beginPath(); c.moveTo(x + s * 0.14, y - s * 0.62 + i * s * 0.18); c.lineTo(x + s * 0.68, y - s * 0.62 + i * s * 0.18); c.stroke();
    }
  }

  // a mast with an orange windsock that has never once hung still
  function drawWindsock(c, x, y, s) {
    propShadow(c, x, y + 2, s * 0.4);
    c.strokeStyle = '#8b959f'; c.lineWidth = Math.max(1.6, s * 0.11); c.lineCap = 'round';
    c.beginPath(); c.moveTo(x, y); c.lineTo(x, y - s * 2.1); c.stroke();
    c.fillStyle = '#e07020';
    c.beginPath();
    c.moveTo(x + s * 0.04, y - s * 2.05); c.lineTo(x + s * 1.05, y - s * 1.85);
    c.lineTo(x + s * 1.05, y - s * 1.65); c.lineTo(x + s * 0.04, y - s * 1.6); c.closePath(); c.fill();
    c.fillStyle = '#f2f4f6';
    c.beginPath();
    c.moveTo(x + s * 0.38, y - s * 1.98); c.lineTo(x + s * 0.62, y - s * 1.93);
    c.lineTo(x + s * 0.62, y - s * 1.69); c.lineTo(x + s * 0.38, y - s * 1.66); c.closePath(); c.fill();
  }

  // a pipe run with flanged joints and one valve wheel worth turning
  function drawPipeRun(c, x1, y1, x2, y2, s) {
    const ang = Math.atan2(y2 - y1, x2 - x1), len = Math.hypot(x2 - x1, y2 - y1);
    c.save();
    c.translate(x1, y1); c.rotate(ang);
    c.strokeStyle = 'rgba(20,32,48,0.25)'; c.lineWidth = s * 0.5; c.lineCap = 'round';
    c.beginPath(); c.moveTo(2, 4); c.lineTo(len + 2, 4); c.stroke();
    c.strokeStyle = '#77808a'; c.lineWidth = s * 0.46;
    c.beginPath(); c.moveTo(0, 0); c.lineTo(len, 0); c.stroke();
    c.strokeStyle = '#a6b0ba'; c.lineWidth = s * 0.16;
    c.beginPath(); c.moveTo(0, -s * 0.1); c.lineTo(len, -s * 0.1); c.stroke();
    c.fillStyle = '#5a636d';
    for (let d = s * 0.8; d < len; d += s * 1.7) c.fillRect(d - s * 0.09, -s * 0.32, s * 0.18, s * 0.64);
    // the valve
    c.fillStyle = '#c8443c';
    c.beginPath(); c.arc(len * 0.5, -s * 0.42, s * 0.24, 0, TAU); c.fill();
    c.strokeStyle = shade('#c8443c', -50); c.lineWidth = 1.2;
    c.beginPath(); c.arc(len * 0.5, -s * 0.42, s * 0.24, 0, TAU); c.stroke();
    c.beginPath(); c.moveTo(len * 0.5, -s * 0.42); c.lineTo(len * 0.5, 0); c.stroke();
    c.restore();
  }

  // a crater printed on the deck — the plate remembers every rough landing
  function drawCrater(c, x, y, s, rnd) {
    c.save();
    c.globalAlpha = 0.5;
    c.fillStyle = 'rgba(20,28,40,0.35)';
    c.beginPath(); c.ellipse(x, y, s, s * 0.82, rnd() * TAU, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(210,220,232,0.4)'; c.lineWidth = 2;
    c.beginPath(); c.ellipse(x - 1.5, y - 2, s * 0.85, s * 0.68, 0, Math.PI * 0.9, Math.PI * 1.9); c.stroke();
    c.strokeStyle = 'rgba(16,22,32,0.5)';
    c.beginPath(); c.ellipse(x + 1.5, y + 2, s * 0.85, s * 0.68, 0, Math.PI * -0.1, Math.PI * 0.9); c.stroke();
    c.restore();
  }

  // an iron basket of fire beside the last door worth defending
  function drawBrazier(c, x, y, s, meta) {
    propShadow(c, x, y + 3, s * 0.6);
    c.strokeStyle = '#2f3b47'; c.lineWidth = Math.max(1.6, s * 0.12); c.lineCap = 'round';
    for (const side of [-1, 1]) {
      c.beginPath(); c.moveTo(x + side * s * 0.34, y + s * 0.06); c.lineTo(x + side * s * 0.16, y - s * 0.5); c.stroke();
    }
    c.fillStyle = '#3a4450';
    c.beginPath(); c.moveTo(x - s * 0.5, y - s * 0.9); c.lineTo(x + s * 0.5, y - s * 0.9);
    c.lineTo(x + s * 0.32, y - s * 0.44); c.lineTo(x - s * 0.32, y - s * 0.44); c.closePath(); c.fill();
    c.strokeStyle = '#1e2630'; c.lineWidth = 1.1;
    c.beginPath(); c.moveTo(x - s * 0.5, y - s * 0.9); c.lineTo(x + s * 0.5, y - s * 0.9);
    c.lineTo(x + s * 0.32, y - s * 0.44); c.lineTo(x - s * 0.32, y - s * 0.44); c.closePath(); c.stroke();
    if (meta) meta.torches.push({ x, y: y - s * 0.75 });
  }

  // a smooth marble column — dropped in a hall that lost its roof long ago
  function drawColumn(c, x, y, s) {
    propShadow(c, x, y + 2, s * 0.55);
    brickBlock(c, x, y, s * 1.05, s * 0.3, '#b4bec8', 0);
    c.fillStyle = shade('#d6d9dc', -30); c.fillRect(x - s * 0.3, y - s * 1.75, s * 0.6, s * 1.48);
    c.fillStyle = '#d6d9dc'; c.fillRect(x - s * 0.3, y - s * 1.75, s * 0.38, s * 1.48);
    c.fillStyle = '#f0f2f4'; c.fillRect(x - s * 0.16, y - s * 1.75, s * 0.12, s * 1.48);
    c.strokeStyle = '#8b98a5'; c.lineWidth = 1.1;
    c.strokeRect(x - s * 0.3, y - s * 1.75, s * 0.6, s * 1.48);
    brickBlock(c, x, y - s * 1.72, s * 1.0, s * 0.28, '#e8eaec', 2);
  }

  /* The civic centrepiece of tier 1: steps, four columns, a pediment and two
     wings — the building the other nine battlefields were fighting toward. */
  function drawCityHall(c, x, y, s) {
    const w = s * 4.6;
    propShadow(c, x, y + 3, w * 0.5);
    // steps
    brickBlock(c, x, y + s * 0.34, w * 0.72, s * 0.22, '#b4bec8', 0);
    brickBlock(c, x, y + s * 0.14, w * 0.6, s * 0.2, '#c8ccd2', 0);
    // wings
    for (const side of [-1, 1]) {
      const wx = x + side * w * 0.36;
      c.fillStyle = shade('#e3d8c2', -32); c.fillRect(wx - w * 0.14, y - s * 1.1, w * 0.28, s * 1.1);
      c.fillStyle = '#e3d8c2'; c.fillRect(wx - w * 0.14, y - s * 1.1, w * 0.2, s * 1.1);
      c.strokeStyle = shade('#e3d8c2', -58); c.lineWidth = 1.1;
      c.strokeRect(wx - w * 0.14, y - s * 1.1, w * 0.28, s * 1.1);
      c.fillStyle = '#8fd0f0';
      c.fillRect(wx - s * 0.3, y - s * 0.86, s * 0.24, s * 0.3);
      c.fillRect(wx + s * 0.08, y - s * 0.86, s * 0.24, s * 0.3);
      c.strokeStyle = 'rgba(30,40,54,0.5)';
      c.strokeRect(wx - s * 0.3, y - s * 0.86, s * 0.24, s * 0.3);
      c.strokeRect(wx + s * 0.08, y - s * 0.86, s * 0.24, s * 0.3);
    }
    // central block behind the columns
    c.fillStyle = shade('#efe6d2', -26); c.fillRect(x - w * 0.24, y - s * 1.5, w * 0.48, s * 1.5);
    c.fillStyle = '#efe6d2'; c.fillRect(x - w * 0.24, y - s * 1.5, w * 0.38, s * 1.5);
    c.fillStyle = '#5a4a38'; c.fillRect(x - s * 0.3, y - s * 0.78, s * 0.6, s * 0.78);
    c.fillStyle = shade('#5a4a38', 30); c.fillRect(x - s * 0.3, y - s * 0.78, s * 0.6, s * 0.12);
    // four columns
    for (let i = 0; i < 4; i++) {
      const cx = x - w * 0.18 + i * w * 0.12;
      c.fillStyle = '#f5efdf'; c.fillRect(cx - s * 0.09, y - s * 1.42, s * 0.18, s * 1.42);
      c.strokeStyle = 'rgba(120,105,80,0.6)'; c.lineWidth = 1;
      c.strokeRect(cx - s * 0.09, y - s * 1.42, s * 0.18, s * 1.42);
    }
    // entablature and pediment
    c.fillStyle = '#e8dfc8'; c.fillRect(x - w * 0.27, y - s * 1.72, w * 0.54, s * 0.3);
    c.strokeStyle = shade('#e8dfc8', -50); c.lineWidth = 1.1; c.strokeRect(x - w * 0.27, y - s * 1.72, w * 0.54, s * 0.3);
    c.fillStyle = '#efe6d2';
    c.beginPath(); c.moveTo(x - w * 0.28, y - s * 1.72); c.lineTo(x, y - s * 2.35); c.lineTo(x + w * 0.28, y - s * 1.72); c.closePath(); c.fill();
    c.strokeStyle = shade('#efe6d2', -50);
    c.beginPath(); c.moveTo(x - w * 0.28, y - s * 1.72); c.lineTo(x, y - s * 2.35); c.lineTo(x + w * 0.28, y - s * 1.72); c.closePath(); c.stroke();
    c.fillStyle = '#e8b93c'; c.beginPath(); c.arc(x, y - s * 1.95, s * 0.16, 0, TAU); c.fill();
    // rooftop flags
    for (const side of [-1, 1]) {
      const fx = x + side * w * 0.36;
      c.strokeStyle = '#8b98a5'; c.lineWidth = 1.4;
      c.beginPath(); c.moveTo(fx, y - s * 1.1); c.lineTo(fx, y - s * 1.65); c.stroke();
      c.fillStyle = '#c8443c';
      c.beginPath(); c.moveTo(fx, y - s * 1.65); c.lineTo(fx + side * s * 0.4, y - s * 1.55); c.lineTo(fx, y - s * 1.45); c.closePath(); c.fill();
    }
  }

  /* ---------- the dressing table ----------
     One entry per battlefield: `zones` keeps the scattered props out of the
     landmark's footprint, `skin` restyles a hand-placed blocker (the Old
     Quarter's no-build houses become houses), `paint` places the builds.
     Coordinates are world-space, chosen against each level's path list. */
  /* A roof, printed flat and painted UNDER the track (the `under` hook), so
     the road visibly climbs over the building rather than round it. Dark
     tile, a lit parapet on the sunward edges, and a grid of tile seams. */
  function drawRoofArea(c, x0, y0, w, h, col) {
    col = col || '#5d5350';
    c.save();
    c.fillStyle = shade(col, -18); c.fillRect(x0, y0, w, h);
    // tile seams
    c.strokeStyle = 'rgba(20,24,32,0.28)'; c.lineWidth = 1;
    for (let x = x0 + 34; x < x0 + w; x += 34) { c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y0 + h); c.stroke(); }
    for (let y = y0 + 34; y < y0 + h; y += 34) { c.beginPath(); c.moveTo(x0, y); c.lineTo(x0 + w, y); c.stroke(); }
    // the parapet wall running right around, lit top-left
    const P = 13;
    c.fillStyle = shade(col, 20); c.fillRect(x0, y0, w, P); c.fillRect(x0, y0, P, h);
    c.fillStyle = shade(col, -34); c.fillRect(x0, y0 + h - P, w, P); c.fillRect(x0 + w - P, y0, P, h);
    c.strokeStyle = 'rgba(255,255,255,0.30)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(x0, y0 + h); c.lineTo(x0, y0); c.lineTo(x0 + w, y0); c.stroke();
    c.strokeStyle = 'rgba(14,18,26,0.45)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(x0 + w, y0); c.lineTo(x0 + w, y0 + h); c.lineTo(x0, y0 + h); c.stroke();
    // studs along the parapet crest
    c.fillStyle = shade(col, 34);
    for (let x = x0 + 16; x < x0 + w; x += 32) {
      c.beginPath(); c.ellipse(x, y0 + 5, 5.5, 2.8, 0, 0, TAU); c.fill();
      c.beginPath(); c.ellipse(x, y0 + h - 5, 5.5, 2.8, 0, 0, TAU); c.fill();
    }
    c.restore();
  }

  /* A station platform beside the running track, printed flat: pale tile,
     the yellow safety line every platform in the world has, and a name board
     on two posts. This is what makes a dark serpentine read as The Subway. */
  function drawPlatform(c, x0, y, w, h) {
    c.save();
    c.fillStyle = '#8b8478'; c.fillRect(x0, y - h / 2, w, h);
    c.fillStyle = '#a49c8e'; c.fillRect(x0, y - h / 2, w, h * 0.55);
    c.strokeStyle = 'rgba(18,22,30,0.55)'; c.lineWidth = 1.6;
    c.strokeRect(x0, y - h / 2, w, h);
    c.strokeStyle = 'rgba(30,34,42,0.3)'; c.lineWidth = 1;
    for (let x = x0 + 32; x < x0 + w; x += 32) { c.beginPath(); c.moveTo(x, y - h / 2); c.lineTo(x, y + h / 2); c.stroke(); }
    // safety line down both edges
    c.fillStyle = '#e8b93c';
    c.fillRect(x0, y - h / 2 + 5, w, 5);
    c.fillRect(x0, y + h / 2 - 10, w, 5);
    // the name board
    const sx = x0 + w * 0.5;
    c.strokeStyle = '#5a636d'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(sx - 26, y + 6); c.lineTo(sx - 26, y - 12); c.stroke();
    c.beginPath(); c.moveTo(sx + 26, y + 6); c.lineTo(sx + 26, y - 12); c.stroke();
    c.fillStyle = '#2f5fa8'; c.fillRect(sx - 34, y - 26, 68, 17);
    c.strokeStyle = '#f2f4f6'; c.lineWidth = 1.4; c.strokeRect(sx - 34, y - 26, 68, 17);
    c.fillStyle = '#f2f4f6';
    for (let i = 0; i < 4; i++) c.fillRect(sx - 25 + i * 13, y - 20, 8, 5);
    // benches
    for (const bx of [x0 + w * 0.22, x0 + w * 0.78]) {
      c.fillStyle = '#7a5535'; c.fillRect(bx - 13, y - 5, 26, 8);
      c.fillStyle = '#8f6540'; c.fillRect(bx - 13, y - 5, 26, 3);
    }
    c.restore();
  }

  /* A recessed service pit with a hazard border, and coolant that got out of
     it. Flat print — it takes nothing away from the ground, it just explains
     why the yard is called what it is. */
  function drawServicePit(c, x, y, w, h, spill) {
    c.save();
    /* The spill goes down FIRST. Painted after, its translucent green sat on
       top of the pit's own hazard border and made the edge look printed on
       the puddle. Coolant runs out of the pit and across the deck; it does
       not run over the rim it came out of. */
    if (spill) {
      c.fillStyle = 'rgba(64,214,180,0.42)';
      c.beginPath();
      c.ellipse(x + w * 0.78, y + h * 0.42, w * 0.4, h * 0.62, 0.3, 0, TAU); c.fill();
      c.fillStyle = 'rgba(120,240,210,0.3)';
      c.beginPath();
      c.ellipse(x + w * 0.7, y + h * 0.3, w * 0.19, h * 0.3, 0.3, 0, TAU); c.fill();
    }
    c.fillStyle = 'rgba(24,30,40,0.82)'; c.fillRect(x - w / 2, y - h / 2, w, h);
    c.fillStyle = 'rgba(46,56,70,0.9)'; c.fillRect(x - w / 2, y - h / 2, w, 6);
    c.strokeStyle = '#e8b93c'; c.lineWidth = 4;
    c.strokeRect(x - w / 2, y - h / 2, w, h);
    c.strokeStyle = '#2f3b47'; c.lineWidth = 4;
    c.setLineDash([9, 9]);
    c.strokeRect(x - w / 2, y - h / 2, w, h);
    c.setLineDash([]);
    // the grating over it
    c.strokeStyle = 'rgba(150,162,178,0.5)'; c.lineWidth = 1.6;
    for (let d = x - w / 2 + 12; d < x + w / 2; d += 12) {
      c.beginPath(); c.moveTo(d, y - h / 2 + 4); c.lineTo(d, y + h / 2 - 4); c.stroke();
    }
    c.restore();
  }

  /* Concentric plate rings stepping down — the sunless bowl the battlefield
     is named for. Printed flat, so it is a shape in the floor, not an object
     standing on it. */
  function drawBasinRings(c, x, y, r) {
    c.save();
    for (let i = 0; i < 4; i++) {
      const rr = r * (1 - i * 0.22);
      c.fillStyle = `rgba(6,9,20,${0.2 + i * 0.15})`;
      c.beginPath(); c.ellipse(x, y, rr, rr * 0.82, 0, 0, TAU); c.fill();
      // each step gets a full dark outline first, so no lit arc reads as a
      // loose fragment hanging in the middle of the bowl
      c.strokeStyle = 'rgba(4,8,20,0.55)'; c.lineWidth = 2.4;
      c.beginPath(); c.ellipse(x, y, rr, rr * 0.82, 0, 0, TAU); c.stroke();
      c.strokeStyle = 'rgba(200,214,248,0.3)'; c.lineWidth = 2.4;
      c.beginPath(); c.ellipse(x, y - 2, rr, rr * 0.82, 0, Math.PI * 0.9, Math.PI * 1.9); c.stroke();
    }
    c.restore();
  }

  // a grey tank wall laid around a pool rim — the pool becomes a storage tank
  function drawTankRim(c, x, y, r) {
    c.save();
    c.strokeStyle = '#8b959f'; c.lineWidth = 11;
    c.beginPath(); c.arc(x, y, r + 5, 0, TAU); c.stroke();
    c.strokeStyle = '#aab4be'; c.lineWidth = 4;
    c.beginPath(); c.arc(x, y, r + 2, Math.PI * 0.9, Math.PI * 1.9); c.stroke();
    c.strokeStyle = 'rgba(40,50,62,0.75)'; c.lineWidth = 1.6;
    c.beginPath(); c.arc(x, y, r + 10.5, 0, TAU); c.stroke();
    c.beginPath(); c.arc(x, y, r - 0.5, 0, TAU); c.stroke();
    // bolt plates around the wall
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      c.fillStyle = '#c2ccd4';
      c.beginPath(); c.arc(x + Math.cos(a) * (r + 5), y + Math.sin(a) * (r + 5), 2.6, 0, TAU); c.fill();
    }
    c.restore();
  }

  // a brick gatehouse: two pillars and a lintel, framing where a pack comes in
  function drawGateArch(c, x, y, s, col) {
    col = col || '#b4bec8';
    const gap = G.PATH_HALF + 12;
    for (const side of [-1, 1]) {
      const py = y + side * (gap + s * 0.5);
      c.fillStyle = shade(col, -34); c.fillRect(x - s * 0.55, py - s * 0.62, s * 1.1, s * 1.24);
      c.fillStyle = col; c.fillRect(x - s * 0.55, py - s * 0.62, s * 1.1, s * 0.5);
      c.strokeStyle = shade(col, -60); c.lineWidth = 1.3;
      c.strokeRect(x - s * 0.55, py - s * 0.62, s * 1.1, s * 1.24);
      c.fillStyle = shade(col, 26);
      c.beginPath(); c.ellipse(x - s * 0.22, py - s * 0.72, s * 0.2, s * 0.1, 0, 0, TAU); c.fill();
      c.beginPath(); c.ellipse(x + s * 0.22, py - s * 0.72, s * 0.2, s * 0.1, 0, 0, TAU); c.fill();
    }
    // the lintel spanning the gap, with a keystone
    c.fillStyle = shade(col, -20);
    c.fillRect(x - s * 0.32, y - gap, s * 0.64, gap * 2);
    c.fillStyle = 'rgba(255,255,255,0.16)';
    c.fillRect(x - s * 0.32, y - gap, s * 0.2, gap * 2);
    c.strokeStyle = shade(col, -60); c.lineWidth = 1.2;
    c.strokeRect(x - s * 0.32, y - gap, s * 0.64, gap * 2);
    c.fillStyle = '#e8b93c';
    c.fillRect(x - s * 0.2, y - s * 0.32, s * 0.4, s * 0.64);
  }

  /* A city block seen from above: roof, plant, and a lit face on the two
     sunward sides so it has height. Tier 1 is called Brick City and had no
     buildings taller than a cottage anywhere on it. */
  function drawTowerBlock(c, x, y, w, h, col) {
    col = col || '#b9563f';
    c.fillStyle = 'rgba(25,42,62,0.22)';
    c.fillRect(x - w / 2 + 7, y - h / 2 + 9, w, h);
    c.fillStyle = shade(col, -30); c.fillRect(x - w / 2, y - h / 2, w, h);
    c.fillStyle = col; c.fillRect(x - w / 2, y - h / 2, w * 0.82, h * 0.84);
    c.strokeStyle = shade(col, -58); c.lineWidth = 1.6;
    c.strokeRect(x - w / 2, y - h / 2, w, h);
    // window rows, printed on the roof face the way a top-down build shows them
    c.fillStyle = 'rgba(150,205,240,0.75)';
    for (let wy = y - h / 2 + 12; wy < y + h / 2 - 10; wy += 17) {
      for (let wx = x - w / 2 + 11; wx < x + w / 2 - 12; wx += 16) c.fillRect(wx, wy, 8, 8);
    }
    // the roof itself, inset, with its furniture
    c.fillStyle = shade(col, -46);
    c.fillRect(x - w * 0.3, y - h * 0.3, w * 0.6, h * 0.6);
    c.fillStyle = shade(col, -18);
    c.fillRect(x - w * 0.3, y - h * 0.3, w * 0.6, h * 0.12);
    c.strokeStyle = shade(col, -62); c.lineWidth = 1.2;
    c.strokeRect(x - w * 0.3, y - h * 0.3, w * 0.6, h * 0.6);
    c.fillStyle = '#8b959f';
    c.fillRect(x - w * 0.16, y - h * 0.14, w * 0.16, h * 0.16);
    c.fillStyle = '#c8443c';
    c.beginPath(); c.arc(x + w * 0.18, y + h * 0.16, 3.4, 0, TAU); c.fill();
    // studs along the parapet
    c.fillStyle = shade(col, 26);
    for (let sx2 = x - w / 2 + 9; sx2 < x + w / 2 - 6; sx2 += 18) {
      c.beginPath(); c.ellipse(sx2, y - h / 2 + 5, 5, 2.6, 0, 0, TAU); c.fill();
    }
  }

  const DECOS = {
    /* -- tier 1, Brick City -- */
    shores: {
      paint(c, L, rnd, meta) {
        // a small yard inside the upper bend, where the eye actually goes
        drawHouse(c, 455, 322, 27, rnd);
        drawHouse(c, 570, 318, 24, rnd);
        drawTuft(c, 512, 330, 7, rnd); drawTuft(c, 625, 326, 7, rnd);
        drawHouse(c, 790, 706, 24, rnd);
        drawHouse(c, 905, 686, 20, rnd);
        drawTuft(c, 862, 712, 6, rnd);
      },
    },
    pass: {
      paint(c, L, rnd, meta) {
        // the tower blocks the switchbacks run between
        drawTowerBlock(c, 400, 205, 150, 78, '#b9563f');
        drawTowerBlock(c, 800, 205, 138, 74, '#4a6f9c');
        drawTowerBlock(c, 430, 395, 146, 74, '#4a6f9c');
        drawTowerBlock(c, 850, 395, 152, 76, '#c8a13c');
        drawTowerBlock(c, 620, 585, 158, 74, '#b9563f');
        // and the shops along the kerb
        drawHouse(c, 1205, 250, 22, rnd);
        drawHouse(c, 1200, 425, 24, rnd);
        drawHouse(c, 62, 430, 20, rnd);
      },
    },
    river: {
      paint(c, L, rnd, meta) {
        const pts = L.paths[0];
        // parapets where the track fords the canal, and traffic on the water
        drawBridgeRails(c, pts, 780, 170, rnd);    // x=500 crossing, mid-ford
        drawBridgeRails(c, pts, 1365, 170, rnd);   // x=850 crossing
        drawBridgeRails(c, pts, 1895, 170, rnd);   // x=1150 crossing
        drawBoat(c, 300, 412, 13, rnd);
        drawBoat(c, 680, 418, 11, rnd);
        // the terrace along the north bank — the Street half of Canal Street
        drawHouse(c, 250, 232, 26, rnd);
        drawHouse(c, 350, 236, 24, rnd);
        drawHouse(c, 640, 230, 27, rnd);
        drawHouse(c, 742, 234, 25, rnd);
        drawTowerBlock(c, 980, 640, 140, 74, '#4a6f9c');
      },
    },
    alley: {
      paint(c, L, rnd, meta) {
        // the two gates the battlefield is named for, built as gatehouses
        drawGateArch(c, 40, 150, 26, '#b4bec8');
        drawGateArch(c, 40, 650, 26, '#c9b28c');
        drawHouse(c, 118, 62, 20, rnd);
        drawHouse(c, 96, 748, 21, rnd);
      },
    },
    village: {
      /* The no-build houses ARE the quarter, so they are drawn at full
         blocker size rather than the two-thirds that made them doll's
         houses inside a 650px loop. */
      skin(c, b, rnd) {
        if (b.kind !== 'fort' || b.gen) return false;
        drawHouse(c, b.x, b.y + b.r * 0.5, b.r, rnd);
        return true;
      },
      paint(c, L, rnd, meta) {
        // a second row of houses along the top of the loop's inner ground
        drawHouse(c, 410, 336, 25, rnd);
        drawHouse(c, 640, 340, 27, rnd);
        drawHouse(c, 865, 334, 24, rnd);
        drawSnowman(c, 640, 96, 15, rnd);   // the statue in the square
        drawTuft(c, 545, 344, 7, rnd); drawTuft(c, 745, 342, 7, rnd);
        drawTuft(c, 585, 108, 7, rnd); drawTuft(c, 697, 104, 7, rnd);
      },
    },
    caves: {
      under(c, L, rnd, meta) {
        drawPlatform(c, 350, 196, 540, 74);   // flat print, so the track owns it
      },
      paint(c, L, rnd, meta) {
        drawTunnelMouth(c, 34, 120, 0);       // the mouth the pack pours out of
        // platform lamps, on the safe side of the line
        for (const lx of [400, 540, 700, 840]) drawTorchBase(c, lx, 186);
        for (const lx of [400, 540, 700, 840]) meta.torches.push({ x: lx, y: 186 });
      },
    },
    ridge: {
      /* The square itself, printed under the track: a town square is paved.
         The fountain was standing in a meadow. */
      under(c, L, rnd, meta) {
        c.save();
        c.fillStyle = 'rgba(150,150,142,0.5)';
        c.beginPath();
        c.moveTo(255, 400); c.lineTo(452, 168); c.lineTo(828, 168);
        c.lineTo(1025, 400); c.lineTo(828, 632); c.lineTo(452, 632);
        c.closePath(); c.fill();
        c.clip();
        c.strokeStyle = 'rgba(70,74,80,0.22)'; c.lineWidth = 1.2;
        for (let x = 256; x < 1030; x += 48) { c.beginPath(); c.moveTo(x, 150); c.lineTo(x, 650); c.stroke(); }
        for (let y = 168; y < 640; y += 48) { c.beginPath(); c.moveTo(250, y); c.lineTo(1030, y); c.stroke(); }
        c.restore();
      },
      paint(c, L, rnd, meta) {
        drawFountain(c, 640, 400, 105, meta); // the pool IS the fountain here
        drawTuft(c, 570, 262, 7, rnd); drawTuft(c, 712, 258, 7, rnd);
        drawTuft(c, 570, 545, 7, rnd); drawTuft(c, 712, 542, 7, rnd);
      },
    },
    bay: {
      paint(c, L, rnd, meta) {
        // real piers, long enough to read as a waterfront from across the board
        drawJetty(c, 372, 505, 26, 0.30);     // out into the central pool
        drawJetty(c, 812, 258, 22, 2.55);     // out into the eastern pool
        drawJetty(c, 1058, 742, 20, -0.55);
        drawBoat(c, 545, 470, 16, rnd);
        drawBoat(c, 928, 372, 13, rnd);
        drawGantry(c, 762, 486, 19, -1);      // the dock crane
        drawBarrel(c, 700, 512, 11, rnd); drawBarrel(c, 726, 522, 10, rnd);
      },
    },
    peak: {
      /* The track chevrons up to (640,420) and back down, and the board is
         named for what it climbs over — so the building goes down first and
         the road runs across its roof. */
      under(c, L, rnd, meta) {
        drawRoofArea(c, 330, 216, 620, 400);
      },
      paint(c, L, rnd, meta) {
        // rooftop furniture: this board is the top of a building
        drawACUnit(c, 432, 306, 30);
        drawACUnit(c, 828, 302, 28);
        drawACUnit(c, 430, 545, 24);
        drawChimneyBlock(c, 620, 282, 26);
        drawChimneyBlock(c, 836, 552, 22);
        drawACUnit(c, 200, 460, 15);
        drawACUnit(c, 1150, 268, 14);
        c.strokeStyle = '#8b959f'; c.lineWidth = 2.4; c.lineCap = 'round';
        c.beginPath(); c.moveTo(500, 208); c.lineTo(500, 148); c.stroke();
        c.beginPath(); c.moveTo(492, 162); c.lineTo(508, 162); c.stroke();
        c.beginPath(); c.moveTo(495, 175); c.lineTo(505, 175); c.stroke();
        c.fillStyle = '#c8443c'; c.beginPath(); c.arc(500, 145, 3.4, 0, TAU); c.fill();
        drawChimneyBlock(c, 340, 500, 13);
        drawChimneyBlock(c, 1010, 500, 12);
      },
    },
    workshop: {
      skin(c, b, rnd) {
        if (b.kind !== 'fort' || b.gen) return false;
        drawHouse(c, b.x, b.y + b.r * 0.5, b.r * 0.6, rnd);
        return true;
      },
      paint(c, L, rnd, meta) {
        /* City Hall stands BEHIND the base, at the end of the last stretch —
           it is the thing the whole tier is defending, so it belongs where
           the player is looking, at the size of a civic building. */
        drawCityHall(c, 660, 768, 40);
        drawTuft(c, 452, 800, 8, rnd); drawTuft(c, 872, 796, 8, rnd);
        drawTowerBlock(c, 375, 225, 140, 74, '#4a6f9c');   // clear of the NW pool and both lanes
      },
    },

    /* -- tier 2, Star Port -- */
    flats: {
      paint(c, L, rnd, meta) {
        drawLandingPad(c, 850, 690, 80, meta);
        drawLandingPad(c, 1250, 730, 44, meta);
        drawRocket(c, 1290, 185, 26);
        drawWindsock(c, 640, 640, 15);
      },
    },
    fjord: {
      paint(c, L, rnd, meta) {
        drawPipeRun(c, 925, 372, 1135, 372, 14);   // over the coolant channel
        drawTank(c, 640, 168, 22, '#2fa4a8');
        drawTank(c, 200, 162, 17, '#2fa4a8');
      },
    },
    cataracts: {
      paint(c, L, rnd, meta) {
        const pts = L.paths[0];
        drawBridgeRails(c, pts, 215, 160, rnd);    // x=200 over the north run
        drawBridgeRails(c, pts, 2635, 170, rnd);   // x=1400 over the south run
        drawTank(c, 860, 500, 20, '#2fa4a8');
        drawTank(c, 925, 512, 16, '#3f7fd4');
        drawPipeRun(c, 120, 348, 320, 348, 13);
      },
    },
    shelf: {
      paint(c, L, rnd, meta) {
        /* The freight yard, in the pocket the two lanes braid around. Three
           stacks at s=16 scattered into the corners was the entire cargo on
           a board called Cargo Deck. */
        drawContainers(c, 545, 622, 34, rnd);
        drawContainers(c, 760, 628, 34, rnd);
        drawContainers(c, 968, 620, 32, rnd);
        drawGantry(c, 1006, 648, 32, -1);
        drawContainers(c, 160, 620, 18, rnd);
        drawContainers(c, 1250, 700, 19, rnd);
      },
    },
    rookery: {
      /* The three no-build blockers become a row of hangar bays, at full
         blocker size — the road coils around them, so they have to be the
         thing you see. */
      skin(c, b, rnd) {
        if (b.kind !== 'fort' || b.gen) return false;
        drawHangar(c, b.x, b.y + b.r * 0.9, b.r * 1.2, rnd);
        return true;
      },
      paint(c, L, rnd, meta) {
        // clear of the western pool (its right edge is x=195) and of the bay row
        drawHangar(c, 312, 342, 58, rnd);      // the big bay in the coil's eye
        drawHangar(c, 210, 838, 46, rnd);
        drawWindsock(c, 1000, 306, 16);
        drawWindsock(c, 424, 340, 15);
      },
    },
    basin: {
      under(c, L, rnd, meta) {
        drawBasinRings(c, 1060, 470, 172);   // the sunless bowl itself
      },
      paint(c, L, rnd, meta) {
        drawDome(c, 200, 152, 22, '#8fb4ff');
        drawDish(c, 1435, 310, 18);
        drawObelisk(c, 1060, 400, 14, '#8fb4ff');
      },
    },
    sable: {
      under(c, L, rnd, meta) {
        drawServicePit(c, 655, 818, 250, 64, true);   // the pit, and what left it
      },
      paint(c, L, rnd, meta) {
        /* The yard sits in the band between the coolant pool (bottom edge
           y=690) and the board edge — the tanks were standing in the water. */
        drawTank(c, 545, 760, 22, '#e8b93c');
        drawTank(c, 655, 766, 25, '#c8443c');
        drawTank(c, 765, 760, 22, '#e8b93c');
        drawPipeRun(c, 505, 776, 805, 776, 12);
        drawBarrel(c, 455, 790, 12, rnd); drawBarrel(c, 482, 802, 11, rnd);
        drawBarrel(c, 855, 790, 12, rnd);
        drawTank(c, 250, 262, 16, '#77808a');
      },
    },
    floes: {
      paint(c, L, rnd, meta) {
        // the pools ARE the tank farm — give each a bolted steel wall
        for (const wt of L.water) if (!wt.rect) drawTankRim(c, wt.x, wt.y, wt.r);
        drawTank(c, 945, 100, 20, '#3f7fd4');
        drawTank(c, 1030, 112, 17, '#2fa4a8');
        drawTank(c, 118, 770, 18, '#3f7fd4');
        drawTank(c, 190, 780, 15, '#e8b93c');
      },
    },
    stormwall: {
      paint(c, L, rnd, meta) {
        drawDish(c, 100, 90, 19);
        drawDish(c, 1380, 808, 17);
        drawObelisk(c, 620, 62, 15, '#a8d8ff');   // the lightning rod
      },
    },
    longdark: {
      paint(c, L, rnd, meta) {
        /* One installation, not three ornaments in a corner: the pad, the
           gantry standing over it and the ship it is servicing, grouped and
           scaled so the dock reads as the dock. */
        drawLandingPad(c, 1140, 150, 108, meta);
        drawGantry(c, 1016, 178, 34, 1);
        drawRocket(c, 1146, 172, 40);
        drawDish(c, 320, 112, 24);
        drawContainers(c, 250, 200, 16, rnd);
      },
    },

    /* -- tier 3, Castle Realm -- */
    approach: {
      paint(c, L, rnd, meta) {
        // the procession to the gate...
        const cols = ['#c8443c', '#3f7fd4', '#e8b93c'];
        for (let i = 0; i < 6; i++) {
          const bx = 170 + i * 180;
          drawBanner(c, bx, i % 2 ? 158 : 330, 20, cols[i % 3]);
        }
        // ...and the castle wall it ends at
        drawCurtainWall(c, 30, 880, 260, 880, 22);
        drawCurtainWall(c, 545, 880, 782, 880, 22);
        drawCastleTower(c, 280, 892, 19, { roof: '#3f7fd4' });
        drawCastleTower(c, 525, 892, 19, { roof: '#3f7fd4' });
        drawCastleTower(c, 792, 892, 19, { roof: '#c8443c' });   // the wall has to END somewhere
      },
    },
    causeway: {
      paint(c, L, rnd, meta) {
        const pts = L.paths[0];
        // the causeway crossings, in ruins
        drawBridgeRails(c, pts, 1115, 150, rnd, true);   // x=700 ford
        drawBridgeRails(c, pts, 1985, 150, rnd, true);   // x=1160 ford
        drawBridgeRails(c, pts, 2775, 150, rnd, true);   // x=1560 ford
        /* The span that did not survive, standing IN the ditch it used to
           cross — which is the only place a broken bridge means anything. */
        drawArches(c, 800, 545, 40, 5, true);
        brickBit(c, 1010, 512, 17, 10, '#b9a88a');
        brickBit(c, 1048, 528, 14, 9, '#9aa4ae');
        brickBit(c, 985, 544, 12, 8, '#b9a88a');
        drawFloe(c, 1075, 500, 15, rnd);
      },
    },
    trench: {
      paint(c, L, rnd, meta) {
        // the enormous thing in the water is a drowned keep
        drawCurtainWall(c, 556, 690, 772, 694, 20);
        drawCastleTower(c, 572, 706, 24, {});
        drawCastleTower(c, 764, 710, 24, {});
        drawCastleTower(c, 664, 726, 40, { glow: '#6f9ce8' });
      },
    },
    obsidian: {
      paint(c, L, rnd, meta) {
        /* The keep wall runs ACROSS the top track and stops either side of
           it: the gap the pack pours through is the breach the tagline
           promises, instead of a strip of dark-on-dark along the edge. */
        drawCurtainWall(c, 786, 40, 786, 152, 34, true);
        drawCurtainWall(c, 786, 256, 786, 400, 34, true);
        drawCastleTower(c, 762, 176, 28, { dark: true, glow: '#8fb4ff' });
        drawCastleTower(c, 762, 300, 28, { dark: true, glow: '#8fb4ff' });
        drawCastleTower(c, 762, 424, 22, { dark: true });
        // what came out of the breach, spilled across the lane
        brickBit(c, 706, 212, 17, 10, '#6b6478');
        brickBit(c, 836, 224, 15, 9, '#6b6478');
        brickBit(c, 742, 236, 13, 8, '#8a8298');
        drawCastleTower(c, 1545, 138, 18, { dark: true, glow: '#8fb4ff' });
      },
    },
    cathedral: {
      paint(c, L, rnd, meta) {
        /* Two colonnades running the hall's long axis, either side of the
           great pool — a hall is a room, and a room needs walls you can
           follow. Four 15px columns in a 700px hexagon was a garden. */
        for (let i = 0; i < 5; i++) {
          const cx = 660 + i * 92;
          drawColumn(c, cx, 262, 26);
          drawColumn(c, cx, 668, 26);
        }
        drawBanner(c, 596, 250, 17, '#c8443c'); drawBanner(c, 1128, 254, 17, '#3f7fd4');
        drawBanner(c, 596, 664, 17, '#3f7fd4'); drawBanner(c, 1128, 668, 17, '#c8443c');
      },
    },
    maelstrom: {
      paint(c, L, rnd, meta) {
        // the mill: house on the bank, wheel turning in the race. The wheel
        // is baked stopped so thumbnails have it; in battle the animated one
        // draws over this exact spot and it turns.
        drawHouse(c, 880, 330, 34, rnd);
        brickBlock(c, 790, 330, 14, 40, '#5d4a38', 0);
        drawStaticWheel(c, 748, 300, 68);
        if (meta) meta.wheels.push({ x: 748, y: 300, r: 68 });
      },
    },
    icefall: {
      paint(c, L, rnd, meta) {
        /* Three stranded runs of aqueduct. They were drawn at s=20 and read
           as garden trellises on a 1600px board — an aqueduct is the biggest
           thing for miles, so these now span most of the open bands. */
        drawArches(c, 150, 100, 42, 6, false);
        drawArches(c, 900, 100, 40, 7, true);
        drawArches(c, 340, 790, 36, 6, true);
      },
    },
    blackice: {
      paint(c, L, rnd, meta) {
        /* Black stone walls running WITH the lanes, so the three packs read
           as picking their way through a maze rather than across a car park.
           Hard against the lane edges, never across them. */
        drawCurtainWall(c, 300, 236, 720, 236, 22, true);
        drawCurtainWall(c, 980, 236, 1300, 236, 22, true);
        drawCurtainWall(c, 420, 560, 860, 560, 22, true);
        drawCurtainWall(c, 1000, 745, 1330, 745, 22, true);
        drawCastleTower(c, 740, 250, 22, { dark: true, glow: '#5f92e2' });
        drawCastleTower(c, 960, 250, 22, { dark: true, glow: '#5f92e2' });
        drawObelisk(c, 450, 68, 20, '#5f92e2');
        drawObelisk(c, 1500, 605, 20, '#5f92e2');
      },
    },
    throne: {
      paint(c, L, rnd, meta) {
        drawThrone(c, 855, 620, 46);          // the old seat itself
        drawColumn(c, 700, 305, 24); drawColumn(c, 1000, 305, 24);
        drawColumn(c, 700, 640, 24); drawColumn(c, 1000, 645, 24);
        drawBanner(c, 742, 596, 19, '#c8443c'); drawBanner(c, 962, 600, 19, '#e8b93c');
      },
    },
    worldsend: {
      paint(c, L, rnd, meta) {
        // the Last Wall, and fire beside the door it guards
        drawCurtainWall(c, 880, 100, 1230, 104, 20);
        drawCastleTower(c, 862, 114, 20, {});
        drawCastleTower(c, 1052, 118, 24, { glow: '#ffb347' });
        drawCastleTower(c, 1245, 114, 20, {});
        drawBanner(c, 930, 60, 12, '#c8443c');
        drawBanner(c, 1170, 60, 12, '#c8443c');
        drawBrazier(c, 330, 858, 13, meta);
        drawBrazier(c, 470, 858, 13, meta);
      },
    },
  };

  // the mill wheel at rest — same geometry the animated overlay redraws
  function drawStaticWheel(c, x, y, r) {
    c.save();
    c.translate(x, y);
    c.strokeStyle = '#5d4a38'; c.lineWidth = r * 0.2;
    c.beginPath(); c.arc(0, 0, r * 0.85, 0, TAU); c.stroke();
    c.strokeStyle = '#7a5535'; c.lineWidth = r * 0.09;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU;
      c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85); c.stroke();
      c.beginPath(); c.moveTo(Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85);
      c.lineTo(Math.cos(a) * r * 1.08, Math.sin(a) * r * 1.08); c.stroke();
    }
    c.fillStyle = '#e8b93c';
    c.beginPath(); c.arc(0, 0, r * 0.14, 0, TAU); c.fill();
    c.restore();
  }

  // a chimney for the rooftops — brick red, two studs, a soot-dark flue
  function drawChimneyBlock(c, x, y, s) {
    propShadow(c, x, y + 2, s * 0.5);
    brickBlock(c, x, y, s * 0.9, s * 1.1, '#a03830', 2);
    c.fillStyle = '#1e2630';
    c.beginPath(); c.ellipse(x, y - s * 1.28, s * 0.26, s * 0.1, 0, 0, TAU); c.fill();
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

    /* Living landmarks. Each of these is a handful of arcs a frame on one or
       two battlefields — the point is that the board's namesake moves. */
    for (let i = 0; i < (meta.fountains || []).length; i++) {
      const f = meta.fountains[i];
      /* Droplets thrown up from the spout and falling back. `f.s` is the
         basin radius, so the jet is sized as a fraction of it — the spray
         belongs to the middle tier, not to the whole pool. */
      const j = f.s * 0.42;
      ctx.fillStyle = 'rgba(235,248,255,0.8)';
      ctx.beginPath();
      for (let d = 0; d < 10; d++) {
        const u = (t * 0.7 + d / 10) % 1;
        const sx = Math.sin(d * 2.4 + 1) * j * 0.62 * u;
        const dy = -j * 1.0 * u + j * 1.3 * u * u;
        const r = 1.6 + (1 - u) * 1.6;
        ctx.moveTo(f.x + sx + r, f.y + dy);
        ctx.arc(f.x + sx, f.y + dy, r, 0, TAU);
      }
      ctx.fill();
      // and the ring the falling water makes on the tier below
      ctx.strokeStyle = `rgba(255,255,255,${0.16 + 0.12 * Math.sin(t * 3 + i)})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.s * (0.34 + 0.06 * ((t * 0.5 + i) % 1)), 0, TAU); ctx.stroke();
      const tw = (Math.sin(t * 2.2 + i) + 1) / 2;
      ctx.fillStyle = `rgba(255,255,255,${0.2 + tw * 0.35})`;
      ctx.beginPath();
      ctx.arc(f.x + Math.cos(t * 0.8) * f.s * 0.8, f.y + f.s * 0.7 + Math.sin(t * 1.3) * f.s * 0.3, 1.6, 0, TAU);
      ctx.fill();
    }

    for (let i = 0; i < (meta.pads || []).length; i++) {
      const pd = meta.pads[i];
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * TAU + TAU / 8;
        const pulse = (Math.sin(t * 2.4 + k * (TAU / 4) + i) + 1) / 2;
        ctx.fillStyle = `rgba(255,220,120,${0.25 + pulse * 0.6})`;
        ctx.beginPath();
        ctx.arc(pd.x + Math.cos(a) * pd.r * 0.93, pd.y + Math.sin(a) * pd.r * 0.93, 2.6 + pulse * 1.4, 0, TAU);
        ctx.fill();
      }
    }

    for (let i = 0; i < (meta.wheels || []).length; i++) {
      const wh = meta.wheels[i];
      const a0 = t * 0.9;
      ctx.save();
      ctx.translate(wh.x, wh.y);
      ctx.strokeStyle = '#5d4a38'; ctx.lineWidth = wh.r * 0.2;
      ctx.beginPath(); ctx.arc(0, 0, wh.r * 0.85, 0, TAU); ctx.stroke();
      ctx.strokeStyle = '#7a5535'; ctx.lineWidth = wh.r * 0.09;
      for (let k = 0; k < 6; k++) {
        const a = a0 + (k / 6) * TAU;
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * wh.r * 0.85, Math.sin(a) * wh.r * 0.85); ctx.stroke();
        // paddle at the rim
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * wh.r * 0.85, Math.sin(a) * wh.r * 0.85);
        ctx.lineTo(Math.cos(a) * wh.r * 1.08, Math.sin(a) * wh.r * 1.08); ctx.stroke();
      }
      ctx.fillStyle = '#e8b93c';
      ctx.beginPath(); ctx.arc(0, 0, wh.r * 0.14, 0, TAU); ctx.fill();
      ctx.restore();
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
      /* A hull up on timber blocks, not a sailboat sitting on grass. Every
         wreck blocker in the game stands on dry land — that is what a no-build
         obstacle is — so it was drawn afloat in a field on five battlefields.
         Propped in a cradle, the same shape reads as a boat out of the water,
         which is exactly what a dockyard looks like. */
      ctx.restore();
      ctx.save();
      ctx.translate(b.x, b.y);
      propShadow(ctx, 0, b.r * 0.5, b.r * 1.1);
      // the cradle it rests in
      ctx.fillStyle = '#5d4a38';
      for (const bx of [-b.r * 0.55, b.r * 0.5]) ctx.fillRect(bx - b.r * 0.1, -b.r * 0.06, b.r * 0.2, b.r * 0.5);
      ctx.rotate(-0.12);
      // hull, keel down, seen from the side the way a cradled boat is
      ctx.fillStyle = '#7d5f42';
      ctx.beginPath();
      ctx.moveTo(-b.r, -b.r * 0.42); ctx.quadraticCurveTo(0, b.r * 0.62, b.r, -b.r * 0.42);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#9a7550';
      ctx.beginPath();
      ctx.moveTo(-b.r, -b.r * 0.42); ctx.quadraticCurveTo(0, b.r * 0.2, b.r, -b.r * 0.42);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#4f3b26'; ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-b.r, -b.r * 0.42); ctx.quadraticCurveTo(0, b.r * 0.62, b.r, -b.r * 0.42);
      ctx.closePath(); ctx.stroke();
      // planking, a red boot stripe, and the ribs showing where she opened up
      ctx.strokeStyle = 'rgba(70,50,30,0.5)'; ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(-b.r * (1 - i * 0.13), -b.r * 0.42 + i * b.r * 0.12);
        ctx.quadraticCurveTo(0, b.r * (0.5 - i * 0.1), b.r * (1 - i * 0.13), -b.r * 0.42 + i * b.r * 0.12);
        ctx.stroke();
      }
      ctx.fillStyle = '#a03830';
      ctx.fillRect(-b.r * 0.94, -b.r * 0.46, b.r * 1.88, b.r * 0.14);
      ctx.fillStyle = '#c9b9a2'; ctx.fillRect(-b.r * 0.9, -b.r * 0.6, b.r * 1.8, b.r * 0.16);
      // the broken mast, snapped off short
      ctx.fillStyle = '#57402b';
      ctx.fillRect(-b.r * 0.06, -b.r * 1.15, b.r * 0.14, b.r * 0.58);
      ctx.fillStyle = '#4a3624';
      ctx.beginPath();
      ctx.moveTo(b.r * 0.08, -b.r * 1.15); ctx.lineTo(b.r * 0.5, -b.r * 1.34); ctx.lineTo(b.r * 0.16, -b.r * 0.98);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      return;
    } else if (b.kind === 'crack') {
      ctx.restore();
      drawPlateGap(ctx, b.x, b.y, b.r, mulberry32(b.x * 31 + b.y * 7));
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

  /* A hole in the baseplate. This was a cracked-ice pool with white fracture
     lines scribbled across it — a snow-game leftover that, on a green brick
     plate, read as a rendering fault rather than a place. Five separate
     battlefields carried one.

     What a missing floor actually looks like in a brick build: the plate
     simply is not there. So this cuts a RECTANGULAR bite snapped to the stud
     grid, shows the dark underside below, gives the surviving plate a lit
     top edge and a shadowed inner wall, and tips a couple of loose plates in.
     Square, because bricks break along their seams, and the squareness is
     what says "assembled" instead of "smudge". */
  function drawPlateGap(c, x, y, r, rnd) {
    const P = 32;                                   // the baseplate stud pitch
    const gw = Math.max(2, Math.round(r * 1.8 / P)) * P;
    const gh = Math.max(2, Math.round(r * 1.5 / P)) * P;
    const x0 = Math.round((x - gw / 2) / P) * P, y0 = Math.round((y - gh / 2) / P) * P;

    c.save();
    // the void under the board
    c.fillStyle = '#10151f';
    c.fillRect(x0, y0, gw, gh);
    // the inner wall of the plate, thicker on the sunward sides
    c.fillStyle = 'rgba(46,56,72,0.95)';
    c.fillRect(x0, y0, gw, 7);
    c.fillRect(x0, y0, 5, gh);
    c.fillStyle = 'rgba(24,30,42,0.9)';
    c.fillRect(x0, y0 + gh - 4, gw, 4);
    c.fillRect(x0 + gw - 3, y0, 3, gh);
    // the lit lip where the surviving plate stops
    c.strokeStyle = 'rgba(255,255,255,0.34)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(x0, y0 + gh); c.lineTo(x0, y0); c.lineTo(x0 + gw, y0); c.stroke();
    c.strokeStyle = 'rgba(12,18,28,0.5)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(x0 + gw, y0); c.lineTo(x0 + gw, y0 + gh); c.lineTo(x0, y0 + gh); c.stroke();

    // a stud or two clinging to the broken edge, and plates fallen in
    c.fillStyle = 'rgba(255,255,255,0.16)';
    for (let gx = x0 + P / 2; gx < x0 + gw; gx += P) {
      if (rnd() > 0.55) continue;
      c.beginPath(); c.arc(gx, y0 + 3, 6, Math.PI, TAU); c.fill();
    }
    const cols = ['#9aa4ae', '#c8443c', '#3f7fd4', '#e8b93c'];
    for (let i = 0; i < 3; i++) {
      const px = x0 + 10 + rnd() * (gw - 20), py = y0 + 10 + rnd() * (gh - 20);
      c.save();
      c.translate(px, py); c.rotate((rnd() - 0.5) * 1.6);
      c.globalAlpha = 0.5 + rnd() * 0.3;
      const bw = 9 + rnd() * 9;
      c.fillStyle = cols[(rnd() * cols.length) | 0];
      c.fillRect(-bw / 2, -3.5, bw, 7);
      c.fillStyle = 'rgba(255,255,255,0.28)';
      c.fillRect(-bw / 2, -3.5, bw, 2.2);
      c.restore();
    }
    c.restore();
  }

  /* One SLICE of a built brick wall.

     The obstacle generator lays a wall as a chain of lumps stepping r*0.8
     apart — close together on purpose, so shots cannot thread between the
     sight circles. This function used to draw a full three-brick-wide block
     at every one of those lumps, so a five-lump wall was five 2r-wide blocks
     stamped 0.8r apart: they buried each other, their courses never lined up
     across the seams, and the result read as a grey smear rather than a wall.
     It was the largest build on some boards.

     So a lump now draws only its own slice — roughly as wide as the step —
     and consecutive lumps tile into one continuous run. The running bond is
     keyed off the slice's own world position rather than a loop index, so
     neighbouring slices alternate their course offset and the brickwork
     carries across the joins. Gameplay is untouched: the blocker radius, and
     therefore what it blocks, is exactly what it was. */
  function drawGlacierWall(c, x, y, r, rnd) {
    c.save();
    propShadow(c, x + r * 0.15, y + r * 0.5, r * 0.72);
    const cols = ['#9aa4ae', '#8b959f', '#a6b0ba'];
    const courses = 4;
    const ch = r * 0.42;
    const bw = r * 0.92;                       // ≈ the generator's r*0.8 step
    // running bond, alternating on the slice's own position in the world
    const band = Math.round(x / (r * 0.8) + y / (r * 0.8));
    for (let i = 0; i < courses; i++) {
      const cy = y + r * 0.5 - i * ch;
      const off = ((i + band) % 2) * bw * 0.5;
      for (let k = -1; k <= 1; k++) {
        const bx = x + k * bw + off - bw * 0.25;
        if (Math.abs(bx - x) > bw * 0.62) continue;   // keep to this slice
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
    // studs along the crest of this slice
    const topY = y + r * 0.5 - courses * ch;
    for (let k = -1; k <= 1; k++) {
      const sx = x + k * bw * 0.34;
      c.fillStyle = 'rgba(200,210,220,0.95)';
      c.beginPath(); c.ellipse(sx, topY - r * 0.06, bw * 0.16, r * 0.07, 0, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(70,80,92,0.8)'; c.lineWidth = 1;
      c.beginPath(); c.ellipse(sx, topY - r * 0.06, bw * 0.16, r * 0.07, 0, 0, TAU); c.stroke();
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
     Redrawn to minifigure proportions after the first pass came out a toddler:
     the old head was 40% of the figure's height, and no amount of stud on top
     of a head that size reads as a brick person. What actually carries the
     look is the head being NARROWER than the torso and the legs being long:

        stud      -0.895 ─ flat top face, drawn as an ellipse (seen from above)
        head      -0.81  ┬ yellow cylinder — straight sides, hw 0.245
                  -0.345 ┴
        torso     -0.295 ┬ trapezoid: hw 0.335 at the flat shoulder line,
                   0.21  ┴   widening to 0.475 at the hips
        hip bar    0.345 ─ a separate lighter piece across the leg tops
        legs       0.915 ┴ two straight columns, no taper, seam at the foot

     That puts head+stud at ~30% of the height, torso ~28%, hips+legs ~40% —
     close to the real thing, with the head a shade large so the face still
     reads at battle size. All in units of r; everything must stay inside the
     sprite box of x ±0.95, y ±0.94 (the stud's ellipse just grazes -0.93).

     Lit from the top-left like the cast shadow: a hard vertical gloss band on
     the left of every piece and a shade band on the right, which is what makes
     it moulded plastic rather than a printed sticker. */
  const STUD_HW = 0.135, STUD_TOP = -0.895, STUD_BOT = -0.80, STUD_RY = 0.032;
  const HEAD_HW = 0.245, HEAD_TOP = -0.81, HEAD_BOT = -0.345, HEAD_CR = 0.055;
  const NECK_HW = 0.105, NECK_TOP = -0.37, NECK_BOT = -0.27;
  const SHO_HW = 0.335, HIP_HW = 0.475, TORSO_TOP = -0.295, TORSO_BOT = 0.21;
  const HIPBAR_HW = 0.455, HIPBAR_BOT = 0.345;
  const LEG_IN = 0.035, LEG_OUT = 0.445, LEG_BOT = 0.915, FOOT_Y = 0.775;
  const SKIN = '#f2c033';           // the one colour every Bro shares
  const SKIN_INK = '#9a7412';

  /* The plastic gloss: clip to the piece, then three straight vertical bands —
     broad sheen left, a bright core inside it, shade right. Bands, not a
     gradient, because moulded plastic catches light in hard streaks. */
  function gloss(ctx, pathFn, cx, w, yTop, yBot) {
    ctx.save(); pathFn(); ctx.clip();
    const h = yBot - yTop;
    ctx.fillStyle = 'rgba(255,255,255,0.20)'; ctx.fillRect(cx - w * 0.42, yTop, w * 0.24, h);
    ctx.fillStyle = 'rgba(255,255,255,0.38)'; ctx.fillRect(cx - w * 0.36, yTop, w * 0.09, h);
    ctx.fillStyle = 'rgba(10,14,30,0.15)'; ctx.fillRect(cx + w * 0.26, yTop, w * 0.24, h);
    ctx.restore();
  }

  /* The still half of a Bro: the gear on its back, the legs, the torso and the
     head. A dozen fills, none of which changes between frames — so in a battle
     it is baked into a sprite (see the cache at the top of the file) and
     blitted. The shop icons still draw it the long way; they are painted once,
     not sixty times a second, and at sizes the battle never asks for. */
  function paintBroBody(ctx, r, look, tierA, tierB, clsColor) {
    const torso = look.tint || '#2f6fb5';
    const legs = look.belly || '#2b3a4a';

    // back-mounted gear, drawn before the body so it sits behind it
    if (look.prop === 'jetpack') {
      ctx.fillStyle = look.propColor || '#e07b39';
      rounded(ctx, -r * 0.74, -r * 0.30, r * 0.30, r * 0.86, r * 0.12);
      rounded(ctx, r * 0.44, -r * 0.30, r * 0.30, r * 0.86, r * 0.12);
      ctx.fillStyle = '#b8b0a4';
      rounded(ctx, -r * 0.74, -r * 0.38, r * 0.30, r * 0.16, r * 0.06);
      rounded(ctx, r * 0.44, -r * 0.38, r * 0.30, r * 0.16, r * 0.06);
    }
    /* The rover's antenna mast. Inboard of the old spot: the mast used to
       lean on a 0.40r-wide head's hat brim, and against the narrow head it
       hung in open air — now it runs down behind the shoulder so the torso
       overlaps its foot. */
    if (look.prop === 'periscope') {
      ctx.fillStyle = '#7d8a96';
      ctx.fillRect(r * 0.31, -r * 1.62, r * 0.13, r * 1.47);
      ctx.fillStyle = '#c9d4dd';
      ctx.beginPath(); ctx.arc(r * 0.375, -r * 1.66, r * 0.15, 0, TAU); ctx.fill();
    }

    /* Everything below is drawn in units of r: the scale carries lineWidth
       with it, so an outline set to 0.05 is 0.05r on screen. The floor keeps
       outlines a device pixel wide on the tiny fort/vendor shop figures. */
    ctx.save();
    ctx.scale(r, r);
    const inkT = shade(torso.startsWith('#') ? torso : '#2f6fb5', -45);
    const inkL = shade(legs.startsWith('#') ? legs : '#2b3a4a', -45);
    const lw = Math.max(0.05, 0.9 / r);

    /* ---- legs: straight columns with a real gap, seam where the foot starts.
       No boots — a contrasting boot band read as galoshes, not moulded legs. */
    for (const side of [-1, 1]) {
      const x0 = Math.min(side * LEG_IN, side * LEG_OUT);
      const x1 = Math.max(side * LEG_IN, side * LEG_OUT);
      const path = () => { ctx.beginPath(); ctx.rect(x0, HIPBAR_BOT, x1 - x0, LEG_BOT - HIPBAR_BOT); };
      path(); ctx.fillStyle = legs; ctx.fill();
      gloss(ctx, path, (x0 + x1) / 2, x1 - x0, HIPBAR_BOT, LEG_BOT);
      ctx.beginPath(); ctx.moveTo(x0 + 0.02, FOOT_Y); ctx.lineTo(x1 - 0.02, FOOT_Y);
      ctx.strokeStyle = inkL; ctx.lineWidth = lw * 0.6;
      /* multiply, not assign: the placement ghost draws this uncached at 0.75
         alpha, and a bare = 1 would turn the rest of the figure opaque */
      ctx.save(); ctx.globalAlpha *= 0.75; ctx.stroke(); ctx.restore();
      path(); ctx.strokeStyle = inkL; ctx.lineWidth = lw; ctx.stroke();
    }

    /* ---- hip bar: its own piece, a step lighter than the legs ---- */
    const hipPath = () => { ctx.beginPath(); ctx.rect(-HIPBAR_HW, TORSO_BOT, HIPBAR_HW * 2, HIPBAR_BOT - TORSO_BOT); };
    hipPath(); ctx.fillStyle = shade(legs.startsWith('#') ? legs : '#2b3a4a', 22); ctx.fill();
    gloss(ctx, hipPath, 0, HIPBAR_HW * 2, TORSO_BOT, HIPBAR_BOT);
    hipPath(); ctx.strokeStyle = inkL; ctx.lineWidth = lw; ctx.stroke();

    // leg top faces peeking from under the hip bar — the 3D hint
    for (const side of [-1, 1]) {
      const x0 = Math.min(side * LEG_IN, side * LEG_OUT);
      const x1 = Math.max(side * LEG_IN, side * LEG_OUT);
      ctx.beginPath();
      ctx.ellipse((x0 + x1) / 2, HIPBAR_BOT, (x1 - x0) / 2 - 0.02, 0.034, 0, 0, TAU);
      ctx.fillStyle = shade(legs.startsWith('#') ? legs : '#2b3a4a', 32); ctx.fill();
      ctx.strokeStyle = inkL; ctx.lineWidth = lw * 0.5; ctx.stroke();
    }

    /* ---- neck, tucked behind the torso's shoulder line ---- */
    ctx.beginPath(); ctx.rect(-NECK_HW, NECK_TOP, NECK_HW * 2, NECK_BOT - NECK_TOP);
    ctx.fillStyle = SKIN; ctx.fill();
    ctx.strokeStyle = SKIN_INK; ctx.lineWidth = lw * 0.7; ctx.stroke();

    /* ---- torso: the trapezoid, flat shoulders, wider at the hips ---- */
    const torsoPath = () => {
      ctx.beginPath();
      ctx.moveTo(-SHO_HW, TORSO_TOP); ctx.lineTo(SHO_HW, TORSO_TOP);
      ctx.lineTo(HIP_HW, TORSO_BOT); ctx.lineTo(-HIP_HW, TORSO_BOT);
      ctx.closePath();
    };
    torsoPath(); ctx.fillStyle = torso; ctx.fill();
    gloss(ctx, torsoPath, 0, SHO_HW + HIP_HW, TORSO_TOP, TORSO_BOT);

    /* ---- the gear path, worn on the chest ----
       Tier 1 is a printed torso stripe in the class colour; tier 2 adds the
       cape (drawn in drawBro, behind everything); tier 3 gilds the stripe. */
    if (tierB >= 1) {
      ctx.save(); torsoPath(); ctx.clip();
      ctx.strokeStyle = clsColor; ctx.lineWidth = 0.17; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-0.335, TORSO_TOP + 0.10); ctx.lineTo(0.30, TORSO_BOT - 0.07); ctx.stroke();
      if (tierB >= 3) {
        ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 0.05;
        ctx.beginPath(); ctx.moveTo(-0.335, TORSO_TOP + 0.10); ctx.lineTo(0.30, TORSO_BOT - 0.07); ctx.stroke();
      }
      ctx.restore();
    }
    torsoPath(); ctx.strokeStyle = inkT; ctx.lineWidth = lw; ctx.lineJoin = 'miter'; ctx.stroke();

    /* ---- head ----
       Always the same yellow, on every Bro in the game. It is the one thing
       that says these are all the same kind of thing, so nothing is allowed to
       recolour it — hats go on top, they do not replace it. A cylinder:
       straight vertical sides, corners barely eased, clearly narrower than
       the torso. */
    const headPath = () => {
      ctx.beginPath();
      ctx.moveTo(-HEAD_HW + HEAD_CR, HEAD_TOP);
      ctx.arcTo(HEAD_HW, HEAD_TOP, HEAD_HW, HEAD_BOT, HEAD_CR);
      ctx.arcTo(HEAD_HW, HEAD_BOT, -HEAD_HW, HEAD_BOT, HEAD_CR);
      ctx.arcTo(-HEAD_HW, HEAD_BOT, -HEAD_HW, HEAD_TOP, HEAD_CR);
      ctx.arcTo(-HEAD_HW, HEAD_TOP, HEAD_HW, HEAD_TOP, HEAD_CR);
      ctx.closePath();
    };
    headPath(); ctx.fillStyle = SKIN; ctx.fill();
    gloss(ctx, headPath, 0, HEAD_HW * 2, HEAD_TOP, HEAD_BOT);
    headPath(); ctx.strokeStyle = SKIN_INK; ctx.lineWidth = lw; ctx.stroke();

    // the stud, with its flat top face drawn as an ellipse seen from above
    ctx.beginPath(); ctx.rect(-STUD_HW, STUD_TOP, STUD_HW * 2, STUD_BOT - STUD_TOP);
    ctx.fillStyle = SKIN; ctx.fill();
    ctx.strokeStyle = SKIN_INK; ctx.lineWidth = lw * 0.8; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(0, STUD_TOP, STUD_HW, STUD_RY, 0, 0, TAU);
    ctx.fillStyle = shade(SKIN, 35); ctx.fill();
    ctx.strokeStyle = SKIN_INK; ctx.lineWidth = lw * 0.5; ctx.stroke();

    ctx.restore();
  }

  /* One arm and its C-clamp hand, swinging from the shoulder. Drawn live
     rather than baked because it is the only part of a Bro that moves.

     A minifigure arm, in front view: shoulder at the torso's top corner,
     elbow bend, wrist, then the open yellow clamp. The sleeve is one stroked
     polyline in the torso colour over a wider ink pass — two strokes, no
     path-building, and the elbow angle is what sells it. The hand centre
     lands at (±0.71, 0.195)r, which is where the held weapons in drawProp
     expect to meet it. */
  function paintArm(ctx, r, side, torso) {
    const ink = shade(torso.startsWith('#') ? torso : '#2f6fb5', -45);
    ctx.save();
    ctx.scale(r * side, r);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const limb = () => {
      ctx.beginPath();
      ctx.moveTo(0.30, -0.22); ctx.lineTo(0.50, -0.02); ctx.lineTo(0.60, 0.10);
    };
    limb(); ctx.strokeStyle = ink; ctx.lineWidth = 0.255; ctx.stroke();
    limb(); ctx.strokeStyle = torso; ctx.lineWidth = 0.155; ctx.stroke();

    // gloss streak along the upper arm
    ctx.beginPath();
    ctx.moveTo(0.31, -0.24); ctx.lineTo(0.47, -0.09);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 0.05; ctx.stroke();

    // hand: wrist stem, then the open clamp with its gap tilted forward
    const hx = 0.71, hy = 0.195;
    const gapC = (270 - side * 18) * Math.PI / 180, half = 46 * Math.PI / 180;
    for (const [col, w] of [[SKIN_INK, 0.104], [SKIN, 0.058]]) {
      ctx.strokeStyle = col; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(0.60, 0.10); ctx.lineTo(hx - (hx - 0.60) * 0.45, hy - (hy - 0.10) * 0.45); ctx.stroke();
      ctx.beginPath(); ctx.arc(hx, hy, 0.085, gapC + half, gapC - half + TAU); ctx.stroke();
    }
    ctx.restore();
  }

  /* The hat, and the gold halo a maxed gear path puts around it. shadowBlur is
     the most expensive thing a 2D context can be asked for, and it was being
     asked for once per capstone Bro per frame; baked, it costs nothing. */
  /* The headgear was laid out around a head twice as wide as the one the
     figure has now. Rather than re-draw nineteen hats to new coordinates, the
     whole set is scaled to 0.68 and dropped so its seat line lands a third of
     the way down the new cylinder — still oversized against a 0.245r-wide
     head, deliberately, because the hat is what says the Bro's job at a
     glance. */
  function paintBroHat(ctx, r, look, tierB) {
    const put = () => {
      ctx.save();
      ctx.translate(0, -r * 0.29);
      ctx.scale(0.68, 0.68);
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
      ctx.moveTo(-r * 0.32, -r * 0.26);
      ctx.quadraticCurveTo(-r * 0.98, r * 0.10 + sway, -r * 0.80, r * 0.80 + sway);
      ctx.quadraticCurveTo(-r * 0.40, r * 0.92, -r * 0.10, r * 0.72);
      ctx.lineTo(r * 0.04, -r * 0.22);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = tierB >= 3 ? '#ffd166' : shade(clsColor, -46);
      ctx.lineWidth = r * (tierB >= 3 ? 0.08 : 0.05);
      ctx.stroke();
    }

    /* The pad box has to clear everything paintBroBody draws: the stud's top
       face at −0.93, the legs at 0.94, the jetpack tanks at ±0.74 and the
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
    ctx.save(); ctx.translate(0, r * swing * 0.25); paintArm(ctx, r, -1, body); ctx.restore();
    ctx.save(); ctx.translate(0, -r * swing * 0.25); paintArm(ctx, r, 1, body); ctx.restore();

    if (look.cheeks) {
      ctx.fillStyle = look.cheeks;
      ctx.beginPath(); ctx.ellipse(-r * 0.16, -r * 0.50, r * 0.05, r * 0.035, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(r * 0.16, -r * 0.50, r * 0.05, r * 0.035, 0, 0, TAU); ctx.fill();
    }

    /* The face is printed on, so it is flat dark-on-yellow — round dot eyes,
       a thin smile, no gloss and no highlights. The eyes still slide a little
       toward the aim, which is the one liberty taken with it: a whole row of
       Bros staring at the same vacuum is worth more than being strict. */
    const lx = aim != null ? Math.cos(aim) * r * 0.032 : 0;
    const ly = aim != null ? Math.sin(aim) * r * 0.022 : 0;
    ctx.fillStyle = '#20242a';
    ctx.beginPath(); ctx.arc(-r * 0.095 + lx, -r * 0.615 + ly, r * 0.047, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(r * 0.095 + lx, -r * 0.615 + ly, r * 0.047, 0, TAU); ctx.fill();
    // a printed smile
    ctx.strokeStyle = '#20242a'; ctx.lineWidth = Math.max(0.8, r * 0.045); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, -r * 0.53, r * 0.105, 0.61, 2.53); ctx.stroke();

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
        /* centred on the halo hat, which paintBroHat now seats at -1.09r */
        ctx.translate(0, -r * 1.09);
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
        ctx.moveTo(-r * 0.24, -r * 0.56);
        ctx.quadraticCurveTo(-r * 1.1, -r * 0.4 + Math.sin(t * 5) * r * 0.12, -r * 1.5, -r * 0.62 + Math.sin(t * 5) * r * 0.2);
        ctx.quadraticCurveTo(-r * 1.05, -r * 0.28, -r * 0.24, -r * 0.40);
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
     (staffs, flags, slings) stay anchored in the hand while their size scales */
  function drawProp(ctx, r, look, aim, t, s) {
    const rb = r / (s || 1);
    const c = look.propColor || '#7d8a96';
    switch (look.prop) {
      case 'sling': {
        const wood = '#8a5a33';
        const wDk  = shade(wood, -38);
        const wLt  = shade(wood, 34);
        const band = '#3a3f46';
        const bDk  = shade(band, -32);
        const hx = 0.54 * rb, hy = 0.148 * rb;
        const jy = hy - 0.24 * rb;
        const gb = hy + 0.20 * rb;
        const lx = hx - 0.185 * r, ly = jy - 0.60 * r;
        const rx = hx + 0.155 * r, ry = jy - 0.64 * r;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const forks = () => {
          ctx.beginPath();
          ctx.moveTo(hx, jy + 0.10 * rb);
          ctx.quadraticCurveTo(hx - 0.17 * r, jy - 0.26 * r, lx, ly);
          ctx.moveTo(hx, jy + 0.10 * rb);
          ctx.quadraticCurveTo(hx + 0.14 * r, jy - 0.30 * r, rx, ry);
        };
        const grip = () => { ctx.beginPath(); ctx.moveTo(hx, gb); ctx.lineTo(hx, jy); };
        ctx.strokeStyle = wDk;
        ctx.lineWidth = 0.215 * r; forks(); ctx.stroke();
        ctx.lineWidth = 0.27 * rb; grip(); ctx.stroke();
        ctx.strokeStyle = wood;
        ctx.lineWidth = 0.135 * r; forks(); ctx.stroke();
        ctx.lineWidth = 0.19 * rb; grip(); ctx.stroke();
        ctx.strokeStyle = wLt; ctx.lineWidth = 0.07 * rb;
        ctx.beginPath();
        ctx.moveTo(hx - 0.05 * rb, gb - 0.02 * rb);
        ctx.lineTo(hx - 0.05 * rb, jy);
        ctx.quadraticCurveTo(hx - 0.16 * r, jy - 0.24 * r, lx - 0.02 * r, ly + 0.16 * r);
        ctx.stroke();
        const ax = lx + 0.025 * r, ay = ly + 0.06 * r;
        const bx = rx - 0.025 * r, by = ry + 0.06 * r;
        const mx = (ax + bx) / 2, myc = (ay + by) / 2 + 0.34 * r;
        const bandPath = () => { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(mx, myc, bx, by); };
        ctx.strokeStyle = bDk; ctx.lineWidth = 0.13 * r; bandPath(); ctx.stroke();
        ctx.strokeStyle = band; ctx.lineWidth = 0.08 * r; bandPath(); ctx.stroke();
        const px = mx, py = (ay + by) / 2 + 0.17 * r;
        ctx.fillStyle = bDk;
        rounded(ctx, px - 0.115 * r, py - 0.085 * r, 0.23 * r, 0.17 * r, 0.07 * r);
        ctx.fillStyle = shade(band, 14);
        rounded(ctx, px - 0.085 * r, py - 0.058 * r, 0.17 * r, 0.116 * r, 0.05 * r);
      }
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
      case 'blades': {
        const base = '#cfd8e0', edge = '#7a8794', dark = shade(base, -12), lit = shade(base, 24);
        const R1 = 0.17 * r, R2 = 0.076 * r;
        const star = () => {
          ctx.beginPath();
          for (let k = 0; k < 4; k++) {
            const q = k * TAU / 4;
            ctx.lineTo(Math.cos(q) * R1, Math.sin(q) * R1);
            ctx.lineTo(Math.cos(q + TAU / 8) * R2, Math.sin(q + TAU / 8) * R2);
          }
          ctx.closePath();
        };
        for (let i = 0; i < 3; i++) {
          const a = t * 2 + i * TAU / 3;
          ctx.save();
          ctx.translate(Math.cos(a) * 1.05 * r, Math.sin(a) * 0.55 * r + 0.1 * r);
          ctx.rotate(a + t * 2);
          star();
          ctx.lineJoin = 'round';
          ctx.strokeStyle = edge; ctx.lineWidth = 0.07 * r; ctx.stroke();
          ctx.fillStyle = base; ctx.fill();
          for (let k = 0; k < 4; k++) {
            const q = k * TAU / 4;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(q) * R1, Math.sin(q) * R1);
            ctx.lineTo(Math.cos(q + TAU / 8) * R2, Math.sin(q + TAU / 8) * R2);
            ctx.closePath();
            ctx.fillStyle = dark; ctx.fill();
          }
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(R1, 0);
          ctx.lineTo(Math.cos(-TAU / 8) * R2, Math.sin(-TAU / 8) * R2);
          ctx.closePath();
          ctx.fillStyle = lit; ctx.fill();
          ctx.beginPath(); ctx.arc(0, 0, 0.045 * r, 0, TAU);
          ctx.fillStyle = '#55606a'; ctx.fill();
          ctx.restore();
        }
      }
        break;
      case 'cannon': case 'howitzer': {
        const big = look.prop === 'howitzer';
        {
          const dk = shade(c, -40);          // outline
          const lt = shade(c, 20);           // raised reinforcing rings
          const hi = shade(c, 55);           // hard top highlight
          const bo = shade(c, -62);          // muzzle bore

          ctx.save();
          /* Pivot at the figure centre, not the hand: the engine spawns the
             shells and the muzzle flash on the aim ray from the tower centre,
             and a hand-pivoted barrel drifts up to a full barrel-width off
             that line at vertical aims. */
          ctx.rotate(aim != null ? aim : -0.5);
          ctx.lineJoin = 'round';
          ctx.strokeStyle = dk;
          ctx.lineWidth = 0.05 * r;

          const bx0 = 0.15 * rb;                          // breech face, just off the shoulder
          const L = (big ? 1.15 : 0.85) * r;              // barrel length grows with upgrades
          const bx1 = bx0 + L;
          const hB = (big ? 0.21 : 0.15) * r;             // half-thickness at breech
          const hM = (big ? 0.15 : 0.11) * r;             // half-thickness at muzzle

          // cascabel knob at the back
          ctx.fillStyle = c;
          ctx.beginPath();
          ctx.arc(bx0 - (big ? 0.29 : 0.235) * rb, 0, (big ? 0.11 : 0.09) * r, 0, TAU);
          ctx.fill(); ctx.stroke();

          // tapered barrel
          ctx.beginPath();
          ctx.moveTo(bx0, -hB); ctx.lineTo(bx1, -hM);
          ctx.lineTo(bx1, hM); ctx.lineTo(bx0, hB);
          ctx.closePath(); ctx.fill(); ctx.stroke();

          // bulbous breech
          ctx.beginPath();
          ctx.arc(bx0 + 0.04 * r, 0, hB + 0.035 * r, 0, TAU);
          ctx.fill(); ctx.stroke();

          // hard light band along the top
          const hx = bx1 - 0.30 * r;
          const hh = hB + (hM - hB) * (hx - bx0) / L;
          ctx.strokeStyle = hi;
          ctx.lineCap = 'round';
          ctx.lineWidth = 0.075 * r;
          ctx.beginPath();
          ctx.moveTo(bx0 + 0.02 * r, -(hB - 0.055 * r));
          ctx.lineTo(hx, -(hh - 0.05 * r));
          ctx.stroke();
          ctx.lineCap = 'butt';
          ctx.strokeStyle = dk;
          ctx.lineWidth = 0.05 * r;

          // flared muzzle lip
          ctx.fillStyle = c;
          rounded(ctx, bx1 - 0.10 * r, -(hM + 0.045 * r), 0.13 * r, 2 * (hM + 0.045 * r), 0.045 * r);
          ctx.stroke();

          // two raised reinforcing rings (mid-barrel and near the muzzle)
          ctx.fillStyle = lt;
          for (const x of [bx0 + 0.42 * L, bx1 - 0.22 * r]) {
            const h = hB + (hM - hB) * (x - bx0) / L + 0.025 * r;
            rounded(ctx, x - 0.04 * r, -h, 0.08 * r, 2 * h, 0.03 * r);
            ctx.stroke();
          }

          // dark bore at the tip
          ctx.fillStyle = bo;
          ctx.beginPath();
          ctx.ellipse(bx1 + 0.01 * r, 0, 0.05 * r, hM * 0.72, 0, 0, TAU);
          ctx.fill();
          ctx.restore();
        }
        break;
      }
      case 'hose': {
        ctx.save();
        {
          ctx.rotate(aim != null ? aim : -0.5);
          const cy = 0.10 * rb; // barrel centreline, rb so it stays at hand height
          ctx.lineJoin = 'round';
          ctx.lineWidth = Math.max(0.045 * r, 1);
          ctx.strokeStyle = shade(c, -32);
          // grip - pinned to the hand via rb
          ctx.fillStyle = shade(c, -22);
          rounded(ctx, 0.42*rb, cy, 0.20*rb, 0.36*rb, 0.085*rb);
          ctx.stroke();
          // tank bump on top (body covers its base)
          ctx.strokeStyle = shade('#67d4f5', -45);
          ctx.fillStyle = '#67d4f5';
          ctx.beginPath(); ctx.arc(0.50*r, cy - 0.13*r, 0.135*r, 0, TAU);
          ctx.fill(); ctx.stroke();
          // body cylinder
          ctx.strokeStyle = shade(c, -32);
          ctx.fillStyle = c;
          rounded(ctx, 0.20*r, cy - 0.14*r, 0.65*r, 0.28*r, 0.10*r);
          ctx.stroke();
          // hard light highlight along the body top
          ctx.fillStyle = shade(c, 52);
          rounded(ctx, 0.26*r, cy - 0.115*r, 0.44*r, 0.075*r, 0.037*r);
          // ridged cone muzzle: three stacked discs, decreasing radius
          ctx.strokeStyle = shade('#c9d4dd', -35);
          const hs = [0.21, 0.17, 0.13];
          for (let i = 0; i < 3; i++) {
            const x = (0.85 + i*0.0667) * r, h = hs[i] * r;
            ctx.fillStyle = i === 1 ? shade('#c9d4dd', -10) : '#c9d4dd';
            rounded(ctx, x, cy - h, 0.075*r, 2*h, 0.03*r);
            ctx.stroke();
          }
          // glowing droplet at the muzzle tip, soft pulse
          const pr = 0.11 * r * (1 + Math.sin(t*4) * 0.15);
          ctx.fillStyle = 'rgba(103,212,245,0.35)';
          ctx.beginPath(); ctx.arc(1.07*r, cy, pr*1.6, 0, TAU); ctx.fill();
          ctx.fillStyle = '#67d4f5';
          ctx.beginPath(); ctx.arc(1.07*r, cy, pr, 0, TAU); ctx.fill();
        }
        ctx.restore();
        break;
      }
      case 'harpoongun': {
        ctx.save();
        {
          const g = 0.55 * rb;
          const brown = '#8a5a33', bDk = shade(brown, -38), bLt = shade(brown, 32);
          const steel = '#8d97a2', sDk = shade(steel, -42), sLt = shade(steel, 22);
          ctx.rotate(aim != null ? aim : -0.5);
          ctx.lineJoin = 'round'; ctx.lineCap = 'round';
          for (const s of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(g + 0.35 * r, s * 0.05 * r);
            ctx.quadraticCurveTo(g + 0.28 * r, s * 0.55 * r, g - 0.10 * r, s * 0.55 * r);
            ctx.strokeStyle = sDk; ctx.lineWidth = 0.14 * r; ctx.stroke();
            ctx.strokeStyle = steel; ctx.lineWidth = 0.09 * r; ctx.stroke();
          }
          ctx.strokeStyle = bDk; ctx.lineWidth = 0.045 * r; ctx.fillStyle = brown;
          rounded(ctx, g - 0.45 * r, -0.12 * r, 0.30 * r, 0.34 * r, 0.06 * r); ctx.stroke();
          rounded(ctx, g - 0.45 * r, -0.085 * r, 1.05 * r, 0.17 * r, 0.05 * r); ctx.stroke();
          rounded(ctx, g + 0.27 * r, -0.13 * r, 0.19 * r, 0.26 * r, 0.05 * r); ctx.stroke();
          rounded(ctx, g - 0.09 * rb, 0.05 * rb, 0.18 * rb, 0.30 * rb, 0.06 * rb); ctx.stroke();
          ctx.fillStyle = bLt;
          rounded(ctx, g - 0.40 * r, -0.075 * r, 0.62 * r, 0.05 * r, 0.025 * r);
          const by = -0.06 * r;
          ctx.strokeStyle = '#e8e0d0'; ctx.lineWidth = 0.045 * r;
          ctx.beginPath();
          ctx.moveTo(g - 0.10 * r, -0.55 * r);
          ctx.quadraticCurveTo(g + 0.13 * r, 0, g - 0.10 * r, 0.55 * r);
          ctx.stroke();
          ctx.fillStyle = sDk;
          for (const s of [-1, 1]) {
            ctx.beginPath(); ctx.arc(g - 0.10 * r, s * 0.55 * r, 0.055 * r, 0, TAU); ctx.fill();
          }
          ctx.strokeStyle = sLt; ctx.lineWidth = 0.06 * r;
          ctx.beginPath(); ctx.moveTo(g - 0.20 * r, by); ctx.lineTo(g + 0.64 * r, by); ctx.stroke();
          ctx.fillStyle = c; ctx.strokeStyle = shade(c, -35); ctx.lineWidth = 0.03 * r;
          ctx.beginPath();
          ctx.moveTo(g - 0.06 * r, by - 0.025 * r); ctx.lineTo(g - 0.20 * r, by - 0.10 * r); ctx.lineTo(g - 0.20 * r, by - 0.025 * r);
          ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(g - 0.06 * r, by + 0.025 * r); ctx.lineTo(g - 0.20 * r, by + 0.10 * r); ctx.lineTo(g - 0.20 * r, by + 0.025 * r);
          ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.fillStyle = steel; ctx.strokeStyle = sDk; ctx.lineWidth = 0.04 * r;
          ctx.beginPath();
          ctx.moveTo(g + 0.62 * r, by - 0.10 * r); ctx.lineTo(g + 0.80 * r, by); ctx.lineTo(g + 0.62 * r, by + 0.10 * r);
          ctx.closePath(); ctx.fill(); ctx.stroke();
        }
        ctx.restore();
        break;
      }
      case 'staff': case 'crookstaff': {
        const crook = look.prop === 'crookstaff';
        {
          const gc = c || '#5ee8a8';
          const hx = 0.54*rb;
          const wood = '#6b4f35', woodDk = shade(wood,-35), woodHi = shade(wood,18);
          const trim = '#8a6a48', trimDk = shade(trim,-35);
          const top = -0.75*r, bot = 0.6*rb, w = 0.065*r;
          // gem position: crook nests it in the curl (out to the right), staff holds it above the tip
          const gx = crook ? hx+0.16*r : hx;
          const gy = crook ? -0.78*r : -0.87*r;
          // glow halo BEHIND the piece so the plastic colors stay flat
          const glow = 0.65 + Math.sin(t*4)*0.25;
          ctx.fillStyle = gc;
          /* multiply into the caller's alpha (the placement ghost draws this
             at 0.75) and restore, never assign back to 1 */
          ctx.save(); ctx.globalAlpha *= glow*0.35;
          ctx.beginPath(); ctx.arc(gx,gy,0.34*r,0,TAU); ctx.fill();
          ctx.restore();
          ctx.save(); ctx.globalAlpha *= glow;
          ctx.beginPath(); ctx.arc(gx,gy,0.16*r,0,TAU); ctx.fill();
          ctx.restore();
          // shaft (fat cylinder, capsule ends) — x pinned at hand via rb
          ctx.fillStyle = wood;
          rounded(ctx, hx-w, top, 2*w, bot-top, w);
          ctx.lineWidth = 0.05*r; ctx.strokeStyle = woodDk; ctx.stroke();
          // hard light stripe down the left of the cylinder
          ctx.fillStyle = woodHi;
          rounded(ctx, hx-0.048*r, top+0.14*r, 0.042*r, (bot-top)-0.32*r, 0.021*r);
          // butt cap
          ctx.fillStyle = trim;
          rounded(ctx, hx-0.09*r, bot-0.1*r, 0.18*r, 0.1*r, 0.035*r);
          ctx.lineWidth = 0.045*r; ctx.strokeStyle = trimDk; ctx.stroke();
          // collar ring near the top
          ctx.fillStyle = trim;
          rounded(ctx, hx-0.1*r, -0.55*r, 0.2*r, 0.1*r, 0.035*r);
          ctx.stroke();
          if (crook) {
            // spiral hook: ~0.8 turn, curling up and out off the shaft tip
            ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.beginPath();
            for (let i=0;i<=34;i++){
              const f = i/34, a = -f*0.8*TAU, rad = (0.17-0.055*f)*r;
              const px = gx-Math.cos(a)*rad, py = gy+Math.sin(a)*rad;
              if (i) ctx.lineTo(px,py); else ctx.moveTo(px,py);
            }
            ctx.strokeStyle = woodDk; ctx.lineWidth = 0.16*r; ctx.stroke();
            ctx.strokeStyle = wood; ctx.lineWidth = 0.11*r; ctx.stroke();
            // gem disc nested in the curl
            ctx.fillStyle = gc;
            ctx.beginPath(); ctx.arc(gx,gy,0.09*r,0,TAU); ctx.fill();
            ctx.lineWidth = 0.045*r; ctx.strokeStyle = shade(gc,-35); ctx.stroke();
            ctx.fillStyle = shade(gc,45);
            ctx.beginPath(); ctx.arc(gx-0.028*r,gy-0.03*r,0.032*r,0,TAU); ctx.fill();
          } else {
            // prong nubs cradling the gem base
            ctx.fillStyle = trim;
            ctx.lineWidth = 0.04*r; ctx.strokeStyle = trimDk;
            for (const s of [-1,1]) {
              ctx.beginPath(); ctx.arc(hx+s*0.068*r,-0.775*r,0.055*r,0,TAU); ctx.fill(); ctx.stroke();
            }
            // gem rhombus
            const gh = 0.12*r, gw = 0.095*r;
            ctx.beginPath();
            ctx.moveTo(gx,gy-gh); ctx.lineTo(gx+gw,gy); ctx.lineTo(gx,gy+gh); ctx.lineTo(gx-gw,gy);
            ctx.closePath();
            ctx.fillStyle = gc; ctx.fill();
            ctx.lineJoin = 'round'; ctx.lineWidth = 0.05*r; ctx.strokeStyle = shade(gc,-35); ctx.stroke();
            // hard facet highlight, upper-left
            ctx.beginPath();
            ctx.moveTo(gx-0.008*r,gy-0.086*r); ctx.lineTo(gx-0.06*r,gy-0.012*r); ctx.lineTo(gx-0.008*r,gy-0.012*r);
            ctx.closePath();
            ctx.fillStyle = shade(gc,40); ctx.fill();
          }
        }
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
      case 'shuriken': {
        const sk = '#cfd8e0', T = 0.36*r, B = 0.15*r, W = 0.105*r;
        ctx.save();
        ctx.translate(0.54*rb, 0.02*rb);
        ctx.rotate(t*3);
        ctx.lineJoin = 'round';
        const star = () => {
          ctx.beginPath();
          for (let i = 0; i < 4; i++) {
            const a = i*TAU/4, ca = Math.cos(a), sa = Math.sin(a);
            ctx.lineTo(B*ca + W*sa, B*sa - W*ca);
            ctx.lineTo(T*ca, T*sa);
            ctx.lineTo(B*ca - W*sa, B*sa + W*ca);
            ctx.lineTo(B*(ca - sa), B*(sa + ca));
          }
          ctx.closePath();
        };
        star();
        ctx.fillStyle = sk; ctx.fill();
        ctx.fillStyle = shade(sk, -12);
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const a = i*TAU/4, ca = Math.cos(a), sa = Math.sin(a);
          ctx.moveTo(T*ca, T*sa);
          ctx.lineTo(B*ca - W*sa, B*sa + W*ca);
          ctx.lineTo(B*ca, B*sa);
        }
        ctx.fill();
        star();
        ctx.strokeStyle = '#7a8794'; ctx.lineWidth = 0.04*r; ctx.stroke();
        ctx.fillStyle = shade(sk, 8);
        rounded(ctx, -0.115*r, -0.115*r, 0.23*r, 0.23*r, 0.035*r);
        ctx.lineWidth = 0.028*r; ctx.stroke();
        ctx.fillStyle = shade(sk, 24);
        rounded(ctx, -0.088*r, -0.092*r, 0.105*r, 0.052*r, 0.026*r);
        ctx.fillStyle = '#55606a';
        ctx.beginPath(); ctx.arc(0, 0, 0.07*r, 0, TAU); ctx.fill();
        ctx.restore();
      }
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
      case 'pickaxe': {
        const hc = '#8a5a33', sc = '#8d97a2';
        ctx.save();
        ctx.translate(0.54*rb, 0.02*rb);
        ctx.rotate(0.6 + Math.sin(t*3)*0.1);
        ctx.lineJoin = 'round';
        ctx.lineWidth = 0.05*r;
        ctx.strokeStyle = shade(hc, -40);
        ctx.fillStyle = hc;
        rounded(ctx, -0.055*r, -0.58*r, 0.11*r, 0.95*r, 0.05*r);
        ctx.stroke();
        ctx.fillStyle = shade(hc, 26);
        rounded(ctx, -0.037*r, -0.50*r, 0.034*r, 0.78*r, 0.017*r);
        ctx.fillStyle = sc;
        ctx.strokeStyle = shade(sc, -40);
        ctx.beginPath();
        ctx.moveTo(-0.43*r, -0.27*r);
        ctx.quadraticCurveTo(-0.26*r, -0.585*r, 0, -0.60*r);
        ctx.quadraticCurveTo(0.26*r, -0.585*r, 0.43*r, -0.27*r);
        ctx.quadraticCurveTo(0.24*r, -0.472*r, 0, -0.44*r);
        ctx.quadraticCurveTo(-0.24*r, -0.472*r, -0.43*r, -0.27*r);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = shade(sc, 34);
        ctx.lineWidth = 0.05*r;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-0.315*r, -0.40*r);
        ctx.quadraticCurveTo(-0.19*r, -0.535*r, 0, -0.545*r);
        ctx.quadraticCurveTo(0.19*r, -0.535*r, 0.315*r, -0.40*r);
        ctx.stroke();
        ctx.fillStyle = sc;
        ctx.strokeStyle = shade(sc, -40);
        rounded(ctx, -0.08*r, -0.585*r, 0.16*r, 0.175*r, 0.05*r);
        ctx.stroke();
        ctx.fillStyle = shade(sc, 34);
        rounded(ctx, -0.048*r, -0.552*r, 0.052*r, 0.048*r, 0.02*r);
        ctx.restore();
      }
        break;
      case 'flag': {
        const px = rb * 0.56;
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
     Drawn as bold icons: one silhouette, a heavy dark outline, flat colour, and
     the fewest marks inside it that still tell one machine from another.

     Four earlier attempts went the other way — gradients, moulded plastic,
     panel lines, a lit lamp for a face — and every one of them lost the plot at
     the size the game actually draws these things. A vacuum on this board is
     about forty pixels of a screen that also holds a hundred bricks, twenty
     Bros and a studded plate. Detail at that size is mud. An outline is not.

     So: no gradients anywhere, one flat fill per part, and a black bar for the
     intake — which is the only interior mark every machine gets, because it is
     the mouth and the mouth is the mechanic.

     The shape is a side view and the machines never rotate, only mirror, for
     the reason the Bros never rotate: a profile is what makes a vacuum a
     vacuum, and turning one to follow a vertical stretch of track lays it on
     its side. Two archetypes cover all seventeen species:

       UPRIGHT   flat foot on the floor, body leaning back, handle behind
       CANISTER  tub on the floor, hose arcing forward to a wand

     Layout, in radii, nose-right, floor at y = +0.80. */
  const GY = 0.80;
  const OUTLINE = '#161a20';

  const VAC_FORM = {
    pup:         { form: 'hand' },
    juvenile:    { form: 'stick' },
    adult:       { form: 'upright' },
    speedster:   { form: 'robo' },
    bull:        { form: 'upright', bulk: 1.15, vents: true },
    stealth:     { form: 'upright', quiet: true },
    armored:     { form: 'can',     plated: true },
    regen:       { form: 'can',     cyclone: true },
    brute:       { form: 'drum' },
    beachmaster: { form: 'drum',    tank: true },
    colossus:    { form: 'drum',    pad: true },
    emperor:     { form: 'can',     stack: true },
    leviathan:   { form: 'drum',    pipes: true },
    /* The deep-endless machines are shop canisters — same family, same painter,
       so there is one drawing to keep right rather than two that drift. */
    heavy_young: { form: 'drum',    bulk: 1.00, plated: true },
    heavy_bull:  { form: 'drum',    bulk: 1.08, vents: true },
    heavy_great: { form: 'drum',    bulk: 1.16, stack: true },
    heavy_king:  { form: 'drum',    bulk: 1.26, pipes: true, stack: true },
  };

  function vacGeom(spec) {
    const f = (spec && spec.form) || 'upright';
    const b = (spec && spec.bulk) || 1;
    if (f === 'hand')  return { f, b, headX0: 0.30, headX1: 1.00, topX: 0.22, botX: 0.62, halfT: 0.24, halfB: 0.28, top: -0.10 };
    if (f === 'stick') return { f, b, headX0: 0.20, headX1: 1.14, topX: 0.20, botX: 0.60, halfT: 0.20, halfB: 0.28, top: -0.68 };
    if (f === 'can')   return { f, b, tubW: 0.62 * b, tubH: 0.50 * b };
    if (f === 'drum')  return { f, b, tubW: 0.74 * b, tubH: 0.66 * b };
    if (f === 'robo')  return { f, b };
    return { f, b, headX0: 0.20, headX1: 1.26, topX: 0.20, botX: 0.66, halfT: 0.30 * b, halfB: 0.42 * b, top: -0.58 };
  }

  /* The body shell — the one shape the fill, the clip and the outline share, so
     they can never drift apart. */
  function vacBody(ctx, r, spec) {
    const g = vacGeom(spec);
    if (g.f === 'robo') {
      ctx.beginPath();
      ctx.ellipse(r * 0.10, r * (GY - 0.22), r * 0.94, r * 0.24, 0, 0, TAU);
      return;
    }
    if (g.f === 'can' || g.f === 'drum') {
      ctx.beginPath();
      ctx.ellipse(-r * 0.10, r * (GY - g.tubH * 0.5 - 0.06), r * g.tubW, r * g.tubH * 0.5, 0, 0, TAU);
      return;
    }
    /* upright: the foot and the leaning body as ONE closed path. Drawing them
       as a single outline rather than two overlapping boxes is most of what
       makes this treatment read — the machine is one object with one edge. */
    const bot = GY - 0.26;
    ctx.beginPath();
    ctx.moveTo(r * g.headX0, r * GY);
    ctx.lineTo(r * g.headX1, r * GY);
    ctx.lineTo(r * g.headX1, r * (GY - 0.30));
    ctx.lineTo(r * (g.botX + g.halfB), r * (GY - 0.30));
    ctx.lineTo(r * (g.topX + g.halfT), r * g.top);
    ctx.lineTo(r * (g.topX - g.halfT), r * g.top);
    ctx.lineTo(r * (g.botX - g.halfB), r * (GY - 0.30));
    ctx.lineTo(r * g.headX0, r * (GY - 0.30));
    ctx.closePath();
  }

  /* Nothing rotates any more, so this only answers "which way round". Keyed on
     the segment's angle rather than the wobbled one: the wobble is ±0.07 either
     side, so on a vertical leg an angle-with-wobble crosses zero eight times a
     second and the machine would strobe. */
  function facesLeft(ang) { return Math.cos(ang) < 0; }

  /* The still half of a vacuum — which is nearly all of it, and deliberately:
     these are machines rolling down a track, not animals, so there is no gait.
     Painted once per (type, size, stealth, wear) into a sprite. */
  function paintVac(ctx, type, r, hidden, variant) {
    const def = G.ENEMIES[type];
    const col = def.color;
    const boss = !!def.boss;
    const spec = VAC_FORM[type] || { form: 'upright' };
    const g = vacGeom(spec);
    const f = g.f;
    const LW = Math.max(2, r * 0.115);        // the outline, and it is heavy
    ctx.globalAlpha = hidden ? 0.45 : 1;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';

    // Robo-Vac: afterimages, because it is twice as fast as anything else and
    // that has to be legible before it arrives
    if (f === 'robo') {
      for (let gi = 2; gi >= 1; gi--) {
        ctx.save();
        ctx.translate(-r * 0.5 * gi, 0);
        ctx.globalAlpha = (hidden ? 0.45 : 1) * (gi === 1 ? 0.18 : 0.08);
        ctx.fillStyle = col;
        vacBody(ctx, r, spec); ctx.fill();
        ctx.restore();
      }
    }

    /* ---- UPRIGHT: handle first, so the body's outline closes over its root ---- */
    if (f === 'upright' || f === 'stick' || f === 'hand') {
      if (f === 'hand') {
        ctx.strokeStyle = OUTLINE; ctx.lineWidth = LW * 1.7;
        ctx.beginPath(); ctx.moveTo(r * 0.34, r * 0.06); ctx.lineTo(r * 0.02, r * 0.40); ctx.stroke();
      } else {
        const hx = g.topX - 0.26, hy = g.top - 0.58;
        ctx.strokeStyle = OUTLINE; ctx.lineWidth = LW * 1.15;
        ctx.beginPath(); ctx.moveTo(r * g.topX, r * g.top); ctx.lineTo(r * hx, r * hy); ctx.stroke();
        ctx.lineWidth = LW * 1.55;                                  // the grip
        ctx.beginPath();
        ctx.moveTo(r * (hx - 0.20), r * (hy - 0.08)); ctx.lineTo(r * (hx + 0.20), r * (hy + 0.10));
        ctx.stroke();
      }

      ctx.fillStyle = col; ctx.strokeStyle = OUTLINE; ctx.lineWidth = LW;
      vacBody(ctx, r, spec); ctx.fill(); ctx.stroke();

      // the intake: the one mark every machine carries, because it is the mouth
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(r * (g.headX0 + 0.08), r * (GY - 0.15), r * (g.headX1 - g.headX0 - 0.16), r * 0.15);
      // the wheel, as a solid disc rather than a rendered one
      ctx.beginPath(); ctx.arc(r * (g.headX0 + 0.14), r * (GY - 0.15), r * 0.15, 0, TAU); ctx.fill();
    }

    /* ---- CANISTER: tub, hose, wand. The hose is the identifying line. ---- */
    if (f === 'can' || f === 'drum') {
      const tubY = GY - g.tubH * 0.5 - 0.06;

      // hose: one heavy arc from the tub forward to the wand
      ctx.strokeStyle = OUTLINE; ctx.lineWidth = LW * 1.5;
      ctx.beginPath();
      ctx.moveTo(-r * 0.10, r * (tubY - g.tubH * 0.5));
      ctx.quadraticCurveTo(r * 0.55, r * (tubY - g.tubH * 0.5 - 1.05), r * 1.12, r * (GY - 0.52));
      ctx.stroke();
      ctx.strokeStyle = shade(col, 24); ctx.lineWidth = LW * 0.8;
      ctx.beginPath();
      ctx.moveTo(-r * 0.10, r * (tubY - g.tubH * 0.5));
      ctx.quadraticCurveTo(r * 0.55, r * (tubY - g.tubH * 0.5 - 1.05), r * 1.12, r * (GY - 0.52));
      ctx.stroke();

      // wand and its floor nozzle
      ctx.fillStyle = col; ctx.strokeStyle = OUTLINE; ctx.lineWidth = LW;
      ctx.beginPath();
      ctx.moveTo(r * 0.86, r * GY); ctx.lineTo(r * 1.34, r * GY);
      ctx.lineTo(r * 1.34, r * (GY - 0.24)); ctx.lineTo(r * 1.06, r * (GY - 0.24));
      ctx.lineTo(r * 1.18, r * (GY - 0.56)); ctx.lineTo(r * 1.06, r * (GY - 0.56));
      ctx.lineTo(r * 0.92, r * (GY - 0.24)); ctx.lineTo(r * 0.86, r * (GY - 0.24));
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(r * 0.92, r * (GY - 0.14), r * 0.36, r * 0.14);

      // the tub
      ctx.fillStyle = col; ctx.strokeStyle = OUTLINE; ctx.lineWidth = LW;
      vacBody(ctx, r, spec); ctx.fill(); ctx.stroke();
      // casters, solid
      ctx.fillStyle = OUTLINE;
      for (const wx of [-0.58, 0.30]) {
        ctx.beginPath(); ctx.arc(r * wx, r * (GY - 0.10), r * 0.14, 0, TAU); ctx.fill();
      }
    }

    if (f === 'robo') {
      ctx.fillStyle = col; ctx.strokeStyle = OUTLINE; ctx.lineWidth = LW;
      vacBody(ctx, r, spec); ctx.fill(); ctx.stroke();
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(r * 0.30, r * (GY - 0.14), r * 0.62, r * 0.14);      // intake
      ctx.beginPath(); ctx.arc(r * 0.86, r * (GY - 0.22), r * 0.14, 0, TAU); ctx.fill();  // bumper
    }

    /* ---- one flat mark per species, and only one ---- */
    const bodyCx = (f === 'can' || f === 'drum') ? -r * 0.10 : r * (g.topX ? (g.topX + g.botX) / 2 : 0);
    const bodyCy = (f === 'can' || f === 'drum')
      ? r * (GY - g.tubH * 0.5 - 0.06)
      : r * ((g.top + GY - 0.30) / 2);

    if (spec.vents) {                          // cooling slots
      ctx.fillStyle = OUTLINE;
      for (let i = -1; i <= 1; i++) {
        ctx.fillRect(bodyCx + i * r * 0.20 - r * 0.035, bodyCy - r * 0.18, r * 0.07, r * 0.36);
      }
    }
    if (spec.quiet) {                          // foam wrap
      ctx.fillStyle = '#d8e2ec';
      ctx.fillRect(bodyCx - r * 0.34, bodyCy - r * 0.10, r * 0.68, r * 0.20);
      ctx.strokeStyle = OUTLINE; ctx.lineWidth = LW * 0.6;
      ctx.strokeRect(bodyCx - r * 0.34, bodyCy - r * 0.10, r * 0.68, r * 0.20);
    }
    if (spec.plated) {                         // steel band with rivets
      ctx.fillStyle = '#b4bec8';
      ctx.fillRect(bodyCx - r * 0.52, bodyCy - r * 0.11, r * 1.04, r * 0.22);
      ctx.strokeStyle = OUTLINE; ctx.lineWidth = LW * 0.6;
      ctx.strokeRect(bodyCx - r * 0.52, bodyCy - r * 0.11, r * 1.04, r * 0.22);
      ctx.fillStyle = OUTLINE;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath(); ctx.arc(bodyCx + i * r * 0.30, bodyCy, r * 0.045, 0, TAU); ctx.fill();
      }
    }
    if (spec.cyclone) {                        // the bin that empties itself
      ctx.strokeStyle = '#6fe89a'; ctx.lineWidth = LW * 0.7;
      ctx.beginPath();
      for (let i = 0; i <= 20; i++) {
        const a = i * 0.44, rad = r * 0.03 + i * r * 0.011;
        const px = bodyCx + Math.cos(a) * rad, py = bodyCy + Math.sin(a) * rad * 0.7;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();
    }
    if (spec.tank) {                           // solution tank
      ctx.fillStyle = '#9fe0ee';
      ctx.fillRect(bodyCx - r * 0.14, bodyCy - r * 0.24, r * 0.44, r * 0.48);
      ctx.strokeStyle = OUTLINE; ctx.lineWidth = LW * 0.6;
      ctx.strokeRect(bodyCx - r * 0.14, bodyCy - r * 0.24, r * 0.44, r * 0.48);
    }
    if (spec.pad) {                            // the buffing pad, under the nose
      ctx.fillStyle = '#dde3e9'; ctx.strokeStyle = OUTLINE; ctx.lineWidth = LW * 0.7;
      ctx.beginPath(); ctx.ellipse(r * 1.10, r * (GY - 0.06), r * 0.34, r * 0.11, 0, 0, TAU);
      ctx.fill(); ctx.stroke();
    }
    if (spec.stack) {                          // exhaust stacks
      ctx.fillStyle = OUTLINE;
      for (const sx of [-0.44, -0.18]) {
        ctx.fillRect(r * sx, bodyCy - r * (g.tubH ? g.tubH * 0.5 : 0.5) - r * 0.42, r * 0.13, r * 0.46);
      }
    }
    if (spec.pipes) {                          // plumbed into the wall
      ctx.strokeStyle = OUTLINE; ctx.lineWidth = LW * 1.3;
      ctx.beginPath();
      ctx.moveTo(bodyCx - r * 0.40, bodyCy);
      ctx.quadraticCurveTo(-r * 1.30, bodyCy - r * 0.50, -r * 1.78, r * (GY - 0.34));
      ctx.stroke();
    }

    /* Bosses and heavies wear yellow-and-black hazard tape along the floor,
       because "this one is different" has to be one signal the player learns
       once, not four they learn separately. */
    if (boss) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(-r * 1.0, r * (GY - 0.30), r * 2.4, r * 0.30);
      ctx.clip();
      for (let i = -5; i <= 9; i++) {
        ctx.fillStyle = i % 2 ? OUTLINE : '#f2c14e';
        ctx.beginPath();
        ctx.moveTo(r * (-0.90 + i * 0.20), r * (GY - 0.30));
        ctx.lineTo(r * (-0.80 + i * 0.20), r * (GY - 0.30));
        ctx.lineTo(r * (-0.92 + i * 0.20), r * GY);
        ctx.lineTo(r * (-1.02 + i * 0.20), r * GY);
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
    /* Just the bristles, tracking across the intake. The dark cylinder this
       used to draw underneath them is now the intake bar itself — the one
       interior mark every machine already carries — so drawing it again only
       muddied the one solid black shape the icon treatment depends on. */
    ctx.save();
    const bw = r * 0.30;
    ctx.strokeStyle = '#c9b98a'; ctx.lineWidth = Math.max(1, r * 0.05);
    for (let i = 0; i < 3; i++) {
      const ph = (spin + i / 3) % 1;
      const x = -bw + ph * bw * 2;
      ctx.globalAlpha = (hidden ? 0.45 : 1) * (0.30 + Math.sin(ph * Math.PI) * 0.5);
      ctx.beginPath(); ctx.moveTo(x, -r * 0.055); ctx.lineTo(x, r * 0.055); ctx.stroke();
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

    /* NOT ROTATED. The pack used to turn to follow the track, which is what
       you do with a drawing seen from above — and it is why three attempts at
       these machines kept failing, because it forced a plan view and a vacuum
       seen from directly above is a rectangle.

       The Bros solved this long ago by never rotating at all: they stand
       upright wherever they are and only their weapon points anywhere. The
       machines do the same now. They stand on the board in profile, they mirror
       to face the way they are travelling, and on a vertical stretch of track
       they stay the right way up instead of lying on their side.

       The shadow keeps a small bob so the pack does not look pasted on. */
    ctx.save();
    ctx.translate(p.x, p.y);
    if (hidden) ctx.globalAlpha = 0.45;
    const bob = Math.sin(t * 7 + e.wob) * r * 0.02;

    ctx.fillStyle = 'rgba(25,42,62,0.10)';
    ctx.beginPath(); ctx.ellipse(r * 0.18, r * 0.86, r * 1.05, r * 0.22, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(25,42,62,0.20)';
    ctx.beginPath(); ctx.ellipse(r * 0.10, r * 0.84, r * 0.82, r * 0.16, 0, 0, TAU); ctx.fill();

    // face the way it is going — a mirror, never a rotation. See facesLeft.
    if (facesLeft(p.ang)) ctx.scale(-1, 1);
    ctx.translate(0, bob);

    // heavies get their own body entirely, then fall through to the shared
    // status pips and health bar below
    if (e.heavy) {
      drawHeavyBody(ctx, e, r, col, t);
      ctx.restore();
      drawEnemyStatus(ctx, game, e, def, r, p, t);
      return;
    }

    // the power cord, trailing along the floor behind the machine
    ctx.save();
    ctx.translate(-r * 0.75, r * (GY - 0.10));
    blitSprite(ctx, sprite('cord|' + e.type + '|' + Math.round(r), [r * 1.5, r * 0.2, r * 0.35, r * 0.35],
      (c) => paintVacCord(c, r, col)));
    ctx.restore();

    /* The machine itself, in one blit. Three wear patterns per species is all
       the variety ninety individually-seeded vacuums ever showed.

       PAD BOX, measured against the furthest thing any form actually draws
       rather than against the body — under-measuring it crops the sprite with
       no error at all, and a machine missing a slice reads as a different one:

         back    Central Unit's wall pipe −1.85r
         front   the canister wand +1.35r
         top     the Extractor's exhaust stacks, and the handle grip, −1.60r
         floor   GY at +0.80r, plus the cord

       `r` IS IN THE KEY. It is constant per species today, so this adds no
       sheets — but the cache returns whatever was baked first for a key and
       ignores the size it is asked for, so the day anything scales a vacuum
       every machine of that species would silently wear the first size drawn. */
    const variant = ((e.wob * 1000) | 0) % 3;
    const key = 'vac|' + e.type + '|' + Math.round(r) + '|' + (hidden ? 'h' : '') + variant;
    ctx.globalAlpha = 1;
    blitSprite(ctx, sprite(key, [r * 2.05, r * 1.65, r * 1.70, r * 1.05],
      (c) => paintVac(c, e.type, r, hidden, variant)));

    /* The brush roll, turning under the mouth of the floor head. In profile it
       is edge-on, so it lies along the machine. It turns with DISTANCE
       TRAVELLED rather than with the clock, so a clogged vacuum visibly slows
       instead of spinning merrily on the spot while stuck. */
    if (e.type !== 'speedster') {
      ctx.save();
      ctx.translate(r * 0.72, r * (GY - 0.075));
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

  /* The dust cloud a heavy drags along behind it. */
  function paintHeavyWake(ctx, r) {
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = 'rgba(198,206,214,0.55)';
    ctx.beginPath();
    ctx.ellipse(-r * 1.5, r * (GY - 0.30), r * 0.72, r * 0.34, 0, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.24;
    ctx.beginPath();
    ctx.ellipse(-r * 2.15, r * (GY - 0.24), r * 0.5, r * 0.22, 0, 0, TAU);
    ctx.fill();
  }

  /* The heavies used to be drawn from above — a steel drum on casters — while
     the rest of the pack was in profile. That split was there when the small
     machines were plan views too, and once they went back to profile it left
     the deep-endless machines as the only thing on the board still drawn from
     a different angle. They are the same family now: a big shop canister with
     a hose, in profile, at the same scale as everything else.

     They are entries in VAC_FORM like every other species, so there is one
     painter for the whole pack rather than two that can drift apart. All that
     is left here is the wake and the pulsing intake — the intake being the
     whole mechanic, because this is the thing that swallows the pack. */
  function drawHeavyBody(ctx, e, r, col, t) {
    blitSprite(ctx, sprite('heavywake|' + e.type + '|' + Math.round(r), [r * 2.75, r * 0.1, r * 0.2, r * 1.2],
      (c) => paintHeavyWake(c, r)));

    ctx.save();
    ctx.translate(-r * 0.75, r * (GY - 0.10));
    blitSprite(ctx, sprite('cord|' + e.type + '|' + Math.round(r), [r * 1.5, r * 0.2, r * 0.35, r * 0.35],
      (c) => paintVacCord(c, r, col)));
    ctx.restore();

    const variant = ((e.wob * 1000) | 0) % 3;
    blitSprite(ctx, sprite('vac|' + e.type + '|' + Math.round(r) + '|' + variant,
      [r * 2.05, r * 1.55, r * 1.75, r * 1.05],
      (c) => paintVac(c, e.type, r, false, variant)));

    // the throat, pulsing at the mouth of the wand
    const suck = 0.5 + Math.sin(t * 5 + e.wob) * 0.5;
    ctx.save();
    ctx.globalAlpha = 0.25 + suck * 0.35;
    ctx.fillStyle = 'rgba(150,205,240,0.9)';
    ctx.beginPath();
    ctx.ellipse(r * (1.24 - suck * 0.10), r * (GY - 0.05), r * (0.10 + suck * 0.10), r * 0.06, 0, 0, TAU);
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
    const sx = canvas.width / G.W, sy = canvas.height / G.H;
    const dot = (wx, wy, col) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(Math.max(5, Math.min(canvas.width - 5, wx * sx)),
        Math.max(5, Math.min(canvas.height - 5, wy * sy)), 3.5, 0, TAU);
      ctx.fill();
    };
    /* A dot per ENTRANCE, not one for the board. Two- and three-gate
       battlefields were advertising a single way in on the level-select
       screen, which is the one screen where a player picks a board by
       reading its shape. */
    for (const pl of level.paths) dot(pl[0].x, pl[0].y, '#d9534f');
    const p0 = level.paths[0];
    const pe = p0[p0.length - 1];
    dot(pe.x, pe.y, '#5fc26e');
    G.W = keepW; G.H = keepH;
  };
})();
