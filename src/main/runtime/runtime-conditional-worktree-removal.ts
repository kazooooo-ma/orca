import type { ConditionalWorktreeRemoval } from '../../shared/worktree/conditional-removal'
import type { RuntimeWorktreePsResult } from '../../shared/runtime-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { PtyProcessInfo } from '../providers/types'
import type { RemoveManagedWorktreeOptions } from './runtime-worktree-selection'
import type { RuntimeWorktreeRemovalTarget } from './runtime-worktree-selection'
import type { Repo } from '../../shared/repo-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'

export function refuseConditionalWorktreeRemoval(reason: string): never {
  throw new Error(`conditional_worktree_removal_refused: ${reason}`)
}

export function refuseConditionalRemovalFallback(
  expected: ConditionalWorktreeRemoval | undefined,
  fallback: 'pending' | 'unregistered' | 'stale' | 'remote'
): void {
  if (expected) {
    const reasons = {
      pending: 'an existing background removal cannot inherit this condition',
      unregistered: 'unregistered worktree or retry is unsupported',
      stale: 'stale registration recovery is unsupported',
      remote: 'remote removal is unsupported'
    }
    refuseConditionalWorktreeRemoval(reasons[fallback])
  }
}

export function assertConditionalRemovalTarget(
  expected: ConditionalWorktreeRemoval | undefined,
  target: RuntimeWorktreeRemovalTarget
): void {
  if (
    expected &&
    (target.id !== expected.worktreeId ||
      target.repoId !== expected.repoId ||
      target.path !== expected.path)
  ) {
    refuseConditionalWorktreeRemoval('resolved target changed')
  }
}

export function assertConditionalRemovalRepo(
  expected: ConditionalWorktreeRemoval | undefined,
  repo: Repo | undefined
): void {
  if (expected && (!repo || getRepoExecutionHostId(repo) !== 'local')) {
    refuseConditionalWorktreeRemoval('only registered local Git worktrees are supported')
  }
}

export function snapshotConditionalWorktreeRemoval(options: RemoveManagedWorktreeOptions) {
  const expected = options.conditional
  if (!expected) {
    return undefined
  }
  if (
    options.force ||
    options.runHooks ||
    options.allowUnverifiedPtyStop ||
    options.allowFailedArchiveHook
  ) {
    refuseConditionalWorktreeRemoval('force, hooks and stop waivers are unsupported')
  }
  if (options.hostId !== 'local' || expected.hostId !== 'local') {
    refuseConditionalWorktreeRemoval('an explicit local host is required')
  }
  if (
    [
      expected.runtimeId,
      expected.worktreeId,
      expected.repoId,
      expected.path,
      expected.instanceId
    ].some((value) => typeof value !== 'string' || !value.trim()) ||
    !Number.isFinite(expected.lastActivityAt) ||
    expected.isActive !== false ||
    expected.hasAttachedPty !== false
  ) {
    refuseConditionalWorktreeRemoval('incomplete expected identity or state')
  }
  return Object.freeze({ ...expected })
}

export async function assertConditionalWorktreeRemoval(args: {
  expected: ConditionalWorktreeRemoval
  runtimeId: string
  readPs: () => Promise<RuntimeWorktreePsResult>
  readRawPtys: () => Promise<PtyProcessInfo[]>
  readMeta: () => WorktreeMeta | undefined
  readActiveWorktreeId: () => string | null | undefined
}): Promise<void> {
  const { expected } = args
  if (args.runtimeId !== expected.runtimeId) {
    refuseConditionalWorktreeRemoval('runtime identity changed')
  }
  const inventory = await args.readRawPtys()
  if (!Array.isArray(inventory)) {
    refuseConditionalWorktreeRemoval('raw PTY inventory is unproved')
  }
  for (const pty of inventory) {
    if (!pty || (!pty.worktreeId && !pty.cwd)) {
      refuseConditionalWorktreeRemoval('raw PTY ownership is unproved')
    }
    if (
      (pty.worktreeId && runtimeWorktreeIdsEqual(pty.worktreeId, expected.worktreeId)) ||
      (pty.cwd && isPathInsideOrEqual(expected.path, pty.cwd))
    ) {
      refuseConditionalWorktreeRemoval('raw PTY is present')
    }
  }
  const ps = await args.readPs()
  if (!ps || !Array.isArray(ps.worktrees)) {
    refuseConditionalWorktreeRemoval('native state is unproved')
  }
  const rows = ps.worktrees.filter(
    (row) => row.worktreeId === expected.worktreeId && row.hostId === 'local'
  )
  if (ps.truncated !== false || rows.length !== 1) {
    refuseConditionalWorktreeRemoval('native state is incomplete or ambiguous')
  }
  const row = rows[0]
  const meta = args.readMeta()
  const activeId = args.readActiveWorktreeId()
  if (
    row.repoId !== expected.repoId ||
    row.path !== expected.path ||
    row.workspaceKind !== 'git' ||
    row.isMainWorktree !== false ||
    row.worktreeInstanceId !== expected.instanceId ||
    meta?.hostId !== 'local' ||
    meta.instanceId !== expected.instanceId ||
    meta.lastActivityAt !== expected.lastActivityAt ||
    row.lastActivityAt !== expected.lastActivityAt
  ) {
    refuseConditionalWorktreeRemoval('worktree identity or activity changed')
  }
  if (
    activeId === undefined ||
    (activeId && runtimeWorktreeIdsEqual(activeId, expected.worktreeId)) ||
    row.isActive !== false ||
    row.hasAttachedPty !== false ||
    row.liveTerminalCount !== 0 ||
    row.status !== 'inactive' ||
    !Array.isArray(row.agents) ||
    row.agents.length !== 0
  ) {
    refuseConditionalWorktreeRemoval('worktree is active or execution state is unproved')
  }
}
