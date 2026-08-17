# 🧱 Brix and Bros — Bros vs. Vacuums

A tower defense game. The vacuums are rolling in on the workshop — recruit Bros,
hold the line across **30 battlefields** in **three campaign tiers** and **three
difficulties**, and keep every last build safe.

Runs in any modern browser on **Mac and PC** — no install, no internet, no dependencies.
Also playable on a **phone or tablet held sideways**: the controls become a side dock with
a drag-to-place touch scheme, and you can add it to your home screen as a full-screen app.

### Play it anywhere

**https://krtisclarke.github.io/brixandbros/** — the hosted copy, kept current with
this repo. On a phone, open it once and **Share → Add to Home Screen** (iPhone) or
**⋮ → Add to Home screen** (Android): you get a full-screen app with its own icon, and
after that first visit it keeps working **offline** — no computer, no internet.

### Playing on a phone

Hold the phone **sideways** (portrait shows a rotate prompt). Tap a Bro to pick it up,
drag on the board to aim the ghost, lift your finger to place. Long-press any Bro or
boost for its stats. The controls live in a side dock so the battlefield gets the whole
screen height.

## How to run

**Easiest:** double-click `index.html` — it opens in your browser and just works.

**Recommended:** use the launcher for your platform (starts a tiny local server, which some
browsers prefer for saved games):

- **Mac:** double-click `Play on Mac.command`
  *(first time: right-click → Open if macOS warns about an unidentified developer)*
- **Windows:** double-click `Play on Windows.bat`

Both use Node or Python if you have them, and fall back to opening `index.html` directly.

## The game

### Three difficulties — pick one when you start a battle

| | Waves | Bro prices | Lives | Victory reward | Retry cost |
|---|---|---|---|---|---|
| 🟩 **Easy** | 30 | 15% cheaper | +25% | 100 🧱 | 40 🧱 |
| 🟨 **Medium** | 40 | standard | standard | 250 🧱 | 75 🧱 |
| 🟥 **Hard** | 50 | 15% pricier | −20% | 500 🧱 | 150 🧱 |

Every campaign ends on a boss wave: the Carpet Cleaner pair (30), the Floor Buffer (40),
or The Extractor / Central Unit (50). Beating a battlefield on any difficulty unlocks the
next one.

**Second Chance:** if the build falls, spend bricks to retry — lives fully restored, the
board cleared, and the wave that beat you replays with your Bros and studs intact.

### 🔁 The Endless Shift — keep going past the campaign

Beat the final boss and the victory screen offers **Keep Going** — the waves continue past
the campaign, tougher every wave, with a boss court every 10th, until the build falls.
Your win and its bricks are already banked; every 10th endless wave survived pays a bonus
(25 / 50 / 100 🧱 by difficulty), every 100th pays **ten times that** (250 / 500 / 1,000
🧱), and each battlefield remembers your record wave on the level select.

#### The big machines arrive — wet/dry vacs from wave 71

At Endless wave 71 the board comes apart and the shop machinery rolls in. Heavies never
split — one patient slab of steel instead of a bag of smaller problems — and they carry
heavy armour. They also hoover the pack: **any ordinary vacuum that rolls into a heavy is
swallowed whole**, which refills it. You get nothing for a swallowed vacuum — no studs, no
XP — so a fat pack in front of a heavy is a meal you're serving. Clear the small stuff
fast, or feed them.

Refilling is capped at 60% of a heavy's own maximum however rich the pickings, so feeding
buys them time and never immortality.

**Deep endless gets faster, not just fatter.** Past wave 50 the pack picks up speed (to
×1.7) and shrugs off more and more of your clog (to 60% resistance), because piling health
onto slow-moving vacuums made late waves long rather than hard. Waves now resolve in about
two minutes at any depth, and failure is sharp: the pack either dies or reaches the Home
Build. None of this touches the 30/40/50-wave campaign, which plays exactly as before.

**Letting one reach the Home Build is the loss condition**, not a setback — a heavy through
the door costs more lives than any ordinary vacuum in the game:

| Waves | Machine | HP | Armour | Lives if it leaks |
|---|---|---|---|---|
| 71–80 | Wet/Dry Vac | 1,200 | 3 | **100** |
| 81–90 | Industrial Wet/Dry | 3,600 | 4 | **180** |
| 91–99 | Turbine Extractor | 9,000 | 5 | **300** |
| **100** | **THE MEGAVAC** | **190,000** | **8** | **1,000** |

For scale, a Central Unit costs 250 and Easy starts you with 190 lives — two Wet/Dry Vacs
through the door and the run is over.

