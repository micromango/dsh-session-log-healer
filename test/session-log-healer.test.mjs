import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { scheduler } from 'node:timers/promises'
import zlib from 'node:zlib'
import { apply, inject, scanFrames, scanAndRepair } from '../index.js'

const parentRoot = fs.realpathSync(process.env.HEALER_TEST_ROOT || os.tmpdir())
const fixtureRoot = fs.mkdtempSync(path.join(parentRoot, 'dsh-healer-regression-'))
after(() => {
  const relative = path.relative(parentRoot, fs.realpathSync(fixtureRoot))
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

const header = JSON.stringify({ type: 'session', version: 4, id: 'regression-fixture', createdAt: 0, isSeeded: false, delegationDepth: 0 }) + '\n'
const event = (seq, text) => JSON.stringify({ type: 'healer/test-record', seq, time: seq, ignorable: true, data: { text } }) + '\n'
const firstEvent = event(0, 'original record')
const laterEvent = event(1, 'later record: 后续消息')
const addedEvent = event(2, 'concurrent append must survive')
const plaintext = Buffer.from(header + firstEvent + laterEvent)
const encode = (bytes) => zlib.zstdCompressSync(Buffer.from(bytes), { params: { 201: 1 } })
const valid = Buffer.concat([encode(header), encode(firstEvent + laterEvent)])
const repairable = Buffer.concat([encode(header + firstEvent), encode(laterEvent)])
const decode = (bytes) => Buffer.concat(scanFrames(bytes).map(({ start, end }) => zlib.zstdDecompressSync(bytes.subarray(start, end))))

function fixture(label, bytes = repairable) {
  const dir = fs.mkdtempSync(path.join(fixtureRoot, label + '-'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(file, bytes)
  const oldTime = new Date(Date.now() - 20 * 60 * 1000)
  fs.utimesSync(file, oldTime, oldTime)
  return { dir, file, original: Buffer.from(bytes) }
}

function backend(root) {
  const held = new Set()
  return {
    name: 'session-persistence-jsonl', compression: 'zstd', root,
    catalog: {
      currentVersion: 4,
      createRestore(headerRecord) {
        const events = []
        return { decodeRow: (row) => events.push(row), finish: () => ({ header: headerRecord, events }) }
      },
    },
    acquisitions: 0, releases: 0, validations: 0,
    async acquireLease(id, cwd, dir) {
      this.acquisitions++
      if (held.has(dir)) throw Object.assign(new Error('active write handle'), { name: 'SessionAlreadyOwnedError' })
      held.add(dir)
      let released = false
      return { release: async () => {
        if (!released) { held.delete(dir); this.releases++; released = true }
      } }
    },
    async readZstdPrefix(bytes, signal) {
      signal?.throwIfAborted()
      this.validations++
      const frames = scanFrames(bytes)
      const first = zlib.zstdDecompressSync(bytes.subarray(frames[0].start, frames[0].end))
      assert.equal(first.indexOf(10), first.length - 1, 'independent header required')
      const plain = decode(bytes).toString('utf8')
      assert.ok(plain.endsWith('\n'), 'complete JSONL required')
      const records = plain.slice(0, -1).split('\n').map((line) => JSON.parse(line))
      return { meta: records[0], events: records.slice(1) }
    },
  }
}

async function scan(subject, overrides = {}) {
  const storage = overrides.backend || backend(subject.dir)
  const logs = []
  const stats = await scanAndRepair(subject.dir, { backend: storage, log: (level, message) => logs.push({ level, message }), ...overrides })
  return { stats, logs, backend: storage }
}

function backups(subject) {
  return fs.readdirSync(subject.dir).filter((name) => name.endsWith('.bak')).map((name) => path.join(subject.dir, name))
}

function noStaging(subject) {
  assert.ok(fs.readdirSync(subject.dir).every((name) => !name.endsWith('.tmp')))
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function withTimers(fn) {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const timers = []
  globalThis.setTimeout = (callback, milliseconds) => {
    const timer = { callback, milliseconds, cleared: false, unref() {} }
    timers.push(timer)
    return timer
  }
  globalThis.clearTimeout = (timer) => { if (timer) timer.cleared = true }
  try { await fn(timers) } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
}

function context(storage) {
  const logs = []
  let dispose
  return {
    sessionPersistence: storage,
    get(key) { return key === 'loader' ? { import: async () => ({ sessionFormatCatalog: storage.catalog }) } : undefined },
    logger: Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (message) => logs.push({ level, message })])),
    on(eventName, callback) { assert.equal(eventName, 'dispose'); dispose = callback },
    dispose: () => dispose?.(),
    logs,
  }
}

async function withWrites(hook, fn) {
  const realOpen = fs.openSync
  const realClose = fs.closeSync
  const realWrite = fs.writeFileSync
  const handles = new Map()
  fs.openSync = (file, flags, ...args) => {
    const fd = realOpen(file, flags, ...args)
    handles.set(fd, { file: String(file), flags })
    return fd
  }
  fs.closeSync = (fd) => { handles.delete(fd); return realClose(fd) }
  fs.writeFileSync = (target, data, ...args) => hook({ target, data, args, file: handles.get(target)?.file ?? String(target), flags: handles.get(target)?.flags, write: () => realWrite(target, data, ...args) })
  try { await fn() } finally {
    fs.openSync = realOpen
    fs.closeSync = realClose
    fs.writeFileSync = realWrite
  }
}

test('repair preserves every valid original frame and all plaintext bytes', async () => {
  const subject = fixture('all-frames')
  const result = await scan(subject)
  assert.equal(result.stats.repaired, 1)
  assert.ok(decode(fs.readFileSync(subject.file)).equals(plaintext))
  assert.equal(backups(subject).length, 1)
  assert.ok(fs.readFileSync(backups(subject)[0]).equals(subject.original))
  assert.equal(result.backend.acquisitions, result.backend.releases)
  noStaging(subject)
})

test('valid sessions remain byte-identical without a backup', async () => {
  const subject = fixture('valid', valid)
  const result = await scan(subject)
  assert.equal(result.stats.ok, 1)
  assert.ok(fs.readFileSync(subject.file).equals(valid))
  assert.equal(backups(subject).length, 0)
})

test('damage in a later checksum never rewrites a decoded prefix', async () => {
  const bytes = Buffer.from(valid)
  bytes[bytes.length - 1] ^= 1
  const subject = fixture('later-checksum', bytes)
  const result = await scan(subject)
  assert.equal(result.stats.manual, 1)
  assert.equal(result.stats.repaired, 0)
  assert.ok(fs.readFileSync(subject.file).equals(bytes))
  assert.equal(backups(subject).length, 0)
})

test('legal empty frames are accepted without rewriting', async () => {
  const bytes = Buffer.concat([encode(header), encode(Buffer.alloc(0))])
  const subject = fixture('empty-frame', bytes)
  const result = await scan(subject)
  assert.equal(result.stats.ok, 1)
  assert.ok(fs.readFileSync(subject.file).equals(bytes))
  assert.equal(backups(subject).length, 0)
})

test('a nonempty streaming frame with an empty final raw block is accepted', async () => {
  const compressor = zlib.createZstdCompress()
  const chunks = []
  const finished = new Promise((resolve, reject) => { compressor.on('data', (chunk) => chunks.push(Buffer.from(chunk))); compressor.once('end', resolve); compressor.once('error', reject) })
  compressor.write(header)
  await new Promise((resolve, reject) => compressor.flush((error) => error ? reject(error) : resolve()))
  compressor.end()
  await finished
  const bytes = Buffer.concat(chunks)
  const subject = fixture('empty-final-raw', bytes)
  const result = await scan(subject)
  assert.equal(result.stats.ok, 1)
  assert.ok(fs.readFileSync(subject.file).equals(bytes))
})

test('invalid JSONL and incomplete headers are manual, not OK', async (t) => {
  const cases = [
    ['empty-file', Buffer.alloc(0)],
    ['invalid-json', Buffer.concat([encode(header), encode('not valid JSON\n')])],
    ['missing-header-fields', encode('{"type":"session"}\n')],
    ['invalid-header-time', encode(JSON.stringify({ ...JSON.parse(header), createdAt: -1 }) + '\n')],
    ['foreign-version', encode(JSON.stringify({ ...JSON.parse(header), version: 5 }) + '\n')],
    ['primitive-body', Buffer.concat([encode(header), encode('42\n')])],
    ['missing-event-type', Buffer.concat([encode(header), encode('{}\n')])],
  ]
  for (const [label, bytes] of cases) await t.test(label, async () => {
    const subject = fixture(label, bytes)
    const result = await scan(subject)
    assert.equal(result.stats.manual, 1)
    assert.equal(result.stats.ok, 0)
    assert.ok(fs.readFileSync(subject.file).equals(bytes))
    assert.equal(backups(subject).length, 0)
  })
})

test('invalid UTF-8 is rejected without replacement-character rewriting', async () => {
  const bytes = encode(Buffer.concat([Buffer.from(header + '{"type":"healer/test-record","data":{"text":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}}\n')]))
  const subject = fixture('invalid-utf8', bytes)
  const result = await scan(subject)
  assert.equal(result.stats.manual, 1)
  assert.ok(fs.readFileSync(subject.file).equals(bytes))
  assert.equal(backups(subject).length, 0)
})

test('a complete final JSON record may gain only its missing newline', async () => {
  const withoutNewline = Buffer.from(header + firstEvent + laterEvent.slice(0, -1))
  const subject = fixture('missing-newline', Buffer.concat([encode(header), encode(firstEvent + laterEvent.slice(0, -1))]))
  const result = await scan(subject)
  const after = decode(fs.readFileSync(subject.file))
  assert.equal(result.stats.repaired, 1)
  assert.ok(after.subarray(0, withoutNewline.length).equals(withoutNewline))
  assert.equal(after.length, withoutNewline.length + 1)
  assert.equal(after.at(-1), 10)
})

test('partial JSON and torn compressed tails are retained for manual handling', async (t) => {
  const cases = [
    ['partial-json', Buffer.concat([encode(header), encode('{"type":"healer/test-record"')])],
    ['torn-zstd', valid.subarray(0, -2)],
  ]
  for (const [label, bytes] of cases) await t.test(label, async () => {
    const subject = fixture(label, bytes)
    const result = await scan(subject)
    assert.equal(result.stats.manual, 1)
    assert.ok(fs.readFileSync(subject.file).equals(bytes))
  })
})

test('an owned session is skipped even with the recent-write guard disabled', async () => {
  const subject = fixture('owned')
  const storage = backend(subject.dir)
  const writerLease = await storage.acquireLease('writer', undefined, subject.dir)
  const result = await scan(subject, { backend: storage, scanActive: false })
  assert.equal(result.stats.skipped, 1)
  assert.equal(storage.validations, 0)
  assert.ok(fs.readFileSync(subject.file).equals(subject.original))
  await writerLease.release()
})

test('recent files are skipped before acquiring a lease', async () => {
  const subject = fixture('recent')
  fs.utimesSync(subject.file, new Date(), new Date())
  const result = await scan(subject)
  assert.equal(result.stats.skipped, 1)
  assert.equal(result.backend.acquisitions, 0)
})

test('an append during validation is detected and preserved', async () => {
  const subject = fixture('concurrent-append')
  const storage = backend(subject.dir)
  const read = storage.readZstdPrefix.bind(storage)
  let appended = false
  storage.readZstdPrefix = async (...args) => {
    if (!appended) { fs.appendFileSync(subject.file, encode(addedEvent)); appended = true }
    return read(...args)
  }
  const result = await scan(subject, { backend: storage })
  assert.equal(result.stats.skipped, 1)
  assert.ok(fs.readFileSync(subject.file).equals(Buffer.concat([subject.original, encode(addedEvent)])))
  assert.equal(backups(subject).length, 0)
  noStaging(subject)
})

test('a partial staging write leaves the live file intact', async () => {
  const subject = fixture('partial-staging')
  await withWrites(({ target, data, file, write }) => {
    if (file.endsWith('.tmp')) { fs.writeSync(target, data.subarray(0, 12)); throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' }) }
    return write()
  }, async () => {
    const result = await scan(subject)
    assert.equal(result.stats.manual, 1)
  })
  assert.ok(fs.readFileSync(subject.file).equals(subject.original))
  assert.equal(backups(subject).length, 0)
  noStaging(subject)
})

test('a backup write failure leaves the original intact and removes only partial staging', async () => {
  const subject = fixture('partial-backup')
  await withWrites(({ target, data, file, write }) => {
    if (file.endsWith('.bak')) { fs.writeSync(target, data.subarray(0, 12)); throw Object.assign(new Error('simulated backup ENOSPC'), { code: 'ENOSPC' }) }
    return write()
  }, async () => {
    const result = await scan(subject)
    assert.equal(result.stats.manual, 1)
  })
  assert.ok(fs.readFileSync(subject.file).equals(subject.original))
  assert.equal(backups(subject).length, 0)
  noStaging(subject)
})

test('a failed atomic rename retains the original and its complete backup', async () => {
  const subject = fixture('rename-failure')
  const realRename = fs.renameSync
  fs.renameSync = (source, destination) => { if (destination === subject.file) throw Object.assign(new Error('simulated rename I/O failure'), { code: 'EIO' }); return realRename(source, destination) }
  try {
    const result = await scan(subject)
    assert.equal(result.stats.manual, 1)
  } finally { fs.renameSync = realRename }
  assert.ok(fs.readFileSync(subject.file).equals(subject.original))
  assert.ok(fs.readFileSync(backups(subject)[0]).equals(subject.original))
  noStaging(subject)
})

test('successful repair never opens the live file for a truncating write', async () => {
  const subject = fixture('atomic-replacement')
  const writes = []
  const renames = []
  const realRename = fs.renameSync
  fs.renameSync = (source, destination) => { renames.push({ source, destination }); return realRename(source, destination) }
  try {
    await withWrites(({ file, flags, write }) => { writes.push({ file, flags }); return write() }, async () => {
      assert.equal((await scan(subject)).stats.repaired, 1)
    })
  } finally { fs.renameSync = realRename }
  assert.ok(writes.every(({ file }) => file !== subject.file))
  assert.ok(writes.every(({ flags }) => flags === 'wx'))
  assert.equal(renames.filter(({ destination }) => destination === subject.file).length, 1)
  assert.ok(decode(fs.readFileSync(subject.file)).equals(plaintext))
})

test('disposal during staging validation cancels the repair and releases its lease', async () => {
  const subject = fixture('dispose-validation')
  const storage = backend(subject.dir)
  const read = storage.readZstdPrefix.bind(storage)
  const entered = deferred()
  const continueValidation = deferred()
  let validations = 0
  storage.readZstdPrefix = async (...args) => {
    if (++validations === 2) { entered.resolve(); await continueValidation.promise }
    return read(...args)
  }
  await withTimers(async (timers) => {
    const ctx = context(storage)
    await apply(ctx, { startupDelayMs: 0 })
    timers[0].callback()
    await entered.promise
    const disposed = ctx.dispose()
    continueValidation.resolve()
    await disposed
    await scheduler.yield()
    assert.equal(storage.acquisitions, storage.releases)
    assert.ok(ctx.logs.every(({ message }) => !message.includes('] repaired ')))
    assert.equal(timers.length, 1)
  })
  assert.ok(fs.readFileSync(subject.file).equals(subject.original))
  assert.equal(backups(subject).length, 0)
  noStaging(subject)
})

test('disposal after a complete backup still prevents the final replacement', async () => {
  const subject = fixture('dispose-after-backup')
  const storage = backend(subject.dir)
  await withTimers(async (timers) => {
    const ctx = context(storage)
    const backupWritten = deferred()
    let disposed
    await apply(ctx, { startupDelayMs: 0 })
    await withWrites(({ file, write }) => {
      const result = write()
      if (file.endsWith('.bak')) { disposed = ctx.dispose(); backupWritten.resolve() }
      return result
    }, async () => {
      timers[0].callback()
      await backupWritten.promise
      await disposed
      await scheduler.yield()
    })
    assert.equal(storage.acquisitions, storage.releases)
    assert.ok(ctx.logs.every(({ message }) => !message.includes('] repaired ')))
  })
  assert.ok(fs.readFileSync(subject.file).equals(subject.original))
  assert.ok(fs.readFileSync(backups(subject)[0]).equals(subject.original))
  noStaging(subject)
})

test('a thirty-day interval waits the full duration without timer overflow', async () => {
  const emptyRoot = fs.mkdtempSync(path.join(fixtureRoot, 'long-timer-'))
  await withTimers(async (timers) => {
    const ctx = context(backend(emptyRoot))
    await apply(ctx, { startupDelayMs: 0, intervalMs: 30 * 24 * 60 * 60 * 1000 })
    timers[0].callback()
    await scheduler.yield()
    assert.equal(timers[1].milliseconds, 2 ** 31 - 1)
    timers[1].callback()
    assert.equal(timers[2].milliseconds, 30 * 24 * 60 * 60 * 1000 - (2 ** 31 - 1))
    assert.equal(ctx.logs.length, 1, 'no scan before the complete interval')
    timers[2].callback()
    await scheduler.yield()
    assert.equal(ctx.logs.length, 2)
    assert.ok(timers.every(({ milliseconds }) => milliseconds >= 0 && milliseconds <= 2 ** 31 - 1))
    await ctx.dispose()
  })
})

test('invalid timer settings fail before scheduling any work', async (t) => {
  const emptyRoot = fs.mkdtempSync(path.join(fixtureRoot, 'bad-timer-'))
  const cases = [
    ['negative-startup', { startupDelayMs: -1 }],
    ['infinite-startup', { startupDelayMs: Infinity }],
    ['zero-interval', { intervalMs: 0 }],
    ['nan-interval', { intervalMs: 'not a number' }],
    ['fractional-interval', { intervalMs: 1.5 }],
    ['empty-interval', { intervalMs: '' }],
  ]
  for (const [label, config] of cases) await t.test(label, async () => {
    await withTimers(async (timers) => {
      await assert.rejects(apply(context(backend(emptyRoot)), config), RangeError)
      assert.equal(timers.length, 0)
    })
  })
})

test('missing backend capabilities prevent automatic scanning and writes', async () => {
  assert.deepEqual(inject, ['sessionPersistence'])
  const subject = fixture('no-backend')
  await assert.rejects(scanAndRepair(subject.dir, { backend: { root: subject.dir } }), /requires the JSONL zstd backend/)
  await assert.rejects(apply(context({ root: subject.dir })), /requires the JSONL zstd backend/)
  assert.ok(fs.readFileSync(subject.file).equals(subject.original))
})

test('roots outside the backend are rejected before acquiring any write lease', async () => {
  const subject = fixture('root-boundary')
  const outside = fixture('outside-root')
  const storage = backend(subject.dir)
  await assert.rejects(scanAndRepair(outside.dir, { backend: storage }), /root must be the active DSH persistence root/)
  assert.equal(storage.acquisitions, 0)
  assert.ok(fs.readFileSync(outside.file).equals(outside.original))
})

test('reserved zstd descriptor bits are rejected without rewriting', async () => {
  const bytes = Buffer.from(valid)
  bytes[4] |= 0x08
  const subject = fixture('reserved-header', bytes)
  assert.equal((await scan(subject)).stats.manual, 1)
  assert.ok(fs.readFileSync(subject.file).equals(bytes))
})
