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
