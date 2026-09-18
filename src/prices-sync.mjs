/**
 * prices-sync.mjs —— 从 DeepSeek 官方定价页解析价目（宿主半）
 *
 * 为什么要做：官方会调价。把价目写死在包里，迟早算错钱
 * （本机残留配置就因此把 V4-Pro 少算 3.3 倍）。
 *
 * 解析策略：官方页的价目区是三段固定结构，每段「OFF-PEAK / PEAK」各一行、
 * 模型列从左到右与页面顶部的 MODEL 表一致。所以按段抓数字即可，
 * 不做 HTML DOM 解析——但**解析结果必须过合理性校验**，否则宁可不更新。
 *
 * @module dsh-usage-card/prices-sync
 */
export const OFFICIAL_PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing'

/** 抓一段里的所有美元数字。 */
function dollarsNear(text, marker, span = 600) {
  const at = text.indexOf(marker)
  if (at < 0) return []
  return [...text.slice(at, at + span).matchAll(/\$([0-9]+(?:\.[0-9]+)?)/g)].map((m) => Number(m[1]))
}

/**
 * 解析官方定价页文本。
 *
 * 结构（实测 2026-09-18）：
 *   1M INPUT TOKENS (CACHE HIT) → OFF-PEAK $a $b / PEAK $c $d
 *   1M INPUT TOKENS (CACHE MISS) → 同上
 *   1M OUTPUT TOKENS → 同上
 * 每段四个数 = [模型1 谷, 模型2 谷, 模型1 峰, 模型2 峰]。
 * @param text - 页面纯文本
 * @returns { models, peakWindows, weekdays, offPeakIsHalfOfPeak } 或 null（结构不符）
 */
export function parseOfficialPricing(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const flat = text.replace(/\s+/g, ' ')
  const hit = dollarsNear(flat, 'CACHE HIT)', 400)
  const miss = dollarsNear(flat, 'CACHE MISS)', 400)
  const out = dollarsNear(flat, '1M OUTPUT TOKENS', 400)
  if (hit.length < 4 || miss.length < 4 || out.length < 4) return null
  // 页面顶部的模型名列（按列顺序）
  const models = []
  for (const name of ['deepseek-flash', 'deepseek-v4-pro']) if (flat.includes(name)) models.push(name)
  if (models.length === 0) return null
  const count = Math.min(models.length, 2)
  const table = {}
  for (let i = 0; i < count; i += 1) {
    table[models[i]] = {
      currency: 'USD',
      unit: 'per_1m_tokens',
      offPeak: { cacheHit: hit[i], cacheMiss: miss[i], output: out[i] },
      peak: { cacheHit: hit[i + count], cacheMiss: miss[i + count], output: out[i + count] },
    }
  }
  // 峰时窗口（官方脚注原文：“Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday”）
  const windows = [...flat.matchAll(/(\d{2}):00\s*-\s*(\d{2}):00/g)].map((m) => ({ start: m[1] + ':00', end: m[2] + ':00' }))
  return {
    models: table,
    peakWindows: windows.length > 0 ? windows : null,
    weekdays: /Monday through Friday/i.test(flat) ? [1, 2, 3, 4, 5] : null,
    sourceUrl: OFFICIAL_PRICING_URL,
    checkedAt: new Date().toISOString().slice(0, 10),
  }
}

/**
 * 合理性校验：宁可拒绝更新，也不要用一个半截的价目去算钱。
 * @param parsed - parseOfficialPricing 的结果
 * @param baseline - 内置价目（用于量级对比）
 */
export function acceptParsed(parsed, baseline) {
  if (parsed == null || typeof parsed !== 'object') return { ok: false, reason: 'PARSE_EMPTY' }
  const names = Object.keys(parsed.models ?? {})
  if (names.length === 0) return { ok: false, reason: 'NO_MODELS' }
  for (const name of names) {
    const row = parsed.models[name]
    for (const tier of ['offPeak', 'peak']) {
      for (const key of ['cacheHit', 'cacheMiss', 'output']) {
        const v = row?.[tier]?.[key]
        if (!Number.isFinite(v) || v <= 0 || v > 1000) return { ok: false, reason: 'BAD_VALUE', detail: name + '.' + tier + '.' + key + '=' + String(v) }
      }
    }
    // 与内置价目比量级：允许调价，但不允许离谱（>5 倍或 <1/5）
    const base = baseline?.models?.[name]?.offPeak
    if (base != null && Number.isFinite(base.cacheMiss) && base.cacheMiss > 0) {
      const ratio = row.offPeak.cacheMiss / base.cacheMiss
      if (ratio > 5 || ratio < 0.2) return { ok: false, reason: 'IMPLAUSIBLE', detail: name + ' 未命中价变成内置价的 ' + ratio.toFixed(2) + ' 倍' }
    }
  }
  return { ok: true }
}
