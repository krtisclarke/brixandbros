/* Brix and Bros — DOM UI: RTS-style command dock, hotkeys, menus, persistence, sound */
(function () {
  const G = (globalThis.G = globalThis.G || {});
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  /* Write markup into an element ONLY when it actually differs from what is
     already there.

     updateHud() is a blunt redraw-everything-from-state pass running about
     eight times a second, which is why every number in the HUD stays live with
     no bookkeeping. That is fine for text, and quietly fatal for markup: an
     element rebuilt between a finger going down and coming up is no longer in
     the document when the browser looks for the common ancestor of the two, so
     NO CLICK IS FIRED AT ALL. That is why tapping the speaker glyph never
     muted, and why the `space` chip inside Send Wave never sent a wave — the
     button was replaced underneath the press. Hitting the padding worked
     because there the target is the button itself, which is never rebuilt.

     A string compare is the whole fix and it keeps the blunt-redraw design:
     nothing has to know when state changed, only whether the output did. */
  const setHTML = (node, html) => {
    if (!node || node._html === html) return;
    node._html = html;
    node.innerHTML = html;
  };
  // in-match currency is studs 🔩 (recruiting); bricks 🧱 are the meta-currency
  const fmt = (n) => '🔩' + Math.round(n).toLocaleString();
  const num = (n) => Math.round(n).toLocaleString();   // a count, not a stud price
  /* Compact form for the selection card's stat line, which is one line by
     decree and has no room to grow. Deep endless drives hero damage into five
     and six figures and a long run's kill count with it — spelled out, those
     pushed the line past the card and the tail was silently ellipsed away.
     "36.2k" is both shorter and easier to read at a glance than "36,191". */
  const short = (n) => {
    n = Math.round(n);
    if (Math.abs(n) < 10000) return n.toLocaleString();
    if (Math.abs(n) < 1e6) return (n / 1000).toFixed(n < 1e5 ? 1 : 0).replace(/\.0$/, '') + 'k';
    return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  };

  /* Hotkey rows mirror the physical keyboard; each row is one class. */
  const HOTKEY_ROWS = [
    ['1', '2', '3', '4', '5'],
    ['Q', 'W', 'E', 'R', 'T'],
    ['A', 'S', 'D', 'F', 'G'],
    ['Z', 'X', 'C', 'V', 'B'],
  ];
  const KEY_TO_TOWER = {};
  HOTKEY_ROWS.forEach((row, r) => row.forEach((k, c) => { KEY_TO_TOWER[k] = G.TOWER_ORDER[r * 5 + c]; }));
  const TOWER_KEY = {};
  Object.entries(KEY_TO_TOWER).forEach(([k, id]) => { TOWER_KEY[id] = k; });

  const ICON_SOUND_ON = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1c2.9.9 5 3.5 5 6.7s-2.1 5.8-5 6.7v2.1c4-.9 7-4.5 7-8.8s-3-7.9-7-8.8z"/></svg>';
  const ICON_SOUND_OFF = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm18.6 3 2-2-1.4-1.4-2 2-2-2L16.7 10l2 2-2 2 1.4 1.4 2-2 2 2 1.4-1.4-2-2z"/></svg>';
  /* Drawn rather than typed: the ⓘ character renders as a different shape on
     every platform and as a colour emoji on some. */
  const ICON_INFO = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">' +
    '<circle cx="12" cy="12" r="9.1" fill="none" stroke="currentColor" stroke-width="1.9"/>' +
    '<circle cx="12" cy="7.4" r="1.4" fill="currentColor"/>' +
    '<path d="M12 10.7v6.4" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg>';

  /* ---------- persistence ---------- */
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
      catch (e) { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); return true; }
      catch (e) { return false; }
    },
    del(key) { try { localStorage.removeItem(key); } catch (e) {} },
  };
  /* Both games are hosted on the same github.io origin, and localStorage is
     scoped to the ORIGIN, not to the path. Share a key and one game silently
     overwrites the other's profile. Hence the prefix. */
  const PROFILE_KEY = 'brix_profile_v1';
  const saveKey = (li) => 'brix_save_v1_' + li;

  function getProfile() {
    const p = store.get(PROFILE_KEY, {});
    // backfill every key a profile written by an older build might be missing
    if (!(p.unlocked > 0)) p.unlocked = 1;
    if (p.bricks == null) p.bricks = 0;
    if (!p.completed) p.completed = {};
    if (!p.bestWave) p.bestWave = {};
    if (!p.endlessBest) p.endlessBest = {};   // per-level record wave in Endless Shift
    if (!p.diffDone) p.diffDone = {};
    if (!p.powerInv) p.powerInv = {};
    if (!p.heroes) p.heroes = { hero_frost: true };  // the Captain serves for free
    // audio levels, 0..1. Music sits under the effects by default: it is a bed,
    // and the effects are the ones carrying information.
    if (p.musicVol == null) p.musicVol = 0.7;
    if (p.sfxVol == null) p.sfxVol = 1;
    if (p.heroSel === undefined) p.heroSel = 'hero_frost'; // null = fight heroless
    if (!p.workshop) p.workshop = {};                    // permanent Workshop Upgrades tiers
    /* Builder rank. Profiles from the battlefields-defended era are seeded with
       the XP for the rank their wins had already earned (that drip gave five
       starters + two per battlefield), so nobody loses a Bro they had. */
    if (p.xp == null) {
      const grandfathered = Math.min(G.MAX_RANK, 1 + G.defendedCount(p) * 2);
      p.xp = G.xpForRank(grandfathered);
    }
    G.applyWorkshop(p.workshop);                         // perks live in G.PERK from here on
    // legacy profiles: a completed level was a 50-wave campaign → credit it as Hard
    for (const id in p.completed) {
      if (p.completed[id] && !p.diffDone[id]) p.diffDone[id] = { hard: true };
    }
    return p;
  }
  function putProfile(p) { store.set(PROFILE_KEY, p); }

  /* ---------- sound (tiny synth) ----------
     Every effect runs through one master gain rather than straight to the
     speakers, so a single slider can ride the whole set. Each beep still picks
     its own level; that is balance between the effects, this is how loud the
     effects are as a group. */
  let actx = null, sfxMaster = null, sfxVol = 1;
  function sfxCtx() {
    if (!actx) {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      sfxMaster = actx.createGain();
      sfxMaster.gain.value = sfxVol;
      sfxMaster.connect(actx.destination);
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  function setSfxVolume(v) {
    sfxVol = Math.max(0, Math.min(1, Number(v) || 0));
    if (sfxMaster) sfxMaster.gain.value = sfxVol;
  }
  function beep(freq, dur, type, vol, slide) {
    if (UI.profile.muted || sfxVol <= 0) return;
    try {
      const ac = sfxCtx();
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(freq, ac.currentTime);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), ac.currentTime + dur);
      g.gain.setValueAtTime(vol || 0.04, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      o.connect(g).connect(sfxMaster);
      o.start(); o.stop(ac.currentTime + dur);
    } catch (e) { /* audio unavailable */ }
  }
  const sfx = {
    place: () => beep(300, 0.12, 'triangle', 0.06, 200),
    upgrade: () => beep(500, 0.15, 'triangle', 0.06, 300),
    sell: () => beep(400, 0.15, 'sawtooth', 0.04, -200),
    pop: () => beep(600 + Math.random() * 200, 0.05, 'square', 0.018, -300),
    leak: () => beep(180, 0.3, 'sawtooth', 0.06, -80),
    wave: () => beep(440, 0.12, 'triangle', 0.05, 120),
    boss: () => beep(110, 0.5, 'sawtooth', 0.08, -40),
    win: () => { beep(523, 0.15, 'triangle', 0.06); setTimeout(() => beep(659, 0.15, 'triangle', 0.06), 140); setTimeout(() => beep(784, 0.3, 'triangle', 0.07), 280); },
    lose: () => { beep(300, 0.25, 'sawtooth', 0.06, -100); setTimeout(() => beep(200, 0.4, 'sawtooth', 0.06, -80), 200); },
    error: () => beep(160, 0.12, 'square', 0.04),
  };

  /* ---------- UI state ---------- */
  const UI = {
    game: null,
    profile: getProfile(),
    canvas: null, ctx: null,
    lastTime: 0, rafId: 0,
    popSoundGate: 0,
    previewWave: 0,
  };
  G.UI = UI;

  /* ---------- touch helpers ---------- */
  const IS_TOUCH = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  // haptic tick — Android only; iOS ignores it, which is fine
  const buzz = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} };

  // keep the screen awake during a battle (phones dim fast while you watch a wave)
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && IS_TOUCH && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
      else if (!on && wakeLock) { wakeLock.release(); wakeLock = null; }
    } catch (e) { /* not granted — harmless */ }
  }
  /* Leaving the game should cost nothing. Before this, backgrounding the app
     left the frame loop and a 15Hz catch-up timer both alive: the browser
     throttles them, but every surviving tick still ran a full simulation step
     AND painted a canvas nobody could see, so a wave went on advancing in your
     pocket at about quarter speed — you could come back to lost lives. It also
     went on holding the screen awake.

     So: hidden pauses the battle and drops the wake lock. It stays paused when
     you come back, rather than resuming under your thumb. */
  document.addEventListener('visibilitychange', () => {
    const g = UI.game;
    if (document.visibilityState === 'visible') {
      if (g && !g.paused && !g.over) keepAwake(true);
      startLoop();
    } else {
      keepAwake(false);
      if (g && !g.over && !g.paused) setPaused(true);
    }
  });

  /* iPhones mute WebAudio when the ring/silent switch is on silent, because a
     web page counts as "ambient" sound. Declaring a playback session — and
     keeping a silent <audio> loop alive as the fallback for older iOS — moves
     the game into the media category, which the switch does not mute. */
  function unlockMobileAudio() {
    if (!IS_TOUCH) return;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    try {
      const a = new Audio('data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA');
      a.loop = true;
      a.setAttribute('playsinline', '');
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* audio unavailable */ }
  }

  function syncCancelBtn() {
    const g = UI.game;
    const on = !!(g && g.placingType && !g.over);
    $('#btn-cancel-place').classList.toggle('show', on);
    /* The placement hint. This used to be the selection card's job, but that
       card is a full-height column now — a third of the battlefield going dark
       to say a Bro's name and two keys. One line along the bottom of the
       map instead, where the cancel button already lives.

       Touch gets the name only: there is no shift and no esc on a phone, and
       the cancel button underneath is the way out. */
    const hint = $('#place-hint');
    hint.classList.toggle('show', on);
    /* setHTML, not innerHTML. setHTML remembers the last string it wrote to a
       node and skips the write when nothing changed; emptying the node behind
       its back left it remembering a sentence that was no longer there. So
       picking up the SAME Bro a second time was a no-op — the pill opened
       along the bottom of the map with nothing written in it, and stayed empty
       for as long as the Bro was in hand. Every route out of a placement
       comes through here, so this was every placement after the first. */
    if (!on) { setHTML(hint, ''); return; }
    const def = G.TOWERS[g.placingType];
    const color = def.hero ? 'var(--gold)' : G.CLASSES[def.cls].color;
    setHTML(hint, IS_TOUCH
      ? `<b style="color:${color}">${def.name}</b> — drag onto the map`
      : `<b style="color:${color}">${def.name}</b> — click to place
         · hold <kbd>shift</kbd> to place several · <kbd>esc</kbd> cancel`);
  }

  /* Tray slots, touch: hold shows the Bro's description card; drag out of
     the dock and you are carrying the Bro — the card vanishes, the ghost
     follows the finger, and lifting on the map places it. A quick tap still
     arms for tap-then-drag. Vertical strokes stay with the browser (tray
     scrolling): touch-action pan-y makes those fire pointercancel here. */
  /* Where the control column starts. #dock cannot answer this any more: it is
     display:contents in the only layout there is, so it generates no box and
     getBoundingClientRect() returns all zeros. That silently broke dragging a
     Bro out of the tray on a phone — the drag begins when the finger
     crosses the column's left edge, and the edge was reported as 0, so the
     finger could never be left of it. The tray is a real element in that
     column and spans its full width, so it is the one to ask. */
  /* Where the dock column starts, and where the canvas sits. Both are read on
     EVERY pointermove of a drag — the tray handler asks whether the finger has
     left the column, and canvasPos turns the finger into map coordinates — and
     both were a fresh getBoundingClientRect, which forces the browser to settle
     layout then and there. A finger fires 60-120 moves a second, so that was up
     to 240 forced reflows a second, interleaved with hoverAt writing
     cv.style.cursor: a read-write-read-write cycle, which is the shape that
     makes dragging feel like it is skipping.

     Neither rect moves while a drag is happening. They are cached and thrown
     away whenever the layout could actually have changed. */
  let rectCache = null;
  const invalidateRects = () => { rectCache = null; safeCache = null; };

  /* What is sticking into each edge of the screen, in pixels — the Dynamic
     Island, the notch, the home indicator. Zero on a screen with nothing
     sticking into it, which is most of them, so all of this is a no-op almost
     everywhere.

     Read off #safe-probe, a zero-sized hidden element whose padding is the four
     env(safe-area-inset-*) values. Script cannot ask for env() directly; the
     browser will only hand the numbers over already resolved, as a computed
     style, and it re-resolves them on rotation. This used to read #app, which
     carried them as real padding until that padding turned out to be costing
     the battlefield up to 12% of its width (see #app in style.css). */
  /* One of the numbers fitCanvas publishes on the root element, in pixels.
     Written there rather than kept in a variable because the CSS reads them
     too, and one source for both is the only way they cannot disagree. */
  const cssPx = (name) =>
    parseFloat(document.documentElement.style.getPropertyValue(name)) || 0;

  let safeCache = null;
  function safeArea() {
    if (safeCache) return safeCache;
    const app = $('#safe-probe');
    const cs = app ? getComputedStyle(app) : null;
    safeCache = cs ? {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
    } : { top: 0, right: 0, bottom: 0, left: 0 };
    return safeCache;
  }
  function rects() {
    if (!rectCache) {
      const pal = $('#palette'), cv = UI.canvas;
      rectCache = {
        left: pal ? pal.getBoundingClientRect().left : Infinity,
        canvas: cv ? cv.getBoundingClientRect() : null,
      };
    }
    return rectCache;
  }
  const columnLeft = () => rects().left;
  window.addEventListener('resize', invalidateRects);
  window.addEventListener('scroll', invalidateRects, true);
  window.addEventListener('orientationchange', invalidateRects);

  /* Is this point on the cancel button? Used while a Bro is being carried,
     because the tray slot holds an implicit pointer capture for the whole drag
     — every move and the lift are delivered to the SLOT, so the button never
     sees them and its own click never fires. Dropping a Bro on the big red
     cancel button used to place the Bro underneath it, which is the exact
     opposite of what it says. A little slop, because fingers are not precise. */
  function overCancelBtn(x, y) {
    const b = $('#btn-cancel-place');
    if (!b || !b.classList.contains('show')) return false;
    const r = b.getBoundingClientRect();
    if (!r.width) return false;
    const pad = 10;
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  }

  /* Is this point back inside the dock column? Dragging a Bro out and then
     back into the tray means "never mind", the same as dropping it on cancel —
     there is nowhere in the column it could sensibly be placed. */
  function overTray(x) { return x >= columnLeft() - 4; }

  /* Would a drag in this direction reach the battlefield?

     This is the rule, stated exactly: cast a ray from where the finger started,
     along the direction it is moving, and ask whether it enters the map. If it
     does, the player is pulling a Bro out. If it does not — straight down
     the tray, up the tray, off to the right — it is a scroll.

     It answers the question properly rather than with an angle threshold,
     because the angle that "leads to the map" is not a constant: it depends on
     where in the tray the finger started. From a tile at the top of the column
     the map lies left and DOWN as well as left; from one at the bottom it lies
     left and up. A fixed cone would have to be wrong at one end to be right at
     the other. Standard slab test against the canvas rectangle. */
  function rayReachesMap(ox, oy, dx, dy) {
    const r = rects().canvas;
    if (!r || !r.width) return dx < 0;      // no map measured yet: leftward wins
    let tmin = 0, tmax = Infinity;
    const slab = (o, d, lo, hi) => {
      if (Math.abs(d) < 1e-6) return o >= lo && o <= hi;
      let t1 = (lo - o) / d, t2 = (hi - o) / d;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      return tmin <= tmax;
    };
    if (!slab(ox, dx, r.left, r.right)) return false;
    if (!slab(oy, dy, r.top, r.bottom)) return false;
    return tmax >= 0;
  }

  /* The tray scrolls itself now. Its tiles are touch-action: none, because a
     browser that owns the vertical axis decides the gesture BEFORE we can: it
     commits to a pan after about 8px of movement, and on a diagonal pull the
     vertical component reaches 8px before the horizontal one reaches any
     threshold worth trusting. It would start scrolling, fire pointercancel, and
     the drag was gone — which is why a diagonal drag out kept failing however
     the angle rule was tuned. Owning the axis is the only way to be sure the
     decision is ours.

     What that costs is native momentum, so it is put back here: a flick keeps
     its velocity and decays, which is the only part of native scrolling a
     player would miss on a seven-row tray. */
  let trayGlide = null;
  function stopTrayGlide() { if (trayGlide) { cancelAnimationFrame(trayGlide); trayGlide = null; } }
  function glideTray(vy) {
    stopTrayGlide();
    const pal = $('#palette');
    if (!pal || Math.abs(vy) < 0.05) return;
    let v = Math.max(-4, Math.min(4, vy));   // px per ms
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(32, now - last); last = now;
      pal.scrollTop -= v * dt;
      v *= Math.pow(0.9975, dt);             // ~decay to nothing in half a second
      if (Math.abs(v) > 0.02) trayGlide = requestAnimationFrame(step);
      else trayGlide = null;
    };
    trayGlide = requestAnimationFrame(step);
  }

  function attachTrayDrag(slot, id) {
    let timer = null, showing = false, carrying = false, swallow = false;
    let sx = 0, sy = 0, settled = false;
    let mode = null;                 // null | 'carry' | 'scroll' — decided once, on the first real movement
    let lastY = 0, lastT = 0, vy = 0;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };

    slot.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse') return;   // mouse keeps hover + click
      /* no preventDefault here: iOS Safari would swallow the synthesized
         click that tap-to-arm depends on (Chrome keeps it, per spec).
         Selection during drags is suppressed by CSS instead —
         user-select/touch-callout on .slot and html/body */
      showing = false; carrying = false; swallow = false; settled = false;
      sx = ev.clientX; sy = ev.clientY;
      lastY = ev.clientY; lastT = ev.timeStamp || performance.now(); vy = 0;
      mode = null;
      stopTrayGlide();          // a new touch stops a flick that is still gliding
      clear();
      timer = setTimeout(() => {
        timer = null;
        const g = UI.game;
        if (g && !g.placingType) { showing = true; showTooltip(slot, id); }
      }, 200);
    });

    /* Pick the Bro up. Returns false when it cannot be taken, so the caller
       knows not to claim the gesture. */
    function beginCarry() {
      const g = UI.game;
      if (!g || g.over) return false;
      clear();
      if (showing) { hideTooltip(); showing = false; }
      const lock = towerLockMsg(id);
      if (lock) {
        sfx.error(); buzz(30);
        toast('🔒 ' + lock, 'bad');
        swallow = true; settled = true;
        return false;
      }
      const cost = g.priceOf(G.TOWERS[id].cost);
      if (g.cash < cost) {
        sfx.error(); buzz(30);
        toast(`Need ${fmt(cost)} for a ${G.TOWERS[id].name}.`, 'bad');
        swallow = true; settled = true;
        return false;
      }
      carrying = true; swallow = true; settled = true;
      g.placingType = id;
      g.selected = null;
      syncCancelBtn(); renderDockSel(); updateHud();
      return true;
    }

    slot.addEventListener('pointermove', (ev) => {
      if (ev.pointerType === 'mouse') return;
      const g = UI.game;
      if (!g || g.over) return;
      if (carrying) {
        g.mouse = canvasPos(ev);
        /* Both ways out light up as the finger passes over them, so it is clear
           before letting go that this drop puts the Bro back rather than
           placing it: the cancel button, and the tray it came from. */
        const back = overCancelBtn(ev.clientX, ev.clientY);
        const home = overTray(ev.clientX);
        $('#btn-cancel-place').classList.toggle('hot', back || home);
        $('#palette').classList.toggle('returning', home);
      }
    });

    /* Every touch that starts on a tile is ours, and this is where it is spent:
       the first real movement picks carry or scroll, and after that the choice
       does not change for the rest of the gesture. Six pixels is enough to have
       a direction and small enough that nothing has visibly happened yet. */
    slot.addEventListener('touchmove', (ev) => {
      const t = ev.touches && ev.touches[0];
      if (!t) return;
      ev.preventDefault();          // the tiles are touch-action:none; we drive both axes
      const now = ev.timeStamp || performance.now();

      if (mode === null && !settled) {
        const dx = t.clientX - sx, dy = t.clientY - sy;
        if (Math.hypot(dx, dy) < 6) return;
        if (rayReachesMap(sx, sy, dx, dy)) {
          mode = beginCarry() ? 'carry' : 'scroll';
        } else {
          mode = 'scroll';
          clear();
          if (showing) { hideTooltip(); showing = false; }
        }
      }

      if (mode === 'scroll') {
        const pal = $('#palette');
        const dy = t.clientY - lastY;
        if (pal) pal.scrollTop -= dy;
        const dt = Math.max(1, now - lastT);
        vy = 0.8 * (dy / dt) + 0.2 * vy;    // smoothed, for the flick
        swallow = true;                      // a scrolled tile must not also arm
      } else if (mode === 'carry') {
        const g = UI.game;
        if (g) g.mouse = canvasPos({ clientX: t.clientX, clientY: t.clientY });
      }
      lastY = t.clientY; lastT = now;
    }, { passive: false });

    const done = (ev) => {
      if (ev.pointerType === 'mouse') return;
      clear();
      const g = UI.game;
      $('#btn-cancel-place').classList.remove('hot');
      $('#palette').classList.remove('returning');
      if (mode === 'scroll') { glideTray(vy); mode = null; carrying = false; return; }
      /* Two ways to change your mind, and they are the two places a player
         would try: the cancel button, and the tray the Bro came out of.
         Neither spends a stud. Dropping it back where you got it is the more
         natural of the two — there is nothing in the column it could be placed
         on anyway, so a drop there could only ever have meant "never mind". */
      if (carrying && g && g.placingType === id
          && (overCancelBtn(ev.clientX, ev.clientY) || overTray(ev.clientX))) {
        g.placingType = null;
        g.mouse = { x: -999, y: -999 };
        sfx.sell(); buzz(12);
        syncCancelBtn(); renderDockSel(); updateHud();
        carrying = false; mode = null;
        return;
      }
      if (carrying && g && g.placingType === id) {
        const pos = canvasPos(ev);
        const placed = g.placeTower(id, pos.x, pos.y);
        if (placed) {
          sfx.place(); buzz(12);
          g.placingType = null;
          g.mouse = { x: -999, y: -999 };
        } else {
          /* A bad spot keeps the Bro in hand rather than sending it back to
             the tray. Letting go over a rock or the track used to mean starting
             the whole drag again, which is most of a fiddly placement's misery.
             Held is exactly the state tap-to-arm leaves behind, so the ghost
             stays under the finger with its red X and the next touch anywhere
             on the map tries again — no new machinery, and the cancel button is
             already the way out. No studs are ever spent on a failed drop. */
          sfx.error(); buzz(30);
        }
        syncCancelBtn(); renderDockSel(); updateHud();
      } else if (showing) {
        armTooltipDismiss();
      }
      carrying = false; mode = null;
    };
    slot.addEventListener('pointerup', done);
    slot.addEventListener('pointercancel', () => {   // tray scroll took the gesture
      clear();
      if (showing) { hideTooltip(); showing = false; }
      $('#btn-cancel-place').classList.remove('hot');
      $('#palette').classList.remove('returning');
      mode = null;
      if (carrying) {
        const g = UI.game;
        if (g && g.placingType === id) { g.placingType = null; g.mouse = { x: -999, y: -999 }; syncCancelBtn(); renderDockSel(); updateHud(); }
        carrying = false;
      }
    });
    // swallow the tap that follows a long-press or a completed drag
    slot.addEventListener('click', (ev) => {
      if (showing || swallow) { ev.stopPropagation(); ev.preventDefault(); showing = false; swallow = false; }
    }, true);
  }

  /* Long-press stands in for hover: it opens the same tooltip and swallows the
     tap that would otherwise have armed the Bro. */
  function attachLongPress(el, showFn) {
    let timer = null, fired = false, sx = 0, sy = 0;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    el.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse') return;
      fired = false; sx = ev.clientX; sy = ev.clientY;
      cancel();
      timer = setTimeout(() => { fired = true; timer = null; showFn(); armTooltipDismiss(); }, 420);
    });
    el.addEventListener('pointermove', (ev) => {
      if (timer && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 12) cancel();
    });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    // capture phase: kill the click that follows a long-press
    el.addEventListener('click', (ev) => {
      if (fired) { ev.stopPropagation(); ev.preventDefault(); fired = false; }
    }, true);
  }

  /* The next tap anywhere clears the card, with a timeout as a backstop.
     Registered a tick late so the tap that opened the card is not also the tap
     that closes it.

     Only one dismiss is ever pending. Before, each card armed its own and left
     it running: an earlier card's four-second backstop would still fire while a
     later card was up and take that one away early. Cheap to get wrong now that
     more than one route arms this. */
  let tipDismiss = null;
  function armTooltipDismiss() {
    clearTooltipDismiss();
    const off = () => { clearTooltipDismiss(); hideTooltip(); };
    tipDismiss = {
      off,
      arm: setTimeout(() => document.addEventListener('pointerdown', off, true), 0),
      /* The backstop only exists so a card can never be stranded — the next tap
         anywhere is what actually closes it. Four seconds was doing a second
         job it was not meant to: the upgrade card is three tier names and three
         descriptions, about twelve seconds of reading, and it used to vanish a
         third of the way through. */
      bail: setTimeout(off, 14000),
    };
  }
  function clearTooltipDismiss() {
    if (!tipDismiss) return;
    const d = tipDismiss;
    tipDismiss = null;
    clearTimeout(d.arm);
    clearTimeout(d.bail);
    document.removeEventListener('pointerdown', d.off, true);
  }

  /* Three at once, oldest retired early. A wave ending on a boss, on a tenth
     wave, with a hero levelling can fire four of these inside a second, and a
     stack that tall reaches a third of the way up a phone. */
  const TOAST_MAX = 3;
  function toast(msg, kind) {
    const box = $('#toasts');
    while (box.children.length >= TOAST_MAX) box.firstChild.remove();
    const t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
    box.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
  }

  function banner(msg) {
    const b = $('#banner');
    b.textContent = msg;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
  }

  /* ---------- screens ---------- */
  function show(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
    if (id) $(id).classList.add('active');
    $('#overlay').style.display = id ? 'flex' : 'none';
    /* A menu covers the game, and the selection card is part of the game. It
       sits at z-index 45 against the overlay's 20, so a battle that ended with
       a Bro selected drew its upgrade card across the victory screen with
       the dock still hidden behind it. Raising the overlay instead would have
       put it over the toasts and the fullscreen button too, which is a bigger
       change than the problem. */
    if (id) {
      const sel = $('#selpanel');
      if (sel) { sel.hidden = true; sel.innerHTML = ''; }
      showDock(true);
      closeConfirm();
      /* And drop the selection with it, or the game comes back from the menu
         believing a card is open that is not on screen — which leaves the panel
         shut until you tap a DIFFERENT Bro, because the poll only redraws
         when the selection changes. */
      if (UI.game) UI.game.selected = null;
    }
    // every menu screen carries a pebble chip — keep them all current
    for (const b of document.querySelectorAll('.js-bricks')) b.textContent = UI.profile.bricks.toLocaleString();
    syncRankChips();
  }

  function openPauseMenu() {
    const g = UI.game;
    if (!g || g.over) return;
    setPaused(true);
    show('#screen-pause');
  }
  function closePauseMenu() {
    show(null);
    setPaused(false);
  }

  const ICON_FS = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 3h7v2H5v5H3V3zm11 0h7v7h-2V5h-5V3zM3 14h2v5h5v2H3v-7zm16 0h2v7h-7v-2h5v-5z"/></svg>';
  const ICON_FS_EXIT = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 3v7H3V8h5V3h2zm4 0h2v5h5v2h-7V3zM3 14h7v7H8v-5H3v-2zm11 0h7v2h-5v5h-2v-7z"/></svg>';

  function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  function toggleFullscreen() {
    const root = document.documentElement;
    const blocked = () => toast('Fullscreen was blocked by the browser.', 'bad');
    try {
      const p = isFullscreen()
        ? (document.exitFullscreen || document.webkitExitFullscreen).call(document)
        : (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
      if (p && p.catch) p.catch(blocked);
    } catch (e) { blocked(); }
  }
  function updateFsButton() { $('#btn-fs').innerHTML = isFullscreen() ? ICON_FS_EXIT : ICON_FS; }

  /* ---------- progress backup: one file the player keeps ----------
     Phones/tablets get the share sheet (Save to Files on iOS — an iCloud Drive
     folder syncs it across devices); everywhere else it downloads. Loading
     opens the file picker, which on iOS is the Files app. */
  function collectBackup() {
    const saves = {};
    for (let i = 0; i < G.LEVELS.length; i++) {
      const s = store.get(saveKey(i), null);
      if (s) saves[i] = s;
    }
    return {
      /* The other game stamps its own name here and refuses any file that does
         not carry it. Two different stamps is what stops a backup from one
         game being loaded over the other game's progress. */
      game: 'brix-and-bros', kind: 'progress-backup', version: 1,
      exported: new Date().toISOString(),
      profile: UI.profile,
      saves,
    };
  }

  async function exportProgress() {
    const name = 'brix-and-bros-progress-' + new Date().toISOString().slice(0, 10) + '.json';
    const blob = new Blob([JSON.stringify(collectBackup(), null, 2)], { type: 'application/json' });
    if (IS_TOUCH && navigator.canShare) {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'Brix and Bros progress' });
          toast('Progress backed up 💾');
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;   // player closed the share sheet
          /* share refused — fall through to a plain download */
        }
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Backup saved — check your downloads 💾');
  }

  function importProgress(file) {
    const reader = new FileReader();
    reader.onerror = () => toast('Could not read that file.', 'bad');
    reader.onload = () => {
      let data = null;
      try { data = JSON.parse(reader.result); } catch (e) { /* not JSON — caught below */ }
      if (!data || data.game !== 'brix-and-bros' || data.kind !== 'progress-backup' || !data.profile) {
        toast('That file is not a Brix and Bros backup.', 'bad');
        return;
      }
      if (!confirm('Load this backup? It replaces the progress on this device.')) return;
      store.set(PROFILE_KEY, data.profile);
      for (let i = 0; i < G.LEVELS.length; i++) {
        if (data.saves && data.saves[i]) store.set(saveKey(i), data.saves[i]);
        else store.del(saveKey(i));
      }
      UI.profile = getProfile();   // re-read through the backfill, so old backups gain new fields
      show('#screen-menu');        // refreshes every pebble chip
      toast('Progress loaded ✔');
    };
    reader.readAsText(file);
  }

  function buildMainMenu() {
    $('#btn-play').onclick = () => { buildLevelSelect(); show('#screen-levels'); };
    $('#btn-shop').onclick = () => buildShop('#screen-menu');
    $('#btn-workshop').onclick = () => buildWorkshop('#screen-menu');
    $('#btn-heroes').onclick = () => { buildHeroRow($('#hero-row-menu')); show('#screen-heroes'); };
    $('#btn-heroes-back').onclick = () => show('#screen-menu');
    $('#btn-guide').onclick = () => buildGuide('#screen-menu');
    $('#btn-pause-guide').onclick = () => buildGuide('#screen-pause');
    $('#btn-howto').onclick = () => show('#screen-howto');
    $('#btn-howto-back').onclick = () => show(UI.game ? '#screen-pause' : '#screen-menu');
    $('#btn-reset').onclick = () => {
      if (!confirm('Wipe all progress and saves?')) return;
      store.del(PROFILE_KEY);
      for (let i = 0; i < G.LEVELS.length; i++) store.del(saveKey(i));
      UI.profile = getProfile();
      show('#screen-menu');   // pebble chips back to zero
      toast('Progress reset.');
    };
    $('#btn-export').onclick = exportProgress;
    $('#btn-import').onclick = () => $('#import-file').click();
    $('#import-file').onchange = (ev) => {
      const f = ev.target.files && ev.target.files[0];
      ev.target.value = '';   // so picking the same file again still fires change
      if (f) importProgress(f);
    };
    $('#btn-resume').onclick = closePauseMenu;
    $('#btn-pause-save').onclick = () => { doSave(false); };
    $('#btn-pause-quit').onclick = () => exitToMenu(true);
    $('#btn-pause-restart').onclick = restartBattle;
  }

  function buildLevelSelect() {
    const grid = $('#level-grid');
    grid.innerHTML = '';
    const p = UI.profile;

    // one section per campaign tier, each with its own card grid
    const sections = {};
    for (const T of G.TIERS) {
      const first = G.LEVELS.findIndex((L) => L.tier === T.id);
      const count = G.LEVELS.filter((L) => L.tier === T.id).length;
      const reached = G.DIFF_ORDER.some((d) => G.tierUnlocked(p, T.id, d));
      const beaten = G.LEVELS.filter((L) => L.tier === T.id && p.completed[L.id]).length;

      // one chip per difficulty: is this whole tier open on it, and how far in?
      const diffChips = G.DIFF_ORDER.map((d) => {
        const D = G.DIFFICULTIES[d];
        const open = G.tierUnlocked(p, T.id, d);
        const cleared = G.LEVELS.filter((L) => L.tier === T.id && G.beatenAtLeast(p, L.id, d)).length;
        if (!open) {
          const prev = G.TIERS.find((x) => x.id === T.id - 1);
          const left = G.tierLevels(T.id - 1).filter((x) => !G.beatenAtLeast(p, x.id, d)).length;
          return `<span class="badge diff-lock" title="Clear ${prev.name} on ${D.name} — ${left} to go.">${D.icon} ${D.name} 🔒</span>`;
        }
        return `<span class="badge${cleared === count ? ' done' : ' diff-open'}" title="${D.name} is open on this tier.">${D.icon} ${D.name} ${cleared}/${count}</span>`;
      }).join('');

      const sec = el('div', 'lvl-section' + (reached ? '' : ' locked'));
      const head = el('div', 'lvl-sec-head');
      head.innerHTML = `
        <div class="lvl-sec-title"><span class="lvl-sec-icon">${T.icon}</span>${T.name}</div>
        <div class="lvl-sec-meta">
          <span class="badge">Battlefields ${first + 1}–${first + count}</span>
          <span class="badge${beaten === count ? ' done' : ''}">${beaten} / ${count} defended</span>
          ${diffChips}
        </div>
        <div class="lvl-sec-blurb">${T.blurb}</div>`;
      sec.appendChild(head);
      const cards = el('div', 'lvl-cards');
      sec.appendChild(cards);
      grid.appendChild(sec);
      sections[T.id] = cards;
    }

    G.LEVELS.forEach((L, i) => {
      const unlocked = G.anyDiffUnlocked(p, i);
      const save = store.get(saveKey(i), null);
      const best = p.bestWave[L.id] || 0;
      const stars = '★'.repeat(L.diff) + '<span class="dim-star">' + '★'.repeat(5 - L.diff) + '</span>';
      const card = el('div', 'level-card' + (unlocked ? '' : ' locked'));

      const thumb = document.createElement('canvas');
      thumb.className = 'lvl-thumb';
      thumb.width = 232;
      thumb.height = Math.round(232 * L.h / L.w); // keep each tier's true aspect
      G.drawLevelThumb(thumb, L);
      card.appendChild(thumb);
      if (!unlocked) card.appendChild(el('div', 'lvl-lock', '🔒'));

      const done = p.diffDone[L.id] || {};
      const diffBadges = G.DIFF_ORDER
        .filter((d) => done[d])
        .map((d) => `<span class="badge done">${G.DIFFICULTIES[d].icon} ${G.DIFFICULTIES[d].name} ✔</span>`)
        .join('');
      const body = el('div', 'lvl-body');
      body.innerHTML = `
        <div class="lvl-row"><span class="lvl-name">${i + 1}. ${L.name}</span><span class="lvl-stars">${stars}</span></div>
        <div class="lvl-tag">${unlocked ? L.tagline : G.lockReason(p, i, 'easy')}</div>
        <div class="lvl-meta">
          ${diffBadges}
          ${best && !p.completed[L.id] ? `<span class="badge">Best: wave ${best}</span>` : ''}
          ${p.endlessBest[L.id] ? `<span class="badge" title="Endless Shift record — keep going after a victory to beat it">🔁 Endless: wave ${p.endlessBest[L.id]}</span>` : ''}
          ${save ? '<span class="badge save">💾 Saved game</span>' : ''}
        </div>`;
      card.appendChild(body);

      if (unlocked) {
        const row = el('div', 'lvl-actions');
        const bNew = el('button', 'btn small', save ? 'New Game' : '▶ Play');
        bNew.onclick = (ev) => {
          ev.stopPropagation();
          if (save && !confirm('Start fresh? This overwrites the existing save for this level.')) return;
          openDiffSelect(i);
        };
        row.appendChild(bNew);
        if (save) {
          const D = G.DIFFICULTIES[save.diff || 'hard'];
          const bCont = el('button', 'btn small primary', `⏵ Continue — wave ${save.wave} · ${D.name}`);
          bCont.onclick = (ev) => { ev.stopPropagation(); startGame(i, save); };
          row.appendChild(bCont);
        }
        card.appendChild(row);

        /* The whole card is the target, not just the button in the corner of
           it — a card with a picture on it reads as clickable and people click
           the picture. It does whatever the card's primary button does: resume
           where there is a save, otherwise go and pick a difficulty. The
           buttons stop the event, so clicking one still does its own thing. */
        const enter = () => { if (save) startGame(i, save); else openDiffSelect(i); };
        card.onclick = enter;
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', `${L.name} — ${save ? `continue at wave ${save.wave}` : 'play'}`);
        card.onkeydown = (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); enter(); }
        };
      }
      (sections[L.tier] || grid).appendChild(card);
    });
    $('#btn-levels-back').onclick = () => show('#screen-menu');
  }

  /* ---------- difficulty select ---------- */
  function openDiffSelect(levelIdx) {
    const L = G.LEVELS[levelIdx];
    $('#diff-sub').textContent = `${L.name} — how hard should the packs hit?`;
    const grid = $('#diff-grid');
    grid.innerHTML = '';
    for (const dId of G.DIFF_ORDER) {
      const D = G.DIFFICULTIES[dId];
      const done = (UI.profile.diffDone[L.id] || {})[dId];
      const locked = !G.levelUnlocked(UI.profile, levelIdx, dId);
      const priceLine = D.costMult === 1
        ? 'standard tower prices'
        : `towers ${Math.round(Math.abs(1 - D.costMult) * 100)}% ${D.costMult < 1 ? 'cheaper' : 'pricier'}`;
      const card = el('div', 'diff-card ' + dId + (locked ? ' locked' : ''));
      card.innerHTML = `
        <div class="diff-icon">${locked ? '🔒' : D.icon}</div>
        <div class="diff-name">${D.name}${done ? ' <span class="diff-done" title="Beaten on this difficulty">✔</span>' : ''}</div>
        ${locked ? `<div class="diff-locked-why">${G.lockReason(UI.profile, levelIdx, dId)}</div>` : `
        <ul class="diff-facts">
          <li><b>${D.waves}</b> waves</li>
          <li><b>${G.scaleLives(L.lives, dId)}</b> lives</li>
          <li>${priceLine}</li>
          <li class="diff-reward">win: +${D.bricks} 🧱 · retry: ${G.scaleRetry(D.retryCost)} 🧱</li>
        </ul>`}`;
      if (!locked) card.onclick = () => startGame(levelIdx, null, dId);
      grid.appendChild(card);
    }
    buildHeroRow($('#hero-row'));
    $('#btn-diff-shop').onclick = () => buildShop('#screen-diff');
    $('#btn-diff-workshop').onclick = () => buildWorkshop('#screen-diff');
    $('#btn-diff-back').onclick = () => show('#screen-levels');
    show('#screen-diff');
  }

  /* ---------- hero picker (difficulty screen + heroes screen) ---------- */
  function buildHeroRow(row) {
    row = row || $('#hero-row');
    row.innerHTML = '';
    const p = UI.profile;
    const rescreen = () => {           // refresh pebble chips on whichever screen we're on
      const sc = row.closest('.screen');
      if (sc && sc.classList.contains('active')) show('#' + sc.id);
    };
    for (const id of G.HERO_ORDER) {
      const def = G.TOWERS[id];
      const H = G.HEROES[id];
      const owned = !!p.heroes[id];
      const sel = p.heroSel === id;
      const card = el('div', 'hero-card' + (sel ? ' sel' : '') + (owned ? '' : ' locked'));
      const cv = document.createElement('canvas');
      cv.width = 52; cv.height = 52;
      G.drawTowerIcon(cv, id);
      card.appendChild(cv);
      card.appendChild(el('div', 'hc-name', def.name));
      card.appendChild(el('div', 'hc-blurb', H.blurb));
      card.appendChild(el('div', 'hc-abil', `${H.ability.icon} ${H.ability.name} <span class="dim">· lvl ${H.ability.unlock}</span>`));
      if (owned) {
        card.appendChild(el('div', 'hc-state', sel ? '✔ fighting with you' : 'tap to choose'));
        card.onclick = () => {
          p.heroSel = sel ? null : id;   // tap the chosen one again to fight heroless
          putProfile(p);
          buildHeroRow(row);
        };
      } else {
        const afford = p.bricks >= H.bricks;
        const btn = el('button', 'btn small' + (afford ? ' primary' : ''), `Recruit · ${H.bricks.toLocaleString()} 🧱`);
        btn.disabled = !afford;
        if (!afford) card.appendChild(el('div', 'hc-state', 'win battles to afford them'));
        btn.onclick = (ev) => {
          ev.stopPropagation();
          if (p.bricks < H.bricks) return;
          if (!confirm(`Recruit ${def.name} for ${H.bricks.toLocaleString()} 🧱 bricks? Heroes are yours forever.`)) return;
          p.bricks -= H.bricks;
          p.heroes[id] = true;
          p.heroSel = id;
          putProfile(p);
          sfx.win();
          toast(`⭐ ${def.name} joins the workshop!`);
          rescreen();               // pebble chips update wherever we are
          buildHeroRow(row);
        };
        card.appendChild(btn);
      }
      row.appendChild(card);
    }
  }

  /* ---------- game lifecycle ---------- */
  function startGame(levelIdx, save, diffId) {
    const heroSel = UI.profile.heroes[UI.profile.heroSel] ? UI.profile.heroSel : null;
    const game = save ? G.Game.deserialize(save) : new G.Game(levelIdx, diffId, heroSel);
    UI.game = game;
    game.onEvent = onGameEvent;
    sizeCanvas();   // the Game constructor set G.W/G.H for this battlefield
    show(null);
    $('#hud-stats').style.display = 'flex';
    $('#hud-sys').style.display = 'flex';
    /* a class, not an inline display — the wide layout needs #dock to be
       display:contents so its panels can be placed into the page grid, and an
       inline style would win over that */
    $('#dock').classList.add('playing');
    fitCanvas();          // the dock's arrival changes what the map has to fill
    $('#auto-start').checked = game.autoStart;
    UI.previewWave = 0;
    syncCancelBtn();
    buildPalette();
    buildDockPowers();
    buildDockHero();
    renderDockSel();
    updateWavePreview();
    updateHud();
    fitPanels();   // the panels have their content now; scale to what it needs
    keepAwake(true);
    startLoop();
    banner(save ? `Welcome back — Wave ${game.wave}` : `${game.level.name} — ${G.DIFFICULTIES[game.diffId].name}`);
    G.music.play(G.music.trackForLevel(levelIdx));
    G.music.setTempoScale(G.tempoForWave(game.wave));
  }

  function exitToMenu(saveFirst) {
    const g = UI.game;
    if (g && saveFirst && !g.over) doSave(true);
    keepAwake(false);
    UI.game = null;
    $('#hud-stats').style.display = 'none';
    $('#hud-sys').style.display = 'none';
    $('#dock').classList.remove('playing');
    fitCanvas();          // and its departure gives the whole window back
    hideTooltip();
    /* Explicitly, not via renderDockSel: that returns early once UI.game is
       null, so the flyout would have stayed on screen over the menu. */
    const sel = $('#selpanel');
    sel.hidden = true; sel.innerHTML = '';
    showDock(true);   // or the tray comes back invisible next battle
    closeConfirm();
    G.music.play('menu');
    buildLevelSelect();
    show('#screen-levels');
  }

  /* Start this battlefield again from wave 1, same difficulty, from the pause
     menu. It goes through startGame rather than resetting the live Game: the
     constructor is the only place that knows the full list of fields a battle
     starts with, so a fresh Game cannot drift out of date the way a hand-written
     reset would every time a field is added. (Second Chance is the opposite
     operation — it deliberately KEEPS the board — so there is nothing to share.)

     Three things have to happen around it, none of which startGame does:
       · bank the XP first. Kills are only banked at the end of a wave, so
         everything felled since then is unbanked, and the builder rank that
         recruits new Bros is built from exactly those kills. The game's
         standing rule is that a vacuum felled is never forfeited, defeat
         included, and a restart should not be the one exception.
       · delete the save. It is keyed on the level alone and startGame does not
         touch it, so the abandoned run would still be sitting there offering
         "Continue — wave 23" from the level card.
       · drop the wake lock before taking a new one. keepAwake(true) overwrites
         the sentinel without releasing it, which is fine today only because
         every other route into startGame comes from the menu with no lock held.
         A restart is the first thing to enter it from a live battle. */
  function restartBattle() {
    const g = UI.game;
    if (!g) return;
    if (!confirm('Restart this battle from wave 1? Everything built is lost, and any boosts already used are not refunded.')) return;
    bankXp();
    store.del(saveKey(g.levelIdx));
    hideTooltip();
    keepAwake(false);
    const li = g.levelIdx, diff = g.diffId;
    /* Unpause while the old game is still there — setPaused reaches into it and
       into the music scheduler — and only then throw it away. */
    closePauseMenu();
    UI.game = null;
    startGame(li, null, diff);
  }

  function doSave(silent) {
    const g = UI.game;
    if (!g || g.over) return;
    bankXp();   // no-op if nothing new was felled; keeps quitting from losing XP
    const ok = store.set(saveKey(g.levelIdx), g.serialize());
    if (!silent) toast(ok ? '💾 Game saved.' : 'Save failed — browser storage unavailable.', ok ? '' : 'bad');
  }

  function onGameEvent(kind, payload) {
    const g = UI.game;
    if (kind === 'waveStart') {
      sfx.wave();
      // +1% tempo per wave, but the march stops getting faster at wave 75
      G.music.setTempoScale(G.tempoForWave(payload));
      if (g.endless && payload === G.HEAVY_WAVE) {
        sfx.boss();
        banner('🔁 THE BIG MACHINES ARRIVE — the heavies have found you');
        toast('The board has come apart. Heavies hunt the packs and the workshop alike — and every vacuum they swallow heals them.', 'bad');
      } else {
        banner(g.endless ? `🔁 Wave ${payload} — the shift drags on` : `Wave ${payload} / ${g.totalWaves}`);
      }
      const spec = G.generateWave(g.levelIdx, payload);
      if (spec.groups.some((gr) => G.ENEMIES[gr.type].boss)) { sfx.boss(); banner(`⚠ Wave ${payload} — something huge is coming…`); }
      updateWavePreview();
      updateHud();
    } else if (kind === 'waveEnd') {
      bankXp();
      doSave(true);
      if (g.endless && payload.wave > g.totalWaves) {
        const p = UI.profile;
        p.endlessBest[g.level.id] = Math.max(p.endlessBest[g.level.id] || 0, payload.wave);
        // every 10th endless wave pays the drip; every 100th pays ten drips.
        // D.drip, not D.retryCost — rewards don't move when retry pricing does.
        if (payload.wave % 100 === 0) {
          const D = G.DIFFICULTIES[g.diffId];
          const bonus = D.drip * 10;
          p.bricks += bonus;
          banner(`🔁 Wave ${payload.wave} — the shift bows to you`);
          toast(`🏆 Century! Wave ${payload.wave} survived: +${bonus} 🧱 bricks`);
        } else if (payload.wave % 10 === 0) {
          const D = G.DIFFICULTIES[g.diffId];
          p.bricks += D.drip;
          toast(`🔁 Wave ${payload.wave} survived! +${D.drip} 🧱 bricks`);
        } else {
          toast(`Wave ${payload.wave} cleared! +${fmt(payload.earned)}`);
        }
        putProfile(p);
      } else {
        toast(`Wave ${payload.wave} cleared! +${fmt(payload.earned)}`);
      }
      updateWavePreview();
      updateHud();
    } else if (kind === 'heroLevel') {
      sfx.upgrade();
      const def = G.TOWERS[g.heroType];
      const H = G.HEROES[g.heroType];
      toast(`⭐ ${def.name} reached Level ${payload}!` +
        (payload === H.ability.unlock ? ` ${H.ability.icon} ${H.ability.name} is ready.` : ''));
      if (g.selected === g.heroTower) renderDockSel();
      updateDockHero();
    } else if (kind === 'leak') {
      sfx.leak();
    } else if (kind === 'bossDown') {
      /* A boss going down is a MOMENT, and the game already has a channel for
         moments: the banner that announces a wave. It is centred, it fades on
         its own, and it takes no pointer events. As a toast it was a card
         parked in the corner of a phone for two and a half seconds, over the
         vitals and over the selection card, at exactly the point in a battle
         when you most want to see the battlefield. */
      banner(`☠ ${payload} down!`);
    } else if (kind === 'victory') {
      G.music.stop();
      bankXp();          // the final wave's vacuums count too
      sfx.win();
      const p = UI.profile;
      const D = G.DIFFICULTIES[g.diffId];
      p.completed[g.level.id] = true;
      p.diffDone[g.level.id] = Object.assign({}, p.diffDone[g.level.id], { [g.diffId]: true });
      p.bestWave[g.level.id] = Math.max(p.bestWave[g.level.id] || 0, g.totalWaves);
      p.bricks += D.bricks;
      putProfile(p);
      store.del(saveKey(g.levelIdx));

      // who earned their studs this battle?
      const top = [...g.towers].sort((a, b) => (b.kills || 0) - (a.kills || 0))[0];
      const topLine = top && top.kills ? ` Top defender: ${G.TOWERS[top.type].name} — ${top.kills.toLocaleString()} vacuums.` : '';

      // say what this win actually opened up on this difficulty
      const nextTier = G.TIERS.find((T) => T.id === g.level.tier + 1);
      let opened = '';
      if (nextTier && G.tierUnlocked(p, nextTier.id, g.diffId)) {
        opened = ` ${nextTier.name} is now open on ${D.name}!`;
      } else if (g.levelIdx + 1 < G.LEVELS.length && G.levelUnlocked(p, g.levelIdx + 1, g.diffId)) {
        opened = ` "${G.LEVELS[g.levelIdx + 1].name}" is now open on ${D.name}.`;
      } else if (!nextTier && G.tierLevels(g.level.tier).every((L) => G.beatenAtLeast(p, L.id, g.diffId))) {
        opened = ` You have cleared the whole campaign on ${D.name}. The vacuums have given up!`;
      }

      $('#btn-retry').style.display = 'none';
      const eb = $('#btn-endless');
      eb.style.display = 'block';
      const rec = p.endlessBest[g.level.id] || 0;
      eb.innerHTML = `🔁 Keep Going — Endless Shift${rec ? ` · record: wave ${rec}` : ''}`;
      eb.title = 'The waves keep coming, tougher every time, until the workshop falls. Your victory is already banked.';
      eb.onclick = keepGoing;
      $('#end-title').textContent = '🏆 Build Defended!';
      $('#end-sub').textContent = `${g.level.name} (${D.name}) is safe. All ${g.totalWaves} waves repelled with ${g.lives} lives to spare.` + topLine +
        ` Reward: +${D.bricks} 🧱 bricks — you now have ${p.bricks.toLocaleString()}. ` +
        `${g.kills.toLocaleString()} vacuums destroyed — ${rankChipText()}.` + opened;
      show('#screen-end');
      keepAwake(false);   // the battle is over; stop holding the screen on
    } else if (kind === 'defeat') {
      G.music.stop();
      bankXp();          // a lost battle still earned every vacuum it felled
      sfx.lose();
      const p = UI.profile;
      p.bestWave[g.level.id] = Math.max(p.bestWave[g.level.id] || 0, g.wave - 1);
      if (g.endless) p.endlessBest[g.level.id] = Math.max(p.endlessBest[g.level.id] || 0, g.wave - 1);
      putProfile(p);
      store.del(saveKey(g.levelIdx));
      const D = G.DIFFICULTIES[g.diffId];
      const price = G.scaleRetry(D.retryCost);
      const afford = p.bricks >= price;
      const rb = $('#btn-retry');
      rb.style.display = 'block';
      rb.disabled = !afford;
      rb.innerHTML = `🧱 Second Chance — retry wave ${g.wave} · ${price} bricks`;
      rb.title = afford
        ? `Restore all ${g.startLives} lives and replay wave ${g.wave}. Towers and cash are kept.`
        : `You need ${price} 🧱 — win battles to earn more.`;
      rb.onclick = retryBattle;
      $('#btn-endless').style.display = 'none';
      if (g.endless) {
        const rec = p.endlessBest[g.level.id];
        $('#end-title').textContent = '🔁 The Shift Ends';
        $('#end-sub').textContent = `The workshop held for ${g.wave - 1} waves — ` +
          `${g.wave - 1 - g.totalWaves} beyond the campaign's ${g.totalWaves}. ` +
          (g.wave - 1 >= rec ? 'A new record for this battlefield!' : `Record here: wave ${rec}.`) +
          (afford ? ' The workshop can rally, for a price…' : '');
      } else {
        $('#end-title').textContent = '💔 The Workshop Has Fallen';
        $('#end-sub').textContent = `The vacuums broke through on wave ${g.wave}. You survived ${g.wave - 1} full waves ` +
          `and felled ${g.kills.toLocaleString()} vacuums — ${rankChipText()}.` +
          (afford ? ' The workshop can rally, for a price…' : ' Regroup and try again!');
      }
      show('#screen-end');
      keepAwake(false);   // the battle is over; stop holding the screen on
    }
  }

  /* ---------- HUD ---------- */
  function updateHud() {
    const g = UI.game;
    if (!g) return;
    $('#hud-lives').textContent = g.lives;
    $('#hud-cash').textContent = Math.round(g.cash).toLocaleString(); // studs icon sits beside it
    /* Set here rather than by the .js-bricks sweep, which only runs on a
       screen change: bricks are awarded mid-battle for surviving a wave, and
       this is the one place that is already re-reading the HUD as it happens. */
    $('#hud-bricks').textContent = UI.profile.bricks.toLocaleString();
    $('#hud-wave').textContent = g.endless ? `Wave ${g.wave} · ∞` : `Wave ${Math.min(g.wave, g.totalWaves)} / ${g.totalWaves}`;
    $('#wave-bar i').style.width = Math.min(100, ((g.wave - 1) / g.totalWaves) * 100) + '%';
    $('#hud-level').textContent = `${g.level.name} · ${G.DIFFICULTIES[g.diffId].name}`;

    const btn = $('#send-wave');
    if (g.over) {
      btn.disabled = true;
      setHTML(btn, g.over === 'win' ? '🏆 Victory' : '💔 Defeated');
    } else if (g.waveInProgress) {
      btn.disabled = true;
      const remaining = g.enemies.length + g.spawnQueue.length;
      setHTML(btn, `${remaining} vacuum${remaining === 1 ? '' : 's'} left`);
    } else if (g.autoStart && g.nextWaveIn != null) {
      btn.disabled = true;
      setHTML(btn, 'Auto-sending…');
    } else {
      btn.disabled = false;
      setHTML(btn, 'Send Wave <kbd>space</kbd>');
    }
    $('#btn-speed').textContent = g.speed + '×';
    $('#btn-pause').textContent = g.paused ? '▶' : '⏸';
    $('#btn-pause').classList.toggle('attention', g.paused);
    setHTML($('#btn-mute'), UI.profile.muted ? ICON_SOUND_OFF : ICON_SOUND_ON);

    // palette affordability + armed state (locked slots keep their look)
    for (const slot of document.querySelectorAll('#palette .slot')) {
      if (slot.classList.contains('locked')) continue;
      const def = G.TOWERS[slot.dataset.type];
      /* Bulk Orders can cut every price mid-battle, so the tray's own
         labels are refreshed here rather than left at whatever they cost when
         the dock was built — a tile that advertises the old price is a lie the
         player only finds out about at the checkout. */
      const price = g.priceOf(def.cost);
      slot.classList.toggle('poor', g.cash < price);
      slot.classList.toggle('armed', g.placingType === slot.dataset.type);
      const tag = slot.querySelector('.slot-cost');
      if (tag && tag.textContent !== String(price)) tag.textContent = String(price);
    }

    /* upgrade buttons light up the moment they become affordable — the card
       itself only re-renders on selection changes, so without this the
       poor/can state would freeze at whatever the cash was back then */
    for (const b of document.querySelectorAll('#selpanel .ds-path[data-cost]')) {
      const can = g.cash >= +b.dataset.cost;
      if (can && !b.classList.contains('can')) {
        b.classList.add('flash');   // one pulse right as it crosses the line
        b.addEventListener('animationend', () => b.classList.remove('flash'), { once: true });
      }
      b.classList.toggle('can', can);
      b.classList.toggle('poor', !can);
    }

    // boost inventory in the dock
    for (const btn of document.querySelectorAll('#dock-powers .dp-btn')) {
      const owned = UI.profile.powerInv[btn.dataset.power] || 0;
      btn.querySelector('.dp-count').textContent = owned;
      btn.classList.toggle('empty', owned <= 0);
      btn.disabled = !!g.over;
    }

    // kill counter on the open card ticks live while the wave runs — same
    // compact form the card was built with, or a long run would widen the
    // stat line out from under itself mid-wave
    const kEl = document.querySelector('.ds-kills');
    if (kEl && g.selected) kEl.textContent = short(g.selected.kills || 0);

    updateDockHero();
  }

  /* ---------- wave preview ---------- */
  function updateWavePreview() {
    const g = UI.game;
    if (!g) return;
    const w = g.endless ? g.wave : Math.min(g.wave, g.totalWaves);
    const box = $('#wave-preview');
    const spec = G.generateWave(g.levelIdx, w);
    const counts = new Map();
    for (const grp of spec.groups) counts.set(grp.type, (counts.get(grp.type) || 0) + grp.count);
    /* Bosses first. The strip is two rows tall and late waves field more enemy
       types than fit, so something has to be dropped — and the one chip you
       must not lose is the one naming the boss. It used to sort last and got
       sliced in half by the strip's clip. The wave number lives in the HUD at
       the top of the screen, so it is not repeated here. */
    const ordered = [...counts].sort((a, b) => (G.ENEMIES[b[0]].boss ? 1 : 0) - (G.ENEMIES[a[0]].boss ? 1 : 0));
    let html = '';
    for (const [type, n] of ordered) {
      const e = G.ENEMIES[type];
      html += e.boss
        ? `<span class="wp-chip boss" title="${e.name} — boss">☠ ${e.name}${n > 1 ? ' ×' + n : ''}</span>`
        : `<span class="wp-chip" title="${e.name}"><i style="background:${e.color}"></i>${n}</span>`;
    }
    box.innerHTML = html;
    /* Hide any chip that fell past the visible rows rather than letting the
       clip cut one through the middle — a half-height chip reads as a
       rendering fault, an absent one reads as "and some others". */
    const top = box.getBoundingClientRect().top;
    const limit = box.clientHeight + 1;
    let hidden = 0;
    for (const chip of box.children) {
      chip.style.visibility = '';
      if (chip.getBoundingClientRect().bottom - top > limit) { chip.style.visibility = 'hidden'; hidden++; }
    }
    if (hidden) box.title = `${hidden} more enemy type${hidden === 1 ? '' : 's'} in this wave`;
    else box.removeAttribute('title');
  }

  /* ---------- command dock: palette ---------- */
  /* One flat grid of twenty Bros, not four bordered class boxes. The class
     was being carried by a box — a border, a tinted panel and 11px of chrome
     around every five Bros — when each Bro's own tile was already
     tinted with it; the tile keeps the tint and takes the coloured edge the box
     used to have, and the boxes go.

     The point is not the 44px of chrome. It is that four fixed boxes could only
     ever stack, so the tray needed 313px of height whatever shape its container
     was — which is why a short window collapsed it to a sliver. A plain grid
     reflows instead: five across in a narrow column, ten across in a wide one,
     as many rows as that leaves. The class stays legible because the twenty are
     still in class order, five apiece. */
  function buildPalette() {
    const pal = $('#palette');
    pal.innerHTML = '';
    G.TOWER_ORDER.forEach((id, i) => {
      const r = Math.floor(i / 5), c = i % 5;      // five Bros per class
      const color = G.CLASSES[Object.keys(G.CLASSES)[r]].color;
      const def = G.TOWERS[id];
      const slot = el('div', 'slot');
      slot.dataset.type = id;
      /* Only the colour goes on the element. The fill itself is built from it
         in CSS, so a locked tile can drop the class tint entirely — an inline
         background wins over any stylesheet rule, and every locked Bro was
         coming out as brightly coloured as a usable one. */
      slot.style.setProperty('--cls', color);
      /* 128, not 38: the tile shows this at its full height now rather than as
         a 26px thumbnail with the price under it, and drawTowerIcon scales
         everything off the canvas width, so the bitmap has to be big enough to
         still be sharp at 117px on a 4K panel. */
      const cv = document.createElement('canvas');
      cv.width = 128; cv.height = 128;
      G.drawTowerIcon(cv, id);
      slot.appendChild(el('kbd', 'slot-key', HOTKEY_ROWS[r][c]));
      slot.appendChild(cv);
      /* No 🔩 on the tray price. A four-figure cost plus the emoji cannot
         fit a slot at the width the dock can spare, and the gold number
         already reads as a price — the tooltip and guide still spell it
         out with the icon. */
      slot.appendChild(el('span', 'slot-cost', String(UI.game.priceOf(def.cost))));
      if (G.towerNeed(UI.profile, id)) {   // tower drip: not recruited yet
        slot.classList.add('locked');
        slot.appendChild(el('span', 'slot-lock', '🔒'));
      }
      hoverTip(slot, () => showTooltip(slot, id));
      slot.addEventListener('click', () => armTower(id));
      attachTrayDrag(slot, id);
      pal.appendChild(slot);
    });
  }

  // why this Bro can't be built yet (builder rank) — null when usable
  function towerLockMsg(id) {
    const need = G.towerNeed(UI.profile, id);
    if (!need) return null;
    const short = Math.max(0, G.xpForRank(need) - (UI.profile.xp || 0));
    return `${G.TOWERS[id].name} joins the workshop at rank ${need} — ${short.toLocaleString()} more vacuums.`;
  }

  /* ---------- builder rank: XP banked from the battle, one Bro per rank ---------- */
  function bankXp() {
    const g = UI.game;
    if (!g) return;
    /* Floored, and xpBanked moves by the same whole number it paid out — an
       endless kill is a quarter of an XP, so banking the raw figure would put
       fractions on the profile and let rounding pay for kills twice. At most
       three-quarters of one XP ever sits unbanked. */
    const gained = Math.floor(g.rankXp) - g.xpBanked;
    if (gained <= 0) return;
    g.xpBanked += gained;
    const p = UI.profile;
    const before = G.rankFromXp(p.xp);
    p.xp = (p.xp || 0) + gained;
    const after = G.rankFromXp(p.xp);
    putProfile(p);
    for (let r = before + 1; r <= after; r++) {
      const id = G.unlockAtRank(r);
      sfx.win();
      banner(`⬆ Builder Rank ${r}`);
      toast(id
        ? `⬆ Rank ${r}! 🧑‍🔧 ${G.TOWERS[id].name} joins the workshop — build it right now.`
        : `⬆ Rank ${r}!`);
      if (id) buildPalette();   // the new Bro appears in the tray mid-battle
    }
    updateHud();
  }

  // "Rank 4 · 812 / 1,450" for the menu chips
  function rankChipText() {
    const pr = G.rankProgress(UI.profile.xp);
    return pr.maxed
      ? `Rank ${pr.rank} · every Bro recruited`
      : `Rank ${pr.rank} · ${(UI.profile.xp || 0).toLocaleString()} / ${pr.next.toLocaleString()} 🔌`;
  }
  function syncRankChips() {
    const pr = G.rankProgress(UI.profile.xp);
    for (const c of document.querySelectorAll('.js-rank')) c.textContent = rankChipText();
    for (const b of document.querySelectorAll('.js-rank-bar i')) {
      b.style.width = (pr.maxed ? 100 : Math.round((pr.into / pr.span) * 100)) + '%';
    }
  }

  function armTower(id) {
    const g = UI.game;
    if (!g || g.over) return;
    const lock = towerLockMsg(id);
    if (lock) { sfx.error(); toast('🔒 ' + lock, 'bad'); return; }
    const def = G.TOWERS[id];
    const cost = g.priceOf(def.cost);
    if (g.placingType === id) { g.placingType = null; syncCancelBtn(); renderDockSel(); updateHud(); return; }
    if (g.cash < cost) { sfx.error(); toast(`Need ${fmt(cost)} for a ${def.name}.`, 'bad'); return; }
    g.placingType = id;
    g.selected = null;
    syncCancelBtn();
    renderDockSel();
    updateHud();
  }

  /* ---------- tooltip ---------- */
  /* The numbers a player is shown BEFORE building anything.
     G.TOWERS[id].stats holds the design-time figures; the global nerf is
     applied inside computeEffective, so any surface quoting stats has to go
     through it or it advertises a Bro that does not exist. This bit the
     guide and this tooltip once already — both were promising 1.2/s and 150
     range for a Bro that builds at 1.02/s and 128. */
  function shopStats(typeId) {
    const s = G.computeEffective(typeId, [0, 0]);
    if (s.damage) s.damage = Math.round(s.damage * 100) / 100;
    if (s.rate) s.rate = Math.round(s.rate * 100) / 100;
    if (s.range && s.range < 5000) s.range = Math.round(s.range);
    return s;
  }

  function showTooltip(anchor, typeId) {
    const def = G.TOWERS[typeId];
    const cls = G.CLASSES[def.cls];
    const s = shopStats(typeId);
    const bits = [];
    if (s.damage) bits.push(['Damage', s.damage]);
    if (s.rate) bits.push(['Speed', s.rate + '/s']);
    if (s.range && s.range < 5000) bits.push(['Range', s.range]);
    if (s.range >= 5000) bits.push(['Range', '∞']);
    if (s.pierce > 1) bits.push(['Pierce', s.pierce]);
    if (s.income) bits.push(['Income', '🔩' + s.income + '/wave']);
    const cost = UI.game ? UI.game.priceOf(def.cost) : def.cost;
    const tip = $('#tooltip');
    tip.innerHTML = `
      <div class="tt-head"><b>${def.name}</b><span class="tt-cost">${fmt(cost)}</span></div>
      <div class="tt-cls" style="color:${cls.color}">${cls.name}${s.water === 'only' ? ' · <span style="color:#67d4f5">water only</span>' : ''}</div>
      <div class="tt-desc">${def.desc}</div>
      ${bits.length ? `<div class="tt-stats">${bits.map(([k, v]) => `<span>${k}<b>${v}</b></span>`).join('')}</div>` : ''}
      <div class="tt-key">${towerLockMsg(typeId)
        ? `🔒 ${towerLockMsg(typeId)}`
        : IS_TOUCH
          ? 'Tap to pick up, then drag onto the map to place'
          : `Press <kbd>${def.hero ? 'H' : TOWER_KEY[typeId]}</kbd> or click, then click the map`}</div>`;
    tip.style.display = 'block';
    placeTip(anchor);
  }

  /* Where a floating card goes. Anything anchored in the control column gets it
     to the LEFT of the column, level with what it describes: a card centred
     over the thing you are pointing at covers the thing you are pointing at,
     which is the one place it must not be. It lands on the map instead, which
     is the cheaper thing to hide for a moment.

     It cannot interfere with dragging a Bro out: the card is
     pointer-events:none, so it never takes a pointer, and a touch drag is
     implicitly captured by the tile that received the press, so the moves keep
     arriving there wherever the finger goes. The drag hides the card the moment
     the finger crosses into the map anyway.

     Falls back to centred-above when there is not room to the left — a narrow
     window, or an anchor that is not in the column at all. */
  function placeTip(anchor) {
    const tip = $('#tooltip');
    const r = anchor.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    const left = columnLeft();
    /* The card is position:fixed, so the window's edges are its limits — and on
       a phone the window's edges are not the safe area's. Both are folded in
       here so a card can never open under a cutout. */
    const sa = safeArea();
    const minX = 8 + sa.left, maxX = window.innerWidth - sa.right - 8;
    const clampY = (y) => Math.max(8 + sa.top, Math.min(window.innerHeight - sa.bottom - tr.height - 8, y));
    /* An upgrade row lives in the selection card on the LEFT, and the rule
       below would centre its description above the row — which put the card on
       top of the very list you are choosing from, hiding the other two paths
       while you read about one. Anything anchored in that column opens to its
       RIGHT instead, out over the map, level with the row it describes. */
    const panel = anchor.closest && anchor.closest('#selpanel');
    if (panel) {
      const pr = panel.getBoundingClientRect();
      const x = pr.right + 10;
      tip.style.left = (x + tr.width + 8 <= maxX
        ? x
        : Math.max(minX, pr.left - tr.width - 10)) + 'px';
      tip.style.top = clampY(r.top + r.height / 2 - tr.height / 2) + 'px';
      return;
    }
    if (r.left >= left - 1 && left > tr.width + 16) {
      tip.style.left = Math.max(minX, left - tr.width - 10) + 'px';
      tip.style.top = clampY(r.top + r.height / 2 - tr.height / 2) + 'px';
      return;
    }
    const x = Math.max(minX, Math.min(maxX - tr.width, r.left + r.width / 2 - tr.width / 2));
    tip.style.left = x + 'px';
    tip.style.top = clampY(r.top - tr.height - 10) + 'px';
  }
  function hideTooltip() { clearTooltipDismiss(); openUpg = null; $('#tooltip').style.display = 'none'; }

  /* Hover opens a card and the matching mouseleave closes it again. That pair
     is a mouse contract, and on a touchscreen only half of it is honoured: what
     fires there are the compatibility mouse events a browser sends at the end
     of a tap, so the card opens, and its mouseleave partner may never arrive at
     all. Tapping an upgrade was the case that stranded it — buying rebuilds the
     Bro's panel and destroys the very button the mouseleave was waiting on,
     leaving the card sitting over the battlefield with nothing able to clear it.

     So on touch the card also arms the next-tap dismiss. Arming here rather
     than at show time is what keeps dragging a Bro out of the tray intact:
     the compatibility events only fire once the finger is already up, so there
     is never a drag in flight to disturb. The long-press routes arm themselves
     at their own right moment (the tray waits for pointerup precisely so a hold
     that becomes a drag never arms) and are left alone. */
  function hoverTip(anchor, showFn) {
    anchor.addEventListener('mouseenter', () => { showFn(); if (IS_TOUCH) armTooltipDismiss(); });
    anchor.addEventListener('mouseleave', hideTooltip);
  }

  /* ---------- boosts: bought in the shop, fired from the dock ---------- */
  function buildDockPowers() {
    const box = $('#dock-powers');
    box.innerHTML = '<div class="dp-label">boosts</div>';
    const grid = el('div', 'dp-grid');
    for (const id of G.POWER_ORDER) {
      const P = G.POWERS[id];
      const b = el('button', 'dp-btn');
      b.dataset.power = id;
      b.innerHTML = `<span class="dp-icon">${P.icon}</span><span class="dp-count">0</span>`;
      b.onclick = () => usePower(id);
      hoverTip(b, () => showPowerTip(b, id));
      attachLongPress(b, () => showPowerTip(b, id));
      grid.appendChild(b);
    }
    box.appendChild(grid);
  }

  function usePower(id) {
    const g = UI.game;
    if (!g || g.over) return;
    const P = G.POWERS[id];
    const owned = UI.profile.powerInv[id] || 0;
    if (owned <= 0) {
      sfx.error();
      toast(`No ${P.name} in stock — visit the 🧱 Boost Shop on the main menu.`, 'bad');
      return;
    }
    const res = g.usePower(id);
    if (!res.ok) { sfx.error(); toast(res.msg, 'bad'); return; }
    UI.profile.powerInv[id] = owned - 1;
    putProfile(UI.profile);
    sfx.upgrade();
    toast(`${P.icon} ${P.name}! (${owned - 1} left)`);
    hideTooltip();
    updateHud();
  }

  function showPowerTip(anchor, id) {
    const P = G.POWERS[id];
    const owned = UI.profile.powerInv[id] || 0;
    const tip = $('#tooltip');
    tip.innerHTML = `
      <div class="tt-head"><b>${P.icon} ${P.name}</b><span class="tt-cost">×${owned}</span></div>
      <div class="tt-desc">${P.desc}</div>
      <div class="tt-key">${owned > 0 ? 'Click to fire it now.' : `Buy for ${P.cost} 🧱 in the Boost Shop (main menu).`}</div>`;
    tip.style.display = 'block';
    placeTip(anchor);
  }

  /* Which Bro and which of its three paths the open upgrade card is about,
     so renderDockSel can redraw the card instead of leaving it behind.

     It used to be left behind. Buying an upgrade rebuilds the selection panel
     and nothing touched the card floating beside it, so it went on describing
     the Bro you had a second ago: the tier you had just bought still marked
     as the one to buy next, at the price you had just paid, over a footer
     saying "tap the row to buy Keen Eyes" when Keen Eyes was already yours. The
     one card in the game whose whole job is to say where a path has got to was
     the one thing on screen that did not know. */
  let openUpg = null;

  /* Floating card for an upgrade path — all three tiers, what you own, what
     comes next and what it costs.

     The tier is read off the tower here rather than passed in. It used to be an
     argument, captured when the row was built, which is the other half of why
     the card went stale: even a card opened fresh was quoting whatever the
     panel knew when it last drew itself. */
  function showUpgradeTip(anchor, t, pathIdx) {
    const g = UI.game;
    const typeId = t.type;
    const def = G.TOWERS[typeId];
    const path = def.paths[pathIdx];
    const tier = (t.up && t.up[pathIdx]) || 0;
    const state = G.pathState(t.up, pathIdx);
    const price = (raw) => (g ? g.priceOf(raw) : G.scaleCost(raw, 'medium'));
    const next = state === 'open' ? path.tiers[tier] : null;
    const cost = next ? price(next.cost) : 0;
    const afford = next && g && g.cash >= cost;
    openUpg = { t, pathIdx };

    /* Every row says which of the three things it is in words — owned, next,
       locked — rather than leaving it to a 10px dot and a change of opacity.
       That dot was the only difference between a tier you had bought and one
       you had not, and at arm's length on a phone it is not a difference. */
    const rows = path.tiers.map((x, i) => {
      const owned = i < tier;
      const isNext = i === tier && state === 'open';
      const tag = owned ? '<span class="tt-tag own">owned</span>'
        : isNext ? '<span class="tt-tag next">next</span>'
          : '';
      const cap = i === 2 ? '<span class="tt-capstone">capstone</span> ' : '';
      /* No price on something already bought — the number beside a tier you own
         is the money you spent, not money you are being asked for, and the two
         read identically. */
      const money = owned ? '' : ` <span class="tt-cost">${fmt(price(x.cost))}</span>`;
      return `<div class="tt-tier ${owned ? 'own' : isNext ? 'next' : 'later'}">
        <span class="tt-tier-dot">${owned ? '✓' : isNext ? '▸' : '○'}</span>
        <span><b>${x.name}</b>${money} ${tag}<br>
        <span class="tt-tier-desc">${cap}${x.desc}</span></span></div>`;
    }).join('');

    /* The head carries the tally, because "how far along this path am I" is the
       question the card exists to answer and it should not need counting. */
    const foot = next
      ? (afford
        ? IS_TOUCH
          /* The keycap is hidden on touch, so the mouse wording came out as
             "Press  or click to buy" with a hole in it — and this is the card
             the ⓘ button exists to show, so a phone reads it far more often
             than a mouse ever did. */
          ? `Tap the row to buy <b>${next.name}</b>`
          : `Press <kbd>${['Q', 'W', 'E'][pathIdx]}</kbd> or click to buy <b>${next.name}</b>`
        : `<b>${next.name}</b> needs ${fmt(cost - (g ? g.cash : 0))} more`)
      : G.PATH_LOCK_MSG[state] || '';

    const tip = $('#tooltip');
    tip.innerHTML = `
      <div class="tt-head"><b>${path.name}</b><span class="tt-tally${tier >= 3 ? ' max' : tier ? ' has' : ''}">${tier} of ${path.tiers.length}</span></div>
      <div class="tt-cls" style="color:${def.hero ? 'var(--gold)' : G.CLASSES[def.cls].color}">${def.name} — upgrade path ${pathIdx + 1} of ${def.paths.length}</div>
      <div class="tt-tiers">${rows}</div>
      <div class="tt-key">${foot}</div>`;
    tip.style.display = 'block';
    placeTip(anchor);
  }

  /* ---------- Second Chance (paid retry after defeat) ---------- */
  function retryBattle() {
    const g = UI.game;
    if (!g || g.over !== 'lose') return;
    const D = G.DIFFICULTIES[g.diffId];
    const price = G.scaleRetry(D.retryCost);   // Rally Flags discount
    if (UI.profile.bricks < price) { sfx.error(); return; }
    if (!g.retry()) return;
    UI.profile.bricks -= price;
    putProfile(UI.profile);
    $('#auto-start').checked = false;
    show(null);
    sfx.upgrade();
    keepAwake(true); startLoop();   // the end screen released both
    G.music.play(G.music.trackForLevel(g.levelIdx));
    G.music.setTempoScale(G.tempoForWave(g.wave));
    banner(`Second chance — Wave ${g.wave}`);
    toast(`🧱 −${price} bricks. Lives restored to ${g.lives} — regroup and hold the line!`);
    updateWavePreview();
    renderDockSel();
    updateHud();
  }

  /* ---------- hero panel in the dock ---------- */
  function buildDockHero() {
    const box = $('#dock-hero');
    const g = UI.game;
    /* the panel grid puts the hero and the boosts side by side; with no hero
       the boosts take the whole row rather than leaving a hole beside them */
    if (!g || !g.heroType) {
      box.style.display = 'none'; box.innerHTML = '';
      $('#sidebar').classList.add('no-hero');
      return;
    }
    box.style.display = 'flex';
    $('#sidebar').classList.remove('no-hero');
    const H = G.HEROES[g.heroType];
    const placed = !!g.heroTower;
    /* Two different panels, because there are two different jobs. A hero can be
       placed once, so once it is on the ice the portrait is a control that
       cannot do anything: it still dragged out and the ghost still followed the
       finger, and the drop could only ever be refused. What the panel is for
       after that is the signature ability. */
    box.dataset.mode = placed ? 'power' : 'place';
    box.innerHTML = `<div class="dp-label">${placed ? H.ability.name : 'hero'}</div>`;

    if (!placed) {
      const chip = el('button', 'hero-chip');
      chip.id = 'hero-chip';
      /* 160, not 40: the chip is a portrait filling its half of the panel,
         up to 165px, and drawTowerIcon draws to the canvas's own size. */
      const cv = document.createElement('canvas');
      cv.width = 160; cv.height = 160;
      G.drawTowerIcon(cv, g.heroType);
      chip.appendChild(cv);
      chip.appendChild(el('span', 'hero-lv', ''));
      chip.onclick = () => {
        const gg = UI.game;
        if (!gg || gg.over || gg.heroTower) return;
        armTower(gg.heroType);
      };
      hoverTip(chip, () => showTooltip(chip, g.heroType));
      attachLongPress(chip, () => showTooltip(chip, g.heroType));
      attachTrayDrag(chip, g.heroType);
      box.appendChild(chip);
    }

    const ab = el('button', 'btn hero-abil' + (placed ? ' hero-power' : ' tiny'));
    ab.id = 'hero-abil';
    ab.title = `${H.ability.name} — ${H.ability.desc}`;
    ab.onclick = fireHeroAbility;
    /* No description card on this button, in either state. Once the hero is on
       the ice this is not a hero any more, it is a weapon — and holding it, or
       resting a cursor on it, opened the recruitment card for a Bro you
       have already recruited and cannot recruit again. Worse on a finger: the
       gesture for firing the ability is a press, so every hesitation on the way
       to firing it put a card over the battlefield.

       What the button does is on the button — icon, name, level and cooldown —
       and its title says the rest on a mouse. The hero's own card is a tap on
       the hero itself, out on the board, where every other Bro's card is. */
    box.appendChild(ab);
    updateDockHero();
  }

  function updateDockHero() {
    const g = UI.game;
    const box = $('#dock-hero'), ab = $('#hero-abil');
    if (!g || !g.heroType || !ab) return;
    const H = G.HEROES[g.heroType];
    const placed = !!g.heroTower;
    /* Placing the hero (or selling it) swaps which panel this is, and the swap
       has to happen here — updateHud is what runs after either. */
    if (box.dataset.mode !== (placed ? 'power' : 'place')) { buildDockHero(); return; }

    const chip = $('#hero-chip');
    if (chip) {
      const cost = g.priceOf(G.TOWERS[g.heroType].cost);
      chip.classList.toggle('armed', g.placingType === g.heroType);
      chip.classList.toggle('poor', g.cash < cost);
      chip.querySelector('.hero-lv').textContent = '🔩' + cost;
    }

    const ready = placed && g.heroLevel >= H.ability.unlock && g.time >= g.heroReadyAt && !g.over;
    if (!placed) {
      setHTML(ab, `${H.ability.icon} place your hero`);
    } else {
      const state = g.heroLevel < H.ability.unlock
        ? `unlocks at Lv ${H.ability.unlock}`
        : g.time < g.heroReadyAt
          ? `${Math.ceil(g.heroReadyAt - g.time)}s`
          : (IS_TOUCH ? 'tap to fire' : 'press H');
      setHTML(ab,
        `<span class="hp-icon">${H.ability.icon}</span>
         <span class="hp-name">${H.ability.name}</span>
         <span class="hp-state">Lv ${g.heroLevel} · ${state}</span>`);
    }
    ab.disabled = !ready;
    ab.classList.toggle('ready', ready);
  }

  function fireHeroAbility() {
    const g = UI.game;
    if (!g || g.over) return;
    const res = g.useHeroAbility();
    if (!res.ok) { sfx.error(); toast(res.msg, 'bad'); return; }
    sfx.boss();
    buzz(30);
    toast(`${G.HEROES[g.heroType].ability.icon} ${res.name}!`);
    updateDockHero();
  }

  /* ---------- Bro Guide: the workshop's field manual ---------- */
  function buildGuide(backTo) {
    const body = $('#guide-body');
    body.innerHTML = '';
    const p = UI.profile;

    // where the workshop stands, and who joins next
    const pr = G.rankProgress(p.xp);
    const nextId = pr.maxed ? null : G.unlockAtRank(pr.rank + 1);
    body.appendChild(el('div', 'gd-rank', pr.maxed
      ? `<b>Builder Rank ${pr.rank}</b> — every Bro has been recruited.`
      : `<b>Builder Rank ${pr.rank}</b> · ${(p.xp || 0).toLocaleString()} / ${pr.next.toLocaleString()} vacuums` +
        (nextId ? ` — <b>${G.TOWERS[nextId].name}</b> joins at rank ${pr.rank + 1}, ${(pr.next - (p.xp || 0)).toLocaleString()} to go.` : '')));

    /* The rule of two, once, above the roster — it governs every card below it
       and repeating it twenty times would be worse than saying it here. */
    body.appendChild(el('div', 'gd-rule',
      `<b>Three paths, choose two.</b> Every Bro has three upgrade paths, and studs may go into
       only <b>two</b> of them — buying into a second path shuts the third for the rest of the battle.
       One of your two may run all the way to its <b>capstone</b> (tier 3); the other stops at tier 2.
       Tiers 1 and 2 sharpen the numbers. Every capstone changes how the Bro plays.`));

    // one section per class, every tower with all three upgrade paths
    for (const clsKey of Object.keys(G.CLASSES)) {
      const cls = G.CLASSES[clsKey];
      const sec = el('div', 'gd-sec');
      sec.appendChild(el('div', 'gd-sec-head',
        `<span class="gd-sec-name" style="color:${cls.color}">${cls.name}</span><span class="gd-sec-desc">${cls.desc}</span>`));
      for (const id of G.TOWER_ORDER.filter((t) => G.TOWERS[t].cls === clsKey)) {
        const def = G.TOWERS[id];
        const s = shopStats(id);
        const need = G.towerNeed(p, id);
        const card = el('div', 'gd-card');
        const cv = document.createElement('canvas');
        cv.width = 44; cv.height = 44;
        G.drawTowerIcon(cv, id);
        const bits = [];
        if (s.damage) bits.push(`⚔ ${s.damage}`);
        if (s.rate) bits.push(`⚡ ${s.rate}/s`);
        if (s.range) bits.push(`◎ ${s.range >= 5000 ? '∞' : s.range}`);
        if (s.pierce > 1) bits.push(`pierce ${s.pierce}`);
        if (s.splash) bits.push(`splash ${s.splash}`);
        if (s.income) bits.push(`+🔩${s.income}/wave`);
        if (s.stealth) bits.push('sees stealth');
        if (s.water === 'only') bits.push('water only');
        const head = el('div', 'gd-head');
        head.appendChild(cv);
        head.appendChild(el('div', '', `
          <div class="gd-name" style="color:${cls.color}">${def.name}
            <span class="gd-cost">🔩${def.cost}</span>
            ${need ? `<span class="gd-lock">🔒 recruited at rank ${need}</span>` : ''}</div>
          <div class="gd-stats">${bits.join(' · ')}</div>
          <div class="gd-desc">${def.desc}</div>`));
        card.appendChild(head);
        const paths = el('div', 'gd-paths');
        for (const path of def.paths) {
          const col = el('div', 'gd-path');
          col.appendChild(el('div', 'gd-path-name', path.name));
          path.tiers.forEach((t, i) => {
            const cap = i === 2 ? '<span class="tt-capstone">capstone</span> ' : '';
            col.appendChild(el('div', 'gd-tier' + (i === 2 ? ' cap' : ''),
              `<b>${t.name}</b> <span class="gd-cost">🔩${t.cost.toLocaleString()}</span><br><span class="gd-tier-desc">${cap}${t.desc}</span>`));
          });
          paths.appendChild(col);
        }
        card.appendChild(paths);
        sec.appendChild(card);
      }
      body.appendChild(sec);
    }

    // heroes
    const hsec = el('div', 'gd-sec');
    hsec.appendChild(el('div', 'gd-sec-head',
      `<span class="gd-sec-name" style="color:var(--gold)">⭐ Heroes</span><span class="gd-sec-desc">One per battle. They level up on vacuums felled while they stand on the field — to level ${G.HERO_MAX_LEVEL} — and hit as hard as the pack is tough.</span>`));
    for (const id of G.HERO_ORDER) {
      const def = G.TOWERS[id];
      const H = G.HEROES[id];
      const card = el('div', 'gd-card');
      const cv = document.createElement('canvas');
      cv.width = 44; cv.height = 44;
      G.drawTowerIcon(cv, id);
      const head = el('div', 'gd-head');
      head.appendChild(cv);
      head.appendChild(el('div', '', `
        <div class="gd-name" style="color:var(--gold)">${def.name}
          <span class="gd-cost">${H.bricks ? H.bricks.toLocaleString() + ' 🧱 to recruit' : 'free'} · 🔩${def.cost} to place</span></div>
        <div class="gd-stats">${H.blurb}</div>
        <div class="gd-desc">${H.ability.icon} <b>${H.ability.name}</b> (level ${H.ability.unlock}, recharges ${H.ability.cd}s) — ${H.ability.desc}</div>`));
      card.appendChild(head);
      hsec.appendChild(card);
    }
    body.appendChild(hsec);

    // the enemy roster
    const esec = el('div', 'gd-sec');
    esec.appendChild(el('div', 'gd-sec-head',
      `<span class="gd-sec-name">🔌 The Vacuums</span><span class="gd-sec-desc">Bigger ones break apart into smaller ones — a wave isn't over until the last handheld is down.</span>`));
    const egrid = el('div', 'gd-enemies');
    for (const id of G.ENEMY_ORDER.filter((x) => !G.ENEMIES[x].heavy)) {
      const e = G.ENEMIES[id];
      const traits = [];
      if (e.speed >= 120) traits.push('fast');
      if (e.stealth) traits.push('stealth — needs detection');
      if (e.armor) traits.push(`armor ${e.armor}`);
      if (e.regen) traits.push(`regenerates ${e.regen}/s`);
      if (e.boss) traits.push('BOSS');
      egrid.appendChild(el('div', 'gd-enemy' + (e.boss ? ' boss' : ''), `
        <span class="gd-dot" style="background:${e.color}"></span>
        <div><div class="gd-ename">${e.name} <span class="gd-cost">${e.hp} hp · ${e.lives} ♥ if it leaks · 🔩${e.bounty}</span></div>
        <div class="gd-etraits">${traits.length ? traits.join(' · ') + ' · ' : ''}${e.children.length ? 'splits into ' + e.children.map((c) => G.ENEMIES[c].name).join(' + ') : 'the smallest — just pops'}</div></div>`));
    }
    esec.appendChild(egrid);
    body.appendChild(esec);

    // the heavies — deep endless only
    const osec = el('div', 'gd-sec');
    osec.appendChild(el('div', 'gd-sec-head',
      `<span class="gd-sec-name" style="color:#7fd4f0">🐋 The Heavies</span>` +
      `<span class="gd-sec-desc">From Endless wave ${G.HEAVY_WAVE} the board comes apart and the heavies arrive. They never split — and any ordinary vacuum that rolls into one is swallowed, healing it. Clear the pack fast or you are feeding them.</span>`));
    const ogrid = el('div', 'gd-enemies');
    for (const id of G.HEAVY_ORDER) {
      const e = G.ENEMIES[id];
      const traits = [`armor ${e.armor}`, `heals ${Math.round(e.eat * 100)}% per vacuum eaten`];
      if (e.boss) traits.push('SUPER BOSS — Endless wave 100');
      ogrid.appendChild(el('div', 'gd-enemy' + (e.boss ? ' boss' : ''), `
        <span class="gd-dot" style="background:${e.color}"></span>
        <div><div class="gd-ename">${e.name} <span class="gd-cost">${e.hp.toLocaleString()} hp · ${e.lives} ♥ if it leaks · 🔩${e.bounty.toLocaleString()}</span></div>
        <div class="gd-etraits">${traits.join(' · ')}</div></div>`));
    }
    osec.appendChild(ogrid);
    body.appendChild(osec);

    $('#btn-guide-back').onclick = () => show(backTo);
    show('#screen-guide');
  }

  /* ---------- Workshop Upgrades: permanent pebble-bought perks ---------- */
  function buildWorkshop(backTo) {
    const grid = $('#workshop-grid');
    grid.innerHTML = '';
    for (const id of G.WORKSHOP_ORDER) {
      const C = G.WORKSHOP[id];
      const tier = UI.profile.workshop[id] || 0;
      const maxed = tier >= C.tiers.length;
      const next = maxed ? null : C.tiers[tier];
      const afford = next && UI.profile.bricks >= next.cost;
      const pips = C.tiers.map((t, i) =>
        `<span class="cu-pip${i < tier ? ' on' : ''}" title="Tier ${i + 1}: ${C.fmt(t.v)}"></span>`).join('');
      const card = el('div', 'shop-card');
      card.innerHTML = `
        <div class="shop-icon">${C.icon}</div>
        <div class="shop-name">${C.name} <span class="cu-pips">${pips}</span></div>
        <div class="shop-desc">${C.desc}</div>
        <div class="cu-now">${tier ? '✓ now: ' + C.fmt(C.tiers[tier - 1].v) : ' '}</div>
        <div class="shop-row">
          <span class="shop-owned">${maxed ? '★ fully upgraded' : 'next: ' + C.fmt(next.v)}</span>
          ${maxed ? '' : `<button class="btn small${afford ? ' primary' : ''}" ${afford ? '' : 'disabled'}>Buy · ${next.cost.toLocaleString()} 🧱</button>`}
        </div>`;
      if (!maxed) {
        card.querySelector('button').onclick = () => {
          if (UI.profile.bricks < next.cost) { sfx.error(); return; }
          UI.profile.bricks -= next.cost;
          UI.profile.workshop[id] = tier + 1;
          G.applyWorkshop(UI.profile.workshop);
          putProfile(UI.profile);
          sfx.upgrade();
          toast(`${C.icon} ${C.name} — ${C.fmt(next.v)}, in every battle from now on.`);
          buildWorkshop(backTo);
        };
      }
      grid.appendChild(card);
    }
    $('#btn-workshop-back').onclick = () => show(backTo);
    show('#screen-workshop');
  }

  /* ---------- Endless Shift (keep playing after victory) ---------- */
  function keepGoing() {
    const g = UI.game;
    if (!g || !g.goEndless()) return;
    $('#auto-start').checked = false;
    show(null);
    sfx.wave();
    keepAwake(true); startLoop();   // the end screen released both
    G.music.play(G.music.trackForLevel(g.levelIdx));
    G.music.setTempoScale(G.tempoForWave(g.wave));
    banner(`🔁 The Endless Shift — Wave ${g.wave}`);
    toast('Victory is banked — now hold as long as you can. Every 10th wave pays 🧱 bricks.');
    updateWavePreview();
    renderDockSel();
    updateHud();
  }

  /* ---------- boost shop ---------- */
  function buildShop(backTo) {
    const grid = $('#shop-grid');
    grid.innerHTML = '';
    for (const id of G.POWER_ORDER) {
      const P = G.POWERS[id];
      const owned = UI.profile.powerInv[id] || 0;
      const afford = UI.profile.bricks >= P.cost;
      const card = el('div', 'shop-card');
      card.innerHTML = `
        <div class="shop-icon">${P.icon}</div>
        <div class="shop-name">${P.name}</div>
        <div class="shop-desc">${P.desc}</div>
        <div class="shop-row">
          <span class="shop-owned" title="How many you own">×${owned}</span>
          <button class="btn small${afford ? ' primary' : ''}" ${afford ? '' : 'disabled'}>Buy · ${P.cost} 🧱</button>
        </div>`;
      card.querySelector('button').onclick = () => {
        if (UI.profile.bricks < P.cost) { sfx.error(); return; }
        UI.profile.bricks -= P.cost;
        UI.profile.powerInv[id] = (UI.profile.powerInv[id] || 0) + 1;
        putProfile(UI.profile);
        sfx.upgrade();
        toast(`${P.icon} ${P.name} purchased — ×${UI.profile.powerInv[id]} in stock.`);
        buildShop(backTo);
      };
      grid.appendChild(card);
    }
    $('#btn-shop-back').onclick = () => show(backTo || '#screen-menu');
    show('#screen-shop');
  }

  /* ---------- "are you sure" ----------
     One card, reused. It answers by calling back rather than by returning a
     promise so that nothing in the game has to become async to ask a question.

     Every way out closes it: the button, Cancel, the scrim, Escape. Closing is
     always the safe answer — a dialog that cannot be dismissed is a dialog that
     eventually gets tapped through. */
  let confirmYes = null, confirmAbout = null;
  /* While a question is up, the card it is about is not live.

     #confirm is absolute inside #stage — it is the MAP's scrim — and that used
     to be enough, because the card floated over the map too: the scrim covered
     it, dimmed it and swallowed its taps. The card sits in the control column
     now, outside the stage's box, so the scrim no longer reaches it and the
     card was left fully tappable behind a dialog asking whether to destroy the
     Bro it describes. Buying an upgrade from it while "Sell this?" was on
     screen left the dialog quoting a refund that was no longer the one it would
     pay: it said "Sell +102" and paid 168.

     The keyboard has always been guarded this way — the keydown handler returns
     while #confirm is open, so Q/W/E cannot buy either — so this is the same
     rule for a finger rather than a new one. A class on #app rather than moving
     the dialog, because where the dialog appears is not what went wrong. */
  function setConfirming(on) {
    $('#app').classList.toggle('confirming', !!on);
  }
  function closeConfirm() {
    confirmYes = confirmAbout = null;
    $('#confirm').hidden = true;
    setConfirming(false);
  }
  /* `about` is what the question concerns — a tower, so far. The panel closes
     the dialog when it rebuilds for a DIFFERENT Bro and leaves it alone
     otherwise. Closing on every rebuild was the first attempt and it took the
     question away for reasons that have nothing to do with it: the selection
     poll runs at 0.3s and fires on any change to what is in hand, so placing a
     Bro and selling one in quick succession dismissed the dialog by
     itself. */
  function askConfirm(title, body, yesLabel, onYes, about) {
    confirmYes = onYes;
    confirmAbout = about || null;
    setHTML($('#cf-title'), title);
    setHTML($('#cf-body'), body);
    setHTML($('#cf-yes'), yesLabel);
    hideTooltip();          // one thing floating over the map at a time
    $('#confirm').hidden = false;
    setConfirming(true);
  }
  function wireConfirm() {
    $('#cf-no').onclick = closeConfirm;
    $('#cf-yes').onclick = () => {
      const go = confirmYes;
      closeConfirm();
      if (go) go();
    };
    /* The scrim, but only the scrim. currentTarget would fire for a press that
       began on the card and drifted out onto the backdrop, which is a slip, not
       an answer. */
    $('#confirm').onclick = (ev) => { if (ev.target === $('#confirm')) closeConfirm(); };
  }

  /* ---------- command dock: selection card ---------- */
  /* The card takes the control column's own slot rather than floating over the
     battlefield.

     It used to open down the left of the map, which meant that reading a
     Bro's upgrades cost you 178px of the thing you were reading them about
     — a quarter of the battlefield on a phone — and put the card in the one
     place an iPhone's Dynamic Island also wants. Here it covers nothing: the
     tray and the hero and boost panels step aside for it and step back when it
     closes, and the battlefield is never touched.

     It takes the column down as far as the WAVE CONTROLS and stops there.

     Three things live in that column under the tray: the hero chip, the six
     boosts, and the row with Send Wave, the speed toggle, pause and auto. The
     first two step aside for the card. The last does not, ever. Sending the
     next wave, changing speed and pausing are not things to make a player close
     a card to reach — pause especially, which is the one control you want when
     you have stopped to read something and the battle has not stopped with you.

     That is 325px on a phone in landscape, against 238 for the tray's row alone
     and 382 for the whole column. 238 was not enough to hold three upgrade rows
     and say what any of them did; 325 is, and it does not cost the wave
     controls to get there.

     The bottom edge comes from #command's rect rather than from a grid row,
     because #command is inside #sidebar and #sidebar is scaled — its laid-out
     box and the box on screen are different by a factor of about 0.39, and the
     one the card has to stop above is the one on screen. The scale is static,
     so the rect is stable to read. Everything else is offsets: the tray's own
     box is untransformed and reads correctly that way.

     A column that measures near nothing is a layout that has not settled —
     mid-rotation, entering fullscreen, an installed app being restored — and
     writing that rect would pin the card to a sliver. Left alone instead, and
     the card keeps whatever box it had. */
  /* Between the card's foot and the wave controls. Two, not four: the card is
     within a few pixels of holding three rows without scrolling at the size
     this is played at, and a gap is the cheapest place to find them. The two
     panels still read as separate — they have their own edges. */
  const CARD_GAP = 2;
  function fitSelPanel(box) {
    const tray = $('#palette');
    if (!tray || tray.offsetWidth < 40 || tray.offsetHeight < 40) return;
    const par = tray.offsetParent;
    const px = par ? par.getBoundingClientRect() : { left: 0, top: 0 };
    const top = px.top + tray.offsetTop;
    /* Down to the wave controls, or to the foot of the tray if they are not
       there to measure — which is every layout where the dock is not playing,
       and the first frame of one that is. */
    const cmd = $('#command');
    const cr = cmd ? cmd.getBoundingClientRect() : null;
    const foot = cr && cr.height > 10 && cr.top > top + 120
      ? cr.top - CARD_GAP
      : top + tray.offsetHeight;
    box.style.left = Math.round(px.left + tray.offsetLeft) + 'px';
    box.style.top = Math.round(top) + 'px';
    box.style.width = Math.round(tray.offsetWidth) + 'px';
    box.style.height = Math.round(foot - top) + 'px';
  }

  /* visibility, not display. Taking the panels out of the flow would collapse
     the rows they define, which are the rows the card was just measured
     against. Hidden in place they hold their boxes and nothing moves — and the
     wave controls, which are not hidden, do not shift under a thumb that is
     already on its way to them. */
  function showDock(on) {
    $('#app').classList.toggle('upg-open', !on);
  }

  function renderDockSel() {
    const g = UI.game;
    const box = $('#selpanel');
    if (!g) return;
    /* Tell the 0.3s poll what the card is now showing. The poll redraws when
       g.selected differs from what it last saw, and it does not run while the
       game is paused — so a menu that cleared the selection left the poll still
       remembering the old Bro, and re-selecting that same Bro after
       resuming looked like no change at all and drew nothing. Every route that
       redraws the card comes through here, so this is the one place the two can
       be kept in step. */
    lastSelected = g.selected;
    // a question about a Bro you are no longer looking at is not a question
    if (confirmAbout && confirmAbout !== g.selected) closeConfirm();

    /* Closed is the resting state. The old card lived in the column and so was
       always on screen saying something, which is why it had to be a fixed
       height and why its contents were squeezed to fit. Out here it can simply
       not be there, and take whatever room it needs when it is.

       Closed while PLACING, too. The card opened during placement to say the
       Bro's name and repeat two keyboard hints, which was tolerable when it
       was a small box and absurd once it became a full-height column: a third
       of the battlefield went dark at exactly the moment you were trying to
       read the battlefield and choose a spot on it. #place-hint carries that
       line along the bottom of the map now (see syncCancelBtn). */
    if (!g.selected) {
      box.hidden = true;
      box.innerHTML = '';
      showDock(true);
      return;
    }
    box.hidden = false;
    fitSelPanel(box);
    showDock(false);

    const t = g.selected;

    const def = G.TOWERS[t.type];
    const color = def.hero ? '#ffd166' : G.CLASSES[def.cls].color;
    const c = t.calc;
    box.innerHTML = '';

    const head = el('div', 'ds-head');
    /* 256, not 40: on a tall column the head becomes a portrait and this is
       drawn at up to 118px, which is 236 real pixels on a 2× screen.
       drawTowerIcon draws to whatever size the canvas is, so this number is the
       only thing standing between a big portrait and a soft one. */
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 256;
    G.drawTowerIcon(cv, t.type, t.up);
    head.appendChild(cv);
    const stats = [];
    if (c.damage) {
      const d = c.damage * t.buff.dmg;
      stats.push(`⚔ ${d < 10000 ? Math.round(d * 10) / 10 : short(d)}`);
    }
    if (c.rate) stats.push(`⚡ ${Math.round(c.rate * t.buff.rate * 100) / 100}/s`);
    // ∞ rather than nothing for the map-wide reaches (Laser Sniper, Gunner
    // Rook) — an absent range chip read as "this one has no range at all"
    if (c.range) stats.push(`◎ ${c.range >= 5000 ? '∞' : Math.round(c.range * t.buff.range)}`);
    /* A vendor's headline number is what it will ACTUALLY pay next wave, not
       its sticker income — with other vendors on the map those differ, and the
       gap is the whole thing a player needs to see before buying another. */
    const vpay = c.income ? g.vendorPayouts().find((p) => p.tower === t) : null;
    if (vpay) {
      const all = g.vendorPayouts();
      stats.push(`+${fmt(vpay.got)}/w`);
      /* The falloff rides on the stat line, right beside the number it
         explains, rather than as a row of its own. The card's height is fixed
         and a vendor already spends it on a head, two upgrade buttons and an
         action row — a fourth row pushed the sell button out of the card. */
      if (all.length > 1) stats.push(`<span class="ds-rank">stall ${vpay.rank}/${all.length} · ${Math.round(vpay.share * 100)}%</span>`);
    }
    // ☠ only where it can ever be non-zero — vendors and aura towers never shoot
    if (!['income', 'aura'].includes(c.kind))
      stats.push(`<span title="Vacuums destroyed by this Bro">☠ <b class="ds-kills">${short(t.kills || 0)}</b></span>`);
    /* The name sits beside the portrait and the stats run full width beneath
       both. In a column this narrow, name and stats side by side left each of
       them 33px — the name came out as "Pe…" and the stat line was invisible. */
    head.appendChild(el('div', 'ds-title', `<div class="ds-name" style="color:${color}">${def.name}${def.hero ? ` · <span class="hero-tag">★ Lv ${g.heroLevel}</span>` : ''}</div>`));
    /* An explicit way out. Tapping the map closes the panel too, but on a phone
       the map is mostly covered by the thing you are trying to dismiss. */
    const shut = el('button', 'ds-close', '✕');
    shut.title = 'Close (Esc)';
    shut.onclick = () => { g.selected = null; renderDockSel(); };
    head.appendChild(shut);
    head.appendChild(el('div', 'ds-stats', stats.join(' · ')));
    box.appendChild(head);

    /* The falloff has to be explained somewhere, and the stat line has room
       only for the headline. The long version hangs off the whole stat line as
       a tooltip — you buy a second stall, the wave payout barely moves, and
       this is what connects the two. */
    if (vpay) {
      const all = g.vendorPayouts();
      const statsEl = head.querySelector('.ds-stats');
      if (all.length > 1) {
        statsEl.title = c.noFalloff && vpay.rank > 1
          ? `A Krill Konglomerate refuses to be undercut. This is stall ${vpay.rank} of ${all.length}, but it still sells at full price: ${fmt(vpay.got)} every wave, whatever stands above it.`
          : vpay.rank === 1
          ? `The richest stall sells at full price. Every further vendor earns ${Math.round((1 - G.VENDOR_FALLOFF) * 100)}% less than the one above it — a second is worth 70% of this one, a third 49%.`
          : `Vendors undercut each other. This is stall ${vpay.rank} of ${all.length}, so it earns ${Math.round(vpay.share * 100)}% of full price: ${fmt(vpay.full)} becomes ${fmt(vpay.got)} each wave.`;
      } else {
        statsEl.title = `Pays ${fmt(vpay.got)} at the end of every wave. Build a second vendor and it earns only ${Math.round(G.VENDOR_FALLOFF * 100)}% of what this one does — the market only bears so many stalls.`;
      }
    }

    if (def.hero) {
      const H = G.HEROES[t.type];
      /* Show the actual count and what it is counting toward. A level that
         arrives on a hidden threshold feels arbitrary; a number you watch
         climb is the whole appeal of levelling on kills.

         The top two lines are the live ones and stay single lines: they are a
         number, a bar and a hotkey, and they have to survive a card only 322px
         tall on a phone. Underneath them, .hn-more says what this champion is
         FOR and what the ability actually does — the same words that were only
         in the hover tooltip. It is hidden until the column has the height to
         spare, exactly like the upgrade rows' tier ladder, because the reason
         it was cut was never that it wasn't worth reading. On a desktop this
         card was two lines of text in a 654px column: 65% of it was empty. */
      const prog = G.heroProgress(g.heroKills);
      const xpLine = prog
        ? `<b>${num(prog.into)}</b> / ${num(prog.need)} vacuums to Lv ${prog.next}` +
          `<span class="hero-xp"><i style="width:${Math.round((prog.into / prog.need) * 100)}%"></i></span>`
        : `<b>Level ${G.HERO_MAX_LEVEL}</b> — fully grown`;
      const abil = g.heroLevel < H.ability.unlock
        ? `${H.ability.icon} ${H.ability.name} · <b>Lv ${H.ability.unlock}</b>`
        : `${H.ability.icon} <b>${H.ability.name}</b> · <kbd>H</kbd>`;
      const note = el('div', 'ds-hero-note',
        `<span class="hn-line">${xpLine}</span><span class="hn-line">${abil}</span>` +
        `<span class="hn-more"><span class="hn-blurb">${H.blurb}</span>` +
        `<span class="hn-abil">${H.ability.icon} ${H.ability.desc}</span></span>`);
      note.title = (prog
        ? `${num(prog.into)} of ${num(prog.need)} vacuums toward Level ${prog.next}. Heroes level on vacuums felled while they stand on the field, and each level costs more than the last.`
        : `Level ${G.HERO_MAX_LEVEL} is the ceiling. Damage still rises with the pack's strength on deeper waves.`) +
        (g.heroLevel < H.ability.unlock
          ? ` ${H.ability.name} unlocks at level ${H.ability.unlock}.`
          : ` ${H.ability.name}: fire it from the hero panel or press H.`);
      box.appendChild(note);
      const act0 = el('div', 'ds-actions');
      const tgt0 = el('button', 'btn tiny', `<kbd>T</kbd> ${t.target}`);
      tgt0.title = 'Cycle targeting: first / last / strong / close';
      tgt0.onclick = () => cycleTarget();
      act0.appendChild(tgt0);
      box.appendChild(act0);
      box.appendChild(makeSellButton(t));
      return;
    }

    /* One narrow column, the same width as the build tray on the right — three
       rows, one per path, and nothing else.

       Three paths printed in full did not fit anywhere. Laid out as three
       columns it was 430px on a phone in landscape, which is 51% of the screen:
       the card covered the battlefield it was describing. Stacked it was 867px
       tall in a 613px window. Both were the same mistake — trying to print
       eighteen upgrade descriptions next to a game you are meant to be
       watching.

       So a row says only what you need to DECIDE: which path, how far along it
       you are, what comes next and what it costs. What an upgrade actually does
       is a hover away on a mouse and a long-press away on a finger — the card
       that opens is showUpgradeTip, which lays out the whole path with the tier
       you are about to buy picked out, and which the game already had. */
    const upgRow = el('div', 'ds-upgs');
    const chosen = t.up.filter((v) => v > 0).length;
    /* Which path's card was open before this rebuild, if it was this Bro's.
       Read now, because building the rows is what destroys the element the card
       was anchored to. */
    const reopen = openUpg && openUpg.t === t ? openUpg.pathIdx : null;
    let reopenInfo = null;
    for (let p = 0; p < def.paths.length; p++) {
      const path = def.paths[p];
      const tier = t.up[p];
      const key = ['Q', 'W', 'E'][p];
      const state = G.pathState(t.up, p);

      /* Two lines, never three — but the SAME two lines in every state, which
         they were not. An open path printed a keycap, a name and a price; a
         shut one printed a padlock and a sentence in a smaller face; and a
         path you had already bought into looked exactly like one you had not,
         because the only thing separating them was which of three 5px dots
         were tinted. So after your first upgrade the card stopped answering
         the two questions it exists to answer: how far along am I, and can I
         still go further.

         One skeleton now. Line one is the path name and how many of its three
         tiers you own, as a number in a chip — with the padlock or the star in
         the chip too, because line two is only about 105px wide once the ⓘ and
         the price have had their share, and a leading glyph there took enough
         off it to clip "Rolling Thunder" to "Rolling Thun…". Line two is
         always a label and an optional value: what you would buy next and what
         it costs, or why you cannot buy anything. And a path you have studs in
         wears a green edge — gold once it is finished — so which two you
         committed to reads at a glance without counting anything.

         Three lines now, not two. The card moved into the control column,
         which is about 30px narrower than the width the rows were tuned to —
         and what pays for that is the ⓘ button, which took 41px out of every
         row and is gone. Losing it leaves the name MORE room than it had, and
         the description it used to hide comes back into the row itself, which
         is what the column's spare height is for. Nothing is now a tap away
         that used to be on screen. */
      const shutMark = state === 'mastered' ? '★' : state === 'open' ? '' : '🔒';
      const owned = `<span class="dsp-tally${tier >= 3 ? ' max' : tier ? ' has' : ''}">` +
        `${shutMark ? `<i>${shutMark}</i>` : ''}${tier}/${path.tiers.length}</span>`;
      const head = `<span class="dsp-head">
             <span class="dsp-name">${path.name}</span>
             ${owned}
           </span>`;

      let row;
      if (state === 'open') {
        const u = path.tiers[tier];
        const uCost = g.priceOf(u.cost);
        row = el('button', 'ds-path open' + (tier ? ' owned' : '') + (g.cash < uCost ? ' poor' : ' can'),
          `${head}
           <span class="dsp-next"><kbd>${key}</kbd> <span class="dsp-up">${u.name}</span>
             <span class="dsp-cost" title="${fmt(uCost)}">${num(uCost)}</span></span>
           <span class="dsp-desc">${u.desc}</span>
           ${ladder(path, tier)}`);
        row.dataset.cost = uCost;   // updateHud re-checks this as studs come in
        /* The one purchase that cannot be taken back: buying into a second path
           is what shuts the third. Said on the button that does it, before the
           press, rather than discovered afterwards from a greyed-out row. */
        if (!tier && chosen === G.PATH_LIMIT - 1) row.classList.add('commits');
        row.onclick = () => buyUpgrade(t, p);
      } else {
        const why = state === 'mastered' ? 'Path mastered'
          : state === 'locked' ? 'Two paths chosen'
          : 'Capstone spent';
        row = el('div', 'ds-path shut' + (tier ? ' owned' : '') + (state === 'mastered' ? ' done' : ''),
          `${head}
           <span class="dsp-next"><span class="dsp-up">${why}</span></span>
           ${ladder(path, tier)}`);
        row.title = G.PATH_LOCK_MSG[state] || '';
      }
      /* The whole path — all three tiers, what each one does, what you own and
         what is still ahead — on a hover, a hold, and a button that says so. */
      const openInfo = () => showUpgradeTip(row, t, p);
      hoverTip(row, openInfo);
      attachLongPress(row, openInfo);
      /* The card was open on this path when the panel was rebuilt, so redraw it
         against the row that replaced the one it was anchored to. Buying is the
         case: the panel rebuilds under a card that is still describing the tier
         you just bought, which is exactly the moment the card has something new
         to say. */
      if (reopen === p) reopenInfo = openInfo;

      /* On a finger the path card gets a control of its own. Long-press was the
         only way in and nobody found it: nothing on screen says a row can be
         held, and the row's obvious gesture — a tap — spends studs. So the row
         and the ⓘ are siblings rather than one inside the other, which keeps
         them separate targets: a tap on the row still buys, and a tap on the ⓘ
         can never be a mis-buy.

         Hidden on a mouse, where hovering the row already opens the same card
         and a third control per row would be furniture. */
      const prow = el('div', 'ds-prow');
      prow.appendChild(row);
      const info = el('button', 'ds-info', ICON_INFO);
      info.setAttribute('aria-label', `What ${path.name} does`);
      info.title = `What ${path.name} does`;
      info.onclick = (ev) => { ev.stopPropagation(); openInfo(); armTooltipDismiss(); };
      prow.appendChild(info);
      upgRow.appendChild(prow);
    }
    box.appendChild(upgRow);

    /* Targeting and selling share the bottom row. Stacked they were two 42px
       rows plus a gap in a column that has about 320px to give on a phone in
       landscape, and the sell button was the thing pushed off the bottom. */
    const act = el('div', 'ds-actions');
    if (!['income', 'aura', 'spikes', 'pulse'].includes(c.kind)) {
      const tgt = el('button', 'btn tiny ds-target', `<kbd>T</kbd> ${t.target}`);
      tgt.title = 'Cycle targeting: first / last / strong / close';
      tgt.onclick = () => cycleTarget();
      act.appendChild(tgt);
    }
    act.appendChild(makeSellButton(t));
    box.appendChild(act);

    /* Last, once the rows are in the document with real positions: the hover
       card is placed relative to the row it describes, and a row that has not
       been laid out yet reports a zero rectangle. */
    if (reopenInfo) reopenInfo();
  }

  /* Selling is destructive, refunds only 70% and has no undo, and it used to be
     a 10px-tall button one pixel beneath the upgrade you were aiming for — that
     is how Bros got sold by accident. It gets its own row at the bottom of
     the panel now, well clear of anything else, and it asks first.

     It used to ask in place: one press turned the button red and said "Sell?",
     a second press sold, and after three seconds it forgot. The red never
     arrived on the device the whole confirmation exists for. iOS leaves :hover
     stuck on whatever was last tapped, and .btn:hover is written after
     .sell-btn.armed at the same specificity — so on a phone the armed button
     kept the ordinary grey fill and picked up the armed state's near-black
     text, which is what a disabled button looks like. Pressing sell appeared to
     do nothing, and there was no way to find out that pressing it again would
     empty the tile.

     So it asks in a dialog, where a question can be a question and neither
     answer depends on a colour landing. The X hotkey is still a direct sell,
     because a deliberate keypress is not a mistap. */
  function makeSellButton(t) {
    /* No studs glyph and no middot on the label. It shares the bottom row with
       the targeting button in a column about 143px wide, and spelled out in
       full it clipped to "Sel". The refund is gold, which reads as studs
       everywhere else in the game, and the dialog has the room to say it
       properly. */
    const sell = el('button', 'btn sell-btn', `<kbd>X</kbd> Sell <b>+${num(t.invested * G.SELL_RATE)}</b>`);
    sell.onclick = () => confirmSell(t);
    return sell;
  }

  /* Named, and the number spelled out in full. "Sell?" next to a figure was the
     old inline confirm and it told you neither which Bro was about to go
     nor that the refund is only seven tenths of what you put in. */
  function confirmSell(t) {
    const g = UI.game;
    if (!g || !t) return;
    const def = G.TOWERS[t.type];
    const refund = Math.round(t.invested * G.SELL_RATE);
    askConfirm(
      `Sell ${def.name}?`,
      `It leaves the ice for good. You get back <b>${fmt(refund)}</b> of the ${fmt(t.invested)} you put in.`,
      `Sell +${num(refund)}`,
      () => sellSelected(),
      t);
  }

  /* Where the path GOES — the three tier names, nothing else. It is what the
     column's spare height is for: on a tall window you can read the shape of
     all three paths at once without opening anything, and on a short one the
     container query hides it and the rows stay as they were. Names only. The
     descriptions are what made this card cover half the screen, and they stay
     in the hover card where there is room for them. */
  function ladder(path, tier) {
    const rows = path.tiers.map((x, i) => {
      const mark = i < tier ? '✓' : i === tier ? '▸' : '·';
      const st = i < tier ? 'own' : i === tier ? 'next' : 'later';
      return `<span class="dsp-tier ${st}"><i>${mark}</i>${x.name}</span>`;
    }).join('');
    return `<span class="dsp-tiers">${rows}</span>`;
  }

  function buyUpgrade(t, p) {
    const g = UI.game;
    const res = g.buyUpgrade(t, p);
    if (res.ok) sfx.upgrade();
    else { sfx.error(); toast(res.msg, 'bad'); }
    renderDockSel(); updateHud();
  }
  function cycleTarget() {
    const t = UI.game && UI.game.selected;
    if (!t) return;
    const modes = ['first', 'last', 'strong', 'close'];
    t.target = modes[(modes.indexOf(t.target) + 1) % modes.length];
    renderDockSel();
  }
  function sellSelected() {
    const g = UI.game;
    const t = g && g.selected;
    if (!t) return;
    const refund = g.sellTower(t);
    sfx.sell();
    toast(`Sold for ${fmt(refund)}.`);
    renderDockSel(); updateHud();
  }
  function trySend() {
    const g = UI.game;
    if (g && !g.waveInProgress && !g.over) { g.startWave(); updateHud(); }
  }
  /* Single door for pausing, so the music can never disagree with the game.
     There are three ways to pause — the dock button, the P key, and the Esc
     menu — and the bed has to stop for all of them. */
  function setPaused(paused) {
    const g = UI.game;
    if (!g) return;
    g.paused = !!paused;
    G.music.setPaused(g.paused);
    updateHud();
    // unpausing is one of the two things that can wake a stopped frame loop
    if (!g.paused) startLoop();
  }
  function togglePause() {
    const g = UI.game;
    if (g) setPaused(!g.paused);
  }
  function toggleMute() {
    UI.profile.muted = !UI.profile.muted;
    putProfile(UI.profile);
    G.music.setMuted(UI.profile.muted);
    syncAudioControls();
    updateHud();
  }

  /* ---------- audio levels ----------
     Push the saved levels into the two engines. Called on boot, and whenever a
     slider moves, so the sliders and what you hear can't drift apart. */
  function applyAudioSettings() {
    G.music.setVolume(UI.profile.musicVol);
    setSfxVolume(UI.profile.sfxVol);
    G.music.setMuted(UI.profile.muted);
  }
  /* Two mount points (the pause screen and the main menu) show the same
     settings, so moving one has to redraw the other. */
  function syncAudioControls() {
    for (const box of document.querySelectorAll('.audio-panel')) {
      const m = box.querySelector('.au-music'), s = box.querySelector('.au-sfx');
      const mute = box.querySelector('.au-mute');
      if (m) { m.value = Math.round(UI.profile.musicVol * 100); m.nextElementSibling.textContent = m.value + '%'; }
      if (s) { s.value = Math.round(UI.profile.sfxVol * 100); s.nextElementSibling.textContent = s.value + '%'; }
      if (mute) {
        mute.textContent = UI.profile.muted ? '🔇 Sound is off' : '🔊 Sound is on';
        mute.classList.toggle('muted', !!UI.profile.muted);
      }
      box.classList.toggle('is-muted', !!UI.profile.muted);
    }
  }
  function buildAudioPanel(mount) {
    if (!mount || mount.querySelector('.audio-panel')) return;
    const box = el('div', 'audio-panel');
    box.innerHTML = `
      <div class="au-title">Audio</div>
      <label class="au-row"><span>Music</span>
        <input class="au-music" type="range" min="0" max="100" step="1" /><b>70%</b></label>
      <label class="au-row"><span>Effects</span>
        <input class="au-sfx" type="range" min="0" max="100" step="1" /><b>100%</b></label>
      <button class="btn tiny au-mute" type="button">🔊 Sound is on</button>`;
    const wire = (sel, key) => {
      const input = box.querySelector(sel);
      const readout = input.nextElementSibling;
      input.addEventListener('input', () => {
        UI.profile[key] = input.value / 100;
        readout.textContent = input.value + '%';
        /* Un-mute the moment someone reaches for a slider: leaving the toggle
           off would make a dragged slider do nothing at all, which reads as a
           broken control rather than a mute. */
        if (UI.profile.muted && UI.profile[key] > 0) UI.profile.muted = false;
        applyAudioSettings();
        putProfile(UI.profile);
        syncAudioControls();
        updateHud();
      });
    };
    wire('.au-music', 'musicVol');
    wire('.au-sfx', 'sfxVol');
    box.querySelector('.au-mute').addEventListener('click', toggleMute);
    mount.appendChild(box);
    syncAudioControls();
  }
  function cycleSpeed() {
    const g = UI.game;
    if (!g) return;
    g.speed = g.speed === 1 ? 2 : g.speed === 2 ? 3 : 1;
    updateHud();
  }

  /* ---------- input ---------- */
  function canvasPos(ev) {
    const r = rects().canvas || UI.canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (G.W / r.width), y: (ev.clientY - r.top) * (G.H / r.height) };
  }

  function wireInput() {
    const cv = UI.canvas;

    /* One pointer path for mouse and finger alike. A mouse hovers freely; a
       finger only reports while it is down, so an armed Bro is dragged
       into position and placed on lift — you can see the ghost before
       committing, which a blind tap would never give you. */
    const hoverAt = (pos) => {
      const g = UI.game;
      if (!g) return;
      g.mouse = pos;
      let hover = null, bd = 30 * 30;
      for (const t of g.towers) {
        const d2 = (t.x - pos.x) ** 2 + (t.y - pos.y) ** 2;
        if (d2 < bd) { bd = d2; hover = t; }
      }
      g.hoverTower = hover;
      /* Only when it changes. Writing the same value back still dirties layout,
         and paired with canvasPos's read on the line above it turned every
         pointer move into a read-write-read cycle. */
      const want = g.placingType ? 'crosshair' : hover ? 'pointer' : 'default';
      if (cv.style.cursor !== want) cv.style.cursor = want;
    };

    let downId = null, downPos = null, moved = false;

    cv.addEventListener('pointerdown', (ev) => {
      const g = UI.game;
      if (!g || g.over) return;
      downId = ev.pointerId;
      moved = false;
      downPos = canvasPos(ev);
      hoverAt(downPos);
      if (cv.setPointerCapture) { try { cv.setPointerCapture(ev.pointerId); } catch (e) {} }
      ev.preventDefault();
    });

    cv.addEventListener('pointermove', (ev) => {
      const g = UI.game;
      if (!g) return;
      const pos = canvasPos(ev);
      if (ev.pointerId === downId) {
        if (Math.hypot(pos.x - downPos.x, pos.y - downPos.y) > 10) moved = true;
        hoverAt(pos);
      } else if (ev.pointerType === 'mouse') {
        hoverAt(pos);           // free hover, mouse only
      }
    });

    const finish = (ev) => {
      const g = UI.game;
      if (ev.pointerId !== downId) return;
      downId = null;
      if (!g || g.over) return;
      const pos = canvasPos(ev);

      if (g.placingType) {
        const placed = g.placeTower(g.placingType, pos.x, pos.y);
        if (placed) {
          sfx.place();
          const cost = g.priceOf(G.TOWERS[g.placingType].cost);
          if (!ev.shiftKey || g.cash < cost) g.placingType = null;
        } else {
          sfx.error();
        }
        syncCancelBtn();
        renderDockSel(); updateHud();
        return;
      }
      // a drag that wasn't placing anything shouldn't change the selection
      if (moved) return;
      let best = null, bd = 30 * 30;
      for (const t of g.towers) {
        const d2 = (t.x - pos.x) ** 2 + (t.y - pos.y) ** 2;
        if (d2 < bd) { bd = d2; best = t; }
      }
      g.selected = best;
      renderDockSel();
    };
    cv.addEventListener('pointerup', finish);
    cv.addEventListener('pointercancel', () => { downId = null; });

    cv.addEventListener('pointerleave', (ev) => {
      const g = UI.game;
      if (g && ev.pointerType === 'mouse') { g.mouse = { x: -999, y: -999 }; g.hoverTower = null; }
    });

    cv.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const g = UI.game;
      if (g) { g.placingType = null; g.selected = null; syncCancelBtn(); renderDockSel(); updateHud(); }
    });

    $('#btn-cancel-place').onclick = () => {
      const g = UI.game;
      if (!g) return;
      g.placingType = null;
      g.mouse = { x: -999, y: -999 };
      syncCancelBtn(); renderDockSel(); updateHud();
    };

    window.addEventListener('keydown', (ev) => {
      const g = UI.game;
      if (!g) return;
      const k = ev.key;

      if ((ev.metaKey || ev.ctrlKey) && k.toLowerCase() === 's') { ev.preventDefault(); doSave(false); return; }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

      if (k === 'Escape') {
        if (!$('#confirm').hidden) { closeConfirm(); return; }
        if ($('#screen-pause').classList.contains('active')) { closePauseMenu(); return; }
        if ($('#overlay').style.display === 'flex') return; // other screens keep their own buttons
        if (g.placingType) { g.placingType = null; }
        else if (g.selected) { g.selected = null; }
        else { openPauseMenu(); return; }
        syncCancelBtn(); renderDockSel(); updateHud();
        return;
      }
      if ($('#overlay').style.display === 'flex') return; // don't play the game under a menu
      /* Nor under a question. X in particular: it is the direct sell, and
         answering "sell this?" by pressing the sell key would sell the Bro
         and leave the card still asking about it. */
      if (!$('#confirm').hidden) return;

      if (k === ' ' || k === 'Spacebar' || ev.code === 'Space') { ev.preventDefault(); trySend(); return; }
      if (k === 'Tab') { ev.preventDefault(); cycleSpeed(); return; }
      if (k === 'p' || k === 'P') { togglePause(); return; }
      if (k === 'm' || k === 'M') { toggleMute(); return; }
      if (k === 'h' || k === 'H') {   // hero: place if benched, otherwise fire the ability
        if (!g.heroType) return;
        if (g.heroTower) fireHeroAbility();
        else armTower(g.heroType);
        return;
      }

      // context keys for the selected Bro
      if (g.selected) {
        const lk = k.toLowerCase();
        if (lk === 'q') { buyUpgrade(g.selected, 0); return; }
        if (lk === 'w') { buyUpgrade(g.selected, 1); return; }
        if (lk === 'e') { buyUpgrade(g.selected, 2); return; }
        if (lk === 't') { cycleTarget(); return; }
        if (lk === 'x') { sellSelected(); return; }
      }

      // build hotkeys
      const id = KEY_TO_TOWER[k.length === 1 ? k.toUpperCase() : k];
      if (id) armTower(id);
    });

    /* The panel stays up until you go somewhere else. Pressing inside it does
       nothing — that is where the upgrade buttons are — and the map is left to
       its own handler, which already picks a different Bro or clears the
       selection depending on what you hit. Everything else counts as leaving.
       Capture phase so it runs before the thing you pressed re-renders the panel
       out from under this check. */
    document.addEventListener('pointerdown', (ev) => {
      const g = UI.game;
      if (!g || !g.selected) return;
      /* #confirm is a child of #stage rather than of the panel, so without it
         here the press that answers "sell this Bro?" cleared the selection
         and re-rendered the panel first — which closes the dialog and drops the
         callback — and the click that followed landed on a button that no
         longer had anything to do. Pressing Sell did nothing at all.

         #command is the wave controls, and they are the one thing beside the
         card that keeps working while it is open — so using them must not shut
         it. Sending the next wave, dropping to 1x or pausing are all things you
         do BECAUSE you are part-way through reading a card, and closing it as
         the price of pausing is the opposite of what pausing is for. */
      if (ev.target.closest('#selpanel') || ev.target.closest('#confirm')
          || ev.target.closest('#command') || ev.target.closest('canvas#game')) return;
      g.selected = null;
      renderDockSel();
    }, true);

    $('#send-wave').onclick = trySend;
    $('#btn-speed').onclick = cycleSpeed;
    $('#btn-pause').onclick = togglePause;
    $('#btn-save').onclick = () => doSave(false);
    $('#btn-menu').onclick = openPauseMenu;
    $('#btn-mute').onclick = toggleMute;
    $('#auto-start').onchange = (ev) => {
      const g = UI.game;
      if (g) { g.autoStart = ev.target.checked; if (!g.autoStart) g.nextWaveIn = null; updateHud(); }
    };
    $('#btn-end-menu').onclick = () => exitToMenu(false);
  }

  /* ---------- canvas sizing (world size varies per tier) ---------- */
  /* How many real pixels the battlefield is drawn into.

     This used to be the WORLD size times the device ratio — G.W * dpr — which
     has nothing to do with how big the map is actually on screen. On a Retina
     Mac that is a 2560x1600 backbuffer, 4.1 million pixels, redrawn every
     frame, to fill a canvas the layout had sized to 596x373. Nine times the
     pixels the display could show. Measured on an EMPTY map with no towers and
     no vacuums, that alone was 9.0ms of a 16.7ms frame — before drawing a
     single Bro — which is why the whole game had so little headroom left
     that dragging a Bro around visibly skipped.

     It is the displayed size times the device ratio now, which is the amount
     that can actually be seen, capped at twice the world size so a 5K panel
     cannot ask for a backbuffer nobody benefits from. Everything draws in world
     coordinates and the transform absorbs the difference, so nothing else in
     the renderer has to know. */
  const MAX_OVERSAMPLE = 2;
  function backingScale(cssW) {
    const dpr = Math.min(IS_TOUCH ? 1.5 : 2, window.devicePixelRatio || 1);
    return Math.min(MAX_OVERSAMPLE, (cssW * dpr) / G.W);
  }

  function applyBacking(cssW) {
    const s = backingScale(cssW);
    const w = Math.max(320, Math.round(G.W * s)), h = Math.max(200, Math.round(G.H * s));
    /* Setting width/height clears the canvas and resets its state, so only do
       it when the number really changed — fitCanvas runs on every resize tick
       and a ResizeObserver can fire a lot. */
    if (UI.canvas.width !== w || UI.canvas.height !== h) {
      UI.canvas.width = w;
      UI.canvas.height = h;
    }
    // the transform is reset by a resize, so it is re-applied either way
    UI.ctx.setTransform(w / G.W, 0, 0, h / G.H, 0, 0);
  }

  function sizeCanvas() {
    /* alpha:false — the terrain blit covers every pixel of this canvas on every
       frame, so the transparency was never used, and an opaque canvas can go
       straight to the compositor instead of being blended over the page. */
    UI.ctx = UI.canvas.getContext('2d', { alpha: false });
    applyBacking(G.W);   // a starting guess; fitCanvas sets the real one
    fitCanvas();
  }
  /* ---- in-level geometry ----
     The map and the column beside it are one block of FIXED proportions. The
     block is scaled to fit the window and centred; whatever the window has left
     over is empty space above and below, or either side. The block's shape is
     never bent to match the window's — that is the whole idea, and it is what
     makes the layout identical everywhere instead of merely similar.

     The column is a quarter of the map's width. That one number sets the
     block's shape, and it is a share of the map rather than a pixel count so
     everything scales together. Checked against all three battlefields, since
     they are not one shape: 1.60 gives an 18:9 block, 1.67 gives 18.8:9 and
     1.74 gives 19.6:9 — all inside 16:9 to 20:9, with room at both ends. */
  const COL_FRAC = 0.25;
  /* The panels are laid out at this width and then scaled into their half, so
     it is the only width their contents ever see: every question about
     wrapping, clipping and long sell prices is settled once, here, rather than
     at every window size. Because the block's shape is fixed, half a column is
     always the same shape too — COL_FRAC * 2 * map aspect, which is 0.80 to
     0.87 — so a group of that shape scales in with nothing left over. */
  const PANEL_W = 400;
  const PAD = 12;
  /* How the column divides between the build tray on top and the panels under
     it. It was a straight half each. The selection card used to be 170 of the
     panels' 519 nominal units, and it has moved to the flyout, so the panels
     need about two-thirds of what they did and the tray takes the difference —
     which is a couple more rows of Bros visible without scrolling.

     Left at 0.62 deliberately. The blank band under the tray was never this
     split: it was an empty grid track inside the panel box (see #dock-hero's
     grid-row in style.css), and taking height off the tray to paper over it
     would have cost rows of Bros for nothing. */
  const TRAY_SHARE = 0.62;

  /* The panel group is drawn at PANEL_W and scaled by width alone, and given
     the height its half works out to in those same nominal units. So it fills
     the half exactly — no slack down one side, which is what "contained" gave:
     the group came out narrower than the tray above it and the two boxes did
     not line up. What varies with the battlefield is only how tall the group is
     in nominal units (0.80 to 0.87 of its width), and the sections inside share
     that between them. */
  function fitPanels() {
    const root = document.documentElement;
    const side = parseFloat(root.style.getPropertyValue('--sidew'));
    const half = parseFloat(root.style.getPropertyValue('--panelsh'));
    if (!side || !half) return;
    /* The block runs to the foot of the screen now, so the wave controls would
       otherwise sit in the strip iOS watches for a swipe up. #panel-fit keeps
       clear with a bottom margin — and the group has to be scaled to what is
       LEFT after that margin, not to the whole cell, or #panel-fit's
       overflow:hidden simply clips off the bottom of the group it was given.
       Zero on a screen with nothing sticking into it. */
    const inB = parseFloat(root.style.getPropertyValue('--map-inset-b')) || 0;
    const cellW = side - 8, cellH = half - 4 - inB;   /* the cell, less its margins */
    const scale = cellW / PANEL_W;
    root.style.setProperty('--pscale', scale.toFixed(4));
    root.style.setProperty('--panelh', Math.round(cellH / scale) + 'px');
  }

  /* One path, no branch. There is no window size at which a different
     arrangement takes over — a window the block's shape does not match gets a
     margin, and that is the whole of it. */
  /* How to spend the leftover margin along one axis. `total` is what is left
     once the block has taken its size; `a` and `b` are what the two edges want
     for their cutouts.

     An even split — which is what a pair of 1fr gutters gives, and what this
     replaced — is the wrong answer the moment only one edge has something in
     it: half the margin sits on the empty side doing nothing while the island
     covers the map. So the cutouts are paid first and whatever survives is
     shared evenly, which leaves an ordinary window centred exactly as before
     because there both edges want nothing. When the margin cannot cover both
     cutouts it is shared in proportion to what each asked for, so the edge with
     the real cutout still gets the larger share of a bad hand. */
  function spendMargin(total, a, b) {
    if (total <= 0) return [0, 0];
    const want = a + b;
    if (want <= 0) return [total / 2, total / 2];
    if (want <= total) { const rest = (total - want) / 2; return [a + rest, b + rest]; }
    return [total * (a / want), total * (b / want)];
  }

  function fitCanvas() {
    if (!UI.canvas) return;
    const root = document.documentElement;
    /* The whole screen, cutouts included. This used to be the safe box — the
       window less the four insets — and on an iPhone in landscape that handed
       about 59px of the Dynamic Island's width straight to the letterbox. The
       block is a fixed shape scaled to fit, so width taken off the budget is
       width taken off the battlefield: up to 12% of it on the widest tier.

       The block takes the screen and moves out of the cutout's way instead, and
       what is under the cutout afterwards is map art rather than anything you
       read or press. The chrome offsets itself by --map-inset-* below. */
    const sa = safeArea();
    const vw = root.clientWidth, vh = root.clientHeight;
    const W = vw - PAD;
    const H = vh - PAD;
    const aspect = G.W / G.H;
    const playing = $('#dock').classList.contains('playing');

    /* Between battles there is no column, so the block is just the map and it
       takes the window; the menu's backdrop gets the rest. */
    const frac = playing ? COL_FRAC : 0;
    const ratio = aspect * (1 + frac);
    /* The one place the window is consulted: how big the block can be drawn.
       Its shape does not depend on this. */
    const blockW = Math.min(W, H * ratio);
    const mapH = blockW / ratio, mapW = mapH * aspect, side = blockW - mapW;

    /* The column used to split in half, because the top half was the tray and
       the bottom half was four panels. The selection card has since left for a
       flyout on the left, so the bottom needs less and the tray gets the rest.
       The panels do not reflow into their share — they are laid out at PANEL_W
       and scaled into it, so they hold their shape at every window size. */
    root.style.setProperty('--mapw', Math.round(mapW) + 'px');
    root.style.setProperty('--sidew', Math.round(side) + 'px');
    root.style.setProperty('--trayh', Math.round(mapH * TRAY_SHARE) + 'px');
    root.style.setProperty('--panelsh', Math.round(mapH * (1 - TRAY_SHARE)) + 'px');
    root.style.setProperty('--panelw', PANEL_W + 'px');

    /* Where the block sits. The four gutters are the grid's outer tracks (see
       #app in style.css), spent on the cutouts first and shared evenly after
       that — so a desktop window is centred exactly as it always was, and a
       phone gets the block pushed off the island.

       The RIGHT inset is deliberately ignored. iOS reports a landscape cutout
       on both edges at once — 62px each on an iPhone 17 Pro — because it will
       not say which way round the phone is being held. Honouring both cost 124
       of the 26 spare pixels the widest battlefield has, and the shortfall came
       out of the build tray: 49px off a 170px column, three tiles across, so
       the tiles and their prices visibly shrank for everyone.
       So the island is assumed to be on the LEFT, which is where it lands for
       the way most people turn a phone. Held the other way it sits over the far
       end of the tray, and a player will turn the phone back — a cheaper thing
       to ask once than smaller tiles forever. */
    /* Clear the island and then stop. spendMargin was splitting what was left
       over AFTER clearing it evenly between the two edges, which put half of it
       back on the side that already had the cutout: 78px of black down the left
       of a phone where the island only needs 62, and the whole block shoved
       that much further right for no reason. The block now sits as far toward
       the cutout as the cutout allows, and everything spare goes to the far
       side. A screen with nothing sticking into it still centres exactly as
       before — that is the second branch, and it is what a desktop takes. */
    const spare = Math.max(0, vw - blockW);
    const clear = Math.min(spare, sa.left);
    const [gutL, gutR] = sa.left > 0 ? [clear, spare - clear] : spendMargin(spare, 0, 0);
    const [gutT, gutB] = spendMargin(vh - mapH, sa.top, sa.bottom);
    root.style.setProperty('--gut-l', Math.round(gutL) + 'px');
    root.style.setProperty('--gut-r', Math.round(gutR) + 'px');
    root.style.setProperty('--gut-t', Math.round(gutT) + 'px');
    root.style.setProperty('--gut-b', Math.round(gutB) + 'px');

    /* And how far a cutout still reaches PAST the gutter, into the block. Zero
       whenever the margin was enough to clear it, which on the two smaller
       tiers is every iPhone. When it is not zero it is a handful of pixels of
       map art, and it is the number every floating control adds to its own
       offset so that none of them lands under the island or the home bar.

       Left and top land on the map; right lands on the dock, because the dock
       is what the block's right-hand edge is. Bottom lands on both. */
    const px = (n) => Math.max(0, Math.round(n)) + 'px';
    root.style.setProperty('--map-inset-l', px(sa.left - gutL));
    root.style.setProperty('--map-inset-t', px(sa.top - gutT));
    root.style.setProperty('--map-inset-b', px(sa.bottom - gutB));
    /* The map's left edge, for anything position:fixed that has to line up with
       it — measured against the window, while everything else floating over the
       battlefield is absolute inside #stage, which IS the map's box, and needs
       only the insets above. */
    root.style.setProperty('--map-l', Math.round(gutL) + 'px');
    /* The vitals and the system buttons sit on the map rather than in the
       column, so they scale with the map rather than with the panels. Floored
       so they stay legible and tappable on a small block, capped so they do not
       swell on a 4K one. 1280 is the narrowest battlefield's own width, which
       makes 1 the size they were drawn at. */
    root.style.setProperty('--uiscale', Math.max(0.62, Math.min(1.1, mapW / 1280)).toFixed(3));
    fitPanels();

    UI.canvas.style.width = Math.round(mapW) + 'px';
    UI.canvas.style.height = Math.round(mapH) + 'px';
    applyBacking(mapW);  // draw at the resolution it is actually displayed at
    invalidateRects();   // the column and the canvas just moved
    /* The card sits in the column's slot, so the slot moving is the one thing
       that can strand it. Re-measured rather than re-rendered: rebuilding the
       whole card on every resize tick would throw away a half-scrolled panel
       and re-run every price lookup for a box that only changed shape. */
    const sel = $('#selpanel');
    if (sel && !sel.hidden) fitSelPanel(sel);
  }

  /* ---------- main loop ---------- */
  let hudTick = 0, dockTick = 0, lastSelected = null, lastPlacing = null;
  function step(dt, now) {
    const g = UI.game;
    if (!g) return;

    /* Paused or finished: draw the state once so the banner and the final board
       land, then stop. The simulation already bails on both, but the renderer
       did not — it rebuilt the whole scene sixty times a second for a picture
       that could not change, and because the render clock keeps advancing the
       frames really were different, so the browser could not skip a single one.
       A paused game cost exactly as much as a live one. */
    if (g.paused || g.over) {
      if (UI.idleDrawn) return;
      UI.idleDrawn = true;
      G.render(UI.ctx, g, dt);
      updateHud();
      return;
    }
    UI.idleDrawn = false;

    const popsBefore = g.enemies.length;
    g.update(dt);
    if (g.enemies.length < popsBefore && now > UI.popSoundGate) {
      sfx.pop();
      UI.popSoundGate = now + 60;
    }

    G.render(UI.ctx, g, dt);

    hudTick -= dt;
    if (hudTick <= 0) { hudTick = 0.12; updateHud(); }
    dockTick -= dt;
    if (dockTick <= 0) {
      dockTick = 0.3;
      if (g.selected !== lastSelected || g.placingType !== lastPlacing) {
        lastSelected = g.selected; lastPlacing = g.placingType;
        renderDockSel();
      }
    }
  }

  /* Never draw faster than this, whatever the screen offers. requestAnimationFrame
     fires at the display's refresh rate, so nobody ever chose 60 — a 120Hz phone
     was simply doing twice the work per second for a picture that looks the same,
     because the simulation is driven by elapsed time rather than by counting
     frames. There is no way for the player or the device to opt out of that. */
  const FRAME_MS = 1000 / 60;

  /* Truthiness, not `!= null`. UI.rafId starts life as 0 (see the UI object at
     the top of this file), and `0 != null` is true — so this guard decided the
     loop was already running before it had ever run once, and returned. From
     the moment the loop learned to stop, it could never be started.

     What kept the game moving at all was the 15Hz backstop below, which exists
     for webviews that starve requestAnimationFrame. Measured against a 60Hz
     display: 7 frames a second, 88% of them dropped. That is the skipping —
     not the drag, not the renderer. A real handle is always a positive
     integer, so this reads 0, null and undefined alike as "not running". */
  function startLoop() {
    if (UI.rafId) return;
    UI.lastTime = performance.now();
    UI.rafId = requestAnimationFrame(loop);
  }

  /* The loop stops rather than idling. It used to re-arm unconditionally on its
     first line, so it ran at full refresh through every menu, shop and level
     select for the whole session, doing a call and an early return — cheap in
     JS, but it keeps the browser's rendering pipeline armed the entire time.
     Anything that gives us a game to run starts it again. */
  function loop(now) {
    const g = UI.game;
    if (!g) { UI.rafId = 0; return; }
    /* Stop once there is nothing left that can change on screen. A finished
       battle is the state a phone is most likely to be left sitting in —
       someone wins and puts it down — and it used to redraw the whole
       battlefield forever at full refresh.

       Deliberately keyed on the GAME being paused rather than on the page being
       hidden. Hiding pauses the battle, so the battery saving is the same, but a
       webview that misreports its visibility can then only ever cost a paused
       game the player can see and resume — not a loop that refuses to restart. */
    if ((g.paused || g.over) && UI.idleDrawn) { UI.rafId = 0; return; }
    UI.rafId = requestAnimationFrame(loop);
    /* Six tenths of a frame of slack, not one millisecond.
       A 60Hz display does not hand out clean 16.667s — measured here, the gaps
       run 15.6 to 17.7 — so a threshold of 15.667 rejected the short ones. A
       rejected frame does not advance lastTime, so the next one renders with a
       doubled step: one in six frames arrived as a 33ms lurch. That is judder
       manufactured by the frame limiter itself.
       10ms clears every real 60Hz frame and still halves a 120Hz one, which is
       the only thing the cap was ever for. */
    if (now - UI.lastTime < FRAME_MS * 0.6) return;
    const dt = Math.min(0.1, (now - UI.lastTime) / 1000) || 0.016;
    UI.lastTime = now;
    step(dt, now);
  }

  /* ---------- boot ---------- */
  UI.init = function () {
    if (IS_TOUCH) document.documentElement.classList.add('touch');
    UI.canvas = $('#game');
    sizeCanvas();
    // rotating the phone changes the whole layout budget
    window.addEventListener('orientationchange', () => setTimeout(fitCanvas, 250));
    window.addEventListener('resize', fitCanvas);
    setTimeout(fitCanvas, 0);
    new ResizeObserver(fitCanvas).observe($('#stage'));
    /* Two more ways the room can change without a resize event, both of them
       phone-only. visualViewport is what actually moves when Safari's furniture
       slides away, and it does not always fire the window's resize alongside.
       pageshow fires when an installed web app is restored rather than started
       — it can come back with the status bar showing and 54px less height than
       it had when it was put down, and nothing else announces that. */
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fitCanvas);
    window.addEventListener('pageshow', () => { invalidateRects(); fitCanvas(); });
    /* the panel group's own height, which changes as its contents are built and
       as the hero panel comes and goes; the transform does not affect what this
       reports, so setting the scale cannot re-trigger it */
    new ResizeObserver(fitPanels).observe($('#sidebar'));

    buildMainMenu();
    buildAudioPanel($('#menu-audio'));
    buildAudioPanel($('#pause-audio'));
    applyAudioSettings();
    wireInput();
    wireConfirm();
    $('#btn-fs').onclick = toggleFullscreen;
    document.addEventListener('fullscreenchange', updateFsButton);
    document.addEventListener('webkitfullscreenchange', updateFsButton);
    updateFsButton();
    show('#screen-menu');
    /* Not started here any more: with no game there is nothing to run, and the
       loop now stops instead of spinning through the menus. startGame kicks it. */

    // browsers unlock audio on the first gesture — start the menu tune then
    const kickAudio = () => {
      unlockMobileAudio();
      applyAudioSettings();
      if (!UI.game) G.music.play('menu');
      window.removeEventListener('pointerdown', kickAudio);
      window.removeEventListener('keydown', kickAudio);
    };
    window.addEventListener('pointerdown', kickAudio);
    window.addEventListener('keydown', kickAudio);

    /* Backstop: keep the simulation running even if the browser starves
       requestAnimationFrame (embedded webviews, minimized panes, etc).

       It must not run while the page is hidden. There, rAF stops refreshing
       lastTime, so the 120ms condition becomes permanently true and every
       surviving tick simulated AND painted a canvas nobody could see — which is
       precisely the case the backstop is not for. Nor while there is no game:
       it woke the JS thread fifteen times a second from boot, on every screen,
       for the whole session. */
    setInterval(() => {
      const g = UI.game;
      if (!g || g.paused || g.over) return;
      const now = performance.now();
      if (now - UI.lastTime > 120) {
        const dt = Math.min(0.25, (now - UI.lastTime) / 1000);
        UI.lastTime = now;
        step(dt, now);
      }
    }, 66);
  };
})();
