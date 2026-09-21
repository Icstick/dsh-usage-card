/**
 * ledger.mjs —— 逐轮账本（本机缓存，**不是权威**）
 *
 * 存在的三个理由（多一条都不做）：
 *   1. 重启后不再重走日志：某个会话第一次被看到时，读一份小文件而不是把整份日志扫一遍；
 *   2. **冻结价格版本**：金额在写入时算定并连同当时用的价目版本落盘，此后再不重算 ——
 *      官方调价只影响之后的轮次，不会让历史金额跟着漂；
 *   3. 历史可查：按会话/按天/按模型的明细不必现场折叠日志。
 *
 * 四条硬纪律：
 *   - **幂等键 = (sessionId, seq)**，同键后写覆盖。重放、回填、实时事件交叠都不会重复计数。
 *   - **投影仍是权威**：账本只影响「逐轮归属」，四桶总量永远以内核投影为准；账本少算的部分照旧
 *     走线性估算并如实标注 coverage —— 账本只减少「未覆盖」，不粉饰它。
 *   - **坏了不能带走卡片**：坏行跳过、文件读不出就整份放弃，任何 IO 异常都只记一条 warn。
 *   - **同一个月允许多个进程各写各的文件**（见下）。
 *
 * 文件布局（按**轮次发生的月份**分，UTC；跨月回填也不会写错文件）：
 *   <DSH_HOME>/storages/dsh-usage-card/ledger/2026-09.<pid>.jsonl
 *
 * **为什么文件名带 pid**：同一个 DSH_HOME 可能被多个 dsh 进程同时使用（web / worker / headless
 * 各起一份；换用户跑的话还会各有一套 home 目录）。两个进程同时往一个文件追加，行与行会互相插进去 —— 拼接出
 * 来的行解析失败就会被当坏行丢掉，那是**静默少算钱**。按进程分文件之后这一类彻底不存在：
 * 各写各的文件，同一个轮次被两个进程各记一次也没关系，读取时按 (sessionId, seq) 去重。
 *
 * 刻意不做 index.json：月份文件只有几个，全量扫描的代价是几十毫秒；多一份索引就多一个
 * 可能与事实不符的第二真相源。
 *
 * @module dsh-usage-card/ledger
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { localDay } from './report.mjs'

export const LEDGER_SCHEMA_VERSION = 1
/** 攒够这么多行就立刻落盘，不等防抖。 */
export const LEDGER_MAX_BUFFER = 200
/** 防抖窗口：一次连发多轮只写一次文件。 */
export const LEDGER_DEBOUNCE_MS = 300

/** 账本目录。 */
export function ledgerDir(home) {
  return join(home, 'storages', 'dsh-usage-card', 'ledger')
}

/** 轮次发生的月份（UTC），形如 2026-09。 */
export function monthKeyOf(timeMs) {
  const d = new Date(timeMs)
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')
}

/** 账本文件名的形状：<月份>[.<写它的进程>].jsonl —— 月份由 1 号捕获组给出。 */
export const LEDGER_FILE_RE = /^(\d{4}-\d{2})(?:\.[A-Za-z0-9_-]+)?\.jsonl$/

/** 幂等键：同一个会话的同一个 seq 就是同一轮。 */
export function rowKey(row) {
  return String(row?.sessionId) + '#' + String(row?.seq)
}

/** 一行是不是一条合法账本行（形状不对就当坏行丢掉，别让半个对象进来）。 */
/** 账本行自带的版本号：将来改行结构时用它判断怎么读。 */
export const ROW_SCHEMA_VERSION = LEDGER_SCHEMA_VERSION

export function isLedgerRow(o) {
  if (o === null || typeof o !== 'object') return false
  if (typeof o.sessionId !== 'string' || o.sessionId === '') return false
  if (!Number.isInteger(o.seq)) return false
  if (!Number.isFinite(o.time)) return false
  if (o.buckets === null || typeof o.buckets !== 'object') return false
  return true
}

/** 序列化成一行（含换行，追加写用）。 */
export function encodeRow(row) {
  return JSON.stringify(row) + '\n'
}

/** 解析一行；坏行返回 null —— 半行 JSON、被截断的尾巴都走这里。 */
export function parseRow(line) {
  if (typeof line !== 'string' || line === '') return null
  let o
  try { o = JSON.parse(line) } catch { return null }
  return isLedgerRow(o) ? o : null
}

