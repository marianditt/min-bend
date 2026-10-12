import { describe, expect, it } from 'vitest'
import {
  computeAcceleration,
  computeBendForces,
  computeLengthForce,
  computeReferenceLength,
  computeSegments,
  normalize,
  clampMagnitude,
  length,
} from './forces'
import { CancelledError, previewPose, solve } from './solve'
import { createFrameBuffer } from './frameBuffer'
import { DEFAULT_CONSTANTS, type Frame, type Setup, type Vec2 } from './types'
import { validateSetup } from './validate'

/** Single oriented curve with two fix points. */
const setup1 = (
  n: number,
  start: Vec2,
  end: Vec2,
  startDir: Vec2 | null,
  endDir: Vec2 | null,
  free: Vec2[] = [],
): Setup => ({
  curves: [
    {
      n,
      fixPoints: [
        { pos: start, orientation: startDir },
        { pos: end, orientation: endDir },
      ],
      spans: [free],
    },
  ],
})

const validSetup = setup1(3, [0, 0], [10, 0], [1, 0], [1, 0])

const pts = (frame: Frame): Vec2[] => frame.curves[0]

const zeroVel = (N: number): Vec2[] => Array.from({ length: N }, () => [0, 0])

/** Centered RNG: produces a zero jitter offset so initialization stays straight. */
const plainInit = { random: () => 0.5 }

describe('validateSetup', () => {
  it('accepts a valid setup', () => {
    expect(validateSetup(validSetup)).toEqual([])
  })

  it('rejects a setup with no curves', () => {
    expect(validateSetup({ curves: [] })[0].field).toBe('curves')
  })

  it('rejects negative and non-integer n', () => {
    expect(validateSetup(setup1(-1, [0, 0], [10, 0], [1, 0], [1, 0]))[0].field).toBe('n:0')
    expect(validateSetup(setup1(2.5, [0, 0], [10, 0], [1, 0], [1, 0]))[0].field).toBe('n:0')
  })

  it('accepts n = 0 and n = 1', () => {
    expect(validateSetup(setup1(0, [0, 0], [10, 0], [1, 0], [1, 0]))).toEqual([])
    expect(validateSetup(setup1(1, [0, 0], [10, 0], [1, 0], [1, 0]))).toEqual([])
  })

  it('rejects a curve with fewer than two fix points', () => {
    const setup: Setup = {
      curves: [{ n: 3, fixPoints: [{ pos: [0, 0], orientation: null }], spans: [] }],
    }
    expect(validateSetup(setup)[0].field).toBe('fixPoints:0')
  })

  it('rejects zero orientation vectors', () => {
    expect(validateSetup(setup1(3, [0, 0], [10, 0], [0, 0], [1, 0]))[0].field).toBe('orientation:0:0')
    expect(validateSetup(setup1(3, [0, 0], [10, 0], [1, 0], [0, 0]))[0].field).toBe('orientation:0:1')
  })

  it('accepts coincident start and end', () => {
    expect(validateSetup(setup1(3, [5, 0], [5, 0], [1, 0], [1, 0]))).toEqual([])
  })

  it('allows null orientations', () => {
    expect(validateSetup(setup1(3, [0, 0], [10, 0], null, null))).toEqual([])
  })

  it('rejects non-finite coordinates', () => {
    expect(validateSetup(setup1(3, [NaN, 0], [10, 0], [1, 0], [1, 0])).length).toBeGreaterThan(0)
    expect(validateSetup(setup1(3, [0, 0], [Infinity, 0], [1, 0], [1, 0])).length).toBeGreaterThan(0)
  })
})