THE MEGAVAC is the largest machine in the game and it guards the century jackpot. It is a
genuine wall, sized against a **moving** target — it rolls through the whole kill zone, so
an eighteen-Bro maxed board lands about 1,283 damage a second on it, not the ~895 a dummy
pinned in one spot suggests. That is roughly 169,000 across its 132-second run. Measured:
an eighteen-Bro board **loses** it through the door, while a twenty-five-Bro board kills it
at the halfway mark. Landing the century takes a real late-game defence, your hero and your
boosts.

Waves 101+ keep the Turbine Extractors coming, with another MEGAVAC every century.

### Two currencies: studs & bricks

**🔩 Studs** are match money: pops and wave clears pay them, and they recruit and upgrade
Bros. They reset every battle.

Winning a battle earns **🧱 bricks** — a permanent currency stored with your profile. Spend
them in the **Boost Shop** (main menu, or from the difficulty screen) *before* a match.
Boosts you own appear in the command dock during battle — one click fires them:

| Boost | Cost | Effect |
|---|---|---|
| 🔩 Stud Dump | 15 | +600 🔩 studs, instantly |
| 🧱 Brick Trap | 20 | 40 loose bricks (10 dmg each) scattered near the exit of every track |
| 🥁 Rally Drum | 25 | every Bro attacks 50% faster for 15s |
| ⚡ Power Cut | 30 | every vacuum unplugged for 4s (bosses 1.5s) |
| 💖 Second Wind | 40 | +25 lives |
| 🪣 Tip the Tub | 50 | 60 damage to everything on the board, ignoring armor |

### Heroes — one champion fights beside you

Pick a hero on the challenge screen before a battle. In battle they place like a Bro (a
stud price, one per battle), then **level up on their own** — on vacuums broken while they
stand on the board, each level costing more than the last, to level 20 — and their damage
**scales with the pack itself**. At level 3 the signature ability unlocks — free to fire
(press **H**), recharging over time.

Nine champions, each built around a job the others don't do. Prices are not guesswork:
every hero was run through 18 identical battles — six battlefield/difficulty pairings ×
three seeds — against the same scripted defence, firing its ability whenever it recharged.
The improvement over fighting heroless was mapped onto the 2,500–7,500 🧱 band, so what a
hero costs is what it measured.

| Hero | Recruited | Style | Ability |
|---|---|---|---|
| ⚔️ **Captain Flint** | free | heavy single-target damage | 🧱 Brick Slam — smashes the whole board |
| 💣 **Major Marlow** | 2,500 🧱 | lobs over walls and builds; wide blast | 💣 Shell Barrage — six shells walked down the track |
| 🌪️ **Scout Tilly** | 2,750 🧱 | shreds swarms, sees stealth | 🌪️ Grit Storm — buries everything near her |
| 🧪 **Warden Kell** | 4,000 🧱 | strips casing, poisons the wound | 🧪 Corrosion — −3 armour on the board, and burning |
| 🔩 **Trader Fen** | 4,500 🧱 | every kill the workshop makes pays more | 🔩 Stud Haul — a lump of studs, bigger on deep waves |
| 📯 **Foreman Bolt** | 5,000 🧱 | nearby Bros fight harder & faster | 📯 Rally Horn — everyone attacks 50% faster for 8s |
| 🌌 **Prism Sage** | 6,250 🧱 | steady armour-piercing beam | 🌌 Prism Veil — the board clogged hard and scorched |
| 🎯 **Gunner Rook** | 7,500 🧱 | reaches the whole board; +60% vs bosses | 🎯 Laser Volley — through the eight biggest |
| 🔧 **Elder Gritt** | 7,500 🧱 | clogs whole packs, deeper each level | 🔧 Deep Jam — jams every vacuum for 2.5s |

Every damage ability also takes a **share of a boss's own health** on top of its flat
number — 3% for Laser Volley down to 0.8% for Grit Storm, capped at 12% of the machine
across the whole cast. Ordinary vacuums are unaffected: the flat damage already kills them
several times over.

Heroes are permanent once recruited.

### 🏛️ Workshop Upgrades — bricks that work forever

The permanent half of the brick economy (main menu or challenge screen). Six upgrades,
three tiers each — starting studs, starting lives, bigger bounties, cheaper Bros,
discounted Second Chances, richer wave rewards. Bought once, active in every battle from
then on.

### Your Bros — 20 defenders, 4 classes, each with 3 upgrade paths × 3 tiers

**Three paths, choose two.** Every Bro has three upgrade paths, and studs may go into only
**two** of them — buying into a second path shuts the third for the rest of the battle. One
of your two may run all the way to its **capstone** (tier 3); the other stops at tier 2.
That is the same five purchases a Bro has always supported, so no price moves: what changes
is that each Bro has six real builds (which pair, then which of the pair caps) instead of
two.

