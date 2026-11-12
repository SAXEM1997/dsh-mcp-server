/**
 * Tool scope: which workspaces may see this plugin's DSH-facing tools.
 *
 * The document answers one question — is this agent's workspace selected — and
 * every path that cannot answer it lands on the strict side (`selected` with no
 * workspaces), never on `global`. That is the one rule the rest of this module
 * exists to keep: a broken file must not silently widen what the tools can touch.
 *
 * The live document is the in-memory copy, replaced in place by {@link save};
 * the file is only how it survives a restart. That is deliberate: a save must not
 * reload the plugin, because a reload swaps the tool registrations the running
 * step already snapshotted.
 *
 * See `docs/design/2026-11-12-tool-scope.md`.
 *
 * @module dsh-mcp-server/tool-scope
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The only `version` this build writes. */
export const SCOPE_FILE_VERSION = 1

/** How long the first document read may take before the scope narrows to nobody. */
const SCOPE_LOAD_TIMEOUT_MS = 2000

/** How long one workspace listing is reused before asking the registry again. */
const WORKSPACE_LIST_TTL_MS = 500

/** Upper bound on remembered unplaced sessions; only the count is reported. */
const UNMATCHED_CAP = 2000

/** How long one judgement is reused, so the 28 calls of one step agree. */
const VERDICT_TTL_MS = 10

/** A save that failed for a reason the caller can act on. */
export class ScopeError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ScopeError'
    this.status = status
    this.code = code
  }
}

const EMPTY = Object.freeze({ version: SCOPE_FILE_VERSION, mode: 'global', workspaceIds: Object.freeze([]) })

/**
 * Coerce whatever was on disk into a usable document.
 *
 * A document this build does not understand, or one whose fields are the wrong
 * shape, selects nobody. A *missing* document is different: it means the
 * deployment never opted in, so it stays `global` and every tool stays where it
 * was before this feature existed.
 *
 * @param raw - the parsed file contents, the raw text, or `undefined`.
 * @returns `{ doc, notes }` — `notes` carries `scope-degraded` when the input was unusable.
 */
export function normalizeDocument(raw) {
  if (raw === undefined || raw === null) return { doc: { ...EMPTY }, notes: [] }

  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return { doc: { ...EMPTY, mode: 'selected' }, notes: ['scope-degraded'] }
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { doc: { ...EMPTY, mode: 'selected' }, notes: ['scope-degraded'] }
  }
  // A document this build does not understand is not a document it may rewrite:
  // narrowing is the only safe reading of a newer format.
  if (value.version !== undefined && value.version !== SCOPE_FILE_VERSION) {
    return { doc: { ...EMPTY, mode: 'selected' }, notes: ['scope-degraded'] }
  }

  const mode = value.mode
  if (mode !== 'global' && mode !== 'selected') {
    return { doc: { ...EMPTY, mode: 'selected' }, notes: ['scope-degraded'] }
  }
  if (mode === 'global') {
    // The selection is kept while global, so switching back does not make the
    // operator pick everything again.
    const kept = Array.isArray(value.workspaceIds)
      ? [...new Set(value.workspaceIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))].sort()
      : []
    return { doc: { version: SCOPE_FILE_VERSION, mode: 'global', workspaceIds: kept }, notes: [] }
  }

  const ids = value.workspaceIds
  if (!Array.isArray(ids)) return { doc: { ...EMPTY, mode: 'selected' }, notes: ['scope-degraded'] }
  const cleaned = [...new Set(ids.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))].sort()
  // An empty selection is a legitimate "nobody", but a list whose every entry was
  // unusable is a broken document, and the two must not look the same.
  const notes = cleaned.length === 0 && ids.length > 0 ? ['scope-degraded'] : []
  return { doc: { version: SCOPE_FILE_VERSION, mode: 'selected', workspaceIds: cleaned }, notes }
}

/**
 * Whether one workspace id is inside the document's reach.
 *
 * `global` admits everything, including an id the registry has never heard of —
 * that is what "global" meant before this feature existed.
 *
 * @param doc - a normalized document.
 * @param workspaceId - the workspace this agent belongs to, or `undefined` when unknown.
 */
