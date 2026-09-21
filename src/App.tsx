import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { mockEnabled } from './mock'
import {
  COLLECTIONS,
  QDRANT,
  badgesOf,
  fetchAll,
  filterPoints,
  fmtClock,
  fmtInt,
  fold,
  formatWhen,
  groupTenants,
  rawWhen,
  strOf,
  textOf
} from './qdrant'
import type { Collection, MemPoint, Tenant } from './qdrant'

interface Loaded {
  collection: Collection
  points: MemPoint[]
  /** The collection's own count; can exceed points.length on a truncated read. */
  total: number
  truncated: boolean
  dim: number | null
  at: Date
}

// ── URL state ──────────────────────────────────────────────────────────────
// Filters live in the query string so a view can be linked, reloaded and
// bookmarked: ?collection=mem0_entities&user=demo-local&agent=assistant&q=postgres

const initial = new URLSearchParams(
  typeof location === 'undefined' ? '' : location.search
)

const initialCollection = (): Collection => {
  const c = initial.get('collection')
  return (COLLECTIONS as readonly string[]).includes(c ?? '')
    ? (c as Collection)
    : 'mem0'
}

/** Tenant is stored as its two halves; a lone or empty half is not a selection. */
const initialTenant = (): string => {
  const user = initial.get('user')
  const agent = initial.get('agent')
  return user && agent ? `${user}\u0000${agent}` : ''
}

