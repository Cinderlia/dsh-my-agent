/**
 * dep-guard —— 依赖树里「尾斜杠内置名」地雷的**探测**与**就地修补**。
 *
 * ## 这颗雷长什么样
 *
 * 有些包会写 `require('string_decoder')`（带尾斜杠）。裸 Node 解析器能容忍这种写法，
 * 但 **DSH 的 profile 解析器不能**：`dsh-app-boot` 的 `barePackageName()` 判据是
 * 「不以 `.` `/` `\` `#` 开头、不含 `:`、`isBuiltin()` 为假」，而 `isBuiltin('string_decoder/')`
 * 因为尾斜杠是 **false** ⇒ 它被当成包名、砍掉斜杠成 `'string_decoder'`，接着
 * `for (const p of createRequire(parent).resolve.paths('string_decoder'))` —— 内置名让
 * `resolve.paths()` 返回 **null**，对 null 做 for-of 直接抛：
 *
 *     TypeError: createRequire.resolve.paths is not a function or its return value is not iterable
 *
 * 结果是**整个 `import()` 失败**：插件那一项 inactive，能力静默消失。
 *
 * ## 已知触发者
 *
 * `mineflayer → minecraft-protocol → readable-stream@4` 的
 * `lib/internal/streams/readable.js` 第 70 行 `require('string_decoder')`。
 * 2026-10-20 别人反馈 issue #2（`pnpm add github:blueziii/dsh-mc-agent` 装上后加载失败），
 * 根因就是这个 —— 我们自己机器上早把那一行手改成不带斜杠了，所以一直没看见。
 *
 * ## 三条防线（都在这里）
 *
 * 1. `tools/fix-mc-deps.mjs`（`postinstall` 会跑）—— 装完立刻修；
 * 2. `ensureMineflayer()`（`src/connection.mjs`）—— 懒加载 mineflayer，命中这颗雷时**先修再重试**一次
 *    （pnpm 10 默认拦依赖的 build script，postinstall 可能不跑，所以这条不能省）；
 * 3. `tools/check-mc-deps.mjs` / `tools/check-dep-guard.mjs` —— 体检 + 把契约钉住。
 *
 * 修法只做一件事：把 `'<内置名>/'` 改成 `'<内置名>'`（语义完全等价，`require('string_decoder')`
 * 和 `require('string_decoder')` 拿到的是同一个模块）。**只改 isBuiltin 为真的那一小撮**，
 * 别的一律不碰。
 *
 * 开关：`DSH_MC_AGENT_DEP_GUARD=off` 可以让 2 号防线完全不动手（只报告）。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isBuiltin } from 'node:module'
import { homedir } from 'node:os'

/** `<pkg>/src` 的上一级 = 本包根目录。 */
const HERE = dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = dirname(HERE)

/**
 * 抓 specifier 的正则：`require('x')` / `import('x')` / `from 'x'` / `import 'x'`。
 * 第二个捕获组之外用 `\1` 配平引号，避免把 `"a'"` 这种跨行乱配。
 */
