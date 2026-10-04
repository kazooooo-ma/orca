import { describe, expect, it, vi } from 'vitest'
import { WorktreeRemove } from '../../shared/rpc-contract/worktree-params'
import type { ConditionalWorktreeRemoval } from '../../shared/worktree/conditional-removal'
import {
  assertConditionalWorktreeRemoval,
  snapshotConditionalWorktreeRemoval
} from './runtime-conditional-worktree-removal'
import { getRuntimeWorktreeRemovalOptionsKey } from './runtime-worktree-selection'

const expected: ConditionalWorktreeRemoval = {
  runtimeId: 'runtime-1',
  hostId: 'local',
  worktreeId: 'repo::/repo/wt',
  repoId: 'repo',
  path: '/repo/wt',
  instanceId: 'instance-1',
  lastActivityAt: 10,
  isActive: false,
  hasAttachedPty: false
}

function state() {
  const row = {
    workspaceKind: 'git',
    worktreeId: expected.worktreeId,
    repoId: expected.repoId,
    hostId: 'local',
    path: expected.path,
    isMainWorktree: false,
    worktreeInstanceId: expected.instanceId,
    lastActivityAt: 10,
    isActive: false,
    hasAttachedPty: false,
    liveTerminalCount: 0,
    status: 'inactive',
    agents: []
  }
  const meta = { hostId: 'local', instanceId: expected.instanceId, lastActivityAt: 10 }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mock supplies every field the conditional seam reads.
  const readPs = vi.fn(async () => ({ worktrees: [row], truncated: false }) as never)
  const args = {
    expected,
    runtimeId: 'runtime-1',
    readPs,
    readRawPtys: vi.fn(async () => []),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Metadata is synthetic and contains all fields read by the guard.
    readMeta: () => meta as never,
    readActiveWorktreeId: () => null
  }
  return { args, row, meta }
}

describe('restricted conditional removal contract', () => {
  it('preserves the manual schema and accepts the complete restricted request', () => {
    expect(WorktreeRemove.parse({ worktree: 'id:x' })).toEqual({ worktree: 'id:x' })
    expect(WorktreeRemove.parse({ worktree: 'id:x', conditional: expected }).conditional).toEqual(
      expected
    )
  })

  it.each(['runtimeId', 'instanceId', 'lastActivityAt', 'isActive', 'hasAttachedPty'])(
    'rejects an incomplete condition: %s',
    (field) => {
      const missing = { ...expected }
      Reflect.deleteProperty(missing, field)
      expect(WorktreeRemove.safeParse({ worktree: 'id:x', conditional: missing }).success).toBe(
        false
      )
    }
  )

  it.each(['force', 'runHooks', 'allowUnverifiedPtyStop', 'allowFailedArchiveHook'])(
    'refuses the incompatible option: %s',
    (field) => {
      expect(() =>
        snapshotConditionalWorktreeRemoval({
          hostId: 'local',
          conditional: expected,
          [field]: true
        })
      ).toThrow('unsupported')
    }
  )

  it('requires local host and freezes the flight condition independently of its caller', () => {
    expect(() => snapshotConditionalWorktreeRemoval({ conditional: expected })).toThrow(
      'explicit local'
    )
    const input = { ...expected }
    const snapshot = snapshotConditionalWorktreeRemoval({ hostId: 'local', conditional: input })
    input.instanceId = 'mutated'
    expect(snapshot?.instanceId).toBe('instance-1')
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('separates manual, same-condition and stale-condition in-flight keys', () => {
    const guarded = getRuntimeWorktreeRemovalOptionsKey({ conditional: expected })
    expect(getRuntimeWorktreeRemovalOptionsKey({})).not.toBe(guarded)
    expect(getRuntimeWorktreeRemovalOptionsKey({ conditional: { ...expected } })).toBe(guarded)
    expect(
      getRuntimeWorktreeRemovalOptionsKey({ conditional: { ...expected, instanceId: 'other' } })
    ).not.toBe(guarded)
  })

  it('accepts an empty execution inventory and exact native state', async () => {
    await expect(assertConditionalWorktreeRemoval(state().args)).resolves.toBeUndefined()
  })

  it.each([
    { worktreeInstanceId: 'other' },
    { path: '/other' },
    { repoId: 'other' },
    { lastActivityAt: 11 },
    { hostId: 'ssh:x' },
    { isActive: true },
    { hasAttachedPty: true },
    { liveTerminalCount: 1 },
    { status: 'working' },
    { workspaceKind: 'folder-workspace' },
    { isMainWorktree: true }
  ])('refuses native identity/state drift %j', async (change) => {
    const s = state()
    Object.assign(s.row, change)
    await expect(assertConditionalWorktreeRemoval(s.args)).rejects.toThrow(
      'conditional_worktree_removal_refused'
    )
  })

  it('rechecks live metadata after the asynchronous native read', async () => {
    const s = state()
    s.args.readPs.mockImplementation(async () => {
      s.meta.instanceId = 'recreated'
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies all guard fields.
      return { worktrees: [s.row], truncated: false } as never
    })
    await expect(assertConditionalWorktreeRemoval(s.args)).rejects.toThrow(
      'identity or activity changed'
    )
  })

  it('refuses changed runtime, unknown session and an activated target', async () => {
    const s = state()
    await expect(
      assertConditionalWorktreeRemoval({ ...s.args, runtimeId: 'other' })
    ).rejects.toThrow('runtime identity')
    await expect(
      assertConditionalWorktreeRemoval({ ...s.args, readActiveWorktreeId: () => undefined })
    ).rejects.toThrow('unproved')
    await expect(
      assertConditionalWorktreeRemoval({
        ...s.args,
        readActiveWorktreeId: () => expected.worktreeId
      })
    ).rejects.toThrow('active')
  })

  it.each([
    { inventory: [{ id: 'raw', cwd: '/elsewhere', worktreeId: expected.worktreeId, title: '' }] },
    { inventory: [{ id: 'raw', cwd: '/repo/wt/sub', title: '' }] },
    { inventory: [{ id: 'unknown', cwd: '', title: '' }] }
  ])('refuses present or unproved raw inventory %j', async ({ inventory }) => {
    await expect(
      assertConditionalWorktreeRemoval({ ...state().args, readRawPtys: async () => inventory })
    ).rejects.toThrow('conditional_worktree_removal_refused')
  })

  it('propagates inventory failure and incomplete native listing', async () => {
    const s = state()
    await expect(
      assertConditionalWorktreeRemoval({
        ...s.args,
        readRawPtys: async () => {
          throw new Error('inventory unavailable')
        }
      })
    ).rejects.toThrow('inventory unavailable')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: A deliberately truncated synthetic read verifies refusal.
    s.args.readPs.mockResolvedValue({ worktrees: [s.row], truncated: true } as never)
    await expect(assertConditionalWorktreeRemoval(s.args)).rejects.toThrow('incomplete')
  })
})
