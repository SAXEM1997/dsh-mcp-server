/**
 * Presigned uploads: mint a slot, PUT the bytes into it, reference it later.
 *
 * The MCP transport carries JSON only, so a client cannot hand the server a
 * binary. This module adds a capability URL: `dsh_prepare_upload` mints one
 * short-lived, single-success slot per file, and the client PUTs the bytes to
 * that URL with no credential at all — the unguessable nonce *is* the
 * capability. See `docs/design/2026-11-12-file-transport.md`.
 */

import { createHash, randomBytes } from 'node:crypto'

/** Media types this feature accepts before the deployment's own list narrows it. */
export const UPLOAD_MEDIA_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
])

const MIB = 1024 * 1024
const MAX_PIXELS = 100 * 1024 * 1024
const SLOT_MINTED = 'minted'
const SLOT_CONSUMING = 'consuming'
const SLOT_STORED = 'stored'
const SLOT_GONE = 'gone'
const SWEEP_INTERVAL_MS = 60_000
const ROUTE_PREFIX = '/mcp-files/'

const clamp = (value, fallback, min, max) => {
  const raw = Number(value)
  if (!Number.isFinite(raw)) return fallback
  return Math.max(min, Math.min(max, raw))
}

/** Resolve the upload knobs out of the plugin configuration, clamped. */
export function uploadConfig(config = {}) {
  return {
    ttlMs: clamp(config.uploadTtlMs, 300_000, 60_000, 24 * 60 * 60 * 1000),
    fileIdTtlMs: clamp(config.fileIdTtlMs, 3_600_000, 60_000, 24 * 60 * 60 * 1000),
    maxFileBytes: clamp(config.uploadMaxFileBytes, 20 * MIB, 64 * 1024, 256 * MIB),
    maxFiles: clamp(config.uploadMaxFiles, 10, 1, 20),
    maxBytes: clamp(config.uploadMaxBytes, 64 * MIB, MIB, 512 * MIB),
    maxAttempts: clamp(config.uploadMaxAttempts, 3, 1, 10),
    globalBudgetBytes: clamp(config.uploadGlobalBudgetBytes, 512 * MIB, 64 * MIB, 4096 * MIB),
    requireSha256: config.uploadRequireSha256 === true,
  }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** Magic-number sniffing: the declared type must match the bytes. */
function sniffMediaType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.length >= 6 && buffer.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('latin1') === 'ftyp' && buffer.subarray(8, 12).toString('latin1').startsWith('avif')) return 'image/avif'
  return undefined
}

