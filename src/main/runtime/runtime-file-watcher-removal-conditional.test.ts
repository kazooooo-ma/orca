import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getWorktreeWatcherRemoval,
  type WorktreeWatcherRemoval
} from '../ipc/worktree-watcher-removal'
import {
  acquireWatcherRemovalGate,
  beginTerminalInstall,
  TerminalRemovalInProgressError
} from '../ipc/watcher-removal-gate'
import { drainBeforeWatcherRemoval } from '../ipc/watcher-removal-drain'
import { createRuntimeFileWatcherRemoval } from './runtime-file-watcher-removal'

vi.mock('../ipc/worktree-watcher-removal', () => ({ getWorktreeWatcherRemoval: vi.fn() }))

const BUDGET_MS = 100
const UNKNOWN = 'conditional_worktree_removal_unknown'
const watchers = {
  closeLocal: vi.fn<WorktreeWatcherRemoval['closeLocal']>(),
  restoreLocal: vi.fn<WorktreeWatcherRemoval['restoreLocal']>(),
  forgetLocal: vi.fn<WorktreeWatcherRemoval['forgetLocal']>(),
  closeRemote: vi.fn<WorktreeWatcherRemoval['closeRemote']>(),
  restoreRemote: vi.fn<WorktreeWatcherRemoval['restoreRemote']>(),
  forgetRemote: vi.fn<WorktreeWatcherRemoval['forgetRemote']>()
}
const files = {
  closeFileExplorerWatchersForPath: vi.fn<(path: string, connectionId?: string) => Promise<void>>(),
  restoreFileExplorerWatchersAfterFailedRemoval:
    vi.fn<(path: string, connectionId?: string) => Promise<void>>(),
  forgetFileExplorerWatchersAfterRemoval: vi.fn<(path: string, connectionId?: string) => void>()
}
const cleanup: (() => void | Promise<void>)[] = []
let sequence = 0

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 16; turn++) {
    await Promise.resolve()
  }
}

function deferred() {
  let resolve: () => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  cleanup.push(resolve)
  return { promise, resolve, reject }
}

function rawAdmission(path: string): () => void {
  const finish = beginTerminalInstall(path)
  cleanup.push(finish)
  return finish
}

function gateFor(path: string) {
  const gate = acquireWatcherRemovalGate(path)
  cleanup.push(() => gate.release())
  return gate
}

