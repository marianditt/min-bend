import { describe, expect, it } from 'vitest'
import { formatDirectionExpr, parseDirectionExpr } from './orientation'
import { resolveSetup } from '../solver/constraints'
import type { Setup } from '../solver/types'
import { sceneToPdf, sceneToSvg, type Scene } from '../player/scene'

describe('direction formulas', () => {
  it('parses x, offsets and negation', () => {
    expect(parseDirectionExpr('x')).toEqual({ mirror: false, delta: 0 })
    expect(parseDirectionExpr('x + 90')).toEqual({ mirror: false, delta: 90 })
    expect(parseDirectionExpr('x-90')).toEqual({ mirror: false, delta: -90 })
    expect(parseDirectionExpr('-x')).toEqual({ mirror: true, delta: 0 })
    expect(parseDirectionExpr('90 - x')).toEqual({ mirror: true, delta: 90 })
  })
  it('rejects anything else', () => {
    for (const bad of ['', '90', '2x', 'x + x', 'y', 'x +']) expect(parseDirectionExpr(bad)).toBeNull()
  })
  it('round-trips', () => {
    for (const e of ['x', 'x + 90', 'x - 90', '-x', '-x + 90']) expect(formatDirectionExpr(parseDirectionExpr(e)!)).toBe(e)
  })
  it('resolves a mirrored direction through a chain', () => {
    const setup: Setup = {
      resolution: 1,
      curves: [
        {
          spans: [[], []],
          fixPoints: [
            { id: 'a', pos: [0, 0], orientation: [0, 1] },
            { id: 'b', pos: [1, 0], orientation: null },
            { id: 'c', pos: [2, 0], orientation: null },
          ],
        },
      ],
      constraints: [
        { kind: 'orientation', source: 'a', target: 'b', mirror: true, delta: 90 },
        { kind: 'orientation', source: 'b', target: 'c', delta: 90 },
      ],
    }
    const pts = resolveSetup(setup).setup.curves[0].fixPoints
    // a = 90 deg; b = -90 + 90 = 0; c = 0 + 90 = 90
    expect(pts[1].orientation![0]).toBeCloseTo(1)
    expect(pts[1].orientation![1]).toBeCloseTo(0)
    expect(pts[2].orientation![0]).toBeCloseTo(0)
    expect(pts[2].orientation![1]).toBeCloseTo(1)
  })
})

describe('scene export', () => {
  const scene: Scene = {
    width: 100,
    height: 50,
    bg: '#ffffff',
    items: [
      { kind: 'path', pts: [[0, 0], [10, 10]], stroke: 'rgba(0, 0, 0, 0.5)', width: 2 },
      { kind: 'circle', x: 5, y: 5, r: 3, fill: '#ff0000', stroke: '#000' },
    ],
  }
  it('writes SVG and PDF', () => {
    expect(sceneToSvg(scene)).toContain('<circle')
    const pdf = new TextDecoder().decode(sceneToPdf(scene))
    expect(pdf.startsWith('%PDF-1.4')).toBe(true)
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true)
  })
})