export default function App() {
  const [collection, setCollection] = useState<Collection>(initialCollection)
  const [data, setData] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [query, setQuery] = useState(() => initial.get('q') ?? '')
  const [tenant, setTenant] = useState<string>(initialTenant) // '' = all profiles
  const [limit, setLimit] = useState(50)

  const isMock = useMemo(mockEnabled, [])

  // Guards against an older in-flight load painting over a newer one.
  const epoch = useRef(0)

  const load = useCallback(
    async (which: Collection) => {
      const mine = ++epoch.current
      setBusy(true)
      setError('')
      setProgress(0)
      try {
        const store = await fetchAll(which, loaded => {
          if (epoch.current === mine) setProgress(loaded)
        })
        if (epoch.current !== mine) return
        // Drop a tenant carried in the URL that this collection does not have,
        // rather than filtering to nothing with nothing on screen to explain it.
        setTenant(current =>
          current && !groupTenants(store.points).some(t => t.key === current)
            ? ''
            : current
        )
        setData({
          collection: which,
          points: store.points,
          total: store.total,
          truncated: store.truncated,
          dim: store.dim,
          at: new Date()
        })
      } catch (e) {
        if (epoch.current !== mine) return
        setError(e instanceof Error ? e.message : String(e))
        setData(null)
      } finally {
        if (epoch.current === mine) setBusy(false)
      }
    },
    []
  )

  useEffect(() => {
    void load(collection)
  }, [collection, load])

  // Reflect the current filters in the URL, replacing rather than pushing so a
  // search term does not fill the back button with one entry per keystroke.
  useEffect(() => {
    const p = new URLSearchParams()
    if (collection !== 'mem0') p.set('collection', collection)
    if (tenant) {
      const [user, agent] = tenant.split('\u0000')
      p.set('user', user)
      p.set('agent', agent)
    }
    if (query.trim()) p.set('q', query)
    if (isMock) p.set('mock', '1')

    const qs = p.toString()
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname)
  }, [collection, tenant, query, isMock])

  // `data` is kept during a switch so the previous collection stays readable,
  // but nothing derived from it may be shown under the new collection's chip —
  // `current` is the only state the rest of the view is allowed to render from.
  const current = data && data.collection === collection ? data : null

  const tenants: Tenant[] = useMemo(
    () => (current ? groupTenants(current.points) : []),
    [current]
  )

  const filtered = useMemo(
    () => (current ? filterPoints(current.points, query, tenant) : []),
    [current, query, tenant]
  )

  const shown = filtered.slice(0, limit)
  const activeTenant = tenants.find(t => t.key === tenant)

  const selectCollection = (c: Collection) => {
    setCollection(c)
    setTenant('')
    setLimit(50)
  }

  return (
    <div className="app">
      <a className="skip" href="#results">
        skip to memories
      </a>

      <header className="top">
        <div className="brand">
          <span className="dot" aria-hidden="true" />
          <h1 translate="no">mem0</h1>
          <span className="sub">local memory · OSS · Qdrant</span>
        </div>

        <nav className="collections" aria-label="Collections">
          {COLLECTIONS.map(c => (
            <button
              key={c}
              className={c === collection ? 'chip on' : 'chip'}
              aria-current={c === collection}
              onClick={() => selectCollection(c)}
            >
              {c}
            </button>
          ))}
        </nav>

        <div className="meta">
          {isMock && <span className="badge mock">mock data</span>}
          {current && (
            <span className="muted nowrap">
              {fmtInt(current.total)} points
              {current.dim ? ` · ${current.dim}d` : ''} · read{' '}
              {fmtClock(current.at)}
            </span>
          )}
          <button
            className="chip"
            disabled={busy}
            onClick={() => void load(collection)}
          >
            {busy ? 'refresh…' : 'refresh'}
          </button>
        </div>
      </header>

      <div className="body">
        <aside className="rail">
          <h2 className="rail-head">
            profiles <span className="muted">{tenants.length}</span>
          </h2>
          <button
            className={tenant === '' ? 'tenant on' : 'tenant'}
            aria-current={tenant === ''}
            onClick={() => setTenant('')}
          >
            <span className="tname">all profiles</span>
            <span className="count">{fmtInt(current?.points.length ?? 0)}</span>
          </button>
          {tenants.map(t => (
            <button
              key={t.key}
              className={tenant === t.key ? 'tenant on' : 'tenant'}
              aria-current={tenant === t.key}
              onClick={() => {
                setTenant(t.key)
                setLimit(50)
              }}
              title={`user_id=${t.userId}  agent_id=${t.agentId}`}
            >
              <span className="tname">
                {t.userId}
                <span className="muted"> / {t.agentId}</span>
              </span>
              <span className="count">{fmtInt(t.count)}</span>
            </button>
          ))}
          {!tenants.length && !busy && !error && current && (
            <p className="muted pad">No profiles in this collection.</p>
          )}
        </aside>

        <main className="main">
          <div className="controls">
            <input
              className="search"
              type="search"
              name="q"
              aria-label="Search memories"
              aria-describedby="match-count"
              placeholder="search text, profile, channel, hash, id…"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={e => {
                setQuery(e.target.value)
                setLimit(50)
              }}
            />
            <span className="muted nowrap" id="match-count" role="status">
              {fmtInt(filtered.length)} match
              {filtered.length === 1 ? '' : 'es'}
              {activeTenant
                ? ` · ${activeTenant.userId}/${activeTenant.agentId}`
                : ''}
            </span>
          </div>

          {error && (
            <div className="notice err" role="alert">
              <strong>Could not read the store</strong>
              <p>{error}</p>
              <p className="muted">
                Qdrant is expected at <code>{QDRANT}</code>. Point the app
                elsewhere with <code>VITE_QDRANT_URL</code>, or append{' '}
                <code>?mock=1</code> to browse a synthetic store instead.
              </p>
            </div>
          )}

          {busy && !current && (
            <div className="notice" role="status">
              Reading {collection}
              {progress > 0 ? ` — ${fmtInt(progress)} points` : ''}…
            </div>
          )}

          {current?.truncated && (
            <div className="notice" role="status">
              Showing the first {fmtInt(current.points.length)} of{' '}
              {fmtInt(current.total)} points — the read stopped before the store
              was exhausted, so this view is incomplete.
            </div>
          )}

          {!busy && !error && current && filtered.length === 0 && (
            <div className="notice" role="status">
              {current.points.length === 0
                ? `No memories in ${collection} yet.`
                : 'Nothing matches that filter.'}
            </div>
          )}

          <h2 className="sr-only" id="results-heading">
            Memories
          </h2>
          <div
            className="list"
            id="results"
            tabIndex={-1}
            aria-labelledby="results-heading"
          >
            {shown.map(p => (
              <Memory key={p.id} point={p} query={query.trim()} />
            ))}
          </div>

          {filtered.length > shown.length && (
            <button className="more" onClick={() => setLimit(l => l + 100)}>
              Show more · {fmtInt(shown.length)} / {fmtInt(filtered.length)}
            </button>
          )}
        </main>
      </div>
    </div>
  )
}

