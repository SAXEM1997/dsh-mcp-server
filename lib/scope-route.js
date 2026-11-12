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

const DEFAULT_MAX_BODY_BYTES = 4096

/** Literal loopback spellings a socket may report. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '::1', 'localhost'])

/** Whether a peer address is this machine. */
function isLoopback(address) {
  if (typeof address !== 'string' || !address) return false
  if (LOOPBACK_NAMES.has(address)) return true
  return address.startsWith('127.') || address.startsWith('::ffff:127.')
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function isJsonContentType(value) {
  if (typeof value !== 'string') return false
  const [type] = value.split(';')
  return type.trim().toLowerCase() === 'application/json'
}

/** Read a JSON body, refusing anything past `maxBytes`. */
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        const error = new Error('request body too large')
        error.status = 413
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(text ? JSON.parse(text) : undefined)
      } catch {
        const error = new Error('invalid-body: the request body is not JSON.')
        error.status = 400
        error.code = 'invalid-body'
        reject(error)
      }
    })
    req.on('error', reject)
  })
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
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  logger = () => {},
}) {
  const allowed = new Set((Array.isArray(allowedOrigins) ? allowedOrigins : []).map((origin) => String(origin).replace(/\/+$/, '')))

  /** The page is served from another origin in the LAN + reverse-proxy setup. */
  function originAllowed(req) {
    const origin = req.headers?.origin
    if (typeof origin !== 'string' || !origin) return true
    return allowed.has(origin.replace(/\/+$/, ''))
  }

  function snapshot(trusted) {
    const state = scope.state()
    return {
      supported: state.supported,
      mode: state.mode,
      workspaceIds: state.workspaceIds,
      notes: state.notes,
      workspaces: workspaceRows(registry, trusted),
    }
  }

  return async function handleScopeRequest(req, res) {
    const peer = req.socket?.remoteAddress
    if (!isLoopback(peer)) {
      sendJson(res, 403, { error: 'the tool scope is served to the local machine only' })
      return
    }
    if (!originAllowed(req)) {
      sendJson(res, 403, { error: 'this Origin may not change the tool scope' })
      return
    }

    const method = String(req.method ?? 'GET').toUpperCase()
    const trusted = (() => {
      try {
        return trust(req) === true
      } catch {
        return false
      }
    })()

    if (method === 'GET' || method === 'HEAD') {
      sendJson(res, 200, snapshot(trusted))
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
      body = await readJsonBody(req, maxBodyBytes)
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

    sendJson(res, 200, snapshot(trusted))
  }
}
