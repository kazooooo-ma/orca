import type { ExecutionHostId } from '../../shared/execution-host'
import type { ConditionalWorktreeRemoval } from '../../shared/worktree/conditional-removal'
import type { RuntimeWorktreePsResult } from '../../shared/runtime-types'
import type { IPtyProvider } from '../providers/types'
import type { RuntimePreservedBranchCleanup } from './runtime-preserved-branch-cleanup'
import type { createRuntimeFileWatcherRemoval } from './runtime-file-watcher-removal'
import { resolveWorktreeRemovalMetadata } from '../worktree-removal-repo-owner'
import { removeRuntimeRegisteredLocalWorktree } from './runtime-registered-local-worktree-removal'
import {
  assertConditionalWorktreeRemoval,
  refuseConditionalWorktreeRemoval
} from './runtime-conditional-worktree-removal'

type RemovalArgs = Parameters<typeof removeRuntimeRegisteredLocalWorktree>[0]
type RemovalRequestHost = {
  getRuntimeId(): string
  getWorktreePs(limit: number): Promise<RuntimeWorktreePsResult>
  getLocalProvider(): IPtyProvider | null
  acquireFileWatcherRemoval: ReturnType<typeof createRuntimeFileWatcherRemoval>['acquire']
  stopPtysForDestructiveWorktreeRemoval(
    worktreeId: string,
    options: { allowUnverifiedStop: boolean }
  ): Promise<void>
  closeFileWatchersForRemoval(path: string): Promise<void>
  preservedBranchCleanup: Pick<
    RuntimePreservedBranchCleanup,
    'remember' | 'delete' | 'preserveHead'
  >
  publishWorktreeRemovalChange(repoId: string): void
}

export function removeRuntimeRegisteredLocalWorktreeRequest(
  args: Pick<
    RemovalArgs,
    | 'repo'
    | 'target'
    | 'registeredWorktree'
    | 'removedPushTarget'
    | 'store'
    | 'localOptions'
    | 'force'
    | 'runHooks'
    | 'allowFailedArchiveHook'
    | 'allowUnverifiedPtyStop'
    | 'deleteBranch'
  > & {
    runtime: RemovalRequestHost
    conditional?: ConditionalWorktreeRemoval
    cleanupHostId?: ExecutionHostId
    purgeRemovedWorktree: () => void
    onRemoved: () => void
  }
) {
  const { runtime, conditional, target, store, cleanupHostId, removedPushTarget } = args
  return removeRuntimeRegisteredLocalWorktree({
    ...args,
    hasLocalOptions: Object.keys(args.localOptions).length > 0,
    ...(conditional
      ? {
          assertCondition: () =>
            assertConditionalWorktreeRemoval({
              expected: conditional,
              runtimeId: runtime.getRuntimeId(),
              readPs: () => runtime.getWorktreePs(Number.MAX_SAFE_INTEGER),
              readRawPtys: () => {
                const provider = runtime.getLocalProvider()
                if (!provider) {
                  refuseConditionalWorktreeRemoval('raw PTY provider unavailable')
                }
                return provider.listProcesses()
              },
              readMeta: () =>
                resolveWorktreeRemovalMetadata(store, target.repoId, target.id, 'local'),
              readActiveWorktreeId: () => store.getWorkspaceSession?.('local')?.activeWorktreeId
            })
        }
      : {}),
    acquireWatcherRemoval: conditional
      ? (path) => runtime.acquireFileWatcherRemoval(path, undefined, { strict: true })
      : runtime.acquireFileWatcherRemoval,
    stopPtys: () =>
      runtime.stopPtysForDestructiveWorktreeRemoval(target.id, {
        allowUnverifiedStop: args.allowUnverifiedPtyStop
      }),
    closeWatchers: (path) => runtime.closeFileWatchersForRemoval(path),
    preserveBranchHead: (result, fallbackHead) =>
      runtime.preservedBranchCleanup.preserveHead(result, fallbackHead),
    finishRemoval: (result, rememberBranch, fallbackHead) => {
      if (rememberBranch) {
        runtime.preservedBranchCleanup.remember(
          target.id,
          cleanupHostId,
          result,
          fallbackHead,
          removedPushTarget
        )
      } else {
        runtime.preservedBranchCleanup.delete(target.id, cleanupHostId)
      }
      args.purgeRemovedWorktree()
    },
    publish: () => runtime.publishWorktreeRemovalChange(args.repo.id)
  })
}
