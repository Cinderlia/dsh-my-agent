/**
 * 性能监测自检（`src/perf-monitor.mjs`）
 *
 * 这一套要钉死三件事：
 *   ① **关掉时零成本、零副作用**（`DSH_MC_AGENT_PERF=off` ⇒ `perfWrap()` 只多一次函数调用）；
 *   ② **判据是 `cpuRatio` 不是 `loop*`** —— `perfVerdict()` 是纯函数，各种数字组合都要试一遍，
 *      免得哪天把"在等服务器"误判成"该搬 Worker"，那就白折腾一轮；
 *   ③ **同步调用的 `loopMax` 记成墙钟** —— 直方图的采样定时器要等事件循环转一圈才触发，
 *      同步函数一返回就读 `h.max` 必然是 0（会把"堵了 120ms"报成"没阻塞"）。
 *
 *   cd <profile>/node_modules/dsh-mc-agent
 *   node tools/check-perf-monitor.mjs
 */
import { readFileSync } from 'node:fs'

const mod = await import(new URL('../src/perf-monitor.mjs', import.meta.url))
const { perfEnabled, perfResolution, perfKeep, perfWrap, perfSnapshot, perfVerdict, perfText, perfReset, perfWait } = mod

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `  → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 真烧 CPU 的忙等（`setTimeout` 会睡掉、CPU 计不上，造样本必须真转） */
const busy = (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { /* 转 */ } }

const OLD_ENV = { ...process.env }
const restore = () => {
  for (const k of ['DSH_MC_AGENT_PERF', 'DSH_MC_AGENT_PERF_RESOLUTION', 'DSH_MC_AGENT_PERF_KEEP']) {
    if (OLD_ENV[k] == null) delete process.env[k]; else process.env[k] = OLD_ENV[k]
  }
}

/* ═══════════════ ① 纯函数：判据 ═══════════════ */
section('① perfVerdict：把数字翻成"该不该搬 Worker"（纯函数）')
{
  const heavy = perfVerdict([{ name: 'mc_map', wallMs: 180, cpuMs: 170, cpuRatio: 0.94, sync: true }])
  ok(heavy.length >= 1 && /值得搬 Worker/.test(heavy[0]) && /mc_map/.test(heavy[0]),
    'CPU 密集（p95 够大 + 在堵事件循环）⇒ 判"值得搬 Worker"', JSON.stringify(heavy))
  /* 🔴 实机补的：贴着 bot 的工具被点名"值得搬"时，**必须**同时说清"只能搬纯计算那一段" ——
   *    否则模型会真去把整段（含 `bot.blockAt()`）搬走，拿过期快照做决定。 */
  ok(heavy.some((l) => /贴着 bot/.test(l) && /必须留在主线程/.test(l)),
    '🔴 点名"值得搬"时同时说清"读世界那一段必须留在主线程，只能搬纯计算"', JSON.stringify(heavy))
  const wait = perfVerdict([{ name: 'mc_move', wallMs: 9000, cpuMs: 12, cpuRatio: 0.001 }])
  ok(wait.length === 1 && /不要.*搬 Worker/.test(wait[0]) && /mc_move/.test(wait[0]),
    '🔴 在等服务器（墙钟≥1000ms 但 CPU 占比<0.2）⇒ 判"**不要**搬 Worker"', JSON.stringify(wait))
  const small = perfVerdict([{ name: 'mc_status', wallMs: 3, cpuMs: 1, cpuRatio: 0.33 }])
  ok(small.length === 1 && /还没有够多、够大的样本/.test(small[0]), '样本太小 ⇒ 明确说"还没有够多、够大的样本"')
  ok(perfVerdict([]).length === 1, '空数组也给一句结论（不返回空）')
  const both = perfVerdict([
    { name: 'mc_map', wallMs: 180, cpuMs: 170, cpuRatio: 0.94, sync: true },
    { name: 'mc_move', wallMs: 9000, cpuMs: 12, cpuRatio: 0.001 },
  ])
  ok(both.length >= 2 && /值得搬 Worker/.test(both[0]) && both.some((l) => /不要/.test(l)),
    '两种都有时两条都给（中间可能夹一条"贴着 bot"的提醒）', JSON.stringify(both))
  /* 🔴 实机补的第三条判据：**CPU 高但没堵住事件循环**的活，搬它没有收益。
   *    `sync: false` 且期间事件循环 p99 延迟很低 ⇒ 不算"持续占用事件循环"。 */
  const noBlock = perfVerdict([{ name: 'x', wallMs: 200, wallP95Ms: 200, cpuMs: 190, cpuP95Ms: 190, cpuRatio: 0.95, sync: false, loopP99Ms: 4 }])
  ok(!/值得搬/.test(noBlock.join('\n')), '🔴 CPU 高但**没堵住事件循环**（p99 只有 4ms）⇒ 不判"值得搬"', JSON.stringify(noBlock))
  const blocks = perfVerdict([{ name: 'x', wallMs: 200, wallP95Ms: 200, cpuMs: 190, cpuP95Ms: 190, cpuRatio: 0.95, sync: false, loopP99Ms: 120 }])
  ok(/值得搬/.test(blocks.join('\n')), '🔴 异步但期间事件循环 p99 120ms ⇒ 算"持续占用事件循环"，该搬', JSON.stringify(blocks))
  ok(/整段是同步的/.test(perfVerdict([{ name: 'x', wallMs: 100, cpuMs: 100, cpuRatio: 1, sync: true }])[0]),
    '同步调用在结论里额外点名"整段是同步的"（那是它比异步更该搬的理由）')
  /* 边界：cpuMs 够大但占比低 ⇒ 不算 CPU 密集（在等 I/O） */
  ok(/不要/.test(perfVerdict([{ name: 'x', wallMs: 5000, cpuMs: 60, cpuRatio: 0.012 }])[0]),
    'cpuMs 有 60 但占比 1.2% ⇒ 归"在等 I/O"，不是 CPU 密集')
  /* 边界：墙钟刚好 1000、占比刚好 0.2 ⇒ 不算"等 I/O"（阈值是 `< 0.2`） */
  ok(/还没有够多/.test(perfVerdict([{ name: 'x', wallMs: 1000, cpuMs: 200, cpuRatio: 0.2 }])[0]),
    '墙钟 1000ms / 占比正好 0.2 ⇒ 两边都不算（阈值是严格小于）')
}

/* ═══════════════ ② 采集：同步 / 异步 / 抛错 ═══════════════ */
section('② 采集：同步、异步、抛错都认')
{
  perfReset()
  await perfWrap('sync-block', () => { const t = Date.now(); while (Date.now() - t < 80) {} return 'done' })
  await perfWrap('async-wait', async () => { await sleep(120); return 'done' })
  let threw = false
  try { await perfWrap('boom', () => { throw new Error('炸了') }) } catch { threw = true }
  ok(threw, '同步抛错照原样往外抛（不吞）')
  const s = perfSnapshot()
  const by = Object.fromEntries(s.calls.map((c) => [c.name, c]))
  ok(s.enabled === true && s.calls.length === 3, '三个动作各一条样本')
  ok(by['sync-block'].wallMs >= 70 && by['sync-block'].cpuRatio >= 0.5,
    `同步阻塞 ⇒ 墙钟与 CPU 都记上了（${by['sync-block'].wallMs}ms / 占比 ${by['sync-block'].cpuRatio}）`)
  ok(by['sync-block'].sync === true, '🔴 同步调用打了 sync 标记')
  ok(by['sync-block'].loopMaxMs >= 70,
    `🔴 同步调用的 loopMax 记成墙钟（不是 0）—— 实测 ${by['sync-block'].loopMaxMs}ms`)
  ok(by['async-wait'].sync === false, '异步调用 sync = false')
  ok(by['async-wait'].wallMs >= 110 && by['async-wait'].cpuRatio < 0.2,
    `等 I/O 的墙钟在但 CPU 占比很低（${by['async-wait'].wallMs}ms / 占比 ${by['async-wait'].cpuRatio}）`)
  ok(by['boom'].n === 1 && by['boom'].cpuRatio == null,
    '抛错的动作照样记一条样本（墙钟≈0 ⇒ 占比记 null，不编个 0 出来骗人）')
  /* 🔴 短样本的占比是噪声：Windows 上 `process.cpuUsage()` 是 ~15.6ms 的节拍，
     实测 5ms 忙循环报 16ms、**20ms 忙循环报 0** —— 拿它算占比会得到 0%/150% 这种假数字。
     所以墙钟不足 RATIO_MIN_WALL_MS(32ms) 一律记 null。这条断言以前是**看运气**的：
     判据 `wallMs && …` 靠四舍五入落到 0 才成立，`new Error()` 抓栈耗时刚好在 0.05ms 上下抖。 */
  await perfWrap('too-short', () => { const t = Date.now(); while (Date.now() - t < 6) {} return 'x' })
  const short = Object.fromEntries(perfSnapshot().calls.map((c) => [c.name, c]))
  ok(short['too-short'].wallMs < 32 && short['too-short'].cpuRatio == null,
    `墙钟 < 32ms 的样本不给占比（实测 ${short['too-short'].wallMs}ms ⇒ 占比 ${short['too-short'].cpuRatio}）`)
  ok(/样本太短/.test(perfText()),
    'perfText 把 "?" 解释清楚（不是坏了，是样本太短）')
  perfReset()
  ok(s.calls[0].wallMs >= s.calls[s.calls.length - 1].wallMs, 'calls 按墙钟从大到小排（先看最慢的）')
  ok(Array.isArray(s.verdict) && s.verdict.length >= 1, 'snapshot 带 verdict')
}
{
  /* 多次调用 ⇒ 取平均，并且 n 计数 */
  perfReset()
  for (let i = 0; i < 3; i++) await perfWrap('rep', () => 1)
  const c = perfSnapshot().calls.find((x) => x.name === 'rep')
  ok(c.n === 3, '同一个动作调 3 次 ⇒ n = 3')
}
{
  /* keep 上限：样本只留最近 N 次 */
  process.env.DSH_MC_AGENT_PERF_KEEP = '2'
  perfReset()
  for (let i = 0; i < 5; i++) await perfWrap('capped', () => 1)
  const c = perfSnapshot().calls.find((x) => x.name === 'capped')
  ok(c.n === 5, 'n 记的是总次数（5）')
  restore()
}
{
  /* 并发：两个动作同时在跑 ⇒ 谁都别记 loop*（直方图是全局的，宁可缺不要假） */
  perfReset()
  const a = perfWrap('p1', async () => { await sleep(60) })
  const b = perfWrap('p2', async () => { await sleep(60) })
  await Promise.all([a, b])
  const calls = perfSnapshot().calls
  const withLoop = calls.filter((c) => c.loopMaxMs != null)
  ok(calls.length === 2 && withLoop.length <= 1,
    `🔴 并发时最多只有"第一个进来的"记 loop*（实测 ${withLoop.length} 条记了）`)
}

/* ═══════════════ ③ 开关与参数 ═══════════════ */
section('③ 开关（关掉必须零成本、零副作用）')
{
  process.env.DSH_MC_AGENT_PERF = 'off'
  ok(perfEnabled() === false, 'DSH_MC_AGENT_PERF=off ⇒ 关掉')
  perfReset()
  const r = await perfWrap('should-not-be-recorded', async () => 42)
  ok(r === 42, '关掉之后 perfWrap 照样把返回值透传')
  const s = perfSnapshot()
  ok(s.enabled === false && s.calls === undefined, '关掉之后 snapshot 说 enabled:false，不记样本')
  ok(/关掉/.test(perfText(s)), '关掉之后 perfText 说清楚是关掉的')
  for (const v of ['0', 'false', 'no', 'none', 'OFF', ' off ']) {
    process.env.DSH_MC_AGENT_PERF = v
    if (perfEnabled() !== false) { ok(false, `DSH_MC_AGENT_PERF=${JSON.stringify(v)} 应该关掉`); break }
  }
  ok(true, '0 / false / no / none / OFF / " off " 都认（大小写与空格都吃掉）')
  process.env.DSH_MC_AGENT_PERF = '1'
  ok(perfEnabled() === true, '不设 / 设成 1 ⇒ 默认开')
  restore()
}
{
  process.env.DSH_MC_AGENT_PERF_RESOLUTION = '25'
  ok(perfResolution() === 25, 'DSH_MC_AGENT_PERF_RESOLUTION 生效')
  process.env.DSH_MC_AGENT_PERF_RESOLUTION = '3'
  ok(perfResolution() === 100, '🔴 分辨率低于 10ms ⇒ 回默认 100（太密会自己变成负担）')
  process.env.DSH_MC_AGENT_PERF_RESOLUTION = '乱写'
  ok(perfResolution() === 100, '分辨率非法 ⇒ 回默认')
  restore()
  process.env.DSH_MC_AGENT_PERF_KEEP = '5'
  ok(perfKeep() === 5, 'DSH_MC_AGENT_PERF_KEEP 生效')
  process.env.DSH_MC_AGENT_PERF_KEEP = '0'
  ok(perfKeep() === 20, 'keep 为 0 ⇒ 回默认 20（不能一个都不留）')
  restore()
}
{
  perfReset()
  await perfWrap('x', () => 1)
  ok(perfReset() === true && perfSnapshot().calls.length === 0, 'perfReset() 清空样本')
  const s = perfSnapshot()
  ok(/📊 性能监测/.test(perfText(s)) && /还没采到样本/.test(perfText(s)), 'perfText 在没样本时给一句"还没采到样本"')
}
{
  perfReset()
  await perfWrap('x', () => 1)
  const t = perfText()
  ok(/动作 ｜ 次数 ｜ 墙钟 p50\/p95 ｜ CPU p50\/p95 ｜ CPU占比 ｜ 四类耗时/.test(t), 'perfText 有表头（P50/P95 + 四类耗时）')
  ok(/· x ｜ 1 ｜/.test(t), 'perfText 每个动作一行')
}

/* ═══════════════ ③b P50/P95 + 四类耗时（2026-10-16 审计 P1） ═══════════════ */
section('③b P50 / P95（判据看 p95，不看均值）')
{
  perfReset()
  /* 造一组**长尾**样本：9 次快（约 1ms）+ 1 次慢（60ms）。
   * 均值会被那次慢的拖到 ~7ms，而 p95 会如实报出 60 —— 这正是"要不要搬 Worker"要看的东西。 */
  for (let i = 0; i < 9; i++) await perfWrap('t', () => busy(1))
  await perfWrap('t', () => busy(60))
  const c = perfSnapshot().calls.find((x) => x.name === 't')
  ok(c.wallP50Ms != null && c.wallP95Ms != null, '快照里同时有 p50 和 p95', `p50=${c.wallP50Ms} p95=${c.wallP95Ms}`)
  ok(c.wallP95Ms > c.wallP50Ms, '🔴 p95 明显高于 p50（长尾被如实报出来）', `p50=${c.wallP50Ms} p95=${c.wallP95Ms}`)
  ok(c.wallP95Ms >= 55, 'p95 抓到了那次 60ms 的慢样本', `p95=${c.wallP95Ms}`)
  ok(c.wallMs < c.wallP95Ms, '🔴 均值**低于** p95 —— 所以"只看均值"会漏掉长尾', `均值=${c.wallMs} p95=${c.wallP95Ms}`)
  ok(c.cpuP50Ms != null && c.cpuP95Ms != null, 'CPU 也有 p50/p95')
  ok(perfVerdict([{ name: 't', wallMs: 7, wallP95Ms: 60, cpuMs: 7, cpuP95Ms: 60, cpuRatio: 0.9, sync: true }])[0].includes('值得搬 Worker'),
    '🔴 判"CPU 密集"看的是 p95 CPU（均值 7ms 根本够不到 30ms 那条线）')
}

section('③c 四类耗时：等寻路 / 等事件 / 等服务器分得开')
{
  perfReset()
  /* 一个"慢但几乎不烧 CPU、而且明确是在等寻路"的动作（真的等，不然"四类≈墙钟"这条不成立） */
  await perfWrap('mc_move', async () => {
    const t0 = Date.now(); await sleep(50); perfWait('path', Date.now() - t0)
    const t1 = Date.now(); await sleep(50); perfWait('path', Date.now() - t1)
  })
  const c = perfSnapshot().calls.find((x) => x.name === 'mc_move')
  ok(c.wait.pathMs >= 90 && c.wait.pathMs <= 140, '🔴 两次上报累加到同一次调用上（≈100ms）', `pathMs=${c.wait.pathMs}`)
  ok(c.wait.eventMs === 0 && c.wait.reportedServerMs === 0, '没上报的两类保持 0（不瞎猜）')
  ok(c.wait.serverMs >= 0, '"剩下的算等服务器"不为负', `serverMs=${c.wait.serverMs}`)
  /* 🔴 实机改口径（2026-10-16，`实机验证\性能\live-perf.mjs`）：四类**不是互斥的饼图** ——
   *    `cpu` 是**进程级**（含 GC / Worker / 编译线程），可能超过墙钟；
   *    `path` / `event` / `server` 才是**墙钟归属**，三者之和 ≤ 墙钟。
   *    寻路那一段主线程通常也在烧 CPU ⇒ "CPU"和"等寻路"会重叠。
   *    所以这里钉的是"墙钟归属三项 ≤ 墙钟"，不是"四项加起来等于墙钟"。 */
  ok(c.wait.pathMs + c.wait.eventMs + c.wait.serverMs <= c.wait.wallMs + 2,
    '🔴 墙钟归属的三项（寻路 / 事件 / 服务器）之和 ≤ 墙钟（没重复记账）', JSON.stringify(c.wait))
  ok(!c.cpuOverWall || c.cpuRatioRaw > 1, '`cpuOverWall` 只在原始占比真超过 1 时为真')
  ok(c.cpuRatio == null || c.cpuRatio <= 1, '🔴 `cpuRatio` 夹在 1 以内（超了就不是"比例"，不能拿去比大小）', `ratio=${c.cpuRatio} raw=${c.cpuRatioRaw}`)

  /* 🔴 实机逮到的那一条：`process.cpuUsage()` 是**整个进程**的 ⇒ `cpuMs` 可能超过墙钟。
   *    以前 `cpuRatio` 会算出 1.1（实测 `mc_observe` 就是），拿它跟 0.5 比大小是错的。
   *    现在：夹到 1、原始值留 `cpuRatioRaw`、并打 `cpuOverWall` 让判据别信它。 */
  perfReset()
  await perfWrap('overwall', async () => {
    /* 模拟"这段墙钟里别的线程也在烧"：手动灌一个大 CPU 样本没法做，
     * 所以直接验判据那一侧（下面静态断言 + 纯函数），这里只验形状字段在。 */
    await sleep(40)
  })
  const ow = perfSnapshot().calls.find((x) => x.name === 'overwall')
  ok('cpuRatioRaw' in ow && 'cpuOverWall' in ow, '快照里带 `cpuRatioRaw` 与 `cpuOverWall` 两个字段')
  ok(ow.cpuRatio <= 1, '短样本/正常样本下 `cpuRatio` 也不会超过 1', `ratio=${ow.cpuRatio}`)

  /* 归属：并发的两个动作不许互相偷等待 */
  perfReset()
  await Promise.all([
    perfWrap('a', async () => { await busy(2); perfWait('path', 40) }),
    perfWrap('b', async () => { await busy(2); perfWait('event', 30) }),
  ])
  const A = perfSnapshot().calls.find((x) => x.name === 'a')
  const B = perfSnapshot().calls.find((x) => x.name === 'b')
  ok(A.wait.pathMs === 40 && A.wait.eventMs === 0, '🔴 并发时 a 的"等寻路"没被记到 b 头上', JSON.stringify(A.wait))
  ok(B.wait.eventMs === 30 && B.wait.pathMs === 0, '🔴 并发时 b 的"等事件"也没串味', JSON.stringify(B.wait))

  /* 不在任何 perfWrap 里上报 ⇒ 静默丢弃，不报错（叶子模块可能被别处直接用） */
  perfReset()
  let threw = null
  try { perfWait('path', 10) } catch (e) { threw = e }
  ok(threw === null, '🔴 没有外层动作时 perfWait 静默返回（叶子模块不因为监测而报错）')

  /* 判据：等寻路 ⇒ 明确说"不要搬 Worker" */
  const v = perfVerdict([{
    name: 'mc_move', wallMs: 3000, wallP95Ms: 3000, cpuMs: 10, cpuP95Ms: 10, cpuRatio: 0.003,
    wait: { cpuMs: 10, pathMs: 2600, eventMs: 0, serverMs: 390, wallMs: 3000 },
  }])
  ok(v.some((x) => /等寻路/.test(x) && /不要.*搬 Worker/.test(x)), '🔴 等寻路 ⇒ 归"不要搬 Worker"', JSON.stringify(v))
}

/* ═══════════════ ④ 静态接线 ═══════════════ */
section('④ 静态接线')
{
  const idx = strip(read('../index.js'))
  const self = strip(read('../src/perf-monitor.mjs'))
  ok(/import \{ perfWrap, perfSnapshot, perfText, perfReset \} from '\.\/src\/perf-monitor\.mjs'/.test(idx),
    'index.js 从 src/perf-monitor.mjs 导入（不往 core.mjs 加薄包装 —— 它贴着 1000 行上限）')
  ok(/perfWrap\(spec\.name, \(\) => runScheduled\(/.test(idx),
    '🔴 唯一的工具入口 asTool.execute 包了 perfWrap（这样"每个工具"都被量到）')
  ok(/const perf = perfSnapshot\(\)/.test(idx) && /perf,/.test(idx), 'mc_diag 的返回里带 perf')
  ok(/resetPerf/.test(idx), 'mc_diag 支持 resetPerf（换场景重测）')
  /* 🔴 2026-10-17 用户实机：`mc_diag` 一次输出几万字符，AI 只想知道其中一节 ⇒ 加 `only` 分节。 */
  ok(/only: \{ type: 'string'/.test(idx), '🔴 mc_diag 支持 only（只取需要的几节）')
  ok(/const ONLY_GROUPS = \{/.test(idx) && /state: \['physicsEnabled'/.test(idx),
    '🔴 only 有分组表（state/perf/crafting/scheduler/watching/prompt/terrain/workers/connection）')
  ok(/if \(!asked\.length\) return full/.test(idx), '🔴 不传 only ⇒ 原样全给（老调用行为一个字都没变）')
  ok(/picked\.unknownSections = unknown/.test(idx), '🔴 认不出的节名放进 unknownSections（不静默丢）')
  ok(/const keep = new Set\(\['online', 'version', 'position', 'mode'\]\)/.test(idx),
    '🔴 点名分节时仍**永远**带 online/version/position/mode（不然任何结论都没法落地）')
  ok(!/require\(|import .*mineflayer|prismarine/.test(self), '🔴 perf-monitor 不 import 任何游戏库（纯 Node，好测）')
  ok(!/from '\.\/core\.mjs'/.test(self), '🔴 perf-monitor 不反向 import core.mjs（会循环导入）')
  ok(/if \(!perfEnabled\(\)\) return fn\(\)/.test(self), '🔴 关掉时零成本：直接 return fn()，连 hrtime 都不取')
  ok(!/console\.log/.test(self), 'perf-monitor 自己不打 console（输出走 mc_diag / 日志）')
  const docs = read('../README.md')
  ok(/DSH_MC_AGENT_PERF/.test(docs), 'README 的配置速查里写了这几个环境变量')
  const all = read('./check-all.mjs')
  ok(/check-perf-monitor\.mjs/.test(all) && /check-action-scheduler\.mjs/.test(all),
    'check-all.mjs 的 ORDER 里登记了这两套（跑的顺序稳定）')

  /* ── 2026-10-16 审计 P1 新增：四类耗时必须有"真来源"，不能只有空桶 ── */
  const mv = strip(read('../src/movement.mjs'))
  const wt = strip(read('../src/wait.mjs'))
  ok(/import \{ perfWait \} from '\.\/perf-monitor\.mjs'/.test(mv), '🔴 movement.mjs 上报"等寻路"')
  ok(/perfWait\('path', Date\.now\(\) - pfT0\)/.test(mv), '🔴 上报点就在 `goto` 那一轮的 finally 里（continue/throw 都会记）')
  ok(/import \{ perfWait \} from '\.\/perf-monitor\.mjs'/.test(wt), '🔴 wait.mjs 上报"等事件"')
  ok(/perfWait\('event', waitedMs\)/.test(wt), '🔴 上报的是实测的 `waitedMs`')
  ok(/AsyncLocalStorage/.test(self) && /als\.run\(\{ wait \}, fn\)/.test(self),
    '🔴 归属走 AsyncLocalStorage（跨 await 才分得清是哪个动作在等）')
  ok(/st\.wait\[k\] \+= n/.test(self), 'perfWait 往"当前动作"的桶里累加')
  ok(/export function perfWait \(kind, ms\) \{\s*if \(!perfEnabled\(\)\) return/.test(self),
    '🔴 关掉时 perfWait 也零成本（第一行就 return）')
  ok(/wallP50Ms: pct\(s\.wall, 50\), wallP95Ms: pct\(s\.wall, 95\)/.test(self), '快照里有墙钟 p50/p95')
  ok(/cpuP50Ms: pct\(s\.cpu, 50\), cpuP95Ms: pct\(s\.cpu, 95\)/.test(self), '快照里有 CPU p50/p95')
  ok(/pathMs: waitPathMs/.test(self) && /eventMs: waitEventMs/.test(self) && /serverMs:/.test(self),
    '快照里有四类耗时（cpu / path / event / server）')
}

restore()
console.log(`\n${'─'.repeat(50)}`)
console.log(`check-perf-monitor：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
