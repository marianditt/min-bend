import { describe, expect, it } from 'vitest'
import {
  computeAcceleration,
  computeBendForces,
  computeSegments,
  dot,
  normalize,
  type ChainModel,
} from './forces'
import { CancelledError, previewPose, solve } from './solve'
import { createFrameBuffer } from './frameBuffer'
import { planCurve } from './curve'
import { DEFAULT_CONSTANTS, SETTLE_STEPS, type Curve, type FixPoint, type Frame, type Setup, type Vec2 } from './types'
import { validateSetup } from './validate'
import { MAX_RUNNING_PROGRESS, ProgressTracker } from './progress'

let nextId = 0
const fp = (pos: Vec2, orientation: Vec2 | null = null, posFree = false): FixPoint => {
  const id = `t${++nextId}`
  return posFree ? { id, pos, orientation, posFree } : { id, pos, orientation }
}

/** Single curve through the given control points. */
const chain = (points: FixPoint[], resolution = 1, extra: Partial<Curve> = {}): Setup => ({
  resolution,
  curves: [{ fixPoints: points, spans: points.slice(1).map((): Vec2[] => []), ...extra }],
})

const two = (start: Vec2, end: Vec2, d0: Vec2 | null, d1: Vec2 | null, resolution = 1): Setup =>
  chain([fp(start, d0), fp(end, d1)], resolution)

const fast = { ...DEFAULT_CONSTANTS, maxSteps: 20000 }
const last = (setup: Setup, constants = fast): Vec2[] =>
  solve(setup, constants).frames.at(-1)!.curves[0]

const segLens = (p: Vec2[]): number[] => computeSegments(p).lengths
const turn = (p: Vec2[], k: number): number => {
  const { unitVecs } = computeSegments(p)
  return dot(unitVecs[k - 1], unitVecs[k])
}

describe('validateSetup', () => {
  const valid = two([0, 0], [10, 0], [1, 0], [1, 0])

  it('accepts a valid setup', () => {
    expect(validateSetup(valid)).toEqual([])
  })

  it('rejects a setup with no curves', () => {
    expect(validateSetup({ curves: [], resolution: 1 })[0].field).toBe('curves')
  })

  it('rejects non-positive and non-finite resolution', () => {
    for (const r of [0, -1, NaN, Infinity]) {
      expect(validateSetup({ ...valid, resolution: r }).map((i) => i.field)).toContain('resolution')
    }
  })

  it('rejects a resolution that would create an absurd number of lines', () => {
    expect(validateSetup({ ...valid, resolution: 1e-6 }).map((i) => i.field)).toContain('resolution')
  })

  it('rejects a curve with fewer than two fix points', () => {
    expect(validateSetup(chain([fp([0, 0])]))[0].field).toBe('fixPoints:0')
  })

  it('rejects zero orientation vectors', () => {
    expect(validateSetup(two([0, 0], [10, 0], [0, 0], null))[0].field).toBe('orientation:0:0')
  })

  it('accepts coincident start and end and null orientations', () => {
    expect(validateSetup(two([1, 1], [1, 1], [0, 1], [0, -1]))).toEqual([])
    expect(validateSetup(two([0, 0], [4, 0], null, null))).toEqual([])
  })

  it('rejects non-finite coordinates', () => {
    expect(validateSetup(two([NaN, 0], [10, 0], null, null))[0].field).toBe('fixPoint:0:0')
  })

  it('validates target length', () => {
    expect(validateSetup(chain([fp([0, 0]), fp([4, 0])], 1, { targetLength: 5 }))).toEqual([])
    expect(validateSetup(chain([fp([0, 0]), fp([4, 0])], 1, { targetLength: null }))).toEqual([])
    for (const bad of [0, -1, NaN, Infinity]) {
      const issues = validateSetup(chain([fp([0, 0]), fp([4, 0])], 1, { targetLength: bad }))
      expect(issues[0].field).toBe('targetLength:0')
    }
  })
})

