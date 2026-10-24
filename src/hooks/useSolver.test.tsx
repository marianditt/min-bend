// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useSolver } from './useSolver'
import { DEFAULT_CONSTANTS } from '../solver/types'
import { DEFAULT_SETUP } from '../ui/defaults'

class FakeWorker {
  static instances: FakeWorker[] = []
  static failConstruct = false
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminated = false
  constructor() {
    if (FakeWorker.failConstruct) throw new Error('no workers here')
    FakeWorker.instances.push(this)
  }
  postMessage() {}
  terminate() {
    this.terminated = true
  }
}

beforeEach(() => {
  FakeWorker.instances = []
  FakeWorker.failConstruct = false
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useSolver recovery', () => {
  it('reports a worker crash as an error and can run again without reload', () => {
    const { result } = renderHook(() => useSolver())
    act(() => result.current.compute(DEFAULT_SETUP, DEFAULT_CONSTANTS))
    expect(result.current.state.status).toBe('running')

    act(() => FakeWorker.instances[0].onerror?.({ message: 'kaboom', preventDefault() {} } as ErrorEvent))
    expect(result.current.state.status).toBe('error')
    expect(result.current.state.error).toBe('kaboom')
    expect(FakeWorker.instances[0].terminated).toBe(true)

    act(() => result.current.compute(DEFAULT_SETUP, DEFAULT_CONSTANTS))
    expect(result.current.state.status).toBe('running')
    expect(FakeWorker.instances).toHaveLength(2)
  })

  it('reports a solver error message from the worker', () => {
    const { result } = renderHook(() => useSolver())
    act(() => result.current.compute(DEFAULT_SETUP, DEFAULT_CONSTANTS))
    act(() => FakeWorker.instances[0].onmessage?.({ data: { type: 'error', message: 'bad setup' } } as MessageEvent))
    expect(result.current.state).toMatchObject({ status: 'error', error: 'bad setup' })
  })

  it('turns a failing Worker constructor into an error state instead of throwing', () => {
    FakeWorker.failConstruct = true
    const { result } = renderHook(() => useSolver())
    act(() => result.current.compute(DEFAULT_SETUP, DEFAULT_CONSTANTS))
    expect(result.current.state).toMatchObject({ status: 'error', error: 'no workers here' })
  })

  it('ignores answers from a cancelled run', () => {
    const { result } = renderHook(() => useSolver())
    act(() => result.current.compute(DEFAULT_SETUP, DEFAULT_CONSTANTS))
    const worker = FakeWorker.instances[0]
    act(() => result.current.cancel())
    act(() => worker.onmessage?.({ data: { type: 'error', message: 'late' } } as MessageEvent))
    expect(result.current.state.status).toBe('cancelled')
  })
})
