# 🐧 Tundra Defense — Penguins vs. Sea Lions

A tower defense game. The sea lion herds are marching on the penguin
colony — recruit penguin defenders, hold the line across **30 battlefields** in **three
campaign tiers** and **three difficulties**, and keep every last chick safe.

Runs in any modern browser on **Mac and PC** — no install, no internet, no dependencies.
Also playable on a **phone or tablet held sideways**: the controls become a side dock with
a drag-to-place touch scheme, and you can add it to your home screen as a full-screen app.

### Play it anywhere

**https://krtisclarke.github.io/tundra-defense/** — the hosted copy, kept current with
this repo. On a phone, open it once and **Share → Add to Home Screen** (iPhone) or
**⋮ → Add to Home screen** (Android): you get a full-screen app with its own icon, and
after that first visit it keeps working **offline** — no computer, no internet.

### Playing on a phone

Hold the phone **sideways** (portrait shows a rotate prompt). Tap a penguin to pick it
up, drag on the map to aim the ghost, lift your finger to place. Long-press any penguin
or boost for its stats. The controls live in a side dock so the battlefield gets the
whole screen height.

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

| | Waves | Tower prices | Lives | Victory reward | Retry cost |
|---|---|---|---|---|---|
| 🐣 **Easy** | 30 | 15% cheaper | +25% | 100 🪨 | 40 🪨 |
| 🐧 **Medium** | 40 | standard | standard | 250 🪨 | 75 🪨 |
| 🦭 **Hard** | 50 | 15% pricier | −20% | 500 🪨 | 150 🪨 |

Every campaign ends on a boss wave: the Beachmaster pair (30), the Colossus (40), or the
Emperor / Leviathan (50). Beating a level on any difficulty unlocks the next battlefield.

**Second Chance:** if the colony falls, spend pebbles to retry — lives fully restored, the
field cleared, and the wave that beat you replays with your towers and fish intact.

**🌊 The Endless Tide:** beat the final boss and the victory screen offers **Keep Going** —
the waves continue past the campaign, tougher every wave, with a boss court every 10th,
until the colony falls. Your win and its pebbles are already banked; every 10th endless
wave survived pays a bonus (25 / 50 / 100 🪨 by difficulty), every 100th pays **ten times
that** (250 / 500 / 1,000 🪨), and each battlefield remembers your record wave on the
level select.

#### 🐋 The Tide Comes In — orcas from wave 71

At Endless wave 71 the trails **flood**: every track on the battlefield turns to open
water and the apex predators arrive. Orcas never split — one patient slab of muscle
instead of a bag of smaller problems — and they carry heavy armour. They also hunt the
herds: **any ordinary sea lion that swims into an orca is swallowed whole**, which heals
it. You get nothing for a devoured sea lion — no fish, no XP — so a fat herd in front of
an orca is a meal you're serving. Clear the chaff fast, or feed them.

Healing is capped at 60% of an orca's own maximum however rich the water, so feeding
buys them time and never immortality.

**Deep endless gets faster, not just fatter.** Past wave 50 the herds pick up speed
(to ×1.7) and shrug off more and more of your chill (to 60% resistance), because piling
health onto slow-moving sea lions made late waves long rather than hard — by wave 130
every enemy had spawned within 70 seconds and the remaining four minutes were spent
chipping at a handful of pinned survivors. Waves now resolve in about two minutes at any
depth, and failure is sharp: the herd either dies or reaches the igloo. None of this
touches the 30/40/50-wave campaign, which plays exactly as before.

**Letting one reach the igloo is the loss condition**, not a setback — an orca through
the door costs more lives than any sea lion in the game:

| Waves | Hunter | HP | Armour | Lives if it leaks |
|---|---|---|---|---|
| 71–80 | Young Orca | 1,200 | 3 | **100** |
| 81–90 | Bull Orca | 3,600 | 4 | **180** |
| 91–99 | Great Orca | 9,000 | 5 | **300** |
| **100** | **KILLER WHALE** | **190,000** | **8** | **1,000** |

For scale, an Ancient Leviathan costs 250 and Easy starts you with 190 lives — two Young
Orcas through the door and the run is over.

