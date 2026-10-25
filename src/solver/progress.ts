// Progress estimation for the relaxation solver.
//
// Two independent signals are combined so a run can never report completion
// before it is actually finished:
//   - frame progress: iteration / maxSteps, the hard safety cap, and
//   - energy progress: how far the kinetic-energy envelope has fallen from its
//     running peak (the simulation is converging as energy dissipates).
//
// The energy signal uses an asymmetric envelope follower (instant attack, slow
// exponential release) so a single noisy dip in KE can never spike progress to
// 100% far ahead of the real end.

/** Highest fraction reported while a run is still going; only completion shows 1. */
export const MAX_RUNNING_PROGRESS = 0.99

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * Tracks kinetic energy over a run. Feed every frame's KE to {@link observe},
 * then read {@link progress}. The envelope decays by `release` per observation,
 * so passing `friction * timeStep` ties the decay to the physical damping time constant.
 */
export class ProgressTracker {
  private readonly release: number
  private envelope = 0
  private peak = 0

  constructor(release: number) {
    this.release = Math.max(0, Math.min(1, Number.isFinite(release) ? release : 0))
  }

  /** Fold one frame's kinetic energy into the envelope and running peak. */
  observe(ke: number): void {
    if (!Number.isFinite(ke)) return
    const value = Math.max(0, ke)
    if (value >= this.envelope) {
      // Instant attack: follow rising edges exactly (and every new maximum).
      this.envelope = value
    } else {
      // Slow release: exponential decay toward the instantaneous energy.
      this.envelope += (value - this.envelope) * this.release
    }
    if (value > this.peak) this.peak = value
  }

  /**
   * Completion fraction in [0, MAX_RUNNING_PROGRESS]: the larger of the frame
   * budget burned and the energy dissipated from the peak.
   */
  progress(iteration: number, maxSteps: number): number {
    const frame = maxSteps > 0 ? iteration / maxSteps : 1
    const energy = this.peak > 0 ? clamp01(1 - this.envelope / this.peak) : 0
    return Math.min(MAX_RUNNING_PROGRESS, Math.max(0, Math.max(frame, energy)))
  }
}
