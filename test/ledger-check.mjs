// test/ledger-check.mjs —— M6-a/M6-b 逐轮账本的验收
//
// 判据先写在前面（与 docs/design-m6.md 第六节一一对应）：
//   1. 幂等：同一批轮次写两遍，读出来与写一遍完全一致
//   2. 崩溃截断：文件尾部半行 JSON → 跳过该行、其余照常读出，且后续追加不粘行
//   3. 价格漂移：金额取**存储值**，换价表/重启都不变（账本里根本没有重算这条路）
//   4. 重启不重走日志：账本已覆盖到会话末尾时，session.events / eventAt 一次都不读
//   5. 与投影的关系不变：账本只减少「未覆盖」，不重复计也不遗漏
//   6. 降级：账本目录写不进去 → 只记 warn，不抛
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEDGER_SCHEMA_VERSION, createLedger, foldRows, isLedgerRow, monthKeyOf, parseRow, readMonthFile, rowKey } from '../src/ledger.mjs'
import { SETTINGS_DEFAULTS, apply } from '../src/index.mjs'
import { buildReport, renderMarkdown } from '../src/report.mjs'

/** 插件版本从 package.json 读 —— 断言里写死版本号会在 bump 时无故变红（刚踩过）。 */
const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

let pass = 0
const failures = []
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok  ' + name) }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + ' → ' + (e?.message ?? e)) }
}
const tmp = (tag) => mkdtempSync(join(tmpdir(), 'ledger-' + tag + '-'))
const ledgerDirOf = (home) => join(home, 'storages', 'dsh-usage-card', 'ledger')
/** 账本文件名带写入进程的 pid：<月份>.<pid>.jsonl（同一个月允许多进程各写各的）。 */
const ledgerFile = (home, month, pid = process.pid) => join(ledgerDirOf(home), month + '.' + pid + '.jsonl')
const ledgerFilesOf = (home) => readdirSync(ledgerDirOf(home))

const row = (seq, time, over = {}) => ({
  sessionId: 'session-test', seq, time, model: 'deepseek-flash', tier: 'offpeak',
  buckets: { uncachedInputTokens: 1000, cacheReadTokens: 5000, cacheWriteTokens: 0, outputTokens: 500 },
  usdInput: 0.001, usdOutput: 0.002, priceVersion: '2026-09-18', pluginVersion: '0.12.0',
  ...over,
})

console.log('账本形态')
await t('schemaVersion 是 1，月份键按 UTC', () => {
  assert.equal(LEDGER_SCHEMA_VERSION, 1)
  assert.equal(monthKeyOf(Date.UTC(2026, 8, 21, 3, 0, 0)), '2026-09')
  assert.equal(monthKeyOf(Date.UTC(2026, 0, 1, 0, 0, 0)), '2026-01')
})
await t('形状不对的行一律判为坏行', () => {
  assert.equal(isLedgerRow(row(1, Date.now())), true)
  assert.equal(isLedgerRow({ ...row(1, Date.now()), seq: '1' }), false)
  assert.equal(isLedgerRow({ ...row(1, Date.now()), buckets: null }), false)
  assert.equal(isLedgerRow({ ...row(1, Date.now()), sessionId: '' }), false)
  assert.equal(parseRow('{"broken'), null)
  assert.equal(parseRow(JSON.stringify({ sessionId: 'x' })), null)
})
await t('幂等键是 sessionId#seq', () => {
  assert.equal(rowKey(row(7, Date.now())), 'session-test#7')
})

console.log('1) 幂等')
{
  const home = tmp('idem')
  await t('同一批轮次写两遍 = 写一遍（重放/回填交叠不翻倍）', () => {
    const led = createLedger({ home, onWarn: (m) => { throw new Error('不该有 warn: ' + m) } })
    const batch = [row(1, Date.UTC(2026, 8, 21, 1)), row(2, Date.UTC(2026, 8, 21, 2)), row(3, Date.UTC(2026, 8, 21, 3))]
    for (const r of batch) led.append(r)
    led.flush()
    const once = foldRows(led.load('session-test'))
    for (const r of batch) led.append(r)
    led.flush()
    const twice = foldRows(led.load('session-test'))
    assert.equal(once.turns, 3)
    assert.equal(twice.turns, 3, '写两遍不能变成 6 轮')
    assert.equal(twice.usd, once.usd)
    assert.equal(ledgerFilesOf(home).length, 1, '同月只应有一个文件')
    assert.match(ledgerFilesOf(home)[0], /^2026-09\.\d+\.jsonl$/, '文件名应带写入进程的 pid')
  })
  rmSync(home, { recursive: true, force: true })
}

