import { RuntimeClientError } from './runtime-client'

export function parseTerminalCreateEnvJson(
  value: string | undefined
): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (Buffer.byteLength(value, 'utf8') > 16 * 1024) {
    throw new RuntimeClientError('invalid_argument', '--env-json must be at most 16 KiB')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new RuntimeClientError('invalid_argument', '--env-json must be a JSON object')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RuntimeClientError('invalid_argument', '--env-json must be a JSON object')
  }
  const env: Record<string, string> = {}
  for (const [key, entry] of Object.entries(parsed)) {
    // Why: the startup opt-out does not authorize overriding pane identity or evidence.
    if (key !== 'SETTINGS_AUTO_SYNC') {
      throw new RuntimeClientError('invalid_argument', '--env-json only supports SETTINGS_AUTO_SYNC')
    }
    if (entry !== '0' && entry !== '1') {
      throw new RuntimeClientError(
        'invalid_argument',
        '--env-json SETTINGS_AUTO_SYNC must be the string 0 or 1'
      )
    }
    env[key] = entry
  }
  return env
}
