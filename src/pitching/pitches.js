// Pitch catalog. Every pitch is written for a RIGHT-handed pitcher. Lefties
// are mirrored automatically, with spin handled correctly as an axial vector.
//
// Directions are given in the pitcher's release frame [glove, up, forward]:
//   glove   = pitcher's glove side (pitcher's left for a RHP)
//   up      = vertical, perpendicular to the throw
//   forward = direction of the throw (slots facing "forward" = into the wind)
//
// holes:     where the slotted hemisphere faces at release ('random' = random each throw)
// spin.axis: angular-velocity direction in the same frame (right-hand rule)
//            [-1,0,0] = pure backspin (rises), [1,0,0] = pure topspin (drops)
//            [0,1,0]  = spins on a vertical axis, Magnus toward the glove side
// release:   side = ft toward the arm side of center, height = ft above ground,
//            extension = ft in front of the mound line
// command:   1-sigma location error at the plate (inches) when executed
//
// What makes a Wiffle pitch move:
//   - Spin about the slot axis keeps the slots facing one way, so the slot
//     force pushes steadily toward them (curve/slider/screwball style).
//   - Spin about any other axis makes the slots tumble; Magnus lift then sets
//     the shape (riser, drop, fastball carry).
//   - Almost no spin gives a slowly drifting slot force plus wake buffet: a knuckleball.

export const PITCHES = Object.freeze({
  fastball: {
    name: 'Fastball',
    speedMph: 72,
    release: { side: 1.8, height: 5.6, extension: 3 },
    holes: [0, 0.25, 1],
    spin: { rpm: 1100, axis: [-1, 0, 0] },
    command: 5.6,
    blurb: 'Hard backspin with the slots tumbling. Straight, with less drop than gravity alone.',
  },
  changeup: {
    name: 'Changeup',
    speedMph: 56,
    release: { side: 1.8, height: 5.6, extension: 3 },
    holes: [0, 0.25, 1],
    spin: { rpm: 700, axis: [-1, 0, 0] },
    command: 7.0,
    blurb: 'Fastball arm action, much slower. Drops under the fastball.',
  },
  riser: {
    name: 'Riser',
    speedMph: 66,
    release: { side: 2.6, height: 1.6, extension: 3.5 },
    holes: [0, 1, 0],
    spin: { rpm: 1900, axis: [-1, 0, 0] },
    command: 8.4,
    blurb: 'Submarine release with heavy backspin. Climbs on the hitter.',
  },
  drop: {
    name: 'Drop',
    speedMph: 60,
    release: { side: 1.2, height: 6.2, extension: 3 },
    holes: [0, -1, 0],
    spin: { rpm: 1700, axis: [1, 0, 0] },
    command: 7.0,
    blurb: 'Over-the-top topspin. 12-to-6 dive.',
  },
  curveball: {
    name: 'Curveball',
    speedMph: 57,
    release: { side: 1.8, height: 5.8, extension: 3 },
    holes: [1, 0, 0],
    spin: { rpm: 1400, axis: [1, 0, 0] },
    command: 8.4,
    blurb: 'Slots on the glove side, spinning about the slot axis. Big sweeping break plus drop.',
  },
  slider: {
    name: 'Slider',
    speedMph: 63,
    release: { side: 2.4, height: 4.6, extension: 3 },
    holes: [1, 0, 0],
    spin: { rpm: 500, axis: [1, 0, 0] },
    command: 7.0,
    blurb: 'Slots on the glove side, low spin. Late, flat break to the glove side.',
  },
  slideDrop: {
    name: 'Slide Drop',
    speedMph: 60,
    release: { side: 2.0, height: 5.4, extension: 3 },
    holes: [0.71, -0.71, 0],
    spin: { rpm: 1300, axis: [1, 0, 0] },
    command: 8.4,
    blurb: 'Slots down and to the glove side, with topspin. The glove-side part of the slot force stays steady while topspin pulls it down: a diagonal break.',
  },
  sinker: {
    name: 'Sinker',
    speedMph: 66,
    release: { side: 2.2, height: 4.8, extension: 3 },
    holes: [-0.6, -0.8, 0],
    spin: { rpm: 900, axis: [1, 0, 0] },
    command: 7.0,
    blurb: 'Slots down and to the arm side, with topspin. Runs to the arm side and sinks.',
  },
  screwball: {
    name: 'Screwball',
    speedMph: 59,
    release: { side: 2.0, height: 5.2, extension: 3 },
    holes: [-1, 0, 0],
    spin: { rpm: 800, axis: [1, 0, 0] },
    command: 8.4,
    blurb: 'Slots on the arm side. Breaks the "wrong" way, away from opposite-handed hitters.',
  },
  knuckleball: {
    name: 'Knuckleball',
    speedMph: 52,
    release: { side: 1.6, height: 5.4, extension: 3 },
    holes: 'random',
    spin: { rpm: 40, axis: 'random' },
    command: 14.0,
    blurb: 'Almost no spin. The slot force drifts as the ball turns and the wake buffets it. Flutters unpredictably.',
  },
});

export const PITCH_TYPES = Object.keys(PITCHES);
