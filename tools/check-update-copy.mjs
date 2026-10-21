/**
 * 自检：**复制安装（目录里没有 `.git`）时的「覆盖式更新」**
 * 起因 = 用户 2026-10-20 在 Windows 服务器上遇到「插件不是git安装的是直接复制的，这个更新就用不了了」。
 *
 * 验的是：
 *   ① 认出"不是 git 仓库"就切 `mode:'copy'`，别直接报死；
 *   ② 远端顺序是 **Gitee → GitHub**（匿名可拉，GitHub 在那边可能超时）；
 *   ③ 覆盖（`cpSync`）**跳过** `.git` 与 `node_modules` —— 仓库元数据和宿主装的依赖都不能动；
 *   ④ 顺序必须是"先整份备份 → 再覆盖 → 最后写装过哪个提交的标记"，任何一步都不许颠倒；
 *   ⑤ 落后几个提交靠标记里的提交号在浅 clone 里数（这里真起一个 git 仓库实测一遍）；
 *   ⑥ 前端认 `mode:'copy'`：按钮改叫「覆盖到最新」、多一行「安装方式」。
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, cpSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra !== undefined ? ' → ' + extra : '')) }
}
const section = (t) => console.log('\n' + t)
const TMP = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); TMP.push(d); return d }
const root = new URL('..', import.meta.url)
const idx = readFileSync(new URL('index.js', root), 'utf8')
const cli = readFileSync(new URL('client.js', root), 'utf8')

/** 从 index.js 里切出某个箭头函数/函数的源码（到下一个同缩进的 `\n    const ` 为止） */
const bodyOf = (src, marker) => {
  const at = src.indexOf(marker)
  if (at === -1) return ''
  const rest = src.slice(at)
  const end = rest.slice(marker.length).search(/\n {4}(?:const|let|if|\/\*|\/\*\*)/)
  return end === -1 ? rest : rest.slice(0, marker.length + end)
}

/* ─────────────── ① 认出"不是 git 仓库"就切复制安装 ─────────────── */
section('① 不是 git 仓库 ⇒ 切 copy 模式（而不是报死）')
ok(/data\.mode = 'copy'/.test(idx), 'checkUpdate 里会给 data.mode = copy')
ok(/await fillCopyUpdate\(data\)/.test(idx), '走 fillCopyUpdate 去临时 clone 比对')
ok(/data\.mode = 'git'/.test(idx), '是 git 仓库时标记 mode = git')
ok(!/这种安装方式没有"新版本"可拉，只能手动覆盖/.test(idx), '旧的"只能手动覆盖"那句死话已经删掉')
ok(/const fillCopyUpdate = async \(data\) =>/.test(idx), 'fillCopyUpdate 存在')
ok(/const applyUpdateCopy = async \(info\) =>/.test(idx), 'applyUpdateCopy 存在')
ok(/if \(info\.mode === 'copy'\) return await applyUpdateCopy\(info\)/.test(idx), 'applyUpdate 按 mode 分流')

/* ─────────────── ② 远端顺序 ─────────────── */
section('② 远端顺序：Gitee 优先、GitHub 兜底')
{
  const m = idx.match(/const UPDATE_REMOTES = \[([\s\S]*?)\]/)
  ok(m !== null, '有 UPDATE_REMOTES 数组')
  const urls = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
  ok(urls.length >= 2, `至少两个源（实际 ${urls.length}）`, urls.join(', '))
  ok(urls[0]?.includes('gitee.com'), '第一个是 gitee', urls[0])
  ok(urls.some((u) => u.includes('github.com')), '包含 github 兜底')
  ok(!urls.some((u) => u.includes('@')), '远端地址里**不带令牌**', urls.join(', '))
}

