import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { scheduler, setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

export const name = 'session-log-healer'
export const inject = ['sessionPersistence']

const MAGIC = 0xfd2fb528
const CHECKSUM_FLAG = 201
const FRAME_TARGET = 1024 * 1024
const ACTIVE_MS = 10 * 60 * 1000
const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_PLAIN_BYTES = 512 * 1024 * 1024
const MAX_FRAMES = 1_000_000
const MAX_TIMER_MS = 2 ** 31 - 1
const DECODE_ATTEMPTS = 12
const HEADER_REQUIRED_KEYS = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth']
const HEADER_KEYS = new Set([...HEADER_REQUIRED_KEYS, 'cwd', 'parentSession', 'origin', 'agentPreset'])

class SourceChangedError extends Error {
  constructor(file) {
    super(`session changed during scan: ${file}`)
    this.code = 'HEALER_SOURCE_CHANGED'
  }
}

function assertBackend(backend) {
  if (backend?.name !== 'session-persistence-jsonl' || backend.compression !== 'zstd'
    || typeof backend.root !== 'string' || backend.root.length === 0
    || typeof backend.acquireLease !== 'function' || typeof backend.readZstdPrefix !== 'function') {
    throw new Error('session-log-healer requires the JSONL zstd backend with acquireLease() and readZstdPrefix(); automatic writes are unavailable')
  }
}

function assertCatalog(catalog) {
  if (catalog?.currentVersion !== 4 || typeof catalog.createRestore !== 'function') {
    throw new Error('session-log-healer requires the installed v4 session format catalog for strict validation')
  }
}

async function loadCatalog(ctx) {
  const profile = ctx.get?.('profileContext')
  let module
  if (profile?.installAnchor) {
    const hostRequire = createRequire(profile.installAnchor)
    const persistenceRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
    module = await import(pathToFileURL(persistenceRequire.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
  } else {
    const loader = ctx.get?.('loader')
    if (typeof loader?.import !== 'function') throw new Error('DSH profile/loader is unavailable; cannot load the installed session format validator')
    module = await loader.import('@deepseek-ai/dsh-session-format-catalog')
  }
  assertCatalog(module.sessionFormatCatalog)
  return module.sessionFormatCatalog
}

function canonicalDirectory(dir) {
  let current = path.resolve(dir)
  const suffix = []
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...suffix)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      suffix.unshift(path.basename(current))
      current = parent
    }
  }
}

function sessionRoot(root, backend) {
  const base = path.resolve(backend.root)
  const relative = path.relative(canonicalDirectory(base), canonicalDirectory(root))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('root must be the active DSH persistence root or one of its subdirectories')
  }
  // Preserve the writer's literal root path: Windows semaphore names use the
  // resolved path, not realpath, so junction aliases must map back to this root.
  return path.join(base, relative)
}

function isLockContention(error) {
  return error?.name === 'SessionAlreadyOwnedError'
    || error?.constructor?.name === 'SessionAlreadyOwnedError'
    || ['EBUSY', 'EAGAIN', 'EWOULDBLOCK'].includes(error?.code)
}

function* listSessionFiles(dir, signal) {
  signal?.throwIfAborted()
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    signal?.throwIfAborted()
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* listSessionFiles(file, signal)
    else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') yield file
  }
}

