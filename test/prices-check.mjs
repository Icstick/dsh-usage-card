// test/prices-check.mjs —— 官方价目解析与合理性校验（离线，不联网）
import assert from 'node:assert/strict'
import { acceptParsed, parseOfficialPricing } from '../src/prices-sync.mjs'
import { readFileSync } from 'node:fs'

let pass = 0
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name) }

// 仿官方页结构（纯文本；真实页面抓来后压平成同样形状）
const PAGE = [
  'MODEL deepseek-flash(1) deepseek-v4-pro(2)',
  'PRICING(3)',
  '1M INPUT TOKENS (CACHE HIT) OFF-PEAK $0.003 $0.022 PEAK $0.006 $0.044',
  '1M INPUT TOKENS (CACHE MISS) OFF-PEAK $0.15 $0.66 PEAK $0.3 $1.32',
  '1M OUTPUT TOKENS OFF-PEAK $0.6 $1.98 PEAK $1.2 $3.96',
  '(3) Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday',
].join(' ')
const BASELINE = JSON.parse(readFileSync(new URL('../src/prices.json', import.meta.url), 'utf8'))

console.log('解析')
t('三段各四个数 → 两个模型 × 谷/峰 × 三档', () => {
  const p = parseOfficialPricing(PAGE)
  assert.deepEqual(p.models['deepseek-flash'].offPeak, { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 })
  assert.deepEqual(p.models['deepseek-v4-pro'].peak, { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 })
})
t('峰时窗口与工作日也能带出来', () => {
  const p = parseOfficialPricing(PAGE)
  assert.deepEqual(p.peakWindows, [{ start: '01:00', end: '04:00' }, { start: '06:00', end: '10:00' }])
  assert.deepEqual(p.weekdays, [1, 2, 3, 4, 5])
})
t('结构不符 → null（不猜、不部分解析）', () => {
  assert.equal(parseOfficialPricing(''), null)
  assert.equal(parseOfficialPricing('随便一段没有价目表的文字 $1.00'), null)
  assert.equal(parseOfficialPricing('1M OUTPUT TOKENS OFF-PEAK $0.6'), null, '缺 CACHE HIT/MISS 段')
})

console.log('合理性校验')
t('正常解析结果通过', () => assert.equal(acceptParsed(parseOfficialPricing(PAGE), BASELINE).ok, true))
t('数值非法（0 / 非数）被拒', () => {
  const bad = parseOfficialPricing(PAGE)
  bad.models['deepseek-flash'].offPeak.cacheMiss = 0
  assert.equal(acceptParsed(bad, BASELINE).reason, 'BAD_VALUE')
})
t('量级离谱（价目变成 10 倍）被拒 —— 宁可继续用旧价', () => {
  const wild = parseOfficialPricing(PAGE)
  wild.models['deepseek-flash'].offPeak.cacheMiss = 15
  const verdict = acceptParsed(wild, BASELINE)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'IMPLAUSIBLE')
})
t('解析为空被拒', () => assert.equal(acceptParsed(null, BASELINE).reason, 'PARSE_EMPTY'))

console.log('\n价目验收全部通过：' + pass + ' 项')