/** Declared pixel count, read from the header without decoding the image. */
function declaredPixels(buffer, mediaType) {
  try {
    if (mediaType === 'image/png' && buffer.length >= 24) {
      return buffer.readUInt32BE(16) * buffer.readUInt32BE(20)
    }
    if (mediaType === 'image/gif' && buffer.length >= 10) {
      return buffer.readUInt16LE(6) * buffer.readUInt16LE(8)
    }
    if (mediaType === 'image/jpeg') {
      let offset = 2
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue }
        const marker = buffer[offset + 1]
        const size = buffer.readUInt16BE(offset + 2)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return buffer.readUInt16BE(offset + 7) * buffer.readUInt16BE(offset + 5)
        }
        offset += 2 + size
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

class UploadRejection extends Error {
  constructor(status, message, { burnsSlot = false } = {}) {
    super(message)
    this.status = status
    this.burnsSlot = burnsSlot
  }
}

/**
 * Slots live in memory on purpose: the endpoint is stateless, so a restart
 * drops every unminted file id and the client mints again. Nothing here is
 * worth persisting — an image that reached a message is already an attachment
 * reference held by the delivery path.
 */
export function createUploadStore({ attachments, config, logger = () => {}, now = () => Date.now() }) {
  const limits = uploadConfig(config)
  const byNonceHash = new Map()
  const byFileId = new Map()

  const nonceKey = (nonce) => createHash('sha256').update(nonce).digest('hex').slice(0, 32)

  function drop(slot) {
    slot.state = SLOT_GONE
    byNonceHash.delete(slot.nonceKey)
    byFileId.delete(slot.fileId)
  }

  function sweep(at = now()) {
    for (const slot of byFileId.values()) {
      const deadline = slot.state === SLOT_STORED ? slot.fileIdExpiresAt : slot.expiresAt
      if (deadline <= at) drop(slot)
    }
  }

  const timer = setInterval(() => sweep(), SWEEP_INTERVAL_MS)
  timer.unref?.()

  /** Mint one slot per requested file. */
  function mint(files, { origin }) {
    if (!attachments) {
      throw new UploadRejection(501, 'this DSH deployment exposes no attachment service, so file upload is unavailable')
    }
    if (!Array.isArray(files) || files.length === 0) {
      throw new UploadRejection(400, '"files" must be a non-empty array')
    }
    if (files.length > limits.maxFiles) {
      throw new UploadRejection(400, `"files" may hold at most ${limits.maxFiles} entries`)
    }
    const planned = files.map((file, index) => {
      const mediaType = file?.mediaType
      if (typeof mediaType !== 'string' || !UPLOAD_MEDIA_TYPES.includes(mediaType)) {
        throw new UploadRejection(415, `files[${index}].mediaType must be one of ${UPLOAD_MEDIA_TYPES.join(', ')}`)
      }
      const allowed = attachments.imageLimits?.mediaTypes
      if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(mediaType)) {
        throw new UploadRejection(415, `this deployment does not accept ${mediaType}`)
      }
      const expectedBytes = Number.isFinite(Number(file?.expectedBytes)) && Number(file.expectedBytes) > 0
        ? Math.min(Number(file.expectedBytes), limits.maxFileBytes)
        : limits.maxFileBytes
      const declaredSha = typeof file?.sha256 === 'string' ? file.sha256.toLowerCase() : undefined
      if (limits.requireSha256 && !declaredSha) {
        throw new UploadRejection(400, 'files[].sha256 is required by this deployment')
      }
      return { mediaType, expectedBytes, declaredSha, name: typeof file?.name === 'string' ? file.name : undefined }
    })
    const requested = planned.reduce((sum, item) => sum + item.expectedBytes, 0)
    if (requested > limits.maxBytes) {
      throw new UploadRejection(400, `this mint asks for ${requested} bytes; the limit is ${limits.maxBytes}`)
    }
    const pending = [...byFileId.values()].reduce((sum, slot) => sum + (slot.state === SLOT_STORED ? 0 : slot.maxBytes), 0)
    if (pending + requested > limits.globalBudgetBytes) {
      throw new UploadRejection(429, 'too many bytes are already in flight; retry once the earlier uploads land')
    }

    const mintedAt = now()
    return planned.map((item) => {
      const nonce = randomBytes(32).toString('base64url')
      const fileId = 'f_' + randomBytes(9).toString('base64url')
      const slot = {
        nonceKey: nonceKey(nonce),
        fileId,
        mediaType: item.mediaType,
        name: item.name,
        maxBytes: item.expectedBytes,
        declaredSha: item.declaredSha,
        attempts: 0,
        state: SLOT_MINTED,
        expiresAt: mintedAt + limits.ttlMs,
        fileIdExpiresAt: 0,
        ref: undefined,
        storedBytes: 0,
      }
      byNonceHash.set(slot.nonceKey, slot)
      byFileId.set(fileId, slot)
      return {
        fileId,
        uploadUrl: origin + ROUTE_PREFIX + nonce,
        method: 'PUT',
        expiresAt: new Date(slot.expiresAt).toISOString(),
        maxBytes: slot.maxBytes,
      }
    })
  }

  /** Resolve a file id for delivery, or explain why it cannot be used. */
  function resolve(fileId) {
    sweep()
    const slot = byFileId.get(fileId)
    if (!slot) throw new UploadRejection(404, `unknown fileId: ${fileId}`)
    if (slot.state !== SLOT_STORED) {
      throw new UploadRejection(409, `fileId ${fileId} has not finished uploading`)
    }
    return slot
  }

  /** Store one received body into its slot. */
  async function accept(nonce, buffer, contentType) {
    sweep()
    const slot = byNonceHash.get(nonceKey(nonce))
    if (!slot) throw new UploadRejection(410, 'this upload link is unknown or expired')

    const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase()
    if (declared && declared !== 'application/octet-stream' && declared !== slot.mediaType) {
      throw new UploadRejection(415, `this link was minted for ${slot.mediaType}, not ${declared}`)
    }
    if (slot.state === SLOT_STORED) throw new UploadRejection(409, 'this upload link has already been used')
    if (slot.state === SLOT_CONSUMING || slot.state === SLOT_GONE) {
      throw new UploadRejection(409, 'this upload link is already being consumed')
    }
    if (slot.expiresAt <= now()) {
      drop(slot)
      throw new UploadRejection(410, 'this upload link has expired')
    }
    if (buffer.length > slot.maxBytes) {
      throw new UploadRejection(413, `this link accepts at most ${slot.maxBytes} bytes`)
    }

    slot.state = SLOT_CONSUMING
    try {
      const mediaType = sniffMediaType(buffer)
      if (mediaType !== slot.mediaType) {
        slot.attempts += 1
        if (slot.attempts >= limits.maxAttempts) {
          drop(slot)
          throw new UploadRejection(410, 'too many failed attempts on this link')
        }
        throw new UploadRejection(415, `the bytes are not ${slot.mediaType}`)
      }
      const digest = sha256(buffer)
      if (slot.declaredSha && slot.declaredSha !== digest) {
        slot.attempts += 1
        if (slot.attempts >= limits.maxAttempts) {
          drop(slot)
          throw new UploadRejection(410, 'too many failed attempts on this link')
        }
        throw new UploadRejection(415, 'the bytes do not match the declared sha256')
      }
      const pixels = declaredPixels(buffer, slot.mediaType)
      if (pixels !== undefined && pixels > MAX_PIXELS) {
        slot.attempts += 1
        if (slot.attempts >= limits.maxAttempts) {
          drop(slot)
          throw new UploadRejection(410, 'too many failed attempts on this link')
        }
        throw new UploadRejection(413, 'the image dimensions exceed the 100 MP ceiling')
      }
      if (slot.expiresAt <= now()) {
        drop(slot)
        throw new UploadRejection(410, 'this upload link expired while the bytes were arriving')
      }

      const [ref] = await attachments.saveImages([{ data: buffer, mediaType: slot.mediaType, ...(slot.name ? { name: slot.name } : {}) }])
      slot.ref = ref
      slot.storedBytes = buffer.length
      slot.state = SLOT_STORED
      slot.fileIdExpiresAt = now() + limits.fileIdTtlMs
      logger('debug', 'file uploaded', { fileId: slot.fileId, bytes: slot.storedBytes, mediaType: slot.mediaType })
      return { fileId: slot.fileId, storedBytes: slot.storedBytes, sha256: digest, mediaType: slot.mediaType }
    } finally {
      if (slot.state === SLOT_CONSUMING) slot.state = SLOT_MINTED
    }
  }

  return {
    limits,
    available: Boolean(attachments),
    mint,
    accept,
    resolve,
    sweep,
    stats: () => ({
      pendingSlots: [...byFileId.values()].filter((slot) => slot.state !== SLOT_STORED).length,
      storedFileIds: [...byFileId.values()].filter((slot) => slot.state === SLOT_STORED).length,
    }),
    dispose: () => clearInterval(timer),
  }
}