/** 同键后写覆盖。 */
export function dedupeRows(rows) {
  const map = new Map()
  for (const row of rows) map.set(rowKey(row), row)
  return [...map.values()]
}

/**
 * 读一个账本文件。文件不存在不算错（返回 missing）。
 * @param path - 文件路径
 */
export function readMonthFile(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { rows: [], badLines: 0, missing: true }
  }
  const rows = []
  let badLines = 0
  for (const line of text.split('\n')) {
    if (line === '') continue
    const row = parseRow(line)
    if (row === null) badLines += 1
    else rows.push(row)
  }
  return { rows, badLines, missing: false }
}

/**
 * 折叠账本行 —— 与 report.mjs 的 foldSession 同口径，但金额取**存储值**（冻结），不重算。
 * @param rows - 账本行数组
 */
export function foldRows(rows) {
  const byDay = new Map()
  const byModel = new Map()
  const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
  let turns = 0
  let unpricedTurns = 0
  let usd = 0
  let first = null
  let last = null
  for (const row of dedupeRows(rows)) {
    const b = row.buckets ?? {}
    const uncached = Number(b.uncachedInputTokens) || 0
    const cacheRead = Number(b.cacheReadTokens) || 0
    const cacheWrite = Number(b.cacheWriteTokens) || 0
    const output = Number(b.outputTokens) || 0
    totals.uncachedInputTokens += uncached
    totals.cacheReadTokens += cacheRead
    totals.cacheWriteTokens += cacheWrite
    totals.outputTokens += output
    turns += 1
    const priced = Number.isFinite(row.usdInput) && Number.isFinite(row.usdOutput)
    if (!priced) unpricedTurns += 1
    const rowUsd = priced ? row.usdInput + row.usdOutput : 0
    usd += rowUsd
    first = first == null || row.time < first ? row.time : first
    last = last == null || row.time > last ? row.time : last
    const tokens = uncached + cacheRead + cacheWrite + output
    const day = localDay(row.time)
    const dayRow = byDay.get(day) ?? { day, turns: 0, usd: 0, tokens: 0 }
    dayRow.turns += 1
    dayRow.tokens += tokens
    dayRow.usd += rowUsd
    byDay.set(day, dayRow)
    const modelKey = typeof row.model === 'string' && row.model !== '' ? row.model : '(未知模型)'
    const modelRow = byModel.get(modelKey) ?? { model: modelKey, turns: 0, usd: 0, tokens: 0 }
    modelRow.turns += 1
    modelRow.tokens += tokens
    modelRow.usd += rowUsd
    byModel.set(modelKey, modelRow)
  }
  return {
    turns,
    unpricedTurns,
    usd,
    totals,
    first,
    last,
    days: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    models: [...byModel.values()].sort((a, b) => b.usd - a.usd),
  }
}

/**
 * 账本写入器/读取器。
 *
 * 写入：进缓冲 → 攒够 maxBuffer 立即落盘，否则防抖 debounceMs 后落盘。
 *       一次 flush 按月份分组，每组一次 appendFileSync（只追加，不重写整文件）。
 *       文件名带 pid：同一个 home 被多个 dsh 进程共用时，各写各的文件，行不会互相插进去。
 * 读取：按会话取行；每个文件的解析结果按 (mtimeMs, size) 缓存 —— 别的进程刚写进去的行，
 *       下一次读就会看见（同一进程内不重复读盘，但也不会一直用陈旧快照）。
 *
 * 任何 IO 失败都只记一条 warn 并保持原样：账本是缓存，坏了顶多回到「走日志回填」。
 * @param deps - { home, pid, now, debounceMs, maxBuffer, onWarn }
 */