// Parse every complete frame. Empty raw blocks are legal; reserved types/bits are not.
export function scanFrames(buf) {
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (frames.length >= MAX_FRAMES) throw new Error('too many zstd frames')
    if (buf.length - offset < 4) throw new Error(`truncated frame magic at ${offset}`)
    if (buf.readUInt32LE(offset) !== MAGIC) throw new Error(`bad frame magic at ${offset}`)
    offset += 4
    if (offset === buf.length) throw new Error(`truncated descriptor at ${start}`)
    const descriptor = buf[offset++]
    if (descriptor & 0x18) throw new Error(`reserved frame-header bit at ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buf.length - offset < remainingHeaderBytes) throw new Error(`truncated frame header at ${start}`)
    offset += remainingHeaderBytes
    for (;;) {
      if (buf.length - offset < 3) throw new Error(`truncated block header at ${offset}`)
      const blockHeader = buf.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buf.length - offset < payloadBytes) throw new Error(`truncated block at ${offset}`)
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buf.length - offset < 4) throw new Error(`truncated checksum at ${offset}`)
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

function isChecksumError(error) {
  return error?.code === 'ZSTD_error_checksum_wrong' || /checksum/i.test(error?.message ?? '')
}

function decompressFrame(piece, maxOutputLength) {
  return new Promise((resolve, reject) => {
    zlib.zstdDecompress(piece, { maxOutputLength }, (error, plain) => {
      if (error) reject(error)
      else resolve(plain)
    })
  })
}

function streamingDecode(piece, maxOutputLength, signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const decoder = zlib.createZstdDecompress()
    const chunks = []
    let size = 0
    const abort = () => decoder.destroy(signal.reason)
    const cleanup = () => signal?.removeEventListener('abort', abort)
    signal?.addEventListener('abort', abort, { once: true })
    decoder.on('data', (chunk) => {
      size += chunk.length
      if (size > maxOutputLength) {
        decoder.destroy(new Error('decoded session exceeds plaintext size limit'))
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    decoder.once('error', (error) => {
      cleanup()
      reject(error)
    })
    decoder.once('end', () => {
      cleanup()
      resolve(Buffer.concat(chunks, size))
    })
    decoder.end(piece)
  })
}

async function decodeFrame(piece, maxOutputLength, signal) {
  let lastError
  for (let attempt = 0; attempt < DECODE_ATTEMPTS; attempt++) {
    signal?.throwIfAborted()
    try {
      const plain = attempt % 2 === 0
        ? await decompressFrame(piece, maxOutputLength)
        : await streamingDecode(piece, maxOutputLength, signal)
      signal?.throwIfAborted()
      if (plain.length > maxOutputLength) throw new Error('decoded session exceeds plaintext size limit')
      return plain
    } catch (error) {
      signal?.throwIfAborted()
      if (!isChecksumError(error)) throw error
      lastError = error
      if (attempt + 1 < DECODE_ATTEMPTS) await delay(2, undefined, { signal })
    }
  }
  throw lastError
}

async function decodeFrames(buf, frames, signal) {
  if (frames.length === 0) throw new Error('empty or header-less session log')
  const chunks = []
  let size = 0
  let expectedStart = 0
  for (const frame of frames) {
    signal?.throwIfAborted()
    if (frame.start !== expectedStart || frame.end <= frame.start || frame.end > buf.length) {
      throw new Error('frame ranges do not cover the original file')
    }
    const plain = await decodeFrame(buf.subarray(frame.start, frame.end), MAX_PLAIN_BYTES - size, signal)
    chunks.push(plain)
    size += plain.length
    expectedStart = frame.end
  }
  if (expectedStart !== buf.length) throw new Error('unprocessed bytes after the last frame')
  return { plain: Buffer.concat(chunks, size), firstFrame: chunks[0] }
}

function isNatural(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function assertHeader(header) {
  if (header === null || typeof header !== 'object' || Array.isArray(header)
    || !HEADER_REQUIRED_KEYS.every((key) => Object.hasOwn(header, key))
    || Object.keys(header).some((key) => !HEADER_KEYS.has(key))
    || header.type !== 'session' || header.version !== 4 || typeof header.id !== 'string'
    || !isNatural(header.createdAt) || !isNatural(header.delegationDepth)
    || typeof header.isSeeded !== 'boolean'
    || (header.cwd !== undefined && (typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)))
    || (header.parentSession !== undefined && typeof header.parentSession !== 'string')
    || (header.origin !== undefined && header.origin !== 'subagent')
    || (header.agentPreset !== undefined && typeof header.agentPreset !== 'string')) {
    throw new Error('first line is not a supported v4 DSH session header')
  }
}

function validatePlain(plain) {
  if (plain.length === 0) throw new Error('empty or header-less session log')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plain)
  if (!Buffer.from(text, 'utf8').equals(plain)) throw new Error('UTF-8 decoding changed the original bytes')
  // A complete JSON record can be normalized by adding its missing line terminator.
  // A partial/invalid JSON record is never discarded or completed by guessing.
  const appendedNewline = !text.endsWith('\n')
  const normalized = appendedNewline ? Buffer.concat([plain, Buffer.from('\n')]) : plain
  const lines = (appendedNewline ? text : text.slice(0, -1)).split('\n')
  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`line ${index} is not valid JSON`, { cause: error })
    }
  })
  assertHeader(records[0])
  for (let index = 1; index < records.length; index++) {
    const record = records[index]
    if (record === null || typeof record !== 'object' || Array.isArray(record)
      || typeof record.type !== 'string' || record.type.length === 0) {
      throw new Error(`line ${index} is not a JSON event object`)
    }
  }
  return { normalized, appendedNewline, records }
}

function reencodePlain(plain) {
  const frames = []
  const encode = (chunk) => frames.push(zlib.zstdCompressSync(chunk, { params: { [CHECKSUM_FLAG]: 1 } }))
  const headerEnd = plain.indexOf(10) + 1
  if (headerEnd === 0) throw new Error('header has no line terminator')
  encode(plain.subarray(0, headerEnd))
  let frameStart = headerEnd
  let lineStart = headerEnd
  for (let newline = plain.indexOf(10, lineStart); newline !== -1; newline = plain.indexOf(10, lineStart)) {
    const lineEnd = newline + 1
    if (lineStart > frameStart && lineEnd - frameStart > FRAME_TARGET) {
      encode(plain.subarray(frameStart, lineStart))
      frameStart = lineStart
    }
    lineStart = lineEnd
  }
  if (frameStart < plain.length) encode(plain.subarray(frameStart))
  return Buffer.concat(frames)
}

export async function checkFrames(buf, frames, { backend, catalog = backend?.catalog, signal } = {}) {
  try {
    assertCatalog(catalog)
    const { plain, firstFrame } = await decodeFrames(buf, frames, signal)
    const validated = validatePlain(plain)
    const restore = catalog.createRestore(validated.records[0], { recovery: 'strict', validation: 'current' })
    for (const record of validated.records.slice(1)) {
      signal?.throwIfAborted()
      restore.decodeRow(record)
    }
    restore.finish()
    const independentHeader = firstFrame.length > 0
      && firstFrame.indexOf(10) === firstFrame.length - 1
    const needsRepair = !independentHeader || validated.appendedNewline
    const canonical = needsRepair ? reencodePlain(validated.normalized) : buf
    signal?.throwIfAborted()
    // For complete frames, DSH rejects any uncommitted/invalid JSONL suffix,
    // then validates the restored v4 relationships when finishing the scan.
    await backend.readZstdPrefix(canonical, signal)
    signal?.throwIfAborted()
    return {
      status: needsRepair ? 'REPAIRABLE' : 'OK',
      reason: !independentHeader ? 'first frame is not exactly one header line' : 'complete JSON record needs a final newline',
      plain,
      normalized: validated.normalized,
      canonical,
      appendedNewline: validated.appendedNewline,
    }
  } catch (error) {
    signal?.throwIfAborted()
    return { status: 'CORRUPT', reason: error.message }
  }
}

function sameIdentity(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every((key) => left[key] === right[key])
}

function readSnapshot(file) {
  const before = fs.lstatSync(file, { bigint: true })
  if (!before.isFile()) throw new Error('session path is not a regular file')
  if (before.size > BigInt(MAX_FILE_BYTES)) throw new Error('session exceeds compressed file size limit')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    if (!sameIdentity(before, opened)) throw new SourceChangedError(file)
    const buf = fs.readFileSync(fd)
    const after = fs.fstatSync(fd, { bigint: true })
    if (!sameIdentity(opened, after) || !sameIdentity(after, fs.lstatSync(file, { bigint: true }))
      || BigInt(buf.length) !== after.size) throw new SourceChangedError(file)
    return { buf, stat: after }
  } finally {
    fs.closeSync(fd)
  }
}

function assertSnapshot(file, original) {
  const current = readSnapshot(file)
  if (!sameIdentity(original.stat, current.stat) || !original.buf.equals(current.buf)) {
    throw new SourceChangedError(file)
  }
}

function writeSynced(file, buf, mode, onCreated) {
  const fd = fs.openSync(file, 'wx', mode)
  onCreated()
  try {
    fs.writeFileSync(fd, buf)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  if (!fs.readFileSync(file).equals(buf)) throw new Error('staged file does not match the intended bytes')
}

function syncDirectory(dir) {
  if (process.platform === 'win32') return
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0))
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function removeStaged(file, log) {
  try {
    fs.unlinkSync(file)
  } catch (error) {
    if (error.code !== 'ENOENT') log('warn', `[session-log-healer] cannot remove staging file ${file}: ${error.message}`)
  }
}

// Called only while scanAndRepair holds the backend's real session write lease.
async function tryRepair(file, original, check, { backend, catalog, signal, log }) {
  const token = randomUUID()
  const staged = path.join(path.dirname(file), `.session-log-healer-${token}.tmp`)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.corrupt-${timestamp}-${token}.bak`
  let stagedCreated = false
  let backupCreated = false
  let backupComplete = false
  try {
    signal?.throwIfAborted()
    assertSnapshot(file, original)
    const mode = Number(original.stat.mode & 0o777n)
    writeSynced(staged, check.canonical, mode, () => { stagedCreated = true })
    const stagedBuf = fs.readFileSync(staged)
    const stagedCheck = await checkFrames(stagedBuf, scanFrames(stagedBuf), { backend, catalog, signal })
    if (stagedCheck.status !== 'OK' || !stagedCheck.plain.equals(check.normalized)
      || !stagedCheck.plain.subarray(0, check.plain.length).equals(check.plain)) {
      throw new Error('staged repair does not preserve all original plaintext bytes')
    }
    signal?.throwIfAborted()
    assertSnapshot(file, original)
    writeSynced(backup, original.buf, mode, () => { backupCreated = true })
    backupComplete = true
    syncDirectory(path.dirname(file))
    // Let pending disposal run before the final, synchronous commit.
    await scheduler.yield()
    signal?.throwIfAborted()
    assertSnapshot(file, original)
    fs.renameSync(staged, file)
    stagedCreated = false
    try {
      syncDirectory(path.dirname(file))
    } catch (error) {
      log('warn', `[session-log-healer] repaired ${file}, but directory sync failed: ${error.message}`)
    }
    log('info', `[session-log-healer] repaired ${file}: ${check.reason}; preserved ${check.plain.length} plaintext bytes${check.appendedNewline ? ', added one newline' : ''}; backup ${backup}`)
    return true
  } finally {
    if (stagedCreated) removeStaged(staged, log)
    if (backupCreated && !backupComplete) removeStaged(backup, log)
  }
}

export async function scanAndRepair(root, { backend, catalog = backend?.catalog, scanActive = true, log = () => {}, signal } = {}) {
  assertBackend(backend)
  assertCatalog(catalog)
  const files = [...listSessionFiles(sessionRoot(root, backend), signal)].sort()
  const stats = { files: files.length, ok: 0, repaired: 0, manual: 0, skipped: 0 }
  for (const file of files) {
    signal?.throwIfAborted()
    let lease
    try {
      const before = fs.lstatSync(file, { bigint: true })
      if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES)) {
        stats.skipped++
        log('warn', `[session-log-healer] skip non-regular or oversized ${file}`)
        continue
      }
      if (scanActive && Date.now() - Number(before.mtimeNs) / 1e6 < ACTIVE_MS) {
        stats.skipped++
        continue
      }
      lease = await backend.acquireLease(path.basename(path.dirname(file)), undefined, path.dirname(file))
      if (typeof lease?.release !== 'function') throw new Error('backend did not provide a releasable session write lease')
      signal?.throwIfAborted()
      const original = readSnapshot(file)
      if (scanActive && Date.now() - Number(original.stat.mtimeNs) / 1e6 < ACTIVE_MS) {
        stats.skipped++
        continue
      }
      const check = await checkFrames(original.buf, scanFrames(original.buf), { backend, catalog, signal })
      if (check.status === 'OK') stats.ok++
      else if (check.status === 'REPAIRABLE') {
        if (await tryRepair(file, original, check, { backend, catalog, signal, log })) stats.repaired++
      } else {
        stats.manual++
        log('warn', `[session-log-healer] manual ${file}: ${check.reason}; original file retained`)
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (isLockContention(error) || error.code === 'HEALER_SOURCE_CHANGED') {
        stats.skipped++
        log('info', `[session-log-healer] skipped ${file}: ${error.message}`)
      } else {
        stats.manual++
        log('error', `[session-log-healer] cannot repair ${file}: ${error.message}`)
      }
    } finally {
      if (lease && typeof lease.release === 'function') {
        try {
          await lease.release()
        } catch (error) {
          log('error', `[session-log-healer] cannot release session write lease for ${file}: ${error.message}`)
          throw error
        }
      }
    }
  }
  return stats
}

