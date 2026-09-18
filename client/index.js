// client/index.js —— dsh-usage-card 侧栏卡片（bundle-ready CJS 风格源码）。
//
// 构建：node scripts/build-client.mjs → lib/client.js（window.__ModuleLoader__.load 闭包）
// 挂载：sidebar.footer.action（list slot，渲染在「设置」按钮正上方）
// 取数：3 秒轮询宿主只读路由 /usage-card/current.json（宿主算，客户端只显示）
//
// 样式用「主题无关」的中性 rgba，不依赖具体主题 token，深色/浅色都不至于看不见。
// React 无顶层 h（那是 preact 的 API）：createElement 起别名 h。

const { createElement: h, useState, useEffect, useSyncExternalStore } = require('react')

const ROUTE = '/usage-card/current.json'
const POLL_MS = 3000

// 侧栏槽位（sidebar.footer.action）只拿到 { wide }，没有会话上下文；而
// conversation.composer.dock 是 session 作用域槽位，运行时 props 带会话身份。
// 于是在那儿放一个隐形信标，把「当前正在看的会话 id」写进这个模块变量，
// 侧栏卡片取数时带上它 —— 否则卡片会显示「最近有事件的会话」（后台会话/子代理会把它带跑）。
let ACTIVE_SESSION = null

/** 类别 → 颜色；未列出的类别用兜底色。 */
const COLORS = {
  system: '#6b78d6',
  toolsSchema: '#5b9bd5',
  messages: '#35c46a',
  user: '#f0a020',
  inject: '#e05c8a',
  toolResult: '#35c46a',
  assistant: '#4c8dff',
}

/** 每行的悬停说明：让「历史回复」这类容易误解的类目自己解释清楚。 */
const HINTS = {
  system: '人格与规则（系统提示），每轮都发',
  toolsSchema: '工具定义（信封里的 tools），每轮都发',
  user: '你在输入框里打的字',
  inject: '宿主注入的环境信息（runtime context / 记忆召回 / 工作状态等），不是你写的',
  toolResult: '工具与命令的返回内容',
  assistant: '我（AI）之前几轮的回复——每轮都要重发，所以一直占着上下文',
  messages: '其余消息',
  other: '未归类的节点',
}

const MUTED = 'rgba(140,146,156,1)'
const HAIRLINE = 'rgba(127,127,127,.22)'
const CARD_BG = 'rgba(127,127,127,.10)'

