// test/subagent-check.mjs —— M3 子代理归集的验收（直接跑，不用 dsh web）
// 重点验两件事：① 用量取子会话自己的四桶（实测）② 已释放的子会话如实计数，不当 0 抹掉
import assert from 'node:assert/strict'
import { collectSubagents, resetSubagentCache } from '../src/index.mjs'

// 枚举带 4 秒 TTL 缓存；每个用例前重置，保证测的是「这次调用」的行为
// 包一层：每次调用前重置枚举缓存，测的才是「这次调用」的行为
const collect = async (ctx, parentId, settings) => { resetSubagentCache(); return collectSubagents(ctx, parentId, settings) }

let pass = 0
// 必须 await：断言写在 async 函数里，不 await 会先打印 ok 再跑断言（假绿）
const t = async (name, fn) => { await fn(); pass++; console.log('  ok  ' + name) }

const PARENT = 'sess-parent'
const SETTINGS = { fxRate: 7.2, showAmount: true, showAttribution: true }
const childLive = { header: { id: 'sess-child-live' } }

function makeCtx(options = {}) {
  return {
    sessions: { get: (id) => (id === 'sess-child-live' ? childLive : undefined) },
    sessionProjections: {
      snapshot: (session) => {
        if (session !== childLive) return { values: {} }
        return {
          values: {
            tokenUsage: { uncachedInputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 500 },
            modelSelection: { lastUsed: { model: options.childModel ?? 'deepseek-flash' } },
          },
        }
      },
    },
    sessionQuery: {
      listSessions: async () => {
        if (options.throwList) throw new Error('query down')
        return [
          { header: { id: 'sess-child-live', parentSession: PARENT, delegationDepth: 1, agentPreset: 'deepseek-doc' }, live: true },
          { header: { id: 'sess-child-gone', parentSession: PARENT, delegationDepth: 1, agentPreset: 'explorer' }, live: false },
          { header: { id: 'sess-unrelated', parentSession: 'someone-else', delegationDepth: 1 } },
        ]
      },
    },
  }
}

console.log('归集')
await t('只统计直接子会话（无关会话不计入）', async () => {
  const r = await collect(makeCtx(), PARENT, SETTINGS)
  assert.equal(r.count, 2)
  assert.ok(!r.items.some((i) => i.id === 'sess-unrelated'))
})
await t('活着的子会话：用量取它自己的四桶（实测）', async () => {
  const r = await collect(makeCtx(), PARENT, SETTINGS)
  assert.equal(r.measured, 1)
  assert.equal(r.tokens, 1000 + 9000 + 500)
  const live = r.items.find((i) => i.id === 'sess-child-live')
  assert.equal(live.tokens, 10500)
  assert.equal(live.model, 'deepseek-flash')
  assert.equal(live.mode, 'live')
  assert.ok(live.costCny > 0)
})
await t('已释放的子会话：如实计数并给出原因，不当 0 抹掉', async () => {
  const r = await collect(makeCtx(), PARENT, SETTINGS)
  assert.equal(r.released, 1)
  const gone = r.items.find((i) => i.id === 'sess-child-gone')
  assert.equal(gone.tokens, null)
  assert.match(gone.note, /已释放/)
})
await t('金额与手算一致（谷价 flash）', async () => {
  const r = await collect(makeCtx(), PARENT, SETTINGS)
  const usd = (1000 / 1e6) * 0.15 + (9000 / 1e6) * 0.003 + (500 / 1e6) * 0.6
  assert.ok(Math.abs(r.costCny - usd * 7.2) < 1e-9, 'got ' + r.costCny)
})

console.log('诚实性')
await t('子代理模型未定价 → 合计金额为 null（不给半真的数）', async () => {
  const r = await collect(makeCtx({ childModel: 'no-such-model' }), PARENT, SETTINGS)
  assert.equal(r.costCny, null)
  assert.equal(r.items.find((i) => i.id === 'sess-child-live').unpriced, true)
})
await t('枚举失败 → 带 unavailable，不崩、不假装没有子代理', async () => {
  const r = await collect(makeCtx({ throwList: true }), PARENT, SETTINGS)
  assert.equal(r.count, 0)
  assert.match(r.unavailable, /query down/)
})
await t('全部都释放时 → tokens/costCny 为 null，而不是 0（不假装花了 0）', async () => {
  const onlyGone = {
    sessions: { get: () => undefined },
    sessionProjections: { snapshot: () => ({ values: {} }) },
    sessionQuery: { listSessions: async () => [{ header: { id: 'g1', parentSession: PARENT, delegationDepth: 1 }, live: false }] },
  }
  const r = await collect(onlyGone, PARENT, SETTINGS)
  assert.equal(r.count, 1)
  assert.equal(r.released, 1)
  assert.equal(r.tokens, null, '取不到不是 0')
  assert.equal(r.costCny, null)
})

await t('没有 parentId → 空结果', async () => {
  const r = await collect(makeCtx(), null, SETTINGS)
  assert.equal(r.count, 0)
})
await t('includedInTotal 恒为 false（不并进本会话总额）', async () => {
  const r = await collect(makeCtx(), PARENT, SETTINGS)
  assert.equal(r.includedInTotal, false)
})

console.log('\n子代理归集全部通过：' + pass + ' 项')
