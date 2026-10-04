/** Early refusal under the existing raw-install fence; not an all-writer atomic delete. */
export type ConditionalWorktreeRemoval = {
  runtimeId: string
  hostId: 'local'
  worktreeId: string
  repoId: string
  path: string
  instanceId: string
  lastActivityAt: number
  isActive: false
  hasAttachedPty: false
}
