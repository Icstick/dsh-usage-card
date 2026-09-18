// test/wiring-check.mjs —— 接线验证（不启动 dsh web）
// dev-lessons 第 21 条的教训：模块级测试全绿但接线从未插入 = 假绿。
// 这里真的调 apply(ctx)，检验：路由注册到了预期路径、handler 返回可解析的 JSON、事件被跟踪。
import assert from 'node:assert/strict'
import { apply, ROUTE, REPORT_ROUTE, localFenceRejection } from '../src/index.mjs'

let pass = 0
// 必须 await：handler 已是 async，断言与取回 body 都要等
const t = async (name, fn) => { await fn(); pass++; console.log('  ok  ' + name) }

const registered = []
const listeners = new Map()
const effects = []

const fakeSession = { header: { id: 'sess-wiring' } }
const ctx = {
  // webServer 接缝：捕获注册
  webServer: { register: (spec) => { registered.push(spec); return () => { spec.disposed = true } } },
  // sessionProjections：给一份确定的数据
  sessionProjections: {
    snapshot: (session) => ({
      values: session === fakeSession
        ? {
            tokenUsage: { uncachedInputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 500 },
            contextBreakdown: { systemTokens: 4000, toolsTokens: 100, messageTokens: 6000 },
          }
        : {},
    }),
  },
  // 事件与生命周期
  // connection 接缝：宿主信任栅栏。这里模拟「Host 非本机就 403」
  connection: { requestRejection: (req) => (req?.headers?.host === 'evil.example' ? 403 : undefined) },
  // settings 接缝：注册后返回作用域，可读取
  settings: { register: () => ({ get: () => ({ fxRate: 7.2, showAmount: true, showAttribution: true }) }) },
  on: (name, fn) => { listeners.set(name, fn); return () => { listeners.delete(name) } },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') effects.push(d) },
}

console.log('接线')
await t('apply 可调用且不抛', () => apply(ctx))
await t('两条只读路由都注册了（卡片 + 报告）', () => {
  assert.equal(registered.length, 2)
  for (const path of [ROUTE, REPORT_ROUTE]) {
    const route = registered.find((r) => r.path === path)
    assert.ok(route, '缺路由 ' + path)
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.handler, 'function')
  }
})
await t('订阅了 session/event', () => assert.ok(listeners.has('session/event')))

await t('注册了可回收的 effect（卸载不泄漏）', () => assert.ok(effects.length >= 2 && effects.every((f) => typeof f === 'function')))

console.log('路由行为')
// 按路径取，不依赖注册顺序
const handler = registered.find((r) => r.path === ROUTE).handler
async function call(url = ROUTE, init = {}) {
  let body = ''
  const res = {
    statusCode: 0, headers: {},
    setHeader(name, value) { this.headers[name] = value },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers ?? {}) },
    end(chunk) { body += chunk ?? '' },
  }
  await handler({ url, method: init.method ?? 'GET', headers: init.headers ?? { host: '127.0.0.1:3080' } }, res)
  // 405/403 这类拒绝没有 body，JSON.parse('') 会抛 —— 空 body 一律返回 null
  return { status: res.statusCode, headers: res.headers, json: body === '' ? null : JSON.parse(body) }
}