export function isVisible(doc, workspaceId) {
  if (doc.mode === 'global') return true
  return typeof workspaceId === 'string' && doc.workspaceIds.includes(workspaceId)
}

/** The atomic sidecar store used in production: 0600, write-then-rename. */
export function createFileStore(path) {
  return {
    path,
    async read() {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return undefined
        throw error
      }
    },
    async write(text) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${randomUUID()}.tmp`
      await writeFile(temporary, text, { mode: 0o600 })
      await rename(temporary, path)
    },
  }
}

/**
 * Build the scope: read once, judge cheaply, save in place.
 *
 * @param options - `{ registry, store, logger }`.
 * @param options.registry - the Harness `workspaceRegistry` (`list`, `resolveByPath`).
 * @param options.store - `{ read, write }`; see {@link createFileStore}.
 * @param options.logger - debug sink.
 */
export function createToolScope({ registry, store, logger = () => {} } = {}) {
  const supported = typeof registry?.list === 'function' && typeof registry?.resolveByPath === 'function'

  /** Set when the deadline fired first, so a late read knows it is late. */
  let loadAbandoned = false

  /** Bumped by every save, so a late read can tell "stale" from "superseded". */
  let docRevision = 0

  /** The `updatedAt` this instance believes is on disk, for the write-time compare. */
  let stampSeen
  let disposed = false

  let doc = { ...EMPTY }
  let notes = supported ? [] : ['scope-unsupported']
  /** sessionId → workspace id, positive hits only. Identity cannot move, so no cwd. */
  const placements = new Map()
    /** Sessions a lookup could not place, so "configured but nobody matches" is visible. */
  const unmatched = new Set()

  /** (Re)read the file. A broken file narrows the scope; it never widens it. */
  async function load() {
    const at = docRevision
    let parsed
    let raw
    try {
      raw = await store?.read?.()
      parsed = normalizeDocument(raw)
    } catch (error) {
      logger('warn', 'tool scope: the document could not be read; selecting nobody', { error: String(error) })
      parsed = { doc: { ...EMPTY, mode: 'selected' }, notes: ['scope-degraded'] }
    }
    // A late read that nobody superseded is still the best document available: the
    // deadline narrowed the scope only because the answer had not arrived yet.
    // Dropping it would leave this process narrowed for its whole life.
    if (at !== docRevision) return
    if (raw !== undefined) stampSeen = stampOf(raw)
    doc = parsed.doc
    notes = [...parsed.notes, ...(supported ? [] : ['scope-unsupported'])]
    placements.clear()
  }

  /**
   * The first read, bounded.
   *
   * A read that never settles must not hold every step's tool resolution, so the
   * deadline narrows the scope to nobody. The timer is cleared the moment the
   * read lands: leaving it armed would re-narrow a healthy deployment two seconds
   * after startup, which is a deployment-wide outage.
   */
  const ready = (() => {
    let timer
    let abandoned = false
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        abandoned = true
        logger('warn', 'tool scope: the document did not load in time; selecting nobody')
        doc = { ...EMPTY, mode: 'selected' }
        notes = ['scope-degraded']
        resolve()
      }, SCOPE_LOAD_TIMEOUT_MS)
      // Deliberately not unref'd: this timer exists to guarantee a settle, so it is
      // real work, and it lives at most one deadline.
    })
    const read = load().finally(() => clearTimeout(timer))
    // Whichever finishes first settles `ready`: a read that never returns must not
    // leave every `when` awaiting it forever. `abandoned` stops the late read from
    // overwriting the narrowing the deadline already published.
    return Promise.race([read, deadline]).then(() => {
      if (abandoned) loadAbandoned = true
    })
  })()

  /**
   * One workspace list snapshot, briefly cached.
   *
   * `when` runs once per tool per step, so an uncached `list()` would be called
   * 28 times in `full` mode every step. The window is short enough that a
   * workspace created seconds ago is still noticed.
   */
  let listCache
  /**
   * The workspace list, briefly cached.
   *
   * A registry that throws is *not* an empty registry: judging with `[]` would hide
   * every tool, and saving against it would report "unknown workspace" for every
   * id. The failure is carried out to the caller instead.
   */
  function workspaces({ fresh = false } = {}) {
    const at = Date.now()
    if (!fresh && listCache && at - listCache.at < WORKSPACE_LIST_TTL_MS) return listCache.value
    let list
    try {
      list = registry?.list?.()
    } catch (error) {
      throw new ScopeError(500, 'scope-registry-unavailable', `scope-registry-unavailable: the Harness workspace registry failed (${String(error?.message ?? error)}).`)
    }
    if (!Array.isArray(list)) throw new ScopeError(500, 'scope-registry-unavailable', 'scope-registry-unavailable: the Harness workspace registry returned no list.')
    listCache = { at, value: list }
    return list
  }

  /** The `updatedAt` carried by a raw document, or null when it carries none. */
  function stampOf(raw) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      return typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null
    } catch {
      return null
    }
  }

  /** The stamp currently on disk, read fresh for the write-time compare. */
  async function stampOfStore() {
    try {
      return stampOf(await store?.read?.())
    } catch (error) {
      logger('debug', 'tool scope: could not read the document before writing', { error: String(error) })
      return stampSeen
    }
  }

  /**
   * Where this session was opened.
   *
   * Deliberately the *recorded* directory, not the live working directory: a session
   * may change directory at any point, so a live lookup would let any session
   * `cd` into a selected workspace and grant itself the tools. Identity is where
   * the session started; the live directory is only a fallback for a session the
   * header does not carry.
   */
  function cwdOf(agent) {
    const recorded = agent?.session?.header?.cwd
    return typeof recorded === 'string' && recorded ? recorded : undefined
  }

  /** Which workspace this agent belongs to, or `undefined` when the registry cannot say. */
  async function workspaceIdOf(agent) {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || !sessionId) return undefined

    const cwd = cwdOf(agent)
    // Identity cannot change mid-session (`session.header.cwd` is immutable), so a
    // remembered workspace needs no cwd check: it is good while the registry still
    // lists it.
    const remembered = placements.get(sessionId)
    if (remembered !== undefined) {
      const stillListed = workspaces().some((workspace) => workspace?.id === remembered)
      if (stillListed) return remembered
      placements.delete(sessionId)
      if (!notes.includes('scope-stale')) notes.push('scope-stale')
    }

    const listed = workspaces()
    const recorded = listed.find((workspace) => Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId))
    if (recorded?.id) {
      placements.set(sessionId, recorded.id)
      unmatched.delete(sessionId)
      return recorded.id
    }

    if (cwd) {
      try {
        const byPath = await registry.resolveByPath(cwd)
        if (byPath?.id) {
          placements.set(sessionId, byPath.id)
          unmatched.delete(sessionId)
          return byPath.id
        }
      } catch (error) {
        logger('debug', 'tool scope: workspace lookup by path failed', { error: String(error) })
      }
    }
    unmatched.add(sessionId)
    return undefined
  }

  /**
   * Judgements for the document that was current a moment ago.
   *
   * `when` is asked once per tool, so one step asks up to 28 times. Without this
   * a save landing mid-step could answer some of them with the old document and
   * the rest with the new one, leaving a half-visible tool surface. The window is
   * deliberately tiny: it bounds that skew without hiding a save for long.
   */
  const verdicts = new Map()

  /** The judgement every enforcement point asks for. Never throws. */
  async function visibleFor(agent) {
    try {
      await ready
      if (doc.mode === 'global') return true
      if (!supported) return false
      const sessionId = agent?.session?.id
      if (typeof sessionId === 'string') {
        const hit = verdicts.get(sessionId)
        if (hit !== undefined && hit.at === docRevision && Date.now() - hit.ms < VERDICT_TTL_MS) return hit.visible
        const visible = isVisible(doc, await workspaceIdOf(agent))
        verdicts.set(sessionId, { at: docRevision, ms: Date.now(), visible })
        return visible
      }
      return isVisible(doc, await workspaceIdOf(agent))
    } catch (error) {
      // A predicate that throws aborts the whole turn upstream, so a scope failure
      // has to look like "not visible" instead.
      logger('debug', 'tool scope: judgement failed; treating as not visible', { error: String(error) })
      return false
    }
  }

  /**
   * What the page and `dsh_status` show. Doc-level only: per-agent sight is a
   * runtime fact.
   *
   * It waits for the first read, so a status call during startup reports the
   * document that is about to govern the deployment rather than the placeholder.
   */
  async function state() {
    await ready
    return {
      supported,
      mode: doc.mode,
      workspaceIds: [...doc.workspaceIds],
      notes: [...notes],
      unmatchedAgents: unmatched.size,
    }
  }

  /** Saves are serialized: two overlapping writes would race on the same file. */
  let saving = Promise.resolve()

  /**
   * Persist a new document, then adopt it.
   *
   * Memory changes only after the write succeeded: a failed save must leave the
   * running deployment exactly as it was.
   */
  async function save(input) { return saving = saving.then(() => saveNow(input), () => saveNow(input)) }

  /** The write-then-adopt half of `save`, never called directly. */

  async function saveNow(input) {
    await ready
    if (disposed) throw new ScopeError(409, 'scope-disposed', 'scope-disposed: this plugin instance is no longer running; reload the page and save again.')
    const mode = input?.mode
    if (mode !== 'global' && mode !== 'selected') {
      throw new ScopeError(400, 'invalid-mode', 'invalid-mode: "mode" must be "global" or "selected".')
    }
    const rawIds = input?.workspaceIds ?? []
    if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== 'string')) {
      throw new ScopeError(400, 'invalid-workspace-ids', 'invalid-workspace-ids: "workspaceIds" must be an array of workspace ids.')
    }
    const wanted = [...new Set(rawIds.map((id) => id.trim()).filter(Boolean))].sort()

    // The listing is cached for a few hundred milliseconds; a workspace created
    // seconds ago must still be savable, so validation reads through.
    const known = new Set(workspaces({ fresh: true }).map((workspace) => workspace?.id))
    const unknown = wanted.filter((id) => !known.has(id))
    if (unknown.length) {
      throw new ScopeError(400, 'unknown-workspace', `unknown-workspace: no such workspace ${unknown.join(', ')}`)
    }

    // The selection travels with `global` too: switching back to `selected` should
    // not force the operator to pick everything again.
    const next = { version: SCOPE_FILE_VERSION, mode, workspaceIds: wanted }
    // Another instance may have written since this one last read: a late save from a
    // replaced plugin would otherwise silently overwrite a newer, narrower selection.
    if (stampSeen !== undefined && (await stampOfStore()) !== stampSeen) {
      throw new ScopeError(409, 'scope-conflict', 'scope-conflict: the scope document changed elsewhere; reload the page and save again.')
    }
    const updatedAt = new Date().toISOString()
    const text = `${JSON.stringify({ ...next, updatedAt }, null, 2)}\n`
    try {
      await store.write(text)
    } catch (error) {
      logger('warn', 'tool scope: the document could not be written; keeping the running one', { error: String(error) })
      throw new ScopeError(500, 'scope-write-failed', 'scope-write-failed: the scope document could not be written; nothing changed.')
    }

    stampSeen = updatedAt
    docRevision += 1
    doc = next
    notes = supported ? [] : ['scope-unsupported']
    verdicts.clear()
    // Placements stay: a save changes which workspaces are selected, never where a
    // session lives, and dropping them would cost 28 lookups on the next step.
    if (unmatched.size > UNMATCHED_CAP) unmatched.clear()
    return state()
  }

  /**
   * Stop this instance.
   *
   * A replaced plugin keeps its own memory, timers and in-flight writes unless it
   * is told: without this, a save that lands after the swap overwrites whatever the
   * new instance published.
   */
  function dispose() {
    disposed = true
    placements.clear()
    verdicts.clear()
    listCache = undefined
  }

  return { supported, visibleFor, state, save, ready, dispose }
}
