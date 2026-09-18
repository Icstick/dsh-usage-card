/**
 * dsh-usage-card —— 宿主半（M0）
 *
 * 只做一件事：把「当前会话的用量与费用」算成一个 JSON，挂在只读路由上给侧栏卡片轮询。
 * 取数全部走内核已查证的接缝：
 *   - 四桶   ctx.sessionProjections.snapshot(session).values.tokenUsage
 *   - 组成   ctx.sessionProjections.snapshot(session).values.contextBreakdown
 *   - 模型   request/header 事件的 data.header.config.model
 * 口径纪律：measured（实测）与 attribution（估算）在 payload 里就是两组字段，永不相加。
 *
 * @module dsh-usage-card
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名。 */
export const name = 'usage-card'
/** 依赖的服务；缺任一则 fiber 保持 pending，不会半死。sessions 用于按 id 解析客户端正在看的会话。 */
export const inject = ['webServer', 'sessionProjections', 'sessions', 'tokenMeter']

/** 卡片轮询的只读路由。 */
export const ROUTE = '/usage-card/current.json'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRICES = JSON.parse(readFileSync(join(HERE, 'prices.json'), 'utf8'))
/** 本插件版本；写进 payload 便于一眼看出宿主跑的哪个构建。 */
const PLUGIN_VERSION = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version

/**
 * 按 UTC + ISO 星期判定是否峰时。
 * 只用 getUTC* 系列：三台机器时区不同，用本机时间会算出不同的峰谷结论。
 * @param date - 判定时刻
 * @param cfg - prices.json 的 peakPricing 段
 */
export function isPeak(date, cfg) {
  if (!cfg?.enabled) return false
  const wd = date.getUTCDay() === 0 ? 7 : date.getUTCDay()
  if (!cfg.weekdays.includes(wd)) return false
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  return cfg.windows.some((w) => {
    const [sh, sm] = w.start.split(':').map(Number)
    const [eh, em] = w.end.split(':').map(Number)
    return minutes >= sh * 60 + sm && minutes < eh * 60 + em
  })
}

/**
 * 解析某模型在某时刻的档位价；查不到任何必需字段一律返回 null（绝不回退默认价、绝不当 0）。
 * @param model - 请求头里的模型名（可能是退役别名）
 * @param date - 判定时刻
 */
export function priceFor(model, date) {
  const canonical = PRICES.aliases?.[model]?.resolvesTo ?? model
  const row = PRICES.models[canonical]
  if (!row) return null
  const peak = isPeak(date, PRICES.peakPricing)
  const tier = peak ? row.peak : row.offPeak
  if (!tier) return null
  if (['cacheMiss', 'cacheHit', 'output'].some((k) => tier[k] == null)) return null
  return { canonical, tier: peak ? 'peak' : 'offPeak', cacheMiss: tier.cacheMiss, cacheHit: tier.cacheHit, output: tier.output }
}

/**
 * 四桶 + 模型 + 时刻 → 费用。单位在变量名里写死：**Usd 与 Cny 不混**。
 * 换算只在这一处发生，此后全链路是 CNY。
 */
export function computeCost(buckets, price, fxRate) {
  if (price == null) return { unpriced: true, inputUsd: null, outputUsd: null, totalUsd: null, totalCny: null }
  const inputUsd = (buckets.uncachedInputTokens / 1e6) * price.cacheMiss + (buckets.cacheReadTokens / 1e6) * price.cacheHit
  const outputUsd = (buckets.outputTokens / 1e6) * price.output
  return { unpriced: false, inputUsd, outputUsd, totalUsd: inputUsd + outputUsd, totalCny: (inputUsd + outputUsd) * fxRate }
}

/**
 * 从请求 URL 里取 `?session=<id>`。
 *
 * 侧栏槽位没有会话上下文，所以由客户端在 session 作用域的信标把 id 带过来；
 * 不带则退回「最近有事件的会话」（会有后台会话抢镜的问题，客户端正常情况下都会带）。
 * @param url - 原始 request.url
 */
export function sessionIdFrom(url) {
  const raw = String(url ?? '')
  const q = raw.indexOf('?')
  if (q < 0) return null
  const value = new URLSearchParams(raw.slice(q + 1)).get('session')
  return value != null && value !== '' ? value : null
}

/** 一串内容里的字符数（用于把一次拼接按占比摊到各类）。 */
function contentSize(value) {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + contentSize(item), 0)
  if (value !== null && typeof value === 'object') {
    return Object.values(value).reduce((sum, item) => sum + contentSize(item), 0)
  }
  return 0
}

/**
 * 把一个 surface 节点按它来源的事件类型归到卡片要的类别。
 *
 * 关键事实（实测得出，别想当然）：
 *   - 真人消息在 agent/inbox/spliced 的 inserted[] 里（source.kind === 'user'）；
 *     user/message 里绝大多数是宿主注入（runtime context / knowledge-recall / acp …）。
 *   - 一次 spliced 可能同时含真人与注入 → 按内容字符数把该节点的 token 摊开。
 * @param event - 该节点 seq 对应的事件
 * @returns 类别 → 权重（权重和约为 1）
 */
