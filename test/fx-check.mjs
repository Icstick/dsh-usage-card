// test/fx-check.mjs —— M6 汇率自动更新的验收（直接跑，不联网）
//
// 三件事分开验：
//   A. 取汇率：多源、合理性闸、全挂 → null（绝不写离谱的值）
//   B. 该不该同步：关掉 / 从未同步 / 手改过 / 刚同步过，四种判定
//   C. 拉起时真的会同步：假 ctx 跑 apply，断言启动即发起一次拉取并写入设置；网络挂起也不阻塞、不冒泡
import assert from 'node:assert/strict'
import { FX_AUTO_MIN_INTERVAL_MS, SETTINGS_DEFAULTS, apply, autoSyncFx, fetchUsdCny, fxSnapshot, shouldAutoSync } from '../src/index.mjs'

let pass = 0
const failures = []
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok  ' + name) }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + ' → ' + (e?.message ?? e)) }
}

/** 假 fetch：按 URL 里的源 id 给出响应。 */
function fakeFetch(table) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    const hit = Object.keys(table).find((k) => url.includes(k))
    if (hit === undefined) throw new Error('offline')
    const entry = table[hit]
    if (entry instanceof Error) throw entry
    if (typeof entry === 'number') return { ok: true, json: async () => ({ rates: { CNY: entry } }) }
    return entry
  }
  impl.calls = calls
  return impl
}

console.log('取汇率')
await t('第一个源给合理值 → 用它', async () => {
  const f = fakeFetch({ 'open.er-api.com': 7.05 })
  const found = await fetchUsdCny(f)
  assert.deepEqual(found, { rate: 7.05, source: 'open.er-api.com' })
  assert.equal(f.calls.length, 1)
})
await t('第一个源非 200 → 顺延到第二个', async () => {
  const f = fakeFetch({ 'open.er-api.com': { ok: false }, 'exchangerate-api.com': 7.11 })
  const found = await fetchUsdCny(f)
  assert.deepEqual(found, { rate: 7.11, source: 'exchangerate-api.com' })
})
await t('离谱值一律拒绝（0 / 负数 / NaN / 50）', async () => {
  for (const bad of [0, -7, 50, 'abc', null]) {
    const f = fakeFetch({ 'open.er-api.com': typeof bad === 'number' ? bad : { ok: true, json: async () => ({ rates: { CNY: bad } }) } })
    assert.equal(await fetchUsdCny(f), null, '不该接受 ' + String(bad))
  }
})
await t('所有源都挂 → null（不抛）', async () => {
  const f = fakeFetch({})
  assert.equal(await fetchUsdCny(f), null)
})

console.log('该不该在拉起时自动同步')
const base = { ...SETTINGS_DEFAULTS, fxRate: 7.2 }
await t('全新安装（从未同步过）→ 放行（否则默认 7.2 会被误判成手动覆盖）', () => {
  assert.equal(shouldAutoSync(base, Date.now()).ok, true)
})
await t('关掉开关 → DISABLED', () => {
  assert.equal(shouldAutoSync({ ...base, fxAuto: false }, Date.now()).reason, 'DISABLED')
})
await t('同步过且值未被改 → 放行', () => {
  const stamped = { ...base, fxRate: 7.05, fxSyncedRate: 7.05, fxSyncedAt: new Date(Date.now() - FX_AUTO_MIN_INTERVAL_MS - 1000).toISOString() }
  assert.equal(shouldAutoSync(stamped, Date.now()).ok, true)
})
await t('同步过但之后被人手改 → MANUAL_OVERRIDE（不许冲掉手填的记账汇率）', () => {
  const stamped = { ...base, fxRate: 6.5, fxSyncedRate: 7.05, fxSyncedAt: new Date(Date.now() - 3600_000).toISOString() }
  assert.equal(shouldAutoSync(stamped, Date.now()).reason, 'MANUAL_OVERRIDE')
})
await t('刚同步过（<10 分钟）→ RECENT（挡住重启风暴）', () => {
  const stamped = { ...base, fxRate: 7.05, fxSyncedRate: 7.05, fxSyncedAt: new Date(Date.now() - 60_000).toISOString() }
  assert.equal(shouldAutoSync(stamped, Date.now()).reason, 'RECENT')
})

