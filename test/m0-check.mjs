// test/m0-check.mjs —— M0 验收（直接跑，不用 dsh web）
// 覆盖：峰谷边界 / 未定价语义 / 金额闭合 / payload 组装 / 降级路径
import assert from 'node:assert/strict'
import { isPeak, priceFor, computeCost, buildPayload, classifyEvent, attribute } from '../src/index.mjs'

let pass = 0
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name) }

const PK = {
  enabled: true, timezone: 'UTC', weekdays: [1, 2, 3, 4, 5],
  windows: [{ start: '01:00', end: '04:00' }, { start: '06:00', end: '10:00' }],
}
const at = (iso) => new Date(iso)

console.log('峰谷边界（2026-09-18 是周五，2026-09-19 是周六）')
t('周五 01:30 UTC → 峰', () => assert.equal(isPeak(at('2026-09-18T01:30:00Z'), PK), true))
t('周五 01:00 UTC → 峰（左闭）', () => assert.equal(isPeak(at('2026-09-18T01:00:00Z'), PK), true))
t('周五 04:00 UTC → 谷（右开）', () => assert.equal(isPeak(at('2026-09-18T04:00:00Z'), PK), false))
t('周五 05:00 UTC → 谷（窗口之间）', () => assert.equal(isPeak(at('2026-09-18T05:00:00Z'), PK), false))
t('周五 06:30 UTC → 峰', () => assert.equal(isPeak(at('2026-09-18T06:30:00Z'), PK), true))
t('周五 10:00 UTC → 谷', () => assert.equal(isPeak(at('2026-09-18T10:00:00Z'), PK), false))
t('周六 02:00 UTC → 谷（周末全天谷）', () => assert.equal(isPeak(at('2026-09-19T02:00:00Z'), PK), false))
t('周日 07:00 UTC → 谷', () => assert.equal(isPeak(at('2026-09-20T07:00:00Z'), PK), false))

console.log('价目解析')
t('flash 谷价三档正确', () => {
  const p = priceFor('deepseek-flash', at('2026-09-18T05:00:00Z'))
  assert.deepEqual([p.cacheMiss, p.cacheHit, p.output, p.tier], [0.15, 0.003, 0.6, 'offPeak'])
})
t('flash 峰价 = 谷 ×2', () => {
  const p = priceFor('deepseek-flash', at('2026-09-18T02:00:00Z'))
  assert.deepEqual([p.cacheMiss, p.cacheHit, p.output, p.tier], [0.3, 0.006, 1.2, 'peak'])
})
t('v4-pro 是独立价（不是 flash 价）', () => {
  const p = priceFor('deepseek-v4-pro', at('2026-09-18T05:00:00Z'))
  assert.deepEqual([p.cacheMiss, p.output], [0.66, 1.98])
})
t('退役别名解析到 flash', () => {
  const p = priceFor('deepseek-v4-flash', at('2026-09-18T05:00:00Z'))
  assert.equal(p.canonical, 'deepseek-flash')
})
t('未知模型 → null（不是 0、不回退默认价）', () => assert.equal(priceFor('no-such-model', at('2026-09-18T05:00:00Z')), null))

console.log('金额')
const B = { uncachedInputTokens: 96266, cacheReadTokens: 6955648, cacheWriteTokens: 0, outputTokens: 67618 }
t('未定价时全为 null 且标 unpriced', () => {
  const c = computeCost(B, null, 7.2)
  assert.equal(c.unpriced, true)
  assert.deepEqual([c.totalUsd, c.totalCny], [null, null])
})
t('已知模型金额与手算一致（谷价）', () => {
  const c = computeCost(B, priceFor('deepseek-flash', at('2026-09-18T05:00:00Z')), 7.2)
  // 0.0144399 + 0.0208669 = 0.0353068 输入侧；输出 0.0405708
  // 精确值：96266×0.15/1e6 + 6955648×0.003/1e6 = 0.035306844
  assert.ok(Math.abs(c.inputUsd - 0.035306844) < 1e-9, 'inputUsd=' + c.inputUsd)
  assert.ok(Math.abs(c.outputUsd - 0.0405708) < 1e-8)
  assert.ok(Math.abs(c.totalUsd - (c.inputUsd + c.outputUsd)) < 1e-12)
  assert.ok(Math.abs(c.totalCny - c.totalUsd * 7.2) < 1e-9)
})
t('峰价恰好是谷价的 2 倍', () => {
  const off = computeCost(B, priceFor('deepseek-flash', at('2026-09-18T05:00:00Z')), 7.2)
  const pk = computeCost(B, priceFor('deepseek-flash', at('2026-09-18T02:00:00Z')), 7.2)
  assert.ok(Math.abs(pk.totalUsd - off.totalUsd * 2) < 1e-12)
})

