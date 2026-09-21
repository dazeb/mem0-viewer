# AGENTS.md — mem0-viewer

Read [`README.md`](README.md) first: it carries the security posture this repo
must keep.

A read-only browser for a **mem0 OSS** memory store in Qdrant. Vite + React 19 +
TypeScript, pnpm, Vitest. No backend, no router, no state library — the whole app
is one view over one scroll of the store.

## Hard rules

1. **Read-only, always.** This app issues `scroll` and `GET /collections/*` and
   nothing else. No writes, no deletes, no `points/upsert`, no collection
   management. The moment it can mutate someone's memory store it stops being
   safe to hand over. If a feature seems to need a write, it needs a different
   app.
2. **Never weaken the security section.** The README's warning that there is no
   auth and none can be added is load-bearing, not boilerplate. Do not add a
   "deploy to the internet" recipe, do not suggest binding Qdrant to `0.0.0.0`,
   and do not describe Qdrant's reflected `Origin` header as protection. It makes
   the no-backend design possible; it is not a boundary. The API key support in
   `qdrant.ts` is the actual mitigation — keep it working, and keep the README's
   claim accurate to what Qdrant really offers (it has no origin allowlist; only
   `service.enable_cors`, a boolean).
3. **The mock store is synthetic and stays synthetic.** `src/mock.ts` exists so
   the app can be run and screenshotted with no Qdrant. Never add real memories,
   real profile names, hostnames, LAN addresses or file paths to it — a public
   repo's fixture data has leaked a real store before, and `mock.test.ts` asserts
   against known personal names to catch it.
4. **No third-party requests at runtime.** The font is bundled via `@fontsource`
   for exactly this reason. Do not reintroduce a font CDN, analytics, or an
   external image.
5. **Keep the pure logic pure and tested.** Filtering, grouping, badge
   derivation and timestamp formatting live in `src/qdrant.ts` as exported
   functions with tests in `src/qdrant.test.ts`. Put new logic of that kind
   there rather than inside a component; `pnpm test` must stay browser-free.

## Payload facts that are easy to get wrong

- The memory text is in payload **`data`**, not `memory`.
- Scope is `user_id` + `agent_id`; either can be absent, and those points are
  shown as `(none)` rather than hidden.
- `mem0_entities` is a different shape: `entity_type`, `linked_memory_ids`, no
  timestamps or `hash`.
- `next_page_offset` is a UUID string for uuid points and a number for integer
  ones. Pass it back verbatim; do not assume it is a string.
- `attributed_to` and `role` are mutually exclusive in a real store (checked
  across 1.4k points) and both render as bare chip values, so only one of them
  ever shows. `badgesOf` still drops repeated labels as a guard.

## State

Filter state (collection, tenant, query) lives in the URL query string and is
updated with `history.replaceState` — replacing, not pushing, so typing in the
search box does not fill the back button. `mockEnabled()` accepts both the
`VITE_MOCK` env var and `?mock=1`, and writes the param back into the URL.

## Continuous integration

Two remotes, and they do different jobs:

| Remote | What it is |
|---|---|
| `origin` → `github.com/dazeb/mem0-viewer` | **Canonical and public.** The README is written for this one. |
| `gitlab` → `ssh://git@192.168.8.111:2222/dazeb/mem0-viewer.git` | **CI host only.** GitHub Actions is disabled on the account, so the homelab GitLab runs the checks. Private mirror. |

`.github/workflows/ci.yml` cannot run — it is kept because it becomes the right
config if Actions is ever re-enabled, but do not describe it as working. The
pipeline that actually executes is `.gitlab-ci.yml`, verified by pushing and
watching it pass rather than by reading the YAML.

The GitLab runner is registered **for this project** (runner id 5), sharing the
`dorkhound-runner` agent container on the GitLab host. Its config is
`/mnt/pool0/redteam-lab/gitlab-runner/config/config.toml` on that host, alongside
the three dorkhound runners. If you re-register it, the recipe is in
`../dorkhound/deploy/deb/README.md` — and after editing that file, confirm all
four runners still report online, because a malformed config takes down every
runner in the container, not just the one being added.

Push to both remotes. Pushing only to GitHub is safe (the mirror just lags);
pushing only to GitLab means the public repo is stale, which is the failure that
matters.

### Credentials

The GitLab API token is the one in **`~/secrets/gitlab.env`** — a `dazeb`
personal access token with `api` scope. Source that file; do not mint a new
token for a one-off task. (A service-account token also exists on this machine
and reads as a valid credential while being unable to see any group or project,
which is a confusing way to spend an hour — if API calls return empty lists or
403 on admin endpoints, you are holding that one instead.)

Git access needs no token: SSH keys are already authorised on the GitLab host,
so `git push gitlab` just works.

## Commands

```bash
pnpm dev         # dev server (do not leave running)
pnpm build       # tsc --noEmit && vite build
pnpm test        # vitest run
pnpm typecheck   # tsc --noEmit
```

Config is build-time (`VITE_QDRANT_URL`, `VITE_QDRANT_API_KEY`, `VITE_MOCK`), so a
change to any of them needs a rebuild before it takes effect.

## Verifying UI changes

Unit tests cover the pure logic (including the pagination loop in
`src/fetch.test.ts`, which stubs `fetch`), so a change to `App.tsx` or
`styles.css` needs a real render. `pnpm build && pnpm preview --port 4199`, then
drive headless Chrome at `http://localhost:4199/?mock=1`:

```bash
google-chrome --headless=new --disable-gpu --no-sandbox \
  --virtual-time-budget=8000 --dump-dom "http://localhost:4199/?mock=1" \
  | grep -o 'class="mem"' | wc -l
```

`--dump-dom` proves the DOM, not that anything is visible: assert on computed
style too for anything animated or hidden. For interaction (expand, keyboard,
URL sync) drive Playwright against the built bundle — `playwright-core` is
available at `~/.pw-screenshot/node_modules/playwright-core` with the
`/usr/bin/google-chrome` binary.

Run the checks against **both** stores before calling a change done: `?mock=1`
for the fixture path and the bare URL for the live path. The live check needs a
running Qdrant; if none is available, say so rather than skipping it silently.

To exercise the API-key path without touching the user's store, start a
throwaway Qdrant on another port with `service.api_key` set, seed one point, and
build the app against it with `VITE_QDRANT_URL`/`VITE_QDRANT_API_KEY`. Remember
to stop it afterwards and confirm the real store on `6333` is still up.
