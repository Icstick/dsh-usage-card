// test/isolation-check.mjs —— M5-b 验收：崩溃隔离（宿主半 + 客户端半）
//
// 两个问题分开验：
//   A. 宿主半：敌意输入 / 坏日志 / 内部异常，能不能只返回原因码，而不是把 dsh web 带崩；
//   B. 客户端半：payload 形状不对时，卡片会不会在渲染期抛出去（那会把宿主界面一起拖下水）。
//
// B 用「迷你渲染器」真的执行组件本体：假 react + 假 slots 捕获注册的组件，拿敌意 payload 渲染，
// 并且实现最小 error-boundary 语义（class 组件的 getDerivedStateFromError + 重渲染）。
// 不是完整 React（不跑 reconciler、不批处理），但足以回答「渲染期会不会抛 / 会不会被边界兜住」。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

let pass = 0
const failures = []
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok  ' + name) }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + ' → ' + (e?.message ?? e)) }
}

// ── A. 宿主半 ────────────────────────────────────────────────────────────────
const { apply, ROUTE, REPORT_ROUTE, SESSIONS_ROUTE } = await import('../src/index.mjs')

const registered = []
const listeners = new Map()
const ctx = {
  webServer: { register: (spec) => { registered.push(spec); return () => {} } },
  sessionProjections: { snapshot: () => ({ values: {
    tokenUsage: { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5 },
    contextBreakdown: { systemTokens: 1, toolsTokens: 1, messageTokens: 1 },
  } }) },
  connection: { requestRejection: () => undefined },
  settings: { register: () => ({ get: () => ({ fxRate: 7.2, showAmount: true, showAttribution: true }) }) },
  on: (n, fn) => { listeners.set(n, fn); return () => {} },
  effect: (fn) => { fn() },
}
apply(ctx)
const handlerOf = (path) => registered.find((r) => r.path === path)?.handler

async function call(path, url, init = {}) {
  let body = ''
  const res = {
    statusCode: 0, headers: {},
    setHeader(n, v) { this.headers[n] = v },
    writeHead(c, hh) { this.statusCode = c; Object.assign(this.headers, hh ?? {}) },
    end(chunk) { body += chunk ?? '' },
  }
  await handlerOf(path)({ url, method: init.method ?? 'GET', headers: init.headers ?? { host: '127.0.0.1:3080' } }, res)
  let json = null
  try { json = body === '' ? null : JSON.parse(body) } catch { /* 报告路由返回的是 Markdown/CSV 文本 */ }
  return { status: res.statusCode, body, json }
}

console.log('宿主半 · 敌意 URL')
await t('超长 session id（4k 字符）→ 原因码，不抛', async () => {
  const r = await call(ROUTE, ROUTE + '?session=' + 'x'.repeat(4096))
  assert.equal(r.status, 200); assert.equal(r.json.ok, false)
})
await t('null 字节 / 控制字符 → 原因码，不抛', async () => {
  const r = await call(ROUTE, ROUTE + '?session=%00%01%02')
  assert.equal(r.status, 200); assert.equal(r.json.ok, false)
})
await t('路径穿越形态 ?session=../../etc/passwd → 不越权读，只报原因码', async () => {
  const r = await call(ROUTE, ROUTE + '?session=..%2F..%2Fetc%2Fpasswd')
  assert.equal(r.status, 200); assert.equal(r.json.ok, false)
})
await t('URL 完全畸形（裸 % / 截断的百分号编码）→ 不抛', async () => {
  for (const u of [ROUTE + '?session=%', ROUTE + '%', ROUTE + '?a=%E4%B8']) {
    const r = await call(ROUTE, u)
    assert.equal(r.status, 200)
  }
})
await t('非 GET → 405（不是 500）', async () => {
  const r = await call(ROUTE, ROUTE, { method: 'POST' })
  assert.equal(r.status, 405)
})