describe('initialization (frame 0)', () => {
  it('satisfies orientation constraints exactly and spaces points evenly', () => {
    const setup = setup1(4, [0, 0], [10, 0], [3, 4], [0, -2])
    const d0 = normalize([3, 4])
    const d1 = normalize([0, -2])
    const frame0 = solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit).frames[0]
    const p = pts(frame0)

    const seg0: Vec2 = [p[1][0] - p[0][0], p[1][1] - p[0][1]]
    expect(normalize(seg0)[0]).toBeCloseTo(d0[0], 12)
    expect(normalize(seg0)[1]).toBeCloseTo(d0[1], 12)

    const N = p.length
    const segLast: Vec2 = [p[N - 1][0] - p[N - 2][0], p[N - 1][1] - p[N - 2][1]]
    expect(normalize(segLast)[0]).toBeCloseTo(d1[0], 12)
    expect(normalize(segLast)[1]).toBeCloseTo(d1[1], 12)

    const { lengths } = computeSegments(p)
    const mid = lengths.slice(1, -1)
    for (let i = 1; i < mid.length; i++) {
      expect(mid[i]).toBeCloseTo(mid[0], 12)
    }
  })

  it('starts with zero velocity (zero KE)', () => {
    const result = solve(validSetup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit)
    expect(result.frames[0].ke).toBe(0)
  })
})

describe('forces', () => {
  it('produces ~zero acceleration on a straight, equal-length chain', () => {
    const chain: Vec2[] = [
      [0, 0],
      [3, 0],
      [6, 0],
      [9, 0],
      [12, 0],
    ]
    const N = chain.length
    const accel = computeAcceleration(chain, zeroVel(N), DEFAULT_CONSTANTS)
    for (let k = 1; k < N - 1; k++) {
      expect(accel[k][0]).toBeCloseTo(0, 12)
      expect(accel[k][1]).toBeCloseTo(0, 12)
    }
  })

  it('attracts a point toward its stretched neighbor', () => {
    const chain: Vec2[] = [
      [0, 0],
      [4, 0],
      [6, 0],
    ]
    const { lengths, unitVecs } = computeSegments(chain)
    const L = computeReferenceLength(lengths)
    const f = computeLengthForce(1, lengths, unitVecs, L, 1)
    expect(f[0]).toBeLessThan(0)
    expect(f[1]).toBeCloseTo(0, 12)
  })

  it('bend forces push the middle point toward the chord (reduces bend)', () => {
    const chain: Vec2[] = [
      [0, 0],
      [1, 0.5],
      [2, 0],
    ]
    const { lengths, unitVecs } = computeSegments(chain)
    const dotBefore = unitVecs[0][0] * unitVecs[1][0] + unitVecs[0][1] * unitVecs[1][1]
    expect(dotBefore).toBeCloseTo(0.6, 12)

    const { prev, cur, next } = computeBendForces(1, lengths, unitVecs, 1)
    expect(cur[1]).toBeLessThan(0)
    expect(prev[0]).toBeLessThan(0)
    expect(next[0]).toBeGreaterThan(0)
    expect(prev[0] + cur[0] + next[0]).toBeCloseTo(0, 12)
    expect(prev[1] + cur[1] + next[1]).toBeCloseTo(0, 12)

    const h = 0.001
    const vel = [0, 0] as Vec2
    vel[0] += h * cur[0]
    vel[1] += h * cur[1]
    const moved: Vec2[] = [
      [0, 0],
      [chain[1][0] + h * vel[0], chain[1][1] + h * vel[1]],
      [2, 0],
    ]
    const { unitVecs: movedUnit } = computeSegments(moved)
    const dotAfter = movedUnit[0][0] * movedUnit[1][0] + movedUnit[0][1] * movedUnit[1][1]
    expect(dotAfter).toBeGreaterThan(dotBefore)
  })

  it('skips degenerate segments without producing NaN', () => {
    const chain: Vec2[] = [
      [0, 0],
      [0, 0],
      [2, 0],
    ]
    const { lengths, unitVecs } = computeSegments(chain)
    const L = computeReferenceLength(lengths)
    expect(Number.isNaN(L)).toBe(false)
    const f = computeLengthForce(1, lengths, unitVecs, L, 1)
    const bend = computeBendForces(1, lengths, unitVecs, 1)
    expect([...f, ...bend.prev, ...bend.cur, ...bend.next].every(Number.isFinite)).toBe(true)
  })
})

