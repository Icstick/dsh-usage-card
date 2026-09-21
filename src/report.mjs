/**
 * report.mjs —— 用量报告的取数与渲染（宿主半，只读）
 *
 * 不落账本 DB：直接读历史会话日志折叠。理由——日志是权威事实源，
 * 而多帧 zstd 用纯 Node 就能解，不必引入新存储。
 *
 * 计价纪律与卡片一致：逐轮按各轮自己的时刻定价（峰谷是时段价），
 * 未定价的轮次单独计数、金额置 null，绝不当 0。
 *
 * @module dsh-usage-card/report
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * 解出全部帧的文本。Node 的 zstdDecompressSync 只解第一帧（实测 818 帧的文件只出 1 行），
 * 所以按帧魔数切分后逐帧解；伪命中的候选点会解压失败，跳过即可。
 * @param buf - 压缩文件内容
 */
export function decodeFrames(buf) {
  const offsets = [0]
  for (let i = 4; i + 3 < buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offsets.push(i)
  }
  const out = []
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try {
      out.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch { /* 伪命中或截断帧 */ }
  }
  return out.join('')
}

/**
 * 读一个会话日志文件并解析成事件数组；坏行跳过（不因一行坏掉整个报告）。
 * @param path - 会话日志路径
 */
export function readSessionLog(path) {
  const events = []
  let badLines = 0
  for (const line of decodeFrames(readFileSync(path)).split('\n')) {
    if (line === '') continue
    try { events.push(JSON.parse(line)) } catch { badLines += 1 }
  }
  return { events, badLines }
}

/** 列出会话日志路径。 */
export function listSessionLogs(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  const found = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.zstd')) found.push(path)
    }
  }
  walk(join(home, 'sessions'))
  return found
}