The KILLER WHALE is the largest creature in the game and it guards the century jackpot.
It is a genuine wall, sized against a **moving** target — a whale swims through the whole
kill zone, so an eighteen-tower maxed board lands about 1,283 damage a second on it, not
the ~895 a dummy pinned in one spot suggests. That is roughly 169,000 across its
132-second swim. Measured: an eighteen-tower board **loses** the whale through the door,
while a twenty-five-tower board kills it at the halfway mark. Landing the century takes a
real late-game defence, your hero and your boosts.

Waves 101+ keep the Great Orcas coming, with another KILLER WHALE every century.
Flooding is cosmetic: build spots, path geometry and water-only penguins are completely
unchanged.

### Two currencies: fish & pebbles

**🐟 Fish** is match money: pops and wave clears pay it, and it recruits and upgrades
penguins. It resets every battle.

Winning a battle earns **🪨 pebbles** — a permanent currency stored with your profile.
Spend them in the **Boost Shop** (main menu, or from the difficulty screen) *before* a match.
Boosts you own appear in the command dock during battle — one click fires them:

| Boost | Cost | Effect |
|---|---|---|
| 🐟 Fish Feast | 15 | +600 🐟 fish, instantly |
| 🧊 Ice Spikes | 20 | a 40-spike wall (10 dmg each) near the exit of every trail |
| 🥁 War Frenzy | 25 | every penguin attacks 50% faster for 15s |
| ❄️ Big Freeze | 30 | every sea lion frozen for 4s (bosses 1.5s) |
| 💖 Second Wind | 40 | +25 lives |
| 🏔️ Avalanche | 50 | 60 damage to everything on the field, ignoring armor |

### Heroes — one champion fights beside you

Pick a hero on the challenge screen before a battle. In battle they place like a tower
(a fish price, one per battle), then **level up on their own** — on sea lions felled while
they stand on the field, each level costing more than the last, to level 20 — and their
damage **scales with the herd itself**: as tough as the sea
lions are, the hero hits proportionally, from the home shores to the Frozen Abyss to the
deep Endless Tide. At level 3 the signature ability unlocks — free to fire (press **H**),
recharging over time.

Nine champions, each built around a job the others don't do. Prices are not guesswork:
every hero was run through 18 identical battles — six battlefield/difficulty pairings ×
three seeds — against the same scripted defence, firing its ability whenever it recharged.
The improvement over fighting heroless was mapped onto the 2,500–7,500 🪨 band, so what a
hero costs is what it measured.

| Hero | Recruited | Style | Ability |
|---|---|---|---|
| ⚔️ **Captain Frost** | free | heavy single-target damage | 🏔️ Avalanche Charge — smashes the whole field |
| 💣 **Skipper Marlow** | 2,500 🪨 | lobs over ridges and igloos; wide blast | 💣 Depth Barrage — six charges walked down the trail |
| 🌨️ **Scout Tilly** | 2,750 🪨 | shreds swarms, sees stealth | 🌨️ Snow Flurry — buries everything near her |
| 🧪 **Warden Kell** | 4,000 🪨 | strips blubber, poisons the wound | 🧪 Corrosion — −3 armour on the field, and burning |
| 🐟 **Purser Fen** | 4,500 🪨 | every kill the colony makes pays more | 🐟 Fish Haul — a lump of fish, bigger on deep waves |
| 📯 **Commander Beak** | 5,000 🪨 | nearby penguins fight harder & faster | 📯 War Cry — everyone attacks 50% faster for 8s |
| 🌌 **Aurora Sage** | 6,250 🪨 | steady armour-piercing beam | 🌌 Aurora Veil — the field slowed hard and scorched; boss-sized ones marked instead |
| 🎯 **Bosun Rook** | 7,500 🪨 | reaches the whole map; +60% vs bosses | 🎯 Harpoon Volley — through the eight biggest |
| ❄️ **Elder Shiver** | 7,500 🪨 | slows whole packs, deeper each level | ❄️ Cold Snap — freezes every sea lion for 2.5s, and softens boss-sized ones |