console.log('自动同步动作')
await t('成功 → 四个字段一起写（汇率/同步值/时间/来源）', async () => {
  const writes = []
  const r = await autoSyncFx({ settings: base, write: (p) => { writes.push(p) }, fetchImpl: fakeFetch({ 'open.er-api.com': 7.05 }), now: Date.parse('2026-09-21T05:00:00Z') })
  assert.equal(r.ok, true)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0], { fxRate: 7.05, fxSyncedRate: 7.05, fxSyncedAt: '2026-09-21T05:00:00.000Z', fxSource: 'open.er-api.com' })
})
await t('全挂 → 一个字都不写，返回 FX_UNAVAILABLE', async () => {
  const writes = []
  const r = await autoSyncFx({ settings: base, write: (p) => { writes.push(p) }, fetchImpl: fakeFetch({}) })
  assert.equal(r.reason, 'FX_UNAVAILABLE')
  assert.equal(writes.length, 0)
})
await t('写设置抛错 → WRITE_FAILED 且不冒泡', async () => {
  const r = await autoSyncFx({ settings: base, write: () => { throw new Error('read-only') }, fetchImpl: fakeFetch({ 'open.er-api.com': 7.05 }) })
  assert.equal(r.reason, 'WRITE_FAILED')
})
await t('关掉开关 → 一次网络都不发', async () => {
  const f = fakeFetch({ 'open.er-api.com': 7.05 })
  const r = await autoSyncFx({ settings: { ...base, fxAuto: false }, write: () => {}, fetchImpl: f })
  assert.equal(r.reason, 'DISABLED')
  assert.equal(f.calls.length, 0)
})

console.log('汇率出处（不许把"手动值"说成"同步来的"）')
await t('同步值未被改 → status=synced，带来源与时间', () => {
  const snap = fxSnapshot({ ...base, fxRate: 7.05, fxSyncedRate: 7.05, fxSyncedAt: '2026-09-21T05:00:00.000Z', fxSource: 'open.er-api.com' })
  assert.equal(snap.status, 'synced')
  assert.equal(snap.source, 'open.er-api.com')
  assert.equal(snap.at, '2026-09-21T05:00:00.000Z')
})
await t('同步之后被手改 → status=manual，不冒充同步值', () => {
  const snap = fxSnapshot({ ...base, fxRate: 6.5, fxSyncedRate: 7.05, fxSyncedAt: '2026-09-21T05:00:00.000Z', fxSource: 'open.er-api.com' })
  assert.equal(snap.status, 'manual')
  assert.equal(snap.source, 'settings')
  assert.equal(snap.at, null)
})
await t('从未同步过 → status=manual', () => {
  assert.equal(fxSnapshot(base).status, 'manual')
})

console.log('拉起时真的会同步（假 ctx 跑 apply）')
function fakeCtx(settingsScope) {
  const registered = []
  return {
    registered,
    webServer: { register: (spec) => { registered.push(spec); return () => {} } },
    sessionProjections: { snapshot: () => ({ values: {} }) },
    sessions: {}, sessionQuery: {}, tokenMeter: {},
    connection: { requestRejection: () => undefined },
    settings: { register: () => settingsScope },
    on: () => () => {},
    effect: (fn) => { const d = fn(); return () => { try { d?.() } catch {} } },
    logger: { info: () => {}, warn: () => {} },
  }
}
const realFetch = globalThis.fetch
try {
  await t('apply 会在启动时自动拉一次汇率并写入设置', async () => {
    const writes = []
    const scope = { get: () => ({ ...SETTINGS_DEFAULTS }), update: (p) => { writes.push(p) } }
    globalThis.fetch = fakeFetch({ 'open.er-api.com': 6.99 })
    apply(fakeCtx(scope))
    // 自动同步是 fire-and-forget：给它几个微任务的时间落地
    for (let i = 0; i < 20 && writes.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5))
    assert.equal(writes.length, 1, '启动时应写入一次')
    assert.equal(writes[0].fxRate, 6.99)
    assert.equal(writes[0].fxSource, 'open.er-api.com')
  })
  await t('网络挂起时 apply 立刻返回、不抛、不阻塞', async () => {
    const scope = { get: () => ({ ...SETTINGS_DEFAULTS }), update: () => { throw new Error('should not be called') } }
    globalThis.fetch = () => new Promise(() => {})   // 永不 resolve
    const started = Date.now()
    apply(fakeCtx(scope))
    assert.ok(Date.now() - started < 1000, 'apply 不能等网络')
    await new Promise((r) => setTimeout(r, 30))
  })
  await t('所有源都挂时 apply 不冒泡（只留日志）', async () => {
    const scope = { get: () => ({ ...SETTINGS_DEFAULTS }), update: () => { throw new Error('nope') } }
    globalThis.fetch = async () => { throw new Error('offline') }
    apply(fakeCtx(scope))
    await new Promise((r) => setTimeout(r, 30))
  })
} finally {
  globalThis.fetch = realFetch
}

console.log('')
if (failures.length > 0) {
  console.log('汇率自动更新验收：失败 ' + failures.length + ' 项 —— ' + failures.join(' / '))
  process.exit(1)
}
console.log('汇率自动更新验收：通过 ' + pass + ' 项')
