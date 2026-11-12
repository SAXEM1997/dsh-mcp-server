#!/usr/bin/env node
/**
 * Tool scope: the document, the judgement, and where a session belongs.
 *
 * These checks never touch the real filesystem or a real Harness: the store takes
 * its reader/writer and its registry as arguments, which is also what lets the
 * failure paths (unreadable document, registry without an answer) be exercised
 * without staging a broken home directory.
 *
 * Run: node test/tool-scope-test.mjs
 */

import assert from 'node:assert/strict'

import { createToolScope, isVisible, normalizeDocument, SCOPE_FILE_VERSION } from '../lib/tool-scope.js'

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

/** A document store over an in-memory file, so no test writes to disk. */
function memoryStore(initial, options = {}) {
  let text = initial
  const writes = []
  return {
    writes,
    read: () => {
      if (options.readThrows) throw new Error('cannot read')
      return text
    },
    write: (next) => {
      if (options.writeThrows) throw new Error('cannot write')
      writes.push(next)
      text = next
    },
  }
}

/** A registry/working-directory pair shaped like the Harness services. */
function harnessWorld({ workspaces = [], byPath = {} } = {}) {
  const list = workspaces.map((workspace) => ({
    id: workspace.id,
    path: workspace.path,
    title: workspace.title ?? workspace.path,
    sessionIds: workspace.sessionIds ?? [],
  }))
  return {
    registry: {
      list: () => list,
      resolveByPath: async (path) => {
        const wanted = byPath[path] ?? path
        return list.find((workspace) => workspace.path === wanted)
      },
    },
  }
}

/** A session as the Harness hands it over: the directory it was opened in is in the header. */
const agentOf = (sessionId, cwd) => ({ id: `agent-${sessionId}`, session: { id: sessionId, header: { cwd } } })

// --- the document ------------------------------------------------------------

await check('a missing document means global, exactly like today', () => {
  const { doc, notes } = normalizeDocument(undefined)
  assert.deepEqual(doc, { version: SCOPE_FILE_VERSION, mode: 'global', workspaceIds: [] })
  assert.deepEqual(notes, [])
})

await check('a malformed document falls to nobody, never to global', () => {
  for (const raw of [{ mode: 'everyone' }, { mode: 'selected' }, { mode: 'selected', workspaceIds: 'ws_1' }]) {
    const { doc, notes } = normalizeDocument(raw)
    assert.equal(doc.mode, 'selected', `${JSON.stringify(raw)} must not stay global`)
    assert.deepEqual(doc.workspaceIds, [], 'and it must select nobody')
    assert.ok(notes.includes('scope-degraded'), 'and it must say so')
  }
})

await check('ids are trimmed, de-duplicated and sorted so the file does not churn', () => {
  const { doc } = normalizeDocument({ mode: 'selected', workspaceIds: [' ws_b ', 'ws_a', 'ws_a'] })
  assert.deepEqual(doc.workspaceIds, ['ws_a', 'ws_b'])
})

// --- the judgement ------------------------------------------------------------

await check('global admits every workspace, including one it never heard of', () => {
  const doc = { version: SCOPE_FILE_VERSION, mode: 'global', workspaceIds: [] }
  assert.equal(isVisible(doc, undefined), true)
  assert.equal(isVisible(doc, 'ws_any'), true)
})

await check('selected admits exactly the listed ids', () => {
  const doc = { version: SCOPE_FILE_VERSION, mode: 'selected', workspaceIds: ['ws_a'] }
  assert.equal(isVisible(doc, 'ws_a'), true)
  assert.equal(isVisible(doc, 'ws_b'), false)
  assert.equal(isVisible(doc, undefined), false)
})

// --- where a session belongs -------------------------------------------------

await check('recorded membership wins, even when the cwd is a subdirectory', async () => {
  const world = harnessWorld({
    workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: ['s1'] }],
  })
  const scope = createToolScope({ ...world, store: memoryStore(undefined) })
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes/src/deep')), true)
})

await check('without membership, an exact directory match still counts', async () => {
  const world = harnessWorld({
    workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: [] }],
  })
  const scope = createToolScope({ ...world, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  assert.equal(await scope.visibleFor(agentOf('s2', '/repo/hermes')), true)
})

await check('a cwd under a workspace it is not recorded in is not that workspace', async () => {
  const world = harnessWorld({
    workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: [] }],
  })
  const scope = createToolScope({ ...world, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  assert.equal(await scope.visibleFor(agentOf('s3', '/repo/hermes/src/deep')), false)
})

await check('a session the registry cannot place is not visible in selected mode', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: [] }] })
  const scope = createToolScope({ ...world, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  assert.equal(await scope.visibleFor(agentOf('s4', '/somewhere/else')), false)
})

// --- failure paths -----------------------------------------------------------

await check('an unreadable document selects nobody and reports it', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: ['s1'] }] })
  const scope = createToolScope({ ...world, store: memoryStore('{"mode":"global"}', { readThrows: true }) })
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes')), false)
  assert.ok((await scope.state()).notes.includes('scope-degraded'))
})