console.log('1b) 同一个月多进程各写各的文件')
{
  const home = tmp('multiproc')
  await t('两个"进程"写同一轮 → 读时按 (sessionId,seq) 去重，不翻倍', () => {
    // 模拟同一个月两个 dsh 进程（web / worker）共用同一个 DSH_HOME
    const a = createLedger({ home, pid: 111 })
    const b = createLedger({ home, pid: 222 })
    a.append(row(1, Date.UTC(2026, 8, 21, 1)))
    a.append(row(2, Date.UTC(2026, 8, 21, 2)))
    b.append(row(2, Date.UTC(2026, 8, 21, 2)))   // 同一轮，另一个进程也看到了
    b.append(row(3, Date.UTC(2026, 8, 21, 3)))
    a.flush()
    b.flush()
    assert.equal(ledgerFilesOf(home).length, 2, '两个进程各写各的文件')
    const merged = foldRows(a.load('session-test'))
    assert.equal(merged.turns, 3, '2 + 2 行去重后是 3 轮，不是 4')
    assert.equal(foldRows(b.load('session-test')).turns, 3, '另一侧读到的也一样')
  })
  await t('别的进程刚写进去的行，本进程下一次读就能看见（mtime 失效）', () => {
    const a = createLedger({ home, pid: 111 })
    const b = createLedger({ home, pid: 333 })
    assert.equal(a.load('session-test').length, 3)
    a.load('session-test')                       // 先把缓存坐实
    b.append(row(9, Date.UTC(2026, 8, 21, 9)))
    b.flush()
    assert.equal(a.load('session-test').length, 4, '不能一直用陈旧快照')
  })
  rmSync(home, { recursive: true, force: true })
}

console.log('2) 崩溃截断')
{
  const home = tmp('crash')
  await t('尾部半行被跳过，且**后续追加不粘行**', () => {
    const led = createLedger({ home })
    led.append(row(1, Date.UTC(2026, 8, 21, 1)))
    led.append(row(2, Date.UTC(2026, 8, 21, 2)))
    led.flush()
    appendFileSync(ledgerFile(home, '2026-09'), '{"sessionId":"session-test","seq":3,"time":17', 'utf8')
    const res = readMonthFile(ledgerFile(home, '2026-09'))
    assert.equal(res.rows.length, 2)
    assert.equal(res.badLines, 1)
    led.append(row(4, Date.UTC(2026, 8, 21, 4)))   // 崩之后继续写
    led.flush()
    const after = foldRows(led.load('session-test'))
    assert.equal(after.turns, 3, '半行只坏自己那一行，不能把续写的行一起带走')
  })
  rmSync(home, { recursive: true, force: true })
}

console.log('3) 价格漂移：金额取存储值')
{
  const home = tmp('freeze')
  await t('重启（新开一个账本实例）后金额原样', () => {
    const led = createLedger({ home })
    led.append(row(1, Date.UTC(2026, 8, 21, 1), { usdInput: 0.5, usdOutput: 1.5 }))
    led.flush()
    const before = foldRows(led.load('session-test')).usd
    // 账本里没有任何"按当前价重算"的入口 —— 这正是冻结的意思
    const reopened = createLedger({ home })
    const after = foldRows(reopened.load('session-test')).usd
    assert.equal(before, 2)
    assert.equal(after, 2, '重启后金额不变')
  })
  await t('未定价的轮次如实计数，不冒充 0', () => {
    const led = createLedger({ home })
    led.append(row(10, Date.UTC(2026, 8, 21, 10), { usdInput: null, usdOutput: null, model: null, tier: null }))
    led.append(row(11, Date.UTC(2026, 8, 21, 11), { usdInput: 0.25, usdOutput: 0.25 }))
    led.flush()
    const folded = foldRows(led.load('session-test'))
    assert.equal(folded.turns, 3)
    assert.equal(folded.unpricedTurns, 1)
    assert.equal(folded.usd, 2.5)
  })
  await t('按天/按模型聚合用的是本地日', () => {
    const folded = foldRows([row(1, Date.UTC(2026, 8, 21, 1)), row(2, Date.UTC(2026, 8, 22, 1))])
    assert.equal(folded.days.length, 2, '跨天要分成两天')
    assert.equal(folded.models.length, 1)
    assert.equal(folded.models[0].model, 'deepseek-flash')
  })
  rmSync(home, { recursive: true, force: true })
}