Tiers 1 and 2 sharpen the numbers. **Every capstone changes how the Bro plays** —
ricochets, seizure meters, grease trails, drift mines, strafing dives, anchored storms,
brick decoys, corrupted ground, an alarm dome.

Every Bro's card shows its **☠ kill count**, and the victory screen names the battle's top
defender.

### Builder rank — every vacuum is 1 XP

The workshop starts with five Bros (Brick Slinger, Boulder Knight, Laser Sniper, Spark
Mage, Parts Trader) — one or two from each class. **Every vacuum destroyed earns 1 XP**,
splits included, so a Carpet Cleaner is worth 17 and a Floor Buffer 52. **Each rank gained
recruits exactly one more Bro**, weakest first, and the legendary Sun Priest last at rank
16:

| Rank | Recruit | Rank | Recruit | Rank | Recruit |
|---|---|---|---|---|---|
| 2 | Glue Slinger | 7 | Radar Mast | 12 | Jetpack Trooper |
| 3 | Sword Spinner | 8 | Shadow Ninja | 13 | Storm Caller |
| 4 | Deep Rover 💧 | 9 | Hex Witch | 14 | Mech Cannon |
| 5 | Catapult | 10 | Wall Builder | 15 | Brick Fort |
| 6 | Hover Skiff 💧 | 11 | War Drummer | 16 | Sun Priest |

| Class | Bros |
|---|---|
| ⚔ **Knights** — frontline damage | Brick Slinger, Boulder Knight, Sword Spinner, Catapult, Glue Slinger |
| 🚀 **Space** — hardware & vehicles | Laser Sniper, Deep Rover 💧, Hover Skiff 💧, Jetpack Trooper, Mech Cannon |
| 🔮 **Wizards** — spellwork | Spark Mage, Hex Witch, Storm Caller, Shadow Ninja, Sun Priest |
| 🛠 **Crew** — economy & buffs | Parts Trader, Brick Fort, Radar Mast, War Drummer, Wall Builder |

💧 = must be placed in a pool.

### The vacuums — 13 machines that break apart

Dust Buster → Stick Vac → Upright → Heavy Upright … bigger machines break into smaller
ones, so a wave is never over until the last handheld is down. Watch for:

- **Robo-Vac** — twice as fast as anything else
- **Silent Runner** — invisible without detection (Shadow Ninja sees them innately; many
  Bros can learn to)
- **Steel Canister** — flat damage reduction; shred it (Hex Witch) or pierce it (Laser
  Sniper, Sun Priest)
- **Cyclone** — empties itself and keeps going
- **Shop Vac** — a wall of steel that splits into two Heavy Uprights
- **Boss class:** the **Carpet Cleaner** (wave 20), the **Floor Buffer** (wave 40), **The
  Extractor** (wave 50) — and on the last four battlefields, the **Central Unit**

Vacuums get tougher on every battlefield (up to 2.6× HP on City Hall) and mix into nastier
combinations as the campaign goes on.

### The three campaign tiers

The 30 battlefields are grouped into tiers on the level select. Each tier is a fresh
difficulty ramp on a **physically larger, more tangled board** — and every tier starts
tougher than the one before it finished.

| Tier | Battlefields | Board size | Vacuum HP | Bounties |
|---|---|---|---|---|
| 🏙 **Brick City** | 1–10 | 1280 × 800 | 1.0× → 2.6× | 1× |
| 🚀 **Star Port** | 11–20 | 1440 × 860 | 2.8× → 4.6× | 1.5× |
| 🏰 **Castle Realm** | 21–30 | 1600 × 920 | 5.0× → 8.6× | 2.3× |

Tracks get longer with the tiers too — from a 2,240px stroll on Starter Plate to the
9,180px six-lane crawl of The Labyrinth.

### The 30 battlefields

**Brick City** — 1. Starter Plate ★ · 2. Main Street ★ · 3. Canal Street ★★ ·
4. Two-Gate Junction ★★ · 5. The Old Quarter ★★★ · 6. The Subway ★★★ ·
7. Fountain Square ★★★★ · 8. The Docks ★★★★ · 9. Rooftop Run ★★★★★ · 10. City Hall ★★★★★

**Star Port** — 11. Landing Apron ★ · 12. Coolant Channels ★ · 13. Twin Coolant Runs ★★ ·
14. Cargo Deck ★★★ · 15. The Hangars ★★ · 16. Dark Side Basin ★★★ · 17. The Fuel Yards ★★★★ ·
18. The Tank Farm ★★★★ · 19. Ion Storm Ridge ★★★★★ · 20. Deep Space Dock ★★★★★

