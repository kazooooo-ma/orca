import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDebouncedBatch } from './filesystem-watcher-batch-control'
import { watcherLifecycleState as state } from './filesystem-watcher-lifecycle-state'
import { createWatcherSender } from './filesystem-watcher-test-sender'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'
import { trackDetachedLocalUnsubscribe } from './filesystem-watcher-listener-lifecycle'
import { subscribeLocalWatcher } from './filesystem-watcher-local-subscription'
import {
  closeLocalWatcherForWorktreePath,
  restoreLocalWatcherAfterFailedRemoval,
  forgetLocalWatcherRemovalSnapshot
} from './filesystem-watcher-local-removal'
import { setWorktreeWatcherRemoval } from './worktree-watcher-removal'
import { createWatcherRemovalDeadline } from './watcher-removal-drain'
import { WatcherProcessFailure } from './parcel-watcher-process-failure'
import { createRuntimeFileWatcherRemoval } from '../runtime/runtime-file-watcher-removal'

const { createLocal } = vi.hoisted(() => ({ createLocal: vi.fn() }))
vi.mock('node:fs/promises', () => ({ stat: async () => ({ isDirectory: () => true }) }))
vi.mock('./filesystem-watcher-local-events', () => ({
  createLocalWatcher: createLocal,
  scheduleLocalBatchFlush: vi.fn()
}))
vi.mock('./filesystem-watcher-wsl', () => ({ createWslWatcher: vi.fn() }))

