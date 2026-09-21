import { describe, expect, it } from 'vitest'

import { mockCollectionInfo, mockFetchAll } from './mock'
import { COLLECTIONS, matchesQuery, strOf, tenantOf, textOf } from './qdrant'

describe('mock store', () => {
  it('serves every known collection', () => {
    for (const c of COLLECTIONS) {
      expect(mockFetchAll(c).length).toBeGreaterThan(0)
    }
  })

  it('reports a point count matching what it serves', () => {
    for (const c of COLLECTIONS) {
      expect(mockCollectionInfo(c).points).toBe(mockFetchAll(c).length)
    }
  })

  it('uses unique point ids, so React keys stay stable', () => {
    for (const c of COLLECTIONS) {
      const ids = mockFetchAll(c).map(p => p.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('carries the mem0 payload fields the viewer reads', () => {
    for (const p of mockFetchAll('mem0')) {
      expect(p.payload).toHaveProperty('data')
    }
    const withTenant = mockFetchAll('mem0').filter(p => tenantOf(p).userId !== '(none)')
    expect(withTenant.length).toBeGreaterThan(3)
  })

  it('includes the awkward cases the UI has to survive', () => {
    const points = mockFetchAll('mem0')
    // An empty memory text.
    expect(points.some(p => textOf(p) === '')).toBe(true)
    // A point with no user_id/agent_id at all.
    expect(points.some(p => tenantOf(p).userId === '(none)')).toBe(true)
    // A memory long enough to wrap well past one line.
    expect(points.some(p => textOf(p).length > 400)).toBe(true)
    // More than one profile, so the rail has something to show.
    expect(new Set(points.map(p => tenantOf(p).userId)).size).toBeGreaterThan(2)
  })

  it('holds invented content only — the profile set is a known allowlist', () => {
    // An allowlist rather than a denylist of real names: it catches a newly
    // added fixture that drags real data in, and it keeps the author's private
    // profile names out of a public repo.
    const users = new Set<string>()
    const agents = new Set<string>()
    const migrated = new Set<string>()
    for (const p of mockFetchAll('mem0')) {
      const t = tenantOf(p)
      users.add(t.userId)
      agents.add(t.agentId)
      const m = strOf(p, 'migrated_from')
      if (m) migrated.add(m)
    }
    expect([...users].sort()).toEqual(['(none)', 'acme-labs', 'demo-local', 'sample-user'])
    expect([...agents].sort()).toEqual([
      '(none)',
      'assistant',
      'researcher',
      'support-bot',
      'web'
    ])
    expect([...migrated]).toEqual(['legacy-export-v2'])
  })

  it('is searchable with the same predicate the live store uses', () => {
    const points = mockFetchAll('mem0')
    expect(points.filter(p => matchesQuery(p, 'postgres')).length).toBeGreaterThan(0)
    expect(points.filter(p => matchesQuery(p, 'zzz-not-present')).length).toBe(0)
  })

  it('mirrors how mem0 actually sets role and attributed_to', () => {
    // Across a real 1.4k-point store these two are mutually exclusive: a point
    // carries one or the other, never both. The fixture keeps that shape so it
    // exercises the same rendering path live data does.
    for (const p of mockFetchAll('mem0')) {
      const both = strOf(p, 'attributed_to') !== '' && strOf(p, 'role') !== ''
      expect(both).toBe(false)
    }
    expect(mockFetchAll('mem0').some(p => strOf(p, 'role') !== '')).toBe(true)
    expect(mockFetchAll('mem0').some(p => strOf(p, 'attributed_to') !== '')).toBe(true)
  })
})
