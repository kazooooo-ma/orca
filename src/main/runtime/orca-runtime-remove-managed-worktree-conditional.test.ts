import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeWithRemoveManagedWorktree } from './orca-runtime-remove-managed-worktree'
import { RuntimeWorktreeRemovalInFlight } from './runtime-worktree-removal-in-flight'
import type { ConditionalWorktreeRemoval } from '../../shared/worktree/conditional-removal'

const effect = vi.hoisted(() => ({
  local: vi.fn(),
  orphan: vi.fn(),
  unregistered: vi.fn(),
  stale: vi.fn()
}))
vi.mock('./orca-runtime-create-managed-remote-worktree', () => ({
  OrcaRuntimeWithCreateManagedRemoteWorktree: class {}
}))
vi.mock('../observability/instrumentation', () => ({
  withWorktreeSpan: (_span: unknown, run: () => unknown) => run()
}))
vi.mock('../worktree-removal-execution-host-route', () => ({
  resolveWorktreeRemovalRoute: () => ({ kind: 'local', hostId: 'local' }),
  resolveWorktreeRemovalHome: () => '/home'
}))
vi.mock('./worktree-removal-route-listing', () => ({
  listWorktreesOnRemovalRoute: async () => ({
    localWorktreeGitOptions: {},
    registeredWorktrees: [{ path: '/repo/wt' }]
  })
}))
vi.mock('../worktree-prunable-git-file', () => ({ isPrunableGitFileWorktree: async () => false }))
vi.mock('../worktree-removal-safety', () => ({
  findRegisteredDeletableWorktree: () => ({ path: '/repo/wt', head: 'head', isMainWorktree: false })
}))
vi.mock('./runtime-unregistered-worktree-removal', () => ({
  removeRuntimeUnregisteredWorktree: effect.unregistered
}))
vi.mock('../ipc/worktree-logic', () => ({ formatWorktreeRemovalError: String }))
vi.mock('./runtime-worktree-filesystem', () => ({
  isRuntimeWorktreePathMissing: async () => false
}))
vi.mock('../local-worktree-removal-recovery', () => ({
  removeStaleLocalWorktreeRegistration: effect.stale
}))
vi.mock('../ipc/worktree-remote', () => ({ cleanupUnusedWorktreePushTargetRemote: vi.fn() }))
vi.mock('./runtime-registered-remote-worktree-removal', () => ({
  removeRuntimeRegisteredRemoteWorktree: vi.fn()
}))
vi.mock('./runtime-registered-local-worktree-removal', () => ({
  removeRuntimeRegisteredLocalWorktree: effect.local
}))
vi.mock('./orca-runtime-remove-orphan-or-folder-worktree', () => ({
  removeOrphanOrFolderWorktree: effect.orphan
}))
vi.mock('../remote-worktree-history-cleanup', () => ({ deleteRemoteWorktreeHistory: vi.fn() }))
vi.mock('../worktree-background-removal', () => ({
  finishAcceptedWorktreeRemoval: async (result: unknown) => result
}))

const expected: ConditionalWorktreeRemoval = {
  runtimeId: 'runtime',
  hostId: 'local',
  worktreeId: 'repo::/repo/wt',
  repoId: 'repo',
  path: '/repo/wt',
  instanceId: 'occupant',
  lastActivityAt: 10,
  isActive: false,
  hasAttachedPty: false
}

function fixture() {
  const runtime = Object.create(OrcaRuntimeWithRemoveManagedWorktree.prototype)
  const row = {
    worktreeId: expected.worktreeId,
    repoId: 'repo',
    hostId: 'local',
    path: expected.path,
    workspaceKind: 'git',
    isMainWorktree: false,
    worktreeInstanceId: 'occupant',
    lastActivityAt: 10,
    isActive: false,
    hasAttachedPty: false,
    liveTerminalCount: 0,
    status: 'inactive',
    agents: []
  }
  const meta = { hostId: 'local', instanceId: 'occupant', lastActivityAt: 10 }
  const repo = { id: 'repo', path: '/repo', executionHostId: 'local' }
  Object.assign(runtime, {
    runtimeId: 'runtime',
    getRuntimeId: () => runtime.runtimeId,
    store: {
      getRepos: () => [repo],
      getRepo: () => repo,
      getWorktreeMeta: () => meta,
      getWorkspaceSession: () => ({ activeWorktreeId: null })
    },
    resolveWorktreeRemovalTarget: async () => ({
      id: expected.worktreeId,
      repoId: 'repo',
      path: expected.path
    }),
    joinPendingWorktreeRemoval: vi.fn(() => undefined),
    retryFailedLocalRemoval: vi.fn(() => false),
    removeManagedWorktreeInFlight: new RuntimeWorktreeRemovalInFlight(),
    preservedBranchCleanup: { remember: vi.fn(), delete: vi.fn(), preserveHead: vi.fn() },
    emitWorktreeLifecycle: vi.fn(),
    purgeRemovedWorktree: vi.fn(),
    notifyWorktreesChanged: vi.fn(),
    requireStore: () => runtime.store,
    getWorktreePs: async () => ({ worktrees: [row], truncated: false }),
    getLocalProvider: () => ({ listProcesses: async () => [] }),
    stopPtysForDestructiveWorktreeRemoval: vi.fn(),
    acquireFileWatcherRemoval: vi.fn(),
    closeFileWatchersForRemoval: vi.fn(),
    publishWorktreeRemovalChange: vi.fn()
  })
  return { runtime, row, meta, repo }
}