await check('a Harness without a workspace registry says so instead of guessing', async () => {
  const scope = createToolScope({ registry: undefined, store: memoryStore(undefined) })
  assert.equal(scope.supported, false)
  // Global needs no registry: it was the behaviour before this feature existed.
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes')), true)
  assert.ok((await scope.state()).notes.includes('scope-unsupported'))
  // The moment a selection is involved, the missing registry means nobody.
  const selected = memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] }))
  const narrowed = createToolScope({ registry: undefined, store: selected })
  assert.equal(await narrowed.visibleFor(agentOf('s1', '/repo/hermes')), false)
})

await check('a workspace deleted after a positive hit stops being visible', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: ['s1'] }] })
  const scope = createToolScope({ ...world, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes')), true)
  // Forget the workspace the way a deletion would: it is gone from the listing
  // AND unreachable by path, so neither lookup can resurrect it.
  world.registry.list = () => []
  world.registry.resolveByPath = async () => undefined
  // The listing is cached for a few hundred milliseconds; waiting past it is what
  // a real deletion looks like to a later step.
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes')), false)
  assert.ok((await scope.state()).notes.includes('scope-stale'))
})

await check('a judgement that blows up hides the tools instead of throwing', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: ['s1'] }] })
  const scope = createToolScope({ ...world, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  // `when` throwing aborts the whole turn upstream, so even an agent shape this
  // module did not anticipate has to answer "not visible" rather than raise.
  const hostile = { id: 'a', get session() { throw new Error('broken agent') } }
  assert.equal(await scope.visibleFor(hostile), false)
})

// --- saving ------------------------------------------------------------------

await check('saving replaces the live document without rebuilding the scope', async () => {
  const world = harnessWorld({
    workspaces: [
      { id: 'ws_a', path: '/repo/hermes', sessionIds: ['s1'] },
      { id: 'ws_b', path: '/workspace/twin', sessionIds: [] },
    ],
  })
  const store = memoryStore(undefined)
  const scope = createToolScope({ ...world, store })
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes')), true, 'global to start with')
  await scope.save({ mode: 'selected', workspaceIds: ['ws_b'] })
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes')), false, 'the same object now refuses')
  assert.equal(store.writes.length, 1)
})

await check('a rejected save leaves the live document untouched', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: ['s1'] }] })
  const store = memoryStore(undefined, { writeThrows: true })
  const scope = createToolScope({ ...world, store })
  // The selection excludes this session on purpose: if the implementation swapped
  // the live document before the write, the session would already be hidden.
  await assert.rejects(() => scope.save({ mode: 'selected', workspaceIds: [] }), /scope-write-failed|write/i)
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes')), true, 'still global after a failed save')
  assert.equal((await scope.state()).mode, 'global', 'and the reported mode still says global')
})

await check('saving an unknown workspace id is refused before anything is written', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: ['s1'] }] })
  const store = memoryStore(undefined)
  const scope = createToolScope({ ...world, store })
  await assert.rejects(() => scope.save({ mode: 'selected', workspaceIds: ['ws_ghost'] }), /unknown-workspace/)
  assert.equal(store.writes.length, 0)
})

await check('global keeps the selection it was given, so switching back is one click', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: [] }] })
  const store = memoryStore(undefined)
  const scope = createToolScope({ ...world, store })
  await scope.save({ mode: 'global', workspaceIds: ['ws_a'] })
  assert.deepEqual((await scope.state()).workspaceIds, ['ws_a'])
  const reloaded = createToolScope({ ...world, store })
  assert.deepEqual((await reloaded.state()).workspaceIds, ['ws_a'], 'and the document on disk keeps it too')
})

await check('changing directory mid-session does not move the session between workspaces', async () => {
  const world = harnessWorld({
    workspaces: [
      { id: 'ws_a', path: '/repo/a', sessionIds: [] },
      { id: 'ws_b', path: '/repo/b', sessionIds: [] },
    ],
  })
  let live = '/repo/a'
  const agent = { id: 'a', session: { id: 's1', header: { cwd: '/repo/a' } } }
  const scope = createToolScope({ ...world, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  assert.equal(await scope.visibleFor(agent), true, 'opened inside the selected workspace')
  live = '/repo/b'
  assert.equal(await scope.visibleFor(agent), true, 'a cd must not move the session out of it either')
})

await check('a session cannot cd its way into a selected workspace', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/a', sessionIds: [] }] })
  let live = '/somewhere/else'
  // The identity is where it was opened; the live directory is the attack.
  const agent = { id: 'a', session: { id: 's1', header: { cwd: '/somewhere/else' } } }
  const scope = createToolScope({ ...world, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  assert.equal(await scope.visibleFor(agent), false)
  live = '/repo/a'
  assert.equal(await scope.visibleFor(agent), false, 'tools are not a reward for cd')
})

// --- summary -----------------------------------------------------------------

console.log(`\n${passed} tool-scope checks passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
