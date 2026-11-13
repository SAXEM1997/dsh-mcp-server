#!/usr/bin/env node
/**
 * Who may read and write the two settings routes.
 *
 * The browser talks to the plugin from another machine, so the TCP peer is never
 * loopback. An operator who names an Origin in `allowedConfigOrigins` has said
 * which page may do this; requiring loopback as well made that setting inert and
 * left the settings page answering 403 from every other machine.
 *
 * What must NOT move: an unnamed Origin, a missing Origin, and a `trust` that
 * says no all stay refused.
 *
 * Run: node test/route-origin-test.mjs
 */

import assert from 'node:assert/strict'

import { createConfigHandler } from '../lib/config-route.js'
import { createScopeHandler } from '../lib/scope-route.js'

let passed = 0
const failures = []
async function check(name, run) {
  try {
    await run()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL - ${name}\n  ${error && error.message ? error.message : String(error)}`)
  }
}

const LAN = 'http://192.168.50.216:23022'
const FOREIGN = '10.0.0.7'

/** One response sink that only records what the route decided. */
function recorder() {
  return {
    statusCode: 0,
    body: '',
    headers: {},
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {} },
    end(body) { this.body = body ?? '' },
  }
}

/** A request as the plugin sees it: a peer address, a Host and maybe an Origin. */
function request({ method = 'GET', peer = FOREIGN, origin, host = '192.168.50.216:23022' } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  return { method, socket: { remoteAddress: peer }, headers }
}

const configHandler = ({ allowedOrigins = [], trust } = {}) => createConfigHandler({
  snapshot: async () => ({ package: 'dsh-mcp-btwy', version: '0.0.0' }),
  write: async () => {},
  remove: async () => ({ removed: [], missing: [] }),
  queueSession: async () => false,
  ackCommand: async () => {},
  trust,
  allowedOrigins,
})

const scopeHandler = ({ allowedOrigins = [], trust } = {}) => createScopeHandler({
  scope: { state: async () => ({ mode: 'global', workspaceIds: [], notes: [], unmatchedAgents: 0 }) },
  registry: { list: () => [] },
  trust,
  allowedOrigins,
})

async function hit(handler, req) {
  const res = recorder()
  await handler(req, res)
  return res
}

await check('the settings route refuses a foreign peer that names no Origin', async () => {
  const res = await hit(configHandler({ allowedOrigins: [LAN] }), request())
  assert.equal(res.statusCode, 403)
})

await check('the settings route admits a foreign peer whose Origin the operator named', async () => {
  // The defect: the loopback test ran first and unconditionally, so naming an
  // Origin changed nothing for anyone not already on the machine.
  const res = await hit(configHandler({ allowedOrigins: [LAN] }), request({ origin: LAN }))
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}`)
})

await check('the settings route still refuses a foreign peer with an unnamed Origin', async () => {
  const res = await hit(configHandler({ allowedOrigins: [LAN] }), request({ origin: 'http://evil.example' }))
  assert.equal(res.statusCode, 403)
})

await check('naming an Origin does not skip the trust function', async () => {
  const res = await hit(configHandler({ allowedOrigins: [LAN], trust: () => false }), request({ origin: LAN }))
  assert.equal(res.statusCode, 403, 'an allowlisted Origin cannot bypass trust')
})

await check('the settings route still answers loopback without any Origin', async () => {
  const res = await hit(configHandler({ allowedOrigins: [] }), request({ peer: '127.0.0.1' }))
  assert.equal(res.statusCode, 200)
})

await check('the tool scope route follows the same rule', async () => {
  const handler = scopeHandler({ allowedOrigins: [LAN], trust: () => true })
  assert.equal((await hit(handler, request())).statusCode, 403, 'a foreign peer with no Origin is refused')
  assert.equal((await hit(handler, request({ origin: 'http://evil.example' }))).statusCode, 403, 'an unnamed Origin is refused')
  assert.equal((await hit(handler, request({ origin: LAN }))).statusCode, 200, 'the named Origin is admitted')
  assert.equal((await hit(scopeHandler({ allowedOrigins: [LAN], trust: () => false }), request({ origin: LAN }))).statusCode, 403, 'trust still decides')
})

if (failures.length > 0) {
  console.error(`\n${failures.length} route-origin checks failed`)
  process.exit(1)
}
console.log(`\n${passed} route-origin checks passed`)
