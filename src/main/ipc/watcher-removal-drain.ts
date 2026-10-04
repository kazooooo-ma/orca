// Why: worktree deletion has to drain in-flight watcher installs/unsubscribes before Git removes the
// tree, and a wedged native subscribe can leave those promises unsettled forever. Independent per-await
// timeouts would compose (two close passes x two drains), so one removal shares one absolute deadline.

export const WATCHER_REMOVAL_DRAIN_BUDGET_MS = 60_000
// Why: the final live unsubscribe is the drain that actually releases the native handle. Earlier drains
// leave it this slice so a slow-but-finishing unsubscribe on Windows/WSL isn't abandoned at ~0ms left.
export const WATCHER_REMOVAL_FINAL_DRAIN_RESERVE_MS = 10_000

export type WatcherRemovalDeadline = {
  remainingMs(reserveMs?: number): number
  strict?: boolean
  track?(promise: Promise<unknown>, requireSuccess?: boolean): void
  hasPendingDrain?(): boolean
  settlement?(): Promise<void>
}

export function createWatcherRemovalDeadline(
  budgetMs: number = WATCHER_REMOVAL_DRAIN_BUDGET_MS,
  strict = false
): WatcherRemovalDeadline {
  const expiresAt = Date.now() + budgetMs
  const pending = new Set<Promise<unknown>>()
  let recoveryFailed = false
  let recoveryFailure: unknown
  return {
    strict,
    track: (promise, requireSuccess = false) => {
      pending.add(promise)
      void promise.then(
        () => pending.delete(promise),
        (error) => {
          pending.delete(promise)
          if (requireSuccess) {
            recoveryFailed = true
            recoveryFailure = error
          }
        }
      )
    },
    hasPendingDrain: () => pending.size > 0 || recoveryFailed,
    settlement: async () => {
      // Why: a settling install can register a new native teardown before recovery resumes.
      while (pending.size > 0) {
        await Promise.allSettled(pending)
      }
      if (recoveryFailed) {
        throw recoveryFailure
      }
    },
    remainingMs: (reserveMs = 0) => Math.max(0, expiresAt - Date.now() - reserveMs)
  }
}

export type WatcherRemovalDrainOutcome = 'settled' | 'timeout' | 'skipped'

export type WatcherRemovalDrainOptions = {
  required?: boolean
  /** Budget this drain must leave behind for the removal's final unsubscribe. */
  reserveMs?: number
}

/** Await `promise` until the removal deadline expires. Rejections still propagate so genuine
 *  teardown failures keep failing the delete closed; only an unsettled wait is abandoned. */
export async function drainBeforeWatcherRemoval(
  promise: Promise<unknown> | undefined,
  deadline: WatcherRemovalDeadline,
  label: string,
  options: WatcherRemovalDrainOptions = {}
): Promise<WatcherRemovalDrainOutcome> {
  if (!promise) {
    if (deadline.strict && options.required) {
      throw new Error(`conditional_worktree_removal_unknown: missing completion for ${label}`)
    }
    return 'skipped'
  }
  if (deadline.strict) {
    deadline.track?.(promise)
  }
  const waitMs = deadline.remainingMs(options.reserveMs)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const settled = promise.then(() => 'settled' as const)
    const outcome = await Promise.race([
      settled,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), waitMs)
      })
    ])
    if (outcome === 'timeout') {
      // Why: nobody awaits the abandoned promise anymore, so a late rejection (an aborted native
      // subscribe finally reporting) would be an unhandled rejection — fatal in the main process.
      void settled.catch(() => {})
      if (deadline.strict) {
        throw new Error(`conditional_worktree_removal_unknown: timed out waiting for ${label}`)
      }
      // Why log the budget split: production traces need "slow but finishing" separable from "wedged".
      console.warn(
        `[watcher-removal] Timed out waiting for ${label} after ${waitMs}ms ` +
          `(${deadline.remainingMs()}ms of the removal budget left); continuing removal`
      )
    }
    return outcome
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}
