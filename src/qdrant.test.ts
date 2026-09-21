import { describe, expect, it } from 'vitest'

import {
  badgesOf,
  filterPoints,
  fold,
  formatWhen,
  groupTenants,
  matchesQuery,
  searchHay,
  tenantKey,
  textOf
} from './qdrant'
import type { MemPoint } from './qdrant'

const point = (
  id: string,
  payload: Record<string, unknown> = {}
): MemPoint => ({ id, payload })

const alice = point('p1', {
  data: 'Deploys Postgres behind a reverse proxy',
  user_id: 'alice',
  agent_id: 'ops',
  channel: 'cli',
  hash: 'abc123',
  created_at: '2026-09-18T08:41:12.000Z'
})

describe('textOf', () => {
  it('reads the mem0 payload field named data', () => {
    expect(textOf(alice)).toBe('Deploys Postgres behind a reverse proxy')
  })

  it('returns empty string when the payload has no data', () => {
    expect(textOf(point('p2'))).toBe('')
  })

  it('stringifies non-string data rather than dropping it', () => {
    expect(textOf(point('p3', { data: 42 }))).toBe('42')
  })
})

describe('groupTenants', () => {
  it('groups by the user_id/agent_id pair and sorts by count', () => {
    const tenants = groupTenants([
      point('a', { user_id: 'alice', agent_id: 'ops' }),
      point('b', { user_id: 'alice', agent_id: 'ops' }),
      point('c', { user_id: 'bob', agent_id: 'web' })
    ])
    expect(tenants.map(t => [t.userId, t.agentId, t.count])).toEqual([
      ['alice', 'ops', 2],
      ['bob', 'web', 1]
    ])
  })

  it('keeps the same user under different agents apart', () => {
    const tenants = groupTenants([
      point('a', { user_id: 'alice', agent_id: 'ops' }),
      point('b', { user_id: 'alice', agent_id: 'web' })
    ])
    expect(tenants).toHaveLength(2)
  })

  it('labels a missing id as (none) and still groups those points together', () => {
    const tenants = groupTenants([point('a'), point('b', { user_id: 'alice' })])
    expect(tenants.map(t => [t.userId, t.agentId])).toEqual([
      ['(none)', '(none)'],
      ['alice', '(none)']
    ])
  })
})

describe('tenantKey', () => {
  it('is stable across points in the same tenant', () => {
    expect(tenantKey(alice)).toBe(tenantKey(point('other', { user_id: 'alice', agent_id: 'ops' })))
  })

  it('does not collide when ids contain the separator or slashes', () => {
    const a = point('a', { user_id: 'x/', agent_id: 'y' })
    const b = point('b', { user_id: 'x', agent_id: '/y' })
    expect(tenantKey(a)).not.toBe(tenantKey(b))
  })
})

describe('searchHay', () => {
  it('covers text, profile, id, channel and hash, lowercased', () => {
    const hay = searchHay(alice)
    for (const needle of [
      'postgres',
      'alice',
      'ops',
      'cli',
      'abc123',
      'p1'
    ]) {
      expect(hay).toContain(needle)
    }
    expect(hay).toBe(hay.toLowerCase())
  })
})

describe('matchesQuery', () => {
  it('matches everything on an empty or whitespace query', () => {
    expect(matchesQuery(alice, '')).toBe(true)
    expect(matchesQuery(alice, '   ')).toBe(true)
  })

  it('is case-insensitive and matches on substrings', () => {
    expect(matchesQuery(alice, 'POSTGRES')).toBe(true)
    expect(matchesQuery(alice, 'stgre')).toBe(true)
  })

  it('matches identifying fields, not only the memory text', () => {
    expect(matchesQuery(alice, 'cli')).toBe(true)
    expect(matchesQuery(alice, 'abc123')).toBe(true)
  })

  it('rejects a term that is absent', () => {
    expect(matchesQuery(alice, 'mysql')).toBe(false)
  })

  it('does not throw on regex metacharacters in the query', () => {
    for (const q of ['(', '[', '*', '\\', '?', '$^']) {
      expect(() => matchesQuery(alice, q)).not.toThrow()
      expect(matchesQuery(alice, q)).toBe(false)
    }
  })
})