describe('discretization by resolution', () => {
  it('starts with one point per resolution unit, spaced evenly', () => {
    const [p] = previewPose(two([0, 0], [4.5, 0], null, null, 1))
    expect(p).toHaveLength(6)
    const lens = segLens(p)
    expect(lens.every((l) => Math.abs(l - 0.9) < 1e-9)).toBe(true)
  })

  it('has a variable number of lines when the resolution changes', () => {
    expect(previewPose(two([0, 0], [6, 0], null, null, 1))[0]).toHaveLength(7)
    expect(previewPose(two([0, 0], [6, 0], null, null, 2))[0]).toHaveLength(4)
  })

  it('shares the resolution across curves', () => {
    const setup: Setup = {
      resolution: 2,
      curves: [
        { fixPoints: [fp([0, 0]), fp([8, 0])], spans: [[]] },
        { fixPoints: [fp([0, 5]), fp([4, 5])], spans: [[]] },
      ],
    }
    const [a, b] = previewPose(setup)
    expect(segLens(a).every((l) => Math.abs(l - 2) < 1e-9)).toBe(true)
    expect(segLens(b).every((l) => l <= 2 + 1e-9)).toBe(true)
  })

  it('keeps at least three lines in a short span', () => {
    expect(previewPose(two([0, 0], [0.5, 0], null, null, 5))[0]).toHaveLength(4)
  })

  it('shares fix points between spans and reports control indices', () => {
    const setup = chain([fp([0, 0]), fp([3, 0]), fp([3, 4])], 1)
    const result = solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 5 })
    expect(result.frames[0].controlIndices).toEqual([[0, 3, 7]])
    expect(result.frames[0].curves[0]).toHaveLength(8)
    expect(planCurve(setup.curves[0], 1).segmentCount).toBe(7)
  })

  it('uses guide points as the initial layout', () => {
    const setup = two([0, 0], [4, 0], null, null)
    setup.curves[0].spans = [[[2, 3]]]
    const [p] = previewPose(setup)
    expect(Math.max(...p.map((q) => q[1]))).toBeGreaterThan(1)
  })
})

describe('initialization (frame 0)', () => {
  it('satisfies orientation constraints exactly and starts at rest', () => {
    const setup = two([0, 0], [10, 0], [0, 1], [0, -1])
    const result = solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 1 })
    const p = result.frames[0].curves[0]
    expect(p[0]).toEqual([0, 0])
    expect(p.at(-1)).toEqual([10, 0])
    expect(p[1][0]).toBeCloseTo(0, 12)
    expect(p[1][1]).toBeGreaterThan(0)
    expect(p.at(-2)![0]).toBeCloseTo(10, 12)
    expect(p.at(-2)![1]).toBeGreaterThan(0)
    expect(result.frames[0].ke).toBe(0)
  })
})

describe('forces', () => {
  const model = (n: number, targetLength: number | null = null): ChainModel => ({
    movable: Array.from({ length: n }, (_, i) => i > 0 && i < n - 1),
    targetLength,
    constraints: [],
  })

  it('produces ~zero acceleration on a straight chain', () => {
    const pts: Vec2[] = [[0, 0], [3, 0], [6, 0], [9, 0], [12, 0]]
    const accel = computeAcceleration(pts, model(5))
    for (const a of accel) {
      expect(a[0]).toBeCloseTo(0, 12)
      expect(a[1]).toBeCloseTo(0, 12)
    }
  })

  it('does not equalize segment lengths on its own', () => {
    const pts: Vec2[] = [[0, 0], [4, 0], [6, 0]]
    const accel = computeAcceleration(pts, model(3))
    expect(accel[1][0]).toBeCloseTo(0, 12)
    expect(accel[1][1]).toBeCloseTo(0, 12)
  })

  it('pulls a too-long chain together uniformly and leaves pinned points alone', () => {
    const pts: Vec2[] = [[0, 0], [4, 0], [6, 0]]
    const accel = computeAcceleration(pts, { ...model(3, 2), bendStiffness: 0 })
    expect(accel[1][0]).toBeCloseTo(0, 12) // equal tension on both sides cancels on a straight line
    expect(accel[0]).toEqual([0, 0])
    expect(accel[2]).toEqual([0, 0])
  })

  it('bend forces push the middle point toward the chord and sum to zero', () => {
    const pts: Vec2[] = [[0, 0], [1, 0.5], [2, 0]]
    const { lengths, unitVecs } = computeSegments(pts)
    const { prev, cur, next } = computeBendForces(1, lengths, unitVecs, 1)
    expect(cur[1]).toBeLessThan(0)
    expect(prev[0] + cur[0] + next[0]).toBeCloseTo(0, 12)
    expect(prev[1] + cur[1] + next[1]).toBeCloseTo(0, 12)
  })

  it('skips degenerate segments without producing NaN', () => {
    const pts: Vec2[] = [[0, 0], [0, 0], [2, 0]]
    const accel = computeAcceleration(pts, model(3))
    expect(accel.flat().every(Number.isFinite)).toBe(true)
  })
})

