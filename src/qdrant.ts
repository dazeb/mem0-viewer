/**
 * Qdrant client for the mem0 OSS store.
 *
 * mem0 in OSS mode keeps no index of its own — memories are plain points in
 * Qdrant, scoped by `user_id` / `agent_id` payload fields. So "listing memory"
 * is a scroll, and "per-profile memory" is a payload filter.
 *
 * The payload field holding the memory text is `data` (not `memory`). mem0
 * writes `created_at`, `updated_at`, `hash`, `channel`, `attributed_to` and
 * `text_lemmatized` alongside it.
 */

import { mockCollectionInfo, mockEnabled, mockFetchAll } from './mock'

const configured = import.meta.env.VITE_QDRANT_URL || 'http://127.0.0.1:6333'

/** Qdrant base URL, without a trailing slash. */
export const QDRANT = configured.replace(/\/+$/, '')

/**
 * Optional `api-key`. Set this if your Qdrant has an API key configured.
 *
 * It is a build-time value baked into the bundle, so it is readable by anyone
 * who can load the page — it is not a way to publish this app. What it does buy
 * you is the browser vector: a Qdrant with a key rejects requests from a random
 * web page that does not know the key. See the README's security section.
 */
const API_KEY = import.meta.env.VITE_QDRANT_API_KEY || ''

/** True when requests will carry an api-key header. */
export const HAS_API_KEY = API_KEY !== ''

const authHeaders = (): Record<string, string> =>
  API_KEY ? { 'api-key': API_KEY } : {}

/** Per-request deadline. Long enough for a large scroll, short enough to fail. */
const REQUEST_TIMEOUT_MS = 20_000

/** Runaway guard on pagination; hitting it is reported as a truncated read. */
const MAX_PAGES = 200

export const COLLECTIONS = ['mem0', 'mem0_entities'] as const
export type Collection = (typeof COLLECTIONS)[number]

export interface MemPoint {
  id: string
  payload: Record<string, unknown>
}

/** A tenant = one profile's slice of the shared store. */
export interface Tenant {
  key: string
  userId: string
  agentId: string
  count: number
}

// ── payload reads ──────────────────────────────────────────────────────────

export const textOf = (p: MemPoint): string => String(p.payload.data ?? '')

export const strOf = (p: MemPoint, k: string): string => {
  const v = p.payload[k]
  return v == null ? '' : String(v)
}

export const tenantOf = (p: MemPoint): { userId: string; agentId: string } => ({
  userId: strOf(p, 'user_id') || '(none)',
  agentId: strOf(p, 'agent_id') || '(none)'
})

/** Stable identity for a tenant, safe to put in a URL or a Map key. */
export const tenantKey = (p: MemPoint): string => {
  const t = tenantOf(p)
  return `${t.userId}\u0000${t.agentId}`
}