describe('filterPoints', () => {
  const points = [
    alice,
    point('p2', { data: 'Notes about the release', user_id: 'bob', agent_id: 'web' })
  ]

  it('returns everything when neither filter is set', () => {
    expect(filterPoints(points, '', '')).toHaveLength(2)
  })

  it('applies the tenant filter', () => {
    expect(filterPoints(points, '', tenantKey(alice)).map(p => p.id)).toEqual(['p1'])
  })

  it('applies tenant and query together', () => {
    expect(filterPoints(points, 'release', tenantKey(alice))).toEqual([])
    expect(filterPoints(points, 'release', tenantKey(points[1]))).toHaveLength(1)
  })
})

describe('badgesOf', () => {
  it('shows attributed_to and role as bare values, and labels the rest', () => {
    const b = badgesOf(
      point('p', {
        channel: 'cli',
        attributed_to: 'assistant',
        migrated_from: 'export'
      })
    )
    expect(b.map(x => x.label)).toEqual([
      'channel:cli',
      'assistant',
      'migrated_from:export'
    ])
  })

  it('omits fields the payload does not carry', () => {
    expect(badgesOf(point('p', { data: 'x' })).map(b => b.label)).toEqual([])
  })

  it('treats an empty string as absent', () => {
    expect(badgesOf(point('p', { channel: '', role: 'user' })).map(b => b.label)).toEqual([
      'user'
    ])
  })

  it('collapses identical bare labels to a single chip', () => {
    // A guard, not an observed mem0 case: real stores set role and
    // attributed_to exclusively. If some other version sets both to the same
    // word, the row shows one chip rather than two identical ones, and the
    // expandable payload panel is where both fields stay visible.
    const b = badgesOf(point('p', { attributed_to: 'user', role: 'user' }))
    expect(b.map(x => x.label)).toEqual(['user'])
  })

  it('does not collapse fields whose labels differ', () => {
    const b = badgesOf(point('p', { channel: 'user', role: 'user' }))
    expect(b.map(x => x.label)).toEqual(['channel:user', 'user'])
  })
})

describe('fold', () => {
  it('lowercases for matching', () => {
    expect(fold('POSTGRES Deploys')).toBe('postgres deploys')
  })

  it('preserves length for characters whose lowercase form is longer', () => {
    // U+0130 (İ) lowercases to two code units. Highlight maps offsets from the
    // folded string back onto the original, so a length shift would mark the
    // wrong span.
    const s = 'İİpostgres'
    expect(fold(s)).toHaveLength(s.length)
  })

  it('round-trips length for a wide sample, so offsets stay valid', () => {
    for (const s of [
      '',
      'plain ascii',
      'İstanbul İİ',
      'ÄÖÜ ß ẞ',
      'Ωμέγα ΣΙΓΜΑ',
      'ﬁ ligature',
      'İ'.repeat(50)
    ]) {
      expect(fold(s)).toHaveLength(s.length)
    }
  })

  it('still matches the folded form of a plain query', () => {
    expect(fold('Telegram')).toBe('telegram')
  })
})

describe('formatWhen', () => {
  it('formats a valid timestamp without dropping it', () => {
    const out = formatWhen('2026-09-18T08:41:12.000Z')
    expect(out).not.toBe('')
    expect(out).not.toContain('T')
  })

  it('passes unparseable values through verbatim', () => {
    expect(formatWhen('sometime last tuesday')).toBe('sometime last tuesday')
  })

  it('returns empty string for an absent timestamp', () => {
    expect(formatWhen('')).toBe('')
  })

  it('honours an explicit locale', () => {
    // Must distinguish locales, not merely contain a digit that any format
    // happens to include — otherwise dropping the argument would still pass.
    const gb = formatWhen('2026-09-18T08:41:12.000Z', 'en-GB')
    const us = formatWhen('2026-09-18T08:41:12.000Z', 'en-US')
    expect(gb).not.toBe(us)
  })
})
