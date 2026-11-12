#!/usr/bin/env node
/**
 * The `/mcp-scope` route: what the settings page reads and writes.
 *
 * The handler is driven over a real socket so the peer address is genuinely
 * loopback, and `trust` is stubbed because what it decides here is only whether
 * workspace paths travel, not whether the write is allowed.
 *
 * Run: node test/scope-route-test.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'

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

const WORKSPACES = [
  { id: 'ws_a', title: 'hermes', path: '/repo/hermes' },
  { id: 'ws_b', title: 'twin', path: '/workspace/twin' },
]

/** A scope double whose save records what it was asked to store. */
function fakeScope({ supported = true, mode = 'global', workspaceIds = [], saveError = undefined } = {}) {
  const saved = []
  let current = { supported, mode, workspaceIds, notes: [], unmatchedAgents: 0 }
  return {
    saved,
    supported,
    state: () => ({ ...current, workspaceIds: [...current.workspaceIds] }),
    async save(input) {
      if (saveError) throw saveError
      saved.push(input)
      current = { ...current, mode: input.mode, workspaceIds: [...(input.workspaceIds ?? [])] }
      return { ...current }
    },
  }
}

async function serve(handler) {
  const server = createServer((req, res) => void handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

async function withServer(options, run) {
  const handler = createScopeHandler({ registry: { list: () => WORKSPACES }, trust: () => true, ...options })
  const { server, base } = await serve(handler)
  try {
    await run(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// --- reading -----------------------------------------------------------------

await check('GET reports the document and the workspaces the page can pick from', async () => {
  const scope = fakeScope({ mode: 'selected', workspaceIds: ['ws_a'] })
  await withServer({ scope }, async (base) => {
    const body = await (await fetch(base)).json()
    assert.equal(body.supported, true)
    assert.equal(body.mode, 'selected')
    assert.deepEqual(body.workspaceIds, ['ws_a'])
    assert.deepEqual(body.workspaces.map((row) => row.id), ['ws_a', 'ws_b'])
  })
})

await check('workspace paths travel only to a trusted caller', async () => {
  const scope = fakeScope()
  await withServer({ scope, trust: () => false }, async (base) => {
    const body = await (await fetch(base)).json()
    assert.ok(body.workspaces.every((row) => row.path === undefined), 'untrusted responses must not enumerate directories')
    assert.equal(body.workspaces[0].title, 'hermes')
  })
})

// --- writing -----------------------------------------------------------------

await check('POST saves the selection and answers with the live state', async () => {
  const scope = fakeScope()
  await withServer({ scope }, async (base) => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.mode, 'selected')
    assert.deepEqual(body.workspaceIds, ['ws_a'], 'the answer must be the saved state, not the previous one')
    assert.deepEqual(scope.saved, [{ mode: 'selected', workspaceIds: ['ws_a'] }])
  })
})

await check('a refused save reports its own status and code', async () => {
  const error = Object.assign(new Error('invalid-mode: nope'), { status: 400, code: 'invalid-mode' })
  const scope = fakeScope({ saveError: error })
  await withServer({ scope }, async (base) => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'nope' }),
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'invalid-mode')
  })
})

await check('an unsupported Harness refuses the write instead of storing it', async () => {
  const scope = fakeScope({ supported: false })
  await withServer({ scope }, async (base) => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'global' }),
    })
    assert.equal(response.status, 501)
    assert.equal((await response.json()).code, 'scope-unsupported')
    assert.equal(scope.saved.length, 0)
  })
})

await check('a non-JSON body is refused before anything is stored', async () => {
  const scope = fakeScope()
  await withServer({ scope }, async (base) => {
    const response = await fetch(base, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'mode=global' })
    assert.equal(response.status, 415)
    assert.equal(scope.saved.length, 0)
  })
})

await check('malformed JSON is a 400, not a crash', async () => {
  const scope = fakeScope()
  await withServer({ scope }, async (base) => {
    const response = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'invalid-body')
  })
})

await check('a method other than GET/HEAD/POST is refused with the allowed list', async () => {
  const scope = fakeScope()
  await withServer({ scope }, async (base) => {
    const response = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET, HEAD, POST')
  })
})

await check('an Origin outside the allowlist cannot change the scope', async () => {
  const scope = fakeScope()
  await withServer({ scope, allowedOrigins: ['http://192.168.50.216:23022'] }, async (base) => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ mode: 'global' }),
    })
    assert.equal(response.status, 403)
    assert.equal(scope.saved.length, 0)
  })
})

// --- summary -----------------------------------------------------------------

console.log(`\n${passed} scope-route checks passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