export function classifyEvent(event) {
  const type = event?.type
  if (type === 'system/message') return { system: 1 }
  if (type === 'assistant/message' || type === 'assistant/attempt') return { assistant: 1 }
  if (type === 'tool/result' || type === 'tool/call') return { toolResult: 1 }
  if (type === 'user/message') return { inject: 1 }
  if (type === 'agent/inbox/spliced') {
    const items = Array.isArray(event.data?.inserted) ? event.data.inserted : []
    let user = 0
    let other = 0
    for (const item of items) {
      const size = contentSize(item?.content)
      if (item?.source?.kind === 'user') user += size
      else other += size
    }
    const total = user + other
    if (total === 0) return { inject: 1 }
    // 权重为 0 的类别不出现在结果里，省得下游累加一堆 0
    const weights = {}
    if (user > 0) weights.user = user / total
    if (other > 0) weights.inject = other / total
    return weights
  }
  return { other: 1 }
}

/** 卡片要的六类，顺序即展示顺序。 */
export const ATTRIBUTION_ROWS = [
  { key: 'system', label: '系统提示' },
  { key: 'toolsSchema', label: '工具 schema' },
  { key: 'user', label: '用户消息' },
  { key: 'inject', label: '环境注入' },
  { key: 'toolResult', label: '工具结果' },
  { key: 'assistant', label: 'AI 历史回复' },
]

/**
 * 按 surface 逐节点定价做六类归因（估算口径，与四桶实测严格分列）。
 *
 * 节点 token 来自 ctx.tokenMeter.measure(session)（路由定价），类别由
 * session.eventAt(node.seq) 回查事件类型得到 —— 用内核算好的价，不自己按体积估。
 * 工具 schema 不在 surface 节点里（它在请求信封的 header.tools），故单独从
 * contextBreakdown.toolsTokens 取，避免漏掉或被重复计入。
 * @param ctx - 携带 tokenMeter 的上下文
 * @param session - 目标会话
 * @param toolsTokens - 信封里的工具 schema token 数
 */
export function attribute(ctx, session, toolsTokens) {
  const measurement = ctx.tokenMeter.measure(session)
  const acc = { system: 0, toolsSchema: toolsTokens ?? 0, user: 0, inject: 0, toolResult: 0, assistant: 0, other: 0 }
  for (const node of measurement.nodes) {
    const weights = classifyEvent(session.eventAt(node.seq))
    for (const [key, weight] of Object.entries(weights)) acc[key] += node.tokens * weight
  }
  const total = Object.values(acc).reduce((a, b) => a + b, 0)
  return { acc, total, logRevision: measurement.logRevision }
}

/** 当前汇率快照。M0 用手动兜底值；M4 接自动更新。 */
function fxSnapshot() {
  return { rate: 7.2, source: 'manual-fallback', at: new Date().toISOString(), status: 'fallback' }
}

/**
 * 组装卡片 payload。任何一处数据缺失都返回带原因码的降级结果，绝不显示 0 冒充有效。
 * @param ctx - 携带 sessionProjections 的上下文
 * @param session - 最近有事件的会话
 * @param model - 最近一次请求的模型名
 */
