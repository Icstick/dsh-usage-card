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
import z from '@deepseek-ai/schemastery'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名。 */
export const name = 'usage-card'
/** 依赖的服务；缺任一则 fiber 保持 pending，不会半死。sessions 用于按 id 解析客户端正在看的会话。 */
export const inject = ['webServer', 'sessionProjections', 'sessions', 'sessionQuery', 'tokenMeter', 'settings']

/** 设置页 namespace；与客户端设置卡片必须一致。 */
export const SETTINGS_NAMESPACE = 'dsh-usage-card'

/**
 * 设置页 schema。三个键都是「用户层覆盖」语义：
 * 留空则用 schema 默认值（与设计文稿一致的做法）。
 */
export const SETTINGS_SCHEMA = z.object({
  /** 展示汇率：美元 → 人民币。默认 7.2，用户可改。 */
  fxRate: z.number().min(0.01).max(1000).default(7.2),
  /** 是否在卡片上显示金额。与其它显示金额的插件同屏时可关掉。 */
  showAmount: z.boolean().default(true),
  /** 是否显示上下文占比这一整块。 */
  showAttribution: z.boolean().default(true),
})

/** 设置缺省值（scope 不可用时的兜底，与 schema 默认一致）。 */
export const SETTINGS_DEFAULTS = { fxRate: 7.2, showAmount: true, showAttribution: true }

/** 卡片轮询的只读路由。 */
export const ROUTE = '/usage-card/current.json'

/**
 * 宿主的 connection 服务（请求信任栅栏）。
 *
 * 它提供 Host/Origin 校验（挡 DNS rebinding 与跨站调用）与浏览器认证；
 * **插件路由必须自己过这道栅栏** —— webServer 只负责派发，不做认证。
 * 不写进 inject：该包是浏览器侧的，强行注入会让 fiber 永远 pending；
 * 官方同款做法也是运行时取（open-in-app/src/index.ts:84）。
 * @param ctx - 宿主上下文
 */
function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

/**
 * 未通过栅栏就拒绝。**fail closed**：取不到栅栏时一律 403，绝不 fail open。
 * @param ctx - 宿主上下文
 * @param req - 传入请求
 * @param res - 传出响应
 * @returns true 表示已拒绝并结束响应
 */
export function rejectedByFence(ctx, req, res) {
  let status
  try {
    const connection = connectionOf(ctx)
    status = connection == null || typeof connection.requestRejection !== 'function'
      ? 403
      : connection.requestRejection(req)
  } catch {
    status = 403
  }
  if (status === undefined) return false
  res.statusCode = status
  res.end()
  return true
}

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
  if (type === 'user/message') {
    // 实测纠正：真人消息**就是** user/message，判据是 source.kind === 'user'。
    // 之前一律判成 inject，导致「用户消息」恒为 0 —— 这是归因里最核心的一行。
    // agent/inbox/spliced 里也能见到真人消息，但那不是 surface 事件，属兜底分支。
    return event.data?.source?.kind === 'user' ? { user: 1 } : { inject: 1 }
  }
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

/**
 * 读一个会话的实测四桶与模型（供子代理归集用）。
 * @param ctx - 上下文
 * @param session - 目标会话对象
 * @returns { buckets, model } 或 null（取不到就返回 null，绝不填 0 冒充）
 */
function measuredUsageOf(ctx, session) {
  try {
    const values = ctx.sessionProjections.snapshot(session).values
    const totals = values.tokenUsage
    if (totals == null) return null
    return {
      buckets: {
        uncachedInputTokens: totals.uncachedInputTokens ?? 0,
        cacheReadTokens: totals.cacheReadTokens ?? 0,
        cacheWriteTokens: totals.cacheWriteTokens ?? 0,
        outputTokens: totals.outputTokens ?? 0,
      },
      model: values.modelSelection?.lastUsed?.model ?? null,
    }
  } catch {
    return null
  }
}

/**
 * 归集本会话的直接子代理用量。
 *
 * 子代理是**独立会话**（header.parentSession 指回本会话），用量取它们自己的四桶 —— 所以这是
 * 实测而不是估算，可以精确计费。但一次性子代理跑完会被释放，那时它的会话对象不在 live 集合里，
 * 用量取不到：这种情况**如实计入 released 计数**，而不是当作 0 悄悄抹掉。
 * @param ctx - 上下文
 * @param parentId - 本会话 id
 * @param settings - 已解析的设置
 */