Every damage ability also takes a **share of a boss's own health** on top of its flat
number — 3% for Harpoon Volley down to 0.8% for Snow Flurry, capped at 12% of the animal
across the whole cast. Ordinary sea lions are unaffected: the flat damage already kills
them several times over. Without it, an ability that scales at 1.05 a wave was landing two
tenths of one per cent on a wave-100 KILLER WHALE, which is a hit nobody could see.

Heroes are permanent once recruited. One caveat on the measurements: the scripted defence
spreads its towers for coverage rather than clustering them, so it puts barely any of them
inside Commander Beak's circle — an aura hero is worth more in human hands than the
numbers above credit.

### 🏛️ Colony Upgrades — pebbles that work forever

The permanent half of the pebble economy (main menu or challenge screen). Six upgrades,
three tiers each — starting fish, starting lives, bigger bounties, cheaper towers,
discounted Second Chances, richer wave rewards. Bought once, active in every battle
from then on.

### Your penguins — 20 towers, 4 classes, each with 3 upgrade paths × 3 tiers

**Three paths, choose two.** Every penguin has three upgrade paths, and fish may go into
only **two** of them — buying into a second path shuts the third for the rest of the
battle. One of your two may run all the way to its **capstone** (tier 3); the other stops
at tier 2. That is the same five purchases a penguin has always supported, so no price
moves: what changes is that each penguin now has six real builds (which pair, then which
of the pair caps) instead of two.

Tiers 1 and 2 sharpen the numbers. **Every capstone changes how the penguin plays** —
ricochets, freeze meters, icy wakes, drift mines, strafing dives, anchored storms, ice
decoys, corrupted ground, an alarm dome. Cheap purchases stay easy to judge mid-wave;
the identity-defining decision sits at the top, where it is saved up for.

Every penguin's card shows its **☠ kill count**, and the victory screen names the
battle's top defender.

### Colony rank — every sea lion is 1 XP

The colony starts with five penguins (Pebble Flinger, Snowball Roller, Harpoon Sniper,
Aurora Mage, Fish Vendor) — one or two from each class. **Every sea lion destroyed earns
1 XP**, splits included, so a Beachmaster is worth 17 and a Colossus 52. **Each rank
gained recruits exactly one more penguin**, weakest first, and the legendary Sun Priest
last at rank 16:

| Rank | Recruit | Rank | Recruit | Rank | Recruit |
|---|---|---|---|---|---|
| 2 | Slush Thrower | 7 | Sonar Station | 12 | Jetpack Penguin |
| 3 | Ice Shard Gunner | 8 | Shadow Diver | 13 | Blizzard Caller |
| 4 | Torpedo Sub 🌊 | 9 | Frost Witch | 14 | Artillery Emperor |
| 5 | Glacier Cannon | 10 | Ice Wall Builder | 15 | Igloo Fortress |
| 6 | Depth Charge Boat 🌊 | 11 | War Drummer | 16 | Sun Priest |

Rank 2 arrives about six waves into your very first battle, and rank 16 lands as you
finish the Frostlands — a first Easy campaign yields roughly 2,100 sea lions, and all
ten of them about 30,900. Harder difficulties field more sea lions per battle, so they
rank up faster. Lost battles still count every sea lion they felled. Existing profiles
are seeded at the rank their wins had already earned.

| Class | Towers |
|---|---|
| ❄ **Frostline** — frontline damage | Pebble Flinger, Snowball Roller, Ice Shard Gunner, Glacier Cannon, Slush Thrower |
| ⚓ **Navy** — military hardware | Harpoon Sniper, Torpedo Sub 🌊, Depth Charge Boat 🌊, Jetpack Penguin, Artillery Emperor |
| 🔮 **Mystic** — aurora magic | Aurora Mage, Frost Witch, Blizzard Caller, Shadow Diver, Sun Priest |
| 🛠 **Support** — economy & buffs | Fish Vendor, Igloo Fortress, Sonar Station, War Drummer, Ice Wall Builder |

🌊 = must be placed on water. Fish go into only two of a penguin's three paths, and only one of those two can reach its capstone — choose wisely.

### The sea lions — 13 types that split when destroyed

Pup → Juvenile → Adult → Bull … bigger sea lions break apart into smaller ones, so a wave is
never over until the last pup is down. Watch for:

