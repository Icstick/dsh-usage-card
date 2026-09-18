window.__ModuleLoader__.load({
	id: "dsh-usage-card",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
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
		/** 单次请求超时：超了就报错重试，不要让卡片冻在旧数据上。 */
		const FETCH_TIMEOUT_MS = 8000
		
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
		      // 超时是必须的：没有它，一次挂起的请求会让 timer 永不被赋值，
		      // 卡片就冻在旧数据上且不报错 —— 静默失效比报错更糟。
		      const ctl = typeof AbortController === 'function' ? new AbortController() : null
		      const timeout = setTimeout(() => { if (ctl) ctl.abort() }, FETCH_TIMEOUT_MS)
		      fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
		        .then((res) => {
		          if (!res.ok) throw new Error('HTTP ' + res.status)
		          return res.json()
		        })
		        .then((data) => { if (alive) setState({ loading: false, data }) })
		        .catch((error) => { if (alive) setState({ loading: false, error: String((error && error.message) || error) }) })
		        .then(() => { clearTimeout(timeout); if (alive) timer = setTimeout(tick, POLL_MS) })
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
		  const money = data && data.ok && (!data.display || data.display.showAmount !== false) ? fmtCny(data.cost.totalCny) : null
		  return h('div', {
		    title,
		    style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' },
		  },
		    h('div', {
		      style: { position: 'relative', width: '34px', height: '34px', display: 'flex', alignItems: 'center', justifyContent: 'center' },
		    },
		    h('svg', { viewBox: '0 0 34 34', width: 34, height: 34, style: { position: 'absolute', inset: 0, transform: 'rotate(-90deg)' } },
		      h('circle', { cx: 17, cy: 17, r: 13.5, fill: 'none', stroke: HAIRLINE, strokeWidth: 3 }),
		      h('circle', {
		        cx: 17, cy: 17, r: 13.5, fill: 'none', stroke: '#35c46a', strokeWidth: 3, strokeLinecap: 'round',
		        strokeDasharray: (len * p).toFixed(1) + ' ' + len.toFixed(1),
		      })),
		    h('span', { style: { fontSize: '9px', color: '#35c46a', fontVariantNumeric: 'tabular-nums' } }, p > 0 ? Math.round(p * 100) + '%' : '—')),
		    // 折叠态在环下面带一个极小金额（用 0.1 的透明度做底，不抢眼）
		    money === null ? null : h('span', { style: { fontSize: '9px', color: MUTED, fontVariantNumeric: 'tabular-nums' } }, money))
		}
		
		/** 展开态：金额 + 四桶 + 占比条 + 逐项。 */
		function Card(props) {
		  const { data } = props
		  // width/boxSizing 必须显式给：sidebar.footer.action 用 display:flex 承载占位者，
		  // 不写 width 的话卡片按内容宽度收缩，侧栏拉宽时不会跟着扩展。
		  const box = {
		    background: CARD_BG, border: '1px solid ' + HAIRLINE, borderRadius: '9px',
		    padding: '9px 10px', fontSize: '11px', lineHeight: 1.5, color: 'inherit',
		    width: '100%', boxSizing: 'border-box', minWidth: 0,
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
		        // 估算口径不再在卡片上贴标签（按用户要求收到设置页说明）；
		        // 但悬停仍给出来源，免得数字看起来比实际更确定。
		        showAmount ? h('span', {
		          title: c.pricing && c.pricing.mode !== 'per-turn'
		            ? '含估算：插件加载前的轮次按当前档位线性估算，加载后按每轮实际时刻定价（覆盖 ' + Math.round((c.pricing.coverage || 0) * 100) + '%）'
		            : '全部轮次按各自时刻定价（精确）',
		          style: { fontSize: '13px', fontWeight: 600, ...mono },
		        }, fmtCny(c.totalCny)) : null)),
		
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
		
		    // 导出入口已移到设置页的「用量卡片」tab（那里可勾选会话），卡片上不再重复放
		    (data.subagents && (data.subagents.count > 0 || data.subagents.unavailable)) ? h('div', { style: { borderTop: '1px solid ' + HAIRLINE, marginTop: '8px', paddingTop: '7px' } },
		      h('div', { style: rowStyle },
		        h('span', { style: muted },
		          'subagent · ' + data.subagents.count + ' 个',
		          data.subagents.released > 0 ? h('span', { style: { marginLeft: '4px' } }, '(实测 ' + data.subagents.measured + ')') : null),
		        h('span', { style: { display: 'flex', gap: '6px', alignItems: 'baseline' } },
		          h('span', { style: { ...muted, ...mono } }, data.subagents.tokens == null ? '—' : fmtCount(data.subagents.tokens) + ' tok'),
		          showAmount ? h('span', { style: mono }, data.subagents.costCny == null ? '—' : fmtCny(data.subagents.costCny)) : null,
		          h('span', { style: { ...muted, border: '1px solid ' + HAIRLINE, borderRadius: '4px', padding: '0 4px' } }, '实测'))),
		
		      // 只给合计，不分条列明细 —— 子代理一多会把卡片撑很长。
		      // payload 里仍然带 items（供 M5 导出与后续明细页使用），只是不在这里渲染。
		      h('div', { style: { ...muted, marginTop: '4px' } },
		        data.subagents.released > 0
		          ? data.subagents.released + ' 个已释放（未计入合计）'
		          : '独立会话（未计入合计）'),
		      data.subagents.unavailable
		        ? h('div', { style: { ...muted, marginTop: '4px', color: '#b45309' } }, '子代理统计不可用：' + data.subagents.unavailable)
		        : null) : null)
		}
		
		/** 设置页 namespace，必须与宿主侧 SETTINGS_NAMESPACE 一致。 */
		const NS = 'dsh-usage-card'
		
		/** 设置项定义（顺序即渲染顺序）。留空 = 用设计默认值。 */
		const FIELDS = [
		  { name: 'fxRate', label: '汇率（USD → CNY）', hint: '卡片金额 = 美元金额 × 本汇率。默认 7.2，改完立即生效（无需重启）。', type: 'number', step: '0.01', min: '0.01' },
		  { name: 'showAmount', label: '显示金额', hint: '若同时装了其它显示金额的插件，可关掉本卡片的金额避免两处口径并存。', type: 'toggle' },
		  { name: 'showAttribution', label: '显示上下文占比', hint: '关掉后卡片只保留用量与金额。', type: 'toggle' },
		]
		
		/**
		 * 导出链接：全选或未选时省略 sessions 参数（服务端语义「全部」）。
		 * @param selected - 已勾选的会话 id
		 * @param sessions - 会话列表
		 * @param format - 'md' | 'csv'
		 */
		function exportHref(selected, sessions, format) {
		  const base = '/usage-card/report?format=' + format
		  if (sessions === null || selected.length === 0 || selected.length === sessions.length) return base
		  return base + '&sessions=' + encodeURIComponent(selected.join(','))
		}
		
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
		    // 导出：会话列表 + 勾选
		    const [sessions, setSessions] = useState(null)
		    const [selected, setSelected] = useState([])
		    const [listError, setListError] = useState(null)
		    const [withSubagents, setWithSubagents] = useState(false)
		    const [syncing, setSyncing] = useState(false)
		    const [syncMsg, setSyncMsg] = useState(null)
		    const [prices, setPrices] = useState(null)
		    const [priceSyncing, setPriceSyncing] = useState(false)
		    const [priceMsg, setPriceMsg] = useState(null)
		    const loadPrices = () => {
		      fetch('/usage-card/sync-prices', { cache: 'no-store' })
		        .then((r) => r.json())
		        .then((d) => { setPrices(d && d.ok ? d : null) })
		        .catch(() => setPrices(null))
		    }
		    useEffect(() => { loadPrices() }, [])
		    useEffect(() => {
		      let alive = true
		      setSessions(null)
		      fetch('/usage-card/sessions' + (withSubagents ? '?subagents=1' : ''), { cache: 'no-store' })
		        .then((r) => r.json())
		        .then((d) => {
		          if (!alive) return
		          if (d && d.ok) { setSessions(d.sessions || []); setSelected((d.sessions || []).map((s) => s.id)) }
		          else setListError((d && d.reason) || '加载失败')
		        })
		        .catch((e) => { if (alive) setListError(String((e && e.message) || e)) })
		      return () => { alive = false }
		    }, [withSubagents])
		
		    /** 手动同步汇率：拉一次实时价写进设置。 */
		    const syncFx = () => {
		      setSyncing(true)
		      setSyncMsg(null)
		      fetch('/usage-card/sync-fx', { method: 'POST' })
		        .then((r) => r.json())
		        .then((d) => {
		          setSyncing(false)
		          setSyncMsg(d && d.ok ? '已同步 ' + Number(d.rate).toFixed(4) + '（' + d.source + '）' : '同步失败：' + ((d && d.reason) || '未知原因'))
		        })
		        .catch((e) => { setSyncing(false); setSyncMsg('同步失败：' + String((e && e.message) || e)) })
		    }
		
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
		      h('p', { style: { ...label, margin: '0 0 8px' } }, '金额按每轮的时段计价；插件加载前的轮次为估算（悬停卡片金额可看覆盖比例）。上下文占比一律是估算。'),
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
		                field.name === 'fxRate' ? h('button', {
		                  type: 'button',
		                  disabled: !writable || syncing,
		                  style: { ...input, width: 'auto', cursor: 'pointer' },
		                  title: '从公开汇率接口拉取 USD→CNY 当前价并写入设置',
		                  onClick: syncFx,
		                }, syncing ? '同步中…' : '同步') : null,
		                saving ? h('span', { style: label }, '保存中…') : null,
		                failed ? h('span', { style: { ...label, color: '#b91c1c' } }, '保存失败（数值需为正数）') : null))
		      }),
		
		      syncMsg === null ? null : h('p', { style: { ...label, margin: '0 0 6px' } }, syncMsg),
		
		      // ---- 费用（价目）----
		      h('div', { style: { marginTop: '12px', paddingTop: '10px', borderTop: '1px solid ' + HAIRLINE } },
		        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
		          h('span', { style: { fontSize: '12px', fontWeight: 600 } }, '费用价目'),
		          h('span', { style: label },
		            prices === null ? '读取中…'
		              : (prices.source === 'bundled' ? '内置价表' : '官方同步') + ' · ' + (prices.checkedAt || '-'))),
		        h('p', { style: { ...label, margin: '4px 0 8px' } }, '单价为 美元/百万 token，顺序：缓存命中 / 未命中 / 输出。峰价 = 谷价 ×2。'),
		
		        prices === null ? null : h('div', { style: { border: '1px solid ' + HAIRLINE, borderRadius: '6px', padding: '6px 8px' } },
		          Object.keys(prices.models).map((name) => h('div', { key: name, style: { fontSize: '11px', lineHeight: 1.7 } },
		            h('span', { style: { fontWeight: 600 } }, name),
		            h('span', { style: { ...label, marginLeft: '8px' } },
		              '谷 ' + prices.models[name].offPeak.cacheHit + ' / ' + prices.models[name].offPeak.cacheMiss + ' / ' + prices.models[name].offPeak.output
		              + (prices.models[name].peak ? '　峰 ' + prices.models[name].peak.cacheHit + ' / ' + prices.models[name].peak.cacheMiss + ' / ' + prices.models[name].peak.output : '　峰 -'))))),
		
		        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px', flexWrap: 'wrap' } },
		          h('button', {
		            type: 'button', disabled: !writable || priceSyncing,
		            style: { ...input, width: 'auto', cursor: 'pointer' },
		            title: '从 DeepSeek 官方定价页抓取当前价目（含峰谷），解析结果不合理则不落盘',
		            onClick: () => {
		              setPriceSyncing(true)
		              setPriceMsg(null)
		              fetch('/usage-card/sync-prices', { method: 'POST' })
		                .then((r) => r.json())
		                .then((d) => {
		                  setPriceSyncing(false)
		                  if (d && d.ok) { setPriceMsg('已同步 ' + d.models.join(', ') + '（' + d.checkedAt + '）'); loadPrices() }
		                  else setPriceMsg('同步失败：' + ((d && d.reason) || '未知') + (d && d.detail ? '（' + d.detail + '）' : ''))
		                })
		                .catch((e) => { setPriceSyncing(false); setPriceMsg('同步失败：' + String((e && e.message) || e)) })
		            },
		          }, priceSyncing ? '同步中…' : '同步官方价目'),
		          h('a', { href: prices === null ? '#' : prices.url, target: '_blank', rel: 'noreferrer', style: { ...label, textDecoration: 'none' } }, '打开官方定价页')),
		        priceMsg === null ? null : h('p', { style: { ...label, margin: '6px 0 0' } }, priceMsg)),
		
		      // ---- 导出报告 ----
		      h('div', { style: { marginTop: '12px', paddingTop: '10px', borderTop: '1px solid ' + HAIRLINE } },
		        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
		          h('span', { style: { fontSize: '12px', fontWeight: 600 } }, '导出报告'),
		          h('label', { style: { ...label, display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' } },
		            h('input', { type: 'checkbox', checked: withSubagents, onChange: (e) => setWithSubagents(e.target.checked) }),
		            '包含子代理会话'),
		          h('span', { style: label },
		            sessions === null ? '正在读取会话…'
		              : listError !== null ? '读取失败：' + listError
		                : '已选 ' + selected.length + ' / ' + sessions.length + ' 个会话' + (selected.length === 0 ? '（不选=全部）' : ''))),
		
		        h('p', { style: { ...label, margin: '4px 0 8px' } }, '报告直接读本机会话日志生成；勾选的会话会被合并成一份。'),
		
		        sessions !== null && listError === null && sessions.length > 0 ? h('div', {
		          style: { maxHeight: '200px', overflowY: 'auto', border: '1px solid ' + HAIRLINE, borderRadius: '6px', padding: '4px 8px' },
		        }, sessions.map((s) => h('label', {
		          key: s.id,
		          title: s.id,
		          style: { display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: '2px 8px', alignItems: 'center', padding: '3px 0', fontSize: '11px', cursor: 'pointer' },
		        },
		          h('input', { type: 'checkbox', checked: selected.includes(s.id), onChange: () => setSelected((prev) => (prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id])) }),
		          h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
		            s.depth > 0 ? '↳ ' : '',
		            s.title || s.id.slice(0, 22)),
		          h('span', { style: { color: MUTED, textAlign: 'right', minWidth: '54px', fontVariantNumeric: 'tabular-nums' } }, s.turns + ' 轮'),
		          h('span', { style: { textAlign: 'right', minWidth: '62px', fontVariantNumeric: 'tabular-nums' } }, '¥' + s.cny.toFixed(2))))) : null,
		
		        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px', flexWrap: 'wrap' } },
		          sessions !== null && sessions.length > 0 ? h('button', {
		            type: 'button',
		            style: { ...input, width: 'auto', cursor: 'pointer' },
		            onClick: () => setSelected(selected.length === sessions.length ? [] : sessions.map((s) => s.id)),
		          }, selected.length === sessions.length ? '全不选' : '全选') : null,
		          h('a', {
		            href: exportHref(selected, sessions, 'md'), target: '_blank', rel: 'noreferrer',
		            style: { ...input, width: 'auto', textDecoration: 'none', display: 'inline-block' },
		          }, '导出 Markdown'),
		          h('a', {
		            href: exportHref(selected, sessions, 'csv'), target: '_blank', rel: 'noreferrer',
		            style: { ...input, width: 'auto', textDecoration: 'none', display: 'inline-block' },
		          }, '导出 CSV'))),
		
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
		exports.apply = apply;
		return module.exports;
	}
});