console.log('M6-b) 报告里的账本对照（方案 A：冻结为准，报告给对照）')
await t('两个口径并列，差异带符号', () => {
  const sessions = [{ sessionId: 's1', turns: 2, usd: 1, unpricedTurns: 0, days: [], models: [], totals: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }]
  const md = renderMarkdown(buildReport(sessions, {
    fxRate: 7, generatedAt: '2026-09-21T00:00:00.000Z', priceVersion: 'v1', covers: 1,
    ledger: { turns: 2, usd: 0.9, unpricedTurns: 0 },
  }))
  assert.match(md, /账本口径对照/)
  assert.match(md, /账本（写入时定价，已冻结） \| 2 \| ¥6\.3000/)
  assert.match(md, /当前价重算（上表即此口径） \| 2 \| ¥7\.0000/)
  assert.match(md, /\| -¥0\.7000 \|/)
})
await t('没有账本时不渲染对照块（老行为一字不变）', () => {
  const sessions = [{ sessionId: 's1', turns: 2, usd: 1, unpricedTurns: 0, days: [], models: [], totals: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }]
  const md = renderMarkdown(buildReport(sessions, { fxRate: 7, generatedAt: 'x', priceVersion: 'v1', covers: 1 }))
  assert.doesNotMatch(md, /账本口径对照/)
})

console.log('6) 降级：目录写不进去也不抛')
{
  const home = tmp('broken')
  await t('ledger 路径被文件占住 → 只记一条 warn，读取返回空', () => {
    mkdirSync(join(home, 'storages', 'dsh-usage-card'), { recursive: true })
    writeFileSync(join(home, 'storages', 'dsh-usage-card', 'ledger'), 'not a directory', 'utf8')
    const warns = []
    const led = createLedger({ home, onWarn: (m) => warns.push(m) })
    assert.equal(led.append(row(1, Date.UTC(2026, 8, 21, 1))), true)
    assert.doesNotThrow(() => led.flush())
    assert.equal(warns.length, 1, '应记一条 warn')
    assert.deepEqual(led.load('session-test'), [])
  })
  rmSync(home, { recursive: true, force: true })
}

console.log('4/5) 宿主集成：拉起 → 记账 → 重启不重走日志')
const homeX = tmp('host')
const realHome = process.env.DSH_HOME
const SESSION_ID = 'session-beb41318-0147-4ccb-9401-d5e8573c3194'
/** 两个真实轮次（seq 连续）+ 一条决定模型的头事件。 */
const EVENTS = [
  { type: 'request/header', seq: 0, time: Date.UTC(2026, 8, 21, 1, 0, 0), data: { header: { config: { model: 'deepseek-flash' } } } },
  { type: 'assistant/message', seq: 1, time: Date.UTC(2026, 8, 21, 1, 1, 0), data: { usage: { inputTokens: 1000, cacheReadTokens: 5000, outputTokens: 500 } } },
  { type: 'assistant/message', seq: 2, time: Date.UTC(2026, 8, 21, 1, 2, 0), data: { usage: { inputTokens: 2000, cacheReadTokens: 6000, outputTokens: 700 } } },
]
const BOOT = { input: 3000, cache: 11000, output: 1200 }
function makeSession({ reads, withEvents }) {
  const session = {
    header: { id: SESSION_ID, parentSession: null, delegationDepth: 0 },
    id: SESSION_ID,
    seq: 2,
    eventAt: (i) => (withEvents ? EVENTS[i] : undefined),
  }
  Object.defineProperty(session, 'events', {
    get() { reads.n += 1; return withEvents ? EVENTS : [] },
    configurable: true,
  })
  return session
}
function makeCtx(session, listeners) {
  const registered = []
  return {
    registered,
    webServer: { register: (spec) => { registered.push(spec); return () => {} } },
    sessions: { get: (id) => (id === SESSION_ID ? session : undefined) },
    sessionProjections: { snapshot: () => ({ values: {
      tokenUsage: { uncachedInputTokens: BOOT.input, cacheReadTokens: BOOT.cache, cacheWriteTokens: 0, outputTokens: BOOT.output },
      contextBreakdown: { systemTokens: 1, toolsTokens: 2, messageTokens: 3 },
      modelSelection: { lastUsed: { model: 'deepseek-flash' } },
    }, asOfSeq: session.seq }) },
    sessionQuery: {}, tokenMeter: {},
    settings: { register: () => ({ get: () => ({ ...SETTINGS_DEFAULTS }), update: async () => {} }) },
    connection: { requestRejection: () => undefined },
    on: (name, fn) => { listeners.push({ name, fn }); return () => {} },
    effect: (fn) => { const d = fn(); return () => { try { d?.() } catch { /* 已回收 */ } } },
    logger: { info: () => {}, warn: () => {} },
  }
}
async function probe(ctx) {
  const handler = ctx.registered.find((r) => r.path === '/usage-card/current.json').handler
  let body = ''
  const res = { statusCode: 0, setHeader() {}, writeHead(c) { this.statusCode = c }, end(c) { body += c ?? '' } }
  await handler({ url: '/usage-card/current.json?session=' + SESSION_ID, method: 'GET', headers: { host: '127.0.0.1:3080' } }, res)
  return JSON.parse(body)
}