- **Speedster** — twice as fast as anything else
- **Stealth** — invisible without detection (Shadow Diver sees them innately; many towers can learn to)
- **Armored** — flat damage reduction; shred it (Frost Witch) or pierce it (Harpoon, Sun Priest)
- **Regenerator** — heals while it swims
- **Brute** — a wall of blubber that splits into two Bulls
- **Boss class:** the **Beachmaster** (wave 20), the **Colossus** (wave 40), the **Emperor Sea Lion**
  (wave 50) — and on the last four battlefields, the **Ancient Leviathan**.

Sea lions get tougher on every level (up to 2.6× HP on The Last Colony) and mix into
nastier combinations as the campaign goes on.

### The three campaign tiers

The 30 battlefields are grouped into tiers on the level select. Each tier is a fresh
difficulty ramp on a **physically larger, more tangled map** — and every tier starts
tougher than the one before it finished, so even Easy in the Deep Tundra outbites
anything in the Frostlands.

| Tier | Battlefields | Map size | Sea lion HP | Bounties |
|---|---|---|---|---|
| ❄ **The Frostlands** | 1–10 | 1280 × 800 | 1.0× → 2.6× | 1× |
| 🌨 **The Deep Tundra** | 11–20 | 1440 × 860 | 2.8× → 4.6× | 1.5× |
| 🌑 **The Frozen Abyss** | 21–30 | 1600 × 920 | 5.0× → 8.6× | 2.3× |

Tracks get longer with the tiers too — from a 2,240px stroll on Icy Shores to the
9,180px six-lane crawl of the Black Ice Labyrinth. Beat any battlefield on any
difficulty to unlock the next.

### The 30 battlefields

1. **Icy Shores** ★ — a gentle S-curve to learn on
2. **Glacier Pass** ★ — long switchbacks
3. **Frozen River** ★★ — the trail crosses a river; subs and boats shine
4. **Iceberg Alley** ★★ — two entrances merge mid-map
5. **Penguin Village** ★★★ — the trail wraps around the village
6. **Crystal Caves** ★★★ — a tight serpentine with **no water at all**
7. **Aurora Ridge** ★★★★ — the trail splits around a mountain lake
8. **Shipwreck Bay** ★★★★ — drowned coastline, navy country
9. **Blizzard Peak** ★★★★★ — brutally short path, every shot counts
10. **The Last Colony** ★★★★★ — two independent trails, the final stand

**The Deep Tundra** — 11. Windswept Flats ★ · 12. Hollow Fjord ★ · 13. Twin Cataracts ★★ ·
14. Splintered Shelf ★★★ · 15. The Rookery ★★ · 16. Nightfall Basin ★★★ ·
17. Sable Glacier ★★★★ · 18. Drifting Floes ★★★★ · 19. Stormwall Ridge ★★★★★ ·
20. The Long Dark ★★★★★

**The Frozen Abyss** — 21. Abyssal Approach ★ · 22. Shattered Causeway ★ ·
23. Leviathan Trench ★★ · 24. Obsidian Maze ★★ · 25. Aurora Cathedral ★★★ ·
26. The Maelstrom ★★★ · 27. Riven Icefall ★★★★ · 28. Black Ice Labyrinth ★★★★ ·
29. Throne of Winter ★★★★★ · 30. World's End ★★★★★

### Unlocking

**Each difficulty is its own campaign.** Battlefield 1 is open on all three from the start;
after that you advance one battlefield at a time on the difficulty you're playing, and
clearing an entire tier of ten opens the next tier **on that difficulty**:

```
Easy:    Frostlands 1-10  →  Deep Tundra 11-20  →  Frozen Abyss 21-30
Medium:  Frostlands 1-10  →  Deep Tundra 11-20  →  Frozen Abyss 21-30
Hard:    Frostlands 1-10  →  Deep Tundra 11-20  →  Frozen Abyss 21-30
```

A win counts for every **easier** difficulty too — clear the Frostlands on Hard and the
Deep Tundra opens on Easy and Medium as well, so nobody has to replay a campaign they've
already proven. The level-select tier headers show how far along each difficulty you are,
and locked difficulties on the challenge screen tell you exactly what's still in the way.

