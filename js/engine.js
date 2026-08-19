/* Brix and Bros — core simulation engine */
(function () {
  const G = (globalThis.G = globalThis.G || {});
  const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

  /* ---------- Path helpers ---------- */
  function buildPath(pts) {
    const segs = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
      const len = Math.hypot(dx, dy);
      segs.push({ x: pts[i].x, y: pts[i].y, dx: dx / len, dy: dy / len, len, start: total });
      total += len;
    }
    return { pts, segs, total };
  }

  function samplePath(path, d) {
    d = Math.max(0, Math.min(d, path.total - 0.001));
    let seg = path.segs[0];
    for (const s of path.segs) { if (d >= s.start) seg = s; else break; }
    const t = d - seg.start;
    return { x: seg.x + seg.dx * t, y: seg.y + seg.dy * t, ang: Math.atan2(seg.dy, seg.dx) };
  }

  function distToPath(path, x, y) {
    let best = Infinity;
    for (const s of path.segs) {
      const px = x - s.x, py = y - s.y;
      const t = Math.max(0, Math.min(s.len, px * s.dx + py * s.dy));
      best = Math.min(best, dist2(x, y, s.x + s.dx * t, s.y + s.dy * t));
    }
    return Math.sqrt(best);
  }

  /* Does the segment a→b pass through this circle? Standard closest-point-on-
     segment test, kept allocation-free because it runs in the targeting loop. */
  function segHitsCircle(ax, ay, bx, by, cx, cy, r2) {
    const dx = bx - ax, dy = by - ay;
    const fx = ax - cx, fy = ay - cy;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 1e-6 ? -(fx * dx + fy * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = fx + dx * t, py = fy + dy * t;
    return px * px + py * py <= r2;
  }

  /* An upgrade must never make a Bro worse at anything. With two paths
     that was easy to keep true by hand; with three it is not, because the
     pairs a player can buy are now six per tower and effects overlap across
     them. So combining an effect TAKES THE BETTER of the two rather than
     letting whichever path happens to be processed last win outright.

     The case that forced it: the Slush Thrower's Thicker Slush (65% slow, 2.4s)
     and Slow Drip (50% slow, 4.8s) are a legal pair, and plain assignment
     handed the player a 50% slow for their trouble — a downgrade they paid
     🔩320 for. Merged, they get the 65% AND the 4.8s, which is what buying
     both plainly ought to mean. */
  function mergeFx(fx, add) {
    for (const k in add) {
      const v = add[k], cur = fx[k];
      if (!cur) { fx[k] = v; continue; }
      if (k === 'slow') fx.slow = { f: Math.min(cur.f, v.f), d: Math.max(cur.d, v.d) };
      else if (k === 'dot') fx.dot = { dps: Math.max(cur.dps, v.dps), d: Math.max(cur.d, v.d) };
      else if (k === 'mark') fx.mark = { amt: Math.max(cur.amt, v.amt), d: Math.max(cur.d, v.d) };
      else if (k === 'knock') fx.knock = { d: Math.max(cur.d, v.d), p: Math.max(cur.p, v.p) };
      else if (k === 'bleed') fx.bleed = { pct: Math.max(cur.pct, v.pct), d: Math.max(cur.d, v.d) };
      else if (k === 'freezeMeter') fx.freezeMeter = { hits: Math.min(cur.hits, v.hits), stun: Math.max(cur.stun, v.stun) };
      else if (typeof v === 'number') fx[k] = Math.max(cur, v);
      else fx[k] = v;
    }
  }

  /* ---------- Effective tower stats (base + upgrades) ---------- */
  function computeEffective(typeId, up) {
    const def = G.TOWERS[typeId];
    const s = Object.assign({}, def.stats);
    const fx = {};
    for (const k in (def.stats.fx || {})) fx[k] = def.stats.fx[k];
    for (let p = 0; p < def.paths.length; p++) {
      for (let t = 0; t < (up[p] || 0); t++) {
        const mods = def.paths[p].tiers[t].mods || {};
        for (const k in (mods.add || {})) s[k] = (s[k] || 0) + mods.add[k];
        for (const k in (mods.mul || {})) s[k] = (s[k] || 0) * mods.mul[k];
        for (const k in (mods.set || {})) s[k] = mods.set[k];
        if (mods.fx) mergeFx(fx, mods.fx);
      }
    }
    s.fx = fx;

    /* Global nerf, applied last so it scales the finished Bro rather than
       each of 120 upgrade tiers. Ranges of 5000+ are the deliberately
       map-wide ones (the Laser Sniper) and stay that way. */
    const N = G.NERF;
    if (N) {
      /* N.damage is 1 today, so this is a no-op — kept as the one place a
         damage change would go. If it ever drops below 1 again, do NOT clamp
         the result back up to 1: that would make "+1 damage" upgrades change
         nothing on the weakest Bros, the exact dead upgrade this codebase
         already had once. Fractional damage is fine. */
      if (s.damage) s.damage *= N.damage;
      if (s.spikeDmg) s.spikeDmg *= N.damage;
      if (s.rate) s.rate *= N.rate;
      if (s.range && s.range < 5000) s.range *= N.range;
      if (s.minRange) s.minRange *= N.range;
      /* Auras are NOT scaled here. Their nerf is baked into the values in
         data.js so that "Helpers hit 28% harder" is literally what the tower
         grants — a multiplier at this point silently falsified every printed
         percentage. Armour-pierce and pierce are likewise untouched, so
         "punch through 2 armor" stays true. */
    }
    return s;
  }
  G.computeEffective = computeEffective;

  /* ---------- Game ---------- */
  let nextId = 1;

  class Game {
    constructor(levelIdx, diffId, heroType) {
      const L = G.LEVELS[levelIdx];
      G.setDims(L);   // world size varies by tier; everything reads G.W/G.H
      this.levelIdx = levelIdx;
      this.level = L;
      this.diffId = G.DIFFICULTIES[diffId] ? diffId : 'medium';
      /* hero: chosen before battle, placed like a tower, one per battle */
      this.heroType = G.TOWERS[heroType] && G.TOWERS[heroType].hero ? heroType : null;
      this.heroTower = null;      // the placed hero (a towers[] entry) or null
      this.heroKills = 0;         // vacuums felled while placed -> level
      this.heroLevel = 1;
      this.heroReadyAt = 0;       // game time when the ability recharges
      this.totalWaves = G.DIFFICULTIES[this.diffId].waves;
      this.startLives = G.scaleLives(L.lives, this.diffId);
      this.frenzyUntil = 0;
      this.paths = L.paths.map(buildPath);
      /* Terrain that stands up blocks shots. Precomputed once — obstacles never
         move, so the targeting loop only ever reads this list. */
      this.sightBlockers = L.blockers
        .filter((b) => G.SIGHT_BLOCKS[b.kind])
        .map((b) => ({ x: b.x, y: b.y, r: b.r * G.SIGHT_SHRINK, r2: (b.r * G.SIGHT_SHRINK) ** 2 }));
      this.cash = L.cash + G.PERK.cash;   // Deeper Stores workshop upgrade
      this.lives = this.startLives;
      this.wave = 1;              // next wave to start (1-based)
      this.waveInProgress = false;
      this.waveTime = 0;
      this.spawnQueue = [];       // [{type, t, pathIdx, hpMult}]
      this.enemies = [];
      this.projectiles = [];
      this.piles = [];            // ice-wall spikes, drift mines and ice decoys on track
      /* Ground zones: craters, slicks, wakes, aurora fire, corrupt stains,
         squalls, quagmires. One patch on the track with a lifetime and an
         effect, checked against vacuums exactly as spike piles already are —
         ten capstones share this list rather than each inventing a system. */
      this.zones = [];
      /* Buffs that live for a few seconds rather than for the battle: the
         Brick Fort's breach alarm, the War Drummer's opening solo. Static auras are
         settled in recomputeBuffs; these can't be, because they start and stop
         while nothing about the board has changed. */
      this.tempAuras = [];
      this.costMult = 1;          // Bulk Orders discount on everything bought
      this.towers = [];
      this.effects = [];          // transient visuals
      this.texts = [];            // floating cash/damage text
      this.time = 0;
      this.speed = 1;
      this.paused = false;
      this.autoStart = false;
      this.nextWaveIn = null;   // auto-start countdown (ticks only while unpaused)
      this.over = null;           // 'win' | 'lose'
      this.endless = false;       // set after victory if the player keeps going
      this.kills = 0;             // vacuums destroyed this battle (the ☠ count)
      /* Builder XP is no longer the raw count: an endless kill is worth
         G.ENDLESS_RANK_XP of a campaign one, so depth on one map cannot outrun
         the ten-battlefield tier the rank ladder was fitted to. Kept as its own
         running total rather than derived at bank time, because banking happens
         mid-wave too (saving, restarting) and "which waves were those kills in"
         is not recoverable from a total after the fact. */
      this.rankXp = 0;
      this.xpBanked = 0;          // how much of that is already on the profile
      this.selected = null;
      this.placingType = null;
      this.mouse = { x: -999, y: -999 };
      this.onEvent = null;        // ui callback: (kind, payload)
      this._altPath = 0;
    }

    emit(kind, payload) { if (this.onEvent) this.onEvent(kind, payload); }

    /* ----- placement ----- */
    inWater(x, y) {
      /* The stud, not the circle. The pool is PAINTED as whole studs with a
         stepped edge, so asking a smooth circle here would put the buildable
         shape a few pixels off the visible one — right at the rim, which is
         the only part of a pool anyone builds on. */
      return G.inWaterCell(this.level, x, y);
    }

    canPlace(typeId, x, y) {
      const def = G.TOWERS[typeId];
      if (x < 20 || x > G.W - 20 || y < 46 || y > G.H - 20) return false;
      for (const p of this.paths) if (distToPath(p, x, y) < G.PATH_HALF + G.TOWER_R - 4) return false;
      for (const b of this.level.blockers) if (dist2(x, y, b.x, b.y) < (b.r + G.TOWER_R - 4) ** 2) return false;
      for (const t of this.towers) if (dist2(x, y, t.x, t.y) < (G.TOWER_R * 2 - 6) ** 2) return false;
      /* A Bro stands on the baseplate, or on the water plates — never on top
         of a piece that is already down. The scenery used to be decoration the
         placement rules knew nothing about, so Bros ended up standing on the
         houses and the loose bricks. */
      const occ = this.level.occupied;
      if (occ) {
        /* Two studs wide, and two deep: the pair the feet stand on plus the
           row the legs reach into. Only the feet was too little — a Bro one
           stud above a brick still had its legs lying across it. All three
           rows was too much: it cost so much ground that the difficulty ramp
           between tiers went flat.

           The row ABOVE deliberately is not reserved. Terrain is painted
           before the figures, so a piece up there is drawn BEHIND the Bro,
           which is what standing in front of something looks like. */
        const U = G.STUD_U, s = G.snapStand(x, y);
        const i = Math.round(s.x / U), j = Math.round(s.y / U - 0.5);
        for (let dj = 0; dj <= 1; dj++) {
          if (occ.has((i - 1) + ',' + (j + dj)) || occ.has(i + ',' + (j + dj))) return false;
        }
      }
      const water = def.stats.water || 'never';
      if (water === 'only' && !this.inWater(x, y)) return false;
      if (water === 'never' && this.inWater(x, y)) return false;
      return true;
    }

    /* What a thing actually costs right now: the difficulty and workshop-perk
       price, then the Bulk Orders discount if a Parts Trader is running
       one. Every surface that quotes a price has to come through here, or the
       dock advertises one number and the purchase takes another. */
    priceOf(raw) {
      const base = G.scaleCost(raw, this.diffId);
      return this.costMult === 1 ? base : Math.max(5, Math.round((base * this.costMult) / 5) * 5);
    }

    placeTower(typeId, x, y) {
      const def = G.TOWERS[typeId];
      if (def.hero && (this.heroTower || typeId !== this.heroType)) return null; // one hero, the chosen one
      /* Snap to the studs. A Bro stands on two of them like a minifig does, so
         the drop point is a suggestion and this is where it actually lands.
         Every route into placement comes through here, so none of them can
         put a Bro down off the grid. */
      const spot = G.nearestStand(this, typeId, x, y);
      if (!spot) return null;
      x = spot.x; y = spot.y;
      const cost = this.priceOf(def.cost);
      if (this.cash < cost || !this.canPlace(typeId, x, y)) return null;
      this.cash -= cost;
      const t = {
        id: nextId++, type: typeId, x, y, up: [0, 0, 0], target: 'first',
        invested: cost, cooldown: 0, orbitAngle: Math.random() * Math.PI * 2,
        calc: computeEffective(typeId, [0, 0, 0]), buff: { dmg: 1, rate: 1, range: 1, stealth: false },
      };
      if (def.hero) { t.hero = true; this.heroTower = t; this.refreshHero(); }
      this.towers.push(t);
      this.recomputeBuffs();
      return t;
    }

    /* re-derive the hero's level and battle stats (called when either input
       moves: a vacuum fell, the endless curve deepened, a save loaded) */
    refreshHero() {
      this.heroLevel = G.heroLevelFor(this.heroKills);
      const t = this.heroTower;
      if (!t) return;
      t.calc = G.applyHeroScale(
        computeEffective(t.type, t.up), t.type, this.heroLevel,
        G.heroStrength(this.level, this.wave));
      this.recomputeBuffs();
    }

    /* the hero's signature ability: free, gated by level, recharges on game time */
    useHeroAbility() {
      const t = this.heroTower;
      if (this.over) return { ok: false, msg: 'The battle is over.' };
      if (!t) return { ok: false, msg: 'Place your hero first.' };
      const A = G.HEROES[t.type].ability;
      if (this.heroLevel < A.unlock) return { ok: false, msg: `${A.name} unlocks at level ${A.unlock}.` };
      if (this.time < this.heroReadyAt) return { ok: false, msg: `${A.name} is recharging.` };
      /* Each hero's ability lives beside its definition in data.js rather than
         in a growing if/else here — with nine champions that chain was going to
         become the one place every new hero had to remember to edit. */
      if (typeof A.fire === 'function') A.fire(this, t, G.heroStrength(this.level, this.wave));
      this.heroReadyAt = this.time + A.cd;
      return { ok: true, name: A.name };
    }

    buyUpgrade(tower, pathIdx) {
      const def = G.TOWERS[tower.type];
      if (def.hero) return { ok: false, msg: 'Heroes level up on their own as waves fall.' };
      const state = G.pathState(tower.up, pathIdx);
      if (state !== 'open') return { ok: false, msg: G.PATH_LOCK_MSG[state] };
      const tier = tower.up[pathIdx];
      const upg = def.paths[pathIdx].tiers[tier];
      const cost = this.priceOf(upg.cost);
      if (this.cash < cost) return { ok: false, msg: 'Not enough studs.' };
      this.cash -= cost;
      tower.invested += cost;
      tower.up[pathIdx]++;
      tower.calc = computeEffective(tower.type, tower.up);
      this.recomputeBuffs();
      return { ok: true };
    }

    sellTower(tower) {
      const refund = Math.round(tower.invested * G.SELL_RATE);
      this.cash += refund;
      this.towers = this.towers.filter((t) => t !== tower);
      this.piles = this.piles.filter((p) => p.owner !== tower.id);
      if (tower.hero) this.heroTower = null; // level is kept — re-place to resume
      if (this.selected === tower) this.selected = null;
      this.recomputeBuffs();
      return refund;
    }

    towerPos(t) {
      if (t.calc.orbit) {
        return { x: t.x + Math.cos(t.orbitAngle) * t.calc.orbit, y: t.y + Math.sin(t.orbitAngle) * t.calc.orbit };
      }
      return t;
    }

    recomputeBuffs() {
      /* Fresh Catch takes the BEST vendor's rate rather than the sum — a
         per-kill bounty that stacked would just be vendor spam by another name. */
      this.bountyBonus = 0;
      this.costMult = 1;
      this.waveBonus = 0;
      for (const t of this.towers) {
        const c = t.calc;
        if (c.bountyBonus) this.bountyBonus = Math.max(this.bountyBonus, c.bountyBonus);
        /* Bulk Orders and Cold Storage take the BEST stall rather than the
           sum, for the same reason Fresh Catch does: a discount that stacked
           would just be vendor spam wearing a different hat, and two of them
           would be worth more than the vendors themselves. */
        if (c.buildDiscount) this.costMult = Math.min(this.costMult, 1 - c.buildDiscount);
        if (c.waveBonus) this.waveBonus = Math.max(this.waveBonus, c.waveBonus);
      }
      this.deathZoners = this.towers.filter((t) => t.calc.zoneAt === 'death');
      /* Auras used to add up flat and without limit, so the winning move was
         simply to build more of them: a real board reached x7 attack speed and
         x2.65 range on one Bro, and 44% of it was support towers. Now each
         extra source of the same buff counts for HALF the one before it (so a
         second drummer is worth 50%, a third 25%) and every channel has a hard
         ceiling. One excellent aura tower gets you most of the way; a wall of
         them gets you almost nothing more. */
      const inbox = new Map();
      for (const t of this.towers) inbox.set(t, { dmg: [], rate: [], range: [], shred: [], pierce: [], stealth: false, arcs: false });
      for (const s of this.towers) {
        const c = s.calc;
        // aura sources: dedicated aura towers, plus any unit carrying aura stats (heroes)
        if (c.kind !== 'aura' && !c.auraDmg && !c.auraRate && !c.auraRange && !c.auraStealth
            && !c.auraShred && !c.auraPierce && !c.auraArcs) continue;
        /* An aura's reach is the tower's own, unless it says otherwise. The
           Mech Cannon's Firebase is why: his shells carry 320, and using
           that as the circle would have steadied every Bro on the map. */
        const ar = c.auraR || c.range;
        const r2 = ar * ar;
        for (const t of this.towers) {
          if (t === s || t.calc.kind === 'aura' || t.calc.kind === 'income') continue;
          // Scout Tilly's Pack Scout lends her eyes to Knights and no one else
          if (c.auraClass && G.TOWERS[t.type].cls !== c.auraClass) continue;
          if (dist2(s.x, s.y, t.x, t.y) > r2) continue;
          const k = inbox.get(t);
          if (c.auraDmg) k.dmg.push(c.auraDmg);
          if (c.auraRate) k.rate.push(c.auraRate);
          if (c.auraRange) k.range.push(c.auraRange);
          if (c.auraShred) k.shred.push(c.auraShred);
          if (c.auraPierce) k.pierce.push(c.auraPierce);
          if (c.auraStealth) k.stealth = true;
          if (c.auraArcs) k.arcs = true;
        }
      }
      // strongest source in full, then halving: converges to 2x the best one
      const stack = (arr) => {
        arr.sort((a, b) => b - a);
        let f = 1, total = 0;
        for (const v of arr) { total += v * f; f *= 0.5; }
        return total;
      };
      /* Which obstacles could possibly stand between this tower and something
         it can reach? Towers and terrain are both static, so this is settled
         here rather than in the per-frame targeting loop. Most towers get an
         empty list and skip the sight test entirely. */
      for (const t of this.towers) {
        // Fire Control puts a spotter overhead: helpers stop caring about cover
        if (G.arcsOverTerrain(t.calc) || inbox.get(t).arcs) { t.los = null; continue; }
        const reach = (t.calc.range || 0) * 1.5 + 40;
        t.los = this.sightBlockers.filter(
          (o) => dist2(t.x, t.y, o.x, o.y) <= (reach + o.r) ** 2);
        if (!t.los.length) t.los = null;
      }

      for (const t of this.towers) {
        const k = inbox.get(t);
        t.buff = {
          dmg: Math.min(G.AURA_CAP.dmg, 1 + stack(k.dmg)),
          rate: Math.min(G.AURA_CAP.rate, 1 + stack(k.rate)),
          range: Math.min(G.AURA_CAP.range, 1 + stack(k.range)),
          shred: Math.min(G.AURA_CAP.shred, stack(k.shred)),
          pierce: Math.min(G.AURA_CAP.pierce, Math.round(stack(k.pierce))),
          stealth: k.stealth,
        };
      }
    }

    /* ----- waves ----- */
    startWave() {
      if (this.waveInProgress || this.over) return;
      this.nextWaveIn = null;
      const spec = G.generateWave(this.levelIdx, this.wave);
      this.waveReward = spec.reward;
      this.spawnQueue = [];
      let t = 0.35, firstGroup = true;
      for (const grp of spec.groups) {
        if (!firstGroup) t += grp.delay || 0; // first group marches immediately
        firstGroup = false;
        for (let i = 0; i < grp.count; i++) {
          let pathIdx = 0;
          if (this.paths.length > 1) {
            pathIdx = grp.path === 'alt' ? (this._altPath = 1 - this._altPath) : (grp.path || 0);
          }
          this.spawnQueue.push({ type: grp.type, t, pathIdx, hpMult: grp.hpMult || 1 });
          t += grp.spacing;
        }
      }
      this.waveInProgress = true;
      this.waveTime = 0;
      this.refreshHero();   // endless strength moves with the wave number
      for (const t of this.towers) {
        // Shield Dome is once per wave; Drum Solo opens every one of them
        if (t.calc.dome) t.domeUsed = false;
        if (t.calc.solo) this.pushTempAura('solo' + t.id, G.W / 2, G.H / 2, 99999, t.calc.solo.rate, t.calc.solo.d);
      }
      this.emit('waveStart', this.wave);
    }

    spawnEnemy(type, pathIdx, dist, hpMult) {
      const def = G.ENEMIES[type];
      const hp = Math.ceil(def.hp * this.level.hpMult * (hpMult || 1));
      this.enemies.push({
        id: nextId++, type, pathIdx, dist,
        hp, maxHp: hp, hpMult: hpMult || 1,
        speed: def.speed * this.level.speedMult * (this.endless ? G.endlessSpeed(this.wave) : 1),
        armor: def.armor, stealth: def.stealth, regen: def.regen,
        size: def.size, rank: def.rank, boss: !!def.boss, heavy: !!def.heavy,
        slowF: 1, slowUntil: 0, dotDps: 0, dotUntil: 0, stunUntil: 0, revealUntil: 0,
        vulnAmt: 0, vulnUntil: 0, bleedPct: 0, bleedUntil: 0, frostHits: 0,
        wob: Math.random() * Math.PI * 2,
      });
    }

    /* ----- combat helpers ----- */
    canSee(tower, e) {
      if (!e.stealth || e.revealUntil > this.time) return true;
      return !!(tower.calc.stealth || tower.buff.stealth);
    }

    /* Is the firing line clear of standing terrain? `list` is normally the
       tower's own prefiltered obstacles (see recomputeBuffs) so this is a
       handful of tests, not a sweep of the whole battlefield. */
    sightClear(ax, ay, bx, by, list) {
      const obs = list || this.sightBlockers;
      for (let i = 0; i < obs.length; i++) {
        const o = obs[i];
        if (segHitsCircle(ax, ay, bx, by, o.x, o.y, o.r2)) return false;
      }
      return true;
    }

    /* Some upgrades take the choice out of the player's hands: Spotter's Eye
       and Hunter-Killer are bought precisely so the Bro stops wasting
       shots on pups, so they override the targeting toggle. */
    targetMode(t) { return t.calc.forceTarget || t.target; }

    targetKey(mode, e, d2) {
      switch (mode) {
        case 'last':   return -e.dist;
        case 'strong': return e.rank * 1e6 + e.hp;
        case 'close':  return -d2;
        default:       return e.dist; // first
      }
    }

    pickTarget(t, pos, range) {
      const r2 = range * range;
      let best = null, bestKey = -Infinity;
      const minR2 = (t.calc.minRange || 0) ** 2;
      const mode = this.targetMode(t);
      for (const e of this.enemies) {
        if (e.dead || !this.canSee(t, e)) continue;
        const ep = samplePath(this.paths[e.pathIdx], e.dist);
        const d2 = dist2(pos.x, pos.y, ep.x, ep.y);
        if (d2 > r2 || d2 < minR2) continue;
        // a ridge or boulder in the way means no shot (howitzers and storms arc)
        if (t.los && !this.sightClear(pos.x, pos.y, ep.x, ep.y, t.los)) continue;
        const key = this.targetKey(mode, e, d2);
        if (key > bestKey) { bestKey = key; best = { e, ep, d2 }; }
      }
      return best;
    }

    /* The same sweep, but keeping the best N distinct vacuums — Double
       Launcher and Twin Sparks exist to stop two shots landing on one body.
       Builds a list, so it is only called by the handful of towers that need
       it rather than by every Bro every shot. */
    pickTargets(t, pos, range, n) {
      const r2 = range * range;
      const minR2 = (t.calc.minRange || 0) ** 2;
      const mode = this.targetMode(t);
      const out = [];
      for (const e of this.enemies) {
        if (e.dead || !this.canSee(t, e)) continue;
        const ep = samplePath(this.paths[e.pathIdx], e.dist);
        const d2 = dist2(pos.x, pos.y, ep.x, ep.y);
        if (d2 > r2 || d2 < minR2) continue;
        if (t.los && !this.sightClear(pos.x, pos.y, ep.x, ep.y, t.los)) continue;
        out.push({ e, ep, d2, key: this.targetKey(mode, e, d2) });
      }
      out.sort((a, b) => b.key - a.key);
      return out.slice(0, n);
    }

    /* ----- what each Parts Trader actually pays at the end of a wave -----
       Richest stall first, and every vendor after it earns G.VENDOR_FALLOFF of
       the one before — a second is worth 0.7 of the first, a third 0.49. Left
       uncapped, stacking vendors was a money printer.

       This is a method rather than a loop inside update() because the dock
       panel has to quote the same figure the wave will actually pay. When the
       two were separate, the panel advertised the vendor's full income and the
       player was quietly handed less, with nothing on screen to explain it. */
    vendorPayouts() {
      const vendors = this.towers
        .filter((t) => t.calc.kind === 'income')
        .sort((a, b) => (b.calc.income || 0) - (a.calc.income || 0));
      const out = [];
      let share = 1;
      let cash = this.cash;   // interest compounds down the list, as it pays out
      for (const t of vendors) {
        const c = t.calc;
        let pay = c.income || 0;
        // Trade Hub: pays per Bro standing in this vendor's circle
        if (c.tradeHub) {
          const r2 = (c.range || 0) ** 2;
          let near = 0;
          for (const o of this.towers) {
            if (o !== t && o.calc.kind !== 'income' && dist2(t.x, t.y, o.x, o.y) <= r2) near++;
          }
          pay += c.tradeHub * near;
        }
        if (c.interest) pay += Math.min(250, Math.round(cash * c.interest));
        /* Krill Konglomerate sells at full price whatever its rank. It still
           OCCUPIES a rank — the stalls beneath it are undercut exactly as
           before — it simply refuses to be undercut itself. */
        const sh = c.noFalloff ? 1 : share;
        const got = Math.round(pay * sh);
        out.push({ tower: t, rank: out.length + 1, share: sh, full: pay, got });
        cash += got;
        share *= G.VENDOR_FALLOFF;
      }
      return out;
    }

    /* How many mystic curses are riding on this vacuum right now — chill,
       rot and the vulnerability mark. Read by the Spark Mage's Resonance,
       which pays out for arriving second. Warden Kell's Corrosion leaves a rot,
       so it counts here without needing a case of its own. */
    debuffCount(e) {
      let n = 0;
      if (e.slowUntil > this.time) n++;
      if (e.dotUntil > this.time) n++;
      if (e.vulnUntil > this.time) n++;
      return n;
    }

    damageEnemy(e, rawDmg, tower, opts) {
      opts = opts || {};
      const c = tower ? tower.calc : {};
      let dmg = rawDmg * (tower ? tower.buff.dmg : 1);
      // boss-killers earn their price against heavies too — see G.isHeavyweight
      if (c.bossBonus && G.isHeavyweight(e)) dmg *= c.bossBonus;
      // Stonebreaker: a brick aimed at the plates rather than around them
      if (c.vsArmored && e.armor > 0) dmg *= c.vsArmored;
      if (c.resonance) dmg += c.resonance * this.debuffCount(e);
      /* Killing Strike — the game's only random damage roll, deliberately
         capstone-priced. A shuriken that finds something hiding always lands
         the crit, which is the Shadow Diver's whole reason to see stealth. */
      if (c.crit && ((c.crit.stealthAlways && e.stealth) || Math.random() < c.crit.p)) dmg *= c.crit.mult;
      if (!opts.pure && !c.armorPierce) {
        // Heroic Ballad and friends let nearby Bros punch through casing
        const armor = Math.max(0, e.armor - (tower ? tower.buff.shred || 0 : 0));
        /* Armour can strip at most 90% of a shot, never all of it. This used to
           be a flat "at least 1 damage", which quietly rescued every weak shot
           and made "+1 damage" upgrades pointless against heavy armour: a
           2-damage and a 3-damage Bro both dealt exactly 1 through 3
           armour, so the upgrade you just paid for changed nothing. A
           proportional floor keeps the original intent (no shot is ever
           completely wasted) while letting the upgrade matter. Shots with no
           damage at all (the Slush Thrower is a pure slow) still deal
           nothing. */
        dmg = rawDmg > 0 ? Math.max(dmg * 0.1, dmg - armor) : 0;
      }
      /* Vulnerability marks multiply LAST, after armour, because that is what
         "+30% damage from every source" has to mean to be worth its price —
         marking a Floor Buffer should raise the damage that actually lands on it,
         not the damage its casing then eats. */
      if (e.vulnUntil > this.time) dmg *= 1 + e.vulnAmt;
      e.hp -= dmg;
      if (tower && c.fx) this.applyFx(e, c.fx);
      /* Prism Conduit and Miasma: what the bolt does to the vacuums the bolt
         did not hit. Kept here rather than at each firing site so every weapon
         kind the Spark Mage and Hex Witch can become carries it. */
      if (c.conduit) this.spreadCurse(e, c.conduit);
      if (c.miasma && c.fx) this.splashFx(e, c.miasma, c.fx);
      if (e.hp <= 0) this.killEnemy(e, tower);
      return dmg;
    }

    /* Prism Conduit — hold the curses already on the victim open a little
       longer, and pass one of them to whoever is standing nearest. */
    spreadCurse(e, radius) {
      if (e.slowUntil > this.time) e.slowUntil += 1;
      if (e.dotUntil > this.time) e.dotUntil += 1;
      if (e.vulnUntil > this.time) e.vulnUntil += 1;
      const carry = {};
      if (e.dotUntil > this.time && e.dotDps) carry.dot = { dps: e.dotDps, d: 2 };
      else if (e.slowUntil > this.time) carry.slow = { f: e.slowF, d: 2 };
      else if (e.vulnUntil > this.time) carry.mark = { amt: e.vulnAmt, d: 2 };
      else return;
      const ep = samplePath(this.paths[e.pathIdx], e.dist);
      let best = null, bd = radius * radius;
      for (const o of this.enemies) {
        if (o === e || o.dead) continue;
        const op = samplePath(this.paths[o.pathIdx], o.dist);
        const d2 = dist2(ep.x, ep.y, op.x, op.y);
        if (d2 < bd) { bd = d2; best = o; }
      }
      if (best) this.applyFx(best, carry);
    }

    // Miasma — the curse alone, splashed onto the bodies pressed against the target
    splashFx(e, radius, fx) {
      const ep = samplePath(this.paths[e.pathIdx], e.dist);
      const r2 = radius * radius;
      for (const o of this.enemies) {
        if (o === e || o.dead) continue;
        const op = samplePath(this.paths[o.pathIdx], o.dist);
        if (dist2(ep.x, ep.y, op.x, op.y) <= r2) this.applyFx(o, fx);
      }
    }

    applyFx(e, fx) {
      /* Deep endless packs shrug off the chill (and the ice) — without this a
         wave-150 vacuum sits pinned at a third speed forever and the wave
         never resolves. Bosses resist on top of that, as they always did. */
      const resist = this.endless ? G.slowResist(this.wave) : 0;
      const soften = (f) => 1 - (1 - f) * (1 - resist);
      if (fx.slow) {
        const f = e.boss ? soften(1 - (1 - fx.slow.f) * 0.4) : soften(fx.slow.f);
        const dur = fx.slow.d * (e.boss ? 0.6 : 1) * (1 - resist * 0.5);
        if (f < e.slowF || e.slowUntil <= this.time) e.slowF = f;
        e.slowUntil = Math.max(e.slowUntil, this.time + dur);
      }
      if (fx.dot) {
        e.dotDps = Math.max(e.dotDps, fx.dot.dps);
        e.dotUntil = Math.max(e.dotUntil, this.time + fx.dot.d);
      }
      if (fx.shred && e.armor > 0) e.armor = Math.max(0, e.armor - fx.shred);
      /* Solar Judgment strips one plate a SECOND, not one per beam tick — the
         Sun Priest fires four times a second, so a plain shred would have
         peeled an Central Unit bare in a second and a quarter. */
      if (fx.shredPerSec && e.armor > 0 && (e.shredReady || 0) <= this.time) {
        e.armor = Math.max(0, e.armor - fx.shredPerSec);
        e.shredReady = this.time + 1;
      }
      // Deep Chill: slush holds a vacuum open, so every freeze that lands sticks longer
      if (fx.frostbite) { e.frostMul = fx.frostbite; e.frostMulUntil = this.time + 3; }
      if (fx.stun) this.stunEnemy(e, fx.stun, resist);
      /* The freeze meter. A counter on the victim rather than a chance roll,
         because "the third hit freezes it solid" was the whole Boulder Knight
         fantasy and a 33% chance is a different, worse promise. */
      if (fx.freezeMeter) {
        e.frostHits = (e.frostHits || 0) + 1;
        if (e.frostHits >= fx.freezeMeter.hits) {
          e.frostHits = 0;
          this.stunEnemy(e, fx.freezeMeter.stun, resist);
        }
      }
      /* Vulnerability marks. One field on the vacuum and one multiply where
         damage is dealt — six capstones share it. The strongest mark wins
         rather than adding, so stacking two markers is coverage, not a combo. */
      if (fx.mark) {
        if (e.vulnUntil <= this.time || fx.mark.amt >= e.vulnAmt) e.vulnAmt = fx.mark.amt;
        e.vulnUntil = Math.max(e.vulnUntil || 0, this.time + fx.mark.d);
      }
      /* Knockback. A vacuum's progress is a distance along the track, so
         knocking it back is a subtraction — the field has simply never been
         written to before. Bosses budge a third as far. */
      if (fx.knock && (fx.knock.p >= 1 || Math.random() < fx.knock.p)) {
        const back = fx.knock.d * (G.isHeavyweight(e) ? 0.35 : 1) * (1 - resist);
        if (back > 0) {
          e.dist = Math.max(0, e.dist - back);
          this.effects.push({ kind: 'knock', e, life: 0.25, max: 0.25 });
        }
      }
      // Extractor Lance: bosses only. Stacks refresh the bleed, they don't multiply it.
      if (fx.bleed && G.isHeavyweight(e)) {
        e.bleedPct = Math.max(e.bleedPct || 0, fx.bleed.pct);
        e.bleedUntil = Math.max(e.bleedUntil || 0, this.time + fx.bleed.d);
      }
    }

    stunEnemy(e, secs, resist) {
      const boost = (e.frostMulUntil || 0) > this.time ? e.frostMul : 1;
      e.stunUntil = Math.max(e.stunUntil, this.time + secs * boost * (G.isHeavyweight(e) ? 0.25 : 1) * (1 - (resist || 0)));
    }

    /* ----- ground zones -----
       Lay a patch on the track. `r: 0` in the definition means "as wide as the
       Bro reaches", which is what the ring capstones (Hailfield, The
       Anchored Eye) want. The list is capped because a fast Bro with a
       short-lived zone can otherwise put hundreds down inside a second. */
    dropZone(tower, x, y, radius) {
      const z = tower.calc.zone;
      if (!z) return;
      const r = radius || z.r || (tower.calc.range || 60) * tower.buff.range;
      const tone = z.tone || 'ice';
      /* Refresh a patch that is already here rather than stacking another one
         on top of it. Two identical circles in the same place cannot do more
         than one — every zone effect takes the strongest, not the sum — so the
         second was pure cost, and there were a lot of seconds: Hailfield and
         The Anchored Eye re-lay the same full-range ring on every shot, and Icy
         Wake drops one every 30px of a roll whose radius is 34.

         They are translucent circles, so the cost is fill rate and it lands on
         the GPU rather than in any JS profile: a measured board of forty
         full-range patches was spending 6.3ms of a 16.7ms frame painting the
         same ground over and over. */
      for (const o of this.zones) {
        if (o.tone !== tone || Math.abs(o.r - r) > 2) continue;
        if (dist2(o.x, o.y, x, y) > (r * 0.35) ** 2) continue;
        o.until = this.time + z.life;
        return;
      }
      this.zones.push({
        x, y, r, until: this.time + z.life, life: z.life,
        slowF: z.slowF, dps: z.dps, curse: z.curse ? tower.calc.fx : null,
        stick: z.stick, tone, hit: null,
      });
      /* A ceiling, because Icy Wake lays one every 30px a snowball rolls and a
         board of zone-makers reached 90 live patches on a measured endless run.
         Dropping the OLDEST is the right eviction here: on a wake that is the
         patch furthest behind the roll, the one already being left behind.
         160 keeps that run clear of the cap; the per-frame cost of even a full
         list is a rounding error beside the frame budget. */
      if (this.zones.length > 160) this.zones.splice(0, this.zones.length - 160);
    }

    /* Buffs with a clock on them — the Brick Fort's breach alarm, the War Drummer's
       opening solo. Refreshed rather than duplicated, so an alarm that keeps
       tripping stays one entry. */
    pushTempAura(key, x, y, r, rate, dur) {
      let a = this.tempAuras.find((v) => v.key === key);
      if (!a) { a = { key, x, y, r, rate, until: 0 }; this.tempAuras.push(a); }
      a.x = x; a.y = y; a.r = r; a.rate = rate;
      a.until = Math.max(a.until, this.time + dur);
    }

    tempRate(t) {
      let m = 1;
      for (const a of this.tempAuras) {
        if (a.until <= this.time) continue;
        if (dist2(a.x, a.y, t.x, t.y) > a.r * a.r) continue;
        m *= a.rate;
      }
      return m;
    }

    /* ----- a Bro's second job, on its own clock -----
       Shard Bulwark, Drift Mines and Decoy Dive all put something on the track
       while the Bro keeps shooting, and Thunder Drums staggers on a beat
       the drummer does not otherwise have. One timer serves all four. */
    auxTick(t, dt) {
      const a = t.calc.aux;
      if (!a) return;
      t.auxCd = (t.auxCd == null ? a.every : t.auxCd) - dt;
      if (t.auxCd > 0) return;
      t.auxCd = a.every;
      const range = (t.calc.range || 0) * t.buff.range;

      if (a.kind === 'stagger') {
        const r2 = range * range;
        let any = false;
        for (const e of this.enemies) {
          if (e.dead) continue;
          const ep = samplePath(this.paths[e.pathIdx], e.dist);
          if (dist2(t.x, t.y, ep.x, ep.y) > r2) continue;
          this.stunEnemy(e, a.stun, this.endless ? G.slowResist(this.wave) : 0);
          any = true;
        }
        if (any) this.effects.push({ kind: 'storm', x: t.x, y: t.y, r: range, life: 0.3, max: 0.3 });
        return;
      }

      const mine = this.piles.filter((p) => p.owner === t.id);
      if (mine.length >= (a.maxPiles || 3)) return;
      const spot = this.pickTrackSpot(t, range);
      if (!spot) return;
      this.piles.push({
        x: spot.x, y: spot.y, owner: t.id,
        charges: a.charges, damage: a.mine ? Math.round((t.calc.damage || 1) * a.mine.mult) : (a.damage || 0),
        chill: a.chill, hold: a.hold, decoy: a.decoy,
        mine: a.mine ? a.mine.blast : 0,
      });
    }

    // somewhere on the track this Bro can actually reach
    pickTrackSpot(t, range) {
      const pos = this.towerPos(t);
      const spots = [];
      for (const path of this.paths) {
        for (let d = 30; d < path.total - 30; d += 26) {
          const p = samplePath(path, d);
          if (dist2(pos.x, pos.y, p.x, p.y) <= range * range) spots.push(p);
        }
      }
      return spots.length ? spots[(Math.random() * spots.length) | 0] : null;
    }

    killEnemy(e, tower) {
      if (e.dead) return;
      e.dead = true;
      this.kills++;                                     // leaks never reach here
      this.rankXp += this.endless ? G.ENDLESS_RANK_XP : 1;
      if (tower) tower.kills = (tower.kills || 0) + 1;
      /* Hero XP. Every vacuum the workshop fells counts, not only the ones the
         hero shot — the hero is the champion the workshop fights around, and
         crediting only its own kills would punish the two support heroes for
         doing their job. But it must be ON THE FIELD to earn: this is what
         "waves cleared while placed" used to mean. */
      if (this.heroTower) {
        this.heroKills++;
        if (G.heroLevelFor(this.heroKills) > this.heroLevel) {
          this.refreshHero();
          this.emit('heroLevel', this.heroLevel);
        }
      }
      const def = G.ENEMIES[e.type];
      const bounty = Math.max(1, Math.round(def.bounty * (this.level.bountyMult || 1) * G.PERK.bounty)
        + (this.bountyBonus || 0));   // Fresh Catch
      this.cash += bounty;
      this.texts.push({ x: 0, y: 0, e, txt: '+' + bounty + '🔩', life: 0.9, kind: 'cash' });
      // plague spread (Hex Witch — Plague of Rust)
      if (tower && tower.calc.plague && e.dotDps > 0) {
        const ep = samplePath(this.paths[e.pathIdx], e.dist);
        for (const o of this.enemies) {
          if (o === e || o.dead) continue;
          const op = samplePath(this.paths[o.pathIdx], o.dist);
          if (dist2(ep.x, ep.y, op.x, op.y) < 70 * 70) this.applyFx(o, { dot: { dps: e.dotDps, d: 2 } });
        }
      }
      /* Corrupted Ground — a vacuum that dies CURSED stains the track. It
         asks the BOARD whether a witch is running the stain, not whoever landed
         the killing blow: the likeliest way to die cursed is to die OF the
         curse, and a rot tick kills with no tower credited at all. Hanging this
         off the killer would have made the capstone fire least in exactly the
         case it was bought for. The rot check stays — it is the curse that
         soaks in, so a witch who has not landed one leaves nothing behind. */
      if (this.deathZoners && this.deathZoners.length && e.dotUntil > this.time) {
        const dp = samplePath(this.paths[e.pathIdx], e.dist);
        this.dropZone(this.deathZoners[0], dp.x, dp.y);
      }
      for (let i = 0; i < def.children.length; i++) {
        this.spawnEnemy(def.children[i], e.pathIdx, Math.max(0, e.dist - 14 * (i + 1)), e.hpMult);
      }
      const ep = samplePath(this.paths[e.pathIdx], e.dist);
      this.effects.push({ kind: e.boss ? 'bossDeath' : 'pop', x: ep.x, y: ep.y, r: e.size, life: e.boss ? 0.8 : 0.3, max: e.boss ? 0.8 : 0.3, color: def.color });
      if (e.boss) this.emit('bossDown', def.name);
    }

    /* ----- Heavies devour the packs -----
       Any ordinary vacuum that drifts into an heavy's jaws is swallowed
       whole. The player gets nothing for it — no bounty, no XP, no splits,
       and no life lost either; the vacuum simply ceases. The heavy heals,
       but each meal is capped at a small slice of its own maximum, so a
       feeding heavy is a stalling problem rather than an immortal one.
       Starving it — clearing the chaff first — is the counter-play. */
    heavyEat() {
      let fed = false;
      for (const o of this.enemies) {
        if (o.dead || !o.heavy) continue;
        const maw = o.size * 0.9;
        const rate = G.ENEMIES[o.type].eat || 0.015;
        /* Total healing is capped at 60% of the heavy's own maximum, however
           rich the pack is. Without it a big enough shoal could keep one
           topped up indefinitely; with it, feeding buys time and nothing more. */
        const budget = o.maxHp * 0.6 - (o.healed || 0);
        if (budget <= 0) continue;
        for (const e of this.enemies) {
          if (e.dead || e === o || e.heavy || e.boss) continue;
          if (e.pathIdx !== o.pathIdx) continue;
          if (e.rank > G.EDIBLE_RANK) continue;         // too big to swallow
          if (Math.abs(e.dist - o.dist) > maw) continue;
          e.dead = true;
          e.devoured = true;                            // pays nothing, splits nothing
          /* The heal is a slice of the HEAVY's bulk, not the meal's — late-game
             vacuums are crumbs beside a Great Heavy, so scaling off the meal
             made this inert exactly where it mattered. Bigger prey still feeds
             better: a Brute is worth roughly twice a Pup. */
          const meal = o.maxHp * rate * (0.35 + 0.65 * (e.rank / G.EDIBLE_RANK));
          /* Only healing actually applied is charged against the budget — an
             unhurt heavy still swallows the vacuum, it just banks nothing,
             so a healthy one can't be "fed empty" before the shooting starts. */
          const given = Math.max(0, Math.min(meal, o.maxHp * 0.6 - (o.healed || 0), o.maxHp - o.hp));
          o.healed = (o.healed || 0) + given;
          o.hp += given;
          const ep = samplePath(this.paths[e.pathIdx], e.dist);
          this.effects.push({ kind: 'devour', x: ep.x, y: ep.y, r: e.size, life: 0.45, max: 0.45 });
          fed = true;
        }
      }
      if (fed) this.emit('devour');
    }

    /* What a burst leaves behind. Zones and cluster children both hang off the
       moment of impact, and both a lobbed shell and an exploding bullet reach
       it, so they share one door rather than each firing site remembering. */
    onImpact(tower, pr, x, y) {
      if (!tower) return;
      const c = tower.calc;
      if (c.zone && !c.zoneAt) this.dropZone(tower, x, y);
      // Cluster Load: the chunk cracks apart and the halves fly on. Children
      // never cluster again, or one shell would seed an endless cascade.
      if (c.cluster && !pr.child) {
        const near = this.pickTargets(tower, { x, y }, (c.splash || 60) * 3.2, c.cluster.n + 1)
          .filter((s) => !s.e.dead);
        let made = 0;
        for (const s of near) {
          if (made >= c.cluster.n) break;
          made++;
          this.projectiles.push({
            kind: 'lob', sx: x, sy: y, tx: s.ep.x, ty: s.ep.y,
            t: 0, T: 0.3, splash: (pr.splash || 40) * 0.7, damage: pr.damage * c.cluster.frac,
            pierce: pr.pierce, owner: tower.id, child: true,
          });
        }
      }
    }

    /* Ricochet — the brick comes off the shell into whoever is standing close.
       No new projectile: the bounce lands where it lands, which is what the
       player sees, and a spawned brick would have to be aimed at a body that
       may already be dead by the time it arrives. */
    ricochet(tower, pr, from, fp) {
      let left = tower.calc.ricochet;
      const struck = [from];
      while (left-- > 0) {
        let best = null, bd = 95 * 95;
        for (const o of this.enemies) {
          if (o.dead || struck.includes(o) || pr.hit.includes(o.id) || !this.canSee(tower, o)) continue;
          const op = samplePath(this.paths[o.pathIdx], o.dist);
          const d2 = dist2(fp.x, fp.y, op.x, op.y);
          if (d2 < bd) { bd = d2; best = { o, op }; }
        }
        if (!best) break;
        struck.push(best.o);
        this.effects.push({ kind: 'hit', x: best.op.x, y: best.op.y, life: 0.12, max: 0.12 });
        this.damageEnemy(best.o, pr.damage, tower);
        fp = best.op;
      }
    }

    /* `bite` is the hero-ability share-of-the-animal (see G.heroBite): a
       fraction of a heavyweight's own maximum health, added on top of the flat
       damage and only for the two abilities that reach their targets through a
       splash. `bitten` is an optional Set that survives across the several
       blasts of one cast, so a boss standing inside two of them takes the
       percentage once and the flat twice — which is how the flat has always
       behaved and how a percentage plainly must not. */
    splashAt(x, y, radius, dmg, tower, maxHit, exclude, bite, bitten) {
      const r2 = radius * radius;
      let hits = 0;
      // sort by distance so the closest are hit when capped
      const inRange = [];
      for (const e of this.enemies) {
        if (e.dead || e === exclude) continue;
        const ep = samplePath(this.paths[e.pathIdx], e.dist);
        const d2 = dist2(x, y, ep.x, ep.y);
        if (d2 <= r2) inRange.push({ e, d2 });
      }
      inRange.sort((a, b) => a.d2 - b.d2);
      for (const { e } of inRange) {
        if (hits >= maxHit) break;
        let extra = 0;
        if (bite && !(bitten && bitten.has(e))) {
          extra = G.heroBite(e, bite, dmg);
          if (bitten) bitten.add(e);
        }
        this.damageEnemy(e, dmg + extra, tower);
        hits++;
      }
      this.effects.push({ kind: 'boom', x, y, r: radius, life: 0.35, max: 0.35 });
    }

    frenzyMult() { return this.time < this.frenzyUntil ? 1.5 : 1; }

    /* ----- Second Chance: revive after defeat (brick cost handled by the UI).
       Clears the field and restores full lives; the fatal wave replays. ----- */
    retry() {
      if (this.over !== 'lose') return false;
      this.over = null;
      this.lives = this.startLives;
      this.enemies = [];
      this.projectiles = [];
      this.zones = [];
      this.tempAuras = [];
      this.spawnQueue = [];
      this.waveInProgress = false;
      this.waveTime = 0;
      this.nextWaveIn = null;
      this.autoStart = false; // no instant re-send — let the player regroup
      return true;
    }

    /* ----- Endless Shift: keep playing past the final scripted wave.
       The victory is already banked; from here waves scale without end. ----- */
    goEndless() {
      if (this.over !== 'win') return false;
      this.over = null;
      this.endless = true;
      this.autoStart = false; // let the player take a breath first
      this.nextWaveIn = null;
      return true;
    }

    /* ----- power-ups (brick accounting lives in the UI) ----- */
    usePower(id) {
      if (this.over) return { ok: false, msg: 'The battle is over.' };
      switch (id) {
        case 'studdump':
          this.cash += 600;
          return { ok: true };
        case 'icespikes':
          for (const path of this.paths) {
            const p = samplePath(path, Math.max(30, path.total - 130));
            this.piles.push({ x: p.x, y: p.y, charges: 40, damage: 10, owner: -2 });
          }
          return { ok: true };
        case 'frenzy':
          this.frenzyUntil = this.time + 15;
          return { ok: true };
        case 'freeze':
          for (const e of this.enemies) {
            if (e.dead) continue;
            e.stunUntil = Math.max(e.stunUntil, this.time + (e.boss ? 1.5 : 4));
          }
          this.effects.push({ kind: 'storm', x: G.W / 2, y: G.H / 2, r: 620, life: 0.6, max: 0.6 });
          return { ok: true };
        case 'heal':
          this.lives += 25;
          return { ok: true };
        case 'avalanche':
          for (const e of [...this.enemies]) {
            if (!e.dead) this.damageEnemy(e, 60, null, { pure: true });
          }
          this.effects.push({ kind: 'boom', x: G.W / 2, y: G.H / 2, r: 420, life: 0.4, max: 0.4 });
          return { ok: true };
      }
      return { ok: false, msg: 'Unknown power.' };
    }

    /* ----- firing ----- */
    fireTower(t, dt) {
      const c = t.calc;
      if (c.kind === 'income' || c.kind === 'aura') return;
      t.cooldown -= dt;
      if (t.cooldown > 0) return;
      const pos = this.towerPos(t);
      const range = c.range * t.buff.range;

      if (c.kind === 'spikes') {
        const mine = this.piles.filter((p) => p.owner === t.id);
        if (mine.length >= c.maxPiles) return;
        const p = this.pickTrackSpot(t, range);
        if (!p) return;
        this.piles.push({
          x: p.x, y: p.y, charges: c.charges, max: c.charges, damage: c.spikeDmg, owner: t.id,
          shred: c.spikeShred || 0, regrow: c.regrow || 0,
        });
        // Frozen Frontier: the wall goes up in a flash of frost
        if (c.pileFlash) {
          for (const e of this.enemies) {
            if (e.dead) continue;
            const ep = samplePath(this.paths[e.pathIdx], e.dist);
            if (dist2(p.x, p.y, ep.x, ep.y) <= 70 * 70) this.applyFx(e, { slow: c.pileFlash });
          }
          this.effects.push({ kind: 'storm', x: p.x, y: p.y, r: 70, life: 0.35, max: 0.35 });
        }
        t.cooldown = 1 / (c.rate * t.buff.rate * this.frenzyMult() * this.tempRate(t));
        return;
      }

      if (c.kind === 'pulse') {
        let any = false;
        const r2 = range * range;
        for (const e of this.enemies) {
          if (e.dead || !this.canSee(t, e)) continue;
          const ep = samplePath(this.paths[e.pathIdx], e.dist);
          if (dist2(pos.x, pos.y, ep.x, ep.y) <= r2) { any = true; break; }
        }
        if (!any) return;
        for (const e of [...this.enemies]) {
          if (e.dead || !this.canSee(t, e)) continue;
          const ep = samplePath(this.paths[e.pathIdx], e.dist);
          if (dist2(pos.x, pos.y, ep.x, ep.y) <= r2) this.damageEnemy(e, c.damage, t);
        }
        this.effects.push({ kind: 'storm', x: pos.x, y: pos.y, r: range, life: 0.5, max: 0.5 });
        // The Anchored Eye: the storm leaves its footprint frozen behind it
        if (c.zone && c.zoneAt === 'self') this.dropZone(t, pos.x, pos.y, range);
        t.lastShot = this.time;
        t.cooldown = 1 / (c.rate * t.buff.rate * this.frenzyMult() * this.tempRate(t));
        return;
      }

      const target = this.pickTarget(t, pos, range);
      if (!target) return;
      t.aim = Math.atan2(target.ep.y - pos.y, target.ep.x - pos.x);
      // Double Launcher, Twin Sparks: one aim point per shot instead of one for all
      const aimPoints = c.multiTarget && (c.shots || 1) > 1
        ? this.pickTargets(t, pos, range, c.shots) : null;

      const shots = c.shots || 1;
      if (c.kind === 'snipe' || c.kind === 'ray') {
        /* Supernova Focus: the beam builds while it stays on one victim and
           drops the moment it switches. Capped at +15 on purpose — deep endless
           would otherwise let a ramp with no ceiling run away entirely. */
        let dmg = c.damage;
        if (c.ramp) {
          if (t.rampOn !== target.e.id) { t.rampOn = target.e.id; t.ramp = 0; }
          else t.ramp = Math.min(c.ramp.max, (t.ramp || 0) + c.ramp.per);
          dmg += t.ramp;
        }
        for (let i = 0; i < shots; i++) {
          this.effects.push({ kind: c.kind === 'ray' ? 'ray' : 'snipeTrack', x: pos.x, y: pos.y, tx: target.ep.x, ty: target.ep.y, life: 0.12, max: 0.12 });
          this.damageEnemy(target.e, dmg, t);
          // Scorched Path: the ground catches light where the beam lands
          if (c.zone && !c.zoneAt) this.dropZone(t, target.ep.x, target.ep.y);
          // Twin Mirrors: the beam splits to a second target at reduced power
          if (c.split) {
            for (const s of this.pickTargets(t, pos, range, 1 + c.split.n)) {
              if (s.e === target.e) continue;
              this.effects.push({ kind: 'ray', x: pos.x, y: pos.y, tx: s.ep.x, ty: s.ep.y, life: 0.12, max: 0.12 });
              this.damageEnemy(s.e, dmg * c.split.frac, t);
            }
          }
          /* chain harpoons / solar lance: bounce to extra targets. These kinds
             fire no projectile, so a pierce aura has to be added here or it
             would silently do nothing for the Laser Sniper and Sun Priest. */
          let extra = (c.pierce || 1) - 1 + (t.buff.pierce || 0), last = target.e;
          while (extra-- > 0) {
            const lp = samplePath(this.paths[last.pathIdx], last.dist);
            let nxt = null, nd = 130 * 130;
            for (const o of this.enemies) {
              if (o.dead || o === last || !this.canSee(t, o)) continue;
              const op = samplePath(this.paths[o.pathIdx], o.dist);
              const d2 = dist2(lp.x, lp.y, op.x, op.y);
              // a bounce also has to make it there — no chaining through a ridge
              if (d2 < nd && (!t.los || this.sightClear(lp.x, lp.y, op.x, op.y, t.los))) { nd = d2; nxt = { o, op }; }
            }
            if (!nxt) break;
            this.effects.push({ kind: 'ray', x: lp.x, y: lp.y, tx: nxt.op.x, ty: nxt.op.y, life: 0.1, max: 0.1 });
            this.damageEnemy(nxt.o, dmg, t);
            last = nxt.o;
          }
          if (target.e.dead) break;
        }
      } else if (c.kind === 'lob') {
        for (let i = 0; i < shots; i++) {
          let tx, ty;
          if (aimPoints) {
            // each charge takes its own clump; falls back to the main target
            const pick = aimPoints[Math.min(i, aimPoints.length - 1)] || target;
            tx = pick.ep.x; ty = pick.ep.y;
          } else if (c.walk) {
            /* Rolling Barrage — three shells WALKED along the track rather than
               scattered around it, so the volley covers a stretch of lane. */
            const path = this.paths[target.e.pathIdx];
            const d = target.e.dist + (i - (shots - 1) / 2) * c.walk;
            const p = samplePath(path, Math.max(0, Math.min(path.total - 1, d)));
            tx = p.x; ty = p.y;
          } else {
            const off = i === 0 ? 0 : 30;
            tx = target.ep.x + (Math.random() - 0.5) * off;
            ty = target.ep.y + (Math.random() - 0.5) * off;
          }
          this.projectiles.push({
            kind: 'lob', sx: pos.x, sy: pos.y, tx, ty,
            t: 0, T: 0.55, splash: c.splash, damage: c.damage, pierce: c.pierce + (t.buff.pierce || 0), owner: t.id,
          });
        }
      } else if (c.kind === 'volley') {
        const n = c.volley;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + t.orbitAngle * 0.1;
          this.projectiles.push({
            kind: 'bullet', x: pos.x, y: pos.y, vx: Math.cos(a) * c.projSpeed, vy: Math.sin(a) * c.projSpeed,
            damage: c.damage, pierce: c.pierce + (t.buff.pierce || 0), splash: c.splash || 0, range, traveled: 0, owner: t.id, hit: [],
          });
        }
        // Hailfield: the whole ring frosts over as the volley goes out
        if (c.zone && c.zoneAt === 'self') this.dropZone(t, pos.x, pos.y, range);
      } else { // bullet | homing
        for (let i = 0; i < shots; i++) {
          let a, aimAt = target.e;
          if (aimPoints) {
            const pick = aimPoints[Math.min(i, aimPoints.length - 1)] || target;
            aimAt = pick.e;
            a = Math.atan2(pick.ep.y - pos.y, pick.ep.x - pos.x);
          } else {
            a = t.aim + (shots > 1 ? (i - (shots - 1) / 2) * 0.14 : 0);
          }
          this.projectiles.push({
            kind: c.kind, x: pos.x, y: pos.y,
            vx: Math.cos(a) * c.projSpeed, vy: Math.sin(a) * c.projSpeed,
            damage: c.damage, pierce: c.pierce + (t.buff.pierce || 0), splash: c.splash || 0,
            range: range * (c.projRange || 1.4), traveled: 0, owner: t.id, targetId: aimAt.id, hit: [],
            grow: c.grow || null, grew: 0, wake: c.zoneAt === 'wake',
          });
        }
        /* Wolfpack Salvo — every third launch, a fan of light torpedoes that
           each pick a different vacuum. Counted per Bro, so two subs do
           not share a rhythm. */
        if (c.salvo && ((t.salvoN = (t.salvoN || 0) + 1) % c.salvo.every === 0)) {
          const fan = this.pickTargets(t, pos, range, c.salvo.n);
          for (let i = 0; i < c.salvo.n; i++) {
            const pick = fan[Math.min(i, fan.length - 1)] || target;
            const a = Math.atan2(pick.ep.y - pos.y, pick.ep.x - pos.x) + (i - (c.salvo.n - 1) / 2) * 0.2;
            this.projectiles.push({
              kind: 'homing', x: pos.x, y: pos.y,
              vx: Math.cos(a) * c.projSpeed, vy: Math.sin(a) * c.projSpeed,
              damage: c.damage * c.salvo.frac, pierce: 1, splash: 0,
              range: range * 1.6, traveled: 0, owner: t.id, targetId: pick.e.id, hit: [], light: true,
            });
          }
        }
      }
      this.effects.push({ kind: 'muzzle', x: pos.x, y: pos.y, a: t.aim, life: 0.14, max: 0.14 });
      t.lastShot = this.time;
      t.cooldown = 1 / (c.rate * t.buff.rate * this.frenzyMult() * this.tempRate(t));
    }

    /* ----- main update ----- */
    update(rawDt) {
      if (this.paused || this.over) return;
      const dt = Math.min(rawDt, 0.05) * this.speed;
      this.time += dt;

      // spawn
      if (this.waveInProgress) {
        this.waveTime += dt;
        while (this.spawnQueue.length && this.spawnQueue[0].t <= this.waveTime) {
          const s = this.spawnQueue.shift();
          this.spawnEnemy(s.type, s.pathIdx, 0, s.hpMult);
        }
      }

      // sonar decloak zones
      const decloakers = this.towers.filter((t) => t.calc.decloak);

      // enemies
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (e.stunUntil > this.time) { /* frozen */ } else {
          const slow = e.slowUntil > this.time ? e.slowF : 1;
          e.dist += e.speed * slow * dt;
        }
        if (e.slowUntil <= this.time) e.slowF = 1;
        if (e.regen && e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + e.regen * dt);
        if (e.dotUntil > this.time) e.hp -= e.dotDps * dt;
        // Extractor Lance: the barb keeps working on the big ones
        if (e.bleedUntil > this.time) e.hp -= e.maxHp * e.bleedPct * dt;
        if (e.hp <= 0) { this.killEnemy(e, null); continue; }
        const path = this.paths[e.pathIdx];
        if (e.dist >= path.total) {
          e.dead = true; e.leaked = true;
          this.lives -= G.ENEMIES[e.type].lives;
          this.effects.push({ kind: 'leak', x: path.pts[path.pts.length - 1].x, y: path.pts[path.pts.length - 1].y, life: 0.5, max: 0.5 });
          this.emit('leak', e.type);
          continue;
        }
        /* One position, three checks. Sampling the track is the hot call in
           this loop, and decloak zones, ground zones and spike piles were all
           asking for it separately. */
        if (!decloakers.length && !this.zones.length && !this.piles.length) continue;
        const ep = samplePath(path, e.dist);

        if (e.stealth && decloakers.length) {
          for (const s of decloakers) {
            if (dist2(s.x, s.y, ep.x, ep.y) > s.calc.range * s.calc.range) continue;
            e.revealUntil = this.time + 0.5;
            // Full Decloak: what the whole crew can see, it hits harder
            if (s.calc.revealMark) this.applyFx(e, { mark: { amt: s.calc.revealMark, d: 1 } });
            break;
          }
        }

        // ground zones — craters, slicks, wakes, stains, squalls, quagmires
        for (const z of this.zones) {
          if (dist2(z.x, z.y, ep.x, ep.y) > z.r * z.r) continue;
          if (z.slowF) this.applyFx(e, { slow: { f: z.slowF, d: 0.4 } });
          if (z.dps) e.hp -= z.dps * dt;
          if (z.curse) this.applyFx(e, z.curse);
          /* Quagmire: something the spray already slushed gets stuck fast, and
             only once per puddle — a per-frame stun would be a permanent one. */
          if (z.stick && e.slowUntil > this.time) {
            if (!z.hit) z.hit = new Set();
            if (!z.hit.has(e.id)) { z.hit.add(e.id); this.stunEnemy(e, z.stick, this.endless ? G.slowResist(this.wave) : 0); }
          }
        }
        if (e.hp <= 0) { this.killEnemy(e, null); continue; }

        // spikes, drift mines and ice decoys all live on the pile list
        for (const p of this.piles) {
          if (p.charges <= 0) continue;
          if (dist2(p.x, p.y, ep.x, ep.y) >= 18 * 18) continue;
          p.charges--;
          if (p.regrow) p.grindUntil = this.time + 1;
          if (p.mine) {
            // Drift Mines: the first vacuum over it sets the whole thing off
            p.charges = 0;
            this.splashAt(p.x, p.y, p.mine, p.damage, null, 12);
          } else if (p.hold) {
            // Decoy Dive: the ice-double cracks and whatever stood on it stops dead
            this.stunEnemy(e, p.hold, this.endless ? G.slowResist(this.wave) : 0);
            this.effects.push({ kind: 'spikeHit', x: ep.x, y: ep.y, life: 0.2, max: 0.2 });
          } else {
            if (p.shred) this.applyFx(e, { shred: p.shred });
            this.damageEnemy(e, p.damage, null, { pure: true });
            this.effects.push({ kind: 'spikeHit', x: ep.x, y: ep.y, life: 0.2, max: 0.2 });
          }
          if (p.chill) this.applyFx(e, { slow: p.chill });
          if (e.dead) break;
        }
      }
      this.heavyEat();
      this.enemies = this.enemies.filter((e) => !e.dead);

      /* Self-Repairing: a wall being ground down grows a spike back every second,
         so long as something is still grinding on it. A wall spent to nothing
         is gone — regrowth keeps a wall standing, it does not resurrect one. */
      for (const p of this.piles) {
        if (!p.regrow || p.charges <= 0 || p.charges >= p.max) continue;
        if ((p.grindUntil || 0) <= this.time) continue;
        p.regrown = (p.regrown || 0) + p.regrow * dt;
        while (p.regrown >= 1 && p.charges < p.max) { p.regrown -= 1; p.charges++; }
      }
      this.piles = this.piles.filter((p) => p.charges > 0);
      if (this.zones.length) this.zones = this.zones.filter((z) => z.until > this.time);
      if (this.tempAuras.length) this.tempAuras = this.tempAuras.filter((a) => a.until > this.time);

      // towers
      for (const t of this.towers) {
        if (t.calc.orbit) t.orbitAngle += dt * (t.calc.orbitSpeed || 1.4);
        const c = t.calc;
        /* Fortress Walls and Shield Dome both watch the circle rather than
           shoot from it, so they are checked here rather than in fireTower —
           an aura tower never reaches that function at all. */
        if (c.alarm || c.dome) {
          const r2 = (c.range * t.buff.range) ** 2;
          let breach = null;
          for (const e of this.enemies) {
            if (e.dead) continue;
            const ep = samplePath(this.paths[e.pathIdx], e.dist);
            if (dist2(t.x, t.y, ep.x, ep.y) <= r2) { breach = ep; break; }
          }
          if (breach && c.alarm) this.pushTempAura('alarm' + t.id, t.x, t.y, c.range * t.buff.range, c.alarm.rate, c.alarm.d);
          if (breach && c.dome && !t.domeUsed) {
            t.domeUsed = true;
            const resist = this.endless ? G.slowResist(this.wave) : 0;
            for (const e of this.enemies) {
              if (e.dead) continue;
              const ep = samplePath(this.paths[e.pathIdx], e.dist);
              if (dist2(t.x, t.y, ep.x, ep.y) <= r2) this.stunEnemy(e, c.dome, resist);
            }
            this.effects.push({ kind: 'storm', x: t.x, y: t.y, r: c.range * t.buff.range, life: 0.6, max: 0.6 });
          }
        }
        this.auxTick(t, dt);
        this.fireTower(t, dt);
      }

      // projectiles
      for (const pr of this.projectiles) {
        if (pr.kind === 'lob') {
          pr.t += dt;
          if (pr.t >= pr.T) {
            pr.dead = true;
            const owner = this.towers.find((t) => t.id === pr.owner);
            this.splashAt(pr.tx, pr.ty, pr.splash, pr.damage, owner, pr.pierce);
            this.onImpact(owner, pr, pr.tx, pr.ty);
          }
          continue;
        }
        if (pr.kind === 'homing') {
          let tgt = this.enemies.find((e) => e.id === pr.targetId);
          if (!tgt) {
            let nd = 300 * 300;
            for (const e of this.enemies) {
              const ep = samplePath(this.paths[e.pathIdx], e.dist);
              const d2 = dist2(pr.x, pr.y, ep.x, ep.y);
              if (d2 < nd) { nd = d2; tgt = e; }
            }
            if (tgt) pr.targetId = tgt.id;
          }
          if (tgt) {
            const ep = samplePath(this.paths[tgt.pathIdx], tgt.dist);
            const a = Math.atan2(ep.y - pr.y, ep.x - pr.x);
            const sp = Math.hypot(pr.vx, pr.vy);
            const cur = Math.atan2(pr.vy, pr.vx);
            let da = a - cur;
            while (da > Math.PI) da -= 2 * Math.PI;
            while (da < -Math.PI) da += 2 * Math.PI;
            const turn = 6 * dt;
            const na = cur + Math.max(-turn, Math.min(turn, da));
            pr.vx = Math.cos(na) * sp; pr.vy = Math.sin(na) * sp;
          }
        }
        const step = Math.hypot(pr.vx, pr.vy) * dt;
        pr.x += pr.vx * dt; pr.y += pr.vy * dt;
        pr.traveled += step;
        /* Rolling Thunder: a snowball is heavier at the bottom of the lane than
           at the top. One counter on the projectile, capped so a long straight
           on a tier-3 map cannot turn one shot into the whole answer. */
        if (pr.grow) {
          const want = Math.min(pr.grow.max, Math.floor(pr.traveled / pr.grow.per));
          if (want > pr.grew) {
            pr.damage += (want - pr.grew) * pr.grow.damage;
            pr.pierce += (want - pr.grew) * pr.grow.pierce;
            pr.grew = want;
          }
        }
        // Icy Wake: the track polishes over into ice behind the roll
        if (pr.wake && pr.traveled - (pr.lastWake || 0) > 30) {
          pr.lastWake = pr.traveled;
          const ow = this.towers.find((t) => t.id === pr.owner);
          if (ow) this.dropZone(ow, pr.x, pr.y);
        }
        if (pr.traveled > (pr.range || 600) || pr.x < -60 || pr.x > G.W + 60 || pr.y < -60 || pr.y > G.H + 60) { pr.dead = true; continue; }
        // collision
        for (const e of this.enemies) {
          if (e.dead || pr.hit.includes(e.id)) continue;
          const owner = this.towers.find((t) => t.id === pr.owner);
          if (owner && !this.canSee(owner, e)) continue;
          const ep = samplePath(this.paths[e.pathIdx], e.dist);
          if (dist2(pr.x, pr.y, ep.x, ep.y) < (e.size + 6) ** 2) {
            if (pr.splash > 0) {
              pr.dead = true;
              /* the vacuum the shell actually struck always takes the hit —
                 big bodies used to shrug off blasts that burst on their rim,
                 outside the blast's own center-measured radius */
              this.damageEnemy(e, pr.damage, owner);
              this.splashAt(pr.x, pr.y, pr.splash, pr.damage, owner, Math.max(pr.pierce, 6), e);
              this.onImpact(owner, pr, pr.x, pr.y);
              break;
            }
            this.damageEnemy(e, pr.damage, owner);
            pr.hit.push(e.id);
            pr.pierce--;
            this.effects.push({ kind: 'hit', x: ep.x, y: ep.y, life: 0.12, max: 0.12 });
            if (owner && owner.calc.ricochet) this.ricochet(owner, pr, e, ep);
            if (owner && owner.calc.zone && !owner.calc.zoneAt) this.dropZone(owner, ep.x, ep.y);
            if (pr.pierce <= 0) { pr.dead = true; break; }
          }
        }
      }
      this.projectiles = this.projectiles.filter((p) => !p.dead);

      // effects & texts
      for (const fx of this.effects) fx.life -= dt;
      this.effects = this.effects.filter((f) => f.life > 0);
      for (const tx of this.texts) tx.life -= dt;
      this.texts = this.texts.filter((t) => t.life > 0);

      // defeat
      if (this.lives <= 0) {
        this.lives = 0;
        this.over = 'lose';
        this.emit('defeat');
        return;
      }

      // wave end
      if (this.waveInProgress && !this.spawnQueue.length && !this.enemies.length) {
        this.waveInProgress = false;
        // Keen Scouts (workshop perk) and Cold Storage (a vendor on the board)
        const wr = Math.round(this.waveReward * G.PERK.reward * (1 + (this.waveBonus || 0)));
        this.cash += wr;
        let earned = wr;
        for (const p of this.vendorPayouts()) {
          this.cash += p.got;
          earned += p.got;
        }
        const finished = this.wave;
        this.wave++;
        /* The hero's LEVEL now moves on kills, in killEnemy. Its strength
           still tracks the wave number (heroStrength), so it has to be
           recomputed when the wave advances or the hero silently stops
           scaling with the endless curve. */
        if (this.heroTower) this.refreshHero();
        if (finished >= this.totalWaves && !this.endless) {
          this.over = 'win';
          this.emit('victory');
        } else {
          this.emit('waveEnd', { wave: finished, earned });
        }
      }

      // auto-start: lives in the sim so pausing pauses it too
      if (!this.waveInProgress && this.autoStart && !this.over) {
        this.nextWaveIn = this.nextWaveIn == null ? 1.2 : this.nextWaveIn - dt;
        if (this.nextWaveIn <= 0) this.startWave();
      } else if (!this.autoStart) {
        this.nextWaveIn = null;
      }
    }

    /* ----- serialization (mid-match saves) ----- */
    serialize() {
      return {
        v: 3, levelIdx: this.levelIdx, diff: this.diffId, cash: this.cash, lives: this.lives,
        wave: this.wave, waveInProgress: this.waveInProgress, waveTime: this.waveTime,
        waveReward: this.waveReward || 0, autoStart: this.autoStart, time: this.time,
        frenzyUntil: this.frenzyUntil || 0, endless: this.endless,
        kills: this.kills, rankXp: this.rankXp, xpBanked: this.xpBanked,
        heroType: this.heroType, heroKills: this.heroKills,
        heroReadyIn: Math.max(0, this.heroReadyAt - this.time),
        towers: this.towers.map((t) => ({ type: t.type, x: t.x, y: t.y, up: [...t.up], target: t.target, invested: t.invested, kills: t.kills || 0 })),
        spawnQueue: this.spawnQueue.map((s) => ({ ...s })),
        enemies: this.enemies.map((e) => ({
          type: e.type, pathIdx: e.pathIdx, dist: e.dist, hp: e.hp, maxHp: e.maxHp,
          hpMult: e.hpMult, armor: e.armor, stealth: e.stealth,
        })),
        piles: this.piles.map((p) => ({ ...p, owner: -1 })),
        savedAt: Date.now(),
      };
    }

    static deserialize(data) {
      // pre-difficulty saves were 50-wave campaigns at standard prices → closest is 'hard'
      const g = new Game(data.levelIdx, data.diff || 'hard', data.heroType);
      g.cash = data.cash; g.lives = data.lives; g.wave = data.wave;
      g.waveInProgress = data.waveInProgress; g.waveTime = data.waveTime;
      g.waveReward = data.waveReward; g.autoStart = !!data.autoStart; g.time = data.time || 0;
      g.frenzyUntil = data.frenzyUntil || 0; g.endless = !!data.endless;
      g.kills = data.kills || 0; g.xpBanked = data.xpBanked || 0;
      /* Saves written before rank XP split from the kill count have no rankXp.
         Seeding it from kills keeps them exactly where they were — their banked
         total already equals their kill count, so nothing is re-paid or lost. */
      g.rankXp = data.rankXp != null ? data.rankXp : (data.kills || 0);
      /* Saves written before hero XP moved to kills carry heroWaves instead.
         Convert by keeping the LEVEL the player had earned (3 waves a level,
         old cap 10) and crediting the kills that level now costs, so nobody
         loads a mid-campaign save and finds their hero demoted. */
      if (data.heroKills != null) {
        g.heroKills = data.heroKills;
      } else {
        const oldLevel = Math.min(10, 1 + Math.floor((data.heroWaves || 0) / 3));
        g.heroKills = G.heroKillsFor(oldLevel);
      }
      g.heroReadyAt = g.time + (data.heroReadyIn || 0);
      for (const td of data.towers) {
        /* Saves written when Bros had two paths carry a two-slot array.
           Padding it leaves those towers exactly as they were — the third path
           simply starts empty, and the rule of two then treats them like any
           other Bro with one or two paths already going. */
        const up = [td.up[0] || 0, td.up[1] || 0, td.up[2] || 0];
        const t = {
          id: nextId++, type: td.type, x: td.x, y: td.y, up, target: td.target,
          invested: td.invested, cooldown: 0, orbitAngle: Math.random() * Math.PI * 2,
          kills: td.kills || 0,
          calc: computeEffective(td.type, up), buff: { dmg: 1, rate: 1, range: 1, stealth: false },
        };
        if ((G.TOWERS[td.type] || {}).hero) { t.hero = true; g.heroTower = t; }
        g.towers.push(t);
      }
      g.refreshHero();
      g.recomputeBuffs();
      g.spawnQueue = (data.spawnQueue || []).map((s) => ({ ...s }));
      for (const ed of data.enemies || []) {
        g.spawnEnemy(ed.type, ed.pathIdx, ed.dist, ed.hpMult);
        const e = g.enemies[g.enemies.length - 1];
        e.hp = ed.hp; e.maxHp = ed.maxHp; e.armor = ed.armor;
      }
      g.piles = (data.piles || []).map((p) => ({ ...p, owner: -1 }));
      return g;
    }
  }

  G.Game = Game;
  G.samplePath = samplePath;
  G.distToPath = distToPath;
})();