await t('无事件时返回 NO_SESSION（不是 500，也不是 0）', async () => {
  const r = await call()
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, 'NO_SESSION')
})
await t('收到事件后返回真实 payload', async () => {
  listeners.get('session/event')(fakeSession, { type: 'request/header', data: { header: { config: { model: 'deepseek-flash' } } } })
  const r = await call()
  assert.equal(r.json.ok, true)
  assert.equal(r.json.session.model, 'deepseek-flash')
  assert.equal(r.json.measured.totalTokens, 1000 + 9000 + 500)
})
await t('响应头是 JSON 且禁缓存', async () => {
  const r = await call()
  assert.match(r.headers['Content-Type'], /application\/json/)
  assert.equal(r.headers['Cache-Control'], 'no-store')
})
await t('handler 抛错也被兜住（返回 INTERNAL 而不是崩宿主）', async () => {
  const bad = { ...ctx, sessionProjections: { snapshot: () => { throw new Error('boom') } } }
  const capture = []
  const c2 = { ...bad, webServer: { register: (s) => { capture.push(s); return () => {} } } }
  apply(c2)
  // 新实例有自己的闭包，必须先喂一个事件它才知道「当前会话」是哪个
  listeners.get('session/event')(fakeSession, { type: 'request/header', data: { header: { config: { model: 'deepseek-flash' } } } })
  let body = ''
  await capture[0].handler(
    { url: ROUTE, method: 'GET', headers: { host: '127.0.0.1:3080' } },
    { statusCode: 0, headers: {}, setHeader(n, v) { this.headers[n] = v }, writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}) }, end(chunk) { body += chunk ?? '' } },
  )
  assert.equal(JSON.parse(body).reason, 'PROJECTION_UNAVAILABLE')
})

console.log('按会话取数（切换会话时的正确性）')
const otherSession = { header: { id: 'sess-other' } }
// 让 ctx 具备按 id 解析会话的能力，并给另一个会话不同的用量
const sessionsById = new Map([[otherSession.header.id, otherSession]])
const ctx2 = {
  ...ctx,
  sessions: { get: (id) => sessionsById.get(String(id)) },
  sessionProjections: {
    snapshot: (session) => ({
      values: session === otherSession
        ? { tokenUsage: { uncachedInputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0, outputTokens: 1 } }
        : { tokenUsage: { uncachedInputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 500 } },
    }),
  },
}
const capture2 = []
const c3 = { ...ctx2, webServer: { register: (s) => { capture2.push(s); return () => {} } } }
apply(c3)
listeners.get('session/event')(fakeSession, { type: 'request/header', data: { header: { config: { model: 'deepseek-flash' } } } })
const call2 = async (url) => {
  let body = ''
  await capture2[0].handler({ url, method: 'GET', headers: { host: '127.0.0.1:3080' } }, {
    statusCode: 0, headers: {}, setHeader(n, v) { this.headers[n] = v },
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}) },
    end(chunk) { body += chunk ?? '' },
  })
  return JSON.parse(body)
}
await t('带 ?session= 时按该会话取数（而不是「最近有事件」的那个）', async () => {
  const p = await call2(ROUTE + '?session=sess-other')
  assert.equal(p.ok, true)
  assert.equal(p.session.id, 'sess-other')
  assert.equal(p.measured.totalTokens, 7 + 3 + 1)
})
await t('不带 session 时退回最近事件会话', async () => {
  const p = await call2(ROUTE)
  assert.equal(p.session.id, 'sess-wiring')
  assert.equal(p.measured.totalTokens, 10500)
})
await t('会话解析不到 → SESSION_NOT_LOADED（不显示别人的数字）', async () => {
  const p = await call2(ROUTE + '?session=does-not-exist')
  assert.equal(p.ok, false)
  assert.equal(p.reason, 'SESSION_NOT_LOADED')
  assert.equal(p.measured, undefined)
})