/** 轮询宿主 payload；返回 { loading, data, error }。 */
function usePayload() {
  const [state, setState] = useState({ loading: true })
  useEffect(() => {
    let alive = true
    let timer = null
    const tick = () => {
      const url = ACTIVE_SESSION ? ROUTE + '?session=' + encodeURIComponent(ACTIVE_SESSION) : ROUTE
      fetch(url, { cache: 'no-store' })
        .then((res) => res.json())
        .then((data) => { if (alive) setState({ loading: false, data }) })
        .catch((error) => { if (alive) setState({ loading: false, error: String((error && error.message) || error) }) })
        .then(() => { if (alive) timer = setTimeout(tick, POLL_MS) })
    }
    tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [])
  return state
}

/** 紧凑数字：1.2M / 96.3k / 921。 */
function fmtCount(n) {
  if (n == null) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k'
  return String(n)
}

function fmtExact(n) {
  return n == null ? '—' : n.toLocaleString('en-US')
}

function fmtCny(v) {
  if (v == null) return '—'
  if (v > 0 && v < 0.005) return '<¥0.01'
  return '¥' + v.toFixed(2)
}

function fmtPct(v) {
  return v == null ? '—' : (v * 100).toFixed(1) + '%'
}

/** 折叠态：一个环，外圈＝缓存命中率。 */
function Ring(props) {
  const { data } = props
  const rate = data && data.ok ? data.measured.cacheHitRate : null
  const p = rate == null ? 0 : Math.max(0, Math.min(1, rate))
  const len = 2 * Math.PI * 13.5
  const title = data && data.ok
    ? '本会话 ' + fmtCny(data.cost.totalCny) + ' · ' + fmtCount(data.measured.totalTokens) + ' tok · 命中 ' + fmtPct(rate)
    : '用量卡片：暂无数据'
  return h('div', {
    title,
    style: { position: 'relative', width: '34px', height: '34px', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  },
    h('svg', { viewBox: '0 0 34 34', width: 34, height: 34, style: { position: 'absolute', inset: 0, transform: 'rotate(-90deg)' } },
      h('circle', { cx: 17, cy: 17, r: 13.5, fill: 'none', stroke: HAIRLINE, strokeWidth: 3 }),
      h('circle', {
        cx: 17, cy: 17, r: 13.5, fill: 'none', stroke: '#35c46a', strokeWidth: 3, strokeLinecap: 'round',
        strokeDasharray: (len * p).toFixed(1) + ' ' + len.toFixed(1),
      })),
    h('span', { style: { fontSize: '9px', color: '#35c46a', fontVariantNumeric: 'tabular-nums' } }, p > 0 ? Math.round(p * 100) + '%' : '—'))
}

/** 展开态：金额 + 四桶 + 占比条 + 逐项。 */
function Card(props) {
  const { data } = props
  const box = {
    background: CARD_BG, border: '1px solid ' + HAIRLINE, borderRadius: '9px',
    padding: '9px 10px', fontSize: '11px', lineHeight: 1.5, color: 'inherit',
  }
  const rowStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }
  const muted = { color: MUTED, fontSize: '11px' }
  const mono = { fontVariantNumeric: 'tabular-nums' }

  if (!data || data.ok !== true) {
    const reason = data && data.reason ? data.reason : (props.error ? 'FETCH_FAILED' : 'LOADING')
    const text = {
      LOADING: '正在读取…', NO_SESSION: '等待首个会话事件', NO_USAGE_YET: '本会话还没产生用量',
      PROJECTION_UNAVAILABLE: '投影服务不可用', FETCH_FAILED: '宿主路由不可达',
    }[reason] || ('不可用：' + reason)
    return h('div', { style: box },
      h('div', { style: rowStyle }, h('span', { style: muted }, '本会话用量'), h('span', { style: muted }, text)))
  }

  const m = data.measured
  const c = data.cost
  const attr = data.attribution
  const rows = attr && attr.rows ? attr.rows : []
  // 显示开关来自设置页；缺省（老 payload）按显示处理
  const showAmount = !data.display || data.display.showAmount !== false
  const showAttr = !data.display || data.display.showAttribution !== false

  return h('div', { style: box },
    h('div', { style: rowStyle },
      h('span', { style: muted }, '本会话用量'),
      h('span', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } },
        h('span', { style: { ...muted, ...mono } }, fmtCount(m.totalTokens) + ' tok'),
        showAmount ? h('span', { style: { fontSize: '13px', fontWeight: 600, ...mono } }, fmtCny(c.totalCny)) : null)),

    h('div', { style: { display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr', gap: '2px 8px', marginTop: '7px' } },
      h('span', { style: muted }, '输入未命中'), h('span', { style: mono }, fmtExact(m.uncachedInputTokens)),
      h('span', { style: muted }, '输出'), h('span', { style: mono }, fmtExact(m.outputTokens)),
      h('span', { style: muted }, '缓存命中'), h('span', { style: { color: '#35c46a', ...mono } }, fmtExact(m.cacheReadTokens)),
      h('span', { style: muted }, '命中率'), h('span', { style: { color: '#35c46a', ...mono } }, fmtPct(m.cacheHitRate))),

    c.unpriced && showAmount ? h('div', { style: { ...muted, marginTop: '6px' } },
      '当前模型未定价（' + (data.session.model || '未知') + '），金额不计入') : null,

    (attr == null || !showAttr) ? null : h('div', null,
      h('div', { style: { height: '1px', background: HAIRLINE, margin: '9px 0 7px' } }),
      h('div', { style: rowStyle },
        h('span', { style: muted }, '上下文占比 · ' + fmtCount(attr.totalTokens)),
        h('span', { style: { ...muted, border: '1px solid ' + HAIRLINE, borderRadius: '4px', padding: '0 4px' } }, '估算')),

      h('div', { style: { display: 'flex', height: '9px', borderRadius: '5px', overflow: 'hidden', background: HAIRLINE, margin: '7px 0 8px' } },
        rows.map((r) => h('div', {
          key: r.key,
          title: r.label + ' ' + fmtPct(r.share),
          style: { width: ((r.share || 0) * 100) + '%', background: COLORS[r.key] || '#8a8f98' },
        }))),

      h('div', null, rows.map((r) => h('div', {
        key: r.key,
        style: { display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '3px 10px' },
      },
        h('span', { title: HINTS[r.key] || '', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
          h('i', { style: { display: 'inline-block', width: '6px', height: '6px', borderRadius: '2px', background: COLORS[r.key] || '#8a8f98', marginRight: '6px' } }),
          r.label),
        h('span', { style: { color: MUTED, textAlign: 'right', minWidth: '38px', ...mono } }, fmtPct(r.share)),
        h('span', { style: { textAlign: 'right', minWidth: '48px', ...mono } }, fmtCny(r.costCny))))),

      attr.pending || attr.fallbackReason
        ? h('div', { style: { ...muted, marginTop: '6px' } }, attr.pending || ('退回内核三元：' + attr.fallbackReason))
        : null),

    data.subagents && data.subagents.count > 0 ? h('div', { style: { borderTop: '1px solid ' + HAIRLINE, marginTop: '8px', paddingTop: '7px' } },
      h('div', { style: rowStyle },
        h('span', { style: muted }, 'subagent · ' + data.subagents.count + ' 个'),
        h('span', { style: mono }, fmtCount(data.subagents.tokens) + ' tok · ' + fmtCny(data.subagents.costCny)))) : null)
}

/** 设置页 namespace，必须与宿主侧 SETTINGS_NAMESPACE 一致。 */
const NS = 'dsh-usage-card'

/** 设置项定义（顺序即渲染顺序）。留空 = 用设计默认值。 */
const FIELDS = [
  { name: 'fxRate', label: '汇率（USD → CNY）', hint: '卡片金额 = 美元金额 × 本汇率。默认 7.2，改完立即生效（无需重启）。', type: 'number', step: '0.01', min: '0.01' },
  { name: 'showAmount', label: '显示金额', hint: '若同时装了其它显示金额的插件，可关掉本卡片的金额避免两处口径并存。', type: 'toggle' },
  { name: 'showAttribution', label: '显示上下文占比', hint: '关掉后卡片只保留用量与金额。', type: 'toggle' },
]

/** 数字草稿解析：非法返回 undefined（不写盘）。 */
function parseNumber(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  const n = Number(text)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * 设置页 section 组件工厂（自包含：闭包捕获 bound scope）。
 * @param {object} scope - ctx.settingsScope.bind({ namespace })
 */
function makeSettingsSection(scope) {
  return function UsageCardSettings() {
    const snapshot = useSyncExternalStore((cb) => scope.subscribe(cb), () => scope.getSnapshot())
    const value = snapshot && typeof snapshot.value === 'object' && snapshot.value !== null ? snapshot.value : {}
    const userLayer = snapshot && typeof snapshot.user === 'object' && snapshot.user !== null ? snapshot.user : {}
    const writable = snapshot ? snapshot.writable === true : false
    const [draft, setDraft] = useState(null)
    const [saving, setSaving] = useState(false)
    const [failed, setFailed] = useState(false)

    const save = (patch) => {
      setSaving(true)
      setFailed(false)
      Promise.resolve(scope.update(patch))
        .then(() => { setSaving(false); setDraft(null) })
        .catch(() => { setSaving(false); setFailed(true) })
    }

    const label = { fontSize: '12px', color: MUTED }
    const input = {
      background: 'transparent', color: 'inherit', border: '1px solid ' + HAIRLINE,
      borderRadius: '6px', padding: '4px 8px', fontSize: '12px', width: '110px',
    }

    return h('div', { style: { padding: '2px' } },
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', paddingBottom: '8px', borderBottom: '1px solid ' + HAIRLINE } },
        h('span', { style: { fontWeight: 600, fontSize: '15px' } }, '用量卡片'),
        h('span', { style: label }, '本会话费用、四桶用量与上下文占比')),
      h('p', { style: { ...label, margin: '8px 0' } }, '留空的项采用设计默认值；本页改动立即生效，不需要重启。'),
      !writable ? h('p', { role: 'status', style: { ...label, color: '#b45309' } }, '当前配置文档不可写（只读模式）') : null,

      FIELDS.map((field) => {
        const overridden = userLayer[field.name] !== undefined
        const current = value[field.name]
        return h('div', { key: field.name, style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 0' } },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: '12px' } }, field.label, overridden ? h('span', { style: { ...label, marginLeft: '6px' } }, '（已覆盖）') : null),
            h('div', { style: { ...label, marginTop: '2px' } }, field.hint)),
          field.type === 'toggle'
            ? h('input', {
                type: 'checkbox', checked: current === true, disabled: !writable || saving,
                onChange: (event) => { save({ [field.name]: event.target.checked }) },
              })
            : h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                h('input', {
                  type: 'number', step: field.step, min: field.min, style: input,
                  disabled: !writable || saving,
                  value: draft === null ? String(current === undefined ? '' : current) : draft,
                  onChange: (event) => { setDraft(event.target.value) },
                  onBlur: () => {
                    if (draft === null) return
                    const parsed = parseNumber(draft)
                    if (parsed === undefined) { setFailed(true); return }
                    save({ [field.name]: parsed })
                  },
                  onKeyDown: (event) => { if (event.key === 'Enter') { event.currentTarget.blur() } },
                }),
                saving ? h('span', { style: label }, '保存中…') : null,
                failed ? h('span', { style: { ...label, color: '#b91c1c' } }, '保存失败（数值需为正数）') : null))
      }),

      h('p', { style: { ...label, marginTop: '10px', paddingTop: '8px', borderTop: '1px solid ' + HAIRLINE } },
        '价格表随插件内置（DeepSeek 官方页驱动，含峰谷）。需要覆盖单价时改 src/prices.json。'))
  }
}

/** 隐形信标：只干一件事——把当前会话 id 记进模块变量。渲染 null。 */
function SessionBeacon(props) {
  const id = (props && props.sessionId) || null
  useEffect(() => {
    ACTIVE_SESSION = id
    return () => { if (ACTIVE_SESSION === id) ACTIVE_SESSION = null }
  }, [id])
  return null
}

/** 槽位组件：按 wide 切换折叠/展开两态。 */
function UsageCardSlot(props) {
  const state = usePayload()
  const wide = !!(props && props.wide)
  const data = state.data
  return wide
    ? h(Card, { data, error: state.error })
    : h(Ring, { data })
}

/** client 插件入口：侧栏卡片 + 会话信标 + 设置页 section。 */
function apply(ctx) {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'usage-card', order: 50 },
    UsageCardSlot,
  ))
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'usage-card-beacon', order: 99 },
    SessionBeacon,
  ))
  // 设置页 section（settingsScope 由 ui-settings 提供；缺席时跳过而不是崩）
  if (ctx.settingsScope && typeof ctx.settingsScope.bind === 'function') {
    const scope = ctx.settingsScope.bind({ namespace: NS })
    ctx.slots.inject('settings.section', () => ctx.slots.register(
      { name: 'settings.section', id: 'usage-card', order: 170, label: '用量卡片' },
      makeSettingsSection(scope),
    ))
  }
}

exports.inject = ['slots', 'settingsScope']
// build.mjs 模板注入 exports.apply
exports.apply = apply
