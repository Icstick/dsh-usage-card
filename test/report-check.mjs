// test/report-check.mjs —— 报告取数与渲染的验收（直接跑）
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import { buildReport, decodeFrames, foldSession, renderCsv, renderMarkdown } from '../src/report.mjs'

let pass = 0
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name) }

// 谷/峰两档假价表：峰 = 谷 ×2（与官方口径一致）
const priceFor = (model, at) => {
  if (model !== 'deepseek-flash') return null
  const hour = at.getUTCHours()
  const peak = hour >= 1 && hour < 4
  return { cacheMiss: peak ? 0.3 : 0.15, cacheHit: peak ? 0.006 : 0.003, output: peak ? 1.2 : 0.6 }
}
const turn = (iso, input, output, cacheRead = 0) => ({
  type: 'assistant/message', time: Date.parse(iso),
  data: { usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead } },
})

console.log('多帧 zstd')
t('两帧拼一起能全部解出（Node 原生只解第一帧）', () => {
  const buf = Buffer.concat([
    zstdCompressSync(Buffer.from('{"a":1}\n', 'utf8')),
    zstdCompressSync(Buffer.from('{"b":2}\n', 'utf8')),
  ])
  const text = decodeFrames(buf)
  assert.match(text, /"a":1/)
  assert.match(text, /"b":2/)
})

console.log('逐轮折叠')
t('峰谷各一轮 → 各按自己的时刻定价', () => {
  const f = foldSession([
    { type: 'request/header', data: { header: { config: { model: 'deepseek-flash' } } } },
    turn('2026-09-18T02:00:00Z', 1_000_000, 0),   // 峰：0.3
    turn('2026-09-18T05:00:00Z', 1_000_000, 0),   // 谷：0.15
  ], { priceFor, sessionId: 's1' })
  assert.equal(f.turns, 2)
  assert.ok(Math.abs(f.usd - 0.45) < 1e-9, 'got ' + f.usd)
  assert.equal(f.totals.uncachedInputTokens, 2_000_000)
})
t('未定价轮次单列，不计入金额', () => {
  const f = foldSession([
    { type: 'request/header', data: { header: { config: { model: 'unknown-model' } } } },
    turn('2026-09-18T05:00:00Z', 1_000_000, 0),
  ], { priceFor, sessionId: 's1' })
  assert.equal(f.turns, 1)
  assert.equal(f.unpricedTurns, 1)
  assert.equal(f.usd, 0)
})
t('会话中途换模型 → 各自按其时点生效的价', () => {
  const f = foldSession([
    { type: 'request/header', data: { header: { config: { model: 'deepseek-flash' } } } },
    turn('2026-09-18T05:00:00Z', 1_000_000, 0),
    { type: 'request/header', data: { header: { config: { model: 'unknown-model' } } } },
    turn('2026-09-18T05:01:00Z', 1_000_000, 0),
  ], { priceFor, sessionId: 's1' })
  assert.equal(f.models.length, 2)
  assert.ok(Math.abs(f.usd - 0.15) < 1e-9, '只有第一轮可定价，got ' + f.usd)
})
t('缺 usage / 缺 time 的事件被跳过', () => {
  const f = foldSession([
    { type: 'assistant/message', data: {} },
    { type: 'assistant/message', time: 1, data: { usage: null } },
    { type: 'user/message', time: 1, data: {} },
  ], { priceFor, sessionId: 's1' })
  assert.equal(f.turns, 0)
})

console.log('聚合与渲染')
const multi = [
  foldSession([{ type: 'request/header', data: { header: { config: { model: 'deepseek-flash' } } } }, turn('2026-09-18T05:00:00Z', 1_000_000, 0)], { priceFor, sessionId: 's1' }),
  foldSession([{ type: 'request/header', data: { header: { config: { model: 'deepseek-flash' } } } }, turn('2026-09-17T05:00:00Z', 2_000_000, 0)], { priceFor, sessionId: 's2' }),
]
const report = buildReport(multi, { fxRate: 7.2, generatedAt: 'T', priceVersion: 'v', covers: 2 })
t('总览与按天/按会话聚合正确', () => {
  assert.equal(report.turns, 2)
  assert.ok(Math.abs(report.usd - 0.45) < 1e-9)
  assert.equal(report.days.length, 2)
  assert.equal(report.sessions[0].sessionId, 's2', '按金额降序')
})
t('Markdown 含总览/按天/按模型/按会话与计价说明', () => {
  const md = renderMarkdown(report)
  for (const heading of ['## 总览', '## 按天', '## 按模型', '## 按会话', '## 计价说明']) assert.ok(md.includes(heading), '缺 ' + heading)
  assert.ok(md.includes('¥3.2400'), '应含金额')
})
t('CSV 有表头且按天/按模型都有行', () => {
  const csv = renderCsv(report)
  const lines = csv.trim().split('\n')
  assert.equal(lines[0], 'scope,name,turns,tokens,usd,cny', '表头为固定列名（数据行才加引号）')
  assert.ok(lines.length >= 4)
  assert.ok(csv.includes('"day"') && csv.includes('"model"'))
})

console.log('\n报告验收全部通过：' + pass + ' 项')
