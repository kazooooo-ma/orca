import { beforeEach, describe, expect, it, vi } from 'vitest'
import { beginTerminalInstall } from '../ipc/watcher-removal-gate'
import { createRuntimeFileWatcherRemoval } from './runtime-file-watcher-removal'
import { removeRuntimeRegisteredLocalWorktree } from './runtime-registered-local-worktree-removal'

const effects = vi.hoisted(() => ({
  remove: vi.fn(),
  linked: vi.fn(),
  hook: vi.fn(),
  recover: vi.fn(),
  orphan: vi.fn(),
  pending: false,
  archive: false,
  links: [] as string[],
  deleted: false
}))
vi.mock('../git/worktree', () => ({
  assertWorktreeCleanForRemoval: async () => {},
  listWorktreesStrict: async () => [{ path: '/repo/wt' }],
  removeWorktree: effects.remove
}))
vi.mock('../git/runner', () => ({ gitExecFileAsync: vi.fn() }))
vi.mock('../git/worktree-shared-directories', () => ({
  getWorktreeSharedLinkPaths: () => effects.links
}))
vi.mock('../hooks', () => ({
  getEffectiveHooks: () => (effects.archive ? { scripts: { archive: 'script' } } : undefined),
  runHook: effects.hook
}))
vi.mock('../ipc/worktree-symlinks', () => ({
  findExistingWorktreeSymlinkPaths: async () => [],
  removeWorktreeLinkedPaths: effects.linked
}))
vi.mock('../ipc/worktree-remote', () => ({ cleanupUnusedWorktreePushTargetRemote: async () => {} }))
vi.mock('../ipc/worktree-change-invalidators', () => ({ runWorktreeChangeInvalidators: () => {} }))
vi.mock('../ipc/worktree-logic', () => ({
  formatWorktreeRemovalError: String,
  isOrphanCompatiblePreflightError: () => false,
  isOrphanedWorktreeError: () => true
}))
vi.mock('../local-orphaned-worktree-cleanup', () => ({
  cleanupLocalOrphanedWorktreeDirectory: effects.orphan
}))
vi.mock('../local-worktree-removal-recovery', () => ({
  recoverLocalWindowsWorktreeRemoval: effects.recover
}))
vi.mock('../worktree-removal-safety', () => ({
  findRegisteredDeletableWorktree: () => ({ path: '/repo/wt', head: 'h', isMainWorktree: false })
}))
vi.mock('../worktree-background-removal', () => ({
  waitForPendingWorktreeRemoval: () => (effects.pending ? Promise.resolve({}) : undefined),
  removesInBackground: () => true,
  startBackgroundWorktreeRemoval: vi.fn()
}))