export const SPEC_RE = /(?:require\s*\(\s*|import\s*\(\s*|from\s*|import\s*)(['"])([^'"\n]+)\1/g

/** 这些目录不扫（测试/示例里的写法跟我们无关，也很拖时间）。 */
const SKIP_DIRS = new Set(['.git', '.bin', '.cache', 'test', 'tests', 'examples', 'example', 'docs', 'coverage'])

/**
 * 这个 specifier 是不是「尾斜杠内置名」？
 *
 * 只认：以 `/` 结尾、去掉斜杠后是**单个**内置模块名（不含 `/`、不含 `:`）。
 * `'safe-buffer/'`（不是内置名）、`'node:fs/'`（带冒号）、`'@scope/x/'` 都不算。
 */
export function isLandmineSpec (spec) {
  if (typeof spec !== 'string' || !spec.endsWith('/')) return false
  const name = spec.slice(0, -1)
  if (!name || name.includes('/') || name.includes(':')) return false
  return isBuiltin(name)
}

/**
 * 在一段源码里找所有地雷。
 *
 * @returns {Array<{spec:string, name:string, index:number}>} `index` 是 spec 本体（不含引号）的起点
 */
export function landminesInText (text) {
  if (typeof text !== 'string' || !text.includes('/')) return []
  const out = []
  SPEC_RE.lastIndex = 0
  let m
  while ((m = SPEC_RE.exec(text)) !== null) {
    const spec = m[2]
    if (!isLandmineSpec(spec)) continue
    /* m[0] = 前缀 + 引号 + spec + 引号 ⇒ spec 起点 = 结尾往回退「引号 + spec 长度」 */
    out.push({ spec, name: spec.slice(0, -1), index: m.index + m[0].length - 1 - spec.length })
  }
  return out
}

/**
 * 按 `landminesInText` 的结果改文本（从后往前改，索引不会失效）。
 * 引号原样保留，只把 spec 末尾那个斜杠去掉。
 */
export function patchText (text, mines) {
  if (!mines?.length) return text
  let out = text
  for (const mine of [...mines].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, mine.index) + mine.name + out.slice(mine.index + mine.spec.length)
  }
  return out
}

/**
 * 扫一棵依赖树（只读）。
 *
 * pnpm 的 `node_modules` 里一层层都是**符号链接**，所以链接要跟着走；
 * 用 realpath 记已访问目录，防环。
 *
 * @param {string} root 目录（一般是某个 `node_modules`）
 * @param {{maxFiles?:number, maxBytes?:number}} opts 上限，防止在超大树上卡死
 * @returns {{root:string, files:number, truncated:boolean, mines:Array<{spec:string,name:string,index:number,file:string}>}}
 */
export function scanDepTree (root, { maxFiles = 20000, maxBytes = 2_000_000, skipUnder = [] } = {}) {
  const report = { root, files: 0, truncated: false, mines: [] }
  const seenDirs = new Set()
  /* 🔴 skipUnder 必须按 **realpath** 比：`link:`/junction 装出来的
   * `node_modules/dsh-mc-agent` 就指着我们自己的仓库 —— 只比字面路径会把
   * 「我们的源码」当成依赖树去改（2026-10-20 真踩：把自己自检里的样本改没了）。 */
  const prunedTo = skipUnder.filter(Boolean).map((b) => { try { return realpathSync(b) } catch { return b } })
  const under = (p) => {
    let rp = p
    try { rp = realpathSync(p) } catch { /* 不存在就用字面路径 */ }
    return prunedTo.some((base) => p === base || p.startsWith(base + sep) || rp === base || rp.startsWith(base + sep))
  }
  const walk = (dir) => {
    if (report.truncated) return
    if (under(dir)) return
    let real = dir
    try { real = realpathSync(dir) } catch { return }
    if (seenDirs.has(real)) return
    seenDirs.add(real)
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (report.truncated) return
      if (SKIP_DIRS.has(e.name)) continue
      const p = join(dir, e.name)
      let isDir = e.isDirectory()
      let isFile = e.isFile()
      if (e.isSymbolicLink()) {
        try {
          const st = statSync(p)
          isDir = st.isDirectory()
          isFile = st.isFile()
        } catch { continue }
      }
      if (isDir) { if (!under(p)) walk(p); continue }
      if (!isFile || !/\.(js|cjs|mjs)$/i.test(e.name)) continue
      if (report.files >= maxFiles) { report.truncated = true; return }
      let st
      try { st = statSync(p) } catch { continue }
      if (st.size > maxBytes) continue
      let text
      try { text = readFileSync(p, 'utf8') } catch { continue }
      report.files++
      for (const m of landminesInText(text)) report.mines.push({ ...m, file: p })
    }
  }
  walk(root)
  return report
}

/**
 * 把扫描结果落盘修掉。**只改文件里那几个 spec**，其它字节一律不动（含行尾）。
 *
 * @returns {{files:number, patched:number, failed:Array<{file:string, error:string}>}}
 */
export function patchLandmines (report, { dryRun = false } = {}) {
  const byFile = new Map()
  for (const m of report?.mines ?? []) {
    if (!byFile.has(m.file)) byFile.set(m.file, [])
    byFile.get(m.file).push(m)
  }
  const out = { files: 0, patched: 0, failed: [] }
  for (const [file, mines] of byFile) {
    try {
      const text = readFileSync(file, 'utf8')
      const next = patchText(text, mines)
      if (next === text) continue
      if (!dryRun) writeFileSync(file, next, 'utf8')
      out.files++
      out.patched += mines.length
    } catch (e) {
      out.failed.push({ file, error: e?.code ?? String(e?.message ?? e) })
    }
  }
  return out
}

/**
 * 宿主 profile 目录列表：`<DSH_HOME>/profiles/<名字>`。
 * DSH_HOME 不设时取用户主目录下的 dsh 目录。软链安装那套依赖长在这里，不在本包目录旁边。
 */
export function dshProfiles () {
  const home = process.env.DSH_HOME || join(homedir(), '.' + 'dsh')
  const dir = join(home, 'profiles')
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => join(dir, e.name))
  } catch { return [] }
}