export function createLedger({ home, pid = process.pid, debounceMs = LEDGER_DEBOUNCE_MS, maxBuffer = LEDGER_MAX_BUFFER, onWarn = null } = {}) {
  const dir = ledgerDir(home)
  const buffer = []
  /** 文件路径 → { mtimeMs, size, rows } */
  const fileCache = new Map()
  let timer = null
  let warnings = 0
  let written = 0
  /** 写盘失败而**丢掉**的行数。丢掉就丢掉，但绝不能不吭声 —— 那是少算钱。 */
  let lost = 0

  /** 缓存上限：账本一年也就十来个月份文件，超过这个数说明另有情况，全清防止常驻涨内存。 */
  const FILE_CACHE_MAX = 64

  const warn = (message) => {
    warnings += 1
    try { onWarn?.(message) } catch { /* 日志不可用不影响账本 */ }
  }

  /**
   * 文件末尾没有换行就补一个。
   *
   * 不补会出真事：崩在写入中途会留下半行 JSON（没有结尾换行），下一次追加会**粘在同一行**上，
   * 于是新写的那一轮也被解析成坏行一起丢掉。补一个换行把残行封死，它只坏自己那一行。
   * @param file - 目标文件
   */
  const needsSeal = (file) => {
    try {
      const st = statSync(file)
      if (st.size === 0) return ''
      const fd = openSync(file, 'r')
      try {
        const buf = Buffer.alloc(1)
        readSync(fd, buf, 0, 1, st.size - 1)
        return buf[0] === 10 ? '' : '\n'
      } finally { closeSync(fd) }
    } catch {
      return ''   // 文件还不存在 → 不需要补
    }
  }

  /** 把缓冲里的行写进对应月份文件。返回写成功的行数。 */
  const flush = () => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    if (buffer.length === 0) return 0
    const batch = buffer.splice(0, buffer.length)
    const byMonth = new Map()
    for (const row of batch) {
      const key = monthKeyOf(row.time)
      const list = byMonth.get(key) ?? []
      list.push(row)
      byMonth.set(key, list)
    }
    let n = 0
    for (const [month, rows] of byMonth) {
      try {
        mkdirSync(dir, { recursive: true })
        const file = join(dir, month + '.' + pid + '.jsonl')
        appendFileSync(file, needsSeal(file) + rows.map(encodeRow).join(''), 'utf8')
        n += rows.length
        written += rows.length
        fileCache.delete(file)   // 这份文件变了，缓存作废
      } catch (error) {
        lost += rows.length
        warn('ledger append failed (' + month + ')，这 ' + rows.length + ' 行没进账本（会退回日志重放）：' + String(error?.message ?? error))
      }
    }
    return n
  }

  const schedule = () => {
    if (timer !== null) return
    timer = setTimeout(() => { timer = null; flush() }, debounceMs)
    // 别让定时器把进程钉住（dsh 正常退出时不该等它）
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** 追加一行；返回 true 表示已进缓冲。 */
  const append = (row) => {
    if (!isLedgerRow(row)) { warn('ledger skipped a malformed row: ' + JSON.stringify(row).slice(0, 120)); return false }
    buffer.push(row)
    if (buffer.length >= maxBuffer) flush()
    else schedule()
    return true
  }

  /** 列出账本文件（含其它进程写的）。目录不存在 = 全新安装，不是错误。 */
  const listFiles = () => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const out = []
    for (const name of names) {
      const m = LEDGER_FILE_RE.exec(name)
      if (m === null) continue
      out.push({ name, month: m[1], path: join(dir, name) })
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1))
  }

  /** 读一个文件（按 mtime+size 判缓存是否还能用）。 */
  const readCached = (file) => {
    let st
    try {
      st = statSync(file.path)
    } catch {
      fileCache.delete(file.path)
      return []
    }
    const hit = fileCache.get(file.path)
    if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.rows
    const res = readMonthFile(file.path)
    if (res.badLines > 0) warn('ledger skipped ' + res.badLines + ' bad line(s) in ' + file.name)
    if (fileCache.size >= FILE_CACHE_MAX) fileCache.clear()
    fileCache.set(file.path, { mtimeMs: st.mtimeMs, size: st.size, rows: res.rows })
    return res.rows
  }

  /**
   * 取某个会话的全部行（已去重、按 seq 排序）。
   * 还没落盘的行（缓冲里）也算上，否则「刚聊完、重启前」那几轮会读不到。
   * @param sessionId - 会话 id
   */
  const load = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    const rows = []
    for (const file of listFiles()) {
      for (const row of readCached(file)) if (row.sessionId === sessionId) rows.push(row)
    }
    for (const row of buffer) if (row.sessionId === sessionId) rows.push(row)
    return dedupeRows(rows).sort((a, b) => a.seq - b.seq)
  }

  /** 账本自述：目录、已写行数、缓冲、文件数、警告数。 */
  const stats = () => {
    const files = listFiles()
    return { dir, written, buffered: buffer.length, files: files.length, months: new Set(files.map((f) => f.month)).size, warnings, lost }
  }

  /** 清空内存缓存（测试用；不动磁盘）。 */
  const reset = () => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    buffer.length = 0
    fileCache.clear()
  }

  return { dir, append, load, flush, stats, reset, listFiles }
}