console.log('payload 组装')
const fakeCtx = {
  sessionProjections: {
    snapshot: () => ({
      values: {
        tokenUsage: { uncachedInputTokens: 96266, cacheReadTokens: 6955648, cacheWriteTokens: 0, outputTokens: 67618 },
        contextBreakdown: { systemTokens: 39270, toolsTokens: 524, messageTokens: 225610 },
      },
    }),
  },
}
const sess = { header: { id: 'sess-test' } }
t('ok=true 且四桶与命中率正确', () => {
  const p = buildPayload(fakeCtx, sess, 'deepseek-flash')
  assert.equal(p.ok, true)
  assert.equal(p.measured.totalTokens, 96266 + 6955648 + 67618)
  assert.ok(Math.abs(p.measured.cacheHitRate - 0.98634) < 1e-4)
})
t('measured 与 attribution 是两组字段（口径分区）', () => {
  const p = buildPayload(fakeCtx, sess, 'deepseek-flash')
  assert.ok(p.measured && p.attribution)
  assert.notEqual(p.measured.totalTokens, p.attribution.totalTokens)
})
t('逐项金额之和 === 输入侧金额（闭合，且都是 CNY）', () => {
  const p = buildPayload(fakeCtx, sess, 'deepseek-flash')
  const sum = p.attribution.rows.reduce((s, r) => s + r.costCny, 0)
  assert.ok(Math.abs(sum - p.cost.inputUsd * p.cost.fx.rate) < 1e-6, 'sum=' + sum)
})
t('占比之和 === 1', () => {
  const p = buildPayload(fakeCtx, sess, 'deepseek-flash')
  const s = p.attribution.rows.reduce((x, r) => x + r.share, 0)
  assert.ok(Math.abs(s - 1) < 1e-6)
})
t('未定价模型：unpriced=true，占比不给钱', () => {
  const p = buildPayload(fakeCtx, sess, 'no-such-model')
  assert.equal(p.cost.unpriced, true)
  assert.equal(p.cost.totalCny, null)
  // null 表示「没算」，不是 0 —— 未定价不给钱，也不假装是 0
  assert.equal(p.attribution.rows[0].costCny, null)
})

console.log('模型解析（回归：插件后装时事件早过去了）')
const ctxWithSelection = {
  sessionProjections: {
    snapshot: () => ({
      values: {
        tokenUsage: { uncachedInputTokens: 96266, cacheReadTokens: 6955648, cacheWriteTokens: 0, outputTokens: 67618 },
        contextBreakdown: { systemTokens: 39270, toolsTokens: 524, messageTokens: 225610 },
        modelSelection: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }, pending: null },
      },
    }),
  },
}
t('模型取自 modelSelection 投影，不依赖事件跟踪', () => {
  const p = buildPayload(ctxWithSelection, sess, null)
  assert.equal(p.session.model, 'deepseek-v4-pro')
  assert.equal(p.cost.unpriced, false)
  assert.ok(p.cost.totalCny > 0)
})
t('v4-pro 按自己的价算（不是 flash 价）', () => {
  const p = buildPayload(ctxWithSelection, sess, null)
  const usd = (96266 / 1e6) * 0.66 + (6955648 / 1e6) * 0.022 + (67618 / 1e6) * 1.98
  assert.ok(Math.abs(p.cost.totalUsd - usd) < 1e-9, 'got ' + p.cost.totalUsd)
})

console.log('占比与金额解耦（回归：未定价不该把占比一起抹掉）')
t('未定价时占比照常给出，只有金额为 null', () => {
  // 用没有 modelSelection 的那份 ctx，模型才会落回传参的未知名
  const p = buildPayload(fakeCtx, sess, 'no-such-model')
  assert.equal(p.cost.unpriced, true)
  assert.equal(p.attribution.totalTokens, 39270 + 524 + 225610)
  for (const r of p.attribution.rows) {
    assert.equal(typeof r.share, 'number', r.label + ' 应仍有占比')
    assert.ok(r.share > 0)
    assert.equal(r.costCny, null, r.label + ' 金额应为 null 而不是 0')
  }
  assert.ok(Math.abs(p.attribution.rows.reduce((s, r) => s + r.share, 0) - 1) < 1e-9)
})

