/**
 * The payload is a contract with a client that ships separately, so these are
 * byte-for-byte assertions rather than shape assertions. A test that only
 * checked "contains the token" would pass for a link the phone refuses.
 */

import { describe, expect, it } from 'vitest'

import { buildAccessLink, describeAccessLink, isLoopbackServer, normalizeServer } from './accessLink'

const SERVER = 'http://192.0.2.10:8000'
const TOKEN = 'r4nd0m-t0ken_value'
const LINK = `krobi://acceso?server=http%3A%2F%2F192.0.2.10%3A8000&access_token=${TOKEN}`

describe('buildAccessLink', () => {
  it('produces the exact string the phone parses', () => {
    expect(buildAccessLink(SERVER, TOKEN)).toBe(LINK)
  })

  it('puts the action in the authority, not the path', () => {
    // Three slashes would move `acceso` into the path, and the phone accepts
    // only the authority form. This is the assertion that catches a rewrite of
    // the builder that "looks the same".
    expect(buildAccessLink(SERVER, TOKEN)).toContain('krobi://acceso?')
    expect(buildAccessLink(SERVER, TOKEN)).not.toContain('krobi:///')
  })

  it('normalises the address so two spellings give one link', () => {
    expect(buildAccessLink('  http://192.0.2.10:8000/  ', TOKEN)).toBe(LINK)
    expect(buildAccessLink('192.0.2.10:8000', TOKEN)).toBe(LINK)
    expect(buildAccessLink('http://192.0.2.10:8000///', TOKEN)).toBe(LINK)
  })

  it('escapes a plus rather than letting it decode as a space', () => {
    const link = buildAccessLink(SERVER, 'a+b c')
    expect(link).toContain('access_token=a%2Bb%20c')
    expect(link).not.toContain('a+b')
  })

  it('escapes the characters the built-in encoder leaves alone', () => {
    // Legal in a query, so a URL builder keeps them; but the phone escapes
    // them, and the two payloads have to be the same string.
    expect(buildAccessLink(SERVER, "!'()*")).toContain('access_token=%21%27%28%29%2A')
  })

  it('refuses an address whose normalisation is not stable', () => {
    // `nonsense://` normalises to `nonsense:`, which a second pass rebuilds as
    // `http://nonsense:`; a link whose recorded and effective addresses differ.
    expect(buildAccessLink('nonsense://', TOKEN)).toBeNull()
  })

  it('refuses a missing half', () => {
    expect(buildAccessLink('', TOKEN)).toBeNull()
    expect(buildAccessLink(SERVER, '   ')).toBeNull()
  })
})

describe('normalizeServer', () => {
  it('assumes http for a bare host so a LAN address does not fail at TLS', () => {
    expect(normalizeServer('192.0.2.10:8000')).toBe('http://192.0.2.10:8000')
    expect(normalizeServer('https://krobi.example/')).toBe('https://krobi.example')
    expect(normalizeServer('   ')).toBe('')
  })
})

describe('describeAccessLink', () => {
  it('names the length and never the token', () => {
    const description = describeAccessLink(SERVER, TOKEN)
    expect(description).toContain(SERVER)
    expect(description).toContain(`${TOKEN.length} caracteres`)
    expect(description).not.toContain(TOKEN)
  })
})

describe('a loopback address', () => {
  it.each(['http://127.0.0.1:8000', '127.0.0.1:8000', 'http://127.4.5.6:8000', 'http://localhost:8000', 'http://[::1]:8000'])(
    'is refused for %s: a phone scanning it would reach itself',
    (server) => {
      expect(buildAccessLink(server, TOKEN)).toBeNull()
      expect(isLoopbackServer(server)).toBe(true)
    },
  )

  it('does not refuse a LAN address', () => {
    expect(isLoopbackServer('http://192.168.1.20:8000')).toBe(false)
    expect(buildAccessLink('http://192.168.1.20:8000', TOKEN)).not.toBeNull()
  })
})