/** Read a whole request body, refusing anything past *maxBytes*. */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new UploadRejection(413, `the request body exceeds ${maxBytes} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * The `PUT /mcp-files/<nonce>` handler.
 *
 * Registered with `kind: "prefix"`; everything after the prefix is the nonce.
 * No bearer token: the nonce is the capability, and requiring the endpoint
 * token here would make the feature unusable by a client that can only run a
 * shell command.
 */
export function createUploadRouteHandler({ store, logger = () => {} }) {
  return async function handleUpload(req, res) {
    const send = (status, body) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
      res.end(payload)
    }
    if ((req.method ?? '').toUpperCase() !== 'PUT') {
      send(405, { error: 'this endpoint accepts PUT only' })
      return
    }
    const nonce = String(req.url ?? '').slice(ROUTE_PREFIX.length)
    if (!nonce) {
      send(404, { error: 'missing upload nonce' })
      return
    }
    let buffer
    try {
      buffer = await readBody(req, store.limits.maxFileBytes)
    } catch (error) {
      const status = error instanceof UploadRejection ? error.status : 400
      send(status, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    const declared = req.headers?.['content-length']
    if (declared !== undefined && Number(declared) !== buffer.length) {
      send(400, { error: 'content-length does not match the bytes received' })
      return
    }
    try {
      send(200, await store.accept(nonce, buffer, req.headers?.['content-type']))
    } catch (error) {
      const status = error instanceof UploadRejection ? error.status : 500
      if (status === 500) logger('error', 'upload failed', { error: error instanceof Error ? error.message : String(error) })
      send(status, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export { ROUTE_PREFIX, UploadRejection }
