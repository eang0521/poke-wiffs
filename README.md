# poke-wiffs

Simulation core for a Pokémon wiffle ball game. It has no dependencies: plain ES modules that run in Node and the browser.

```
npm test          # geometry + physics checks
npm run report    # field layout, pitch movement table, batted-ball outcomes (add "-- L" for lefties)
npm run serve     # http://localhost:5173/viewer/game.html (game) and /viewer/ (physics lab)
node tools/season.mjs 100   # sim 100 CPU games between random teams and print league rates
node tools/build-pokedex.mjs # refresh src/data/pokedex.js from pokemondb.net
```

## Layout

| File | What it does |
|---|---|
| `src/physics/ball.js` | Wiffle aero model: drag, slot (hole) asymmetry force, Magnus lift, low-spin wake buffet. **All tunable constants live here.** |
| `src/physics/flight.js` | RK4 integrator. Slots rotate with the spin vector and spin decays, so pitch shapes emerge from the physics. |
| `src/field/field.js` | Field geometry from feet/inches config: bases, zone, mound, foul lines, fence polyline, fair/foul, fence crossings. |
| `src/pitching/pitches.js` | Pitch catalog (RHP frame; LHP mirrored automatically). |
| `src/pitching/pitching.js` | Aim solver (Newton on launch angles), execution error, strike/ball, movement measurement. |
| `src/batting/bat.js` | Yellow-bat properties (mass, taper, sweet spot, COR, friction), swing types, default batter. |
| `src/batting/swing.js` | Swing kinematics → geometric contact against the real pitch path → impulse collision (effective bat mass, COR, friction spin) → batted ball. |
| `src/stats/stats.js` | Pokémon stats → wiffle stats. One data table each for batters and pitchers. |
| `src/batting/battedBall.js` | Batted-ball flight → home run / off the wall / fair / foul, with bounces and rolling. |
| `src/data/pokedex.js` | All 1,025 species (default forms): name, types, base stats; HOME sprite URLs (hotlinked from pokemondb.net). |
| `src/game/roster.js` | Players (stats → batter/pitcher/fielder profiles, 4-pitch arsenal by type + stats, handedness) and 6-Pokémon teams. |
| `src/game/fielding.js` | Batted ball → play: catches/dives, ground balls, wiffle-slow throws, runner decisions, force/tag plays, DPs, tag-ups, errors. |
| `src/game/ai.js` | CPU pitch selection by count; CPU batter reads (Eye), swing decisions and input errors. |
| `src/game/game.js` | Game engine: counts, outs, innings, walk-offs, pitching changes, fatigue, box score, play-by-play. |
| `viewer/game.html` | The game: team builder, scoreboard, sprites on the field, animated plays, human batting and pitching. |
| `viewer/index.html` | Physics lab: catcher view, side view, top-down field, live at-bats. |

Units are SI internally; use the helpers in `src/units.js` at the edges.

## Field conventions

Origin is the point of home plate. +y points to center field, +x to the 1st-base side, and +z is up.
The foul lines start at the base of the strike-zone frame (4 ft behind home) and open 75° in total.
That puts 1st/3rd at 45 ft from home and 2nd at 61.4 ft. The default fence is five straight panels 100 ft from home, 4 ft tall. Fences are configurable per field via
`createField({ fence: { vertices: [[x,y],...], heightsFt: [...] } })`.

## Swinging

```js
const pitch = throwPitch({ pitch: 'slider', field });
const ideal = idealContact(pitch);            // when/where the ball crosses the contact plane
const r = swingAtPitch({
  pitch, field,
  timing: ideal.t + 0.005,                    // bat square 5 ms late
  aimFt: { x: 0, z: 2.4 },                    // sweet spot position at square
  type: 'power',                              // contact | normal | power
  batter: { hand: 'L', batSpeedMph: 62 },
});
// r.contact, r.exitVeloMph, r.launchAngleDeg, r.sprayAngleDeg, r.backspinRpm, r.batted.outcome …
```

Contact is unforgiving, like real wiffle: the bat barrel is only about 1.3" thick, so 1" of height error
swings the launch angle about 30°. Any "contact skill" help belongs in the game layer, on top of this physics.

## Pokémon stats

Each of the six stats feeds exactly one batting attribute and one pitching attribute. A base stat of 30 maps
to the worst end of the range and 150 to the best, with a soft cap beyond that.

| Stat | Batter | Pitcher |
|---|---|---|
| HP | Stamina: bat and foot speed fade with swings and baserunning | Stamina (pitches before fatigue: 25 → 90) |
| Attack | Bat speed (40 → 66 mph) | Velocity (×0.85 → ×1.12) |
| Defense | Fielding: reaction, sure hands, arm | Fielding: reaction, sure hands, arm |
| Sp. Atk | Contact: shrinks aim error up to 60% and timing error up to 40% | Movement: spin ×0.7 → ×1.25, ball scuff ×0.8 → ×1.25, spin-axis consistency |
| Sp. Def | Eye: how well CPU batters read location and timing | Command (location error ×1.8 → ×0.6) |
| Speed | Swing quickness (190 → 120 ms) and foot speed (19 → 31 ft/s) | Extension (2 → 4.5 ft, less reaction time) |

```js
const pitcher = pitcherFromStats(SAMPLE_POKEMON.gengar.stats, { hand: 'L', name: 'Gengar' });
const batter  = batterFromStats(SAMPLE_POKEMON.machamp.stats, { hand: 'R', name: 'Machamp' });
const pitch = throwPitch({ pitch: 'slideDrop', field, pitcher, pitchCount: 34 });
const swing = swingAtPitch({ pitch, field, batter, timing, aimFt });
```

## Game rules (defaults, see `DEFAULT_RULES`)

Six innings, extra innings until someone leads (a tie after 15). 4 balls is a walk, 3 strikes is a strikeout. With no catcher
behind the frame, a foul tip is just a foul. There's no stealing or leading off. Teams are 6 Pokémon: a pitcher, 1B, middle infield, 3B, LF and RF.
The CPU changes pitchers once the starter is 12 pitches past their stamina.
