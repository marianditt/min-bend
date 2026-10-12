import type { Setup } from '../solver/types'

/**
 * Default setup: a single curve with two oriented coincident fix points.
 * This reproduces the original single-chain problem exactly (n = 6, start and
 * end at the origin, start tangent +y, end tangent -y).
 */
export const DEFAULT_SETUP: Setup = {
  curves: [
    {
      n: 6,
      fixPoints: [
        { pos: [0, 0], orientation: [0, 1] },
        { pos: [0, 0], orientation: [0, -1] },
      ],
      spans: [[]],
    },
  ],
}
