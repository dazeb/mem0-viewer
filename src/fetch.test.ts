import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchAll } from './qdrant'

/**
 * `fetchAll` is the riskiest logic in the app — it drives pagination against a
 * real store and decides when the read is the whole collection. These tests
 * stub `fetch` so the loop can be exercised without Qdrant.
 */

const point = (id: string) => ({ id, payload: { data: `memory ${id}` } })

/** Build a fetch stub from a list of scroll responses, recording each request. */
function stubFetch(pages: unknown[], info = { points_count: 0 }) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  let page = 0
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/points/scroll')) {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      })
      const body = pages[Math.min(page, pages.length - 1)]
      page += 1
      return new Response(JSON.stringify(body), { status: 200 })
    }
    return new Response(JSON.stringify({ result: info }), { status: 200 })
  })
  vi.stubGlobal('fetch', mock)
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchAll pagination', () => {
  it('follows next_page_offset until it is null', async () => {
    const calls = stubFetch(
      [
        { result: { points: [point('a'), point('b')], next_page_offset: 'cursor-1' } },
        { result: { points: [point('c')], next_page_offset: null } }
      ],
      { points_count: 3 }
    )

    const store = await fetchAll('mem0')

    expect(store.points.map(p => p.id)).toEqual(['a', 'b', 'c'])
    expect(store.truncated).toBe(false)
    expect(store.total).toBe(3)
    expect(calls).toHaveLength(2)
  })

  it('passes the offset back on the next request, and omits it on the first', async () => {
    const calls = stubFetch([
      { result: { points: [point('a')], next_page_offset: 'cursor-1' } },
      { result: { points: [point('b')], next_page_offset: null } }
    ])

    await fetchAll('mem0')

    expect(calls[0].body).not.toHaveProperty('offset')
    expect(calls[1].body.offset).toBe('cursor-1')
  })

  it('carries an integer offset through unchanged, not stringified', async () => {
    // A collection of integer-id points hands back a number, which is not a
    // UUID — passing it back as a string would be a different cursor.
    const calls = stubFetch([
      { result: { points: [point('1')], next_page_offset: 7 } },
      { result: { points: [point('2')], next_page_offset: null } }
    ])

    await fetchAll('mem0')

    expect(calls[1].body.offset).toBe(7)
  })

  it('stops on an empty page even when a cursor is still offered', async () => {
    const calls = stubFetch([
      { result: { points: [], next_page_offset: 'cursor-1' } }
    ])

    const store = await fetchAll('mem0')

    expect(store.points).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('stops when a server repeats the same cursor, rather than looping forever', async () => {
    // Every page claims the same offset. The page guard is what ends this.
    const calls = stubFetch([
      { result: { points: [point('a')], next_page_offset: 'stuck' } }
    ])

    const store = await fetchAll('mem0')

    expect(calls.length).toBeGreaterThan(1)
    expect(calls.length).toBeLessThanOrEqual(200)
    // A read that ran out of pages is not the whole store.
    expect(store.truncated).toBe(true)
  })

  it('reports truncation when the collection has more points than were returned', async () => {
    stubFetch([{ result: { points: [point('a')], next_page_offset: null } }], {
      points_count: 5000
    })

    const store = await fetchAll('mem0')

    expect(store.points).toHaveLength(1)
    expect(store.truncated).toBe(true)
    expect(store.total).toBe(5000)
  })

  it('reports progress as pages arrive', async () => {
    stubFetch([
      { result: { points: [point('a'), point('b')], next_page_offset: 'c1' } },
      { result: { points: [point('c')], next_page_offset: null } }
    ])

    const seen: number[] = []
    await fetchAll('mem0', n => seen.push(n))

    expect(seen).toEqual([2, 3])
  })

  it('survives a malformed point instead of taking the whole read down', async () => {
    // Qdrant allows a point with no payload, and its schema makes payload
    // optional. One such point must not blank the app.
    stubFetch([
      {
        result: {
          points: [
            { id: 'ok', payload: { data: 'fine' } },
            { id: 'no-payload' },
            { id: 'null-payload', payload: null },
            { id: 'array-payload', payload: ['wrong'] },
            { payload: { data: 'no id' } },
            null,
            'not an object'
          ],
          next_page_offset: null
        }
      }
    ])

    const store = await fetchAll('mem0')

    expect(store.points.map(p => p.id)).toEqual(['ok', 'no-payload', 'null-payload', 'array-payload'])
    expect(store.points.every(p => typeof p.payload === 'object' && p.payload !== null)).toBe(true)
  })

  it('coerces a numeric point id to a string', async () => {
    stubFetch([
      { result: { points: [{ id: 12345, payload: { data: 'int id' } }], next_page_offset: null } }
    ])

    const store = await fetchAll('mem0')

    expect(store.points[0].id).toBe('12345')
  })
})