/** 本地日期：报告按人看的「天」分桶，不是 UTC 天。 */
function localDay(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/**
 * 把一个会话的事件折叠成用量与金额。
 * 逐轮定价：每个 assistant/message 用它自己的 time 判峰谷；模型取该轮时点上生效的请求头。
 * @param events - 该会话的事件数组
 * @param deps - 依赖注入：{ priceFor, sessionId }
 */
export function foldSession(events, deps) {
  const { priceFor, sessionId } = deps
  const byDay = new Map()
  const byModel = new Map()
  const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
  let model = null
  let turns = 0
  let unpricedTurns = 0
  let usd = 0
  let first = null
  let last = null
  // 会话身份：标题来自 session/title（后者覆盖前者），子代理标记来自日志首行的 header
  let title = null
  let depth = 0
  let parent = null
  for (const event of events) {
    if (event?.type === 'session') {
      depth = Number(event.delegationDepth ?? 0)
      parent = event.parentSession ?? null
      continue
    }
    if (event?.type === 'session/title') {
      const t = event.data?.title
      if (typeof t === 'string' && t !== '') title = t
      continue
    }
    if (event?.type === 'request/header') {
      const m = event.data?.header?.config?.model
      if (typeof m === 'string') model = m
      continue
    }
    if (event?.type !== 'assistant/message') continue
    const usage = event.data?.usage
    const time = event.time
    if (usage == null || typeof time !== 'number') continue
    const buckets = {
      uncachedInputTokens: usage.inputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    }
    const price = priceFor(model, new Date(time))
    const turnUsd = price == null
      ? null
      : (buckets.uncachedInputTokens / 1e6) * price.cacheMiss
        + (buckets.cacheReadTokens / 1e6) * price.cacheHit
        + (buckets.outputTokens / 1e6) * price.output
    const tokenCount = buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens
    turns += 1
    if (turnUsd == null) unpricedTurns += 1
    else usd += turnUsd
    for (const key of Object.keys(totals)) totals[key] += buckets[key]
    first = first == null || time < first ? time : first
    last = last == null || time > last ? time : last
    const day = localDay(time)
    const dayRow = byDay.get(day) ?? { day, turns: 0, usd: 0, tokens: 0 }
    dayRow.turns += 1
    dayRow.tokens += tokenCount
    if (turnUsd != null) dayRow.usd += turnUsd
    byDay.set(day, dayRow)
    const modelKey = model ?? '(未知模型)'
    const modelRow = byModel.get(modelKey) ?? { model: modelKey, turns: 0, usd: 0, tokens: 0 }
    modelRow.turns += 1
    modelRow.tokens += tokenCount
    if (turnUsd != null) modelRow.usd += turnUsd
    byModel.set(modelKey, modelRow)
  }
  return {
    sessionId, turns, unpricedTurns, usd, totals, first, last,
    title: title === null ? null : title.replace(/\s+/g, ' ').trim().slice(0, 60),
    depth, parent,
    days: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    models: [...byModel.values()].sort((a, b) => b.usd - a.usd),
  }
}

/**
 * 只保留用户发起的会话（子代理是 delegationDepth > 0）。
 * @param sessions - 折叠结果
 * @param include - true 时连子代理一起要
 */
export function userSessions(sessions, include = false) {
  return include ? sessions : sessions.filter((s) => (s.depth ?? 0) === 0)
}

/** 把多个会话折叠结果合成一份报告。 */
export function buildReport(sessions, deps) {
  const { fxRate, generatedAt, priceVersion, covers, ledger = null } = deps
  const byDay = new Map()
  const byModel = new Map()
  let usd = 0
  let turns = 0
  let unpricedTurns = 0
  for (const s of sessions) {
    usd += s.usd
    turns += s.turns
    unpricedTurns += s.unpricedTurns
    for (const d of s.days) {
      const acc = byDay.get(d.day) ?? { day: d.day, turns: 0, usd: 0, tokens: 0 }
      acc.turns += d.turns; acc.usd += d.usd; acc.tokens += d.tokens
      byDay.set(d.day, acc)
    }
    for (const m of s.models) {
      const acc = byModel.get(m.model) ?? { model: m.model, turns: 0, usd: 0, tokens: 0 }
      acc.turns += m.turns; acc.usd += m.usd; acc.tokens += m.tokens
      byModel.set(m.model, acc)
    }
  }
  return {
    generatedAt, priceVersion, fxRate, covers,
    // 账本口径（写入时定价，冻结）：只作为**对照**出现在报告里。
    // 报告主体仍是"用当前价表重算日志"，因为报告以日志为权威、且经常要回答
    // 「按今天的价，这段时间要多少钱」。两者给的数不一样时，差异就是官方调价的量。
    ledger: ledger === null ? null : { ...ledger, cny: ledger.usd * fxRate },
    sessionsScanned: sessions.length, turns, unpricedTurns, usd,
    cny: usd * fxRate,
    days: [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
    models: [...byModel.values()].sort((a, b) => b.usd - a.usd),
    sessions: [...sessions].sort((a, b) => b.usd - a.usd),
  }
}

/** 渲染 Markdown 报告。 */
export function renderMarkdown(report) {
  const cny = (usd) => '¥' + (usd * report.fxRate).toFixed(4)
  const lines = []
  lines.push('# DSH 用量报告')
  lines.push('')
  lines.push('生成于 ' + report.generatedAt + ' · 汇率 ' + report.fxRate + '（USD→CNY）· 价表版本 ' + String(report.priceVersion ?? '-'))
  lines.push('')
  lines.push('## 总览')
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('|---|---|')
  lines.push('| 扫描会话 | ' + report.covers + ' |')
  lines.push('| 计入轮次 | ' + report.turns + ' |')
  lines.push('| 金额 | ' + cny(report.usd) + ' (USD ' + report.usd.toFixed(6) + ') |')
  lines.push('| 未定价轮次 | ' + report.unpricedTurns + (report.unpricedTurns > 0 ? '（未计入金额）' : '') + ' |')
  lines.push('')
  if (report.ledger != null && report.ledger.turns > 0) {
    const diff = report.ledger.cny - report.cny
    // 符号写在币种前面（-¥0.70 而不是 ¥-0.70）
    const sign = diff > 0 ? '+' : (diff < 0 ? '-' : '')
    lines.push('## 账本口径对照')
    lines.push('')
    lines.push('| 口径 | 轮次 | 金额 |')
    lines.push('|---|---|---|')
    lines.push('| 账本（写入时定价，已冻结） | ' + report.ledger.turns + ' | ¥' + report.ledger.cny.toFixed(4) + ' |')
    lines.push('| 当前价重算（上表即此口径） | ' + report.turns + ' | ¥' + report.cny.toFixed(4) + ' |')
    lines.push('| 差异 | ' + (report.ledger.turns - report.turns) + ' | ' + sign + '¥' + Math.abs(diff).toFixed(4) + ' |')
    lines.push('')
    lines.push('> 差异来自官方调价或价表覆盖：账本里的历史轮次按**写入当时**的价目计价，不随价表变化而漂移；')
    lines.push('> 上表则一律按当前价表重算。账本只服务侧栏卡片，报告仍以日志为权威。')
    lines.push('')
  }
  lines.push('## 按天')
  lines.push('')
  lines.push('| 日期 | 轮次 | token | 金额 |')
  lines.push('|---|---|---|---|')
  for (const d of report.days) lines.push('| ' + d.day + ' | ' + d.turns + ' | ' + d.tokens.toLocaleString() + ' | ' + cny(d.usd) + ' |')
  lines.push('')
  lines.push('## 按模型')
  lines.push('')
  lines.push('| 模型 | 轮次 | token | 金额 |')
  lines.push('|---|---|---|---|')
  for (const m of report.models) lines.push('| ' + m.model + ' | ' + m.turns + ' | ' + m.tokens.toLocaleString() + ' | ' + cny(m.usd) + ' |')
  lines.push('')
  lines.push('## 按会话（前 20）')
  lines.push('')
  lines.push('| 会话 | 轮次 | token | 金额 | 起止 |')
  lines.push('|---|---|---|---|---|')
  for (const s of report.sessions.slice(0, 20)) {
    const span = s.first == null ? '-' : new Date(s.first).toISOString().slice(0, 16).replace('T', ' ') + ' → ' + new Date(s.last).toISOString().slice(0, 16).replace('T', ' ')
    const tokens = s.totals.uncachedInputTokens + s.totals.cacheReadTokens + s.totals.cacheWriteTokens + s.totals.outputTokens
    lines.push('| ' + String(s.sessionId).slice(0, 20) + ' | ' + s.turns + ' | ' + tokens.toLocaleString() + ' | ' + cny(s.usd) + ' | ' + span + ' |')
  }
  lines.push('')
  lines.push('## 计价说明')
  lines.push('')
  lines.push('- 金额按 DeepSeek 官方价目，含峰谷（峰时 = 谷时 ×2；峰时为 UTC 周一至周五 01:00–04:00 与 06:00–10:00）')
  lines.push('- 每个轮次按它自己的时刻判峰谷；模型取该轮时点上生效的请求头')
  lines.push('- 未定价的轮次金额不计入，也不按默认价估算')
  lines.push('- 数据来源：本机会话日志，只读')
  return lines.join('\n')
}

/** 渲染 CSV（按天 + 按模型两张表拼在一个文件里）。 */
export function renderCsv(report) {
  const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"'
  const lines = ['scope,name,turns,tokens,usd,cny']
  for (const d of report.days) lines.push(['day', d.day, d.turns, d.tokens, d.usd.toFixed(6), (d.usd * report.fxRate).toFixed(4)].map(esc).join(','))
  for (const m of report.models) lines.push(['model', m.model, m.turns, m.tokens, m.usd.toFixed(6), (m.usd * report.fxRate).toFixed(4)].map(esc).join(','))
  return lines.join('\n') + '\n'
}