#!/usr/bin/env node
/**
 * Upload slot lifetime and attempt accounting.
 *
 * These cases need control over time, which the HTTP seam cannot offer, so they
 * drive the store directly. Everything observable through HTTP is covered in
 * `test/file-upload-test.mjs`.
 *
 * Run: node test/file-upload-store-test.mjs
 */
import assert from 'node:assert/strict'

import { createUploadStore } from '../lib/file-upload.js'

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const checks = []
async function check(name, fn) {
  await fn()
  checks.push(name)
}

function makeStore(overrides = {}) {
  let clock = 1_000_000
  const saved = []
  const store = createUploadStore({
    attachments: {
      imageLimits: { mediaTypes: ['image/png'] },
      async saveImages(inputs) {
        return inputs.map((input) => {
          const ref = { id: 'att_' + (saved.length + 1), mediaType: input.mediaType }
          saved.push(ref)
          return ref
        })
      },
    },
    config: overrides,
    now: () => clock,
  })
  return { store, saved, advance: (ms) => { clock += ms } }
}

await check('a link stops accepting bytes once its window closes', async () => {
  const { store, advance } = makeStore({ uploadTtlMs: 60_000 })
  const [slot] = store.mint([{ mediaType: 'image/png', expectedBytes: PNG_1PX.length }], { origin: 'http://x' })
  advance(60_001)
  await assert.rejects(async () => store.begin(slot.uploadUrl.split('/').at(-1)), /expired/)
})

await check('three failed attempts burn the link', async () => {
  const { store } = makeStore({ uploadMaxAttempts: 3 })
  const [slot] = store.mint([{ mediaType: 'image/png' }], { origin: 'http://x' })
  const nonce = slot.uploadUrl.split('/').at(-1)
  const garbage = Buffer.from('not a png')
  const upload = async (bytes) => store.commit(store.begin(nonce), bytes)
  await assert.rejects(() => upload(garbage), /not image\/png/)
  await assert.rejects(() => upload(garbage), /not image\/png/)
  await assert.rejects(() => upload(garbage), /too many failed attempts/)
  await assert.rejects(async () => store.begin(nonce), /unknown or expired/, 'even a good upload cannot revive it')
})

await check('a declared digest that does not match is refused', async () => {
  const { store } = makeStore({ uploadRequireSha256: true })
  assert.throws(
    () => store.mint([{ mediaType: 'image/png' }], { origin: 'http://x' }),
    /sha256 is required/,
  )
  const [slot] = store.mint([{ mediaType: 'image/png', sha256: 'a'.repeat(64) }], { origin: 'http://x' })
  await assert.rejects(
    async () => store.commit(store.begin(slot.uploadUrl.split('/').at(-1)), PNG_1PX),
    /do not match the declared sha256/,
  )
})

await check('the stored reference stays usable until its own ttl, then reports unknown', async () => {
  const { store, advance } = makeStore({ fileIdTtlMs: 60_000 })
  const [slot] = store.mint([{ mediaType: 'image/png', expectedBytes: PNG_1PX.length }], { origin: 'http://x' })
  await store.commit(store.begin(slot.uploadUrl.split('/').at(-1)), PNG_1PX)
  assert.equal(store.resolve(slot.fileId).state, 'stored')
  advance(60_001)
  assert.throws(() => store.resolve(slot.fileId), /unknown fileId/)
})

await check('an image whose declared dimensions exceed the ceiling is refused', async () => {
  const { store } = makeStore()
  const [slot] = store.mint([{ mediaType: 'image/png' }], { origin: 'http://x' })
  const bomb = Buffer.from(PNG_1PX)
  bomb.writeUInt32BE(20_000, 16) // width
  bomb.writeUInt32BE(20_000, 20) // height
  await assert.rejects(
    async () => store.commit(store.begin(slot.uploadUrl.split('/').at(-1)), bomb),
    /100 MP/,
  )
})

for (const name of checks) process.stdout.write('ok - ' + name + '\n')
process.stdout.write('\n' + checks.length + ' upload-store checks passed\n')
