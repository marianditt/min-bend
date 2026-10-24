import { DEFAULT_RESOLUTION, type Setup } from '../solver/types'

/**
 * Default setup: a single curve running left to right between two fixed
 * positions, with free directions.
 */
export const DEFAULT_SETUP: Setup = {
  curves: [
    {
      fixPoints: [
        { id: 'p1', pos: [0, 0], orientation: null },
        { id: 'p2', pos: [4, 0], orientation: null },
      ],
      spans: [[]],
    },
  ],
  resolution: DEFAULT_RESOLUTION,
}