**Castle Realm** — 21. The Approach ★ · 22. Broken Causeway ★ · 23. The Moat ★★ ·
24. Black Keep Maze ★★ · 25. The Great Hall ★★★ · 26. The Millrace ★★★ ·
27. Broken Aqueduct ★★★★ · 28. The Labyrinth ★★★★ · 29. The Throne Room ★★★★★ ·
30. The Last Wall ★★★★★

### Unlocking

**Each difficulty is its own campaign.** Battlefield 1 is open on all three from the start;
after that you advance one battlefield at a time on the difficulty you're playing, and
clearing an entire tier of ten opens the next tier **on that difficulty**. A win counts for
every **easier** difficulty too.

### How the star ratings are set

Stars are **measured, not guessed**. A board's real difficulty is the *Bro-seconds* it
affords you — how long a vacuum is under fire (track length ÷ speed) multiplied by how many
buildable spots can reach an average point of its route — weighed against how tough the
pack is and how many independent routes you must cover at once.

The counter-intuitive part: a long, tightly-folded serpentine is **generous**, not cruel.
One Bro covers several lanes at once and the enemy rolls past your guns for a minute and a
half. The genuinely hard boards are the *short* ones (Rooftop Run, Fountain Square, The
Last Wall) and the ones that **split** into routes you cannot defend with the same guns.

### Music

Each battlefield plays a chiptune loop, and the tempo climbs **+1% with every wave**, so
wave 50 hits about 1.6× the speed of wave 1. The 🔊 button mutes music and sound effects
together.

### Saving

- The game **autosaves after every wave**.
- The **💾 Save** button saves **mid-wave** — even with vacuums on the board — and the level
  screen shows a **Continue** button to pick up exactly where you left off.
- Progress is stored in your browser (localStorage). *Reset Progress* on the main menu
  wipes it.
- **💾 Back Up Progress** (main menu) writes everything — bricks, unlocks, saved games — to
  one file you keep. **📂 Load Backup** restores it anywhere, including a different browser
  or computer.

### Controls

The interface is a bottom command dock built for keyboard + mouse: build palette in the
middle (laid out like your keyboard), selection card on the left, wave controls on the
right.

| Input | Action |
|---|---|
| **1–5** / **Q–T** / **A–G** / **Z–B** | Build a Knight / Space / Wizard / Crew Bro (or click its slot), then click the board. Hold **Shift** to place several |
| Click a placed Bro | Its card appears bottom-left |
| **Q** / **W** / **E** (selected) | Buy upgrade path 1 / 2 / 3 |
| **T** (selected) | Cycle targeting: first / last / strong / close |
| **X** (selected) | Sell — straight away, no confirmation. The sell *button* asks first |
| **Space** | Send next wave |
| **Tab** | Cycle game speed 1× / 2× / 3× |
| **P** | Quick pause · **M** mute |
| **Ctrl/⌘+S** | Save mid-wave |
| **Esc** / right-click | Cancel placement → deselect → pause menu |
| ⛶ (top-right corner) | Toggle fullscreen — available on every screen |

### Tips

- **The plate beside the track is the real resource.** Brick walls, prised-up plates and
  builds can't be built on, and there are progressively more of them as the campaign goes
  on — Starter Plate is nearly open, The Last Wall is a maze. Scout where you *can* stand
  before you commit your studs.
- Glue Slingers and Boulder Knights make everything else hit more often — clog is damage.
- **Aura Bros don't stack much.** Each extra source of the same buff counts for half the
  one before it, and every buff has a ceiling (damage ×2, attack speed ×2, range ×1.45).
- Build a Parts Trader or two before wave 10 — but only a couple. Each extra trader earns
  30% less than the one before it.
- **Stealth detection is a choice, not a freebie.** Each class has exactly one cheap answer
  — the Knights' **Keen Eyes** (🔩90, the cheapest upgrade in the game), Space's **Night
  Optics** and **Thermal Visor**, the Shadow Ninja born with it for Wizards, and Crew's
  **Watchtower** plus the Radar Mast itself. Skip them all and wave 14 will hurt.
- Have detection online before wave 14, and armor-shred before wave 16.
- Save a Laser Sniper with the **Extractor Lance** upgrade for boss waves.
- Walls placed near the exit catch whatever slips through.

## Files

```
index.html        the game (open this)
style.css         UI styling
js/data.js        Bros, upgrades, vacuums, 30 battlefields across 3 tiers
js/waves.js       wave generation (up to 50 waves × 30 battlefields)
js/engine.js      simulation: combat, targeting, saves
js/render.js      canvas art: baseplates, Bros, vacuums
js/ui.js          menus, shop, HUD, persistence, sound
js/main.js        boot
serve.js          tiny local web server used by the launchers
```

Built with vanilla JavaScript and HTML5 canvas — no frameworks, no build step.