describe('constraints', () => {
  it('keeps first/last segment orientations fixed across all frames', () => {
    const setup = setup1(3, [0, 0], [10, 0], [0, 1], [0, -1])
    const d0 = normalize([0, 1])
    const d1 = normalize([0, -1])
    const result = solve(setup, { ...DEFAULT_CONSTANTS, epsilon: 1e-12, maxIter: 200 }, plainInit)

    for (const frame of result.frames) {
      const p = pts(frame)
      const s0: Vec2 = [p[1][0] - p[0][0], p[1][1] - p[0][1]]
      const N = p.length
      const sLast: Vec2 = [p[N - 1][0] - p[N - 2][0], p[N - 1][1] - p[N - 2][1]]
      const n0 = normalize(s0)
      const nLast = normalize(sLast)
      expect(n0[0] * d0[0] + n0[1] * d0[1]).toBeCloseTo(1, 10)
      expect(nLast[0] * d1[0] + nLast[1] * d1[1]).toBeCloseTo(1, 10)
    }
  })
})

describe('termination', () => {
  it('stops a static chain via KE threshold after settleFrames', () => {
    const result = solve(validSetup, { ...DEFAULT_CONSTANTS, settleFrames: 10, maxIter: 20000 }, plainInit)
    expect(result.meta.termination).toBe('ke')
    expect(result.frames.length).toBe(11)
  })

  it('respects maxIter when it is reached first', () => {
    const result = solve(validSetup, { ...DEFAULT_CONSTANTS, settleFrames: 1000, maxIter: 5 }, plainInit)
    expect(result.meta.termination).toBe('maxIter')
    expect(result.frames.length).toBe(6)
  })

  it('requires settleFrames consecutive quiet frames', () => {
    const result = solve(validSetup, { ...DEFAULT_CONSTANTS, settleFrames: 1, maxIter: 20000 }, plainInit)
    expect(result.meta.termination).toBe('ke')
    expect(result.frames.length).toBe(2)
  })

  it('relaxes a kinked chain to a finite, stable equilibrium', () => {
    const setup = setup1(6, [0, 0], [10, 0], [0, 1], [0, -1])
    const progress: number[] = []
    const result = solve(setup, DEFAULT_CONSTANTS, {
      onProgress: (p) => progress.push(p),
      ...plainInit,
    })

    expect(result.meta.termination).toBe('ke')
    expect(result.frames.length).toBeGreaterThan(2)
    for (const frame of result.frames) {
      expect(pts(frame).every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true)
      expect(pts(frame).length).toBe(result.meta.N)
    }
    expect(result.frames[result.frames.length - 1].ke).toBeLessThan(DEFAULT_CONSTANTS.epsilon)
    expect(progress[progress.length - 1]).toBe(1)
  })

  it('lays out a non-degenerate loop when anchors coincide', () => {
    const setup = setup1(6, [0, 0], [0, 0], [0, 1], [0, -1])
    const result = solve(setup, { ...DEFAULT_CONSTANTS, epsilon: 1e-12, settleFrames: 1, maxIter: 5 }, plainInit)
    for (const frame of result.frames) {
      expect(pts(frame).every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true)
    }
    const frame0 = result.frames[0]
    const p = pts(frame0)
    const s0: Vec2 = [p[1][0] - p[0][0], p[1][1] - p[0][1]]
    expect(normalize(s0)[0]).toBeCloseTo(0, 12)
    expect(normalize(s0)[1]).toBeCloseTo(1, 12)
    const N = p.length
    const sLast: Vec2 = [p[N - 1][0] - p[N - 2][0], p[N - 1][1] - p[N - 2][1]]
    expect(normalize(sLast)[0]).toBeCloseTo(0, 12)
    expect(normalize(sLast)[1]).toBeCloseTo(-1, 12)
    const xs = p.map((q) => q[0])
    const ys = p.map((q) => q[1])
    expect(Math.max(...xs) - Math.min(...xs) > 1e-6 || Math.max(...ys) - Math.min(...ys) > 1e-6).toBe(true)
    const { lengths } = computeSegments(p)
    for (const len of lengths.slice(1, -1)) {
      expect(len).toBeGreaterThanOrEqual(1e-9)
      expect(Number.isFinite(len)).toBe(true)
    }
  })
})