console.log('宿主半 · 坏日志')
const tmp = mkdtempSync(join(tmpdir(), 'usage-card-iso-'))
const prevHome = process.env.DSH_HOME
try {
  mkdirSync(join(tmp, 'sessions', 'proj'), { recursive: true })
  const good = zstdCompressSync(Buffer.from(JSON.stringify({ type: 'assistant/message', time: Date.now(), data: { usage: { inputTokens: 1, outputTokens: 1 } } }) + '\n'))
  writeFileSync(join(tmp, 'sessions', 'proj', 'a-good.zstd'), good)
  writeFileSync(join(tmp, 'sessions', 'proj', 'b-truncated.zstd'), good.subarray(0, Math.max(1, good.length - 3)))
  writeFileSync(join(tmp, 'sessions', 'proj', 'c-garbage.zstd'), Buffer.from('not zstd at all\x00\x01\x02', 'utf8'))
  writeFileSync(join(tmp, 'sessions', 'proj', 'd-empty.zstd'), Buffer.alloc(0))
  writeFileSync(join(tmp, 'sessions', 'proj', 'e-halfjson.zstd'), zstdCompressSync(Buffer.from('{"type":"assistant/message"\n{"broken\n')))
  // 目录本身叫 *.zstd —— listSessionLogs 会把它当文件读，必须只是失败而不是崩
  mkdirSync(join(tmp, 'sessions', 'proj', 'f-directory.zstd'), { recursive: true })

  process.env.DSH_HOME = tmp
  await t('坏日志目录下报告路由仍出 Markdown（不是 500、不抛）', async () => {
    const r = await call(REPORT_ROUTE, REPORT_ROUTE + '?format=md')
    assert.equal(r.status, 200)
    assert.match(r.body, /DSH 用量报告/, 'body 应是报告文本')
  })
  await t('坏日志目录下 CSV 格式同样不抛', async () => {
    const r = await call(REPORT_ROUTE, REPORT_ROUTE + '?format=csv')
    assert.equal(r.status, 200)
    assert.match(r.body, /^scope,name,turns/)
  })
  await t('坏日志目录下会话列表路由仍返回 JSON', async () => {
    const r = await call(SESSIONS_ROUTE, SESSIONS_ROUTE)
    assert.equal(r.status, 200)
  })
} finally {
  if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome
  rmSync(tmp, { recursive: true, force: true })
}

// ── B. 客户端半：迷你渲染器 ─────────────────────────────────────────────────
console.log('客户端半 · 敌意 payload 渲染')
const src = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

let nextState = null
function makeFakeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 0 ? undefined : (children.length === 1 ? children[0] : children) },
  })
  return {
    createElement,
    Component: class { constructor(props) { this.props = props; this.state = {} } },
    useState: (initial) => [nextState === null ? initial : nextState, () => {}],
    useEffect: () => {},
    useSyncExternalStore: () => ({}),
    useRef: (v) => ({ current: v }),
    useCallback: (f) => f,
    useMemo: (f) => f(),
  }
}

/** 最小渲染器：真的执行函数/类组件，并实现 error boundary 的降级语义。 */
function renderNode(node, depth = 0) {
  if (node === null || node === undefined || node === false || node === true) return node
  if (Array.isArray(node)) return node.map((n) => renderNode(n, depth))
  if (typeof node !== 'object') return node
  if (depth > 60) throw new Error('render depth exceeded')
  const { type, props } = node
  if (typeof type === 'string') return { host: type, props, children: renderNode(props.children, depth + 1) }
  const isClass = typeof type === 'function' && type.prototype && typeof type.prototype.render === 'function'
  if (isClass) {
    const inst = new type(props)
    inst.props = props
    try { return renderNode(inst.render(), depth + 1) }
    catch (error) {
      if (typeof type.getDerivedStateFromError !== 'function') throw error
      inst.state = { ...(inst.state ?? {}), ...type.getDerivedStateFromError(error) }
      return renderNode(inst.render(), depth + 1)
    }
  }
  return renderNode(type(props), depth + 1)
}

