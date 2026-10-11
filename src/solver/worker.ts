import type { WorkerRequest, WorkerResponse } from './protocol'
import { CancelledError, solve } from './solve'

// Minimal worker-scope interface so the module worker type-checks under the DOM lib.
interface WorkerScope {
  postMessage: (msg: WorkerResponse) => void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}

const ctx = self as unknown as WorkerScope

let cancelFlag = false

const post = (msg: WorkerResponse): void => {
  ctx.postMessage(msg)
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const msg = event.data

  if (msg.type === 'cancel') {
    cancelFlag = true
    return
  }

  if (msg.type === 'solve') {
    cancelFlag = false
    const { input, constants } = msg

    try {
      const result = solve(input, constants, {
        onProgress: (progress, iteration, ke) => {
          if (cancelFlag) return
          post({ type: 'progress', progress, iteration, ke })
        },
        shouldCancel: () => cancelFlag,
      })
      post({ type: 'done', result })
    } catch (err) {
      if (err instanceof CancelledError) {
        post({ type: 'cancelled' })
      } else {
        post({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
}