/** Compact energy display shared by the sidebar, player, and status line. */
export function formatEnergy(ke: number): string {
  if (!Number.isFinite(ke)) return '—'
  if (ke === 0) return '0'
  const abs = Math.abs(ke)
  if (abs >= 0.01 && abs < 1e4) return ke.toFixed(3)
  return ke.toExponential(2)
}