/** 树上所有文本，用来断言「降级文案真的出来了」而不只是「没抛」。 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node !== 'object') return ''
  return [textOf(node.props?.children), textOf(node.children)].join(' ')
}

const slots = []
const fakeCtx = {
  slots: {
    inject: (name, fn) => { fn({ slots: { register: (spec, comp) => { slots.push({ spec, comp }); return () => {} } } }); return () => {} },
    register: (spec, comp) => { slots.push({ spec, comp }); return () => {} },
  },
  settingsScope: { bind: () => ({ subscribe: () => () => {}, getSnapshot: () => ({}), set: () => {} }) },
}
// 优先跑**构建产物** lib/client.js（那才是真正发出去、真正装在侧栏里的东西）：
// 只跑源码的话，忘了重建 bundle 也能全绿 —— 这正是别的插件踩过的坑。
const bundleSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let clientExports = null
let loadedFrom = null
{
  let captured = null
  new Function('window', bundleSrc)({ __ModuleLoader__: { load: (reg) => { captured = reg } } })
  if (captured && captured.id === 'dsh-usage-card' && typeof captured.factory === 'function') {
    clientExports = captured.factory((name) => (name === 'react' ? makeFakeReact() : {}))
    loadedFrom = 'lib/client.js（构建产物）'
  }
}
if (clientExports === null) {
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', src)((name) => (name === 'react' ? makeFakeReact() : {}), mod, mod.exports)
  clientExports = mod.exports
  loadedFrom = 'client/index.js（源码，未能从 bundle 取到）'
}
console.log('  （渲染对象：' + loadedFrom + '）')
await t('构建产物含本次隔离修复（bundle 不是旧的）', () => {
  assert.match(bundleSrc, /SCHEMA_MISMATCH/, 'lib/client.js 里没有形状闸 → 忘了重建')
  assert.match(bundleSrc, /已隔离/, 'lib/client.js 里没有渲染边界 → 忘了重建')
})
await t('客户端模块可加载且暴露 apply', () => assert.equal(typeof clientExports.apply, 'function'))
clientExports.apply(fakeCtx)
const cardSlot = slots.find((s) => s.spec.id === 'usage-card' && s.spec.name === 'sidebar.footer.action')
await t('卡片组件注册进 sidebar.footer.action', () => assert.ok(cardSlot && typeof cardSlot.comp === 'function'))

/** 渲染一次卡片（宽/窄两态），返回合并后的文本。 */
function renderCard(payload, error) {
  nextState = { loading: false, data: payload, error }
  const wide = renderNode(cardSlot.comp({ wide: true }))
  const narrow = renderNode(cardSlot.comp({ wide: false }))
  return textOf(wide) + ' | ' + textOf(narrow)
}

const EVIL = [
  ['undefined', undefined, undefined],
  ['null', null, undefined],
  ['空对象', {}, undefined],
  ['ok:true 但缺 measured/cost', { ok: true, session: { model: 'deepseek-flash' } }, 'schema'],
  ['ok:true 且 measured 非对象', { ok: true, measured: 42, cost: {}, session: {} }, 'schema'],
  ['ok:true 且 cost 为 null', { ok: true, measured: { totalTokens: 1 }, cost: null, session: {} }, 'schema'],
  ['ok:true 且 totalTokens 不是数', { ok: true, measured: { totalTokens: 'x' }, cost: {}, session: {} }, 'schema'],
  ['attribution.rows 非数组', { ok: true, measured: { totalTokens: 1 }, cost: { totalCny: 0, pricing: {} }, session: {}, attribution: { rows: 'nope' } }, 'ok'],
  ['subagents 非对象', { ok: true, measured: { totalTokens: 1 }, cost: { totalCny: 0, pricing: {} }, session: {}, subagents: 7 }, 'ok'],
  ['reason 是对象（toString 为 null）', { ok: false, reason: { toString: null } }, 'degraded'],
  ['reason 是数字', { ok: false, reason: 42 }, 'degraded'],
  ['自引用对象', (() => { const o = { ok: true }; o.self = o; return o })(), 'schema'],
  ['measured 取值即抛（形状闸挡不住，必须靠边界）', { ok: true, measured: { get totalTokens() { throw new Error('boom') } }, cost: {} }, 'boundary'],
]

for (const [label, payload, expect] of EVIL) {
  await t('渲染不抛：' + label, () => {
    const text = renderCard(payload)
    assert.ok(text.length > 0, '应该有输出')
    if (expect === 'schema') assert.match(text, /不认识|渲染失败/, '应报结构不认识：' + text.slice(0, 80))
    if (expect === 'degraded') assert.match(text, /不可用/, '应走降级文案：' + text.slice(0, 80))
    if (expect === 'boundary') assert.match(text, /已隔离/, '应由渲染边界兜住：' + text.slice(0, 80))
  })
}

await t('fetch 失败（error 有值、data 为 undefined）→ FETCH_FAILED 文案', () => {
  const text = renderCard(undefined, 'NetworkError')
  assert.match(text, /宿主路由不可达/)
})

console.log('')
if (failures.length > 0) {
  console.log('崩溃隔离验收：失败 ' + failures.length + ' 项 —— ' + failures.join(' / '))
  process.exit(1)
}
console.log('崩溃隔离验收：通过 ' + pass + ' 项')