describe('cancellation', () => {
  it('throws CancelledError when shouldCancel flips', () => {
    let calls = 0
    const setup = setup1(6, [0, 0], [10, 0], [0, 1], [0, -1])
    expect(() =>
      solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 20000 }, {
        shouldCancel: () => ++calls > 10,
        ...plainInit,
      }),
    ).toThrow(CancelledError)
  })
})

describe('randomized initialization', () => {
  const setup = setup1(5, [0, 0], [10, 0], [1, 0], [1, 0])

  it('keeps a straight, equal-length start when the jitter value is centered', () => {
    const frame = solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit).frames[0]
    const { lengths } = computeSegments(pts(frame))
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]).toBeCloseTo(lengths[0], 12)
    }
    expect(pts(frame).every((p) => p[1] === 0)).toBe(true)
  })

  it('perturbs interior points perpendicular to the chord and keeps anchors exact', () => {
    const straight = solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit).frames[0]
    const wiggled = solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, { random: () => 1 }).frames[0]
    const n = 5
    const sp = pts(straight)
    const wp = pts(wiggled)
    expect(wp[0]).toEqual(sp[0])
    expect(wp[1]).toEqual(sp[1])
    expect(wp[n]).toEqual(sp[n])
    expect(wp[n + 1]).toEqual(sp[n + 1])
    for (let k = 2; k < n; k++) {
      expect(wp[k][0]).toBeCloseTo(sp[k][0], 12)
      expect(Math.abs(wp[k][1])).toBeGreaterThan(0)
    }
  })

  it('still satisfies orientation constraints on every frame when randomized', () => {
    const result = solve(
      setup,
      { ...DEFAULT_CONSTANTS, epsilon: 1e-12, maxIter: 200 },
      { random: () => 1 },
    )
    for (const frame of result.frames) {
      const p = pts(frame)
      const s0: Vec2 = [p[1][0] - p[0][0], p[1][1] - p[0][1]]
      const N = p.length
      const sLast: Vec2 = [p[N - 1][0] - p[N - 2][0], p[N - 1][1] - p[N - 2][1]]
      expect(normalize(s0)[1]).toBeCloseTo(0, 10)
      expect(normalize(sLast)[1]).toBeCloseTo(0, 10)
    }
  })
})

