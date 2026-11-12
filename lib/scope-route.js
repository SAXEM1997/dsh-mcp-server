/**
 * The loopback-only JSON route behind the tool-scope section of this plugin's
 * configuration page.
 *
 * It is separate from `/mcp-config` on purpose: that route saves through the
 * profile configuration editor, which reloads the plugin — exactly what a scope
 * change must not do, because a reload swaps the registrations a running step
 * already snapshotted. This route writes the sidecar document and updates the
 * live scope in place.
 *
 * Methods are `GET` and `POST` (not `PUT`) to match the sibling route the page
 * already talks to.
 *
 * @module dsh-mcp-server/scope-route
 */

import { admittedByTrust, clampBodyLimit, isJsonContentType, isLoopback, readBody, sendJson } from './route-http.js'

/** Decode a JSON body, translating a syntax error into the route's own 400. */
function parseJson(text) {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('invalid-body: the request body is not JSON.')
    error.status = 400
    error.code = 'invalid-body'
    throw error
  }
}

/** One workspace row, with its path only when the caller is trusted to see it. */
function workspaceRows(registry, trusted) {
  let listed = []
  try {
    listed = registry?.list?.() ?? []
  } catch {
    listed = []
  }
  return (Array.isArray(listed) ? listed : []).map((workspace) => ({
    id: String(workspace?.id ?? ''),
    title: String(workspace?.title ?? workspace?.path ?? workspace?.id ?? ''),
    ...(trusted && typeof workspace?.path === 'string' ? { path: workspace.path } : {}),
  }))
}

/**
 * Build the handler.
 *
 * @param options - `{ scope, registry, trust, allowedOrigins, maxBodyBytes, logger }`.
 * @param options.scope - the live tool scope (`state`, `save`).
 * @param options.registry - the Harness `workspaceRegistry`, for the picker.
 * @param options.trust - `(req) => boolean`: may this peer see workspace paths?
 */
export function createScopeHandler({
  scope,
  registry,
  trust = () => false,
  allowedOrigins = [],
  maxBodyBytes = 4096,
  logger = () => {},
}) {
  const origins = Array.isArray(allowedOrigins) ? allowedOrigins : []

  /**
   * Run the settings route's trust rule, letting an operator-named Origin relax
   * only the Origin/Host comparison.
   *
   * The allowlist is a list of *exceptions*, not a requirement: with the default
   * empty list every browser request must still match its own Host, which is what
   * already protects `/mcp-config`. Requiring a hit here would refuse every save
   * on a stock deployment, because the page always sends an Origin.
   */
  function trustedRequest(req) {
    const origin = req.headers?.origin
    const allowlisted = typeof origin === 'string' && origins.includes(origin)
    if (!allowlisted || typeof req.headers?.host !== 'string') return req
    return { ...req, headers: { ...req.headers, origin: `http://${req.headers.host}` } }
  }

  async function snapshot(trusted) {
    const state = await scope.state()
    return {
      supported: state.supported,
      mode: state.mode,
      workspaceIds: state.workspaceIds,
      notes: state.notes,
      // Same shape as `dsh_status.scope`, so the page and the status tool cannot
      // disagree about whether anything is waiting to be registered.
      unmatchedAgents: state.unmatchedAgents,
      workspaces: workspaceRows(registry, trusted),
    }
  }

  return async function handleScopeRequest(req, res) {
    const peer = req.socket?.remoteAddress
    if (!isLoopback(peer)) {
      sendJson(res, 403, { error: 'the tool scope is served to the local machine only' })
      return
    }
    // Every method goes through trust, exactly like the settings route: reading
    // the workspace list is as much a local-only operation as changing the scope.
    const trusted = (() => {
      try {
        return trust(trustedRequest(req)) === true
      } catch {
        return false
      }
    })()
    if (!trusted) {
      sendJson(res, 403, { error: 'the tool scope is served to the local machine only' })
      return
    }

    const method = String(req.method ?? 'GET').toUpperCase()

    if (method === 'GET' || method === 'HEAD') {
      sendJson(res, 200, await snapshot(trusted))
      return
    }
    if (method !== 'POST') {
      res.writeHead(405, { allow: 'GET, HEAD, POST', 'content-type': 'text/plain; charset=utf-8' })
      res.end('Method Not Allowed')
      return
    }
    if (scope.supported === false) {
      sendJson(res, 501, { error: 'scope-unsupported: this Harness exposes no workspace registry.', code: 'scope-unsupported' })
      return
    }
    if (!isJsonContentType(req.headers?.['content-type'])) {
      sendJson(res, 415, { error: 'the tool scope accepts application/json only', code: 'unsupported-media-type' })
      return
    }

    let body
    try {
      body = parseJson(await readBody(req, maxBodyBytes))
    } catch (error) {
      sendJson(res, error.status ?? 400, { error: error.message, ...(error.code ? { code: error.code } : {}) })
      return
    }
    if (body === undefined || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { error: 'invalid-body: expected a JSON object.', code: 'invalid-body' })
      return
    }

    try {
      await scope.save({ mode: body.mode, workspaceIds: body.workspaceIds })
    } catch (error) {
      const status = Number.isFinite(error?.status) ? error.status : 500
      const code = typeof error?.code === 'string' ? error.code : 'scope-save-failed'
      logger('warn', 'tool scope: save refused', { status, code, error: error?.message })
      sendJson(res, status, { error: error?.message ?? 'the tool scope could not be saved', code })
      return
    }

    sendJson(res, 200, await snapshot(trusted))
  }
}
