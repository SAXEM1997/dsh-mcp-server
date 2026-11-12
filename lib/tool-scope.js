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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The only `version` this build writes. */
export const SCOPE_FILE_VERSION = 1

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
  if (raw === undefined || raw === null || raw === '') return { doc: { ...EMPTY }, notes: [] }

  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return { doc: { ...EMPTY, mode: 'selected' }, notes: ['scope-degraded'] }
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { doc: { ...EMPTY, mode: 'selected' }, notes: ['scope-degraded'] }
  }

  const mode = value.mode
  if (mode !== 'global' && mode !== 'selected') {
    return { doc: { ...EMPTY, mode: 'selected' }, notes: ['scope-degraded'] }
  }
  if (mode === 'global') {
    return { doc: { ...EMPTY, mode: 'global' }, notes: [] }
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
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporary, text, { mode: 0o600 })
      await rename(temporary, path)
    },
  }
}

/**
 * Build the scope: read once, judge cheaply, save in place.
 *
 * @param options - `{ registry, workingDirectory, store, logger }`.
 * @param options.registry - the Harness `workspaceRegistry` (`list`, `resolveByPath`).
 * @param options.workingDirectory - the Harness `workingDirectory` service (`get(session)`).
 * @param options.store - `{ read, write }`; see {@link createFileStore}.
 * @param options.logger - debug sink.
 */
export function createToolScope({ registry, workingDirectory, store, logger = () => {} } = {}) {
  const supported = typeof registry?.list === 'function' && typeof registry?.resolveByPath === 'function'

  let doc = { ...EMPTY }
  let notes = supported ? [] : ['scope-unsupported']
  /** sessionId → workspaceId, positive hits only. A miss is retried, never remembered. */
  const placements = new Map()
  /** Sessions a lookup could not place, so "configured but nobody matches" is visible. */
  const unmatched = new Set()

  /** (Re)read the file. A broken file narrows the scope; it never widens it. */
  async function load() {
    let raw
    try {
      raw = await store?.read?.()
    } catch (error) {
      logger('warn', 'tool scope: the document could not be read; selecting nobody', { error: String(error) })
      doc = { ...EMPTY, mode: 'selected' }
      notes = ['scope-degraded']
      return
    }
    const parsed = normalizeDocument(raw)
    doc = parsed.doc
    notes = [...parsed.notes, ...(supported ? [] : ['scope-unsupported'])]
    placements.clear()
  }

  const ready = load()

  /** One workspace list snapshot, shared by a save and a judgement. */
  function workspaces() {
    try {
      const list = registry?.list?.()
      return Array.isArray(list) ? list : []
    } catch (error) {
      logger('debug', 'tool scope: workspace listing failed', { error: String(error) })
      return []
    }
  }

  /** The session's cwd, the service's answer first because it follows a mid-session change. */
  function cwdOf(agent) {
    const session = agent?.session
    try {
      const live = workingDirectory?.get?.(session)
      if (typeof live === 'string' && live) return live
    } catch (error) {
      logger('debug', 'tool scope: working directory lookup failed', { error: String(error) })
    }
    const recorded = session?.header?.cwd
    return typeof recorded === 'string' && recorded ? recorded : undefined
  }

  /** Which workspace this agent belongs to, or `undefined` when the registry cannot say. */
  async function workspaceIdOf(agent) {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || !sessionId) return undefined

    const remembered = placements.get(sessionId)
    if (remembered !== undefined) {
      // A workspace can be deleted while its sessions live on; a remembered id is
      // only good while the registry still lists it.
      if (workspaces().some((workspace) => workspace?.id === remembered)) return remembered
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

    const cwd = cwdOf(agent)
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

  /** The judgement every enforcement point asks for. Never throws. */
  async function visibleFor(agent) {
    try {
      await ready
      if (doc.mode === 'global') return true
      if (!supported) return false
      return isVisible(doc, await workspaceIdOf(agent))
    } catch (error) {
      // A predicate that throws aborts the whole turn upstream, so a scope failure
      // has to look like "not visible" instead.
      logger('debug', 'tool scope: judgement failed; treating as not visible', { error: String(error) })
      return false
    }
  }

  /** What the page and `dsh_status` show. Doc-level only: per-agent sight is a runtime fact. */
  function state() {
    return {
      supported,
      mode: doc.mode,
      workspaceIds: [...doc.workspaceIds],
      notes: [...notes],
      unmatchedAgents: unmatched.size,
    }
  }

  /**
   * Replace the live document, then persist it.
   *
   * Memory changes only after the write succeeded: a failed save must leave the
   * running deployment exactly as it was.
   */
  async function save(input) {
    const mode = input?.mode
    if (mode !== 'global' && mode !== 'selected') {
      throw new ScopeError(400, 'invalid-mode', 'invalid-mode: "mode" must be "global" or "selected".')
    }
    const rawIds = input?.workspaceIds ?? []
    if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== 'string')) {
      throw new ScopeError(400, 'invalid-workspace-ids', 'invalid-workspace-ids: "workspaceIds" must be an array of workspace ids.')
    }
    const wanted = [...new Set(rawIds.map((id) => id.trim()).filter(Boolean))].sort()

    const known = new Set(workspaces().map((workspace) => workspace?.id))
    const unknown = wanted.filter((id) => !known.has(id))
    if (unknown.length) {
      throw new ScopeError(400, 'unknown-workspace', `unknown-workspace: no such workspace ${unknown.join(', ')}`)
    }

    // The selection travels with `global` too: switching back to `selected` should
    // not force the operator to pick everything again.
    const next = { version: SCOPE_FILE_VERSION, mode, workspaceIds: wanted }
    const text = `${JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2)}\n`
    try {
      await store.write(text)
    } catch (error) {
      logger('warn', 'tool scope: the document could not be written; keeping the running one', { error: String(error) })
      throw new ScopeError(500, 'scope-write-failed', 'scope-write-failed: the scope document could not be written; nothing changed.')
    }

    doc = next
    notes = supported ? [] : ['scope-unsupported']
    placements.clear()
    return state()
  }

  return { supported, visibleFor, state, save, ready }
}
