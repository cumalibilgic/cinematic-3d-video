// Pure helpers for time-based animation. No dependencies, so they can be unit-tested in Node.
//
// Rule of thumb: every animated value in a scene is a pure function of time t (seconds).
// That is what makes frame-by-frame rendering deterministic.

export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const lerp = (a, b, t) => a + (b - a) * t;

/** Easing functions: take progress 0..1, return eased progress 0..1 (outBack/outElastic overshoot on purpose). */
export const ease = {
  linear: (t) => t,
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inCubic: (t) => t * t * t,
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutExpo: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
  outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  outElastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
};

/**
 * Eased progress of a segment: 0 before `start`, 1 after `start + dur`, eased in between.
 *   scale.setScalar(seg(t, 0.5, 1.2, ease.outBack))   // pops in between 0.5s and 1.7s
 */
export const seg = (t, start, dur, fn = ease.inOutCubic) => fn(clamp01((t - start) / dur));

/**
 * Value at time t from keyframes [[time, value], ...] (times ascending), eased between neighbours.
 * `value` is a number or an array of numbers (e.g. a position [x, y, z]); arrays return a new array.
 * Holds the first/last value outside the range.
 */
export function keys(frames, t, fn = ease.inOutCubic) {
  if (t <= frames[0][0]) return frames[0][1];
  const last = frames[frames.length - 1];
  if (t >= last[0]) return last[1];
  let i = 0;
  while (i < frames.length - 2 && t > frames[i + 1][0]) i++;
  const [t0, v0] = frames[i], [t1, v1] = frames[i + 1];
  const k = fn((t - t0) / (t1 - t0));
  return Array.isArray(v0) ? v0.map((a, j) => lerp(a, v1[j], k)) : lerp(v0, v1, k);
}

/** Seeded random generator (mulberry32): same seed, same sequence, on every machine. Never use Math.random() in a scene. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
