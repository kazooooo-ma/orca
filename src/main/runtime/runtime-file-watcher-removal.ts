import { getWorktreeWatcherRemoval } from '../ipc/worktree-watcher-removal'
import { acquireWatcherRemovalGate } from '../ipc/watcher-removal-gate'
import {
  createWatcherRemovalDeadline,
  drainBeforeWatcherRemoval,
  type WatcherRemovalDeadline
} from '../ipc/watcher-removal-drain'

type FileExplorerWatcherCommands = {
  closeFileExplorerWatchersForPath(worktreePath: string, connectionId?: string): Promise<void>
  restoreFileExplorerWatchersAfterFailedRemoval(
    worktreePath: string,
    connectionId?: string
  ): Promise<void>
  forgetFileExplorerWatchersAfterRemoval(worktreePath: string, connectionId?: string): void
}

export function createRuntimeFileWatcherRemoval(fileCommands: FileExplorerWatcherCommands) {
  const close = async (
    worktreePath: string,
    connectionId?: string,
    deadline: WatcherRemovalDeadline = createWatcherRemovalDeadline()
  ): Promise<void> => {
    const results = await Promise.allSettled([
      connectionId
        ? drainBeforeWatcherRemoval(
            getWorktreeWatcherRemoval().closeRemote(connectionId, worktreePath),
            deadline,
            `remote watcher close for ${worktreePath}`,
            { required: deadline.strict }
          )
        : deadline.strict
          ? drainBeforeWatcherRemoval(
              getWorktreeWatcherRemoval().closeLocal(worktreePath, deadline),
              deadline,
              `local watcher close for ${worktreePath}`,
              { required: true }
            )
          : getWorktreeWatcherRemoval().closeLocal(worktreePath, deadline),
      drainBeforeWatcherRemoval(
        fileCommands.closeFileExplorerWatchersForPath(worktreePath, connectionId),
        deadline,
        `file explorer watcher close for ${worktreePath}`,
        { required: deadline.strict }
      )
    ])
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failure) {
      // Why: restoration must wait until every bounded teardown settles.
      throw failure.reason
    }
  }

  const restore = async (
    worktreePath: string,
    connectionId?: string,
    deadline?: WatcherRemovalDeadline
  ): Promise<void> => {
    const restores = [
      connectionId
        ? getWorktreeWatcherRemoval().restoreRemote(connectionId, worktreePath)
        : getWorktreeWatcherRemoval().restoreLocal(worktreePath),
      fileCommands.restoreFileExplorerWatchersAfterFailedRemoval(worktreePath, connectionId)
    ]
    await Promise.all(
      deadline?.strict
        ? restores.map((completion, index) =>
            drainBeforeWatcherRemoval(
              completion,
              deadline,
              `${index === 0 ? 'native' : 'file explorer'} watcher restoration for ${worktreePath}`,
              { required: true }
            )
          )
        : restores
    )
  }

  const forget = (worktreePath: string, connectionId?: string): void => {
    if (connectionId) {
      getWorktreeWatcherRemoval().forgetRemote(connectionId, worktreePath)
    } else {
      getWorktreeWatcherRemoval().forgetLocal(worktreePath)
    }
    fileCommands.forgetFileExplorerWatchersAfterRemoval(worktreePath, connectionId)
  }

  const acquire = async (
    worktreePath: string,
    connectionId?: string,
    options: { strict?: boolean; budgetMs?: number } = {}
  ): Promise<{ finish(removed: boolean): Promise<void> }> => {
    const gate = acquireWatcherRemovalGate(worktreePath, connectionId)
    const deadline = createWatcherRemovalDeadline(options.budgetMs, options.strict)
    const recover = async (): Promise<void> => {
      gate.release()
      if (options.strict && deadline.hasPendingDrain?.()) {
        // Why: an old close must settle before restoration can install its replacement.
        void deadline
          .settlement?.()
          .then(() => restore(worktreePath, connectionId))
          .catch((error) => console.error('[worktrees] delayed watcher restoration failed', error))
        throw new Error('conditional_worktree_removal_unknown: watcher recovery pending')
      }
      if (options.strict) {
        try {
          const restorationDeadline = createWatcherRemovalDeadline(options.budgetMs, true)
          await drainBeforeWatcherRemoval(
            restore(worktreePath, connectionId, restorationDeadline),
            restorationDeadline,
            `watcher restoration for ${worktreePath}`,
            { required: true }
          )
        } catch (error) {
          throw new Error('conditional_worktree_removal_unknown: watcher restoration failed', {
            cause: error
          })
        }
      } else {
        await restore(worktreePath, connectionId).catch((restoreError: unknown) => {
          console.error('[worktrees] failed to restore watchers after removal failed', {
            worktreePath,
            restoreError
          })
        })
      }
    }
    try {
      await close(worktreePath, connectionId, deadline)
      const fenceDrain = await drainBeforeWatcherRemoval(
        gate.ready,
        deadline,
        `watcher install fence for ${worktreePath}`,
        { required: deadline.strict }
      )
      if (fenceDrain === 'timeout') {
        gate.abandonPendingInstalls()
      }
      await close(worktreePath, connectionId, deadline)
      let finishPromise: Promise<void> | undefined
      return {
        finish: (removed) => {
          finishPromise ??= (async () => {
            try {
              if (removed) {
                forget(worktreePath, connectionId)
              }
            } finally {
              gate.release()
            }
            if (!removed) {
              await recover()
            }
          })()
          return finishPromise
        }
      }
    } catch (error) {
      await recover()
      throw error
    }
  }

  return { close, restore, forget, acquire }
}