### How the star ratings are set

Stars are **measured, not guessed**. A map's real difficulty is the *tower-seconds* it
affords you — how long a sea lion is under fire (track length ÷ speed) multiplied by how
many buildable spots can reach an average point of its route — weighed against how tough
the herd is and how many independent routes you must cover at once.

The counter-intuitive part: a long, tightly-folded serpentine is **generous**, not cruel.
One tower covers several lanes at once and the enemy walks past your guns for a minute and
a half. The genuinely hard maps are the *short* ones (Blizzard Peak, Aurora Ridge, World's
End) and the ones that **split** into routes you cannot defend with the same guns.

### Music

Each battlefield plays a Game Boy-style chiptune loop (a cheery march early on, a darker
theme mid-campaign, a driving track for the finale) — and the tempo climbs **+1% with every
wave**, so wave 50 hits about 1.6× the speed of wave 1. The 🔊 button mutes music and
sound effects together.

### Saving

- The game **autosaves after every wave**.
- The **💾 Save** button saves **mid-wave** — even with sea lions on the field — and the level
  screen shows a **Continue** button to pick up exactly where you left off.
- Progress is stored in your browser (localStorage). *Reset Progress* on the main menu wipes it.
- **💾 Back Up Progress** (main menu) writes everything — pebbles, unlocks, saved games — to one
  file you keep. On iPhone/iPad it opens the share sheet (**Save to Files**; pick an iCloud Drive
  folder and it follows you to your other devices). **📂 Load Backup** restores it anywhere,
  including a different browser or computer.

### Controls

The interface is a bottom command dock built for keyboard + mouse: build palette in the middle
(laid out like your keyboard), selection card on the left, wave controls on the right.

| Input | Action |
|---|---|
| **1–5** / **Q–T** / **A–G** / **Z–B** | Build a Frostline / Navy / Mystic / Support penguin (or click its slot), then click the map. Hold **Shift** to place several |
| Click a placed penguin | Its card appears bottom-left |
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

- **The ground beside the trail is the real resource.** Boulders, cracked ice and glacier
  ridges can't be built on, and there are progressively more of them as the campaign goes
  on — Icy Shores is nearly open, World's End is a maze. Scout where you *can* stand
  before you commit your fish.
- Slush Throwers and Snowball Rollers make everything else hit more often — slow is damage.
- **Aura towers don't stack much.** Each extra source of the same buff counts for half the
  one before it, and every buff has a ceiling (damage ×2, attack speed ×2, range ×1.45).
  One excellent Igloo or War Drummer gets a cluster most of the way there; a wall of them
  adds almost nothing. Build the second one to cover different ground, not more power.
- Build a Fish Vendor or two before wave 10 — but only a couple. Each extra vendor earns
  30% less than the one before it, so a third and fourth barely pay for themselves. Its
  three paths pay three different ways: **Market** is flat reliable income, **Finance**
  pays off your kills, your board and your savings, and **Supply Chain** makes everything
  else on the board cheaper.
- **Stealth detection is a choice now, not a freebie.** Nine penguins used to buy "sees
  stealth" as tier-1 filler; now each class has exactly one cheap answer — Frostline's
  **Keen Eyes** (🐟90, the cheapest upgrade in the game), Navy's **Night Scope** and
  **Thermal Visor**, the Shadow Diver born with it for Mystic, and Support's
  **Watchtower** plus the Sonar Station itself. Skip them all and wave 14 will hurt.
- Have detection online before wave 14, and armor-shred before wave 16.
- Save a Harpoon Sniper with the **Leviathan Lance** upgrade for boss waves.
- Ice Walls placed near the exit catch whatever slips through.

## Files

```
index.html        the game (open this)
style.css         UI styling
js/data.js        towers, upgrades, enemies, 30 levels across 3 tiers
js/waves.js       wave generation (up to 50 waves × 30 levels)
js/engine.js      simulation: combat, targeting, saves
js/render.js      canvas art: maps, penguins, sea lions
js/ui.js          menus, shop, HUD, persistence, sound
js/main.js        boot
serve.js          tiny local web server used by the launchers
```

Built with vanilla JavaScript and HTML5 canvas — no frameworks, no build step.