export function groupTenants(points: MemPoint[]): Tenant[] {
  const map = new Map<string, Tenant>()
  for (const p of points) {
    const { userId, agentId } = tenantOf(p)
    const key = `${userId}\u0000${agentId}`
    const hit = map.get(key)
    if (hit) hit.count += 1
    else map.set(key, { key, userId, agentId, count: 1 })
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

// ── formatting ─────────────────────────────────────────────────────────────

const intFmt = new Intl.NumberFormat()

/** Counts get separators in every locale. */
export const fmtInt = (n: number): string => intFmt.format(n)

const clockFmt = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' })

/** Wall-clock time, for the "last read" stamp. */
export const fmtClock = (d: Date): string => clockFmt.format(d)

/** The raw timestamp the store holds, for tooltips. '' when absent. */
export const rawWhen = (p: MemPoint): string =>
  strOf(p, 'created_at') || strOf(p, 'updated_at')

// Formatters are expensive to construct and there is one per rendered row, so
// they are cached per locale rather than rebuilt on every render.
const whenFmts = new Map<string, Intl.DateTimeFormat>()

function whenFmt(locale?: string): Intl.DateTimeFormat {
  const key = locale ?? ''
  let f = whenFmts.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' })
    whenFmts.set(key, f)
  }
  return f
}

/**
 * Raw timestamp → compact local display. Unparseable values are passed through
 * unchanged: a memory browser should show what the store actually holds rather
 * than refuse to format it.
 */
export function formatWhen(raw: string, locale?: string): string {
  if (!raw) return ''
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  return whenFmt(locale).format(d)
}

// ── filtering ──────────────────────────────────────────────────────────────

/**
 * Lowercase for case-insensitive matching, preserving length.
 *
 * A handful of characters lowercase to something longer (U+0130 İ → two code
 * units). `Highlight` maps match offsets back onto the original text, so a
 * length change would shift every later index and mark the wrong span. Those
 * characters are therefore left unfolded, which only means they match
 * case-sensitively. Search and highlight share this, so whatever matches is
 * whatever gets marked.
 */
export function fold(s: string): string {
  let out = ''
  for (const ch of s) {
    const lower = ch.toLowerCase()
    out += lower.length === ch.length ? lower : ch
  }
  return out
}

/**
 * Everything a search term is matched against: the memory text first, then the
 * identifying payload fields, so an id or a channel is findable by name.
 */
export function searchHay(p: MemPoint): string {
  return fold(
    [
      textOf(p),
      strOf(p, 'user_id'),
      strOf(p, 'agent_id'),
      strOf(p, 'channel'),
      strOf(p, 'hash'),
      p.id
    ].join(' ')
  )
}

/** Case-insensitive substring match over {@link searchHay}. Empty query matches all. */
export function matchesQuery(p: MemPoint, query: string): boolean {
  const q = fold(query.trim())
  return q === '' || searchHay(p).includes(q)
}

/** Tenant filter + text search, applied over the already-loaded points. */
export function filterPoints(
  points: MemPoint[],
  query: string,
  tenant: string
): MemPoint[] {
  return points.filter(
    p => (tenant === '' || tenantKey(p) === tenant) && matchesQuery(p, query)
  )
}

// ── badges ─────────────────────────────────────────────────────────────────

/** Payload fields worth surfacing as chips on a memory row. */
const BADGE_KEYS = ['channel', 'attributed_to', 'role', 'migrated_from'] as const

/**
 * Values that read on their own. The others carry their key, which is what
 * makes `channel:cli` legible where a bare `cli` would not be.
 */
const BARE_BADGES = new Set<string>(['attributed_to', 'role'])

export interface Badge {
  key: string
  value: string
  /** What the chip shows: the value alone, or `key:value`. */
  label: string
}

/**
 * Chips for one memory. The two bare fields render as their value alone, so a
 * store that set both to the same word would show two identical chips; repeated
 * labels are dropped as a guard against that. This only affects the row — the
 * expandable payload panel prints every field verbatim, so nothing is hidden.
 */
export function badgesOf(p: MemPoint): Badge[] {
  const out: Badge[] = []
  const seen = new Set<string>()
  for (const key of BADGE_KEYS) {
    const value = strOf(p, key)
    if (!value) continue
    const label = BARE_BADGES.has(key) ? value : `${key}:${value}`
    if (seen.has(label)) continue
    seen.add(label)
    out.push({ key, value, label })
  }
  return out
}

// ── transport ──────────────────────────────────────────────────────────────

/**
 * Qdrant allows a point to carry no payload at all, and `as T` on a parsed
 * response asserts a shape nothing has checked. Everything downstream reads
 * `payload.<field>` unguarded, so a single malformed point would otherwise
 * blank the whole app — normalize once, here, at the one place real data
 * enters.
 */
function normalizePoint(raw: unknown): MemPoint | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as { id?: unknown; payload?: unknown }
  if (p.id === undefined || p.id === null) return null
  const payload =
    typeof p.payload === 'object' && p.payload !== null && !Array.isArray(p.payload)
      ? (p.payload as Record<string, unknown>)
      : {}
  return { id: String(p.id), payload }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${QDRANT}${path}`, {
      ...init,
      // Without a deadline a stalled store leaves the UI loading forever with
      // the refresh button disabled.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { ...init.headers, ...authHeaders() }
    })
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    throw new Error(
      `Cannot reach Qdrant at ${QDRANT} — is it running? (${why})`
    )
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // 401/403 is the one status with an obvious next step that the server's own
    // text does not name, and it is the path a keyed store takes.
    const hint =
      res.status === 401 || res.status === 403
        ? HAS_API_KEY
          ? ' — the configured VITE_QDRANT_API_KEY was rejected'
          : ' — this store requires an API key; set VITE_QDRANT_API_KEY'
        : ''
    throw new Error(
      `Qdrant ${res.status} on ${path}${hint}${detail ? `: ${detail.slice(0, 300)}` : ''}`
    )
  }
  return (await res.json()) as T
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

interface ScrollResponse {
  result?: {
    points?: unknown[]
    // Qdrant hands back the id it wants next: a UUID string for uuid points, a
    // number for integer ones. Pass it back verbatim.
    next_page_offset?: string | number | null
  }
}

export interface Store {
  points: MemPoint[]
  /** The collection's own count, which can exceed `points.length`. */
  total: number
  /** True when the read stopped before the store was exhausted. */
  truncated: boolean
  dim: number | null
}

/**
 * Scroll the whole collection. Page size is deliberately large — a personal
 * store is ~1k points, so this is one or two round-trips, and it lets the UI
 * filter and search entirely client-side (no stale index, no query language to
 * learn).
 *
 * `MAX_PAGES` is a runaway guard, not a limit anyone should hit. If it is
 * reached the read is reported as truncated rather than passed off as the whole
 * store, because a partial read silently presented as complete is worse than
 * no read at all.
 */
export async function fetchAll(
  collection: Collection,
  onProgress?: (loaded: number) => void
): Promise<Store> {
  if (mockEnabled()) {
    const points = mockFetchAll(collection)
    const info = mockCollectionInfo(collection)
    onProgress?.(points.length)
    return { points, total: info.points, truncated: false, dim: info.dim }
  }

  const pageSize = 512
  const out: MemPoint[] = []
  let offset: string | number | null | undefined = undefined
  let truncated = false

  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = {
      limit: pageSize,
      with_payload: true,
      with_vector: false
    }
    if (offset !== undefined && offset !== null) body.offset = offset

    const data = await post<ScrollResponse>(
      `/collections/${collection}/points/scroll`,
      body
    )
    const rawPoints = data.result?.points ?? []
    for (const raw of rawPoints) {
      const point = normalizePoint(raw)
      if (point) out.push(point)
    }
    onProgress?.(out.length)

    offset = data.result?.next_page_offset
    if (offset === undefined || offset === null || rawPoints.length === 0) break
    if (page === MAX_PAGES - 1) truncated = true
  }

  const info = await collectionInfo(collection).catch(() => ({
    points: out.length,
    dim: null
  }))
  return {
    points: out,
    total: info.points,
    truncated: truncated || info.points > out.length,
    dim: info.dim
  }
}

export async function collectionInfo(
  collection: Collection
): Promise<{ points: number; dim: number | null }> {
  if (mockEnabled()) return mockCollectionInfo(collection)

  const d = await request<{
    result?: {
      points_count?: number
      config?: { params?: { vectors?: { size?: number } } }
    }
  }>(`/collections/${collection}`)
  return {
    points: d.result?.points_count ?? 0,
    dim: d.result?.config?.params?.vectors?.size ?? null
  }
}