console.log('M2 六类归因')
t('事件分类：真人消息在 spliced，不在 user/message', () => {
  assert.deepEqual(classifyEvent({ type: 'user/message' }), { inject: 1 })
  assert.deepEqual(classifyEvent({ type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'user' }, content: 'hi' }] } }), { user: 1 })
  assert.deepEqual(classifyEvent({ type: 'system/message' }), { system: 1 })
  assert.deepEqual(classifyEvent({ type: 'tool/result' }), { toolResult: 1 })
  assert.deepEqual(classifyEvent({ type: 'assistant/message' }), { assistant: 1 })
})
t('spliced 混合时按内容占比摊开', () => {
  const w = classifyEvent({
    type: 'agent/inbox/spliced',
    data: { inserted: [
      { source: { kind: 'user' }, content: 'x'.repeat(30) },
      { source: { kind: 'plugin' }, content: 'y'.repeat(10) },
    ] },
  })
  assert.ok(Math.abs(w.user - 0.75) < 1e-9)
  assert.ok(Math.abs(w.inject - 0.25) < 1e-9)
})

const NODES = [
  [1, 100, { type: 'system/message' }],
  [2, 200, { type: 'user/message' }],
  [3, 300, { type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'user' }, content: 'q' }] } }],
  [4, 400, { type: 'tool/result' }],
  [5, 500, { type: 'assistant/message' }],
]
const nodeSession = { header: { id: 'sess-nodes' }, eventAt: (seq) => NODES.find((n) => n[0] === seq)?.[2] }
const ctxNodes = {
  sessionProjections: {
    snapshot: () => ({
      values: {
        tokenUsage: { uncachedInputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 500 },
        contextBreakdown: { systemTokens: 100, toolsTokens: 5, messageTokens: 1400 },
        modelSelection: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      },
    }),
  },
  tokenMeter: { measure: () => ({ logRevision: 42, nodes: NODES.map(([seq, tokens]) => ({ seq, tokens })) }) },
}
t('逐节点定价 + 事件分类 → 六类各自 token 正确', () => {
  const r = attribute(ctxNodes, nodeSession, 5)
  assert.equal(r.acc.system, 100)
  assert.equal(r.acc.inject, 200)
  assert.equal(r.acc.user, 300)
  assert.equal(r.acc.toolResult, 400)
  assert.equal(r.acc.assistant, 500)
  assert.equal(r.acc.toolsSchema, 5)
  assert.equal(r.total, 1505)
  assert.equal(r.logRevision, 42)
})
t('payload 里六类齐备且占比和为 1', () => {
  const p = buildPayload(ctxNodes, nodeSession, null)
  assert.equal(p.attribution.basis, 'tokenMeter.measure + session.eventAt')
  assert.equal(p.attribution.totalTokens, 1505)
  assert.deepEqual(p.attribution.rows.map((r) => r.key), ['system', 'toolsSchema', 'user', 'inject', 'toolResult', 'assistant'])
  assert.ok(Math.abs(p.attribution.rows.reduce((s, r) => s + r.share, 0) - 1) < 1e-9)
})
t('tokenMeter 缺席 → 退回三元并带 fallbackReason', () => {
  const p = buildPayload(fakeCtx, sess, 'deepseek-flash')
  assert.equal(p.attribution.basis, 'contextBreakdown(fallback)')
  assert.equal(p.attribution.rows.length, 3)
  assert.ok(typeof p.attribution.fallbackReason === 'string')
})

console.log('降级路径')
t('无会话 → NO_SESSION', () => assert.equal(buildPayload(fakeCtx, null, 'x').reason, 'NO_SESSION'))
t('投影抛错 → PROJECTION_UNAVAILABLE', () => {
  const bad = { sessionProjections: { snapshot: () => { throw new Error('nope') } } }
  assert.equal(buildPayload(bad, sess, 'x').reason, 'PROJECTION_UNAVAILABLE')
})
t('无用量 → NO_USAGE_YET', () => {
  const empty = { sessionProjections: { snapshot: () => ({ values: {} }) } }
  assert.equal(buildPayload(empty, sess, 'x').reason, 'NO_USAGE_YET')
})

console.log('\n全部通过：' + pass + ' 项')
