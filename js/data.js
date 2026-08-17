/* Brix and Bros — game data: classes, Bros, upgrades, vacuums, levels */
(function () {
  const G = (globalThis.G = globalThis.G || {});

  G.W = 1280;
  G.H = 800;
  G.PATH_HALF = 26;      // half-width of the track
  G.TOWER_R = 20;        // tower footprint radius
  G.SELL_RATE = 0.7;

  /* ---------------- Difficulty modes ----------------
     costMult scales every tower and upgrade price (rounded to $5).
     livesMult scales each level's starting lives (rounded to 5).
     waves is the campaign length — each ends on a boss wave.
     bricks is the victory reward (persistent meta-currency);
     retryCost is the brick price of a Second Chance after defeat;
     drip is the endless-wave payout basis (every 10th wave; ×10 each century)
     — kept separate so retry pricing can move without touching rewards. */
  G.DIFFICULTIES = {
    easy:   { name: 'Easy',   icon: '🟩', waves: 30, costMult: 0.85, livesMult: 1.25, bricks: 100, retryCost: 40,  drip: 25 },
    medium: { name: 'Medium', icon: '🟨', waves: 40, costMult: 1.0,  livesMult: 1.0,  bricks: 250, retryCost: 75,  drip: 50 },
    hard:   { name: 'Hard',   icon: '🟥', waves: 50, costMult: 1.15, livesMult: 0.8,  bricks: 500, retryCost: 150, drip: 100 },
  };
  G.DIFF_ORDER = ['easy', 'medium', 'hard'];
  G.scaleCost = (raw, diffId) => {
    const D = G.DIFFICULTIES[diffId] || G.DIFFICULTIES.medium;
    return Math.max(5, Math.round((raw * D.costMult * G.PERK.cost) / 5) * 5);
  };
  G.scaleLives = (raw, diffId) => {
    const D = G.DIFFICULTIES[diffId] || G.DIFFICULTIES.medium;
    return Math.max(10, Math.round((raw * D.livesMult) / 5) * 5) + G.PERK.lives;
  };
  G.scaleRetry = (raw) => Math.max(5, Math.round((raw * G.PERK.retry) / 5) * 5);

  /* ---------------- Workshop Upgrades ----------------
     Small forever-bonuses bought with bricks — the permanent half of the
     meta-economy (boosts are the consumable half, heroes the trophies).
     Three tiers each; `v` is the value the perk system reads. */
  G.WORKSHOP = {
    stores:    { name: 'Deeper Bins',     icon: '🔩', desc: 'The workshop keeps a stud jar: start every battle with extra studs.',
                 fmt: (v) => `+${v} starting 🔩`,            tiers: [{ cost: 300, v: 75 }, { cost: 800, v: 150 }, { cost: 1800, v: 250 }] },
    walls:     { name: 'Thicker Walls',   icon: '💖', desc: 'Double-stacked brickwork: start every battle with extra lives.',
                 fmt: (v) => `+${v} starting lives`,         tiers: [{ cost: 300, v: 10 }, { cost: 800, v: 20 }, { cost: 1800, v: 35 }] },
    hooks:     { name: 'Sharper Tools',   icon: '🪛', desc: 'Every vacuum broken apart pays more studs.',
                 fmt: (v) => `+${v}% bounties`,              tiers: [{ cost: 400, v: 4 }, { cost: 1000, v: 8 }, { cost: 2200, v: 12 }] },
    /* NOT "Bulk Orders" — that is the Parts Trader's Supply Chain capstone,
       and the engine comments name it. Two discounts with one name is how you
       end up debugging the wrong one. */
    contracts: { name: 'Standing Orders', icon: '📜', desc: 'Bros sign on for less: defenders and upgrades cost fewer studs.',
                 fmt: (v) => `−${v}% Bro prices`,            tiers: [{ cost: 500, v: 3 }, { cost: 1200, v: 6 }, { cost: 2600, v: 9 }] },
    flags:     { name: 'Rally Flags',     icon: '🚩', desc: 'The crew rebuilds for less: Second Chance costs fewer bricks.',
                 fmt: (v) => `−${v}% retry price`,           tiers: [{ cost: 400, v: 20 }, { cost: 900, v: 35 }, { cost: 2000, v: 50 }] },
    scouts:    { name: 'Keen Scouts',     icon: '🔭', desc: 'Scouts sift the carpet: bigger stud rewards for every wave cleared.',
                 fmt: (v) => `+${v}% wave rewards`,          tiers: [{ cost: 400, v: 5 }, { cost: 1000, v: 10 }, { cost: 2200, v: 15 }] },
  };
  G.WORKSHOP_ORDER = ['stores', 'walls', 'hooks', 'contracts', 'flags', 'scouts'];

  /* live perk values — neutral until a profile is applied (headless stays neutral) */
  G.PERK = { cash: 0, lives: 0, bounty: 1, cost: 1, retry: 1, reward: 1 };
  G.applyWorkshop = function (workshop) {
    workshop = workshop || {};
    const v = (id) => {
      const C = G.WORKSHOP[id];
      const t = Math.min(workshop[id] || 0, C.tiers.length);
      return t ? C.tiers[t - 1].v : 0;
    };
    G.PERK = {
      cash: v('stores'), lives: v('walls'),
      bounty: 1 + v('hooks') / 100, cost: 1 - v('contracts') / 100,
      retry: 1 - v('flags') / 100, reward: 1 + v('scouts') / 100,
    };
  };

  /* ---------------- Builder rank (XP levels) ----------------
     Every vacuum destroyed is 1 XP — splits included, so a Carpet Cleaner is
     worth 17 and a Floor Buffer 52. Each rank gained recruits exactly one new
     Bro. A brand-new crew fields five (one or two per class); the other
     fifteen arrive at ranks 2-16, weakest first, the Sun Priest last.

     The curve is measured, not guessed: a first Easy campaign yields ~2,140
     vacuums and all ten Brick City battlefields ~30,900, so rank 16 lands
     just as the first campaign tier is finished. Harder difficulties field
     more vacuums per battle and so rank up faster — which is only fair. */
  /* The battle music speeds up 1% per wave, but stops accelerating at wave 75 —
     past that the march is already frantic and endless runs would only get
     sillier. One helper so every call site agrees. */
  /* Hard ceilings on what auras can do to one Bro, however many support
     towers surround it. Reached by roughly one maxed aura tower of each kind,
     so the second and third are for covering more ground, not more power. */
  /* These ceilings were lowered alongside the aura nerf, so the most a Bro
     can ever be buffed to fell by the same amount — cutting only the sources
     would have left a big enough cluster reaching the old cap anyway. */
  G.AURA_CAP = { dmg: 1.80, rate: 1.80, range: 1.36, shred: 4, pierce: 2 };

  /* Endless pacing. Piling HP on slow-moving vacuums turned late waves into
     grinds: by wave 130 every enemy had spawned inside 70 seconds and the
     remaining four minutes were spent chipping down a handful of slowed
     survivors — 77% of the wave, rising to 89% by wave 160. Deep waves now
     get part of their menace from SPEED instead, so they resolve quickly and
     failure is sharp: either the pack dies or it reaches the Home Build. */
  G.endlessSpeed = (wave) =>
    wave > 50 ? Math.min(1.7, 1 + (wave - 50) * 0.006) : 1;
  /* The grind was really the slows: a vacuum with 50x health pinned at 35%
     speed neither dies nor arrives, so the wave just hangs there. Deep endless
     packs shrug off more and more of the chill, which forces every wave to
     resolve — they get through the kill zone and either drop or reach you. */
  G.slowResist = (wave) =>
    wave > 50 ? Math.min(0.6, (wave - 50) * 0.009) : 0;   // 0.6 paces as well as 0.8 and leaves slow towers a job

  G.MUSIC_CAP_WAVE = 75;
  G.tempoForWave = (wave) => Math.pow(1.01, Math.min(wave || 1, G.MUSIC_CAP_WAVE) - 1);

  /* ---- what an endless kill is worth toward builder rank ----
     The ladder below was fitted to CAMPAIGN play and says so: ten Brick City
     battlefields field ~30,900 vacuums against the 30,500 rank 16 needs. That
     fit is exact and deliberate, and it is still the intended pace.

     Endless was never in the arithmetic, and it dwarfs the thing that was.
     Battlefield 1 fields 7,039 vacuums across a whole Hard campaign and
     another 13,665 in the 49 endless waves after it — endless pays a flat ~279
     a wave forever, because pack size is capped at 60 a group and deep waves get
     their menace from health and speed instead of numbers. So one long run on
     the FIRST map out-earns the ten-battlefield tier the ladder was built
     around, and a real save came back at rank 12 with 80% of the roster from a
     single sitting.

     A quarter is the fix, and it goes here rather than on the ladder for two
     reasons. Raising the ladder would break the campaign fit that is correct
     today — and it would re-rank every profile already saved, taking Bros
     back off players who have them. Only future earning changes.

     What it lands on: that same wave-99 run pays about rank 9 instead of 12, and
     climbing the rest of the ladder on endless alone becomes ~300 waves, so
     depth on one map stops being the shortcut past breadth across many.

     Hero levels deliberately do NOT use this. That curve was fitted WITH endless
     in mind — the note below it works in "roughly wave 65 of an endless run" —
     so it is already correct and is left alone. */
  G.ENDLESS_RANK_XP = 0.25;

  G.MAX_RANK = 16;
  G.RANK_XP = [
    0,      // rank 1 — where everyone starts
    60, 300, 750, 1450, 2450,
    3700, 5250, 7150, 9400, 12000,
    14900, 18200, 21900, 26000, 30500,
  ];
  G.STARTERS = ['pebble', 'snowball', 'harpoon', 'aurora', 'vendor'];
  /* recruited one per rank, from rank 2 — cheap utility first, the heavy
     hitters and the big aura pieces last. The water pair (Torpedo Sub, Depth
     Charge Boat) lands at ranks 4 and 6, comfortably before Frozen River. */
  G.RANK_UNLOCKS = [
    'slush', 'shards', 'torpedo', 'glacier', 'depth',
    'sonar', 'shadow', 'witch', 'icewall', 'drummer',
    'jetpack', 'blizzard', 'artillery', 'fort', 'sunpriest',
  ];

  G.xpForRank = (rank) => G.RANK_XP[Math.max(0, Math.min(G.MAX_RANK, rank) - 1)] || 0;
  G.rankFromXp = function (xp) {
    let r = 1;
    for (let i = 1; i < G.RANK_XP.length; i++) if ((xp || 0) >= G.RANK_XP[i]) r = i + 1;
    return r;
  };
  // XP into the current rank / XP that rank spans — for the progress bar
  G.rankProgress = function (xp) {
    xp = xp || 0;
    const rank = G.rankFromXp(xp);
    if (rank >= G.MAX_RANK) return { rank, into: 0, span: 0, next: null, maxed: true };
    const base = G.xpForRank(rank), next = G.xpForRank(rank + 1);
    return { rank, into: xp - base, span: next - base, next, maxed: false };
  };
  // the Bro a given rank recruits (null for rank 1)
  G.unlockAtRank = (rank) => G.RANK_UNLOCKS[rank - 2] || null;
  // 0 = usable now; otherwise the rank still needed
  G.towerNeed = function (profile, typeId) {
    if ((G.TOWERS[typeId] || {}).hero) return 0;
    if (G.STARTERS.includes(typeId)) return 0;
    const idx = G.RANK_UNLOCKS.indexOf(typeId);
    if (idx < 0) return 0;
    const need = idx + 2;
    return G.rankFromXp((profile || {}).xp) >= need ? 0 : need;
  };

  G.defendedCount = (profile) =>
    G.LEVELS.filter((L) => {
      const d = ((profile || {}).diffDone || {})[L.id];
      return d && (d.easy || d.medium || d.hard);
    }).length;

  /* ---------------- Campaign tiers ----------------
     Ten battlefields each. Later tiers use a physically larger map, tougher
     packs and richer bounties — even their Easy mode outbites the tier below. */
  G.TIERS = [
    { id: 1, name: 'Brick City', icon: '🏙',
      blurb: 'The home build. Open plate, gentle curves — where every Bro learns to throw.' },
    { id: 2, name: 'Star Port', icon: '🚀',
      blurb: 'Off the edge of the table: wider plate, thicker fleets. Even the easy road here bites harder than Brick City ever did.' },
    { id: 3, name: 'Castle Realm', icon: '🏰',
      blurb: 'The far end of the room, where the old machines wake. Sprawling, tangled boards and vacuums that shrug off everything you knew.' },
  ];
  // per-tier map size and bounty scaling (levels inherit these by position)
  const TIER_DIMS = { 1: { w: 1280, h: 800 }, 2: { w: 1440, h: 860 }, 3: { w: 1600, h: 920 } };
  const TIER_BOUNTY = { 1: 1, 2: 1.5, 3: 2.3 };

  /* The canvas world size changes per battlefield; everything that draws or
     places in world coordinates reads G.W/G.H, so we swap them per level. */
  G.setDims = function (L) { G.W = L.w || 1280; G.H = L.h || 800; };

  /* ---------------- Campaign progression ----------------
     Each difficulty runs its own chain through the campaign: you work along a
     tier battlefield by battlefield, and clearing a whole tier opens the next
     tier on that difficulty. A win also counts for every easier difficulty —
     if you cleared it on Hard you have plainly earned the Easy unlock too. */
  G.DIFF_RANK = { easy: 0, medium: 1, hard: 2 };

  function done(profile, levelId) { return (profile && profile.diffDone && profile.diffDone[levelId]) || {}; }

  // has this battlefield been beaten on `diffId` or anything harder?
  G.beatenAtLeast = function (profile, levelId, diffId) {
    const need = G.DIFF_RANK[diffId];
    const d = done(profile, levelId);
    return G.DIFF_ORDER.some((o) => G.DIFF_RANK[o] >= need && d[o]);
  };

  G.tierLevels = (tier) => G.LEVELS.filter((L) => L.tier === tier);

  G.tierUnlocked = function (profile, tier, diffId) {
    if (tier <= 1) return true;
    return G.tierLevels(tier - 1).every((L) => G.beatenAtLeast(profile, L.id, diffId));
  };

  G.levelUnlocked = function (profile, levelIdx, diffId) {
    const L = G.LEVELS[levelIdx];
    if (!L) return false;
    // grandfather clause: levels reached under the old single-track unlock stay open
    if (levelIdx < ((profile && profile.unlocked) || 1)) return true;
    if (!G.tierUnlocked(profile, L.tier, diffId)) return false;
    if (L.slot === 0) return true;
    return G.beatenAtLeast(profile, G.LEVELS[levelIdx - 1].id, diffId);
  };

  G.anyDiffUnlocked = (profile, levelIdx) =>
    G.DIFF_ORDER.some((d) => G.levelUnlocked(profile, levelIdx, d));

  // plain-English explanation of what stands between the player and this run
  G.lockReason = function (profile, levelIdx, diffId) {
    const L = G.LEVELS[levelIdx];
    if (!L || G.levelUnlocked(profile, levelIdx, diffId)) return null;
    const D = G.DIFFICULTIES[diffId];
    if (!G.tierUnlocked(profile, L.tier, diffId)) {
      const prev = G.TIERS.find((T) => T.id === L.tier - 1);
      const left = G.tierLevels(L.tier - 1).filter((x) => !G.beatenAtLeast(profile, x.id, diffId)).length;
      return `Clear ${prev.name} on ${D.name} first — ${left} battlefield${left === 1 ? '' : 's'} to go.`;
    }
    return `Beat ${G.LEVELS[levelIdx - 1].name} on ${D.name} first.`;
  };

  /* ---------------- Power-ups ----------------
     Bought with bricks mid-match; priced in proportion to their impact. */
  G.POWERS = {
    studdump: { name: 'Stud Dump',   icon: '🔩', cost: 15, desc: 'The traders tip out their jars: +600 🔩, instantly.' },
    icespikes: { name: 'Brick Trap',  icon: '🧱', cost: 20, desc: 'Loose bricks (40 pieces × 10 dmg) scatter near the exit of every track.' },
    frenzy:    { name: 'Rally Drum',  icon: '🥁', cost: 25, desc: 'Every Bro attacks 50% faster for 15 seconds.' },
    freeze:    { name: 'Power Cut',   icon: '⚡', cost: 30, desc: 'Every vacuum on the field is unplugged for 4s (bosses 1.5s).' },
    heal:      { name: 'Second Wind', icon: '💖', cost: 40, desc: 'The crew rebuilds: +25 lives.' },
    avalanche: { name: 'Tip the Tub', icon: '🪣', cost: 50, desc: '60 damage to every vacuum on the field, ignoring armor.' },
  };
  G.POWER_ORDER = ['studdump', 'icespikes', 'frenzy', 'freeze', 'heal', 'avalanche'];

  G.CLASSES = {
    frost:   { name: 'Knights', color: '#e05252', desc: 'Reliable frontline damage — thrown bricks, rolling wheels and blades.' },
    navy:    { name: 'Space',   color: '#3f7fd4', desc: 'Hardware — laser snipers, rovers, skiffs and mech cannons.' },
    mystic:  { name: 'Wizards', color: '#9b59d0', desc: 'Spellwork — piercing sparks, hexes and storms.' },
    support: { name: 'Crew',    color: '#3fae6a', desc: 'Economy, buffs, detection and track hazards.' },
  };

  /* ---------------- The rule of two ----------------
     Every Bro has three upgrade paths and may be fed from only TWO of
     them. Buying into a second path shuts the third for the rest of the
     battle, and only one of the two you chose may take its capstone (tier 3);
     the other stops at tier 2. That is the same five purchases a Bro
     supported when there were two paths, so no cost band and nothing about the
     studs economy moves — what changes is that a tower now has six real builds
     (which pair, then which of the pair caps) instead of two.

     One function answers it for the engine, the panel and the guide alike, so
     the rule can never be enforced in one place and drawn differently in
     another. */
  G.PATH_LIMIT = 2;
  G.pathState = function (up, p) {
    up = up || [];
    const tier = up[p] || 0;
    if (tier >= 3) return 'mastered';
    const chosen = up.filter((v) => v > 0).length;
    if (!tier && chosen >= G.PATH_LIMIT) return 'locked';
    if (tier === 2 && up.some((v, i) => i !== p && v >= 3)) return 'capped';
    return 'open';
  };
  // plain English for a shut path — the panel and the buy refusal share it
  G.PATH_LOCK_MSG = {
    locked: 'Two paths chosen — this one is shut for the battle.',
    capped: 'Only one path can take its capstone.',
    mastered: 'Path maxed out.',
  };

  /* ---------------- Towers ----------------
     stats keys the engine understands:
       range, rate (shots/s), damage, pierce, projSpeed, splash,
       kind: bullet | homing | lob | snipe | ray | volley | pulse | spikes | income | aura
       volley (count), shots (multishot), minRange, orbit (radius),
       income ($/wave), charges/spikeDmg/maxPiles (spikes),
       auraDmg/auraRate/auraRange/auraStealth/auraShred/auraPierce/auraArcs (aura),
       auraR (aura radius when it differs from the tower's own reach),
       auraClass (aura only reaches Bros of that class),
       stealth (detect), water: 'only'|'never'|'any',
       bossBonus (damage mult vs boss ranks), armorPierce
     ...and the capstone machinery, each built once and shared:
       zone {r,life,slowF,dps,curse,stick,tone} + zoneAt: impact|self|wake|death — ground zones
       aux {kind:'pile'|'stagger', every, ...} — a second job on its own clock
       crit {p,mult,stealthAlways}, ramp {per,max}, grow {per,damage,pierce,max},
       cluster {n,frac}, salvo {every,n,frac}, split {n,frac}, ricochet (n),
       multiTarget, forceTarget, walk (px), projRange, vsArmored, resonance,
       conduit (px), miasma (px), alarm {rate,d}, solo {rate,d}, dome (s),
       regrow, spikeShred, pileFlash {f,d}, decloak, revealMark,
       noFalloff, waveBonus, buildDiscount, interest, tradeHub, bountyBonus
     fx applied to hit enemies: slow {f,d}, dot {dps,d}, shred (armor), stun (s),
       mark {amt,d}, knock {d,p}, freezeMeter {hits,stun}, bleed {pct,d},
       shredPerSec (n), frostbite (freeze-duration multiplier)
     Upgrade mods: { add:{}, mul:{}, set:{}, fx:{} }                                    */
  G.TOWERS = {
    /* ---- KNIGHTS ----
       The slow/freeze family reads as CLOGGING throughout: grit and loose
       bricks foul a vacuum's brushes, a full clog seizes the motor. Same
       numbers the ice did, a metaphor that fits the enemy. */
    pebble: {
      cls: 'frost', name: 'Brick Slinger', cost: 170,
      desc: 'A plucky Bro who lobs loose 1×1 bricks at anything that rolls.',
      stats: { range: 150, rate: 1.2, damage: 1, pierce: 1, projSpeed: 460, splash: 0, kind: 'bullet', water: 'never' },
      paths: [
        { name: 'Power', tiers: [
          { name: 'Sharp Edges',    cost: 110, desc: '+1 damage.',                        mods: { add: { damage: 1 } } },
          { name: 'Two-Handed',     cost: 260, desc: '+2 damage, throws 25% faster.',     mods: { add: { damage: 2 }, mul: { rate: 1.25 } } },
          { name: 'Brickbreaker',   cost: 850, desc: '+3 damage; double damage to armored vacuums, and every hit rattles the casing (0.3s).', mods: { add: { damage: 3 }, set: { vsArmored: 2 }, fx: { stun: 0.3 } } },
        ]},
        { name: 'Reach', tiers: [
          { name: 'Keen Eyes',      cost: 90,  desc: '+30% range, sees stealth.',         mods: { mul: { range: 1.3 }, set: { stealth: true } } },
          { name: 'Piercing Throw', cost: 210, desc: 'Bricks pierce 2 extra vacuums.',    mods: { add: { pierce: 2 } } },
          { name: 'Ricochet',       cost: 700, desc: 'Bricks bounce off their victim into 2 more nearby vacuums.', mods: { set: { ricochet: 2 } } },
        ]},
        { name: 'Trick Shot', tiers: [
          { name: 'Follow-Through', cost: 100, desc: 'The throw doesn’t stop at the first shell it hits: +1 pierce.', mods: { add: { pierce: 1 } } },
          { name: 'Gritty Bricks',  cost: 240, desc: 'Grit in the brushes: hits clog vacuums 15% for 1s.', mods: { fx: { slow: { f: 0.85, d: 1 } } } },
          { name: 'Yard Bully',     cost: 780, desc: 'Every brick has a 1-in-4 chance to knock its target a step back down the track.', mods: { fx: { knock: { d: 40, p: 0.25 } } } },
        ]},
      ],
    },
    snowball: {
      cls: 'frost', name: 'Boulder Knight', cost: 300,
      desc: 'Rolls a heavy stone wheel that plows straight through the pack.',
      stats: { range: 135, rate: 0.75, damage: 2, pierce: 5, projSpeed: 330, splash: 0, kind: 'bullet', water: 'never' },
      paths: [
        { name: 'Mass', tiers: [
          { name: 'Packed Core',    cost: 180, desc: '+1 damage.',                        mods: { add: { damage: 1 } } },
          { name: 'Giant Boulder',  cost: 420, desc: '+2 damage, +4 pierce.',             mods: { add: { damage: 2, pierce: 4 } } },
          { name: 'Rolling Thunder', cost: 1300, desc: 'Boulders grow as they roll — +1 damage and +2 pierce for every stretch of track they cover, and they roll much further.', mods: { set: { grow: { per: 55, damage: 1, pierce: 2, max: 10 }, projRange: 3 } } },
        ]},
        { name: 'Clog', tiers: [
          { name: 'Grit Coating',   cost: 200, desc: 'Boulders clog targets 30%.',        mods: { fx: { slow: { f: 0.7, d: 1.6 } } } },
          { name: 'Deeper Clog',    cost: 380, desc: 'Clog strengthened to 45%, and it lasts longer.', mods: { fx: { slow: { f: 0.55, d: 2.4 } } } },
          { name: 'Full Seizure',   cost: 1100, desc: 'Every hit packs the brush tighter; the third seizes the motor for 1.5s.', mods: { fx: { freezeMeter: { hits: 3, stun: 1.5 }, slow: { f: 0.55, d: 2.4 } } } },
        ]},
        { name: 'Momentum', tiers: [
          { name: 'Smooth Rails',   cost: 190, desc: 'Rolls 40% faster.',                 mods: { mul: { rate: 1.4 } } },
          { name: 'Wide Track',     cost: 400, desc: '+25% range, +3 pierce.',            mods: { mul: { range: 1.25 }, add: { pierce: 3 } } },
          { name: 'Grease Trail',   cost: 1200, desc: 'Boulders leave a slick of grease behind them for 3s — vacuums crossing it are clogged 30%, no hit required.', mods: { set: { zone: { r: 34, life: 3, slowF: 0.7, tone: 'ice' }, zoneAt: 'wake' } } },
        ]},
      ],
    },
    shards: {
      cls: 'frost', name: 'Sword Spinner', cost: 260,
      desc: 'Whirls on the spot, flinging blades in every direction. Loves choke points.',
      stats: { range: 115, rate: 1.0, damage: 1, pierce: 1, projSpeed: 400, splash: 0, kind: 'volley', volley: 8, water: 'never' },
      paths: [
        { name: 'Barrage', tiers: [
          { name: 'Faster Spinning', cost: 150, desc: '+50% attack speed.',               mods: { mul: { rate: 1.5 } } },
          { name: 'Blade Storm',    cost: 400, desc: 'Flings 12 blades per spin.',        mods: { set: { volley: 12 } } },
          { name: 'Scatterfield',   cost: 1200, desc: 'Each spin litters the ground in its ring for 2s — vacuums crossing it are clogged 25%.', mods: { set: { zone: { r: 0, life: 2, slowF: 0.75, tone: 'ice' }, zoneAt: 'self' } } },
        ]},
        { name: 'Edge', tiers: [
          { name: 'Razor Edges',    cost: 170, desc: '+1 damage.',                        mods: { add: { damage: 1 } } },
          { name: 'Long Blades',    cost: 330, desc: '+35% range, faster blades.',        mods: { mul: { range: 1.35, projSpeed: 1.3 } } },
          { name: 'Cracked Casing', cost: 950, desc: 'Blades split the shell — for 2s the victim takes +25% damage from every Bro on the field.', mods: { fx: { mark: { amt: 0.25, d: 2 } } } },
        ]},
        { name: 'Fortress', tiers: [
          { name: 'Dense Volley',   cost: 160, desc: '+4 blades per spin.',               mods: { add: { volley: 4 } } },
          { name: 'Snagging Ring',  cost: 350, desc: 'Blades clog vacuums 20% for 1s.',   mods: { fx: { slow: { f: 0.8, d: 1 } } } },
          { name: 'Caltrop Bulwark', cost: 1100, desc: 'Every few seconds, studs the track inside its ring with upturned bricks that bite and clog whatever rolls over them.', mods: { set: { aux: { kind: 'pile', every: 3.5, maxPiles: 3, charges: 6, damage: 4, chill: { f: 0.7, d: 1.5 } } } } },
        ]},
      ],
    },
    glacier: {
      cls: 'frost', name: 'Catapult', cost: 490,
      desc: 'Lobs a bucket of bricks that bursts on landing. Great against clumps.',
      stats: { range: 150, rate: 0.55, damage: 3, pierce: 14, projSpeed: 300, splash: 60, kind: 'bullet', water: 'never' },
      paths: [
        { name: 'Payload', tiers: [
          { name: 'Bigger Loads',   cost: 300, desc: '+2 damage.',                        mods: { add: { damage: 2 } } },
          { name: 'Shattering Load', cost: 650, desc: '+30 blast radius, +8 blast targets.', mods: { add: { splash: 30, pierce: 8 } } },
          { name: 'Brick Crater',   cost: 1800, desc: 'Landings leave a drift of loose bricks for 4s — vacuums inside take 3 dmg/s and are clogged 20%.', mods: { set: { zone: { r: 60, life: 4, dps: 3, slowF: 0.8, tone: 'ice' } } } },
        ]},
        { name: 'Artillery', tiers: [
          { name: 'Spotter Bro',    cost: 250, desc: '+25% range.',                       mods: { mul: { range: 1.25 } } },
          { name: 'Rapid Reload',   cost: 550, desc: '+55% attack speed.',                mods: { mul: { rate: 1.55 } } },
          { name: 'Cluster Load',   cost: 1500, desc: 'The bucket splits on impact — two smaller loads fly on to the nearest vacuums and burst again.', mods: { set: { cluster: { n: 2, frac: 0.6 } } } },
        ]},
        { name: 'Seismic', tiers: [
          { name: 'Heavy Mounting', cost: 280, desc: '+20 blast radius.',                 mods: { add: { splash: 20 } } },
          { name: 'Tremor Rounds',  cost: 600, desc: 'Survivors of a blast are clogged 25%.', mods: { fx: { slow: { f: 0.75, d: 2 } } } },
          { name: 'Tablequake',     cost: 1700, desc: 'Landings throw a shockwave — vacuums near the impact are knocked a step back and stunned 0.4s.', mods: { fx: { knock: { d: 38, p: 1 }, stun: 0.4 } } },
        ]},
      ],
    },
    slush: {
      cls: 'frost', name: 'Glue Slinger', cost: 280,
      desc: 'Sprays sticky glue that drags a vacuum almost to a stop.',
      stats: { range: 125, rate: 1.1, damage: 0, pierce: 1, projSpeed: 360, splash: 26, kind: 'bullet', water: 'never', fx: { slow: { f: 0.5, d: 2.4 } } },
      paths: [
        { name: 'Sticky', tiers: [
          { name: 'Thicker Glue',   cost: 160, desc: 'Clog strengthened to 65%.',         mods: { fx: { slow: { f: 0.35, d: 2.4 } } } },
          { name: 'Wide Spray',     cost: 340, desc: 'Bigger splash, +25% range.',        mods: { add: { splash: 22 }, mul: { range: 1.25 } } },
          { name: 'Solvent Mix',    cost: 1000, desc: 'Glued vacuums corrode (2 dmg/s), and every seizure that lands on them lasts 50% longer.', mods: { fx: { dot: { dps: 2, d: 3 }, frostbite: 1.5 } } },
        ]},
        { name: 'Volume', tiers: [
          { name: 'Faster Pumping', cost: 180, desc: '+50% attack speed.',                mods: { mul: { rate: 1.5 } } },
          { name: 'Caustic Bite',   cost: 300, desc: 'Glue now deals 1 damage.',          mods: { add: { damage: 1 } } },
          { name: 'Gum the Works',  cost: 900, desc: 'Glue reaches the motor — hits stun (0.4s), and a stunned vacuum sheds 1 armor for good.', mods: { fx: { stun: 0.4, shred: 1 } } },
        ]},
        { name: 'Trapper', tiers: [
          { name: 'Extra Goop',     cost: 170, desc: 'Splash 50% wider.',                 mods: { mul: { splash: 1.5 } } },
          { name: 'Slow Drip',      cost: 320, desc: 'Clogs last twice as long.',         mods: { fx: { slow: { f: 0.5, d: 4.8 } } } },
          { name: 'Quagmire',       cost: 950, desc: 'Glue pools into puddles that outlast the throw (4s) — anything wading one is clogged 60%, and a vacuum already glued is stuck fast for 1s.', mods: { set: { zone: { r: 40, life: 4, slowF: 0.4, stick: 1, tone: 'slush' } } } },
        ]},
      ],
    },

    /* ---- SPACE ---- */
    harpoon: {
      cls: 'navy', name: 'Laser Sniper', cost: 380,
      desc: 'Unlimited range. One Bro, one beam, one very sorry vacuum.',
      stats: { range: 9999, rate: 0.45, damage: 7, pierce: 1, kind: 'snipe', water: 'never', armorPierce: true },
      paths: [
        { name: 'Caliber', tiers: [
          { name: 'Focused Lens',   cost: 320, desc: '+6 damage.',                        mods: { add: { damage: 6 } } },
          { name: 'Hull Piercer',   cost: 900, desc: '+12 damage.',                       mods: { add: { damage: 12 } } },
          { name: 'Extractor Lance', cost: 2600, desc: 'Bosses leak around the burn — 2% of max HP per second for 5s. Stacks refresh, they don’t multiply.', mods: { fx: { bleed: { pct: 0.02, d: 5 } } } },
        ]},
        { name: 'Marksman', tiers: [
          { name: 'Steady Mount',   cost: 260, desc: '+45% attack speed.',                mods: { mul: { rate: 1.45 } } },
          { name: 'Quick Cycler',   cost: 600, desc: '+80% attack speed in total.',       mods: { mul: { rate: 1.241 } } },
          { name: 'Chain Beam',     cost: 1900, desc: 'The beam arcs to 3 more vacuums, and every arc clogs its victim 30% for 2s.', mods: { add: { pierce: 3 }, fx: { slow: { f: 0.7, d: 2 } } } },
        ]},
        { name: 'Hunter', tiers: [
          { name: 'Night Optics',   cost: 280, desc: 'Sees stealth vacuums.',             mods: { set: { stealth: true } } },
          { name: 'Spotter’s Eye',  cost: 550, desc: '+4 damage, and the sniper always calls the strongest target on the field.', mods: { add: { damage: 4 }, set: { forceTarget: 'strong' } } },
          { name: 'Marked Prey',    cost: 2200, desc: 'The lased target is marked for 4s — every Bro on the board hits it 30% harder.', mods: { fx: { mark: { amt: 0.3, d: 4 } } } },
        ]},
      ],
    },
    torpedo: {
      cls: 'navy', name: 'Deep Rover', cost: 360,
      desc: 'POOL ONLY. Fires homing slugs that never miss.',
      stats: { range: 175, rate: 0.9, damage: 3, pierce: 1, projSpeed: 300, splash: 0, kind: 'homing', water: 'only' },
      paths: [
        { name: 'Warhead', tiers: [
          { name: 'Heavy Slugs',    cost: 280, desc: '+3 damage.',                        mods: { add: { damage: 3 } } },
          { name: 'Blast Charges',  cost: 620, desc: 'Slugs explode (45 radius).',        mods: { add: { splash: 45, pierce: 6 } } },
          { name: 'Oil Slick',      cost: 1700, desc: 'Blasts leave a slick for 3s — anything crossing it is clogged 30% and smoulders for 2 dmg/s.', mods: { set: { zone: { r: 48, life: 3, slowF: 0.7, dps: 2, tone: 'oil' } } } },
        ]},
        { name: 'Scanner', tiers: [
          { name: 'Mast Array',     cost: 220, desc: '+30% range.',                       mods: { mul: { range: 1.3 } } },
          { name: 'Twin Tubes',     cost: 520, desc: '+70% attack speed.',                mods: { mul: { rate: 1.7 } } },
          { name: 'Hunter-Killer',  cost: 1400, desc: 'Locks the biggest thing in range — +8 damage, +50% vs bosses, and never wastes a slug on a handheld while an upright is rolling.', mods: { add: { damage: 8 }, set: { bossBonus: 1.5, forceTarget: 'strong' } } },
        ]},
        { name: 'Squadron', tiers: [
          { name: 'Short Fuses',    cost: 250, desc: '+40% attack speed.',                mods: { mul: { rate: 1.4 } } },
          { name: 'Wing Doctrine',  cost: 500, desc: '+2 damage, +20% range.',            mods: { add: { damage: 2 }, mul: { range: 1.2 } } },
          { name: 'Squadron Salvo', cost: 1500, desc: 'Every third launch adds a fan of four light slugs that each seek a different target.', mods: { set: { salvo: { every: 3, n: 4, frac: 0.5 } } } },
        ]},
      ],
    },
    depth: {
      cls: 'navy', name: 'Hover Skiff', cost: 520,
      desc: 'POOL ONLY. Lobs canisters that blast wide areas.',
      stats: { range: 165, rate: 0.5, damage: 4, pierce: 10, splash: 75, kind: 'lob', water: 'only' },
      paths: [
        { name: 'Ordnance', tiers: [
          { name: 'Bigger Canisters', cost: 350, desc: '+3 damage.',                      mods: { add: { damage: 3 } } },
          { name: 'Shockwave',      cost: 700, desc: '+30 blast radius.',                 mods: { add: { splash: 30 } } },
          { name: 'Tidal Charge',   cost: 2000, desc: 'The blast throws a wave that shoves surviving vacuums a stride back down the track.', mods: { fx: { knock: { d: 42, p: 1 } } } },
        ]},
        { name: 'Crew', tiers: [
          { name: 'Extra Hands',    cost: 300, desc: '+50% attack speed.',                mods: { mul: { rate: 1.5 } } },
          { name: 'Lookout Post',   cost: 480, desc: '+30% range.',                       mods: { mul: { range: 1.3 } } },
          { name: 'Double Launcher', cost: 1500, desc: 'Two charges per attack, each aimed at its own clump.', mods: { set: { shots: 2, multiTarget: true } } },
        ]},
        { name: 'Mine Layer', tiers: [
          { name: 'Contact Fuses',  cost: 320, desc: '+2 damage, +15 blast radius.',      mods: { add: { damage: 2, splash: 15 } } },
          { name: 'Deep Stock',     cost: 550, desc: '+35% attack speed.',                mods: { mul: { rate: 1.35 } } },
          { name: 'Drift Mines',    cost: 1800, desc: 'Seeds the pool with drifting mines (up to 4 afloat) that detonate on the first vacuum over them.', mods: { set: { aux: { kind: 'pile', every: 2.5, maxPiles: 4, charges: 1, mine: { blast: 58, mult: 3 } } } } },
        ]},
      ],
    },
    jetpack: {
      cls: 'navy', name: 'Jetpack Trooper', cost: 750,
      desc: 'Finally, a Bro that flies. Orbits its post, strafing rapidly. Place anywhere.',
      stats: { range: 150, rate: 3.2, damage: 1, pierce: 1, projSpeed: 540, kind: 'bullet', orbit: 55, water: 'any' },
      paths: [
        { name: 'Gunnery', tiers: [
          { name: 'Heavy Rounds',   cost: 400, desc: '+1 damage.',                        mods: { add: { damage: 1 } } },
          { name: 'Dual Cannons',   cost: 900, desc: 'Fires two shots at once.',          mods: { set: { shots: 2 } } },
          { name: 'Gun Run',        cost: 2400, desc: 'Drops low and rakes the lane — every round punches through 3 vacuums in a row (+3 pierce, +1 damage).', mods: { add: { pierce: 3, damage: 1 } } },
        ]},
        { name: 'Avionics', tiers: [
          { name: 'Thermal Visor',  cost: 350, desc: 'Sees stealth vacuums.',           mods: { set: { stealth: true } } },
          { name: 'Afterburners',   cost: 650, desc: '+30% range, faster orbit.',         mods: { mul: { range: 1.3 }, set: { orbitSpeed: 2.2 } } },
          { name: 'Missile Pods',   cost: 1800, desc: 'Shots explode on impact, and anything caught in a blast is lit up for the whole crew (+20% damage taken) for 3s.', mods: { add: { splash: 40, pierce: 5, damage: 1 }, fx: { mark: { amt: 0.2, d: 3 } } } },
        ]},
        { name: 'Ace', tiers: [
          { name: 'Combat Trim',    cost: 380, desc: '+25% attack speed.',                mods: { mul: { rate: 1.25 } } },
          { name: 'High Patrol',    cost: 700, desc: '+20% range, +1 damage.',            mods: { mul: { range: 1.2 }, add: { damage: 1 } } },
          { name: 'Strafing Dive',  cost: 2100, desc: 'Screams into a low, fast pass — orbit speed doubled, +30% range, and every round bursts on impact.', mods: { mul: { range: 1.3 }, add: { splash: 26, pierce: 3 }, set: { orbitSpeed: 2.8 } } },
        ]},
      ],
    },
    artillery: {
      cls: 'navy', name: 'Mech Cannon', cost: 850,
      desc: 'A Bro in a walking mech with a shoulder gun. Massive range, massive shells, blind up close.',
      /* 420 covered 54% of the whole battlefield from one tile — one of these
         made placement meaningless. 320 is still by far the longest reach.
         `arcs` is its whole identity now that terrain blocks shots: a howitzer
         lobs over ridges and boulders that every other Bro has to see past. */
      stats: { range: 320, rate: 0.33, damage: 6, pierce: 16, splash: 85, kind: 'lob', minRange: 110, water: 'never', arcs: true },
      paths: [
        { name: 'Shells', tiers: [
          { name: 'HE Shells',      cost: 500, desc: '+4 damage.',                        mods: { add: { damage: 4 } } },
          { name: 'Siege Shells',   cost: 1000, desc: '+4 more damage, +25 blast radius.', mods: { add: { damage: 4, splash: 25 } } },
          { name: 'Cratered Plate', cost: 2800, desc: 'Shells leave craters for 4s — 4 dmg/s and a 25% clog to anything crossing them.', mods: { set: { zone: { r: 70, life: 4, dps: 4, slowF: 0.75, tone: 'ice' } } } },
        ]},
        { name: 'Logistics', tiers: [
          { name: 'Loader Team',    cost: 450, desc: '+50% attack speed.',                mods: { mul: { rate: 1.5 } } },
          { name: 'Forward Observer', cost: 700, desc: 'Smaller blind zone, +10% range.', mods: { set: { minRange: 60 }, mul: { range: 1.1 } } },
          { name: 'Firebase',       cost: 2200, desc: 'Shells leave the impact burning for 3s (3 dmg/s), and the mech steadies the line: Bros near it attack 8% faster.', mods: { set: { zone: { r: 55, life: 3, dps: 3, tone: 'fire' }, auraR: 140 }, add: { auraRate: 0.08 } } },
        ]},
        { name: 'Barrage', tiers: [
          { name: 'Drilled Crew',   cost: 480, desc: '+35% attack speed.',                mods: { mul: { rate: 1.35 } } },
          { name: 'Flechette Mix',  cost: 900, desc: '+6 blast targets.',                 mods: { add: { pierce: 6 } } },
          { name: 'Rolling Barrage', cost: 2500, desc: 'Trades the single great shell for a volley of three smaller ones, walked along the track.', mods: { mul: { damage: 0.55 }, set: { shots: 3, walk: 70 } } },
        ]},
      ],
    },

    /* ---- WIZARDS ---- */
    aurora: {
      cls: 'mystic', name: 'Spark Mage', cost: 420,
      desc: 'Channels raw spark into piercing bolts that punch through a whole line.',
      stats: { range: 145, rate: 0.9, damage: 2, pierce: 6, projSpeed: 380, kind: 'bullet', water: 'never' },
      paths: [
        { name: 'Radiance', tiers: [
          { name: 'Brighter Bolts', cost: 250, desc: '+2 damage.',                        mods: { add: { damage: 2 } } },
          { name: 'Arc Lightning',  cost: 600, desc: '+6 pierce, faster bolts.',          mods: { add: { pierce: 6 }, mul: { projSpeed: 1.35 } } },
          { name: 'Solar Flare',    cost: 1700, desc: 'Bolts burst on impact and leave a patch of burning spark on the ground for 2s — 3 dmg/s to anything crossing it.', mods: { add: { damage: 2, splash: 50, pierce: 4 }, set: { zone: { r: 44, life: 2, dps: 3, tone: 'aurora' } } } },
        ]},
        { name: 'Attunement', tiers: [
          { name: 'Focused Mind',   cost: 220, desc: '+40% attack speed.',                mods: { mul: { rate: 1.4 } } },
          { name: 'Quicksilver Bolts', cost: 500, desc: '+20% range, faster bolts.',      mods: { mul: { range: 1.2, projSpeed: 1.3 } } },
          { name: 'Twin Sparks',   cost: 1400, desc: 'Two seeking bolts per cast, each picking its own target.', mods: { set: { shots: 2, multiTarget: true, kind: 'homing' } } },
        ]},
        { name: 'Conduit', tiers: [
          { name: 'Attuned Light',  cost: 240, desc: '+1 damage, +2 pierce.',             mods: { add: { damage: 1, pierce: 2 } } },
          { name: 'Resonance',      cost: 550, desc: 'Bolts deal +1 damage for every wizard curse on the target (clog, rot, burn).', mods: { set: { resonance: 1 } } },
          { name: 'Prism Conduit',  cost: 1500, desc: 'Bolts refresh wizard curses on the victim and spread one of them to a nearby vacuum.', mods: { set: { conduit: 90 } } },
        ]},
      ],
    },
    witch: {
      cls: 'mystic', name: 'Hex Witch', cost: 560,
      desc: 'Curses vacuums — strips armor and rots their strength over time.',
      stats: { range: 135, rate: 0.8, damage: 1, pierce: 2, projSpeed: 330, kind: 'bullet', water: 'never', fx: { shred: 1, dot: { dps: 2, d: 3 } } },
      paths: [
        { name: 'Hex', tiers: [
          { name: 'Deeper Curse',   cost: 300, desc: 'Rot deals 4 dmg/s.',                mods: { fx: { dot: { dps: 4, d: 3 } } } },
          /* Was "strips 2 armor per hit" — but shred is permanent, so going
             from 1 to 2 only ever saved a single hit. It now strips armour
             outright, which is a real capability rather than a rounding error. */
          { name: 'Armor Rust',     cost: 550, desc: 'The curse eats armor away entirely.', mods: { fx: { shred: 99 } } },
          { name: 'Plague of Rust', cost: 1600, desc: 'Rot deepens to 8 dmg/s, and a vacuum that dies rotting passes the full curse to its neighbours.', mods: { fx: { dot: { dps: 8, d: 4 } }, set: { plague: true } } },
        ]},
        { name: 'Coven', tiers: [
          { name: 'Cursed Sight',   cost: 240, desc: '+20% range.',                       mods: { mul: { range: 1.2 } } },
          { name: 'Double Hex',     cost: 520, desc: '+2 pierce, +40% attack speed.',     mods: { add: { pierce: 2 }, mul: { rate: 1.4 } } },
          { name: 'Withering Grasp', cost: 1300, desc: 'Cursed vacuums are clogged 35% and take +15% damage from every source while the curse holds.', mods: { fx: { slow: { f: 0.65, d: 2.5 }, mark: { amt: 0.15, d: 2.5 } } } },
        ]},
        { name: 'Plague Bearer', tiers: [
          { name: 'Festering Touch', cost: 260, desc: 'Curses last 2s longer.',           mods: { fx: { dot: { dps: 2, d: 5 } } } },
          { name: 'Miasma',         cost: 500, desc: 'Curses splash to vacuums pressed against the target.', mods: { set: { miasma: 46 } } },
          { name: 'Corrupted Ground', cost: 1500, desc: 'A vacuum that dies cursed leaves a stain on the track for 3s — anything crossing it catches the curse fresh.', mods: { set: { zone: { r: 42, life: 3, curse: true, tone: 'curse' }, zoneAt: 'death' } } },
        ]},
      ],
    },
    blizzard: {
      cls: 'mystic', name: 'Storm Caller', cost: 800,
      desc: 'Summons howling storms that batter and clog everything nearby.',
      stats: { range: 135, rate: 0.5, damage: 2, kind: 'pulse', water: 'never', fx: { slow: { f: 0.6, d: 1.5 } } },
      paths: [
        { name: 'Tempest', tiers: [
          { name: 'Biting Winds',   cost: 400, desc: '+2 storm damage.',                  mods: { add: { damage: 2 } } },
          { name: 'Widening Gyre',  cost: 800, desc: '+35% storm radius.',                mods: { mul: { range: 1.35 } } },
          { name: 'Blackout',       cost: 2200, desc: 'Storms cut the power for 0.8s, and restarting vacuums are vulnerable — +20% damage taken for 2s.', mods: { fx: { stun: 0.8, mark: { amt: 0.2, d: 2 } } } },
        ]},
        { name: 'Frequency', tiers: [
          { name: 'Restless Sky',   cost: 380, desc: '+50% storm frequency.',             mods: { mul: { rate: 1.5 } } },
          { name: 'Hailstones',     cost: 750, desc: '+3 damage.',                        mods: { add: { damage: 3 } } },
          { name: 'Endless Squall', cost: 1900, desc: 'Storms roll almost without pause (+80% frequency in total), and every storm locks the pack in place for a blink (0.4s).', mods: { mul: { rate: 1.2 }, fx: { stun: 0.4 } } },
        ]},
        { name: 'Eye of the Storm', tiers: [
          { name: 'Stormsight',     cost: 350, desc: '+25% range.',                       mods: { mul: { range: 1.25 } } },
          { name: 'Low Pressure',   cost: 700, desc: 'Storm clog deepened to 50%.',       mods: { fx: { slow: { f: 0.5, d: 2 } } } },
          { name: 'The Anchored Eye', cost: 2100, desc: 'The storm leaves its footprint scoured into the track — a lingering squall (4s) that keeps clogging 40% after the storm has passed.', mods: { set: { zone: { r: 0, life: 4, slowF: 0.6, tone: 'ice' }, zoneAt: 'self' } } },
        ]},
      ],
    },
    shadow: {
      cls: 'mystic', name: 'Shadow Ninja', cost: 470,
      desc: 'A ninja Bro. Flings steel shuriken fast, and always sees stealth.',
      stats: { range: 140, rate: 2.2, damage: 1, pierce: 2, projSpeed: 560, kind: 'bullet', stealth: true, water: 'never' },
      paths: [
        { name: 'Assassin', tiers: [
          { name: 'Honed Edges',  cost: 280, desc: '+1 damage.',                        mods: { add: { damage: 1 } } },
          { name: 'Flurry',         cost: 620, desc: 'Throws 3 shuriken per attack.',     mods: { set: { shots: 3 } } },
          { name: 'Killing Strike',  cost: 1800, desc: '25% chance to crit for triple damage — and a strike on a stealth vacuum always crits.', mods: { set: { crit: { p: 0.25, mult: 3, stealthAlways: true } } } },
        ]},
        { name: 'Sabotage', tiers: [
          { name: 'Numbing Strikes', cost: 260, desc: 'Hits clog vacuums 25%.',         mods: { fx: { slow: { f: 0.75, d: 1.4 } } } },
          { name: 'Deep Reach',     cost: 480, desc: '+35% range.',                       mods: { mul: { range: 1.35 } } },
          { name: 'Death Mark',     cost: 1500, desc: 'Shuriken mark the victim for 3s — it takes +25% damage from every source.', mods: { fx: { mark: { amt: 0.25, d: 3 } } } },
        ]},
        { name: 'Ghost', tiers: [
          { name: 'Silent Steps',   cost: 270, desc: '+30% attack speed.',                mods: { mul: { rate: 1.3 } } },
          { name: 'Umbral Blades',  cost: 500, desc: '+1 damage, +1 pierce.',             mods: { add: { damage: 1, pierce: 1 } } },
          { name: 'Decoy Double',     cost: 1600, desc: 'Every 8s, plants a glittering brick double on the track — the next three vacuums to reach it each stop dead for half a second as it cracks beneath them.', mods: { set: { aux: { kind: 'pile', every: 8, maxPiles: 2, charges: 3, hold: 0.5, decoy: true } } } },
        ]},
      ],
    },
    sunpriest: {
      cls: 'mystic', name: 'Sun Priest', cost: 2400,
      desc: 'The legendary Bro who bottled a star. Melts everything.',
      stats: { range: 165, rate: 4.0, damage: 3, pierce: 1, kind: 'ray', water: 'never', armorPierce: true },
      paths: [
        { name: 'Corona', tiers: [
          { name: 'Focused Beam',   cost: 1400, desc: '+3 damage.',                       mods: { add: { damage: 3 } } },
          { name: 'Solar Lance',    cost: 3200, desc: 'The beam burns through 4 vacuums.', mods: { add: { pierce: 3 } } },
          { name: 'Supernova Focus', cost: 8000, desc: 'The beam ramps while it holds one target — +1 damage per tick, up to +15, resetting when it switches.', mods: { set: { ramp: { per: 1, max: 15 } } } },
        ]},
        { name: 'Zenith', tiers: [
          { name: 'All-Seeing Light', cost: 1200, desc: 'Sees stealth, +25% range.',      mods: { set: { stealth: true }, mul: { range: 1.25 } } },
          { name: 'Searing Heat',   cost: 2800, desc: 'Targets burn for 6 dmg/s.',        mods: { fx: { dot: { dps: 6, d: 2.5 } } } },
          { name: 'Solar Judgment', cost: 7000, desc: 'The beam strips 1 armor per second and deals +150% damage to bosses.', mods: { fx: { shredPerSec: 1 }, set: { bossBonus: 2.5 } } },
        ]},
        { name: 'Eclipse', tiers: [
          { name: 'Wide Lens',      cost: 1300, desc: '+2 damage, +15% range.',           mods: { add: { damage: 2 }, mul: { range: 1.15 } } },
          { name: 'Twin Mirrors',   cost: 3000, desc: 'The beam splits to a second target at 60% power.', mods: { set: { split: { n: 1, frac: 0.6 } } } },
          { name: 'Scorched Path',  cost: 7500, desc: 'The ground catches light where the beam lands — each struck spot burns (5 dmg/s) for 3s, so a sweeping beam writes a line of fire across the track.', mods: { set: { zone: { r: 34, life: 3, dps: 5, tone: 'fire' } } } },
        ]},
      ],
    },

    /* ---- CREW ---- */
    /* Reworked Aug 2026. Two problems at once: every upgrade was "+N studs a
       wave" with only the number changing, and stacking vendors printed money
       without limit. Market keeps the plain reliable income; Finance now pays
       three *different* ways — off your kills, off your board, off your
       savings — so the two paths are a real choice. Vendor payouts also suffer
       diminishing returns per extra vendor (see the wave-end payout in
       engine.js), which is what actually caps the runaway. */
    vendor: {
      cls: 'support', name: 'Parts Trader', cost: 900,
      desc: 'Sorts loose bricks into sellable parts. Nets extra studs at the end of every wave — but the market only bears so many stalls: each extra vendor earns 30% less than the one before it.',
      stats: { kind: 'income', income: 65, range: 150, water: 'never' },
      paths: [
        { name: 'Market', tiers: [
          { name: 'Bigger Stall',   cost: 500, desc: '+60 🔩 per wave.',                  mods: { add: { income: 60 } } },
          { name: 'Stud Market',    cost: 1100, desc: '+130 🔩 per wave.',                mods: { add: { income: 130 } } },
          { name: 'Parts Conglomerate', cost: 2800, desc: '+300 🔩 per wave, and this stall ignores the market falloff — it always sells at full price, whatever its rank.', mods: { add: { income: 300 }, set: { noFalloff: true } } },
        ]},
        { name: 'Finance', tiers: [
          { name: 'Salvage Rights',    cost: 450, desc: 'Claims the scrap: every vacuum the workshop destroys pays +1 🔩.', mods: { set: { bountyBonus: 1 } } },
          { name: 'Trade Hub',      cost: 1000, desc: '+20 🔩 per wave for each Bro in range.', mods: { set: { tradeHub: 20 } } },
          { name: 'Bro Bank',   cost: 2400, desc: 'Also pays 5% interest on saved studs each wave (max 250 🔩). Hoarders rejoice.', mods: { set: { interest: 0.05 } } },
        ]},
        { name: 'Supply Chain', tiers: [
          { name: 'Delivery Carts', cost: 480, desc: '+40 🔩 per wave.',                  mods: { add: { income: 40 } } },
          { name: 'Warehouse',   cost: 1050, desc: 'Wave-clear rewards are +10% while the stall stands.', mods: { set: { waveBonus: 0.1 } } },
          { name: 'Bulk Orders', cost: 2600, desc: 'Every Bro built or upgraded while it stands costs 5% less studs.', mods: { set: { buildDiscount: 0.05 } } },
        ]},
      ],
    },
    fort: {
      cls: 'support', name: 'Brick Fort', cost: 1000,
      desc: 'A studded keep that inspires helpers inside its circle: +16% damage.',
      stats: { kind: 'aura', range: 125, auraDmg: 0.16, water: 'never' },
      paths: [
        { name: 'Command', tiers: [
          { name: 'War Room',       cost: 600, desc: 'Helpers hit 28% harder.',                 mods: { add: { auraDmg: 0.12 } } },
          { name: 'Elite Training', cost: 1300, desc: 'Wider circle; helpers pierce 1 more.', mods: { mul: { range: 1.15 }, set: { auraPierce: 1 } } },
          { name: 'High Command',   cost: 3200, desc: 'Helpers hit 52% harder and punch through 2 armor.', mods: { add: { auraDmg: 0.24 }, set: { auraShred: 2 } } },
        ]},
        { name: 'Garrison', tiers: [
          { name: 'Watchtower',     cost: 500, desc: 'Helpers see stealth vacuums.',      mods: { set: { auraStealth: true } } },
          { name: 'Drill Sergeant', cost: 1100, desc: 'Helpers attack 12% faster.', mods: { add: { auraRate: 0.12 } } },
          { name: 'Fortress Walls', cost: 2600, desc: 'Wider circle, +24% speed in total — and when a vacuum sets a wheel inside it the alarm sounds: helpers attack 40% faster for 3s.', mods: { mul: { range: 1.2 }, add: { auraRate: 0.12 }, set: { alarm: { rate: 1.4, d: 3 } } } },
        ]},
        { name: 'Bastion', tiers: [
          { name: 'Thick Walls',      cost: 550, desc: 'Circle 20% wider.',                  mods: { mul: { range: 1.2 } } },
          { name: 'Brick Ramparts',  cost: 1150, desc: 'Helpers hit 12% harder.',           mods: { add: { auraDmg: 0.12 } } },
          { name: 'Shield Dome',    cost: 2800, desc: 'Once per wave, the first vacuum to breach the circle triggers the dome — everything hostile inside seizes solid for 1.5s.', mods: { set: { dome: 1.5 } } },
        ]},
      ],
    },
    sonar: {
      cls: 'support', name: 'Radar Mast', cost: 550,
      /* Wording rule for every aura tower: "helpers see further" = the buff it
         gives OTHER Bros; "covers more ground" = how far the circle itself
         reaches. "Range aura" next to "aura radius" read as the same thing. */
      desc: 'Sweeps the board: helpers in its circle shoot further and see stealth.',
      stats: { kind: 'aura', range: 130, auraRange: 0.08, auraStealth: true, water: 'never' },
      paths: [
        { name: 'Amplify', tiers: [
          { name: 'Big Dish',       cost: 350, desc: 'Helpers shoot 13% further.', mods: { add: { auraRange: 0.05 } } },
          { name: 'Deep Ping',      cost: 700, desc: 'Circle covers 20% more ground.', mods: { mul: { range: 1.2 } } },
          { name: 'Grand Array',    cost: 1800, desc: 'Helpers’ shots pierce 1 extra vacuum.', mods: { set: { auraPierce: 1 } } },
        ]},
        { name: 'Decrypt', tiers: [
          { name: 'Signal Boost',   cost: 300, desc: 'Helpers attack 8% faster.',        mods: { add: { auraRate: 0.08 } } },
          { name: 'Echo Location',  cost: 650, desc: 'Circle covers 20% more ground.', mods: { mul: { range: 1.2 } } },
          { name: 'Full Decloak',   cost: 1600, desc: 'Stealth in the circle is revealed to EVERY Bro on the field, and revealed vacuums take +10% damage.', mods: { set: { decloak: true, revealMark: 0.1 } } },
        ]},
        { name: 'Overwatch', tiers: [
          { name: 'Target Feed',    cost: 320, desc: 'Helpers hit 8% harder.',        mods: { add: { auraDmg: 0.08 } } },
          { name: 'Priority Uplink', cost: 680, desc: 'Helpers shoot 10% further and 8% faster.', mods: { add: { auraRange: 0.1, auraRate: 0.08 } } },
          { name: 'Fire Control',   cost: 1700, desc: 'The station guides every shot from above — helpers in the circle fire clean over walls, wrecks and builds. Nothing on the map gives cover.', mods: { set: { auraArcs: true } } },
        ]},
      ],
    },
    drummer: {
      cls: 'support', name: 'War Drummer', cost: 700,
      desc: 'Pounds a barrel drum: helpers inside its circle attack 16% faster.',
      stats: { kind: 'aura', range: 120, auraRate: 0.16, water: 'never' },
      paths: [
        { name: 'Rhythm', tiers: [
          { name: 'Double Time',    cost: 450, desc: 'Helpers attack 28% faster.',            mods: { add: { auraRate: 0.12 } } },
          { name: 'Battle Anthem',  cost: 950, desc: 'Helpers attack 44% faster.',            mods: { add: { auraRate: 0.16 } } },
          { name: 'Thunder Drums',  cost: 2400, desc: 'Helpers attack 64% faster, wider circle — and every eighth beat is a thunderclap that staggers vacuums in the circle (0.3s).', mods: { add: { auraRate: 0.2 }, mul: { range: 1.15 }, set: { aux: { kind: 'stagger', every: 4, stun: 0.3 } } } },
        ]},
        { name: 'Morale', tiers: [
          { name: 'Rallying Beat',  cost: 400, desc: 'Helpers hit 8% harder.',      mods: { add: { auraDmg: 0.08 } } },
          { name: 'Fierce Cadence', cost: 850, desc: 'Helpers hit 16% harder.',     mods: { add: { auraDmg: 0.08 } } },
          { name: 'Heroic Ballad',  cost: 2000, desc: 'Helpers punch through 2 armor.', mods: { set: { auraShred: 2 } } },
        ]},
        { name: 'War Song', tiers: [
          { name: 'Longer Verses',  cost: 420, desc: 'Circle 20% wider.',           mods: { mul: { range: 1.2 } } },
          { name: 'Crescendo',      cost: 900, desc: 'Helpers attack 12% faster.',  mods: { add: { auraRate: 0.12 } } },
          { name: 'Drum Solo',      cost: 2200, desc: 'As each wave arrives, an opening solo — every Bro on the field attacks 30% faster for 5s.', mods: { set: { solo: { rate: 1.3, d: 5 } } } },
        ]},
      ],
    },
    icewall: {
      cls: 'support', name: 'Wall Builder', cost: 650,
      desc: 'Stacks walls of upturned bricks on the track that shred whatever rolls over them.',
      stats: { kind: 'spikes', range: 120, rate: 0.45, charges: 6, spikeDmg: 2, maxPiles: 4, water: 'never' },
      paths: [
        { name: 'Jagged', tiers: [
          { name: 'Sharper Spikes', cost: 350, desc: 'Spikes deal 4 damage.',             mods: { add: { spikeDmg: 2 } } },
          { name: 'Dense Walls',    cost: 750, desc: '10 spikes per wall.',               mods: { add: { charges: 4 } } },
          { name: 'Stud Teeth',  cost: 2000, desc: 'Spikes deal 9 damage, 14 per wall, and each bite shreds 1 armor.', mods: { add: { spikeDmg: 5, charges: 4 }, set: { spikeShred: 1 } } },
        ]},
        { name: 'Industry', tiers: [
          { name: 'Fast Builder',   cost: 300, desc: '+55% build speed.',                 mods: { mul: { rate: 1.55 } } },
          { name: 'Wide Operation', cost: 650, desc: '+35% range, 6 walls at once.',      mods: { mul: { range: 1.35 }, add: { maxPiles: 2 } } },
          { name: 'Rapid Works', cost: 1700, desc: '9 walls at once, and each new wall goes up in a burst of grit that clogs passing vacuums 30% for 1.5s.', mods: { add: { maxPiles: 3 }, set: { pileFlash: { f: 0.7, d: 1.5 } } } },
        ]},
        /* "Walls last 50% longer" has to mean something the engine can show. A
           wall's life here is its spikes, not a clock, so Reinforced adds half as
           many again (6 → 9) rather than a timer nothing else in the game has. */
        { name: 'Engineer', tiers: [
          { name: 'Reinforced',       cost: 320, desc: 'Spikes deal +2 damage, and walls hold 3 more spikes before they crumble.', mods: { add: { spikeDmg: 2, charges: 3 } } },
          { name: 'Buttressed Walls', cost: 700, desc: '+2 spikes per wall, +20% range.', mods: { add: { charges: 2 }, mul: { range: 1.2 } } },
          { name: 'Self-Repairing',     cost: 1900, desc: 'Walls regrow a spent spike every second while vacuums are grinding on them.', mods: { set: { regrow: 1 } } },
        ]},
      ],
    },
  };

  G.TOWER_ORDER = [
    'pebble', 'snowball', 'shards', 'glacier', 'slush',
    'harpoon', 'torpedo', 'depth', 'jetpack', 'artillery',
    'aurora', 'witch', 'blizzard', 'shadow', 'sunpriest',
    'vendor', 'fort', 'sonar', 'drummer', 'icewall',
  ];

  /* ---------------- Heroes ----------------
     One per battle, placed like a tower (cost = studs). They level up on their
     own — on vacuums felled while the hero stands on the field, to level 20
     (see the levelling curve below) — and their
     damage scales with the pack's toughness (the battlefield's hpMult, plus the
     endless curve past wave 50), so a hero hits as hard as the vacuums are
     tough, on every map. At level `ability.unlock` a signature ability opens:
     free to fire, recharges on the battle clock.
     Registered in G.TOWERS (hero: true, paths: []) so placement, targeting,
     drawing and saves all reuse the tower pipeline; G.HEROES holds what makes
     them heroes: the brick price to own one, per-level growth, the ability. */
  G.TOWERS.hero_frost = {
    cls: 'frost', hero: true, name: 'Captain Flint', cost: 450,
    desc: 'The workshop’s champion. Fights harder on every battlefield, and grows with every wave.',
    stats: { range: 165, rate: 1.3, damage: 5, pierce: 2, projSpeed: 540, kind: 'bullet', stealth: true, water: 'never' },
    paths: [],
  };
  G.TOWERS.hero_beak = {
    cls: 'support', hero: true, name: 'Foreman Bolt', cost: 500,
    desc: 'A living rallying cry: every Bro near him fights harder and faster.',
    stats: { range: 155, rate: 1.0, damage: 2, pierce: 2, projSpeed: 480, kind: 'bullet', auraDmg: 0.12, auraRate: 0.08, water: 'never' },
    paths: [],
  };
  G.TOWERS.hero_shiver = {
    cls: 'mystic', hero: true, name: 'Elder Gritt', cost: 500,
    desc: 'The oldest Bro on the board. Everything she touches clogs, then stops.',
    stats: { range: 150, rate: 0.9, damage: 3, pierce: 3, projSpeed: 420, splash: 30, kind: 'bullet', stealth: true, water: 'never', fx: { slow: { f: 0.65, d: 1.8 } } },
    paths: [],
  };
  /* Six more champions, each built around a job the first three do not do:
     shredding swarms, reaching the whole map, arcing over terrain, stripping
     casing, burning armour off outright, and paying the workshop. Every one of
     them is assembled from weapon kinds the engine already fires. */
  G.TOWERS.hero_tilly = {
    cls: 'frost', hero: true, name: 'Scout Tilly', cost: 400,
    desc: 'Fastest hands in the workshop. Buries swarms in bricks, spots anything hiding — and lends her eyes to every Knight around her.',
    /* Pack Scout. Detection stopped being a tier-1 filler on nine towers in the
       3-path roster, so the Knights' answer is Keen Eyes at 🔩90 — and Tilly is
       the luxury version of it: what a scout is actually FOR. auraClass keeps
       it to her own class rather than quietly re-blinding the whole board. */
    stats: { range: 145, rate: 2.6, damage: 1, pierce: 3, projSpeed: 560, kind: 'bullet', stealth: true, water: 'never',
             auraStealth: true, auraClass: 'frost' },
    paths: [],
  };
  G.TOWERS.hero_rook = {
    cls: 'navy', hero: true, name: 'Gunner Rook', cost: 600,
    desc: 'Never misses, wherever it stands. Punches through casing and hits the big ones hardest.',
    stats: { range: 9999, rate: 0.6, damage: 6, pierce: 2, kind: 'snipe', armorPierce: true, bossBonus: 1.6, water: 'never' },
    paths: [],
  };
  G.TOWERS.hero_marlow = {
    cls: 'navy', hero: true, name: 'Major Marlow', cost: 620,
    desc: 'Lobs shells clean over walls and builds. Nowhere on the track is out of reach.',
    stats: { range: 260, rate: 0.55, damage: 4, pierce: 12, splash: 78, kind: 'lob', arcs: true, minRange: 60, water: 'never' },
    paths: [],
  };
  G.TOWERS.hero_kell = {
    cls: 'mystic', hero: true, name: 'Warden Kell', cost: 540,
    desc: 'Strips casing and leaves a wound that keeps working. The answer to armour and to healers.',
    stats: { range: 150, rate: 1.0, damage: 2, pierce: 4, projSpeed: 400, kind: 'bullet', water: 'never', fx: { shred: 1, dot: { dps: 3, d: 3 } } },
    paths: [],
  };
  G.TOWERS.hero_sage = {
    cls: 'mystic', hero: true, name: 'Prism Sage', cost: 580,
    desc: 'Holds a beam of hard starlight on the track. Armour means nothing to it.',
    stats: { range: 160, rate: 3.4, damage: 2, pierce: 1, kind: 'ray', armorPierce: true, water: 'never' },
    paths: [],
  };
  G.TOWERS.hero_fen = {
    cls: 'support', hero: true, name: 'Trader Fen', cost: 450,
    desc: 'Keeps the books. Every vacuum the workshop fells pays out more while he is on the board.',
    stats: { range: 150, rate: 0.9, damage: 1, pierce: 1, projSpeed: 420, kind: 'bullet', bountyBonus: 1, auraDmg: 0.06, water: 'never' },
    paths: [],
  };

  /* ability.fire(game, tower, strength) — `strength` is G.heroStrength for the
     battlefield and wave, the same multiplier the hero's own damage rides, so
     an ability stays meaningful in deep endless instead of becoming a rounding
     error. Kept here beside each hero rather than in a switch in the engine. */

  /* ---- the share-of-the-animal half of a hero ability ----
     Flat ability damage rides heroStrength, which is 1.05 per wave past 50.
     Boss health rides 1.055 and heavy health starts in the thousands, so flat
     alone loses the race and then keeps losing it. Measured on Main Street:
     Avalanche Charge was 405 against a 29,283 HP Great Heavy at wave 101, and
     385 against the 212,801 HP MEGAVAC at wave 100 — two tenths of one
     per cent. It was landing. There was simply no way to see that it had.

     A percentage of the target's own maximum health cannot become invisible,
     whatever the health is. Two rails keep it from becoming the game:

     Heavyweights only. G.isHeavyweight is the bosses and the heavies; ordinary
     vacuums get nothing, because the flat damage already overkills them between
     three and sixteen times over at every wave measured, and a percentage there
     would only make swarms free.

     And the whole cast is capped at HERO_BITE_CAP of the animal. The cap can
     only ever take away bite, never flat, so no ability is weaker anywhere than
     it was — it is there for very deep endless, where heroStrength eventually
     outruns heavy health and the flat alone would start one-shotting them. */
  G.HERO_BITE_CAP = 0.12;
  G.heroBite = (e, pct, flatDealt) =>
    !G.isHeavyweight(e) ? 0
      : Math.max(0, Math.min(Math.round(e.maxHp * pct),
        Math.round(e.maxHp * G.HERO_BITE_CAP) - flatDealt));

  G.HEROES = {
    hero_frost: {
      bricks: 0,
      blurb: 'Heavy single-target damage. Grows into a boss-killer.',
      perLevel: { damage: 0.20, rate: 0.04 },       // per level above 1
      ability: { name: 'Brick Slam', icon: '🧱', cd: 45, unlock: 3,
                 desc: 'Smashes every vacuum on the field, ignoring armor. Takes an extra 1.5% off anything boss-sized.',
                 fire(g, t, s) {
                   const dmg = Math.round(30 * s);
                   for (const e of [...g.enemies]) {
                     if (e.dead) continue;
                     g.damageEnemy(e, dmg + G.heroBite(e, 0.015, dmg), null, { pure: true });
                   }
                   g.effects.push({ kind: 'boom', x: G.W / 2, y: G.H / 2, r: 420, life: 0.4, max: 0.4 });
                 } },
    },
    hero_beak: {
      bricks: 5000,
      blurb: 'Weak alone, mighty together — his aura grows with every level.',
      perLevel: { damage: 0.12, auraDmg: 0.016, auraRate: 0.012, range: 0.02 },
      ability: { name: 'Rally Horn', icon: '📯', cd: 60, unlock: 3,
                 desc: 'The whole crew attacks 50% faster for 8 seconds.',
                 fire(g, t) {
                   g.frenzyUntil = Math.max(g.frenzyUntil, g.time + 8);
                   g.effects.push({ kind: 'storm', x: t.x, y: t.y, r: 320, life: 0.6, max: 0.6 });
                 } },
    },
    hero_shiver: {
      bricks: 7500,
      blurb: 'Clogs whole packs; her drag deepens as she levels.',
      perLevel: { damage: 0.15, slow: 0.025, range: 0.015 },
      ability: { name: 'Deep Jam', icon: '🔧', cd: 50, unlock: 3,
                 desc: 'Jams every vacuum solid for 2.5s. Boss-sized ones hold still for less, but the jam leaves them soft: +35% damage for 5s.',
                 fire(g, t) {
                   for (const e of g.enemies) {
                     if (e.dead) continue;
                     /* G.isHeavyweight, not e.boss. Only heavy_king carries
                        boss:true — a Great Heavy is heavy:true and boss:false —
                        so the short freeze meant for the biggest animal in the
                        game was being applied to the MEGAVAC and the full
                        2.5s to its escort. Exactly backwards. */
                     const lev = G.isHeavyweight(e);
                     /* And a flat second buys the same absolute time at wave 25
                        as at wave 125, by which point the wave is forty times
                        harder. It grows with the run, to a ceiling. */
                     const secs = lev ? Math.min(3, 1 + Math.max(0, g.wave - 50) * 0.02) : 2.5;
                     e.stunUntil = Math.max(e.stunUntil, g.time + secs);
                     /* Holding a boss still is only worth what the workshop can
                        put through the window, and against eight armour that is
                        not much. A mark multiplies AFTER armour (see
                        damageEnemy), so this is the half of the freeze that
                        actually reaches a heavyweight. */
                     if (lev) g.applyFx(e, { mark: { amt: 0.35, d: 5 } });
                   }
                   g.effects.push({ kind: 'storm', x: G.W / 2, y: G.H / 2, r: 620, life: 0.6, max: 0.6 });
                 } },
    },
    hero_tilly: {
      bricks: 2750,
      blurb: 'Shreds swarms and sees stealth. Pack Scout: Knights in her reach see what she sees.',
      perLevel: { damage: 0.10, rate: 0.05, range: 0.01 },
      ability: { name: 'Grit Storm', icon: '🌪️', cd: 35, unlock: 3,
                 desc: 'A whirl of loose bricks: heavy damage to everything near her, and an extra 0.8% off anything boss-sized.',
                 /* The smallest bite in the roster: the shortest cooldown, and
                    Tilly is the swarm hero — a boss has to come to her. */
                 fire(g, t, s) { g.splashAt(t.x, t.y, 230, Math.round(14 * s), t, 40, null, 0.008); } },
    },
    hero_rook: {
      bricks: 7500,
      blurb: 'Reaches the whole battlefield, ignores armour, and hits bosses 60% harder.',
      perLevel: { damage: 0.18, rate: 0.03 },
      ability: { name: 'Laser Volley', icon: '🎯', cd: 45, unlock: 3,
                 desc: 'Puts a beam through the eight biggest vacuums on the field, and takes an extra 3% off anything boss-sized.',
                 /* The largest bite in the roster, because Rook IS the
                    boss-killer: eight targets only, a 45s cooldown, and a
                    statline that already carries bossBonus. */
                 fire(g, t, s) {
                   const dmg = Math.round(70 * s);
                   const big = g.enemies.filter((e) => !e.dead)
                     .sort((a, b) => (G.ENEMIES[b.type].rank - G.ENEMIES[a.type].rank) || (b.hp - a.hp))
                     .slice(0, 8);
                   for (const e of big) {
                     const ep = G.samplePath(g.paths[e.pathIdx], e.dist);
                     g.effects.push({ kind: 'snipeTrack', x: t.x, y: t.y, tx: ep.x, ty: ep.y, life: 0.2, max: 0.2 });
                     g.damageEnemy(e, dmg + G.heroBite(e, 0.030, dmg), null, { pure: true });
                   }
                 } },
    },
    hero_marlow: {
      bricks: 2500,
      blurb: 'Arcs over walls and builds. Long reach, wide blast, slow hands.',
      perLevel: { damage: 0.15, range: 0.015 },
      ability: { name: 'Shell Barrage', icon: '💣', cd: 40, unlock: 3,
                 desc: 'Walks six shells down the track, each one a wide blast, and takes an extra 1% off anything boss-sized.',
                 fire(g, t, s) {
                   const dmg = Math.round(22 * s);
                   /* One Set for the whole barrage. A big animal is wide enough
                      to stand inside two of the six blasts and take the flat
                      damage twice, which it always has; taking the percentage
                      twice would quietly make Marlow the best boss-killer in the
                      game depending on where the MEGAVAC happened to be standing. */
                   const bitten = new Set();
                   /* Spread along the track rather than around the hero: the
                      point of the barrage is to reach the part of the track a
                      lobbing tower is already covering. */
                   for (const path of g.paths) {
                     const n = Math.max(1, Math.round(6 / g.paths.length));
                     for (let i = 0; i < n; i++) {
                       const p = G.samplePath(path, path.total * ((i + 0.5) / n));
                       g.splashAt(p.x, p.y, 110, dmg, t, 14, null, 0.010, bitten);
                     }
                   }
                 } },
    },
    hero_kell: {
      bricks: 4000,
      /* Coven Warden. Corrosion leaves a rot, and rot is what the Spark Mage's
         Conduit path and the Hex Witch's Plague Bearer path read as a wizard
         curse — so his burn is already something they can refresh and spread.
         The passive is the wording catching up with the mechanics. */
      blurb: 'Strips casing and poisons the wound. Coven Warden: his Corrosion burn counts as a wizard curse, so Conduit and Plague Bearer can spread and refresh it.',
      perLevel: { damage: 0.13, rate: 0.03, range: 0.015 },
      ability: { name: 'Corrosion', icon: '🧪', cd: 40, unlock: 3,
                 desc: 'Strips 3 armour from every vacuum on the field and leaves them burning — boss-sized ones lose a further 0.2% a second.',
                 /* The shred needed nothing: armour is a constant at every wave,
                    the MEGAVAC is armour 8 at wave 100 and armour 8 at wave
                    300, so three casts bare it completely and that is already
                    worth more than any hero's direct damage. Only the burn was
                    losing the race. */
                 fire(g, t, s) {
                   const dps = Math.round(6 * s);
                   for (const e of g.enemies) {
                     if (e.dead) continue;
                     g.applyFx(e, { shred: 3, dot: { dps: dps + G.heroBite(e, 0.002, dps), d: 5 } });
                   }
                   g.effects.push({ kind: 'storm', x: G.W / 2, y: G.H / 2, r: 620, life: 0.6, max: 0.6 });
                 } },
    },
    hero_sage: {
      bricks: 6250,
      blurb: 'A steady armour-piercing beam. Relentless on one target at a time.',
      perLevel: { damage: 0.12, rate: 0.04, range: 0.01 },
      ability: { name: 'Prism Veil', icon: '🌌', cd: 40, unlock: 3,
                 desc: 'Drops a curtain of light: vacuums are clogged hard and scorched, and boss-sized ones are stripped bare instead — +20% damage for 5s, plus 1% off them.',
                 fire(g, t, s) {
                   const dmg = Math.round(18 * s);
                   for (const e of [...g.enemies]) {
                     if (e.dead) continue;
                     /* The slow is a good crowd tool and nothing is wrong with
                        it there. On a heavyweight it is worth almost nothing and
                        gets worse as the run goes on: the boss softening and
                        then slowResist compound, so by wave 125 a 60% slow has
                        become a 10% slow for two seconds. Spend it as a mark on
                        those instead — the light strips rather than slows. */
                     if (G.isHeavyweight(e)) g.applyFx(e, { mark: { amt: 0.20, d: 5 } });
                     else g.applyFx(e, { slow: { f: 0.4, d: 5 } });
                     g.damageEnemy(e, dmg + G.heroBite(e, 0.010, dmg), null, { pure: true });
                   }
                   g.effects.push({ kind: 'storm', x: G.W / 2, y: G.H / 2, r: 640, life: 0.7, max: 0.7 });
                 } },
    },
    hero_fen: {
      bricks: 4500,
      blurb: 'Fights poorly, pays well: every kill the workshop makes is worth more.',
      perLevel: { damage: 0.08, bounty: 0.12, auraDmg: 0.008, range: 0.015 },
      ability: { name: 'Stud Haul', icon: '🔩', cd: 50, unlock: 3,
                 desc: 'Calls in the carts: a lump of studs, bigger on deeper waves.',
                 /* The ceiling was 6, and sqrt(heroStrength) reaches it at wave
                    121 — so the haul froze at 2,400 and stayed there for the
                    rest of an endless run while everything it buys got steadily
                    more expensive to keep up with. The square root is doing the
                    right job; only the ceiling arrived too early. Nothing at or
                    before wave 121 changes. */
                 fire(g, t, s) {
                   const haul = Math.round(400 * Math.min(20, Math.max(1, Math.sqrt(s))));
                   g.cash += haul;
                   g.texts.push({ x: t.x, y: t.y, txt: '+' + haul + '🔩', life: 1.4, kind: 'cash' });
                   g.effects.push({ kind: 'storm', x: t.x, y: t.y, r: 220, life: 0.6, max: 0.6 });
                 } },
    },
  };
  /* Listed cheapest first, and the prices themselves come from measurement:
     each champion was run through 18 identical battles (six battlefield and
     difficulty pairings x three seeds) against the same scripted defence, with
     its ability fired the moment it recharged. The lift over fighting heroless
     was mapped onto the 2,500-7,500 band, so what a hero costs is what it was
     worth. The ladder is stable — per-seed spread was 0.0-0.2 waves. */
  G.HERO_ORDER = ['hero_frost', 'hero_marlow', 'hero_tilly', 'hero_kell', 'hero_fen',
                  'hero_beak', 'hero_sage', 'hero_rook', 'hero_shiver'];

  /* ---- hero levelling ----
     Level comes from vacuums destroyed while the hero stands on the field;
     strength comes from the pack itself (below). Kills, not waves cleared: a
     hero that has been in the thick of it should grow faster than one parked
     on a quiet corner, and a wave counter cannot tell those apart.

     Each level costs more than the last — level L needs 25 x (L-1)^2 kills —
     so the curve is fast early and slow late. Fitted to a census of what the
     game actually fields: battlefield 1 on Easy sends 2,143 vacuums across
     its 30 waves, and the hardest campaign (battlefield 30 on Hard) sends
     13,801 across 50. That 6.4x spread is why a flat "every N kills" would
     not work — it would cap instantly on the big maps.

     What the curve lands on: level 2 at 25 kills and level 3 (the ability) at
     100, which on battlefield 1 Easy is waves 3 and 5 — the same early pace
     the old every-3-waves rule gave, so nothing feels slower at the start.
     Level 10 needs 2,025, which is the last wave or two of a gentle campaign.
     Beyond that is endless territory: level 20 needs 9,025, roughly wave 65 of
     an endless run on battlefield 1.

     The cap is 20 rather than 10 because levelling is now driven by a quantity
     that keeps growing. At 10 the hero stopped progressing halfway through a
     Hard campaign and instantly in endless. Raising it is safe: the per-level
     gain is linear (Captain Flint is x2.8 damage at 10, x4.8 at 20), while
     heroStrength below is already exponential in deep endless, so the level
     ladder is the small term. */
  G.HERO_MAX_LEVEL = 20;
  G.HERO_KILL_BASE = 25;
  // kills needed to REACH a given level
  G.heroKillsFor = (level) => G.HERO_KILL_BASE * Math.pow(Math.max(0, level - 1), 2);
  G.heroLevelFor = (heroKills) =>
    Math.min(G.HERO_MAX_LEVEL, 1 + Math.floor(Math.sqrt(Math.max(0, heroKills || 0) / G.HERO_KILL_BASE)));
  /* Progress toward the next level, for the hero panel. Returns null at the
     cap so the panel can say "maxed" instead of showing a bar that never
     moves. */
  G.heroProgress = (heroKills) => {
    const k = Math.max(0, heroKills || 0);
    const lv = G.heroLevelFor(k);
    if (lv >= G.HERO_MAX_LEVEL) return null;
    const from = G.heroKillsFor(lv), to = G.heroKillsFor(lv + 1);
    return { level: lv, into: k - from, need: to - from, next: lv + 1 };
  };
  G.heroStrength = (L, wave) =>
    ((L && L.hpMult) || 1) * (wave > 50 ? Math.pow(1.05, wave - 50) : 1);
  G.applyHeroScale = function (calc, heroId, level, strength) {
    const pl = (G.HEROES[heroId] || {}).perLevel || {};
    const lv = Math.max(0, level - 1);
    if (calc.damage) calc.damage = Math.max(1, Math.round(calc.damage * (1 + (pl.damage || 0) * lv) * strength));
    if (pl.rate) calc.rate *= 1 + pl.rate * lv;
    if (pl.range) calc.range = Math.round(calc.range * (1 + pl.range * lv));
    if (pl.auraDmg) calc.auraDmg = (calc.auraDmg || 0) + pl.auraDmg * lv;
    if (pl.auraRate) calc.auraRate = (calc.auraRate || 0) + pl.auraRate * lv;
    // whole studs only — the per-kill bounty is added to a rounded price
    if (pl.bounty) calc.bountyBonus = Math.round((calc.bountyBonus || 0) + pl.bounty * lv);
    if (pl.slow && calc.fx && calc.fx.slow) {
      calc.fx = Object.assign({}, calc.fx, {
        slow: { f: Math.max(0.35, calc.fx.slow.f - pl.slow * lv), d: calc.fx.slow.d + 0.06 * lv },
      });
    }
    return calc;
  };

  /* Per-tower visual identity: body tint, hat, hand prop, scale.
     hat:  scarf captain helmet goggles earmuffs souwester aviator officer wizard
           hood crown headband halo straw beanie headset hardhat mohawk
     prop: sling snowball cannon hose harpoongun periscope jetpack howitzer
           staff crookstaff icering shuriken orb stud drumsticks pickaxe flag   */
  /* ---------------- How each Bro is dressed ----------------
     `tint` is the torso, `belly` is the legs, and the head is always the same
     yellow — nothing here can change it, because one shared head colour is what
     makes twenty different silhouettes read as one cast.

     Torsos run to the class colour so a glance at the board sorts them:
     Knights red, Space blue, Wizards purple, Crew green. Heroes wear gold
     somewhere and no two share a hat. */
  G.LOOKS = {
    /* Knights */
    pebble:    { hat: 'scarf',    hatColor: '#c8382f', prop: 'sling',      tint: '#c8443c', belly: '#7a3a2e' },
    snowball:  { hat: 'earmuffs', hatColor: '#8b98a5', prop: 'boulder',    tint: '#a63f38', belly: '#4c4c52' },
    shards:    { hat: 'goggles',  hatColor: '#67d4f5', prop: 'blades',     tint: '#d4564a', belly: '#57606b' },
    glacier:   { hat: 'helmet',   hatColor: '#8b98a5', prop: 'cannon',     propColor: '#5b4632', tint: '#8f4a3a', belly: '#4a3a2c' },
    slush:     { hat: 'beanie',   hatColor: '#37b5ce', prop: 'hose',       propColor: '#2e8fa3', tint: '#b8564c', belly: '#2f5a63' },
    /* Space */
    harpoon:   { hat: 'captain',  hatColor: '#3f7fd4', prop: 'harpoongun', propColor: '#4a5a6a', tint: '#3f7fd4', belly: '#27354a' },
    torpedo:   { hat: 'sailor',   hatColor: '#eef2f6', prop: 'periscope',  tint: '#2f6fb5', belly: '#25384d' },
    depth:     { hat: 'souwester', hatColor: '#f2c14e', prop: 'stud',      tint: '#3a86c8', belly: '#26405c' },
    jetpack:   { hat: 'aviator',  hatColor: '#8a6d4a', prop: 'jetpack',    propColor: '#e07b39', tint: '#4a90d9', belly: '#2c3e56' },
    artillery: { hat: 'officer',  hatColor: '#2f4858', prop: 'howitzer',   propColor: '#2f3b47', tint: '#35618f', belly: '#232f3d', scale: 1.22, cheeks: '#d9a04a' },
    /* Wizards */
    aurora:    { hat: 'wizard',   hatColor: '#7a52c0', prop: 'staff',      propColor: '#5ee8a8', tint: '#8b5fd0', belly: '#3a2f52' },
    witch:     { hat: 'hood',     hatColor: '#7a4fc0', prop: 'crookstaff', propColor: '#b07ce8', tint: '#5e3f8c', belly: '#322b3d' },
    blizzard:  { hat: 'crown',    hatColor: '#bfe8ff', prop: 'orb',        propColor: '#8fd4f0', tint: '#9b6fd6', belly: '#3d3358' },
    shadow:    { hat: 'headband', hatColor: '#c0392b', prop: 'shuriken',   tint: '#2e2a3a', belly: '#23262b' },
    sunpriest: { hat: 'halo',     hatColor: '#ffd166', prop: 'orb',        propColor: '#ffd166', tint: '#b58fe0', belly: '#6a5a3a', scale: 1.12 },
    /* Crew */
    vendor:    { hat: 'straw',    hatColor: '#d8b46a', prop: 'stud',       tint: '#3fae6a', belly: '#4a3a24' },
    fort:      { hat: 'beanie',   hatColor: '#3fae6a', prop: 'flag',       propColor: '#3fae6a', tint: '#37945c', belly: '#2c4436' },
    sonar:     { hat: 'headset',  hatColor: '#3fae6a', tint: '#46b878',    belly: '#2b3a4a' },
    drummer:   { hat: 'mohawk',   hatColor: '#e0653f', prop: 'drumsticks', propColor: '#8a5a33', tint: '#4aa86a', belly: '#4a3a24' },
    icewall:   { hat: 'hardhat',  hatColor: '#f2c14e', prop: 'pickaxe',    propColor: '#8a5a33', tint: '#52b47e', belly: '#5a4a2c' },
    /* Heroes */
    hero_frost:  { hat: 'captain',  hatColor: '#d4af37', prop: 'harpoongun', propColor: '#5a6a7a', tint: '#b8352c', belly: '#3a2a26', scale: 1.28, cheeks: '#d9a04a' },
    hero_beak:   { hat: 'officer',  hatColor: '#d4af37', prop: 'flag',       propColor: '#d4af37', tint: '#2f9a5e', belly: '#26402f', scale: 1.24 },
    hero_shiver: { hat: 'hood',     hatColor: '#9fd8ef', prop: 'orb',        propColor: '#bfeaff', tint: '#6a4fb0', belly: '#2e3a5a', scale: 1.24 },
    hero_tilly:  { hat: 'goggles',  hatColor: '#ffd166', prop: 'sling',      propColor: '#d4af37', tint: '#d94f42', belly: '#4a2f28', scale: 1.20, cheeks: '#d9a04a' },
    hero_rook:   { hat: 'sailor',   hatColor: '#f4f7fa', prop: 'periscope',  propColor: '#d4af37', tint: '#2d64a8', belly: '#26364a', scale: 1.26 },
    hero_marlow: { hat: 'souwester', hatColor: '#d4af37', prop: 'cannon',    propColor: '#3b4a58', tint: '#3878be', belly: '#28394d', scale: 1.26 },
    hero_kell:   { hat: 'wizard',   hatColor: '#7fc98f', prop: 'crookstaff', propColor: '#a8e6b4', tint: '#7a52a8', belly: '#2f4436', scale: 1.24 },
    hero_sage:   { hat: 'crown',    hatColor: '#d4af37', prop: 'staff',      propColor: '#9fe8d4', tint: '#8b5fd0', belly: '#3a3358', scale: 1.24 },
    hero_fen:    { hat: 'straw',    hatColor: '#d4af37', prop: 'stud',       propColor: '#f2b04e', tint: '#35a068', belly: '#4a3a24', scale: 1.22 },
  };

  /* ---------------- Vacuums ----------------
     hp/speed are base values; levels multiply them.
     children spawn on death. rank drives 'Strong' targeting. boss ranks >= 10. */
  /* The ids are the original tokens and they stay that way on purpose: they are
     written into every wave table, every child list and every save file, and
     renaming them buys nothing a reader cannot get from the `name` two columns
     to the right. pup/juvenile/adult are the small-medium-large uprights;
     bull is the heavy one; beachmaster/colossus/emperor/leviathan are the four
     bosses in ascending order. */
  G.ENEMIES = {
    pup:        { name: 'Dust Buster',      hp: 1,    speed: 62,  size: 10, armor: 0, stealth: false, regen: 0,   bounty: 2,   lives: 1,   children: [],                              rank: 1,  color: '#c9a27e' },
    juvenile:   { name: 'Stick Vac',        hp: 2,    speed: 74,  size: 11, armor: 0, stealth: false, regen: 0,   bounty: 3,   lives: 2,   children: ['pup'],                         rank: 2,  color: '#b3854f' },
    adult:      { name: 'Upright',          hp: 4,    speed: 80,  size: 13, armor: 0, stealth: false, regen: 0,   bounty: 5,   lives: 3,   children: ['juvenile'],                    rank: 3,  color: '#96682f' },
    speedster:  { name: 'Robo-Vac',         hp: 3,    speed: 152, size: 11, armor: 0, stealth: false, regen: 0,   bounty: 6,   lives: 3,   children: ['juvenile'],                    rank: 4,  color: '#8fa8b8' },
    bull:       { name: 'Heavy Upright',    hp: 8,    speed: 90,  size: 15, armor: 0, stealth: false, regen: 0,   bounty: 8,   lives: 5,   children: ['adult'],                       rank: 5,  color: '#6e4a1e' },
    stealth:    { name: 'Silent Runner',    hp: 4,    speed: 88,  size: 12, armor: 0, stealth: true,  regen: 0,   bounty: 7,   lives: 3,   children: ['juvenile'],                    rank: 6,  color: '#3d5a80' },
    armored:    { name: 'Steel Canister',   hp: 9,    speed: 58,  size: 14, armor: 2, stealth: false, regen: 0,   bounty: 9,   lives: 5,   children: ['adult'],                       rank: 7,  color: '#7d8a96' },
    regen:      { name: 'Cyclone',          hp: 8,    speed: 68,  size: 13, armor: 0, stealth: false, regen: 1.5, bounty: 9,   lives: 5,   children: ['adult'],                       rank: 8,  color: '#5f9e6e' },
    brute:      { name: 'Shop Vac',         hp: 28,   speed: 48,  size: 18, armor: 1, stealth: false, regen: 0,   bounty: 16,  lives: 10,  children: ['bull', 'bull'],                rank: 9,  color: '#4a3620' },
    beachmaster: { name: 'Carpet Cleaner',  hp: 280,  speed: 33,  size: 30, armor: 2, stealth: false, regen: 0,   bounty: 130, lives: 30,  children: ['bull', 'bull', 'bull', 'bull'], rank: 10, color: '#8a4b2f', boss: true },
    colossus:   { name: 'Floor Buffer',     hp: 1000, speed: 26,  size: 38, armor: 3, stealth: false, regen: 0,   bounty: 400, lives: 60,  children: ['beachmaster', 'beachmaster', 'beachmaster'], rank: 11, color: '#5d3a5e', boss: true },
    emperor:    { name: 'The Extractor',    hp: 3400, speed: 19,  size: 46, armor: 4, stealth: false, regen: 0,   bounty: 1000, lives: 120, children: ['colossus', 'colossus'],       rank: 12, color: '#2f4858', boss: true },
    leviathan:  { name: 'Central Unit',     hp: 9500, speed: 15, size: 54, armor: 5, stealth: false, regen: 5,   bounty: 2600, lives: 250, children: ['emperor', 'colossus'],        rank: 13, color: '#1d2d44', boss: true },

    /* ---- Heavies: the deep-endless wet/dry machines (waves 71+) ----
       The big shop machinery arrives, and it does not care what it picks up.
       Heavies hoover the packs as well as the workshop — any ordinary vacuum
       that rolls into one is swallowed whole, healing it (see `heavyEat` in the
       engine). They never split: one patient slab of steel rather than a bag of
       smaller problems. No regeneration of their own — eating is how they
       refill, so starving them is the counter-play. */
    /* A heavy reaching the Home Build is a catastrophe, not a setback: a single
       Wet/Dry Vac costs 100 lives where a Central Unit costs 250. Two of them
       end almost any run. Letting one through is the loss condition. */
    heavy_young: { name: 'Wet/Dry Vac',        hp: 1200, speed: 44, size: 34, armor: 3, stealth: false, regen: 0,   bounty: 260,  lives: 100, children: [],                              rank: 14, color: '#16202e', heavy: true, eat: 0.020 },
    heavy_bull:  { name: 'Industrial Wet/Dry', hp: 3600, speed: 38, size: 42, armor: 4, stealth: false, regen: 0,   bounty: 700,  lives: 180, children: [],                              rank: 15, color: '#121a26', heavy: true, eat: 0.018 },
    heavy_great: { name: 'Turbine Extractor',  hp: 9000, speed: 32, size: 50, armor: 5, stealth: false, regen: 0,   bounty: 1700, lives: 300, children: [],                              rank: 16, color: '#0e151f', heavy: true, eat: 0.015 },
    /* The century wall. Sized against a MOVING target, which is the only
       honest way to measure it: the MEGAVAC rolls through the whole kill zone,
       so an eighteen-tower maxed board lands ~1,283 dps on it — not the ~895 a
       dummy pinned in one spot suggests. Over its 132-second run that is
       ~169k of damage available, so 190k means a strong board runs out of
       track and needs its hero, its boosts and better placement to take the
       century. Re-measure against a MOVING target if this is ever retuned. */
    heavy_king:  { name: 'THE MEGAVAC',     hp: 190000, speed: 17, size: 74, armor: 8, stealth: false, regen: 0, bounty: 12000, lives: 1000, children: ['heavy_great', 'heavy_great'],  rank: 17, color: '#080d15', heavy: true, eat: 0.012, boss: true },
  };

  /* Appliance plastics rather than animal browns: bright moulded colours for
     the small machines, industrial steel and near-black for the big ones, so
     a glance at the track still sorts them by threat. */
  const VAC_COLORS = {
    pup: '#b9c4cf', juvenile: '#57b0c4', adult: '#d9793a', speedster: '#4fc9ec',
    bull: '#b0433c', stealth: '#455168', armored: '#8b98a6', regen: '#54a85f',
    brute: '#d4a017', beachmaster: '#7d4a9e', colossus: '#a83e78', emperor: '#34557c',
    leviathan: '#20364f',
  };
  for (const id in VAC_COLORS) G.ENEMIES[id].color = VAC_COLORS[id];

  G.ENEMY_ORDER = ['pup', 'juvenile', 'adult', 'speedster', 'bull', 'stealth', 'armored', 'regen', 'brute', 'beachmaster', 'colossus', 'emperor', 'leviathan',
    'heavy_young', 'heavy_bull', 'heavy_great', 'heavy_king'];
  G.HEAVY_ORDER = ['heavy_young', 'heavy_bull', 'heavy_great', 'heavy_king'];
  // the wave the tide turns: paths run blue from here on
  G.HEAVY_WAVE = 71;
  /* Heavies swallow ordinary vacuums only — anything Carpet Cleaner-sized or
     above is too much mouthful, and other heavies are kin. */
  G.EDIBLE_RANK = 9;

  /* ---- What counts as a heavyweight ----
     Bosses and heavies alike: too much animal to shove, freeze or chain-slow, and
     big enough that the tools built for big things are the answer to them.

     Heavies used to be neither. They sat outside `boss` — only the MEGAVAC
     carries that flag — so every anti-boss investment in the game did nothing
     to a 9,000 HP Great Heavy, while a thrown brick could knock one back down the
     track. That is exactly backwards: the deepest threat in the game was the
     one your crowd control worked best on and your boss-killer worked worst on,
     and the Laser Sniper's Extractor Lance was measured doing literally
     nothing for 0.0% of heavy uptime — a 2,600-stud capstone named after them.

     Deliberately NOT applied to power-ups or hero abilities: Big Freeze and
     Cold Snap are bought with bricks and sit on long cooldowns, so they stay
     the panic button that works on anything. This governs what towers do on
     their own, which is what was trivialising the fight. */
  G.isHeavyweight = (e) => !!(e && (e.boss || e.heavy));

  /* ---------------- Levels ----------------
     paths: one or more waypoint lists (enemies are assigned a path).
     water: circles {x,y,r} and rects {x,y,w,h} — water towers go here, land towers can't.
     blockers: no-build decorations {x,y,r,kind: rock|crystal|fort|wreck}.               */
  G.LEVELS = [
    {
      id: 'shores', name: 'Starter Plate', diff: 1,
      tagline: 'A gentle S-curve across an open plate. Learn the ropes.',
      lives: 150, cash: 650, hpMult: 1.0, speedMult: 1.0,
      theme: { snow: '#eef4f8', ice: '#dce9f2', pathColor: '#cfd9d3' },
      paths: [[{ x: -40, y: 180 }, { x: 300, y: 180 }, { x: 300, y: 430 }, { x: 700, y: 430 }, { x: 700, y: 180 }, { x: 1050, y: 180 }, { x: 1050, y: 560 }, { x: 1320, y: 560 }]],
      water: [{ x: 200, y: 660, r: 120 }, { x: 1130, y: 110, r: 80 }],
      blockers: [{ x: 500, y: 640, r: 30, kind: 'rock' }, { x: 880, y: 300, r: 26, kind: 'rock' }],
    },
    {
      id: 'pass', name: 'Main Street', diff: 1,
      tagline: 'Long switchbacks between the tower blocks. Lots of time to shoot.',
      lives: 140, cash: 650, hpMult: 1.12, speedMult: 1.0,
      theme: { snow: '#e9eff6', ice: '#d5e3ef', pathColor: '#ccd6d2' },
      paths: [[{ x: -40, y: 110 }, { x: 1090, y: 110 }, { x: 1090, y: 300 }, { x: 190, y: 300 }, { x: 190, y: 490 }, { x: 1090, y: 490 }, { x: 1090, y: 670 }, { x: -40, y: 670 }]],
      water: [{ x: 1190, y: 720, r: 95 }],
      blockers: [{ x: 640, y: 205, r: 24, kind: 'rock' }, { x: 640, y: 395, r: 24, kind: 'crystal' }, { x: 640, y: 580, r: 24, kind: 'rock' }],
    },
    {
      id: 'river', name: 'Canal Street', diff: 2,
      tagline: 'The track fords the canal twice. Rovers and skiffs shine here.',
      lives: 130, cash: 700, hpMult: 1.25, speedMult: 1.0,
      theme: { snow: '#e7eef4', ice: '#d2e2ee', pathColor: '#ccd5d5' },
      paths: [[{ x: 150, y: -40 }, { x: 150, y: 300 }, { x: 500, y: 300 }, { x: 500, y: 520 }, { x: 850, y: 520 }, { x: 850, y: 300 }, { x: 1150, y: 300 }, { x: 1150, y: 840 }]],
      water: [{ rect: { x: 0, y: 350, w: 1280, h: 130 } }],
      blockers: [{ x: 320, y: 150, r: 26, kind: 'rock' }, { x: 1000, y: 640, r: 28, kind: 'crystal' }],
    },
    {
      id: 'alley', name: 'Two-Gate Junction', diff: 2,
      tagline: 'Two packs pour in from two gates and merge mid-board.',
      lives: 120, cash: 720, hpMult: 1.4, speedMult: 1.02,
      theme: { snow: '#e6edf5', ice: '#d0dfee', pathColor: '#c9d4d4' },
      paths: [
        [{ x: -40, y: 150 }, { x: 400, y: 150 }, { x: 640, y: 400 }, { x: 1000, y: 400 }, { x: 1000, y: 620 }, { x: 1320, y: 620 }],
        [{ x: -40, y: 650 }, { x: 400, y: 650 }, { x: 640, y: 400 }, { x: 1000, y: 400 }, { x: 1000, y: 620 }, { x: 1320, y: 620 }],
      ],
      water: [{ x: 910, y: 150, r: 95 }, { x: 190, y: 400, r: 85 }, { x: 1160, y: 210, r: 75 }],
      blockers: [{ x: 640, y: 640, r: 26, kind: 'rock' }],
    },
    {
      id: 'village', name: 'The Old Quarter', diff: 3,
      tagline: 'The track wraps around the houses themselves. Protect the builds!',
      lives: 110, cash: 750, hpMult: 1.55, speedMult: 1.04,
      theme: { snow: '#eaf0f6', ice: '#d8e5f0', pathColor: '#cdd7d3' },
      paths: [[{ x: -40, y: 200 }, { x: 1000, y: 200 }, { x: 1000, y: 620 }, { x: 300, y: 620 }, { x: 300, y: 380 }, { x: 1320, y: 380 }]],
      water: [{ x: 140, y: 720, r: 100 }],
      blockers: [{ x: 620, y: 490, r: 30, kind: 'fort' }, { x: 720, y: 510, r: 26, kind: 'fort' }, { x: 550, y: 520, r: 24, kind: 'fort' }, { x: 160, y: 90, r: 26, kind: 'rock' }],
    },
    {
      id: 'caves', name: 'The Subway', diff: 3,
      tagline: 'A tight serpentine gauntlet underground. NO POOLS — no rovers or skiffs.',
      lives: 100, cash: 800, hpMult: 1.7, speedMult: 1.05,
      theme: { snow: '#e2e6f0', ice: '#cdd6ea', pathColor: '#c5cdd6', dark: true },
      paths: [[{ x: -40, y: 120 }, { x: 1160, y: 120 }, { x: 1160, y: 270 }, { x: 120, y: 270 }, { x: 120, y: 420 }, { x: 1160, y: 420 }, { x: 1160, y: 570 }, { x: 120, y: 570 }, { x: 120, y: 700 }, { x: 1320, y: 700 }]],
      water: [],
      blockers: [{ x: 400, y: 195, r: 22, kind: 'crystal' }, { x: 880, y: 345, r: 22, kind: 'crystal' }, { x: 400, y: 495, r: 22, kind: 'crystal' }, { x: 880, y: 640, r: 22, kind: 'crystal' }],
    },
    {
      id: 'ridge', name: 'Fountain Square', diff: 4,
      tagline: 'The track splits around the town fountain — packs take either branch.',
      lives: 100, cash: 800, hpMult: 1.9, speedMult: 1.06,
      theme: { snow: '#e7ebf4', ice: '#d3ddee', pathColor: '#cbd4d6', aurora: true },
      paths: [
        [{ x: -40, y: 400 }, { x: 250, y: 400 }, { x: 450, y: 180 }, { x: 830, y: 180 }, { x: 1030, y: 400 }, { x: 1320, y: 400 }],
        [{ x: -40, y: 400 }, { x: 250, y: 400 }, { x: 450, y: 620 }, { x: 830, y: 620 }, { x: 1030, y: 400 }, { x: 1320, y: 400 }],
      ],
      water: [{ x: 640, y: 400, r: 105 }],
      blockers: [{ x: 150, y: 150, r: 28, kind: 'rock' }, { x: 1140, y: 660, r: 28, kind: 'crystal' }],
    },
    {
      id: 'bay', name: 'The Docks', diff: 4,
      tagline: 'A flooded waterfront. Space owns this board — if you can afford it.',
      lives: 90, cash: 850, hpMult: 2.1, speedMult: 1.08,
      theme: { snow: '#e4ecf3', ice: '#cfe0ee', pathColor: '#c8d3d5' },
      paths: [[{ x: -40, y: 700 }, { x: 300, y: 700 }, { x: 300, y: 250 }, { x: 700, y: 250 }, { x: 700, y: 600 }, { x: 1050, y: 600 }, { x: 1050, y: 150 }, { x: 1320, y: 150 }]],
      water: [{ x: 500, y: 450, r: 135 }, { x: 900, y: 400, r: 110 }, { x: 130, y: 300, r: 105 }, { x: 1200, y: 700, r: 120 }, { x: 880, y: 110, r: 85 }],
      blockers: [{ x: 500, y: 700, r: 34, kind: 'wreck' }, { x: 1180, y: 420, r: 26, kind: 'rock' }],
    },
    {
      id: 'peak', name: 'Rooftop Run', diff: 5,
      tagline: 'A brutally short climb to the roof. Every shot counts.',
      lives: 80, cash: 900, hpMult: 2.35, speedMult: 1.1,
      theme: { snow: '#eef2f7', ice: '#dde8f2', pathColor: '#d2dad8', storm: true },
      paths: [[{ x: -40, y: 620 }, { x: 420, y: 620 }, { x: 640, y: 420 }, { x: 860, y: 620 }, { x: 1320, y: 620 }]],
      water: [{ x: 200, y: 200, r: 80 }],
      blockers: [{ x: 640, y: 200, r: 40, kind: 'rock' }, { x: 950, y: 300, r: 30, kind: 'rock' }, { x: 330, y: 380, r: 28, kind: 'crystal' }, { x: 1100, y: 450, r: 26, kind: 'rock' }],
    },
    {
      id: 'workshop', name: 'City Hall', diff: 5,
      tagline: 'Two independent tracks converge on the workshop. The final stand.',
      lives: 80, cash: 950, hpMult: 2.6, speedMult: 1.12,
      theme: { snow: '#e9eef5', ice: '#d6e2ef', pathColor: '#ccd6d4', aurora: true },
      paths: [
        [{ x: -40, y: 150 }, { x: 500, y: 150 }, { x: 500, y: 400 }, { x: 900, y: 400 }, { x: 900, y: 650 }, { x: 1320, y: 650 }],
        [{ x: 640, y: -40 }, { x: 640, y: 300 }, { x: 250, y: 300 }, { x: 250, y: 650 }, { x: 1320, y: 650 }],
      ],
      water: [{ x: 1100, y: 250, r: 105 }, { x: 110, y: 120, r: 70 }],
      blockers: [{ x: 1150, y: 500, r: 26, kind: 'fort' }, { x: 1060, y: 530, r: 24, kind: 'fort' }, { x: 80, y: 500, r: 28, kind: 'rock' }],
    },

    /* ============ TIER 2 — STAR PORT (1440 × 860) ============ */
    {
      id: 'flats', name: 'Landing Apron', diff: 1,
      tagline: 'A long switchback across open apron. Room to build — and time to use it.',
      lives: 95, cash: 720, hpMult: 2.8, speedMult: 1.0,
      theme: { snow: '#e4ecf6', ice: '#cddff0', pathColor: '#cbd5dd' },
      paths: [[{ x: -40, y: 200 }, { x: 1150, y: 200 }, { x: 1150, y: 470 }, { x: 350, y: 470 }, { x: 350, y: 900 }]],
      water: [{ x: 1350, y: 420, r: 100 }],
      blockers: [{ x: 700, y: 340, r: 26, kind: 'rock' }, { x: 700, y: 640, r: 26, kind: 'crystal' }, { x: 120, y: 430, r: 30, kind: 'rock' }],
    },
    {
      id: 'fjord', name: 'Coolant Channels', diff: 1,
      tagline: 'The track hugs a flooded channel. Deep pools everywhere — bring Space.',
      lives: 92, cash: 730, hpMult: 3.0, speedMult: 1.0,
      theme: { snow: '#e2edf4', ice: '#c8dced', pathColor: '#c9d4d6' },
      paths: [[{ x: -40, y: 300 }, { x: 420, y: 300 }, { x: 420, y: 720 }, { x: 860, y: 720 }, { x: 860, y: 300 }, { x: 1180, y: 300 }, { x: 1180, y: 700 }, { x: 1480, y: 700 }]],
      water: [{ rect: { x: 920, y: 360, w: 220, h: 300 } }, { x: 200, y: 520, r: 110 }],
      blockers: [{ x: 640, y: 400, r: 34, kind: 'wreck' }, { x: 1300, y: 400, r: 28, kind: 'rock' }],
    },
    {
      id: 'cataracts', name: 'Twin Coolant Runs', diff: 2,
      tagline: 'Two coolant runs cut the plate in bands. The pack fords both.',
      lives: 90, cash: 740, hpMult: 3.2, speedMult: 1.02,
      theme: { snow: '#e6f2f2', ice: '#cbe4e6', pathColor: '#d6c8a8' },
      paths: [[{ x: 200, y: -40 }, { x: 200, y: 300 }, { x: 620, y: 300 }, { x: 620, y: 620 }, { x: 1040, y: 620 }, { x: 1040, y: 300 }, { x: 1400, y: 300 }, { x: 1400, y: 900 }]],
      water: [{ rect: { x: 0, y: 120, w: 1440, h: 110 } }, { rect: { x: 0, y: 700, w: 1440, h: 110 } }],
      blockers: [{ x: 400, y: 480, r: 28, kind: 'rock' }, { x: 820, y: 420, r: 26, kind: 'crystal' }],
    },
    {
      id: 'shelf', name: 'Cargo Deck', diff: 3,
      tagline: 'Two packs pour onto the deck, braid together, then split for opposite exits.',
      lives: 88, cash: 750, hpMult: 3.4, speedMult: 1.02,
      theme: { snow: '#e7edf7', ice: '#cbdcf0', pathColor: '#c8d2d8' },
      paths: [
        [{ x: -40, y: 180 }, { x: 380, y: 180 }, { x: 640, y: 400 }, { x: 1100, y: 400 }, { x: 1100, y: 700 }, { x: 420, y: 700 }, { x: 420, y: 900 }],
        [{ x: -40, y: 700 }, { x: 380, y: 700 }, { x: 640, y: 400 }, { x: 1100, y: 400 }, { x: 1100, y: 180 }, { x: 1480, y: 180 }],
      ],
      water: [{ x: 840, y: 130, r: 105 }, { x: 150, y: 420, r: 95 }, { x: 830, y: 820, r: 95 }],
      blockers: [{ x: 1330, y: 480, r: 30, kind: 'rock' }, { x: 200, y: 90, r: 26, kind: 'crystal' }],
    },
    {
      id: 'rookery', name: 'The Hangars', diff: 2,
      tagline: 'The west road coils around the hangar bays — and a second pack comes down the south apron.',
      lives: 85, cash: 760, hpMult: 3.6, speedMult: 1.03,
      theme: { snow: '#f0f4fa', ice: '#d6e4f2', pathColor: '#e0d0af' },
      paths: [
        [{ x: -40, y: 180 }, { x: 900, y: 180 }, { x: 900, y: 560 }, { x: 420, y: 560 }, { x: 420, y: 380 }, { x: 1480, y: 380 }],
        [{ x: -40, y: 740 }, { x: 1150, y: 740 }, { x: 1150, y: 520 }, { x: 1480, y: 520 }],
      ],
      water: [{ x: 1390, y: 220, r: 100 }, { x: 110, y: 320, r: 85 }],
      blockers: [{ x: 600, y: 280, r: 28, kind: 'fort' }, { x: 700, y: 290, r: 24, kind: 'fort' }, { x: 505, y: 275, r: 24, kind: 'fort' }],
    },
    {
      id: 'basin', name: 'Dark Side Basin', diff: 3,
      tagline: 'A sunless bowl with two ways in — one along the floor, one down the eastern wall.',
      lives: 82, cash: 780, hpMult: 3.8, speedMult: 1.04,
      theme: { snow: '#b9c4dc', ice: '#8e9cc0', pathColor: '#7a86a8', dark: true },
      paths: [
        [{ x: -40, y: 340 }, { x: 850, y: 340 }, { x: 850, y: 560 }, { x: 450, y: 560 }, { x: 450, y: 760 }, { x: 1480, y: 760 }],
        [{ x: 560, y: -40 }, { x: 560, y: 140 }, { x: 1300, y: 140 }, { x: 1300, y: 900 }],
      ],
      water: [{ x: 700, y: 880, r: 85 }, { x: 120, y: 620, r: 90 }],
      blockers: [{ x: 700, y: 400, r: 24, kind: 'crystal' }, { x: 220, y: 400, r: 22, kind: 'crystal' }, { x: 1080, y: 640, r: 22, kind: 'crystal' }],
    },
    {
      id: 'sable', name: 'The Fuel Yards', diff: 4,
      tagline: 'Deep service pits and spilled coolant — with a second pack running the high gantry.',
      lives: 78, cash: 800, hpMult: 4.0, speedMult: 1.05,
      theme: { snow: '#dfe6f0', ice: '#c2d0e4', pathColor: '#bcc6d2' },
      paths: [
        [{ x: -40, y: 700 }, { x: 400, y: 700 }, { x: 400, y: 300 }, { x: 900, y: 300 }, { x: 900, y: 700 }, { x: 1480, y: 700 }],
        [{ x: -40, y: 150 }, { x: 1180, y: 150 }, { x: 1180, y: 480 }, { x: 1480, y: 480 }],
      ],
      water: [{ x: 620, y: 560, r: 120 }, { x: 180, y: 420, r: 100 }, { x: 1320, y: 300, r: 110 }],
      blockers: [{ x: 700, y: 420, r: 30, kind: 'crystal' }, { x: 1350, y: 620, r: 28, kind: 'rock' }],
    },
    {
      id: 'floes', name: 'The Tank Farm', diff: 4,
      tagline: 'More pool than plate. Two packs pick through the gaps — rovers and skiffs rule here.',
      lives: 75, cash: 820, hpMult: 4.2, speedMult: 1.06,
      theme: { snow: '#e3eff8', ice: '#c3dcf0', pathColor: '#ccd6dc' },
      paths: [
        [{ x: -40, y: 260 }, { x: 400, y: 260 }, { x: 400, y: 460 }, { x: 800, y: 460 }, { x: 800, y: 260 }, { x: 1200, y: 260 }, { x: 1200, y: 900 }],
        [{ x: -40, y: 660 }, { x: 400, y: 660 }, { x: 400, y: 460 }, { x: 800, y: 460 }, { x: 800, y: 660 }, { x: 1200, y: 660 }, { x: 1200, y: 900 }],
      ],
      water: [{ x: 200, y: 460, r: 100 }, { x: 600, y: 170, r: 90 }, { x: 600, y: 750, r: 90 }, { x: 1000, y: 460, r: 110 }, { x: 1400, y: 300, r: 100 }],
      blockers: [{ x: 1000, y: 820, r: 28, kind: 'wreck' }],
    },
    {
      id: 'stormwall', name: 'Ion Storm Ridge', diff: 5,
      tagline: 'Two tracks knot through a permanent ion storm, crossing four times.',
      lives: 72, cash: 840, hpMult: 4.4, speedMult: 1.07,
      theme: { snow: '#e8edf4', ice: '#d0dae8', pathColor: '#c2ccd6', storm: true },
      paths: [
        [{ x: -40, y: 200 }, { x: 420, y: 200 }, { x: 420, y: 540 }, { x: 820, y: 540 }, { x: 820, y: 200 }, { x: 1240, y: 200 }, { x: 1240, y: 700 }, { x: 1480, y: 700 }],
        [{ x: 720, y: -40 }, { x: 720, y: 300 }, { x: 280, y: 300 }, { x: 280, y: 700 }, { x: 1060, y: 700 }, { x: 1060, y: 340 }, { x: 1480, y: 340 }],
      ],
      water: [{ x: 120, y: 500, r: 90 }, { x: 1380, y: 520, r: 100 }],
      blockers: [{ x: 620, y: 420, r: 30, kind: 'rock' }, { x: 940, y: 420, r: 26, kind: 'crystal' }],
    },
    {
      id: 'longdark', name: 'Deep Space Dock', diff: 5,
      tagline: 'Two packs cross in the black, on lanes too far apart to guard with one gun.',
      lives: 70, cash: 860, hpMult: 4.6, speedMult: 1.08,
      theme: { snow: '#a9b4cf', ice: '#7d8ab0', pathColor: '#6b779c', dark: true },
      paths: [
        [{ x: -40, y: 240 }, { x: 850, y: 240 }, { x: 850, y: 560 }, { x: 350, y: 560 }, { x: 350, y: 900 }],
        [{ x: -40, y: 780 }, { x: 700, y: 780 }, { x: 700, y: 420 }, { x: 1480, y: 420 }],
      ],
      water: [{ x: 60, y: 420, r: 90 }, { x: 1400, y: 660, r: 95 }],
      blockers: [{ x: 600, y: 340, r: 24, kind: 'crystal' }, { x: 1100, y: 600, r: 24, kind: 'crystal' }, { x: 200, y: 620, r: 22, kind: 'crystal' }],
    },

    /* ============ TIER 3 — CASTLE REALM (1600 × 920) ============ */
    {
      id: 'approach', name: 'The Approach', diff: 1,
      tagline: 'The road to the castle gate. Wide, open and deceptively quiet.',
      lives: 68, cash: 820, hpMult: 5.0, speedMult: 1.05,
      theme: { snow: '#dbe3f0', ice: '#bccce4', pathColor: '#b8c2d0' },
      paths: [[{ x: -40, y: 240 }, { x: 1250, y: 240 }, { x: 1250, y: 560 }, { x: 400, y: 560 }, { x: 400, y: 960 }]],
      water: [{ x: 1500, y: 460, r: 110 }, { x: 120, y: 460, r: 100 }],
      blockers: [{ x: 800, y: 400, r: 30, kind: 'rock' }, { x: 800, y: 760, r: 30, kind: 'crystal' }, { x: 1450, y: 800, r: 26, kind: 'rock' }],
    },
    {
      id: 'causeway', name: 'Broken Causeway', diff: 1,
      tagline: 'A broken bridge over the flooded ditch. The pack fords it three times.',
      lives: 65, cash: 840, hpMult: 5.4, speedMult: 1.06,
      theme: { snow: '#dceaf2', ice: '#bad6e8', pathColor: '#c6b998' },
      paths: [[{ x: -40, y: 120 }, { x: 240, y: 120 }, { x: 240, y: 380 }, { x: 700, y: 380 }, { x: 700, y: 700 }, { x: 1160, y: 700 }, { x: 1160, y: 300 }, { x: 1560, y: 300 }, { x: 1560, y: 960 }]],
      water: [{ rect: { x: 0, y: 420, w: 1600, h: 150 } }, { x: 400, y: 800, r: 120 }],
      blockers: [{ x: 950, y: 200, r: 32, kind: 'wreck' }, { x: 1380, y: 800, r: 30, kind: 'rock' }],
    },
    {
      id: 'trench', name: 'The Moat', diff: 2,
      tagline: 'Something enormous sits in the water. Two packs skirt the moat and rejoin.',
      lives: 62, cash: 860, hpMult: 5.8, speedMult: 1.07,
      theme: { snow: '#d8e8ee', ice: '#b2d2e0', pathColor: '#bfc9cc' },
      paths: [
        [{ x: -40, y: 140 }, { x: 420, y: 140 }, { x: 420, y: 520 }, { x: 900, y: 520 }, { x: 900, y: 200 }, { x: 1360, y: 200 }, { x: 1360, y: 800 }, { x: 1640, y: 800 }],
        [{ x: -40, y: 800 }, { x: 420, y: 800 }, { x: 420, y: 520 }, { x: 900, y: 520 }, { x: 900, y: 800 }, { x: 1360, y: 800 }, { x: 1640, y: 800 }],
      ],
      water: [{ rect: { x: 520, y: 560, w: 280, h: 190 } }, { x: 200, y: 400, r: 120 }, { x: 1180, y: 420, r: 130 }, { x: 1500, y: 200, r: 110 }],
      blockers: [{ x: 660, y: 300, r: 30, kind: 'wreck' }, { x: 1500, y: 560, r: 28, kind: 'rock' }],
    },
    {
      id: 'obsidian', name: 'Black Keep Maze', diff: 2,
      tagline: 'Black keep walls, split by a breach. Two packs, and no sky to see them by.',
      lives: 60, cash: 880, hpMult: 6.2, speedMult: 1.08,
      theme: { snow: '#9aa6c6', ice: '#6e7ca6', pathColor: '#5b6890', dark: true },
      paths: [
        [{ x: -40, y: 200 }, { x: 1300, y: 200 }, { x: 1300, y: 600 }, { x: 320, y: 600 }, { x: 320, y: 960 }],
        [{ x: -40, y: 820 }, { x: 950, y: 820 }, { x: 950, y: 420 }, { x: 1640, y: 420 }],
      ],
      water: [{ x: 1500, y: 780, r: 105 }, { x: 90, y: 480, r: 95 }],
      blockers: [{ x: 640, y: 320, r: 24, kind: 'crystal' }, { x: 1120, y: 700, r: 24, kind: 'crystal' }, { x: 400, y: 440, r: 22, kind: 'crystal' }],
    },
    {
      id: 'cathedral', name: 'The Great Hall', diff: 3,
      tagline: 'The pack splits around the hall’s great pool and closes again beyond it.',
      lives: 58, cash: 900, hpMult: 6.6, speedMult: 1.09,
      theme: { snow: '#dfe4f6', ice: '#bcc8ee', pathColor: '#c4b9a4', aurora: true },
      paths: [
        [{ x: -40, y: 460 }, { x: 260, y: 460 }, { x: 520, y: 160 }, { x: 1140, y: 160 }, { x: 1400, y: 460 }, { x: 1400, y: 860 }, { x: 1640, y: 860 }],
        [{ x: -40, y: 460 }, { x: 260, y: 460 }, { x: 520, y: 760 }, { x: 1140, y: 760 }, { x: 1400, y: 460 }, { x: 1400, y: 860 }, { x: 1640, y: 860 }],
      ],
      water: [{ x: 830, y: 460, r: 170 }, { x: 200, y: 170, r: 105 }, { x: 200, y: 750, r: 105 }],
      blockers: [{ x: 830, y: 110, r: 30, kind: 'crystal' }, { x: 830, y: 810, r: 30, kind: 'crystal' }, { x: 1530, y: 280, r: 28, kind: 'rock' }],
    },
    {
      id: 'maelstrom', name: 'The Millrace', diff: 3,
      tagline: 'One ring of the old millrace still turns — and the current drags a second pack in behind it.',
      lives: 55, cash: 920, hpMult: 7.0, speedMult: 1.10,
      theme: { snow: '#d6dff0', ice: '#b4c6e2', pathColor: '#b4bfcc' },
      paths: [
        [{ x: -40, y: 220 }, { x: 1150, y: 220 }, { x: 1150, y: 600 }, { x: 450, y: 600 }, { x: 450, y: 420 }, { x: 1640, y: 420 }],
        [{ x: 760, y: -40 }, { x: 760, y: 60 }, { x: 120, y: 60 }, { x: 120, y: 880 }, { x: 1640, y: 880 }],
      ],
      water: [{ x: 1530, y: 760, r: 105 }, { x: 620, y: 300, r: 90 }],
      blockers: [{ x: 900, y: 500, r: 28, kind: 'rock' }, { x: 260, y: 300, r: 26, kind: 'crystal' }, { x: 1300, y: 700, r: 26, kind: 'rock' }],
    },
    {
      id: 'icefall', name: 'Broken Aqueduct', diff: 4,
      tagline: 'A shattered aqueduct. Two tracks cross and re-cross in the spray.',
      lives: 52, cash: 940, hpMult: 7.4, speedMult: 1.11,
      theme: { snow: '#e0e8f2', ice: '#bfd2e6', pathColor: '#b9c4cf', storm: true },
      paths: [
        [{ x: -40, y: 180 }, { x: 520, y: 180 }, { x: 520, y: 620 }, { x: 1040, y: 620 }, { x: 1040, y: 180 }, { x: 1560, y: 180 }, { x: 1560, y: 860 }, { x: 1640, y: 860 }],
        [{ x: 800, y: -40 }, { x: 800, y: 380 }, { x: 240, y: 380 }, { x: 240, y: 860 }, { x: 1300, y: 860 }, { x: 1300, y: 380 }, { x: 1640, y: 380 }],
      ],
      water: [{ x: 700, y: 800, r: 110 }, { x: 120, y: 600, r: 95 }, { x: 1450, y: 600, r: 100 }],
      blockers: [{ x: 660, y: 480, r: 30, kind: 'rock' }, { x: 1180, y: 480, r: 26, kind: 'crystal' }],
    },
    {
      id: 'blackice', name: 'The Labyrinth', diff: 4,
      tagline: 'Three packs pick separate ways through the black stone. Guard them all.',
      lives: 50, cash: 960, hpMult: 7.8, speedMult: 1.12,
      theme: { snow: '#8f9bbe', ice: '#65739e', pathColor: '#525f86', dark: true },
      paths: [
        [{ x: -40, y: 150 }, { x: 1350, y: 150 }, { x: 1350, y: 660 }, { x: 250, y: 660 }, { x: 250, y: 960 }],
        [{ x: -40, y: 820 }, { x: 900, y: 820 }, { x: 900, y: 480 }, { x: 1640, y: 480 }],
        [{ x: 600, y: -40 }, { x: 600, y: 300 }, { x: 1640, y: 300 }],
      ],
      water: [{ x: 80, y: 460, r: 95 }, { x: 1480, y: 800, r: 100 }],
      blockers: [{ x: 380, y: 300, r: 24, kind: 'crystal' }, { x: 1150, y: 380, r: 24, kind: 'crystal' }, { x: 760, y: 560, r: 22, kind: 'crystal' }],
    },
    {
      id: 'throne', name: 'The Throne Room', diff: 5,
      tagline: 'Three tracks converge on the old seat itself. Hold all of them at once.',
      lives: 48, cash: 980, hpMult: 8.2, speedMult: 1.13,
      theme: { snow: '#dde2f4', ice: '#b8c4ea', pathColor: '#bfb7a6', aurora: true },
      paths: [
        [{ x: -40, y: 140 }, { x: 600, y: 140 }, { x: 600, y: 460 }, { x: 1100, y: 460 }, { x: 1100, y: 760 }, { x: 1640, y: 760 }],
        [{ x: -40, y: 780 }, { x: 600, y: 780 }, { x: 600, y: 460 }, { x: 1100, y: 460 }, { x: 1100, y: 760 }, { x: 1640, y: 760 }],
        [{ x: 820, y: -40 }, { x: 820, y: 220 }, { x: 1340, y: 220 }, { x: 1340, y: 460 }, { x: 1100, y: 460 }, { x: 1100, y: 760 }, { x: 1640, y: 760 }],
      ],
      water: [{ x: 300, y: 460, r: 130 }, { x: 880, y: 860, r: 110 }, { x: 1500, y: 300, r: 100 }],
      blockers: [{ x: 300, y: 180, r: 28, kind: 'rock' }, { x: 300, y: 740, r: 26, kind: 'rock' }, { x: 1450, y: 620, r: 26, kind: 'crystal' }],
    },
    {
      id: 'worldsend', name: 'The Last Wall', diff: 5,
      tagline: 'The final wall. Three tracks from three directions, and everything the room has left.',
      lives: 45, cash: 1000, hpMult: 8.6, speedMult: 1.15,
      theme: { snow: '#d4dcf0', ice: '#adbde2', pathColor: '#b6b09e', aurora: true },
      paths: [
        [{ x: -40, y: 220 }, { x: 1200, y: 220 }, { x: 1200, y: 560 }, { x: 400, y: 560 }, { x: 400, y: 960 }],
        [{ x: 700, y: -40 }, { x: 700, y: 880 }, { x: 1640, y: 880 }],
        [{ x: 1640, y: 180 }, { x: 1460, y: 180 }, { x: 1460, y: 980 }],
      ],
      water: [{ x: 900, y: 700, r: 120 }, { x: 150, y: 640, r: 120 }, { x: 1400, y: 400, r: 110 }],
      blockers: [{ x: 850, y: 380, r: 32, kind: 'crystal' }, { x: 250, y: 320, r: 28, kind: 'rock' }, { x: 1560, y: 620, r: 28, kind: 'rock' }],
    },
  ];

  /* Richer per-map art direction, merged into each level's theme.
     path/pathEdge/pathCore: the packed-track colors · deep/shore: water colors
     props: which scenery set the terrain painter scatters around the map. */
  const THEME_EXTRAS = {
    shores:  { snow: '#f4fafe', ice: '#c6e3f5', pathColor: '#e8d19c', pathEdge: '#b3966a', pathCore: '#f6ead0', deep: '#2f8fd6', shore: '#a9e2f2', props: 'pines' },
    pass:    { snow: '#f0f6fc', ice: '#bdd9f0', pathColor: '#d8c9a2', pathEdge: '#a5906c', pathCore: '#e8ddc2', deep: '#2f79c2', shore: '#a6d6ec', props: 'pines' },
    river:   { snow: '#f0f9f7', ice: '#c4e6e4', pathColor: '#e5d09e', pathEdge: '#b49a6d', pathCore: '#f2e4bf', deep: '#1391b8', shore: '#8fdde4', props: 'reeds' },
    alley:   { snow: '#ecf5fc', ice: '#b9daf2', pathColor: '#d7c9a4', pathEdge: '#a28d68', pathCore: '#e7dcc0', deep: '#1f78c4', shore: '#9ed2f0', props: 'floes' },
    village: { snow: '#f6f9fd', ice: '#cfe5f5', pathColor: '#ecd6a8', pathEdge: '#bb9f72', pathCore: '#f8e9ca', deep: '#2f8fd6', shore: '#a9e2f2', props: 'village' },
    caves:   { snow: '#a0abd0', ice: '#6b7ab2', pathColor: '#5e6b9d', pathEdge: '#3d4877', pathCore: '#7381ad', deep: '#23407c', shore: '#5e7cb2', props: 'crystals', glow: '#7fd8f5' },
    ridge:   { snow: '#eceffb', ice: '#c2cff4', pathColor: '#d9c690', pathEdge: '#a8935f', pathCore: '#e9dab4', deep: '#2b6cc0', shore: '#a4d0f2', props: 'pines' },
    bay:     { snow: '#ecf6f3', ice: '#c2e5de', pathColor: '#e2cb96', pathEdge: '#b0985f', pathCore: '#efdfb6', deep: '#0f83a6', shore: '#90dcd8', props: 'bay' },
    peak:    { snow: '#f1f4f9', ice: '#ccd8ea', pathColor: '#cfc39c', pathEdge: '#9c8f6c', pathCore: '#dfd5b6', deep: '#2f79c2', shore: '#a6d6ec', props: 'dead' },
    workshop:  { snow: '#eaf0fb', ice: '#c2d4f2', pathColor: '#e0ca9c', pathEdge: '#ad9668', pathCore: '#eedcba', deep: '#2361b4', shore: '#9cc8f0', props: 'workshop' },

    /* ---- tier 2: colder light, harder blues ---- */
    flats:     { snow: '#eaf1fb', ice: '#bed9f4', pathColor: '#d6c9a6', pathEdge: '#a08c66', pathCore: '#e5dac0', deep: '#2270c0', shore: '#9cd0ee', props: 'pines' },
    fjord:     { snow: '#e6f2f8', ice: '#b2d9ee', pathColor: '#dcc898', pathEdge: '#ab9464', pathCore: '#eadbb4', deep: '#0e7ba2', shore: '#86d2dc', props: 'bay' },
    cataracts: { snow: '#eaf7f5', ice: '#bce4e4', pathColor: '#e0cb98', pathEdge: '#af9765', pathCore: '#ecdcb4', deep: '#128aa8', shore: '#8cd8dc', props: 'reeds' },
    shelf:     { snow: '#eaf1fc', ice: '#bcd8f4', pathColor: '#d2c6a6', pathEdge: '#9d8a66', pathCore: '#e2d8c0', deep: '#1c6cba', shore: '#98cbee', props: 'floes' },
    rookery:   { snow: '#f4f8fd', ice: '#cde2f4', pathColor: '#e8d4a4', pathEdge: '#b59c6e', pathCore: '#f4e5c4', deep: '#2381c8', shore: '#a4dcf0', props: 'village' },
    basin:     { snow: '#94a1c8', ice: '#6874ac', pathColor: '#59648f', pathEdge: '#3c4670', pathCore: '#6a759e', deep: '#263e6e', shore: '#5a74a4', props: 'crystals', glow: '#7fb8f5' },
    sable:     { snow: '#e4ebf5', ice: '#b9cce6', pathColor: '#c8c0a0', pathEdge: '#948a68', pathCore: '#d8d0b2', deep: '#2470b2', shore: '#a0cce8', props: 'dead' },
    floes:     { snow: '#e9f4fd', ice: '#b6d9f4', pathColor: '#d0c8a8', pathEdge: '#9a8e6a', pathCore: '#e0d8c2', deep: '#156cba', shore: '#92c8ee', props: 'floes' },
    stormwall: { snow: '#ecf1f8', ice: '#c4d3e8', pathColor: '#c6bc9a', pathEdge: '#928866', pathCore: '#d6ccae', deep: '#2470b2', shore: '#a4cce6', props: 'dead' },
    longdark:  { snow: '#8591bb', ice: '#5e6b9a', pathColor: '#4f597f', pathEdge: '#353e60', pathCore: '#5d668c', deep: '#21335c', shore: '#4d6494', props: 'crystals', glow: '#6fa8ea' },

    /* ---- tier 3: the far ice — deepest colour, most dramatic ---- */
    approach:  { snow: '#e2e9f6', ice: '#b0c6ea', pathColor: '#c4bd9e', pathEdge: '#8f8666', pathCore: '#d4cbb0', deep: '#1c5c9e', shore: '#98c0e8', props: 'pines' },
    causeway:  { snow: '#dfeef7', ice: '#a6d2ec', pathColor: '#d2c090', pathEdge: '#a08e5e', pathCore: '#e0d0a4', deep: '#0c6c96', shore: '#82cade', props: 'bay' },
    trench:    { snow: '#daecf3', ice: '#9ecde2', pathColor: '#c2b995', pathEdge: '#8d8462', pathCore: '#d2c9a8', deep: '#085a80', shore: '#78bcd4', props: 'bay' },
    obsidian:  { snow: '#8390b8', ice: '#59689a', pathColor: '#475478', pathEdge: '#2e3757', pathCore: '#525d84', deep: '#1b2f56', shore: '#45608e', props: 'crystals', glow: '#6f9ce8' },
    cathedral: { snow: '#e2e7fb', ice: '#b8c6f4', pathColor: '#d0c298', pathEdge: '#9c8f64', pathCore: '#e0d2ac', deep: '#24509c', shore: '#a2c2ec', props: 'crystals', glow: '#9ce8d4' },
    maelstrom: { snow: '#dae4f5', ice: '#b0c6ec', pathColor: '#c8bd9a', pathEdge: '#948a66', pathCore: '#d8cfae', deep: '#1c58a0', shore: '#9cc6ec', props: 'floes' },
    icefall:   { snow: '#e3ecf6', ice: '#b4cde8', pathColor: '#bcb894', pathEdge: '#898262', pathCore: '#ccc6a6', deep: '#2064a2', shore: '#a0c9e8', props: 'dead' },
    blackice:  { snow: '#7481ac', ice: '#4c5a88', pathColor: '#3c476e', pathEdge: '#262e4c', pathCore: '#46527a', deep: '#152647', shore: '#3a507c', props: 'crystals', glow: '#5f92e2' },
    throne:    { snow: '#dfe4f8', ice: '#b2c0f0', pathColor: '#cabb92', pathEdge: '#978c60', pathCore: '#d9cba6', deep: '#1e4a94', shore: '#9cbcec', props: 'workshop' },
    worldsend: { snow: '#d6def4', ice: '#a8bae8', pathColor: '#beb28e', pathEdge: '#8b8160', pathCore: '#cec2a0', deep: '#184288', shore: '#92b4e8', props: 'workshop' },
  };
  for (const L of G.LEVELS) Object.assign(L.theme, THEME_EXTRAS[L.id] || {});

  /* Tier metadata is positional: ten battlefields per tier, in order.
     slot (0-9) drives wave density so each tier ramps like a fresh campaign. */
  G.LEVELS.forEach((L, i) => {
    L.tier = Math.floor(i / 10) + 1;
    L.slot = i % 10;
    const d = TIER_DIMS[L.tier] || TIER_DIMS[1];
    L.w = L.w || d.w;
    L.h = L.h || d.h;
    L.bountyMult = L.bountyMult || TIER_BOUNTY[L.tier] || 1;
  });

  /* ---------------- Terrain obstacles ----------------
     Boulder fields, cracked ice and glacier walls that Bros cannot build
     on. They exist to take away firing positions: the ground beside the track
     is the only ground worth holding, so denying some of it is what makes a
     battlefield hard rather than merely long.

     The bite scales with how deep into the campaign a map sits — battlefield 1
     loses almost nothing, World's End loses better than a third. Before this,
     the late maps were the roomiest on the roster (tier 3 averaged ~1,500
     firing spots against tier 1's ~950), which had difficulty running backwards.

     Generated rather than hand-placed: 30 maps × dozens of formations is a lot
     of literals to keep correct, and a seeded generator is reproducible, so a
     given battlefield looks identical on every device and every run. */
  /* ---- line of sight ----
     Anything that stands UP blocks shots; a hole in the ground does not. So
     cracked ice denies you the ground but not the shot, while boulders,
     sculptures, builds, wrecks and brick walls deny you both. That split is
     what makes the three obstacle types play differently rather than just
     look different. Sight uses 90% of the drawn radius, so grazing a corner
     still connects and the rule feels fair rather than fussy. */
  G.SIGHT_BLOCKS = { rock: true, crystal: true, fort: true, wreck: true, glacier: true, crack: false };
  G.SIGHT_SHRINK = 0.9;
  /* Lobbed munitions arc over terrain, and weather does not care about walls.
     Those two exemptions matter: they mean a ridge creates a problem with an
     answer (bring the howitzer, the depth charges or the blizzard) rather than
     a dead zone nothing can cover. */
  G.arcsOverTerrain = (calc) => !!calc.arcs || calc.kind === 'lob' || calc.kind === 'pulse';

  /* ---------------- Global Bro nerf ----------------
     Applied to every Bro and hero after its upgrades are totalled, so it
     covers base stats and upgrade bonuses alike without touching 120 tiers by
     hand.

     Every multiplier is 1 today: a Bro hits, reaches and fires exactly as
     its printed numbers say. The hook stays because this is the one place a
     global change belongs, and balance here gets retuned often.

     The 20% aura cut used to live here. It moved into the aura values
     themselves, because a multiplier applied at compute time made every
     printed percentage a lie: "Helpers hit 35% harder" really meant 28%, and
     no screen in the game could tell you that. Aura numbers in this file are
     now the numbers the player is promised.

     The 0.75 damage cut came out first, for overshooting. The 0.85 reach and
     fire-rate cuts have now followed it, for the same reason one step later.
     Measured on the scripted learner, over three seeds: with them, Medium lost
     every battlefield tried — battlefield 1 died on the final wave, 5 on wave
     30 and 3 collapsed at wave 18 on nine Bros — and even Easy came home
     on a third of its lives. Without them, the same learner wins Medium with
     ~90-130 lives spare and Easy without being touched.

     Undoing them does not put the difficulty back where it started. The
     terrain obstacles and line of sight stay, and they are the honest half of
     that change: they make a battlefield hard by denying firing ground rather
     than by quietly shaving every printed stat. */
  G.NERF = { damage: 1, rate: 1, range: 1 };

  /* Parts Trader stacking. The richest stall earns full price and each one
     after it takes this fraction of the one before, so the total converges and
     carpeting the map with vendors stops being the correct opening. Named
     rather than inlined because the dock panel quotes it back to the player. */
  G.VENDOR_FALLOFF = 0.7;

  const OBSTACLE_KINDS = {
    1: ['rock', 'rock', 'crack', 'glacier'],
    2: ['rock', 'crack', 'crack', 'glacier'],
    3: ['rock', 'crack', 'glacier', 'glacier'],
  };
  // fraction of the buildable firing ground each battlefield should lose
  G.obstacleBite = (li) => 0.05 + (li / 29) * 0.33;

  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a += 0x6d2b79f5;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pathPointsOf(L) {
    const pts = [];
    for (const pl of L.paths) {
      for (let i = 0; i < pl.length - 1; i++) {
        const a = pl[i], b = pl[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const ang = Math.atan2(b.y - a.y, b.x - a.x);   // local track direction
        for (let d = 0; d < len; d += 24) {
          pts.push({ x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len, ang });
        }
      }
    }
    return pts;
  }
  // direction of the track nearest a point — glacier ridges run alongside it
  function trackAngleNear(pts, x, y) {
    let best = Infinity, ang = 0;
    for (const p of pts) {
      const d2 = (x - p.x) ** 2 + (y - p.y) ** 2;
      if (d2 < best) { best = d2; ang = p.ang; }
    }
    return ang;
  }
  const inWaterOf = (L, x, y) => L.water.some((w) => w.rect
    ? x >= w.rect.x - 10 && x <= w.rect.x + w.rect.w + 10 && y >= w.rect.y - 10 && y <= w.rect.y + w.rect.h + 10
    : (x - w.x) ** 2 + (y - w.y) ** 2 <= (w.r + 10) ** 2);

  G.LEVELS.forEach((L, li) => {
    const W = L.w, H = L.h;
    const rnd = seeded(9161 + li * 2711);
    const pts = pathPointsOf(L);
    const kinds = OBSTACLE_KINDS[L.tier] || OBSTACLE_KINDS[1];
    const CLEAR = G.PATH_HALF + G.TOWER_R + 12;   // never crowd the track itself

    /* The firing ground worth denying: buildable, within a Bro's reach.
       Split by how close to the track it sits — obstacles on the SHOULDER
       (just outside the build clearance) are the ones that cast shadows down
       the track and actually take shots away; obstacles further out only deny
       standing room. A field made only of the latter left line of sight worth
       about 1%, so roughly half of every formation now hugs the track. */
    const lattice = [];
    for (let y = 60; y < H - 30; y += 20) {
      for (let x = 30; x < W - 30; x += 20) {
        if (inWaterOf(L, x, y)) continue;
        let best = Infinity;
        for (const p of pts) {
          const d2 = (x - p.x) ** 2 + (y - p.y) ** 2;
          if (d2 < best) best = d2;
        }
        const d = Math.sqrt(best);
        if (d < CLEAR || d > 150) continue;
        lattice.push({ x, y, shoulder: d < CLEAR + 46 });
      }
    }
    if (!lattice.length) return;
    const shoulder = lattice.filter((p) => p.shoulder);
    const field = lattice.filter((p) => !p.shoulder);

    const blocked = new Set();
    const key = (p) => p.x + ',' + p.y;
    for (const b of L.blockers) {
      for (const p of lattice) {
        if ((p.x - b.x) ** 2 + (p.y - b.y) ** 2 < (b.r + G.TOWER_R) ** 2) blocked.add(key(p));
      }
    }
    const want = Math.round(lattice.length * G.obstacleBite(li));
    // never strip a map bare — a third of its firing ground always survives
    const floor = Math.round(lattice.length * 0.34);
    let guard = 0;
    while (blocked.size < want && lattice.length - blocked.size > floor && guard++ < 400) {
      // 55% of formations hug the track, where they actually block firing lines
      const pool = (rnd() < 0.55 && shoulder.length) ? shoulder : (field.length ? field : lattice);
      const seed = pool[(rnd() * pool.length) | 0];
      if (!seed || blocked.has(key(seed))) continue;
      const kind = kinds[(rnd() * kinds.length) | 0];
      /* Wall ridges are long BARRIERS laid alongside the track — that is what
         casts a real shadow down it. Scattered lumps looked like terrain but
         blocked almost nothing: they left line of sight worth about 1%. Rocks
         and cracks stay short and scattered. */
      const lumps = kind === 'glacier' ? 4 + ((rnd() * 5) | 0) : 1 + ((rnd() * 2) | 0);
      const ang = kind === 'glacier'
        ? trackAngleNear(pts, seed.x, seed.y) + (rnd() - 0.5) * 0.7
        : rnd() * Math.PI * 2;
      let cx = seed.x, cy = seed.y;
      for (let n = 0; n < lumps; n++) {
        const r = (kind === 'glacier' ? 26 : kind === 'crack' ? 24 : 22) + rnd() * 10;
        if (cx < 30 || cx > W - 30 || cy < 60 || cy > H - 30) break;
        if (inWaterOf(L, cx, cy)) break;
        let clearsPath = true;
        for (const p of pts) {
          if ((cx - p.x) ** 2 + (cy - p.y) ** 2 < (CLEAR + r * 0.5) ** 2) { clearsPath = false; break; }
        }
        if (!clearsPath) break;
        L.blockers.push({ x: Math.round(cx), y: Math.round(cy), r: Math.round(r), kind, gen: true });
        for (const p of lattice) {
          if ((p.x - cx) ** 2 + (p.y - cy) ** 2 < (r + G.TOWER_R) ** 2) blocked.add(key(p));
        }
        /* Wall lumps OVERLAP so the ridge is a solid barrier. Stepping a
           full 1.35 radii apart left ~13px seams between the sight circles,
           and shots threaded straight through them — the wall looked like a
           wall and blocked almost nothing. */
        const step = kind === 'glacier' ? r * 0.8 : r * 1.35;
        cx += Math.cos(ang) * step;
        cy += Math.sin(ang) * step;
      }
    }
  });
})();