describe('control point kinds', () => {
  it('fixed position + fixed orientation: stays put on its tangent line', () => {
    const setup = chain([fp([0, 0], [0, 1]), fp([4, 2], [1, 0]), fp([8, 0], [0, -1])], 1)
    const result = solve(setup, fast)
    const ci = result.frames.at(-1)!.controlIndices[0][1]
    for (const frame of result.frames) {
      const p = frame.curves[0]
      expect(p[ci]).toEqual([4, 2])
      expect(p[ci - 1][1]).toBeCloseTo(2, 9)
      expect(p[ci + 1][1]).toBeCloseTo(2, 9)
      expect(p[ci - 1][0]).toBeLessThanOrEqual(4)
      expect(p[ci + 1][0]).toBeGreaterThanOrEqual(4)
      expect(p[1][0]).toBeCloseTo(0, 9)
    }
  })

  it('fixed position + free orientation: incoming and outgoing directions are equal', () => {
    const setup = chain([fp([0, 0], [0, 1]), fp([4, 2]), fp([8, 0], [0, -1])], 1)
    const result = solve(setup, fast)
    const ci = result.frames.at(-1)!.controlIndices[0][1]
    for (const frame of result.frames) {
      const p = frame.curves[0]
      expect(p[ci]).toEqual([4, 2])
      expect(turn(p, ci)).toBeCloseTo(1, 6)
    }
  })

  it('fixed position + free orientation: the optimizer chooses a non-trivial tangent', () => {
    const setup = chain([fp([0, 0], [0, 1]), fp([4, 2]), fp([8, 0], [0, -1])], 1)
    const p = last(setup)
    const ci = planCurve(setup.curves[0], 1).controlIndices[1]
    const t = normalize([p[ci + 1][0] - p[ci - 1][0], p[ci + 1][1] - p[ci - 1][1]])
    expect(Math.abs(t[0])).toBeGreaterThan(0.5)
  })

  it('free orientation at the curve ends leaves the end tangent unconstrained', () => {
    const setup = two([0, 0], [4, 3], null, null)
    const p = last(setup)
    const t = normalize([p[1][0] - p[0][0], p[1][1] - p[0][1]])
    expect(t[0]).toBeCloseTo(0.8, 2)
    expect(t[1]).toBeCloseTo(0.6, 2)
  })

  it('free position + fixed orientation: moves to reduce bend while keeping its tangent', () => {
    const setup = chain([fp([0, 0], [1, 0]), fp([4, 3], [1, 0], true), fp([8, 0], [1, 0])], 1)
    const result = solve(setup, fast)
    const ci = result.frames.at(-1)!.controlIndices[0][1]
    const first = result.frames[0].curves[0]
    const final = result.frames.at(-1)!.curves[0]
    expect(first[result.frames[0].controlIndices[0][1]]).toEqual([4, 3])
    expect(final[ci][0]).toBeGreaterThan(2)
    expect(final[ci][0]).toBeLessThan(6)
    expect(Math.abs(final[ci][1])).toBeLessThan(5)
    expect(final[ci - 1][1]).toBeCloseTo(final[ci][1], 6)
    expect(final[ci + 1][1]).toBeCloseTo(final[ci][1], 6)
    expect(final[0]).toEqual([0, 0])
    expect(final.at(-1)).toEqual([8, 0])
  })

  it('free position + free orientation behaves like an interior point', () => {
    const setup = chain([fp([0, 0]), fp([4, 3], null, true), fp([8, 0])], 1)
    const p = last(setup)
    const ci = planCurve(setup.curves[0], 1).controlIndices[1]
    expect(p[ci][1]).toBeLessThan(2.9)
  })

  it('keeps first/last orientations fixed across all frames', () => {
    const result = solve(two([0, 0], [10, 0], [0, 1], [0, -1]), fast)
    for (const frame of result.frames) {
      const p = frame.curves[0]
      expect(p[1][0]).toBeCloseTo(0, 9)
      expect(p[1][1]).toBeGreaterThanOrEqual(0)
      expect(p.at(-2)![0]).toBeCloseTo(10, 9)
    }
  })
})