export function buildPayload(ctx, session, model) {
  const base = {
    ok: true,
    schemaVersion: 1,
    pluginVersion: PLUGIN_VERSION,
    generatedAt: new Date().toISOString(),
    machineId: PRICES.machineId ?? null,
    session: { id: session?.header?.id ?? session?.id ?? null, model: model ?? null, requestedModel: model ?? null },
  }
  if (session == null) return { ...base, ok: false, reason: 'NO_SESSION' }
  let values
  try {
    values = ctx.sessionProjections.snapshot(session).values
  } catch (error) {
    return { ...base, ok: false, reason: 'PROJECTION_UNAVAILABLE', detail: String(error?.message ?? error).slice(0, 200) }
  }
  const totals = values.tokenUsage
  if (totals == null) return { ...base, ok: false, reason: 'NO_USAGE_YET' }
  // 模型以本会话的 modelSelection 投影为准（per-session、已折叠）；
  // 只在它缺席时才退回事件跟踪到的模型 —— 插件后装时，request/header 事件早就过去了，
  // 只靠事件跟踪会把模型判成「未知」，进而整套金额都算不出来。
  const effectiveModel = values.modelSelection?.lastUsed?.model ?? model
  const buckets = {
    uncachedInputTokens: totals.uncachedInputTokens ?? 0,
    cacheReadTokens: totals.cacheReadTokens ?? 0,
    cacheWriteTokens: totals.cacheWriteTokens ?? 0,
    outputTokens: totals.outputTokens ?? 0,
  }
  const billed = buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.outputTokens
  const price = priceFor(effectiveModel, new Date())
  const fx = fxSnapshot()
  const cost = computeCost(buckets, price, fx.rate)
  const denom = buckets.cacheReadTokens + buckets.uncachedInputTokens
  const breakdown = values.contextBreakdown
  // 六类归因：逐节点定价 + 事件类型分类（M2）。失败则退回内核三元，绝不整体消失。
  let attribution = null
  try {
    const six = attribute(ctx, session, breakdown?.toolsTokens ?? 0)
    const rows = ATTRIBUTION_ROWS.map((row) => ({ ...row, tokens: six.acc[row.key] ?? 0, costCny: null }))
    // 'other' 只在真的存在时补一行，避免恒为 0 的空行占位
    if ((six.acc.other ?? 0) > 0) rows.push({ key: 'other', label: '其它', tokens: six.acc.other, costCny: null })
    attribution = {
      source: 'estimate',
      basis: 'tokenMeter.measure + session.eventAt',
      totalTokens: six.total,
      logRevision: six.logRevision,
      rows,
    }
  } catch (error) {
    attribution = breakdown == null ? null : {
      source: 'estimate',
      basis: 'contextBreakdown(fallback)',
      totalTokens: (breakdown.systemTokens ?? 0) + (breakdown.toolsTokens ?? 0) + (breakdown.messageTokens ?? 0),
      rows: [
        { key: 'system', label: '系统提示', tokens: breakdown.systemTokens ?? 0, costCny: null },
        { key: 'toolsSchema', label: '工具 schema', tokens: breakdown.toolsTokens ?? 0, costCny: null },
        { key: 'messages', label: '其余消息', tokens: breakdown.messageTokens ?? 0, costCny: null },
      ],
      fallbackReason: String(error?.message ?? error).slice(0, 120),
    }
  }
  if (attribution != null && attribution.totalTokens > 0) {
    // 占比是 token 比例，与定价无关 —— 模型未定价也必须照常给出，
    // 否则一条「算不出钱」会把整块占比一起变成空的（v0.1.0-m0 的 bug）。
    // 金额才是可选的：不可定价时为 null，客户端显示「—」。
    const priced = cost.totalCny != null
    for (const row of attribution.rows) {
      // 不做显示层取整：取整会让「逐项之和 === 输入侧」的校验假失败，还会累积误差。
      // 取整只发生在客户端渲染时（fmtCny）。
      row.share = row.tokens / attribution.totalTokens
      row.costCny = priced ? cost.inputUsd * fx.rate * row.share : null
    }
  }
  return {
    ...base,
    session: {
      ...base.session,
      model: effectiveModel ?? null,
      peakTier: price?.tier ?? null,
      resolvedModel: price?.canonical ?? null,
    },
    measured: {
      ...buckets,
      totalTokens: billed,
      cacheHitRate: denom > 0 ? buckets.cacheReadTokens / denom : null,
    },
    cost: {
      unpriced: cost.unpriced,
      totalUsd: cost.totalUsd,
      inputUsd: cost.inputUsd,
      outputUsd: cost.outputUsd,
      totalCny: cost.totalCny,
      fx,
      priceVersion: PRICES.generatedAt ?? null,
    },
    attribution,
    subagents: { count: 0, tokens: null, costCny: null, includedInTotal: false, items: [], pending: 'M3' },
  }
}

/**
 * 登记只读路由并把「最近一次有事件的会话 / 最近一次请求的模型」记在闭包里。
 * 所有登记都是本 fiber 的 effect，卸载即回收。
 * @param ctx - 宿主上下文
 */
export function apply(ctx) {
  let currentSession = null
  let currentModel = null

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      currentSession = session
      if (event?.type === 'request/header') {
        const model = event.data?.header?.config?.model
        if (typeof model === 'string') currentModel = model
      }
    })
    return () => { try { off?.() } catch { /* 已回收 */ } }
  }, 'usage-card: track latest session')

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: (req, res) => {
        let payload
        try {
          const requested = sessionIdFrom(req.url)
          if (requested == null) {
            payload = buildPayload(ctx, currentSession, currentModel)
          } else {
            const resolved = ctx.sessions.get(requested)
            // 解析不到就诚实说「该会话未加载」，绝不悄悄显示另一个会话的数字
            payload = resolved === undefined
              ? { ok: false, schemaVersion: 1, reason: 'SESSION_NOT_LOADED', session: { id: requested } }
              : buildPayload(ctx, resolved, currentModel)
          }
        } catch (error) {
          payload = { ok: false, reason: 'INTERNAL', detail: String(error?.message ?? error).slice(0, 200) }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(payload))
      },
    })
    return () => { try { dispose?.() } catch { /* 已回收 */ } }
  }, 'usage-card: read-only route')
}