describe('force bound', () => {
  it('clampMagnitude keeps direction and caps length', () => {
    const v = clampMagnitude([3, 4], 2)
    expect(length(v)).toBeCloseTo(2, 12)
    expect(v[0]).toBeCloseTo(1.2, 12)
    expect(v[1]).toBeCloseTo(1.6, 12)
  })

  it('returns a vector already within the bound unchanged', () => {
    expect(clampMagnitude([1, 2], 5)).toEqual([1, 2])
  })

  it('computeAcceleration respects constants.maxForce', () => {
    const chain: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]
    const vel = Array.from({ length: 4 }, () => [0, 0]) as Vec2[]
    const accel = computeAcceleration(chain, vel, { ...DEFAULT_CONSTANTS, maxForce: 1 })
    for (let k = 1; k < chain.length - 1; k++) {
      expect(Math.hypot(accel[k][0], accel[k][1])).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('solve stays finite with a tiny bound', () => {
    const setup = setup1(3, [0, 0], [10, 0], [1, 0], [1, 0])
    const result = solve(setup, { ...DEFAULT_CONSTANTS, maxForce: 1, maxIter: 50 }, plainInit)
    for (const frame of result.frames) {
      expect(pts(frame).every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true)
    }
  })
})

describe('frame buffer', () => {
  const buf = (i: number): Frame => ({ i, ke: 0, curves: [] })

  it('keeps every frame when the run stays within the cap', () => {
    const buffer = createFrameBuffer(100000)
    for (let i = 0; i <= 7; i++) buffer.add(buf(i))
    const out = buffer.finish(buf(7))
    expect(out.map((f) => f.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('caps at maxFrames and preserves the first and last frames', () => {
    const maxFrames = 100
    const buffer = createFrameBuffer(maxFrames)
    const total = 5000
    for (let i = 0; i <= total; i++) buffer.add(buf(i))
    const out = buffer.finish(buf(total))
    expect(out.length).toBe(maxFrames)
    expect(out[0].i).toBe(0)
    expect(out[out.length - 1].i).toBe(total)
  })

  it('keeps roughly even spacing after decimation', () => {
    const buffer = createFrameBuffer(64)
    const total = 4000
    for (let i = 0; i <= total; i++) buffer.add(buf(i))
    const out = buffer.finish(buf(total))
    const gaps: number[] = []
    for (let k = 1; k < out.length; k++) gaps.push(out[k].i - out[k - 1].i)
    const min = Math.min(...gaps)
    const max = Math.max(...gaps)
    expect(min).toBeGreaterThan(0)
    expect(max / min).toBeLessThan(4)
  })

  it('appends a final frame that the stride skipped', () => {
    const buffer = createFrameBuffer(4)
    for (let i = 0; i <= 30; i++) buffer.add(buf(i))
    const out = buffer.finish(buf(31))
    expect(out[0].i).toBe(0)
    expect(out[out.length - 1].i).toBe(31)
    expect(out.length).toBeLessThanOrEqual(4)
  })
})

describe('free interior points', () => {
  it('places user points in free slots and keeps bound slots on their rays', () => {
    // n = 5, both ends oriented -> slots 1 and 5 are bound; slots 2..4 are free.
    const free: Vec2[] = [
      [3, 1],
      [5, 0],
      [7, 1],
    ]
    const setup = setup1(5, [0, 0], [10, 0], [1, 0], [1, 0], free)
    const p = pts(solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit).frames[0])

    const o = 10 / 6
    expect(p[0]).toEqual([0, 0])
    expect(p[1][0]).toBeCloseTo(o, 12)
    expect(p[1][1]).toBeCloseTo(0, 12)
    expect(p[5][0]).toBeCloseTo(10 - o, 12)
    expect(p[5][1]).toBeCloseTo(0, 12)
    expect(p[2]).toEqual([3, 1])
    expect(p[3]).toEqual([5, 0])
    expect(p[4]).toEqual([7, 1])
    expect(p[6]).toEqual([10, 0])
  })

  it('fills missing free slots without collapsing them onto a bound point', () => {
    const setup = setup1(5, [0, 0], [10, 0], [1, 0], [1, 0], [[3, 1]])
    const p = pts(solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit).frames[0])

    expect(p[2]).toEqual([3, 1])
    for (const k of [3, 4]) {
      expect(Number.isFinite(p[k][0])).toBe(true)
      expect(Number.isFinite(p[k][1])).toBe(true)
      expect(Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1])).toBeGreaterThan(1e-9)
      expect(Math.hypot(p[k + 1][0] - p[k][0], p[k + 1][1] - p[k][1])).toBeGreaterThan(1e-9)
    }
  })

  it('spreads leftover points across the widest gaps, including gaps between drawn points', () => {
    const setup = setup1(4, [0, 0], [10, 0], null, null, [
      [1, 0],
      [9, 0],
    ])
    const p = pts(solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit).frames[0])

    expect(p.map((q) => q[0])).toEqual([0, 1, 3, 5, 9, 10])
  })

  it('matches the reference chord layout when no free points are provided', () => {
    const setup = setup1(5, [0, 0], [10, 0], [1, 0], [1, 0])
    const p = pts(solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit).frames[0])
    const o = 10 / 6

    expect(p[1]).toEqual([o, 0])
    expect(p[5][0]).toBeCloseTo(10 - o, 12)
    expect(p[5][1]).toBeCloseTo(0, 12)
    expect(p[6]).toEqual([10, 0])
    for (let k = 2; k <= 4; k++) {
      const t = (k - 1) / 4
      expect(p[k][0]).toBeCloseTo(o + t * (10 - o - o), 12)
      expect(p[k][1]).toBeCloseTo(0, 12)
    }
  })
})