describe('termination', () => {
  it('stops a static chain via the rest threshold after SETTLE_STEPS', () => {
    const result = solve(two([0, 0], [4, 0], null, null), DEFAULT_CONSTANTS)
    expect(result.meta.termination).toBe('rest')
    expect(result.meta.iterations).toBe(SETTLE_STEPS)
  })

  it('respects maxSteps when it is reached first', () => {
    const result = solve(two([0, 0], [10, 0], [0, 1], [0, -1]), { ...DEFAULT_CONSTANTS, maxSteps: 5 })
    expect(result.meta.termination).toBe('maxSteps')
    expect(result.meta.iterations).toBe(5)
  })

  it('relaxes a kinked chain to a finite, stable equilibrium without a force cap', () => {
    const result = solve(two([0, 0], [10, 0], [0, 1], [0, -1]), fast)
    expect(result.frames.every((f) => f.curves[0].flat().every(Number.isFinite))).toBe(true)
  })

  it('lays out a loop when anchors coincide and never ends with more energy than it started with', () => {
    const result = solve(two([0, 0], [0, 0], [0, 1], [0, -1]), fast)
    const p = result.frames[0].curves[0]
    expect(p.flat().every(Number.isFinite)).toBe(true)
    expect(Math.max(...p.map((q) => Math.hypot(q[0], q[1])))).toBeGreaterThan(0.5)
    expect(Math.min(...segLens(p))).toBeGreaterThan(0.1)
    const end = result.frames.at(-1)!
    expect(end.curves[0].flat().every(Number.isFinite)).toBe(true)
    expect(end.energy!).toBeLessThan(result.frames[0].energy!)
  })
})

describe('cancellation', () => {
  it('throws CancelledError when shouldCancel flips', () => {
    let calls = 0
    expect(() =>
      solve(two([0, 0], [10, 0], [0, 1], [0, -1]), { ...DEFAULT_CONSTANTS, maxSteps: 20000 }, {
        shouldCancel: () => ++calls > 10,
      }),
    ).toThrow(CancelledError)
  })
})

describe('deterministic start', () => {
  const setup = two([0, 0], [10, 0], [1, 0], [1, 0])

  it('starts motionless and identically on every run, with only potential energy', () => {
    const a = solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 5 })
    const b = solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 5 })
    expect(a.frames[0].ke).toBe(0)
    expect(a.frames[0].curves).toEqual(b.frames[0].curves)
    expect(a.frames.at(-1)!.curves).toEqual(b.frames.at(-1)!.curves)
  })

  it('satisfies orientation constraints on every frame', () => {
    const result = solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 300 })
    for (const frame of result.frames) {
      expect(frame.curves[0][1][1]).toBeCloseTo(0, 9)
      expect(frame.curves[0].at(-2)![1]).toBeCloseTo(0, 9)
    }
  })

  it('tracks length and bend energy separately and they add up with the kinetic energy', () => {
    const bent = chain([fp([0, 0], [1, 0]), fp([10, 0], [1, 0])], 1, { targetLength: 14 })
    bent.curves[0].spans = [[[5, 6]]]
    const f = solve(bent, { ...DEFAULT_CONSTANTS, maxSteps: 50 }).frames[0]
    expect(f.lengthEnergy!).toBeGreaterThan(0)
    expect(f.bendEnergy!).toBeGreaterThan(0)
    expect(f.energy!).toBeCloseTo(f.lengthEnergy! + f.bendEnergy! + f.ke, 9)
  })
})