beforeEach(() => {
  vi.clearAllMocks()
  effect.orphan.mockResolvedValue(null)
  effect.local.mockImplementation(async (args) => {
    await args.assertCondition?.()
    return {}
  })
})

describe('conditional manager joining', () => {
  it('refuses an existing unconditional pending removal before registered effects', async () => {
    const f = fixture()
    f.runtime.joinPendingWorktreeRemoval.mockReturnValue(Promise.resolve({}))
    await expect(
      f.runtime.removeManagedWorktree('id:x', { hostId: 'local', conditional: expected })
    ).rejects.toThrow('cannot inherit')
    expect(effect.local).not.toHaveBeenCalled()
    expect(f.runtime.stopPtysForDestructiveWorktreeRemoval).not.toHaveBeenCalled()
  })

  it('refuses a guarded request that arrives during an unconditional flight', async () => {
    const f = fixture()
    let finish: (() => void) | undefined
    effect.local.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return {}
    })
    const manual = f.runtime.removeManagedWorktree('id:x', { hostId: 'local' })
    await vi.waitFor(() => expect(effect.local).toHaveBeenCalledTimes(1))
    await expect(
      f.runtime.removeManagedWorktree('id:x', { hostId: 'local', conditional: expected })
    ).rejects.toThrow('already in progress')
    expect(effect.local).toHaveBeenCalledTimes(1)
    finish?.()
    await manual
  })

  it('joins the same guarded flight with its frozen condition and refuses manual or stale joins', async () => {
    const f = fixture()
    let finish: (() => void) | undefined
    effect.local.mockImplementation(async (args) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      await args.assertCondition()
      return {}
    })
    const first = f.runtime.removeManagedWorktree('id:x', {
      hostId: 'local',
      conditional: expected
    })
    await vi.waitFor(() => expect(effect.local).toHaveBeenCalledTimes(1))
    const same = f.runtime.removeManagedWorktree('id:x', {
      hostId: 'local',
      conditional: { ...expected }
    })
    await expect(f.runtime.removeManagedWorktree('id:x', { hostId: 'local' })).rejects.toThrow(
      'already in progress'
    )
    await expect(
      f.runtime.removeManagedWorktree('id:x', {
        hostId: 'local',
        conditional: { ...expected, instanceId: 'other' }
      })
    ).rejects.toThrow('already in progress')
    finish?.()
    await Promise.all([first, same])
    expect(effect.local).toHaveBeenCalledTimes(1)
  })

  it('keeps a pending flight condition when caller input is changed while awaiting', async () => {
    const f = fixture()
    const input = { ...expected }
    let finish: (() => void) | undefined
    effect.local.mockImplementation(async (args) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      await args.assertCondition()
      return {}
    })
    const removal = f.runtime.removeManagedWorktree('id:x', { hostId: 'local', conditional: input })
    await vi.waitFor(() => expect(effect.local).toHaveBeenCalledTimes(1))
    input.instanceId = 'replacement'
    f.meta.instanceId = 'replacement'
    const refused = expect(removal).rejects.toThrow('identity or activity changed')
    finish?.()
    await refused
    expect(f.runtime.stopPtysForDestructiveWorktreeRemoval).not.toHaveBeenCalled()
  })

  it('refuses runtime and host drift and bypasses orphan/retry fallbacks', async () => {
    const f = fixture()
    f.runtime.runtimeId = 'changed'
    await expect(
      f.runtime.removeManagedWorktree('id:x', { hostId: 'local', conditional: expected })
    ).rejects.toThrow('runtime identity changed')
    expect(effect.orphan).not.toHaveBeenCalled()
    expect(f.runtime.retryFailedLocalRemoval).not.toHaveBeenCalled()
    f.repo.executionHostId = 'ssh:other'
    await expect(
      f.runtime.removeManagedWorktree('id:x', { hostId: 'local', conditional: expected })
    ).rejects.toThrow('registered local')
    expect(effect.unregistered).not.toHaveBeenCalled()
    expect(effect.stale).not.toHaveBeenCalled()
  })

  it('preserves a manual pending join', async () => {
    const f = fixture()
    f.runtime.joinPendingWorktreeRemoval.mockReturnValue(Promise.resolve({}))
    await expect(
      f.runtime.removeManagedWorktree('id:x', { waitForBackgroundRemoval: true })
    ).resolves.toEqual({})
    expect(effect.local).not.toHaveBeenCalled()
  })
})