console.log('信任栅栏（P0 回归）')
await t('恶意 Host + 跨站源 → 被宿主栅栏拒绝，不返回任何数据', async () => {
  const r = await call(ROUTE, { headers: { host: 'evil.example', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' } })
  assert.equal(r.status, 403)
  assert.equal(r.json, null, '被拒时不得返回 payload')
})
await t('本机 Host → 放行', async () => {
  const r = await call(ROUTE, { headers: { host: '127.0.0.1:3080' } })
  assert.equal(r.status, 200)
})
await t('非 GET → 405 且带 allow 头', async () => {
  const r = await call(ROUTE, { method: 'POST', headers: { host: '127.0.0.1:3080' } })
  assert.equal(r.status, 405)
  assert.equal(r.headers.allow, 'GET')
})
await t('本地兜底栅栏：回环对端 + 回环 Host → 放行', () => {
  assert.equal(localFenceRejection({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } }), undefined)
  assert.equal(localFenceRejection({ socket: { remoteAddress: '::1' }, headers: { host: 'localhost:3080' } }), undefined)
})
await t('本地兜底栅栏：恶意 Host（DNS rebinding）→ 403', () => {
  assert.equal(localFenceRejection({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.example' } }), 403)
})
await t('本地兜底栅栏：非回环对端 → 403', () => {
  assert.equal(localFenceRejection({ socket: { remoteAddress: '192.168.1.7' }, headers: { host: '127.0.0.1:3080' } }), 403)
})
await t('宿主的 connection 服务缺席时 → 退到本地栅栏，而不是一律 403（第一版就栽在这）', async () => {
  const capture = []
  const noFence = { ...ctx, connection: undefined, webServer: { register: (s) => { capture.push(s); return () => {} } } }
  apply(noFence)
  let body = ''
  const res = { statusCode: 0, headers: {}, setHeader(n, v) { this.headers[n] = v }, writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}) }, end(chunk) { body += chunk ?? '' } }
  await capture[0].handler({ url: ROUTE, method: 'GET', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } }, res)
  assert.equal(res.statusCode, 200, '本机回环请求必须放行')
  assert.equal(res.headers['x-usage-card-fence'], 'local')
  assert.ok(body.length > 0)
})

console.log('设置接缝')
// 注意：探针必须在最后跑 —— 它复用了同一个 listeners Map，会把前面实例的监听器顶掉
await t('注册了设置命名空间（供设置页读写）', () => {
  let registeredNs = null
  const probe = {
    ...ctx,
    settings: { register: (ns) => { registeredNs = ns; return { get: () => ({ fxRate: 7.2, showAmount: true, showAttribution: true }) } } },
  }
  apply(probe)
  assert.equal(registeredNs, 'dsh-usage-card')
})

await t('设置里塞 NaN 汇率 → 退回默认 7.2（不静默算成 ¥0.00）', async () => {
  const capture = []
  const bad = {
    ...ctx,
    settings: { register: () => ({ get: () => ({ fxRate: Number.NaN, showAmount: true, showAttribution: true }) }) },
    webServer: { register: (s) => { capture.push(s); return () => {} } },
  }
  apply(bad)
  listeners.get('session/event')(fakeSession, { type: 'request/header', data: { header: { config: { model: 'deepseek-flash' } } } })
  let body = ''
  await capture[0].handler(
    { url: ROUTE, method: 'GET', headers: { host: '127.0.0.1:3080' } },
    { statusCode: 0, headers: {}, setHeader(n, v) { this.headers[n] = v }, writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}) }, end(chunk) { body += chunk ?? '' } },
  )
  const payload = JSON.parse(body)
  assert.equal(payload.cost.fx.rate, 7.2)
  assert.ok(payload.cost.totalCny > 0)
})

await t('同一投影水位重复请求 → measure() 只调一次（缓存生效）', async () => {
  let calls = 0
  const capture = []
  const ctxC = {
    ...ctx,
    tokenMeter: { measure: () => { calls += 1; return { logRevision: 1, nodes: [] } } },
    sessionProjections: {
      snapshot: () => ({ asOfSeq: 42, values: {
        tokenUsage: { uncachedInputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0, outputTokens: 5 },
        contextBreakdown: { systemTokens: 1, toolsTokens: 1, messageTokens: 1 },
        modelSelection: { lastUsed: { model: 'deepseek-flash' } },
      } }),
    },
    webServer: { register: (s) => { capture.push(s); return () => {} } },
  }
  apply(ctxC)
  listeners.get('session/event')(fakeSession, { type: 'request/header', data: { header: { config: { model: 'deepseek-flash' } } } })
  const hit = async () => {
    let body = ''
    await capture[0].handler(
      { url: ROUTE, method: 'GET', headers: { host: '127.0.0.1:3080' } },
      { statusCode: 0, headers: {}, setHeader() {}, writeHead() {}, end(c) { body += c ?? '' } },
    )
    return JSON.parse(body)
  }
  const a = await hit()
  const b = await hit()
  assert.equal(calls, 1, '第二个同水位请求应命中缓存，measure 不该再跑')
  assert.deepEqual(a.measured, b.measured)
})