describe('frame buffer', () => {
  const buf = (i: number): Frame => ({ i, ke: 0, curves: [], controlIndices: [] })

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

describe('multiple curves', () => {
  it('reports per-curve point counts and solves each curve independently', () => {
    const setup: Setup = {
      resolution: 1,
      curves: [
        { fixPoints: [fp([0, 0]), fp([3, 0])], spans: [[]] },
        { fixPoints: [fp([0, 5]), fp([6, 5])], spans: [[]] },
      ],
    }
    const result = solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 5 })
    expect(result.meta.curveCount).toBe(2)
    expect(result.frames[0].curves.map((c) => c.length)).toEqual([4, 7])
    expect(result.meta.maxPoints).toBe(11)
  })

  it('previewPose matches the solved frame 0', () => {
    const setup = chain([fp([0, 0], [0, 1]), fp([4, 2]), fp([8, 0], [0, -1])], 1)
    const result = solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 1 })
    expect(previewPose(setup)).toEqual(result.frames[0].curves)
  })
})

describe('target path length', () => {
  it('drives the curve toward the target total length', () => {
    const setup = chain([fp([0, 0], [0, 1]), fp([0, 0], [0, -1])], 1, { targetLength: 12 })
    const p = last(setup, { ...fast, maxSteps: 40000 })
    const total = segLens(p).reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(10)
    expect(total).toBeLessThan(13)
  })

  it('produces identical frames when targetLength is null vs absent', () => {
    const a = solve(chain([fp([0, 0]), fp([4, 0])], 1, { targetLength: null }), { ...DEFAULT_CONSTANTS, maxSteps: 20 })
    const b = solve(chain([fp([0, 0]), fp([4, 0])], 1), { ...DEFAULT_CONSTANTS, maxSteps: 20 })
    expect(a.frames).toEqual(b.frames)
  })
})

describe('progress tracking', () => {
  it('exposes a running cap just below completion', () => {
    expect(MAX_RUNNING_PROGRESS).toBeGreaterThan(0.9)
    expect(MAX_RUNNING_PROGRESS).toBeLessThan(1)
  })

  it('starts at zero and uses frame progress when energy is flat', () => {
    const tracker = new ProgressTracker(0.001)
    expect(tracker.progress(0, 100)).toBe(0)
    tracker.observe(5)
    expect(tracker.progress(25, 100)).toBeCloseTo(0.25, 12)
  })

  it('rises as the envelope falls from a peak, then jumps on a new peak', () => {
    const tracker = new ProgressTracker(0.5)
    tracker.observe(2)
    expect(tracker.progress(0, 100)).toBe(0)
    tracker.observe(0)
    expect(tracker.progress(0, 100)).toBeCloseTo(0.5, 12)
    tracker.observe(4)
    expect(tracker.progress(0, 100)).toBe(0)
  })

  it('never reports 100% while the run is still going', () => {
    const tracker = new ProgressTracker(1)
    tracker.observe(1)
    for (let k = 0; k < 50; k++) tracker.observe(0)
    expect(tracker.progress(0, 1)).toBe(MAX_RUNNING_PROGRESS)
    expect(tracker.progress(1_000_000, 1)).toBe(MAX_RUNNING_PROGRESS)
  })

  it('is monotonic and only reaches 1.0 in the final sample', () => {
    const setup = two([0, 0], [0, 0], [0, 1], [0, -1])
    const samples: { progress: number; iteration: number }[] = []
    const result = solve(setup, DEFAULT_CONSTANTS, {
      onProgress: (progress, iteration) => samples.push({ progress, iteration }),
    })

    expect(result.meta.termination).toBe('rest')
    expect(samples.length).toBeGreaterThan(1)

    const last = samples[samples.length - 1]
    expect(last.progress).toBe(1)
    expect(last.iteration).toBe(result.meta.iterations)

    for (const sample of samples.slice(0, -1)) {
      expect(sample.progress).toBeLessThan(1)
      expect(sample.progress).toBeLessThanOrEqual(MAX_RUNNING_PROGRESS + 1e-9)
    }
    for (let k = 1; k < samples.length; k++) {
      expect(samples[k].progress).toBeGreaterThanOrEqual(samples[k - 1].progress)
    }
  })
})

import { resolveSetup } from './constraints'

