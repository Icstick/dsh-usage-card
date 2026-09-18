// test/wiring-check.mjs —— 接线验证（不启动 dsh web）
// dev-lessons 第 21 条的教训：模块级测试全绿但接线从未插入 = 假绿。
// 这里真的调 apply(ctx)，检验：路由注册到了预期路径、handler 返回可解析的 JSON、事件被跟踪。
import assert from 'node:assert/strict'
import { apply, ROUTE } from '../src/index.mjs'

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
  // settings 接缝：注册后返回作用域，可读取
  settings: { register: () => ({ get: () => ({ fxRate: 7.2, showAmount: true, showAttribution: true }) }) },
  on: (name, fn) => { listeners.set(name, fn); return () => { listeners.delete(name) } },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') effects.push(d) },
}

console.log('接线')
t('apply 可调用且不抛', () => apply(ctx))
t('路由注册到预期路径（exact）', () => {
  assert.equal(registered.length, 1)
  assert.equal(registered[0].path, ROUTE)
  assert.equal(registered[0].kind, 'exact')
  assert.equal(typeof registered[0].handler, 'function')
})
t('订阅了 session/event', () => assert.ok(listeners.has('session/event')))

t('注册了可回收的 effect（卸载不泄漏）', () => assert.ok(effects.length >= 2 && effects.every((f) => typeof f === 'function')))

console.log('路由行为')
const handler = registered[0].handler
async function call() {
  let body = ''
  const res = { statusCode: 0, headers: null, writeHead(code, headers) { this.statusCode = code; this.headers = headers }, end(chunk) { body += chunk } }
  await handler({ url: ROUTE, method: 'GET' }, res)
  return { status: res.statusCode, headers: res.headers, json: JSON.parse(body) }
}

t('无事件时返回 NO_SESSION（不是 500，也不是 0）', async () => {
  const r = await call()
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, 'NO_SESSION')
})
t('收到事件后返回真实 payload', async () => {
  listeners.get('session/event')(fakeSession, { type: 'request/header', data: { header: { config: { model: 'deepseek-flash' } } } })
  const r = await call()
  assert.equal(r.json.ok, true)
  assert.equal(r.json.session.model, 'deepseek-flash')
  assert.equal(r.json.measured.totalTokens, 1000 + 9000 + 500)
})
t('响应头是 JSON 且禁缓存', async () => {
  const r = await call()
  assert.match(r.headers['Content-Type'], /application\/json/)
  assert.equal(r.headers['Cache-Control'], 'no-store')
})
t('handler 抛错也被兜住（返回 INTERNAL 而不是崩宿主）', () => {
  const bad = { ...ctx, sessionProjections: { snapshot: () => { throw new Error('boom') } } }
  const capture = []
  const c2 = { ...bad, webServer: { register: (s) => { capture.push(s); return () => {} } } }
  apply(c2)
  // 新实例有自己的闭包，必须先喂一个事件它才知道「当前会话」是哪个
  listeners.get('session/event')(fakeSession, { type: 'request/header', data: { header: { config: { model: 'deepseek-flash' } } } })
  let body = ''
  capture[0].handler({}, { writeHead() {}, end(chunk) { body += chunk } })
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
  await capture2[0].handler({ url }, { writeHead() {}, end(chunk) { body += chunk } })
  return JSON.parse(body)
}
t('带 ?session= 时按该会话取数（而不是「最近有事件」的那个）', async () => {
  const p = await call2(ROUTE + '?session=sess-other')
  assert.equal(p.ok, true)
  assert.equal(p.session.id, 'sess-other')
  assert.equal(p.measured.totalTokens, 7 + 3 + 1)
})
t('不带 session 时退回最近事件会话', async () => {
  const p = await call2(ROUTE)
  assert.equal(p.session.id, 'sess-wiring')
  assert.equal(p.measured.totalTokens, 10500)
})
t('会话解析不到 → SESSION_NOT_LOADED（不显示别人的数字）', async () => {
  const p = await call2(ROUTE + '?session=does-not-exist')
  assert.equal(p.ok, false)
  assert.equal(p.reason, 'SESSION_NOT_LOADED')
  assert.equal(p.measured, undefined)
})

console.log('设置接缝')
// 注意：探针必须在最后跑 —— 它复用了同一个 listeners Map，会把前面实例的监听器顶掉
t('注册了设置命名空间（供设置页读写）', () => {
  let registeredNs = null
  const probe = {
    ...ctx,
    settings: { register: (ns) => { registeredNs = ns; return { get: () => ({ fxRate: 7.2, showAmount: true, showAttribution: true }) } } },
  }
  apply(probe)
  assert.equal(registeredNs, 'dsh-usage-card')
})

console.log('\n接线全部通过：' + pass + ' 项')
