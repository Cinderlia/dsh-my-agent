/**
 * 依赖树「尾斜杠内置名」守卫（`src/dep-guard.mjs`）—— GitHub issue #2 的回归测试。
 *
 * 现场：别人 `pnpm add github:blueziii/dsh-mc-agent` 装完，插件那一项 inactive，日志报
 *   `TypeError: createRequire.resolve.paths is not a function or its return value is not iterable`
 * 根因不是我们的代码，是依赖树里有一行 `require('string_decoder')`（尾斜杠）：
 * DSH 的 profile 解析器把这种名字当包名、砍掉斜杠成内置名，`resolve.paths()` 返回 null，
 * 对 null 做 for-of 就抛了 —— 于是**整个 import 失败**。
 *
 * 这里不连服务器、不碰真依赖树（用临时目录造样本）：
 *   ① 判据只认「尾斜杠 + 内置名」这一小撮；
 *   ② 文本扫描 / 改写：只动那几个 spec，引号与其它字节原样；
 *   ③ 树扫描 + 落盘修补：能修、能跳过本包目录、不误伤干净文件；
 *   ④ 宿主那句报错的识别；
 *   ⑤ 三条防线都接上了（懒加载、postinstall、files 里带上了修复脚本）。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isLandmineSpec, landminesInText, patchText, scanDepTree, patchLandmines,
  ensureDepGuard, defaultDepRoots, dshProfiles, isLandmineError, describeDepGuard, PACKAGE_ROOT,
} from '../src/dep-guard.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)

/* 尾斜杠单独拼：这个文件自己也会被修复器扫到，字面写出来会被它「顺手改干净」（见 ② 的注释） */
const SL = '/'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

// ── ① 判据 ────────────────────────────────────────────────────────────────────
section('① 判据：只认「尾斜杠 + 内置名」')
{
  ok(isLandmineSpec('string_decoder/'), "'string_decoder/' 是地雷")
  ok(isLandmineSpec('process/'), "'process/' 也是（readable-stream 里就有）")
  ok(!isLandmineSpec('string_decoder'), '已经不带斜杠的不算')
  ok(!isLandmineSpec('safe-buffer/'), "'safe-buffer/' 不是内置名，不算（别乱改别人的包名）")
  ok(!isLandmineSpec('node:fs/'), '带冒号的不算（barePackageName 本来就跳过）')
  ok(!isLandmineSpec('@scope/pkg/'), '带 scope 的不算')
  ok(!isLandmineSpec(''), '空串不算')
  ok(!isLandmineSpec(null), 'null 不算（别抛）')
}

// ── ② 文本扫描 / 改写 ─────────────────────────────────────────────────────────
section('② 文本扫描与改写')
{
  /* 🔴 尾斜杠单独拼（`SL`）：这个文件会被 `postinstall` / 自愈扫描到，
   *    字面写出「尾斜杠」的话，**它自己的修复器会把这行样本改掉** ——
   *    2026-10-20 真踩过：样本被"修好"了，于是自检永远 0 命中。 */
  const src = [
    `const { StringDecoder } = require('string_decoder${SL}')`,
    `const p = require('process${SL}')`,
    `const ok1 = require('string_decoder')`,
    `const ok2 = require('./local${SL}')`,
    `import x from 'path${SL}'`,
    `const ok3 = require('safe-buffer${SL}')`,
  ].join('\n')
  const mines = landminesInText(src)
  ok(mines.length === 3, `三处命中（string_decoder${SL}、process${SL}、path${SL}）`, `实际 ${mines.length}`)
  ok(mines.map((m) => m.name).join(',') === 'string_decoder,process,path', '改完的名字对', mines.map((m) => m.name).join(','))
  ok(mines.every((m) => src.slice(m.index, m.index + m.spec.length) === m.spec), 'index 精确定位到 spec 本体（不含引号）')

  const out = patchText(src, mines)
  ok(out.includes("require('string_decoder')") && out.includes("require('process')") && out.includes("from 'path'"), '三处都去掉了斜杠')
  ok(out.includes(`require('safe-buffer${SL}')`), '非内置名的 safe-buffer 一个字没动')
  ok(out.split('\n').length === src.split('\n').length, '行数不变（没吃掉换行）')

  const dq = `const a = require("process${SL}");\n`
  ok(patchText(dq, landminesInText(dq)) === 'const a = require("process");\n', '双引号原样保留')

  ok(patchText('no spec here', []) === 'no spec here', '没有命中时原样返回')
  ok(landminesInText('').length === 0 && landminesInText(undefined).length === 0, '空输入不抛')
}