process.env.DSH_HOME = homeX
try {
  // 第一次启动：实时事件记账
  const reads1 = { n: 0 }
  const session1 = makeSession({ reads: reads1, withEvents: false })
  const listeners = []
  apply(makeCtx(session1, listeners))
  const onEvent = listeners.find((l) => l.name === 'session/event')
  await t('apply 订阅了 session/event', () => assert.ok(onEvent, '应有 session/event 订阅'))
  for (const e of EVENTS) onEvent?.fn(session1, e)
  await new Promise((r) => setTimeout(r, 450))   // 让防抖落盘

  await t('实时事件被记进账本（按月落盘，含金额与价目版本）', () => {
    assert.equal(ledgerFilesOf(homeX).length, 1)
    assert.match(ledgerFilesOf(homeX)[0], /^2026-09\.\d+\.jsonl$/)
    const rows = readMonthFile(ledgerFile(homeX, '2026-09')).rows
    assert.equal(rows.length, 2, '两条 assistant/message 各一行')
    assert.equal(rows[0].sessionId, SESSION_ID)
    assert.equal(Number.isFinite(rows[0].usdInput), true)
    assert.equal(rows[0].priceVersion, '2026-09-18')
    assert.equal(rows[0].pluginVersion, PKG_VERSION)
  })

  // 第二次启动（模拟重启）：账本已覆盖会话末尾
  const reads2 = { n: 0 }
  const session2 = makeSession({ reads: reads2, withEvents: true })
  const ctx2 = makeCtx(session2, [])
  apply(ctx2)
  const payload2 = await probe(ctx2)
  await t('重启后一次都不读 session.events（账本已覆盖到会话末尾）', () => {
    assert.equal(reads2.n, 0, '不该访问日志访问器')
  })
  await t('重启后仍算得出钱，且口径仍是逐轮精确', () => {
    assert.equal(payload2.ok, true)
    assert.equal(payload2.cost.pricing.mode, 'per-turn')
    assert.equal(payload2.cost.pricing.turns, 2)
    assert.ok(payload2.cost.totalCny > 0)
  })
  await t('四桶仍以内核投影为准（账本不重复计、不遗漏）', () => {
    assert.equal(payload2.measured.uncachedInputTokens, BOOT.input)
    assert.equal(payload2.measured.cacheReadTokens, BOOT.cache)
    assert.equal(payload2.measured.outputTokens, BOOT.output)
  })

  // 第三次启动：会话没变，但换一个没有任何账本的 home → 必须走日志回填（功能没被挡）
  const reads3 = { n: 0 }
  const session3 = makeSession({ reads: reads3, withEvents: true })
  const ctx3 = makeCtx(session3, [])
  apply(ctx3)
  const payload3 = await probe(ctx3)
  await t('账本为空时仍走日志回填（盖子没盖死）', () => {
    assert.equal(payload3.ok, true)
    assert.equal(payload3.cost.pricing.turns, 2, '日志里的两轮仍要被计入')
  })
} finally {
  if (realHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = realHome
  rmSync(homeX, { recursive: true, force: true })
}

console.log('')
if (failures.length > 0) {
  console.log('账本验收：失败 ' + failures.length + ' 项 —— ' + failures.join(' / '))
  process.exit(1)
}
console.log('账本验收：通过 ' + pass + ' 项')