describe('point constraints', () => {
  const base = (): Setup => ({
    resolution: 1,
    curves: [
      { fixPoints: [fp([0, 0], [1, 0]), fp([4, 0], [0, 1])], spans: [[]] },
      { fixPoints: [fp([9, 9], null, true), fp([8, 3])], spans: [[]] },
    ],
  })
  const id = (s: Setup, curve: number, point: number) => s.curves[curve].fixPoints[point].id

  it('copies fixed position and orientation to the target', () => {
    const s = base()
    s.constraints = [
      { kind: 'position', source: id(s, 0, 1), target: id(s, 1, 0) },
      { kind: 'orientation', source: id(s, 0, 1), target: id(s, 1, 0) },
    ]
    const r = resolveSetup(s).setup.curves[1].fixPoints[0]
    expect(r.pos).toEqual([4, 0])
    expect(r.posFree).toBeUndefined()
    expect(r.orientation).toEqual([0, 1])
  })

  it('applies a position offset and an angle offset to a fixed source', () => {
    const s = base()
    s.constraints = [
      { kind: 'position', source: id(s, 0, 1), target: id(s, 1, 0), delta: [1, -2] },
      { kind: 'orientation', source: id(s, 0, 1), target: id(s, 1, 0), delta: 90 },
    ]
    const r = resolveSetup(s).setup.curves[1].fixPoints[0]
    expect(r.pos).toEqual([5, -2])
    expect(r.orientation![0]).toBeCloseTo(-1)
    expect(r.orientation![1]).toBeCloseTo(0)
  })

  it('keeps free linked points together (at their offset) while solving', () => {
    const s = base()
    s.curves[0].fixPoints[1] = { ...fp([4, 1], null, true), id: id(s, 0, 1) }
    s.constraints = [{ kind: 'position', source: id(s, 0, 1), target: id(s, 1, 0), delta: [0.5, 1] }]
    const fs = solve(s)
    const last = fs.frames[fs.frames.length - 1]
    const a = last.curves[0][last.controlIndices[0][1]]
    const b = last.curves[1][last.controlIndices[1][0]]
    expect(Math.hypot(b[0] - a[0] - 0.5, b[1] - a[1] - 1)).toBeLessThan(1e-9)
  })

  it('rejects loops and duplicate targets', () => {
    const s = base()
    s.constraints = [
      { kind: 'position', source: id(s, 0, 1), target: id(s, 1, 0) },
      { kind: 'position', source: id(s, 1, 0), target: id(s, 0, 1) },
    ]
    expect(validateSetup(s).length).toBeGreaterThan(0)
  })

  it('rejects a constraint whose point id does not exist', () => {
    const s = base()
    s.constraints = [{ kind: 'position', source: 'gone', target: id(s, 1, 0) }]
    expect(validateSetup(s).length).toBeGreaterThan(0)
  })

  describe('following a free orientation', () => {
    // A (curve 0, point 1) is free in position-fixed/orientation; B (curve 1, point 0) follows its tangent.
    const follow = (delta: number): Setup => {
      const s: Setup = {
        resolution: 1,
        curves: [
          { fixPoints: [fp([0, 0], [1, 0]), fp([4, 0]), fp([8, 2], [0, 1])], spans: [[], []] },
          { fixPoints: [fp([0, -6], [1, 0]), fp([4, -6]), fp([8, -4], [1, 1])], spans: [[], []] },
        ],
      }
      s.constraints = [{ kind: 'orientation', source: id(s, 0, 1), target: id(s, 1, 1), delta }]
      return s
    }
    const tangent = (pts: Vec2[], i: number): Vec2 => {
      const a = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]
      const l = Math.hypot(a[0], a[1])
      return [a[0] / l, a[1] / l]
    }
    const angle = (v: Vec2) => (Math.atan2(v[1], v[0]) * 180) / Math.PI

    it.each([0, 30])('B keeps A\'s actual tangent rotated by %i degrees in the result', (delta) => {
      const r = solve(follow(delta), { ...DEFAULT_CONSTANTS, maxSteps: 20000 })
      const f = r.frames.at(-1)!
      const [ia, ib] = [f.controlIndices[0][1], f.controlIndices[1][1]]
      const ta = angle(tangent(f.curves[0], ia))
      const tb = angle(tangent(f.curves[1], ib))
      expect(Math.abs(tb - ta - delta)).toBeLessThan(0.5)
      // Both sides of B are collinear as well.
      const out = f.curves[1][ib + 1]
      const outAngle = angle([out[0] - f.curves[1][ib][0], out[1] - f.curves[1][ib][1]])
      expect(Math.abs(outAngle - tb)).toBeLessThan(0.5)
    })

    it('the other curve pulls on the source: the shared tangent differs from the unlinked result', () => {
      const linked = solve(follow(0), { ...DEFAULT_CONSTANTS, maxSteps: 20000 }).frames.at(-1)!
      const alone = follow(0)
      delete alone.constraints
      const free = solve(alone, { ...DEFAULT_CONSTANTS, maxSteps: 20000 }).frames.at(-1)!
      const a = angle(tangent(linked.curves[0], linked.controlIndices[0][1]))
      const b = angle(tangent(free.curves[0], free.controlIndices[0][1]))
      expect(Math.abs(a - b)).toBeGreaterThan(1)
    })
  })
})