await t('水位前进 → 缓存失效并重算', async () => {
  let calls = 0
  let seq = 42
  const capture = []
  const ctxD = {
    ...ctx,
    tokenMeter: { measure: () => { calls += 1; return { logRevision: 1, nodes: [] } } },
    sessionProjections: {
      snapshot: () => ({ asOfSeq: seq, values: {
        tokenUsage: { uncachedInputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0, outputTokens: 5 },
        contextBreakdown: { systemTokens: 1, toolsTokens: 1, messageTokens: 1 },
        modelSelection: { lastUsed: { model: 'deepseek-flash' } },
      } }),
    },
    webServer: { register: (s) => { capture.push(s); return () => {} } },
  }
  apply(ctxD)
  listeners.get('session/event')(fakeSession, { type: 'request/header', data: { header: { config: { model: 'deepseek-flash' } } } })
  const hit = async () => {
    let body = ''
    await capture[0].handler(
      { url: ROUTE, method: 'GET', headers: { host: '127.0.0.1:3080' } },
      { statusCode: 0, headers: {}, setHeader() {}, writeHead() {}, end(c) { body += c ?? '' } },
    )
  }
  await hit(); seq = 43; await hit()
  assert.equal(calls, 2, '水位前进后必须重算')
})

await t('历史回填：session.events 里的老轮次被补进账本（覆盖率不再恒为 1%）', async () => {
  const sessB = {
    header: { id: 'sess-backfill' },
    events: [
      { type: 'request/header', data: { header: { config: { model: 'deepseek-flash' } } } },
      // 2026-09-18 02:00 UTC 落在峰时窗口（01:00-04:00）
      { type: 'assistant/message', time: Date.parse('2026-09-18T02:00:00Z'), data: { usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 } } },
    ],
  }
  const captureB = []
  const ctxB = {
    ...ctx,
    sessions: { get: (id) => (id === 'sess-backfill' ? sessB : undefined) },
    tokenMeter: { measure: () => ({ logRevision: 1, nodes: [] }) },
    sessionProjections: {
      snapshot: () => ({ asOfSeq: 7, values: {
        tokenUsage: { uncachedInputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 },
        contextBreakdown: { systemTokens: 1, toolsTokens: 1, messageTokens: 1 },
        modelSelection: { lastUsed: { model: 'deepseek-flash' } },
      } }),
    },
    webServer: { register: (s) => { captureB.push(s); return () => {} } },
  }
  apply(ctxB)
  let body = ''
  await captureB[0].handler(
    { url: ROUTE + '?session=sess-backfill', method: 'GET', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } },
    { statusCode: 0, headers: {}, setHeader() {}, writeHead() {}, end(c) { body += c ?? '' } },
  )
  const p = JSON.parse(body)
  assert.equal(p.cost.pricing.turns, 1, '回填应记入 1 轮')
  assert.equal(p.cost.pricing.mode, 'per-turn', '总量与回填一致 → 精确模式（不打「含估算」）')
  // 该轮在峰时：0.001M×0.3 + 0.0001M×1.2 = 0.00042
  assert.ok(Math.abs(p.cost.totalUsd - 0.00042) < 1e-9, 'got ' + p.cost.totalUsd)
})

console.log('\n接线全部通过：' + pass + ' 项')