/** 会话枚举缓存：listSessions() 是全量磁盘扫描（实测 49 个会话 mean 19.85 ms），
 * 而子代理集合变化很慢 —— 缓存列表，但每个子会话的投影仍然实时读，数字不会滞后。 */
const LIST_TTL_MS = 4000
let listCache = { at: 0, records: null }

/** 清掉枚举缓存（测试与卸载用）。 */
export function resetSubagentCache() {
  listCache = { at: 0, records: null }
}

export async function collectSubagents(ctx, parentId, settings, now = new Date()) {
  if (parentId == null) return { count: 0, measured: 0, released: 0, tokens: null, costCny: null, items: [], includedInTotal: false }
  let records
  try {
    const now = Date.now()
    if (listCache.records !== null && now - listCache.at < LIST_TTL_MS) {
      records = listCache.records
    } else {
      records = await ctx.sessionQuery.listSessions()
      listCache = { at: now, records }
    }
  } catch (error) {
    return { count: 0, measured: 0, released: 0, tokens: null, costCny: null, items: [], includedInTotal: false, unavailable: String(error?.message ?? error).slice(0, 120) }
  }
  const children = records.filter((record) => record?.header?.parentSession === parentId)
  const items = []
  let tokens = 0
  let cny = 0
  let priced = true
  let released = 0
  for (const record of children) {
    const id = record.header.id
    const node = ctx.sessions.get(id)
    const measured = node === undefined ? null : measuredUsageOf(ctx, node)
    if (measured === null) {
      released += 1
      items.push({ id, label: record.header.agentPreset ?? null, depth: record.header.delegationDepth ?? 1, mode: record.header.isSeeded === true ? 'seeded' : 'one-shot', tokens: null, costCny: null, note: node === undefined ? '会话已释放，用量不可得' : '该子会话尚未产生用量' })
      continue
    }
    const b = measured.buckets
    const total = b.uncachedInputTokens + b.cacheReadTokens + b.outputTokens
    const price = priceFor(measured.model ?? null, now)
    const cost = computeCost(b, price, settings.fxRate)
    tokens += total
    if (cost.totalCny == null) priced = false
    else cny += cost.totalCny
    items.push({
      id,
      label: record.header.agentPreset ?? null,
      depth: record.header.delegationDepth ?? 1,
      mode: record.live === true ? 'live' : 'ended',
      model: measured.model ?? null,
      tokens: total,
      costCny: cost.totalCny,
      unpriced: cost.unpriced,
    })
  }
  return {
    count: items.length,
    measured: items.length - released,
    released,
    // 全释放时不能回落成 0：那是「取不到」，不是「花了 0」。违反本插件自己的红线。
    tokens: items.length === 0 ? 0 : (items.length - released === 0 ? null : tokens),
    costCny: priced && !(items.length > 0 && items.length - released === 0) ? cny : null,
    includedInTotal: false,
    items,
  }
}

/**
 * 当前汇率快照。取自设置页的 fxRate；M4 接自动更新（拉取失败再退回这里的手动值）。
 * @param settings - 已解析的设置值
 */
function fxSnapshot(settings) {
  return {
    rate: settings.fxRate,
    source: 'settings',
    at: new Date().toISOString(),
    status: 'manual',
  }
}

/**
 * 组装卡片 payload。任何一处数据缺失都返回带原因码的降级结果，绝不显示 0 冒充有效。
 * @param ctx - 携带 sessionProjections 的上下文
 * @param session - 最近有事件的会话
 * @param model - 最近一次请求的模型名
 */
/**
 * 组装卡片 payload。
 * @param ctx - 携带 sessionProjections / tokenMeter 的上下文
 * @param session - 目标会话
 * @param model - 事件跟踪到的模型（仅作 modelSelection 缺席时的兜底）
 * @param settings - 已解析的设置值（默认与 schema 默认一致）
 */
