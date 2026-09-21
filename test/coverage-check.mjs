// test/coverage-check.mjs —— M5-a 验收：拿**真实的历史会话日志**跑一遍报告取数，量覆盖率。
//
// 为什么单独一个脚本：report-check.mjs 用的是构造事件，证明的是「算法对」；
// 这个脚本读本机 DSH_HOME/sessions 下的真实日志，回答的是「老会话到底能算出多少」——
// 覆盖率、未定价模型分布、坏行数、耗时。依赖真实数据，所以不进 CI，手动跑。
//
// 用法: node test/coverage-check.mjs [--include-subagents] [--quiet]
//      DSH_HOME=/path/to/.dsh node test/coverage-check.mjs
import { homedir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { priceFor } from '../src/index.mjs'
import { buildReport, foldSession, listSessionLogs, readSessionLog, userSessions } from '../src/report.mjs'

const args = new Set(process.argv.slice(2))
const includeSubagents = args.has('--include-subagents')
const quiet = args.has('--quiet')
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')

const log = (s) => { if (!quiet) console.log(s) }

const t0 = performance.now()
const logs = listSessionLogs(home)
log('会话日志目录 ' + join(home, 'sessions'))
log('发现日志 ' + logs.length + ' 个')
if (logs.length === 0) {
  console.log('没有日志可测（DSH_HOME=' + home + '）—— 跳过')
  process.exit(0)
}

const folded = []
const failures = []
let badLines = 0
let bytes = 0
const zeroTurnLogs = []

for (const path of logs) {
  try {
    // 每个日志单独计时：慢文件要能定位到具体是哪个
    const tLog = performance.now()
    const { events, badLines: bad } = readSessionLog(path)
    badLines += bad
    const id = path.replace(/\\/g, '/').split('/').slice(-1)[0].replace(/\.zstd$/, '')
    const f = foldSession(events, { priceFor, sessionId: id })
    f.ms = performance.now() - tLog
    f.badLines = bad
    f.events = events.length
    folded.push(f)
    if (f.turns === 0) zeroTurnLogs.push(id)
  } catch (error) {
    failures.push({ path, error: String(error?.message ?? error) })
  }
}

const ms = performance.now() - t0
const all = folded
const users = userSessions(all, false)
const subs = all.filter((s) => (s.depth ?? 0) > 0)
const target = includeSubagents ? all : users

const turns = target.reduce((n, s) => n + s.turns, 0)
const unpriced = target.reduce((n, s) => n + s.unpricedTurns, 0)
const priced = turns - unpriced
const coverage = turns === 0 ? 0 : priced / turns

// 未定价都落在哪些模型上——这决定「覆盖率低」到底是价表缺口还是历史脏数据
const byModel = new Map()
for (const s of target) {
  for (const m of s.models) {
    const acc = byModel.get(m.model) ?? { model: m.model, turns: 0, tokens: 0, usd: 0 }
    acc.turns += m.turns
    acc.tokens += m.tokens
    acc.usd += m.usd
    byModel.set(m.model, acc)
  }
}
const models = [...byModel.values()].sort((a, b) => b.turns - a.turns)
const report = buildReport(target, {
  fxRate: 6.718405,
  generatedAt: new Date().toISOString(),
  priceVersion: 'coverage-check',
  covers: target.length,
})

log('')
log('扫描 ' + target.length + ' 个会话' + (includeSubagents ? '（含子代理）' : '（仅用户会话；子代理 ' + subs.length + ' 个未计入）'))
log('轮次 ' + turns.toLocaleString() + ' · 可定价 ' + priced.toLocaleString() + ' · 未定价 ' + unpriced.toLocaleString() + ' → 覆盖率 ' + (coverage * 100).toFixed(2) + '%')
log('金额 ¥' + report.cny.toFixed(2) + ' (USD ' + report.usd.toFixed(4) + ')')
log('坏行 ' + badLines + ' · 零轮次日志 ' + zeroTurnLogs.length + ' · 读取失败 ' + failures.length)
log('耗时 ' + ms.toFixed(0) + ' ms')
log('')
log('按模型（轮次降序）：')
for (const m of models.slice(0, 15)) {
  log('  ' + String(m.model).padEnd(24) + ' 轮次 ' + String(m.turns).padStart(6) + '  ' +
      (m.usd > 0 ? '¥' + (m.usd * 6.718405).toFixed(2) : '未定价') + '  token ' + m.tokens.toLocaleString())
}
if (failures.length > 0) {
  log('')
  log('读取失败的日志：')
  for (const f of failures.slice(0, 10)) log('  ' + f.path + ' → ' + f.error)
}

// 验收判据：坏行可以有（诚实计账），但「整个日志读不出来」是结构性问题，必须暴露
if (failures.length > 0) {
  console.log('\n覆盖率验收：失败 —— ' + failures.length + ' 个日志结构性读不出（不是坏行，是整个文件）')
  process.exit(1)
}
console.log('\n覆盖率验收：通过（覆盖率 ' + (coverage * 100).toFixed(2) + '%，未定价 ' + unpriced + ' 轮已在报告里单列）')