// ── ③ 树扫描 / 落盘修补（临时目录造样本） ──────────────────────────────────────
section('③ 树扫描与落盘修补')
{
  const tmp = mkdtempSync(join(tmpdir(), 'dep-guard-'))
  try {
    const nm = join(tmp, 'node_modules')
    mkdirSync(join(nm, 'fake-stream', 'lib'), { recursive: true })
    const bad = join(nm, 'fake-stream', 'lib', 'readable.js')
    const good = join(nm, 'fake-stream', 'lib', 'writable.js')
    const skipMe = join(nm, 'myown', 'backup.js')
    mkdirSync(join(nm, 'myown'), { recursive: true })
    const badSrc = `const { StringDecoder } = require('string_decoder${SL}')\nmodule.exports = { StringDecoder }\n`
    writeFileSync(bad, badSrc, 'utf8')
    writeFileSync(good, `const x = require('safe-buffer${SL}')\n`, 'utf8')
    writeFileSync(skipMe, `require('string_decoder${SL}')\n`, 'utf8')

    const rep = scanDepTree(nm)
    ok(rep.files === 3, '扫到 3 个 js 文件', String(rep.files))
    ok(rep.mines.length === 2, '认出 2 处地雷（safe-buffer 不算）', String(rep.mines.length))
    ok(rep.mines.every((m) => m.file && m.spec === `string_decoder${SL}`), '每处都带 file 和 spec')

    const skipped = scanDepTree(nm, { skipUnder: [join(nm, 'myown')] })
    ok(skipped.mines.length === 1, 'skipUnder 生效：本包目录（含备份）不扫', String(skipped.mines.length))

    const goodBefore = readFileSync(good, 'utf8')
    const res = patchLandmines(rep)
    ok(res.patched === 2 && res.failed.length === 0, '修补 2 处、无失败', `patched=${res.patched} failed=${res.failed.length}`)
    ok(readFileSync(bad, 'utf8') === badSrc.replace(`require('string_decoder${SL}')`, "require('string_decoder')"), '坏文件改对了（斜杠没了，其它字节原样）')
    ok(readFileSync(good, 'utf8') === goodBefore, '干净文件一个字节没动')

    const again = scanDepTree(nm)
    ok(again.mines.length === 0, '再扫一遍是干净的（幂等）')

    const dryFile = join(nm, 'fake-stream', 'lib', 'dry.js')
    const drySrc = `require('process${SL}')\n`
    writeFileSync(dryFile, drySrc, 'utf8')
    const dry = patchLandmines(
      { mines: landminesInText(drySrc).map((m) => ({ ...m, file: dryFile })) },
      { dryRun: true },
    )
    ok(dry.patched === 1 && readFileSync(dryFile, 'utf8') === drySrc, 'dryRun 只报数、不落盘', `patched=${dry.patched}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ── ③b 别改我们自己的包（`link:`/junction 会把 node_modules 指回仓库）────────────
section('③b 自己的包是禁区')
{
  /* 2026-10-20 真踩：`node_modules/dsh-mc-agent` 是 `link:` 出来的 junction，指着我们的源码；
   * 修复器顺着它爬进仓库，把本文件里**当样本用的字面量**改干净了 —— 自检从此永远 0 命中，
   * 而且看不出来（断言退化成 x === x）。 */
  const tmp = mkdtempSync(join(tmpdir(), 'dep-guard-link-'))
  try {
    const nm = join(tmp, 'node_modules')
    mkdirSync(nm, { recursive: true })
    const link = join(nm, 'self-link')
    let linked = false
    try {
      symlinkSync(PACKAGE_ROOT, link, process.platform === 'win32' ? 'junction' : 'dir')
      linked = true
    } catch { /* 没权限建链接：下面那条 ensureDepGuard 断言仍然有效 */ }
    const rep = scanDepTree(nm, { skipUnder: [PACKAGE_ROOT] })
    ok(rep.files === 0, '指向本包目录的链接被整枝跳过（一个文件都不扫）', `files=${rep.files}`)
    ok(linked, '（真的建了 junction 实测）', linked ? '' : '这台机器建不了链接，只验兜底那条')
    const guard = ensureDepGuard({ roots: [nm], patch: false })
    ok(guard.mines.every((m) => !m.file.startsWith(PACKAGE_ROOT)), '报告里没有我们自己仓库里的文件')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ── ④ 宿主那句报错的识别 ─────────────────────────────────────────────────────
section('④ 报错识别')
{
  const hostMsg = 'createRequire.resolve.paths is not a function or its return value is not iterable'
  ok(isLandmineError(new TypeError(hostMsg)), '认得出宿主那句话')
  ok(isLandmineError(new Error("Cannot find module 'string_decoder/' — not iterable")), '认得出变体')
  ok(!isLandmineError(new Error('Cannot read properties of undefined (reading "x")')), '别的 TypeError 不认（别乱吞）')
  ok(!isLandmineError(null) && !isLandmineError(undefined), '空值不抛')
}

// ── ⑤ 三条防线都接上了 ───────────────────────────────────────────────────────
section('⑤ 三条防线接上了')
{
  const conn = read('src/connection.mjs')
  ok(!/^import[^\n]*mineflayer/m.test(conn), 'connection.mjs 不再静态 import mineflayer（静态就来不及修）')
  ok(/export async function ensureMineflayer/.test(conn), '有 ensureMineflayer() 懒加载器')
  ok(/await import\('mineflayer'\)/.test(conn), '用动态 import 拿 mineflayer')
  ok(/if \(!isLandmineError\(err\)\) throw err/.test(conn), '只对这颗雷自愈，别的错照抛')
  ok(/const mineflayer = await ensureMineflayer\(/.test(conn), 'createBot 之前真的走了它')
  ok(/DSH_MC_AGENT_DEP_GUARD/.test(conn), '有 DSH_MC_AGENT_DEP_GUARD 开关')

  const core = read('src/core.mjs')
  ok(!/^import[^\n]*mineflayer/m.test(core), 'core.mjs 也不静态 import mineflayer（它会把整条链拉起来）')

  const pkg = JSON.parse(read('package.json'))
  ok(typeof pkg.scripts?.postinstall === 'string' && pkg.scripts.postinstall.includes('fix-mc-deps'), 'postinstall 会跑修复脚本', String(pkg.scripts?.postinstall))
  ok((pkg.files ?? []).includes('tools/fix-mc-deps.mjs'), 'files 里带上了 tools/fix-mc-deps.mjs（否则装完就没有它）')
  ok((pkg.scripts?.['fix:deps'] ?? '').includes('fix-mc-deps'), '留了 fix:deps 手动入口')
}

// ── ⑥ 默认扫描根 ─────────────────────────────────────────────────────────────
section('⑥ 默认扫描根')
{
  const roots = defaultDepRoots()
  ok(Array.isArray(roots), 'defaultDepRoots() 返回数组')
  ok(roots.length >= 1 && roots.every((r) => statSync(r).isDirectory()), '每个根都是真目录', roots.join(' | '))
  ok(roots.every((r, i) => !roots.some((o, j) => j !== i && r.startsWith(o + sep))), '没有互相嵌套的根（同一棵树不扫两遍）')
  ok(Array.isArray(dshProfiles()), 'dshProfiles() 返回数组（没有 profile 时是空数组）')
  ok(typeof PACKAGE_ROOT === 'string' && PACKAGE_ROOT.length > 0, 'PACKAGE_ROOT 算出来了')
}

// ── ⑦ 报告措辞 ───────────────────────────────────────────────────────────────
section('⑦ 报告措辞')
{
  ok(/干净/.test(describeDepGuard({ scanned: 12, mines: [], patched: 0, failed: [] })), '干净时有"干净"')
  ok(/已就地改/.test(describeDepGuard({ scanned: 12, mines: [{ file: 'a.js', spec: 'string_decoder/', name: 'string_decoder' }], patched: 1, failed: [] })), '修完说"已就地改"')
  ok(/还没修/.test(describeDepGuard({ scanned: 12, mines: [{ file: 'a.js', spec: 'string_decoder/', name: 'string_decoder' }], patched: 0, failed: [] })), '没修时说"还没修"')

  const real = ensureDepGuard({ roots: [], patch: false })
  ok(real.mines.length === 0 && real.scanned === 0, 'roots 为空时不炸、报告 0')
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

/* fileURLToPath 只是为了让 lint 知道它被用过（别的自检也从这里抄了同一行） */
void fileURLToPath
