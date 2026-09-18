#!/usr/bin/env node
/**
 * scripts/install-local.mjs —— 把本插件装进 dsh web profile（可逆、可修）
 *
 * 为什么不用 `dsh plugin add`：它会跑 pnpm install，而运行中的 DSH 会锁住 node_modules
 * （本机 dev-lessons 第 23 条：EPERM）。这里用目录 junction + 手写依赖声明，等价且不碰 pnpm。
 *
 * 三个已踩过的坑，脚本里都防了：
 *   1. mklink 的相对目标按**调用方 CWD** 解析 → 链接目标一律用绝对路径
 *   2. 坏链接 existsSync 返回 false → 探测链接本身必须用 lstat
 *   3. 摘链接必须用 rmdir → rmSync(recursive) 对 junction 可能递归进目标删内容
 *
 * 用法：
 *   node scripts/install-local.mjs             安装 / 修复
 *   node scripts/install-local.mjs --uninstall 卸载
 *   node scripts/install-local.mjs --dry-run   只打印计划
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = 'dsh-usage-card'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH = process.env.DSH_HOME || join(homedir(), '.dsh')
const vendorLink = join(DSH, 'vendor', PKG)
const profileDir = join(DSH, 'profiles', 'web')
const profilePkg = join(profileDir, 'package.json')
const nmDir = join(profileDir, 'node_modules')
const nmLink = join(nmDir, PKG)

const args = process.argv.slice(2)
const uninstall = args.includes('--uninstall')
const dry = args.includes('--dry-run')
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const log = (m) => console.log((dry ? '[dry] ' : '') + m)

/** 探测路径本身是否存在（坏链接 existsSync 看不见，lstat 才看得见）。 */
function stat(path) {
  try { return lstatSync(path) } catch { return null }
}

/** 用 rmdir 摘除链接：只摘链接，不碰目标。真实目录才递归删。 */
function remove(path) {
  const st = stat(path)
  if (st === null) return
  if (dry) return log('会删除: ' + path)
  if (st.isSymbolicLink()) execFileSync('cmd', ['/c', 'rmdir', path], { stdio: 'ignore' })
  else rmSync(path, { recursive: true, force: true })
  log('已删除: ' + path)
}

/** 建目录链接；已存在且可达则跳过，存在但不可达则重建。目标必须是绝对路径。 */
function linkDir(target, linkPath) {
  const st = stat(linkPath)
  if (st !== null) {
    if (!st.isSymbolicLink()) throw new Error('目标已存在且不是链接，请人工处理: ' + linkPath)
    if (existsSync(join(linkPath, 'package.json'))) { log('链接可用，跳过: ' + linkPath); return }
    log('链接不可达，重建: ' + linkPath)
    remove(linkPath)
  }
  mkdirSync(dirname(linkPath), { recursive: true })
  if (dry) { log('会创建 junction: ' + linkPath + ' -> ' + target); return }
  execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { stdio: 'ignore' })
  log('junction 已建: ' + linkPath + ' -> ' + target)
}

const pkg = JSON.parse(readFileSync(profilePkg, 'utf8'))
const depValue = 'link:../../vendor/' + PKG

if (uninstall) {
  remove(nmLink)
  remove(vendorLink)
  delete pkg.dependencies[PKG]
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== PKG)
  if (!dry) writeFileSync(profilePkg, JSON.stringify(pkg, null, 2) + '\n')
  log('已从依赖与 bundles 移除 ' + PKG + '；重启 dsh web 生效')
  process.exit(0)
}

// 1) 备份 profile 清单
if (!dry) copyFileSync(profilePkg, profilePkg + '.bak-usage-card-' + stamp)
log('已备份 ' + profilePkg + '.bak-usage-card-' + stamp)

// 2) 目录链接（目标一律绝对路径）
linkDir(resolve(root), vendorLink)
linkDir(vendorLink, nmLink)

// 3) 依赖声明与 bundle 列表
pkg.dependencies[PKG] = depValue
if (!pkg.dsh.profile.bundles.includes(PKG)) pkg.dsh.profile.bundles.push(PKG)
if (!dry) writeFileSync(profilePkg, JSON.stringify(pkg, null, 2) + '\n')
log('dependencies["' + PKG + '"] = "' + depValue + '"')
log('bundles 共 ' + pkg.dsh.profile.bundles.length + ' 项（含 ' + PKG + '）')
log('重启 dsh web 后生效；验证：curl http://127.0.0.1:3080/usage-card/current.json')