describe('dynamic point count', () => {
  const counts = (r: ReturnType<typeof solve>): number[] => r.frames.map((f) => f.curves[0].length)

  it('loses interior points when the curve straightens and shortens', () => {
    // A bulging guide point makes the span long; minimizing bend straightens it.
    const setup = chain([fp([0, 0], [1, 0]), fp([10, 0], [1, 0])], 1)
    setup.curves[0].spans = [[[5, 6]]]
    const r = solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 30000 })
    const c = counts(r)
    expect(c[0]).toBeGreaterThan(c.at(-1)!)
    expect(c.at(-1)).toBeGreaterThanOrEqual(4)
  })

  it('gains interior points when the curve stretches', () => {
    const setup = chain([fp([0, 0], [0, 1]), fp([4, 0], [0, -1])], 1, { targetLength: 14 })
    const r = solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 30000 })
    const c = counts(r)
    expect(c.at(-1)).toBeGreaterThan(c[0])
    const total = segLens(r.frames.at(-1)!.curves[0]).reduce((a, b) => a + b, 0)
    expect(Math.abs(total - 14)).toBeLessThan(1.5)
  })

  it('keeps control indices consistent with the point count in every frame', () => {
    const setup = chain([fp([0, 0], [1, 0]), fp([5, 0]), fp([10, 0], [1, 0])], 1)
    setup.curves[0].spans = [[[2.5, 4]], [[7.5, -4]]]
    const r = solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 5000 })
    for (const f of r.frames) {
      const idx = f.controlIndices[0]
      expect(idx[0]).toBe(0)
      expect(idx.at(-1)).toBe(f.curves[0].length - 1)
      for (let k = 0; k + 1 < idx.length; k++) expect(idx[k + 1] - idx[k]).toBeGreaterThanOrEqual(3)
    }
    expect(r.meta.maxPoints).toBeGreaterThanOrEqual(Math.max(...counts(r)))
  })

  it('keeps fixed control points exactly in place while points come and go', () => {
    const setup = chain([fp([0, 0], [1, 0]), fp([10, 0], [1, 0])], 1)
    setup.curves[0].spans = [[[5, 6]]]
    const r = solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 3000 })
    for (const f of r.frames) {
      expect(f.curves[0][0]).toEqual([0, 0])
      expect(f.curves[0].at(-1)).toEqual([10, 0])
    }
  })
})

describe('robustness', () => {
  // Small deterministic PRNG so failures are reproducible.
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }

  it('never produces non-finite frames for random setups, including degenerate ones', () => {
    const rand = rng(7)
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
    for (let n = 0; n < 40; n++) {
      const count = 2 + Math.floor(rand() * 3)
      const points: FixPoint[] = Array.from({ length: count }, () =>
        fp(
          [pick([0, 0, 1, rand() * 10 - 5]), pick([0, 0, rand() * 10 - 5])],
          pick<Vec2 | null>([null, [1, 0], [0, -1], [0.001, 0.0011], [rand() - 0.5, rand() - 0.5]]),
          rand() < 0.4,
        ),
      )
      const setup = chain(points, pick([0.2, 0.5, 1, 3]), {
        targetLength: pick<number | null>([null, null, 0.5, 5, 40]),
      })
      if (validateSetup(setup).length > 0) continue
      const r = solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 600 })
      for (const f of r.frames) {
        for (const curve of f.curves) for (const q of curve) expect(Number.isFinite(q[0] + q[1])).toBe(true)
      }
    }
  }, 60000)

  it('reports a clear error for unusable constants instead of looping forever', () => {
    expect(() => solve(two([0, 0], [4, 0], null, null), { ...DEFAULT_CONSTANTS, timeStep: 0 })).toThrow(/step size/i)
    expect(() => solve(two([0, 0], [4, 0], null, null), { ...DEFAULT_CONSTANTS, maxSteps: NaN })).toThrow(/step limit/i)
  })
})