function fixture() {
  const watchers = createRuntimeFileWatcherRemoval({
    closeFileExplorerWatchersForPath: async () => {},
    restoreFileExplorerWatchersAfterFailedRemoval: async () => {},
    forgetFileExplorerWatchersAfterRemoval: () => {}
  })
  const stop = vi.fn(async () => {})
  const condition = vi.fn(async () => {})
  const args = {
    repo: { id: 'repo', path: '/repo' },
    target: { id: 'repo::/repo/wt', repoId: 'repo', path: '/repo/wt' },
    registeredWorktree: { path: '/repo/wt', head: 'h', isMainWorktree: false },
    removedPushTarget: undefined,
    store: {},
    localOptions: {},
    hasLocalOptions: false,
    force: false,
    runHooks: false,
    allowFailedArchiveHook: false,
    allowUnverifiedPtyStop: false,
    deleteBranch: true,
    assertCondition: condition,
    stopPtys: stop,
    closeWatchers: async () => {},
    acquireWatcherRemoval: (path: string) =>
      watchers.acquire(path, undefined, { strict: true, budgetMs: 50 }),
    preserveBranchHead: () => ({}),
    finishRemoval: vi.fn(),
    onRemoved: vi.fn(),
    publish: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: All external effects are mocked; the fixture supplies every field the removal seam reads.
  const removalArgs: Parameters<typeof removeRuntimeRegisteredLocalWorktree>[0] = args as never
  return { args: removalArgs, stop, condition }
}

beforeEach(() => {
  vi.clearAllMocks()
  effects.pending = false
  effects.archive = false
  effects.links = []
  effects.deleted = false
  effects.remove.mockImplementation(async () => {
    effects.deleted = true
    return {}
  })
})

describe('registered local conditional effects', () => {
  it('keeps the gate through completed deletion, checks twice, and never stops absent PTYs', async () => {
    const f = fixture()
    effects.remove.mockImplementation(async () => {
      expect(() => beginTerminalInstall('/repo/wt')).toThrow('being removed')
      effects.deleted = true
      return {}
    })
    await expect(removeRuntimeRegisteredLocalWorktree(f.args)).resolves.toEqual({})
    expect(f.condition).toHaveBeenCalledTimes(2)
    expect(f.stop).not.toHaveBeenCalled()
    expect(effects.remove).toHaveBeenCalledTimes(1)
    beginTerminalInstall('/repo/wt')()
  })

  it.each([1, 2])(
    'refuses a stale condition at checkpoint %i before stop or delete',
    async (checkpoint) => {
      const f = fixture()
      let count = 0
      f.condition.mockImplementation(async () => {
        if (++count === checkpoint) {
          throw new Error('conditional_worktree_removal_refused: stale')
        }
      })
      await expect(removeRuntimeRegisteredLocalWorktree(f.args)).rejects.toThrow('stale')
      expect(f.stop).not.toHaveBeenCalled()
      expect(effects.remove).not.toHaveBeenCalled()
      beginTerminalInstall('/repo/wt')()
    }
  )

  it('drains an admitted spawn before comparing its newly committed raw state', async () => {
    const f = fixture()
    const finishSpawn = beginTerminalInstall('/repo/wt')
    f.condition.mockRejectedValue(
      new Error('conditional_worktree_removal_refused: raw PTY present')
    )
    const removal = removeRuntimeRegisteredLocalWorktree(f.args)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(f.condition).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
    finishSpawn()
    await expect(removal).rejects.toThrow('raw PTY present')
    expect(effects.remove).not.toHaveBeenCalled()
  })

  it('does not continue or delete later after strict drain timeout', async () => {
    const f = fixture()
    const finishSpawn = beginTerminalInstall('/repo/wt')
    await expect(removeRuntimeRegisteredLocalWorktree(f.args)).rejects.toThrow(
      'conditional_worktree_removal_unknown'
    )
    expect(f.condition).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
    expect(effects.remove).not.toHaveBeenCalled()
    finishSpawn()
    await Promise.resolve()
    expect(effects.remove).not.toHaveBeenCalled()
  })

  it.each([
    'pending',
    'archive',
    'links',
    'force',
    'runHooks',
    'allowFailedArchiveHook',
    'allowUnverifiedPtyStop',
    'hasLocalOptions'
  ])('refuses unsupported %s before destructive effects', async (kind) => {
    const f = fixture()
    if (kind === 'pending') {
      effects.pending = true
    } else if (kind === 'archive') {
      effects.archive = true
    } else if (kind === 'links') {
      effects.links = ['linked']
    } else {
      Object.assign(f.args, { [kind]: true })
    }
    await expect(removeRuntimeRegisteredLocalWorktree(f.args)).rejects.toThrow(
      'conditional_worktree_removal_refused'
    )
    expect(f.stop).not.toHaveBeenCalled()
    expect(effects.remove).not.toHaveBeenCalled()
    expect(effects.linked).not.toHaveBeenCalled()
    expect(effects.hook).not.toHaveBeenCalled()
  })

  it('does not run recovery or orphan deletion after a guarded delete failure', async () => {
    const f = fixture()
    effects.remove.mockRejectedValue(new Error('delete failed'))
    await expect(removeRuntimeRegisteredLocalWorktree(f.args)).rejects.toThrow('delete failed')
    expect(effects.recover).not.toHaveBeenCalled()
    expect(effects.orphan).not.toHaveBeenCalled()
    beginTerminalInstall('/repo/wt')()
  })

  it('reports unknown recovery after refusal without stopping or deleting', async () => {
    const f = fixture()
    f.condition.mockRejectedValue(new Error('stale'))
    f.args.acquireWatcherRemoval = async () => ({
      finish: async () => {
        throw new Error('conditional_worktree_removal_unknown: restoration failed')
      }
    })
    await expect(removeRuntimeRegisteredLocalWorktree(f.args)).rejects.toThrow(
      'conditional_worktree_removal_unknown'
    )
    expect(f.stop).not.toHaveBeenCalled()
    expect(effects.remove).not.toHaveBeenCalled()
  })

  it('keeps the manual stop and background acceptance contract', async () => {
    const f = fixture()
    delete f.args.assertCondition
    f.args.acquireWatcherRemoval = async () => ({ finish: async () => {} })
    await expect(removeRuntimeRegisteredLocalWorktree(f.args)).resolves.toMatchObject({
      removing: true
    })
    expect(f.stop).toHaveBeenCalledTimes(1)
  })
})