/**
 * 默认要扫哪些目录：本包的 `node_modules`、往上每层祖先的 `node_modules`、
 * `<祖先>/vendor/mc-deps/node_modules`，再加所有 profile 的 `node_modules` 与 vendor 树。
 *
 * 自动去掉被别的根包含的嵌套根（否则同一棵树扫好几遍）。
 */
export function defaultDepRoots (pkgRoot = PACKAGE_ROOT) {
  const cands = []
  const push = (p) => { if (p && existsSync(p)) cands.push(p) }
  push(join(pkgRoot, 'node_modules'))
  let dir = pkgRoot
  for (let i = 0; i < 5; i++) {
    const up = dirname(dir)
    if (!up || up === dir) break
    dir = up
    push(join(dir, 'vendor', 'mc-deps', 'node_modules'))
    push(join(dir, 'node_modules'))
  }
  for (const profile of dshProfiles()) {
    push(join(profile, 'node_modules'))
    push(join(profile, 'vendor', 'mc-deps', 'node_modules'))
  }
  const sorted = [...new Set(cands)].sort((a, b) => a.length - b.length)
  const roots = []
  for (const p of sorted) {
    if (roots.some((r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep))) continue
    roots.push(p)
  }
  return roots
}

/**
 * 这条报错是不是「尾斜杠内置名」那颗雷？
 *
 * 判据只认宿主那句话 + 我们的关键词，别把别的 TypeError 一起吞了。
 */
export function isLandmineError (err) {
  const msg = String(err?.message ?? err ?? '')
  if (!msg) return false
  if (/resolve\.paths is not a function/.test(msg)) return true
  return /string_decoder/.test(msg) && /not iterable/.test(msg)
}

/**
 * 扫 + 修（一次性）。
 *
 * @param {{roots?:string[], patch?:boolean, maxFiles?:number, log?:Function, dryRun?:boolean}} opts
 * @returns {{roots:string[], scanned:number, truncated:boolean, mines:Array, patched:number, failed:Array}}
 */
export function ensureDepGuard ({ roots = null, patch = true, maxFiles, log = null, dryRun = false } = {}) {
  const useRoots = roots ?? defaultDepRoots()
  const reports = []
  /* 本包自己的目录（含 备份/ 里那份上游原文件）不碰：那是我们的代码，改了没意义还毁备份 */
  const opts = { skipUnder: [PACKAGE_ROOT] }
  if (maxFiles) opts.maxFiles = maxFiles
  for (const root of useRoots) reports.push(scanDepTree(root, opts))
  const mines = reports.flatMap((r) => r.mines)
  let patched = 0
  const failed = []
  if (patch && mines.length && !dryRun) {
    for (const rep of reports) {
      if (!rep.mines.length) continue
      const res = patchLandmines(rep)
      patched += res.patched
      failed.push(...res.failed)
      if (res.patched && typeof log === 'function') {
        log(`依赖修补：${res.files} 个文件里 ${res.patched} 处「尾斜杠内置名」已改成去斜杠（${rep.root}）`)
      }
    }
  }
  return {
    roots: useRoots,
    scanned: reports.reduce((n, r) => n + r.files, 0),
    truncated: reports.some((r) => r.truncated),
    mines,
    patched,
    failed,
  }
}

/** 把报告说成一句人话（给日志 / 工具结果用）。 */
export function describeDepGuard (report) {
  const n = report?.mines?.length ?? 0
  if (!n) return `依赖树干净：扫了 ${report?.scanned ?? 0} 个文件，没有「尾斜杠内置名」`
  const files = new Set(report.mines.map((m) => m.file)).size
  if (report.patched) return `依赖树里 ${files} 个文件有 ${n} 处「尾斜杠内置名」（宿主解析器会对它 for-of null），已就地改成去斜杠`
  if (report.failed?.length) return `依赖树里 ${n} 处「尾斜杠内置名」修不动（${report.failed[0]?.error}），跑 node tools/fix-mc-deps.mjs 看看`
  return `依赖树里 ${n} 处「尾斜杠内置名」还没修 —— 跑 node tools/fix-mc-deps.mjs`
}
