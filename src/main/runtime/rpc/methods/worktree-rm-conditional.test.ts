import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import { WORKTREE_METHODS } from './worktree'

const conditional = {
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
  const runtime = {
    getRuntimeId: () => 'runtime',
    listRepos: () => [{ id: 'repo', executionHostId: 'local' }],
    showManagedWorktree: vi.fn(async () => ({ hostId: 'local' })),
    removeManagedWorktree: vi.fn(async () => ({}))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The dispatcher mock implements every method used by worktree.rm.
  return {
    runtime,
    dispatcher: new RpcDispatcher({ runtime: runtime as never, methods: WORKTREE_METHODS })
  }
}

describe('conditional removal RPC forwarding', () => {
  it('preserves the restricted condition through the method boundary', async () => {
    const f = fixture()
    const result = await f.dispatcher.dispatch({
      id: 'req',
      authToken: 'tok',
      method: 'worktree.rm',
      params: {
        worktree: `id:${conditional.worktreeId}`,
        hostId: 'local',
        conditional
      }
    })
    expect(result.ok).toBe(true)
    expect(f.runtime.removeManagedWorktree).toHaveBeenCalledWith(
      `id:${conditional.worktreeId}`,
      expect.objectContaining({ hostId: 'local', conditional })
    )
  })

  it('refuses malformed conditions before the removal implementation', async () => {
    const f = fixture()
    const result = await f.dispatcher.dispatch({
      id: 'req',
      authToken: 'tok',
      method: 'worktree.rm',
      params: {
        worktree: 'id:x',
        hostId: 'local',
        conditional: { ...conditional, hasAttachedPty: true }
      }
    })
    expect(result.ok).toBe(false)
    expect(f.runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })
})