const UNKNOWN = 'conditional_worktree_removal_unknown'
const cleanup: (() => void)[] = []
let sequence = 0
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function root(unsubscribe = vi.fn(async () => {})) {
  return {
    subscription: { unsubscribe },
    listeners: new Map(),
    batch: createDebouncedBatch(),
    rootPath: '/synthetic-strict-recovery'
  }
}
async function flush(): Promise<void> {
  for (let turn = 0; turn < 64; turn++) {
    await Promise.resolve()
  }
}
function unknownFailure(acquisition: Promise<unknown>) {
  const failure = expect(acquisition).rejects.toThrow(UNKNOWN)
  // Why: the negative-control source may fail this assertion before fake timers finish advancing.
  void failure.catch(() => {})
  return failure
}
function fixture() {
  const path = `/synthetic-strict-recovery/${++sequence}`
  const restore = vi.fn(restoreLocalWatcherAfterFailedRemoval)
  setWorktreeWatcherRemoval({
    closeLocal: closeLocalWatcherForWorktreePath,
    restoreLocal: restore,
    forgetLocal: forgetLocalWatcherRemovalSnapshot,
    closeRemote: async () => {},
    restoreRemote: async () => {},
    forgetRemote: () => {}
  })
  const removal = createRuntimeFileWatcherRemoval({
    closeFileExplorerWatchersForPath: async () => {},
    restoreFileExplorerWatchersAfterFailedRemoval: async () => {},
    forgetFileExplorerWatchersAfterRemoval: () => {}
  })
  return {
    path,
    key: getLocalWatcherRoot(path).key,
    restore,
    acquire: () => removal.acquire(path, undefined, { strict: true, budgetMs: 100 })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  state.localWatchersClosed = false
  createLocal.mockImplementation(async () => root())
})
afterEach(async () => {
  for (const resolve of cleanup.splice(0)) {
    resolve()
  }
  await flush()
  state.watchedRoots.clear()
  state.pendingLocalInstallPromises.clear()
  state.inFlightLocalInstalls.clear()
  state.pendingLocalUnsubscribes.clear()
  state.pendingLocalUnsubscribesByRoot.clear()
  state.failedLocalUnsubscribes.clear()
  state.suspendedLocalWatcherListeners.clear()
  state.unwatchableRoots.clear()
  for (const lifetime of state.senderLifetimes.values()) {
    lifetime.dispose()
  }
  state.senderLifetimes.clear()
  setWorktreeWatcherRemoval(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('strict native close recovery completion', () => {
  it.each(['cancelled install', 'orphaned install'] as const)(
    'waits for detached unsubscribe created by a late %s',
    async (kind) => {
      const f = fixture()
      const install = deferred<ReturnType<typeof root>>()
      const unsubscribe = deferred<void>()
      cleanup.push(() => unsubscribe.resolve())
      const oldRoot = root(vi.fn(() => unsubscribe.promise))
      cleanup.push(() => install.resolve(oldRoot))
      createLocal.mockImplementationOnce(() =>
        kind === 'cancelled install'
          ? install.promise
          : install.promise.then((orphan) => {
              // Mirrors createLocalWatcher's error-before-subscribe-resolution teardown.
              void trackDetachedLocalUnsubscribe(f.key, orphan)
              throw new Error('synthetic orphaned subscription')
            })
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Synthetic sender supplies every watcher ownership method used; no Electron or provider is called.
      const watch = subscribeLocalWatcher(f.path, createWatcherSender(sequence) as never)
      await flush()
      expect(state.pendingLocalInstallPromises.has(f.key)).toBe(true)
      const failure = unknownFailure(f.acquire())
      await vi.advanceTimersByTimeAsync(100)
      await failure
      expect(f.restore).not.toHaveBeenCalled()

      install.resolve(oldRoot)
      await watch
      await flush()
      expect(oldRoot.subscription.unsubscribe).toHaveBeenCalledTimes(1)
      expect(state.pendingLocalUnsubscribesByRoot.get(f.key)?.size).toBe(1)
      expect(f.restore).not.toHaveBeenCalled()
      expect(createLocal).toHaveBeenCalledTimes(1)

      unsubscribe.resolve()
      await flush()
      expect(f.restore).toHaveBeenCalledTimes(1)
      expect(createLocal).toHaveBeenCalledTimes(2)
    }
  )

  it('keeps a rejected fanout sibling from completing recovery while another is pending', async () => {
    const f = fixture()
    const first = deferred<void>()
    const second = deferred<void>()
    cleanup.push(
      () => first.resolve(),
      () => second.resolve()
    )
    void trackDetachedLocalUnsubscribe(f.key, root(vi.fn(() => first.promise)))
    void trackDetachedLocalUnsubscribe(f.key, root(vi.fn(() => second.promise)))
    const failure = unknownFailure(f.acquire())
    first.reject(new Error('synthetic unsubscribe failure'))
    await vi.advanceTimersByTimeAsync(100)
    await failure
    expect(state.pendingLocalUnsubscribesByRoot.get(f.key)?.size).toBe(1)
    expect(f.restore).not.toHaveBeenCalled()

    second.resolve()
    await flush()
    expect(f.restore).toHaveBeenCalledTimes(1)
  })

  it('waits for retained physical exit after unsubscribe rejects', async () => {
    const f = fixture()
    const exit = deferred<void>()
    cleanup.push(() => exit.resolve())
    const error = new WatcherProcessFailure(
      'synthetic child still closing',
      'supervisor',
      'process_unavailable',
      exit.promise
    )
    const oldRoot = root(
      vi.fn(async () => {
        throw error
      })
    )
    createLocal.mockResolvedValueOnce(oldRoot)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Synthetic sender implements the ownership seam; watcher creation and unsubscribe are mocked.
    await subscribeLocalWatcher(f.path, createWatcherSender(sequence) as never)
    await expect(f.acquire()).rejects.toThrow(UNKNOWN)
    await flush()
    expect(state.failedLocalUnsubscribes.get(f.key)).toBe(error)
    expect(f.restore).not.toHaveBeenCalled()
    exit.resolve()
    await flush()
    expect(f.restore).toHaveBeenCalledTimes(1)
    expect(createLocal).toHaveBeenCalledTimes(2)
  })

  it('waits for promises tracked during an earlier settlement continuation', async () => {
    const deadline = createWatcherRemovalDeadline(100, true)
    const first = deferred<void>()
    const late = deferred<void>()
    cleanup.push(
      () => first.resolve(),
      () => late.resolve()
    )
    deadline.track?.(first.promise)
    void first.promise.then(() => deadline.track?.(late.promise))
    let done = false
    const settlement = deadline.settlement?.().then(() => {
      done = true
    })
    first.resolve()
    await flush()
    expect(done).toBe(false)
    late.resolve()
    await settlement
    expect(done).toBe(true)
  })

  it('retains failed required completion as UNKNOWN instead of restoring', async () => {
    const deadline = createWatcherRemovalDeadline(100, true)
    const failure = new Error('synthetic physical completion unproved')
    deadline.track?.(Promise.reject(failure), true)
    await flush()
    expect(deadline.hasPendingDrain?.()).toBe(true)
    await expect(deadline.settlement?.()).rejects.toBe(failure)
  })
})