describe('n = 0 and n = 1', () => {
  it('lays out a straight, interior-free span for n = 0', () => {
    const setup = setup1(0, [0, 0], [10, 0], [1, 0], [1, 0])
    const result = solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 3 }, plainInit)
    const p = pts(result.frames[0])
    expect(p).toEqual([[0, 0], [10, 0]])
    expect(result.meta.curvePointCounts).toEqual([2])
    expect(result.meta.N).toBe(2)
  })

  it('pins an n = 1 span bound at both ends to the ray intersection', () => {
    // rays [t,0] and [10-0.6s, 10-0.8s] intersect at [2.5, 0]
    const setup = setup1(1, [0, 0], [10, 10], [1, 0], [0.6, 0.8])
    const frame0 = solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit).frames[0]
    const p = pts(frame0)
    expect(p[1][0]).toBeCloseTo(2.5, 12)
    expect(p[1][1]).toBeCloseTo(0, 12)
  })

  it('places an n = 1 single-orientation point on its ray', () => {
    const setup = setup1(1, [0, 0], [10, 0], [0, 1], null)
    const p = pts(solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit).frames[0])
    expect(p[1][0]).toBeCloseTo(0, 12)
    expect(p[1][1]).toBeCloseTo(10 / 2, 12)
  })
})

describe('multiple curves and spans', () => {
  const twoCurves: Setup = {
    curves: [
      { n: 3, fixPoints: [{ pos: [0, 0], orientation: [1, 0] }, { pos: [10, 0], orientation: [1, 0] }], spans: [[]] },
      { n: 4, fixPoints: [{ pos: [0, 5], orientation: null }, { pos: [8, 5], orientation: null }], spans: [[]] },
    ],
  }

  it('reports per-curve point counts and solves each curve independently', () => {
    const result = solve(twoCurves, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit)
    expect(result.meta.curveCount).toBe(2)
    expect(result.meta.curvePointCounts).toEqual([5, 6])
    expect(result.meta.N).toBe(11)
    const frame0 = result.frames[0]
    expect(frame0.curves[0].length).toBe(5)
    expect(frame0.curves[1].length).toBe(6)
    expect(frame0.curves[0][0]).toEqual([0, 0])
    expect(frame0.curves[1][0]).toEqual([0, 5])
  })

  it('reassembles a multi-span curve with shared fix points', () => {
    const setup: Setup = {
      curves: [
        {
          n: 2,
          fixPoints: [
            { pos: [0, 0], orientation: null },
            { pos: [5, 0], orientation: null },
            { pos: [10, 0], orientation: null },
          ],
          spans: [[], []],
        },
      ],
    }
    const result = solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit)
    expect(result.meta.curvePointCounts).toEqual([7])
    const p = pts(result.frames[0])
    expect(p.length).toBe(7)
    expect(p[0]).toEqual([0, 0])
    expect(p[3]).toEqual([5, 0])
    expect(p[6]).toEqual([10, 0])
  })

  it('previewPose returns one polyline per curve, matching frame 0', () => {
    const frame0 = solve(twoCurves, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit).frames[0]
    expect(previewPose(twoCurves)).toEqual(frame0.curves)
  })
})

describe('previewPose', () => {
  it('matches the solved frame-0 pose (deterministic, no jitter)', () => {
    const cases: Setup[] = [
      setup1(5, [0, 0], [10, 0], [1, 0], [1, 0], [[2, 3], [4, 0]]),
      setup1(6, [0, 0], [0, 0], [0, 1], [0, -1]),
      setup1(5, [0, 0], [10, 0], [1, 0], [1, 0]),
    ]
    for (const setup of cases) {
      const frame0 = solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit).frames[0]
      expect(previewPose(setup)).toEqual(frame0.curves)
    }
  })
})