export function buildPayload(ctx, session, model, settings = SETTINGS_DEFAULTS, fold = null, now = new Date()) {
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
  // now 可注入：金额依赖墙钟（峰谷），不可注入的测试会在跨过峰谷边界时无故变红。
  const price = priceFor(effectiveModel, now)
  const fx = fxSnapshot(settings)
  const linear = computeCost(buckets, price, fx.rate)
  let cost = linear
  /** 计价模式：per-turn = 每轮按自己的时刻定价（精确）；mixed = 含插件加载前的线性估算部分。 */
  let pricing = { mode: 'session-linear', turns: 0, coverage: 0, note: '插件加载前的部分只能按当前档位线性估算' }
  if (fold != null && fold.turns > 0) {
    // 差集 = 插件加载前就产生的用量（我们没见过那些轮次的时间），只能按当前档位估。
    const remainder = {
      uncachedInputTokens: Math.max(0, buckets.uncachedInputTokens - fold.uncachedInputTokens),
      cacheReadTokens: Math.max(0, buckets.cacheReadTokens - fold.cacheReadTokens),
      cacheWriteTokens: 0,
      outputTokens: Math.max(0, buckets.outputTokens - fold.outputTokens),
    }
    const remTotal = remainder.uncachedInputTokens + remainder.cacheReadTokens + remainder.outputTokens
    const remCost = computeCost(remainder, price, fx.rate)
    const inputUsd = (remCost.inputUsd ?? 0) + fold.usdInput
    const outputUsd = (remCost.outputUsd ?? 0) + fold.usdOutput
    const totalUsd = inputUsd + outputUsd
    cost = {
      unpriced: (remTotal > 0 && linear.unpriced) || fold.unpricedTurns > 0,
      inputUsd,
      outputUsd,
      totalUsd,
      totalCny: totalUsd * fx.rate,
    }
    pricing = {
      mode: remTotal === 0 && fold.unpricedTurns === 0 ? 'per-turn' : 'mixed',
      turns: fold.turns,
      coverage: billed > 0 ? Math.min(1, (billed - remTotal) / billed) : 1,
      unpricedTurns: fold.unpricedTurns,
    }
  }
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
      pricing,
      priceVersion: PRICES.generatedAt ?? null,
    },
    display: { showAmount: settings.showAmount, showAttribution: settings.showAttribution },
    attribution,
    // 由路由在 buildPayload 之后填入（需要异步枚举会话）；这里是同步路径的占位
    subagents: { count: 0, measured: 0, released: 0, tokens: null, costCny: null, includedInTotal: false, items: [] },
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
  /** 设置作用域；注册在 effect 上，卸载即回收。 */
  let settingsScope = null

  /** 现读设置 —— 设置服务 applies 默认 'live'，保存后无需重启。 */
  const readSettings = () => {
    let raw
    try {
      raw = settingsScope === null ? SETTINGS_DEFAULTS : settingsScope.get()
    } catch {
      return SETTINGS_DEFAULTS
    }
    // 防御：手改 settings.yaml 可以塞进 NaN / null / 负数，schema 层不一定挡住。
    // 汇率非法就退回默认值 —— 否则金额会静默变成 ¥0.00（比报错更危险）。
    const rate = Number(raw?.fxRate)
    return {
      ...SETTINGS_DEFAULTS,
      ...raw,
      fxRate: Number.isFinite(rate) && rate > 0 ? rate : SETTINGS_DEFAULTS.fxRate,
      showAmount: raw?.showAmount !== false,
      showAttribution: raw?.showAttribution !== false,
    }
  }

  ctx.effect(() => {
    settingsScope = ctx.settings.register(SETTINGS_NAMESPACE, SETTINGS_SCHEMA)
    return () => { settingsScope = null }
  }, 'usage-card: settings')

  /** 按轮计价账本：会话 id → 逐轮累加的四桶与金额（峰谷按**每轮自己的时间**判定）。 */
  const folds = new Map()
  /** 会话 id → 最近一次请求的模型（逐轮定价要用当时那个模型的价）。 */
  const sessionModels = new Map()

  /**
   * 把一条 assistant/message 记进按轮账本。
   * 峰谷是时段价：整会话按「轮询那一刻」定价，跨峰谷必然错（差可达 2 倍）。
   * @param session - 事件所属会话
   * @param event - 事件
   */
  const recordTurn = (session, event) => {
    const usage = event?.data?.usage
    const time = event?.time
    if (usage == null || typeof time !== 'number') return
    // 时间戳必须是毫秒（实测 event.time 是 epoch ms）。异常就跳过这条，
    // 宁可让它落到「线性估算」里，也不要拿错的时间去判峰谷。
    if (Math.abs(Date.now() - time) > 2 * 365 * 24 * 3600 * 1000) return
    const id = session?.header?.id ?? session?.id
    if (id == null) return
    const buckets = {
      uncachedInputTokens: usage.inputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    }
    const fold = folds.get(id) ?? {
      uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0,
      usdInput: 0, usdOutput: 0, turns: 0, unpricedTurns: 0,
    }
    fold.uncachedInputTokens += buckets.uncachedInputTokens
    fold.cacheReadTokens += buckets.cacheReadTokens
    fold.outputTokens += buckets.outputTokens
    fold.turns += 1
    const price = priceFor(sessionModels.get(id) ?? currentModel, new Date(time))
    if (price == null) {
      fold.unpricedTurns += 1
    } else {
      fold.usdInput += (buckets.uncachedInputTokens / 1e6) * price.cacheMiss + (buckets.cacheReadTokens / 1e6) * price.cacheHit
      fold.usdOutput += (buckets.outputTokens / 1e6) * price.output
    }
    folds.set(id, fold)
  }

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      currentSession = session
      const id = session?.header?.id ?? session?.id
      if (event?.type === 'request/header') {
        const model = event.data?.header?.config?.model
        if (typeof model === 'string') {
          currentModel = model
          if (id != null) sessionModels.set(id, model)
        }
      }
      if (event?.type === 'assistant/message') recordTurn(session, event)
    })
    return () => { try { off?.() } catch { /* 已回收 */ } }
  }, 'usage-card: track latest session')

  /** payload 缓存：键 = 会话 + 投影水位 + 设置。asOfSeq 不变就不必重算 measure()（O(surface)）。 */
  let payloadCache = { key: null, payload: null }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        // 1) 先过宿主的信任栅栏（Host/Origin + 浏览器认证）—— 这一步在任何数据处理之前
        if (rejectedByFence(ctx, req, res)) return
        // 2) 方法白名单：只有 GET
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end()
          return
        }
        let payload
        try {
          const requested = sessionIdFrom(req.url)
          const settings = readSettings()
          const target = requested == null ? currentSession : ctx.sessions.get(requested)
          if (requested != null && target === undefined) {
            // 解析不到就诚实说「该会话未加载」，绝不悄悄显示另一个会话的数字
            payload = { ok: false, schemaVersion: 1, reason: 'SESSION_NOT_LOADED', session: { id: requested } }
          } else {
            // 水位取不到（投影服务异常）就退化为不缓存，仍然返回正确数据
            let watermark = null
            try {
              watermark = target == null ? null : ctx.sessionProjections.snapshot(target).asOfSeq
            } catch {
              watermark = null
            }
            const key = [
              target?.header?.id ?? target?.id ?? 'none',
              watermark ?? 'no-watermark',
              settings.fxRate, settings.showAmount, settings.showAttribution,
            ].join('|')
            if (payloadCache.payload !== null && payloadCache.key === key) {
              payload = payloadCache.payload
            } else {
              const targetId = target?.header?.id ?? target?.id ?? null
              payload = buildPayload(ctx, target, currentModel, settings, targetId == null ? null : folds.get(targetId) ?? null)
              if (payload.ok === true && watermark != null) payloadCache = { key, payload }
            }
          }
          // 子代理归集是异步的（要枚举会话），失败不影响主卡片
          if (payload.ok === true && payload.session?.id != null) {
            try {
              payload.subagents = await collectSubagents(ctx, payload.session.id, settings)
            } catch (error) {
              payload.subagents = { count: 0, measured: 0, released: 0, tokens: null, costCny: null, items: [], includedInTotal: false, unavailable: String(error?.message ?? error).slice(0, 120) }
            }
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
