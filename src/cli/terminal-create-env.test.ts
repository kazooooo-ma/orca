import { describe, expect, it } from 'vitest'
import { parseTerminalCreateEnvJson } from './terminal-create-env'

describe('terminal create startup environment', () => {
  it('preserves the default payload when the flag is absent', () => {
    expect(parseTerminalCreateEnvJson(undefined)).toBeUndefined()
  })

  it('accepts the explicit startup sync policy as strings', () => {
    expect(parseTerminalCreateEnvJson('{"SETTINGS_AUTO_SYNC":"0"}')).toEqual({
      SETTINGS_AUTO_SYNC: '0'
    })
    expect(parseTerminalCreateEnvJson('{"SETTINGS_AUTO_SYNC":"1"}')).toEqual({
      SETTINGS_AUTO_SYNC: '1'
    })
    expect(parseTerminalCreateEnvJson('{}')).toEqual({})
  })

  it.each(['', '{', 'null', '[]', 'true', '1', '"value"'])(
    'rejects malformed or non-object JSON without quoting input: %s',
    (value) => {
      expect(() => parseTerminalCreateEnvJson(value)).toThrow('--env-json')
    }
  )

  it.each([0, 1, true, null, {}, [], '', 'false', '0\u0000'])(
    'rejects invalid startup sync values',
    (value) => {
      expect(() => parseTerminalCreateEnvJson(JSON.stringify({ SETTINGS_AUTO_SYNC: value }))).toThrow(
        'SETTINGS_AUTO_SYNC must be the string 0 or 1'
      )
    }
  )

  it.each(['ORCA_TERMINAL_HANDLE', 'ORCA_RUN_ID', 'ORCA_EVIDENCE_ROOT', 'PATH', '__proto__'])(
    'does not expose caller identity or unrelated environment: %s',
    (key) => {
      expect(() => parseTerminalCreateEnvJson(`{"${key}":"private-value"}`)).toThrow(
        'only supports SETTINGS_AUTO_SYNC'
      )
    }
  )

  it('rejects oversized input before parsing it', () => {
    expect(() => parseTerminalCreateEnvJson(' '.repeat(16385))).toThrow('16 KiB')
  })
})