function fixture() {
  const path = `/synthetic-watcher-removal/case-${++sequence}`
  const removal = createRuntimeFileWatcherRemoval(files)
  const acquire = async (strict = true, target = path) => {
    const lease = await removal.acquire(target, undefined, { strict, budgetMs: BUDGET_MS })
    cleanup.push(() => lease.finish(true).catch(() => {}))
    return lease
  }
  return { path, acquire }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-04T00:00:00Z'))
  vi.resetAllMocks()
  vi.mocked(getWorktreeWatcherRemoval).mockReturnValue(watchers)
  watchers.closeLocal.mockResolvedValue(undefined)
  watchers.closeRemote.mockResolvedValue(undefined)
  watchers.restoreLocal.mockResolvedValue(undefined)
  watchers.restoreRemote.mockResolvedValue(undefined)
  files.closeFileExplorerWatchersForPath.mockResolvedValue(undefined)
  files.restoreFileExplorerWatchersAfterFailedRemoval.mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  for (const finish of cleanup.splice(0).toReversed()) {
    await finish()
  }
  await flushMicrotasks()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('conditional watcher removal using the existing gate', () => {
  it('refuses a close that returns no completion proof', async () => {
    const f = fixture()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Deliberately violates the mock contract to verify fail-closed handling.
    watchers.closeLocal.mockImplementation(() => undefined as never)
    await expect(f.acquire()).rejects.toThrow(UNKNOWN)
    rawAdmission(f.path)()
  })
  it('drains an admitted target raw token and denies fresh admission until finish', async () => {
    const f = fixture()
    const finishOld = rawAdmission(f.path)
    let acquired = false
    const acquisition = f.acquire().then((lease) => {
      acquired = true
      return lease
    })
    await flushMicrotasks()

    expect(acquired).toBe(false)
    expect(watchers.closeLocal).toHaveBeenCalledTimes(1)
    expect(() => rawAdmission(f.path)).toThrow(TerminalRemovalInProgressError)
    finishOld()
    const lease = await acquisition
    expect(watchers.closeLocal).toHaveBeenCalledTimes(2)
    expect(() => rawAdmission(f.path)).toThrow(TerminalRemovalInProgressError)
    await lease.finish(false)

    expect(watchers.restoreLocal).toHaveBeenCalledWith(f.path)
    expect(files.restoreFileExplorerWatchersAfterFailedRemoval).toHaveBeenCalledWith(
      f.path,
      undefined
    )
    expect(watchers.forgetLocal).not.toHaveBeenCalled()
    rawAdmission(f.path)()
  })

  it('retains timed-out raw tokens and a late old finish cannot discard a fresh token', async () => {
    const f = fixture()
    const finishOld = rawAdmission(f.path)
    const failure = expect(f.acquire()).rejects.toThrow(UNKNOWN)
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    await failure
    expect(watchers.closeLocal).toHaveBeenCalledTimes(1)
    expect(watchers.restoreLocal).not.toHaveBeenCalled()

    const retained = gateFor(f.path)
    let retainedReady = false
    void retained.ready.then(() => {
      retainedReady = true
    })
    await flushMicrotasks()
    expect(retainedReady).toBe(false)
    retained.release()

    const finishFresh = rawAdmission(f.path)
    finishOld()
    const retry = gateFor(f.path)
    let retryReady = false
    void retry.ready.then(() => {
      retryReady = true
    })
    await flushMicrotasks()
    expect(retryReady).toBe(false)
    finishFresh()
    await retry.ready
    retry.release()
    await flushMicrotasks()
    expect(watchers.restoreLocal).toHaveBeenCalledTimes(1)
  })

  it.each(['local', 'file explorer'] as const)(
    'rejects a strict %s close timeout',
    async (kind) => {
      const f = fixture()
      const close = deferred()
      if (kind === 'local') {
        watchers.closeLocal.mockReturnValue(close.promise)
      } else {
        files.closeFileExplorerWatchersForPath.mockReturnValue(close.promise)
      }
      const failure = expect(f.acquire()).rejects.toThrow(UNKNOWN)
      await vi.advanceTimersByTimeAsync(BUDGET_MS)
      await failure

      expect(watchers.restoreLocal).not.toHaveBeenCalled()
      expect(watchers.forgetLocal).not.toHaveBeenCalled()
      expect(watchers.closeLocal).toHaveBeenCalledTimes(1)
      rawAdmission(f.path)()
      close.reject(new Error(`late ${kind} close failed`))
      await flushMicrotasks()
      expect(watchers.restoreLocal).toHaveBeenCalledTimes(1)
      expect(files.restoreFileExplorerWatchersAfterFailedRemoval).toHaveBeenCalledTimes(1)
    }
  )

  it('propagates an internal local close failure and restores after rejection', async () => {
    const f = fixture()
    const failure = new Error('local unsubscribe failed')
    watchers.closeLocal.mockImplementationOnce(async (_path, deadline) => {
      expect(deadline?.strict).toBe(true)
      if (!deadline) {
        throw new Error('missing shared deadline')
      }
      await drainBeforeWatcherRemoval(Promise.reject(failure), deadline, 'local unsubscribe')
    })
    await expect(f.acquire()).rejects.toThrow(failure)

    expect(watchers.closeLocal).toHaveBeenCalledTimes(1)
    expect(watchers.restoreLocal).toHaveBeenCalledTimes(1)
    expect(watchers.forgetLocal).not.toHaveBeenCalled()
    rawAdmission(f.path)()
  })

  it('reports UNKNOWN and waits for every late close before restoring replacements', async () => {
    const f = fixture()
    const local = deferred()
    const explorer = deferred()
    watchers.closeLocal.mockReturnValue(local.promise)
    files.closeFileExplorerWatchersForPath.mockReturnValue(explorer.promise)
    const failure = expect(f.acquire()).rejects.toThrow(`${UNKNOWN}: watcher recovery pending`)
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    await failure

    local.resolve()
    await flushMicrotasks()
    expect(watchers.restoreLocal).not.toHaveBeenCalled()
    explorer.resolve()
    await flushMicrotasks()
    expect(watchers.restoreLocal).toHaveBeenCalledTimes(1)
    expect(files.restoreFileExplorerWatchersAfterFailedRemoval).toHaveBeenCalledTimes(1)
    expect(watchers.forgetLocal).not.toHaveBeenCalled()
  })

  it('keeps late recovery failure subordinate to the original UNKNOWN', async () => {
    const f = fixture()
    const close = deferred()
    watchers.closeLocal.mockReturnValue(close.promise)
    watchers.restoreLocal.mockRejectedValue(new Error('late restoration failed'))
    const acquisition = f.acquire()
    const failure = expect(acquisition).rejects.toThrow(UNKNOWN)
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    await failure
    close.resolve()
    await flushMicrotasks()

    expect(console.error).toHaveBeenCalledWith(
      '[worktrees] delayed watcher restoration failed',
      expect.any(Error)
    )
    await expect(acquisition).rejects.toThrow(UNKNOWN)
    expect(watchers.forgetLocal).not.toHaveBeenCalled()
  })

  it.each(['local', 'file explorer'] as const)(
    'refuses %s restoration without completion proof',
    async (kind) => {
      const f = fixture()
      const lease = await f.acquire()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Deliberately violates a synthetic completion contract to verify refusal.
      const missingCompletion = () => undefined as never
      if (kind === 'local') {
        watchers.restoreLocal.mockImplementation(missingCompletion)
      } else {
        files.restoreFileExplorerWatchersAfterFailedRemoval.mockImplementation(missingCompletion)
      }
      await expect(lease.finish(false)).rejects.toThrow(`${UNKNOWN}: watcher restoration failed`)
      rawAdmission(f.path)()
    }
  )

  it.each(['local', 'file explorer'] as const)(
    'reports %s restoration rejection as UNKNOWN',
    async (kind) => {
      const f = fixture()
      const lease = await f.acquire()
      if (kind === 'local') {
        watchers.restoreLocal.mockRejectedValue(new Error('restore failed'))
      } else {
        files.restoreFileExplorerWatchersAfterFailedRemoval.mockRejectedValue(
          new Error('restore failed')
        )
      }
      const first = lease.finish(false)
      await expect(first).rejects.toThrow(`${UNKNOWN}: watcher restoration failed`)
      expect(lease.finish(false)).toBe(first)
      await expect(lease.finish(true)).rejects.toThrow(UNKNOWN)

      expect(watchers.restoreLocal).toHaveBeenCalledTimes(1)
      expect(files.restoreFileExplorerWatchersAfterFailedRemoval).toHaveBeenCalledTimes(1)
      expect(watchers.forgetLocal).not.toHaveBeenCalled()
      rawAdmission(f.path)()
    }
  )

  it.each(['local', 'file explorer'] as const)(
    'bounds %s restoration and preserves repeated rejection',
    async (kind) => {
      const f = fixture()
      const lease = await f.acquire()
      const restoration = deferred()
      if (kind === 'local') {
        watchers.restoreLocal.mockReturnValue(restoration.promise)
      } else {
        files.restoreFileExplorerWatchersAfterFailedRemoval.mockReturnValue(restoration.promise)
      }
      const first = lease.finish(false)
      const failure = expect(first).rejects.toThrow(`${UNKNOWN}: watcher restoration failed`)
      await vi.advanceTimersByTimeAsync(BUDGET_MS)
      await failure
      restoration.resolve()
      await flushMicrotasks()

      expect(lease.finish(false)).toBe(first)
      await expect(lease.finish(true)).rejects.toThrow(UNKNOWN)
      expect(watchers.restoreLocal).toHaveBeenCalledTimes(1)
      expect(watchers.forgetLocal).not.toHaveBeenCalled()
      rawAdmission(f.path)()
    }
  )

  it('holds the successful removal gate through an idempotent finish', async () => {
    const f = fixture()
    const lease = await f.acquire()
    expect(() => rawAdmission(f.path)).toThrow(TerminalRemovalInProgressError)
    const first = lease.finish(true)
    await first
    expect(lease.finish(true)).toBe(first)
    await lease.finish(false)

    expect(watchers.forgetLocal).toHaveBeenCalledTimes(1)
    expect(files.forgetFileExplorerWatchersAfterRemoval).toHaveBeenCalledTimes(1)
    expect(watchers.restoreLocal).not.toHaveBeenCalled()
    rawAdmission(f.path)()
  })

  it('preserves manual drain abandonment and logged restoration failure semantics', async () => {
    const f = fixture()
    const finishOld = rawAdmission(f.path)
    watchers.restoreLocal.mockRejectedValue(new Error('manual restoration failed'))
    const acquisition = f.acquire(false)
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    const lease = await acquisition
    expect(watchers.closeLocal).toHaveBeenCalledTimes(2)
    expect(() => rawAdmission(f.path)).toThrow(TerminalRemovalInProgressError)
    await expect(lease.finish(false)).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith(
      '[worktrees] failed to restore watchers after removal failed',
      expect.any(Object)
    )

    const finishFresh = rawAdmission(f.path)
    finishOld()
    const retry = gateFor(f.path)
    let ready = false
    void retry.ready.then(() => {
      ready = true
    })
    await flushMicrotasks()
    expect(ready).toBe(false)
    finishFresh()
    await retry.ready
    retry.release()
  })

  it('keeps omitted strict options on the existing manual restoration contract', async () => {
    const f = fixture()
    const lease = await createRuntimeFileWatcherRemoval(files).acquire(f.path)
    cleanup.push(() => lease.finish(true).catch(() => {}))
    expect(watchers.closeLocal).toHaveBeenCalledWith(
      f.path,
      expect.objectContaining({ strict: false })
    )
    watchers.restoreLocal.mockRejectedValue(new Error('manual restoration failed'))
    await expect(lease.finish(false)).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalled()
    rawAdmission(f.path)()
  })

  it('documents the ancestor-only pretoken outside the existing target drain scope', async () => {
    const f = fixture()
    const finishAncestor = rawAdmission(f.path)
    const lease = await f.acquire(true, `${f.path}/target`)
    expect(watchers.closeLocal).toHaveBeenCalledTimes(2)
    expect(() => rawAdmission(f.path)).toThrow(TerminalRemovalInProgressError)
    await lease.finish(true)
    finishAncestor()
    rawAdmission(f.path)()
  })
})