/* ─────────────── ③ 覆盖跳过 .git / node_modules ─────────────── */
section('③ 覆盖时不碰 .git 与 node_modules')
{
  const keepOut = bodyOf(idx, 'const copyKeepOut = (srcPath) =>')
  ok(keepOut.length > 0, 'copyKeepOut 存在')
  ok(/'\.git'/.test(keepOut), '跳过 .git')
  ok(/'node_modules'/.test(keepOut), '跳过 node_modules')
  ok(/\.bak-/.test(keepOut), '跳过旧备份目录（别把备份又抄一遍）')
  /* 真跑一遍 cpSync：过滤函数照抄进来，验 node_modules/.git 真没被带过去 */
  const src = mk('wc-upcopy-src-')
  mkdirSync(join(src, 'src'), { recursive: true })
  mkdirSync(join(src, 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(src, '.git', 'objects'), { recursive: true })
  writeFileSync(join(src, 'index.js'), 'x', 'utf8')
  writeFileSync(join(src, 'src', 'a.mjs'), 'x', 'utf8')
  writeFileSync(join(src, 'node_modules', 'x', 'i.js'), 'x', 'utf8')
  const dst = mk('wc-upcopy-dst-')
  cpSync(src, dst, {
    recursive: true, force: true,
    filter: (p) => {
      const name = p.split(/[\\/]/).pop()
      if (name === '.git' || name === 'node_modules') return false
      if (name.startsWith('.bak-') || /\.bak-\d{8}-\d{6}$/.test(name)) return false
      return true
    },
  })
  ok(existsSync(join(dst, 'index.js')), '代码文件被复制')
  ok(existsSync(join(dst, 'src', 'a.mjs')), '子目录被复制')
  ok(!existsSync(join(dst, 'node_modules')), 'node_modules 没被复制')
  ok(!existsSync(join(dst, '.git')), '.git 没被复制')
}

/* ─────────────── ④ 备份 → 覆盖 → 标记 的顺序 ─────────────── */
section('④ 顺序：先备份 → 再覆盖 → 最后写标记')
{
  const apply = bodyOf(idx, 'const applyUpdateCopy = async (info) =>')
  ok(apply.length > 0, 'applyUpdateCopy 源码取到')
  const iBackup = apply.indexOf('backup = backupPluginDir()')
  const iCopy = apply.indexOf('copyIntoPluginDir(clone.dir)')
  const iMark = apply.indexOf('INSTALL_MARK')
  ok(iBackup > -1 && iCopy > -1 && iMark > -1, '三段都在', `${iBackup}/${iCopy}/${iMark}`)
  ok(iBackup < iCopy, '备份在覆盖**之前**')
  ok(iCopy < iMark, '标记在覆盖**之后**（没覆盖成功就不该说装好了）')
  ok(/备份失败，先不动手/.test(apply), '备份失败就不动手')
  ok(/覆盖中途出错（备份在/.test(apply), '覆盖出错时把备份路径告诉用户')
  ok(/needRestart: true/.test(apply), '提醒要重启才生效')
  ok(!/\bpull\b/.test(apply), 'copy 模式里**不出现** git pull')
}

/* ─────────────── ⑤ 落后提交数：浅 clone 里按标记的提交号数 ─────────────── */
section('⑤ 落后几个提交（真起一个 git 仓库实测）')
{
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const repo = mk('wc-upcopy-repo-')
  const ident = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t']
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'CHANGELOG.md'), '## [未发布]\n\n### 一\n- a\n', 'utf8')
  git(repo, ...ident, 'add', '-A')
  git(repo, ...ident, 'commit', '-qm', 'c1')
  const c1 = git(repo, 'rev-parse', '--short', 'HEAD')
  writeFileSync(join(repo, 'CHANGELOG.md'), '## [未发布]\n\n### 二\n- b\n', 'utf8')
  git(repo, ...ident, 'add', '-A')
  git(repo, ...ident, 'commit', '-qm', 'c2')

  const parent = mk('wc-upcopy-clone-')
  const clone = join(parent, 'repo')
  const url = 'file:///' + repo.replace(/\\/g, '/')
  execFileSync('git', ['clone', '--depth', '30', '--quiet', url, clone], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const cnt = git(clone, 'rev-list', '--count', `${c1}..HEAD`)
  ok(cnt === '1', '标记里的提交号能数出落后 1 个提交', cnt)
  const lg = git(clone, 'log', '--no-decorate', '--pretty=%h\t%s', `${c1}..HEAD`)
  ok(lg.split(/\r?\n/).filter(Boolean).length === 1, '能列出这一个提交的标题', lg)
  ok(lg.includes('c2'), '列出来的是**新的**那个（c2）', lg)
  ok(git(clone, 'rev-list', '--count', `HEAD..HEAD`) === '0', '同一个提交 ⇒ 落后 0')
  ok(/rev-list', '--count', `\$\{mark\.commit\}\.\.HEAD`/.test(idx), 'fillCopyUpdate 正是这么数的')
}

/* ─────────────── ⑥ 前端认 copy 模式 ─────────────── */
section('⑥ 更新页认 mode=copy')
ok(/const isCopy = info\?\.mode === 'copy'/.test(cli), '前端取 isCopy')
ok(/覆盖到最新/.test(cli), '按钮文案「覆盖到最新」')
ok(/安装方式/.test(cli), '多一行「安装方式」')
ok(/info\?\.forcePull === true/.test(cli), '同版本号时允许「覆盖一次」（forcePull）')
ok(/forcePull: false/.test(idx), '后端默认带 forcePull: false')

/* ─────────────── ⑦ 开 DSH 查一次 ─────────────── */
section('⑦ 启动时查一次更新（用户 2026-10-21）')
ok(/const START_UPDATE_CHECK_MS = 15_000/.test(idx), '有启动检查的延时常量')
ok(/const updaterRef = \{ check: null \}/.test(idx), 'apply 作用域有个 updaterRef 盒子')
ok(/updaterRef\.check = checkUpdate/.test(idx), 'handleSettingsApi 里把 checkUpdate 递进盒子')
ok(/updaterRef\.check\?\.\(true\)/.test(idx), '启动钩子调的是 force=true 的那份')
ok(/setTimeout\(\(\) => \{[\s\S]{0,200}updaterRef\.check/.test(idx), '是用 setTimeout 推迟跑的（不阻塞启动）')
ok(/t\?\.unref\?\.\(\)/.test(idx), '定时器 unref（别拦着进程退出）')
ok(/return \(\) => clearTimeout\(t\)/.test(idx), 'ctx.effect 卸载时清掉定时器')
ok(/pluginConfig\.updateCheckOnStart !== false/.test(idx), '配置 updateCheckOnStart 能关')
ok(/DSH_MC_AGENT_UPDATE_ON_START/.test(idx), '环境变量 DSH_MC_AGENT_UPDATE_ON_START=off 也能关')
ok(/d\?\.ready === false/.test(idx), '拿不到远端时只记 debug，不打扰用户')
const cfgSrc = readFileSync(new URL('src/config.mjs', root), 'utf8')
ok(/updateCheckOnStart: true/.test(cfgSrc), '配置默认值 = true')
ok(/get updateCheckOnStart \(\)/.test(cfgSrc), '有 getter（只有显式 false 才关）')
ok(/top === 'updateCheckOnStart'/.test(cfgSrc), 'validate 认这个布尔键')

/* ─────────────── 收尾 ─────────────── */
for (const d of TMP) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 临时目录 */ } }
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