describe('energy', () => {
  const bent = (extra: Partial<Curve> = {}): Setup => {
    const setup = chain([fp([0, 0], [1, 0]), fp([10, 0], [1, 0])], 1, extra)
    setup.curves[0].spans = [[[5, 6]]]
    return setup
  }
  const energies = (constants: Partial<typeof DEFAULT_CONSTANTS>, setup = bent()) =>
    solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 4000, ...constants })
      .frames.filter((f) => f.energy !== undefined)

  it('loses energy to friction and comes to rest at a lower energy than it started with', () => {
    const frames = energies({ maxSteps: 20000 })
    const first = frames[0]
    const last = frames.at(-1)!
    expect(last.energy!).toBeLessThan(0.5 * first.energy!)
    expect(last.ke).toBeLessThan(1e-3)
  })

  it('stays finite and settles at a fine resolution with the default step size', () => {
    const setup = bent()
    setup.resolution = 0.15
    const r = solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 100000 })
    expect(r.meta.termination).toBe('rest')
    const last = r.frames.at(-1)!
    for (const q of last.curves[0]) expect(Number.isFinite(q[0] + q[1])).toBe(true)
    expect(last.energy!).toBeLessThan(r.frames[0].energy!)
  }, 60000)

  it('weighs a control point down: it moves less than its interior neighbors in the first steps', () => {
    const setup = chain([fp([0, 0], [1, 0]), fp([5, 3], [1, 0], true), fp([10, 0], [1, 0])], 1)
    const r = solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 6 })
    const a = r.frames[0].curves[0]
    const b = r.frames.at(-1)!.curves[0]
    const ci = r.frames[0].controlIndices[0][1]
    const moved = (k: number) => Math.hypot(b[k][0] - a[k][0], b[k][1] - a[k][1])
    expect(moved(ci)).toBeLessThan(moved(ci - 2))
  })

  it('moves a control point less the larger the controlMass parameter is', () => {
    const setup = chain([fp([0, 0], [1, 0]), fp([5, 3], [1, 0], true), fp([10, 0], [1, 0])], 1)
    const shift = (controlMass: number) => {
      const r = solve(setup, { ...DEFAULT_CONSTANTS, controlMass, maxSteps: 6 })
      const ci = r.frames[0].controlIndices[0][1]
      const a = r.frames[0].curves[0][ci]
      const b = r.frames.at(-1)!.curves[0][ci]
      return Math.hypot(b[0] - a[0], b[1] - a[1])
    }
    expect(shift(20)).toBeLessThan(shift(1))
  })

  it('rejects a non-positive control point mass', () => {
    expect(() => solve(two([0, 0], [4, 0], null, null), { ...DEFAULT_CONSTANTS, controlMass: 0 })).toThrow(/mass/i)
  })

  it('kinetic energy can never exceed the total energy', () => {
    const frames = energies({}, bent({ targetLength: 60 }))
    for (const f of frames) expect(f.ke).toBeLessThanOrEqual(f.energy! + 1e-9)
  })
})

describe('shortness vs flatness', () => {
  const total = (flatness: number): number => {
    const setup = chain([fp([0, 0], [0, 1]), fp([4, 0], [0, -1])], 1, { flatness })
    const f = solve(setup, { ...DEFAULT_CONSTANTS, maxSteps: 20000 }).frames.at(-1)!
    return segLens(f.curves[0]).reduce((a, b) => a + b, 0)
  }

  it('a shortness-leaning curve ends up no longer than a flatness-leaning one', () => {
    expect(total(0)).toBeLessThan(total(1))
  })

  it('rejects a balance outside 0..1', () => {
    expect(validateSetup(chain([fp([0, 0]), fp([4, 0])], 1, { flatness: 2 }))[0].field).toBe('flatness:0')
  })
})