function Memory({ point, query }: { point: MemPoint; query: string }) {
  const [open, setOpen] = useState(false)
  const text = textOf(point)
  const raw = rawWhen(point)
  const badges = badgesOf(point)
  const panelId = `raw-${point.id}`

  // The row is clickable for convenience; the toggle button beside it is what
  // makes the same action reachable by keyboard. A click that ends a text
  // selection is not an expand request.
  const toggle = () => {
    if (window.getSelection()?.toString()) return
    setOpen(o => !o)
  }

  return (
    <article
      className="mem"
      onClick={toggle}
      onKeyDown={e => {
        if (e.key === 'Escape' && open) {
          setOpen(false)
          e.currentTarget.querySelector('button')?.focus()
        }
      }}
    >
      <div className="mem-top">
        <span className="ten">
          {strOf(point, 'user_id')}
          <span className="muted"> / {strOf(point, 'agent_id')}</span>
        </span>
        {badges.map(b => (
          <span className="badge" key={b.key} title={`${b.key}=${b.value}`}>
            {b.label}
          </span>
        ))}
        <span className="spacer" />
        {raw && (
          <time className="muted" dateTime={raw} title={raw}>
            {formatWhen(raw)}
          </time>
        )}
        <button
          className="toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={e => {
            e.stopPropagation()
            setOpen(o => !o)
          }}
        >
          {open ? 'hide' : 'raw'}
        </button>
      </div>

      <p className="mem-text">
        {/* A memory can be genuinely empty, and it is still matchable by hash
            or id — so the placeholder has to survive an active query too. */}
        {text ? (
          query ? (
            <Highlight text={text} query={query} />
          ) : (
            text
          )
        ) : (
          <em className="muted">(empty)</em>
        )}
      </p>

      {open && <RawPanel id={panelId} point={point} />}
    </article>
  )
}

/** The stored payload, verbatim — the record itself, not a rendering of it. */
function RawPanel({ id, point }: { id: string; point: MemPoint }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const json = useMemo(
    () => JSON.stringify({ id: point.id, ...point.payload }, null, 2),
    [point]
  )
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard

  // Clear the confirmation so a second copy announces again — an unchanged
  // live-region string is not re-announced, and the button has to return to
  // reading as an action.
  useEffect(() => {
    if (status === 'idle') return
    const t = setTimeout(() => setStatus('idle'), 2000)
    return () => clearTimeout(t)
  }, [status])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
  }

  return (
    <div className="raw-wrap" onClick={e => e.stopPropagation()}>
      <div className="raw-bar">
        <span className="muted">payload</span>
        {canCopy && (
          <button className="toggle" onClick={() => void copy()}>
            {status === 'copied'
              ? 'copied'
              : status === 'failed'
                ? 'copy failed'
                : 'copy'}
          </button>
        )}
        <span className="sr-only" aria-live="polite">
          {status === 'copied'
            ? 'Payload copied to clipboard'
            : status === 'failed'
              ? 'Could not copy the payload — your browser blocked clipboard access.'
              : ''}
        </span>
      </div>
      <pre className="raw" id={id} tabIndex={-1}>
        {json}
      </pre>
    </div>
  )
}

/**
 * Cheap case-insensitive highlight — no regex, so odd query text cannot break
 * it. Offsets come from {@link fold}, which preserves length, so the marked
 * span always lines up with the original text.
 */
function Highlight({ text, query }: { text: string; query: string }) {
  const hay = fold(text)
  const needle = fold(query)
  const parts: ReactNode[] = []
  let i = 0
  let n = 0

  for (;;) {
    const at = hay.indexOf(needle, i)
    if (at === -1 || !needle) {
      parts.push(text.slice(i))
      break
    }
    if (at > i) parts.push(text.slice(i, at))
    parts.push(<mark key={n++}>{text.slice(at, at + needle.length)}</mark>)
    i = at + needle.length
  }
  return <>{parts}</>
}
