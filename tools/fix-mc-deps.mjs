#!/usr/bin/env node
/**
 * fix-mc-deps.mjs —— 把依赖树里「尾斜杠内置名」地雷修掉（`require('string_decoder')` → `require('string_decoder')`）。
 *
 * 为什么需要它：见 `src/dep-guard.mjs` 头注释与 `踩坑档案.md` #224。
 * 一句话：`mineflayer → minecraft-protocol → readable-stream@4` 里有这么一行，
 * DSH 的 profile 解析器碰到它会 `resolve.paths('string_decoder')` 拿到 null 再 for-of，
 * 抛 `TypeError: createRequire.resolve.paths is not a function or its return value is not iterable`，
 * 于是**整个插件 import 失败**（issue #2 就是这个）。
 *
 * 用法：
 *   node tools/fix-mc-deps.mjs              # 扫默认目录，有就修，打印明细
 *   node tools/fix-mc-deps.mjs --check      # 只检查不改；有雷 exit 1（给 CI/自检用）
 *   node tools/fix-mc-deps.mjs --auto       # 静默修补，**永远 exit 0**（postinstall 用）
 *   node tools/fix-mc-deps.mjs --silent     # 修补，但不打印成功信息
 *   node tools/fix-mc-deps.mjs <目录>       # 只扫指定目录（可给多个）
 *
 * `postinstall` 里跑的是 `--auto`；pnpm 10 默认拦依赖的 build script，所以它可能根本不执行 ——
 * 真正的兜底是 `src/connection.mjs` 的 `ensureMineflayer()`（撞上了就修 + 重试一次）。
 */
import { ensureDepGuard, defaultDepRoots, describeDepGuard } from '../src/dep-guard.mjs'

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const check = flag('--check')
const auto = flag('--auto')
const silent = flag('--silent') || auto
const dirs = args.filter((a) => !a.startsWith('--'))

/* --check 时只读；--auto 时永远别把安装弄挂，所以吞掉所有异常 */
let report
try {
  report = ensureDepGuard({
    roots: dirs.length ? dirs : null,
    patch: !check,
    log: silent ? null : (m) => console.log('  · ' + m),
  })
} catch (err) {
  if (auto) process.exit(0)
  console.error('✗ 扫依赖树失败：' + (err?.message ?? err))
  process.exit(check ? 1 : 2)
}

if (!silent) {
  console.log('\n扫的目录：')
  for (const r of report.roots) console.log('  · ' + r)
  console.log(`扫了 ${report.scanned} 个文件${report.truncated ? '（到上限提前收工）' : ''}`)
}

if (!report.mines.length) {
  if (!silent) console.log('✓ 没有「尾斜杠内置名」地雷')
  process.exit(0)
}

if (!silent) {
  console.log(`\n找到 ${report.mines.length} 处地雷：`)
  for (const m of report.mines) console.log(`  ${m.file}\n      require('${m.spec}')  →  require('${m.name}')`)
}

if (check) {
  console.log('\n✗ 有地雷没修 —— 跑一次 `node tools/fix-mc-deps.mjs`（或让插件自己撞上时自愈）')
  process.exit(1)
}

if (report.failed.length) {
  if (!silent) {
    console.log('\n✗ 有几处没修动（常见原因：node_modules 只读 / 没权限）：')
    for (const f of report.failed) console.log(`  ${f.file} — ${f.error}`)
  }
  if (auto) process.exit(0)
  process.exit(1)
}

if (!silent) console.log('\n' + describeDepGuard(report))
process.exit(0)