function configDelay(value, key, minimum) {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && value.trim() === '')) throw new RangeError(`${key} must be a finite integer in milliseconds`)
  const milliseconds = Number(value)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < minimum) {
    throw new RangeError(`${key} must be a safe integer >= ${minimum} milliseconds`)
  }
  return milliseconds
}

// Node clamps overlarge timers to 1ms. Schedule long delays in supported chunks instead.
function scheduleDelay(callback, milliseconds) {
  let remaining = milliseconds
  let timer
  let stopped = false
  const arm = () => {
    const chunk = Math.min(remaining, MAX_TIMER_MS)
    timer = setTimeout(() => {
      if (stopped) return
      remaining -= chunk
      if (remaining > 0) arm()
      else callback()
    }, chunk)
    timer.unref?.()
  }
  arm()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

export async function apply(ctx, config = {}) {
  const backend = ctx.sessionPersistence
  assertBackend(backend)
  if (config.root !== undefined && typeof config.root !== 'string') throw new TypeError('root must be a directory path string')
  const root = sessionRoot(config.root || backend.root, backend)
  const startupDelayMs = configDelay(config.startupDelayMs ?? 3000, 'startupDelayMs', 0)
  const intervalMs = configDelay(config.intervalMs ?? 24 * 60 * 60 * 1000, 'intervalMs', 1)
  const scanActive = config.scanActive !== false
  const controller = new AbortController()
  let inFlight
  let cancelTimer
  const log = (level, message) => {
    try {
      ctx.logger[level](message)
    } catch {
      ;(level === 'error' ? console.error : console.log)(message)
    }
  }
  const run = async (reason) => {
    if (controller.signal.aborted || inFlight) return
    inFlight = (async () => {
      try {
        const result = await scanAndRepair(root, { backend, catalog, scanActive, log, signal: controller.signal })
        if (!controller.signal.aborted) {
          log('info', `[session-log-healer] ${reason}: files=${result.files} ok=${result.ok} repaired=${result.repaired} manual=${result.manual} skipped=${result.skipped}`)
        }
      } catch (error) {
        if (!controller.signal.aborted) log('error', `[session-log-healer] ${reason} scan failed: ${error.message}`)
      }
    })()
    try {
      await inFlight
    } finally {
      inFlight = undefined
      if (!controller.signal.aborted) cancelTimer = scheduleDelay(() => void run('scheduled'), intervalMs)
    }
  }
  ctx.on('dispose', async () => {
    controller.abort(new Error('session-log-healer disposed'))
    cancelTimer?.()
    await inFlight
  })
  const catalog = await loadCatalog(ctx)
  if (controller.signal.aborted) return
  cancelTimer = scheduleDelay(() => void run('startup'), startupDelayMs)
}
