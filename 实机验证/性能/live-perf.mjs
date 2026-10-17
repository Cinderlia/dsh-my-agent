/**
 * live-perf.mjs —— P1 实机：把「P50/P95 + 四类耗时」跑出**真数据**（用户 m11448 的第三项）
 *
 * 用户原话要点：
 *   ① 对 `mc_observe` / `mc_map` / `mc_scan` / 寻路 / 任务执行记录 **P50/P95**；
 *   ② 区分 **CPU 计算 / 等待服务器响应 / 等待事件 / 等待寻路** 四类耗时；
 *   ③ 只对"持续占用事件循环且可安全序列化"的计算启用 Worker
 *      ——「特别注意 `bot.blockAt()` 等依赖实时游戏状态的操作，不应为了并行而脱离主线程执行」。
 *
 * 离线套件（`tools/check-perf-monitor.mjs`）钉的是**算法与接线**；这个脚本补的是
 * **真链路上的数字**：工具入口包了 `perfWrap` ⇒ 真调几次 ⇒ `mc_diag` 里读回来。
 *
 * 用法：node live-perf.mjs
 * 产物：同目录 live-perf.log
 */
import { appendFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOST = '127.0.0.1'
const PORT = 25565
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 日志落盘（同 `实机验证/溺水/live-water-rig.mjs`）。
 * 🔴 以前这个脚本不写自己的日志，目录里那份 `live-perf.log` 是**手工 Tee 出来的旧运行**，
 *    里面的 `pass=23 fail=6` 是修好之前的数字 —— 仓库里留着一份"过期的红"，比没有更坏。 */
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/性能'
const LOGFILE = join(OUT, 'live-perf.log')
try { writeFileSync(LOGFILE, '') } catch { /* 忽略 */ }
const rawLog = console.log.bind(console)
console.log = (...a) => {
  rawLog(...a)
  try { appendFileSync(LOGFILE, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n') } catch { /* 忽略 */ }
}

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${'═'.repeat(6)} ${t} ${'═'.repeat(6)}`)

/* 假宿主 + 真插件（同 `实机验证/调度/live-sched.mjs`） */
const state = mkdtempSync(join(tmpdir(), 'wc-perf-state-'))
const ws = mkdtempSync(join(tmpdir(), 'wc-perf-ws-'))
mkdirSync(join(state, 'mem'), { recursive: true })
writeFileSync(join(state, 'config.json'), JSON.stringify({ memoryDir: join(state, 'mem') }, null, 2), 'utf8')
process.env.DSH_MC_AGENT_DIR = state
delete process.env.DSH_MC_AGENT_MEMORY_DIR

const tools = new Map()
const logs = []
const agent = { id: 'session-perf01', session: { header: { cwd: ws } } }
const fakeCtx = {
  logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), debug: (m) => logs.push(String(m)) },
  tools: { register: (d) => { tools.set(d.name, d); return () => {} }, guard: () => () => {} },
  agentPresets: { composedPreset: () => null, authorable: true, defaultId: 'standard', roots: [], list: async () => [], copy: async () => {} },
  webServer: { register: () => () => {} },
  workspaceRegistry: { archiveSession: async () => {} },
  systemPrompt: { context: () => () => {}, section: () => () => {}, getContextOrder: () => 100, getSectionOrder: () => 100 },
  inject: () => {},
  effect: (fn) => { try { fn() } catch (e) { logs.push('[effect] ' + e.message) } },
  set: () => {},
  get: (k) => (k === 'agents' ? { get: (sid) => (String(sid) === agent.id ? agent : null) } : undefined),
  on: () => () => {},
}
const mod = await import('../../index.js')
mod.apply(fakeCtx, mod.Config ? mod.Config({}) : {})

const exec = { agent, signal: null }
const call = async (name, args = {}) => {
  const t = tools.get(name)
  if (!t) throw new Error(`没有工具 ${name}`)
  return await t.execute(args, exec)
}
const txt = (r) => {
  if (r == null) return ''
  if (typeof r === 'string') return r
  if (typeof r.text === 'string') return r.text
  if (Array.isArray(r.result)) return r.result.join('\n')
  if (typeof r.result === 'string') return r.result
  try { return JSON.stringify(r) } catch { return String(r) }
}
const perfOf = async (reset = false) => {
  const d = await call('mc_diag', reset ? { resetPerf: true } : {})
  return (d && typeof d === 'object') ? (d.perf ?? null) : null
}
const rowOf = (snap, name) => (snap?.calls ?? []).find((c) => c.name === name) ?? null

try {
  section('前置：真连本地服')
  console.log(`  · ${txt(await call('mc_connect', { host: HOST, port: PORT })).slice(0, 90)}`)
  const stTxt = txt(await call('mc_status', {}))
  ok(/🟢|active|我在/.test(stTxt), '连上了', stTxt.slice(0, 70))
  const p0 = stTxt.match(/\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/)
  const bx = p0 ? Number(p0[1]) : 0, by = p0 ? Number(p0[2]) : 64, bz = p0 ? Number(p0[3]) : 0
  console.log(`  · 我在 (${bx},${by},${bz})`)

  /* 清一次，只统计这个脚本自己产生的样本 */
  await perfOf(true)
  const before = await perfOf()
  /* ⚠️ 清空之后**不是** 0：`perfOf()` 自己就是一次 `mc_diag` 调用，而样本是在
   *    `perfWrap` 的 `finally` 里入账的 —— 也就是说"上一次 mc_diag"那一条**必然**在。
   *    这里钉的是"别的动作的旧样本真被清掉了"。 */
  const left = (before?.calls ?? []).map((c) => c.name)
  ok(left.every((n) => n === 'mc_diag'), '`mc_diag {resetPerf:true}` 真的把**别的**样本清空了',
    `剩下的=${JSON.stringify(left)}`)

  /* ═══════════ ① 真跑五类动作 ═══════════ */
  section('① 真跑：mc_observe / mc_map / mc_scan / 寻路(mc_move) / 任务执行(mc_task)')
  const N = 4
  for (let i = 0; i < N; i++) {
    await call('mc_observe', {})
    await call('mc_map', { mode: 'floor' })
    await call('mc_scan', { radius: 8 })
    /* 寻路：来回走一小段（走同一条路 ⇒ 样本之间可比） */
    await call('mc_move', { x: bx + (i % 2 ? 5 : -5), y: by, z: bz + (i % 2 ? 5 : -5), budget: 6000 })
    await call('mc_task', { action: 'list' })
    process.stdout.write(`  · 第 ${i + 1}/${N} 轮跑完\n`)
  }
  const snap = await perfOf()
  ok(snap?.enabled === true, '性能监测是开着的', `resolutionMs=${snap?.resolutionMs}`)
  const want = ['mc_observe', 'mc_map', 'mc_scan', 'mc_move', 'mc_task']
  for (const n of want) {
    const r = rowOf(snap, n)
    ok(Boolean(r), `🔴 记到了 \`${n}\` 的样本`, r ? `n=${r.n} p50=${r.wallP50Ms}ms p95=${r.wallP95Ms}ms` : '没有这一行')
  }

  /* ═══════════ ② P50/P95 与四类耗时 ═══════════ */
  section('② P50/P95 与四类耗时（真数据）')
  const hdr = ['动作', 'n', 'p50', 'p95', 'p95CPU', 'CPU%', '等服务器', '等寻路', '等事件']
  console.log('  ' + hdr.map((h, i) => h.padEnd(i === 0 ? 14 : 9)).join(''))
  for (const n of want) {
    const r = rowOf(snap, n)
    if (!r) continue
    const cells = [
      n, String(r.n), `${r.wallP50Ms}`, `${r.wallP95Ms}`, `${r.cpuP95Ms}`,
      r.cpuRatio == null ? '—' : `${Math.round(r.cpuRatio * 100)}%`,
      `${r.wait.serverMs}`, `${r.wait.pathMs}`, `${r.wait.eventMs}`,
    ]
    console.log('  ' + cells.map((c, i) => String(c).padEnd(i === 0 ? 14 : 9)).join(''))
  }

  for (const n of want) {
    const r = rowOf(snap, n)
    if (!r) continue
    ok(r.wallP50Ms != null && r.wallP95Ms != null, `${n}：p50 / p95 都算出来了`, `p50=${r.wallP50Ms} p95=${r.wallP95Ms}`)
    ok(r.wallP95Ms >= r.wallP50Ms, `${n}：p95 ≥ p50（分位数没算反）`, `${r.wallP50Ms} ≤ ${r.wallP95Ms}`)
    /* 🔴 实机改口径（这一条原来写的是"四类加起来 ≈ 墙钟"，**是错的**）：
     *    `cpu` 是 `process.cpuUsage()` —— **整个进程**的（含 GC / Worker / V8 编译线程），
     *    不是"主线程占了多少墙钟"，所以它会**超过**墙钟（实测 `mc_observe` 410ms CPU / 377ms 墙钟）。
     *    `path` / `event` / `server` 才是**墙钟归属**：三者之和 ≤ 墙钟。
     *    寻路那一段主线程通常**也在**烧 CPU ⇒ "CPU"和"等寻路"会重叠。
     *    所以这里钉两条：①墙钟归属三项不超墙钟 ②`cpuRatio` 不许超过 1（超了要如实标 `cpuOverWall`）。 */
    const wallSide = r.wait.pathMs + r.wait.eventMs + r.wait.serverMs
    ok(wallSide <= (r.wait.wallMs ?? 0) + 2, `${n}：墙钟归属的三类（寻路/事件/服务器）之和不超墙钟`,
      `寻路 ${r.wait.pathMs} + 服务器 ${r.wait.serverMs} + 事件 ${r.wait.eventMs} = ${Math.round(wallSide * 10) / 10} ≤ ${r.wait.wallMs}`)
    ok(r.cpuRatio == null || r.cpuRatio <= 1, `${n}：\`cpuRatio\` 夹在 1 以内（超了就不是"比例"）`,
      `ratio=${r.cpuRatio} raw=${r.cpuRatioRaw}`)
    /* 超过墙钟的必须被标出来 —— 否则拿它跟 0.5 比大小会得出"它一直在烧 CPU"的错结论 */
    if (r.cpuOverWall) {
      ok(r.cpuRatioRaw > 1, `${n}：标了 \`cpuOverWall\` 就说明原始占比真超过 1（不是误标）`,
        `raw=${r.cpuRatioRaw} wall=${r.wait.wallMs} cpu=${r.wait.cpuMs}`)
    }
  }
  /* 寻路那一类**必须**真的有人上报 —— 不然"四类"里有一类永远是 0，等于没分 */
  const anyPath = want.map((n) => rowOf(snap, n)).filter(Boolean).some((r) => r.wait.pathMs > 0)
  ok(anyPath, '🔴 「等寻路」这一类真的被 `src/movement.mjs` 上报了（不是恒 0）',
    want.map((n) => `${n}:${rowOf(snap, n)?.wait?.pathMs ?? '-'}`).join(' '))

  /* ═══════════ ③ 判据：说清"值不值得搬 Worker" ═══════════ */
  section('③ Worker 判据（说清值不值得搬，而不是"看着慢就搬"）')
  ok(Array.isArray(snap?.verdict) && snap.verdict.length > 0, '`mc_diag.perf.verdict` 给了结论')
  console.log('  ' + (snap?.verdict ?? []).join('\n  '))
  const text = (snap?.verdict ?? []).join('\n')
  ok(!/CPU 密集/.test(text) || /值得搬 Worker/.test(text), '如果判成 CPU 密集，必须同时说"值得搬"', text.slice(0, 120))
  ok(/等|不要搬|没有|不够/.test(text), '🔴 结论里把"在等什么"说清楚了（慢 ≠ 该搬）', text.slice(0, 160))
  const obs = rowOf(snap, 'mc_observe')
  if (obs) {
    /* 🔴 实机逮到的：`mc_observe` 的 `cpuRatio` 会被夹到 **1**，看着"CPU 拉满" ——
     *    其实那是**进程级** CPU（读世界那一段会同步跑很久，GC / 编译线程也在烧）。
     *    正确的断言不是"占比 < 0.5"（那条在旧口径下才成立），而是
     *    "**这个占比不可信，已经如实标出来了**"。 */
    ok(obs.cpuOverWall === true && obs.cpuRatioRaw > 1,
      '🔴 `mc_observe` 的 CPU 占比超过墙钟 ⇒ 如实标 `cpuOverWall`（进程级 CPU，不是主线程占墙钟）',
      `ratio=${obs.cpuRatio} raw=${obs.cpuRatioRaw} wall=${obs.wait.wallMs} cpu=${obs.wait.cpuMs}`)
    ok(obs.cpuRatio <= 1, '`mc_observe`：夹过的占比不会超过 1（拿它比大小不会得到"110%"这种怪数）',
      `ratio=${obs.cpuRatio}`)
  }
  /* 四类不是互斥的饼图 —— 这句话必须出现在结论里，否则看表的人会把重叠当记账错误 */
  ok(/不是互斥|会重叠|别把四类/.test(text), '🔴 结论里说清了"四类不是互斥的饼图"（CPU 与等寻路会重叠）',
    text.slice(0, 200))
  /* `bot.blockAt()` 依赖实时世界 ⇒ 这一类活**不该**被判成"值得搬" */
  ok(!/blockAt/.test(text) || /不要搬/.test(text), '🔴 依赖实时游戏状态的操作没被判成"该搬"')

  section('收尾')
  console.log(`  · 全局事件循环：${JSON.stringify(snap?.loop ?? null)}`)
  console.log(`  · 汇总：${txt(await call('mc_diag', {})).split('\n').filter((l) => /perf|慢|Worker|等/.test(l)).slice(0, 6).join(' | ').slice(0, 200)}`)
  await call('mc_disconnect', {}).catch(() => {})
} catch (e) {
  fail++
  console.log(`\n💥 脚本自己炸了：${e?.stack ?? e}`)
} finally {
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`live-perf：pass=${pass} fail=${fail}`)
  process.exit(fail ? 1 : 0)
}
