import type { Vec2 } from '../solver/types'

/** Heading in degrees (counter-clockwise from +X) of a direction vector. */
export function vectorToDegrees(v: Vec2): number {
  const deg = (Math.atan2(v[1], v[0]) * 180) / Math.PI
  return Math.round(deg * 100) / 100
}

export function degreesToVector(deg: number): Vec2 {
  const rad = (deg * Math.PI) / 180
  const round = (x: number) => Math.round(x * 1e6) / 1e6
  return [round(Math.cos(rad)), round(Math.sin(rad))]
}

export interface DirectionMapping {
  mirror: boolean
  delta: number
}

/**
 * Parses a direction rule written in terms of the followed direction `x`:
 * "x", "x + 90", "x - 90", "-x", "90 - x", "180 + x" ... Exactly one `x` with
 * a plus or minus sign, plus any number of constants in degrees.
 */
export function parseDirectionExpr(text: string): DirectionMapping | null {
  const clean = text.toLowerCase().replace(/[\s°]/g, '').replace(/[−–]/g, '-')
  if (clean === '') return null
  const terms = clean.match(/[+-]?(?:x|\d+\.?\d*|\.\d+)/g)
  if (!terms || terms.join('') !== clean || terms.slice(1).some((t) => !/^[+-]/.test(t))) return null
  let xSign = 0
  let delta = 0
  for (const term of terms) {
    const sign = term.startsWith('-') ? -1 : 1
    const body = term.replace(/^[+-]/, '')
    if (body === 'x') {
      if (xSign !== 0) return null
      xSign = sign
    } else delta += sign * Number(body)
  }
  if (xSign === 0 || !Number.isFinite(delta)) return null
  return { mirror: xSign < 0, delta: Math.round(delta * 1e6) / 1e6 }
}

export function formatDirectionExpr({ mirror, delta }: DirectionMapping): string {
  const x = mirror ? '-x' : 'x'
  if (delta === 0) return x
  return `${x} ${delta < 0 ? '-' : '+'} ${Math.abs(delta)}`
}
