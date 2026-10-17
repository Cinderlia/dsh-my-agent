/**
 * 事件循环延迟 / CPU 占用监测（2026-10-15）
 *
 * 来源：用户给的「DSH-MC-Agent 异步与多线程优化实施方案」第 3.2 步，原话是
 *   **「只有确认 CPU 计算或同步操作确实造成卡顿后，再决定是否使用 Worker。」**
 * 这个模块就是那个"确认"—— 每次工具调用记三个数：
 *
 *   · `wallMs`  —— 这次调用挂了多久（墙钟）
 *   · `cpuMs`   —— 这次调用真的烧了多少 CPU（`process.cpuUsage()` 前后差）
 *   · `loopMaxMs` / `loopP99Ms` —— 调用期间**事件循环延迟**的最大值 / 99 分位
 *
 * 判据（`perfVerdict()` 会把结论直接写成中文，`mc_diag` 的 `perf` 段原样给模型看）：
 *   · `cpuMs` 接近 `wallMs`（比值高）⇒ **CPU 密集**，会阻塞事件循环 ⇒ 值得搬进 Worker。
 *     候选：`src/map-render.mjs` 的 `floorMapOf()`/`heightmapOf()`（96×96 列 × 每列十几次
 *     **同步** `blockAt()`）、`src/png.mjs` 的 `encodePng()`、`extensions/mc_view-render.mjs` 的渲染。
 *   · `cpuMs ≪ wallMs` ⇒ 在等 I/O / 等服务器 ⇒ **不要**搬 Worker。
 *     `mc_move`（等 pathfinder）、`mc_connect`（等握手）、`mc_task`（等子动作）都是这一类。
 *   · `loopMaxMs` 很大但这次调用自己不烧 CPU ⇒ 期间**别人**在阻塞，顺着 `calls` 里的名字往下查。
 *
 * 🔴 设计纪律（和 `src/action-scheduler.mjs` 一样）：
 *   · 不 import 任何游戏库、不反向 import `core.mjs`（会循环导入）；
 *   · 关掉时**零成本**：`perfWrap()` 直接 `return fn()`，连 `hrtime` 都不取；
 *   · 只记"工具名 + 数字"，**不记参数** —— 免得把聊天内容 / 坐标 / 物品名写进日志。
 *
 * 环境变量：
 *   · `DSH_MC_AGENT_PERF` —— `off` / `0` / `false` 关掉（默认**开**：每次工具调用两次
 *     `process.hrtime.bigint()` + 一次 `process.cpuUsage()`，工具调用是"分钟级"的频率，可忽略）；
 *   · `DSH_MC_AGENT_PERF_RESOLUTION` —— 事件循环延迟直方图分辨率 ms（默认 100，最小 10）；
 *   · `DSH_MC_AGENT_PERF_KEEP` —— 每个动作留多少次样本（默认 20）。
 *
 * ⚠️ 并发调用时只记 `wall`/`cpu`，**不记** `loop*` —— 直方图是全局的，
 *    同时有两个动作在跑时"这次调用期间的延迟"分不清是谁的（宁可缺，不要假）。
 *
 * ⚠️ **主信号是 `cpuRatio`（CPU ÷ 墙钟），不是 `loop*`**：直方图的采样间隔就是 `resolution`，
 *    所以 `loop*` 天然带着一个"分辨率级"的底噪（默认 100ms 下，空转也常报几十 ms），
 *    只适合看"这次调用期间事件循环最多被堵了多久"这个量级，别拿它做精确判断。
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { AsyncLocalStorage } from 'node:async_hooks'

const OFF = new Set(['0', 'off', 'false', 'no', 'none', ''])

/** 默认开（见文件头：这是"要不要上 Worker"的唯一依据，得先有数据） */
export function perfEnabled () {
  return !OFF.has(String(process.env.DSH_MC_AGENT_PERF ?? '1').trim().toLowerCase())
}

export function perfResolution () {
  const n = Number(process.env.DSH_MC_AGENT_PERF_RESOLUTION)
  return Number.isFinite(n) && n >= 10 ? Math.floor(n) : 100
}

export function perfKeep () {
  const n = Number(process.env.DSH_MC_AGENT_PERF_KEEP)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20
}

/** ns → ms，留一位小数（`percentile()` 回的是纳秒） */
const toMs = (ns) => Math.round(Number(ns) / 1e5) / 10

/**
 * 当前正在跑的是哪个动作（给 `perfWait()` 归属用）。
 *
 * ⚠️ 为什么用 `AsyncLocalStorage` 而不是一个"当前动作"变量：等待发生在**跨 `await` 之后**，
 *    而工具调用是可以并发跑两个的 —— 用一个模块级变量记"现在是谁"，等 `await` 回来时
 *    早就被另一个动作改掉了，会把 `mc_move` 的寻路等待记到 `mc_scan` 头上。
 *    ALS 跟着异步调用链走，天然分得清。
 */
const als = new AsyncLocalStorage()

/**
 * 上报一次"等待"（`src/wait.mjs` / `src/movement.mjs` 这些叶子调）。
 *
 * 🔴 2026-10-16 审计（P1）点名的缺口：原来只有 `cpuMs` / `wallMs` 两个数，
 *    于是「等服务器响应 / 等事件 / 等寻路」三类**全挤在同一个桶里**，
 *    文案自己都只能写"在等 I/O 或等服务器"。而这三类**都不是**搬 Worker 的理由 ——
 *    搬过去只是把等待换个线程继续等。分开记，判据才说得清。
 *
 * `kind`：`'path'`（寻路）/ `'event'`（等事件）/ `'server'`（等服务器响应，显式上报的）。
 * 不在任何动作里、或者关掉时：**零成本直接返回**。
 */
export function perfWait (kind, ms) {
  if (!perfEnabled()) return
  const st = als.getStore()
  if (!st) return
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return
  const k = kind === 'path' ? 'path' : (kind === 'event' ? 'event' : 'server')
  st.wait[k] += n
}

let hist = null
let histError = null
let startedAt = 0
let inflight = 0

function ensureHist () {
  if (hist || histError) return hist
  try {
    hist = monitorEventLoopDelay({ resolution: perfResolution() })
    hist.enable()
    startedAt = Date.now()
  } catch (e) {
    /* 拿不到就算了：`perfWrap()` 照样记 wall/cpu，只是没有 loop* */
    histError = e?.message ?? String(e)
    hist = null
  }
  return hist
}

/** 工具名 → { n, wall[], cpu[], waitPath[], waitEvent[], waitServer[], loopMax[], loopP99[], sync, firstAt, lastAt } */
const stats = new Map()

function slotOf (name) {
  let s = stats.get(name)
  if (!s) {
    s = {
      n: 0, wall: [], cpu: [],
      waitPath: [], waitEvent: [], waitServer: [],
      loopMax: [], loopP99: [], sync: 0, firstAt: 0, lastAt: 0,
    }
    stats.set(name, s)
  }
  return s
}

function pushCapped (arr, v, cap) {
  arr.push(v)
  while (arr.length > cap) arr.shift()
}

const cpuMsOf = (u) => (Number(u?.user ?? 0) + Number(u?.system ?? 0)) / 1000

/**
 * 包住一次工具调用。同步 / 异步都认。
 * 关掉时**只有一次函数调用**的开销。
 *
 * ⚠️ 同步调用拿不到直方图 —— `monitorEventLoopDelay` 的采样定时器要等事件循环转一圈才触发，
 *    同步函数一返回就立即读 `h.max` 必然是 0（会误导成"没阻塞"）。所以**同步调用一律
 *    把 `loopMax` 记成 `wallMs`**：那段时间事件循环确实被这一整段堵死了，这个数字是真的。
 */
export function perfWrap (name, fn) {
  if (!perfEnabled()) return fn()
  const label = String(name ?? '?')
  const h = ensureHist()
  const cap = perfKeep()
  /* 只有"这一次是唯一在跑的"才记 loop*（直方图是全局的，并发时会张冠李戴） */
  const sole = inflight === 0
  inflight++
  if (sole && h) { try { h.reset() } catch { /* 忽略 */ } }
  const wall0 = process.hrtime.bigint()
  const cpu0 = process.cpuUsage()
  /* 这一次调用里，三类等待各花了多久（`perfWait()` 往里加） */
  const wait = { path: 0, event: 0, server: 0 }

  const finish = (sync) => {
    const wallMs = toMs(process.hrtime.bigint() - wall0)
    const c = process.cpuUsage(cpu0)
    const cpuMs = Math.round(cpuMsOf(c) * 10) / 10
    const s = slotOf(label)
    s.n++
    if (sync) s.sync++
    pushCapped(s.wall, wallMs, cap)
    pushCapped(s.cpu, cpuMs, cap)
    pushCapped(s.waitPath, Math.round(wait.path * 10) / 10, cap)
    pushCapped(s.waitEvent, Math.round(wait.event * 10) / 10, cap)
    pushCapped(s.waitServer, Math.round(wait.server * 10) / 10, cap)
    if (sole && h) {
      pushCapped(s.loopMax, sync ? wallMs : toMs(h.max), cap)
      pushCapped(s.loopP99, sync ? wallMs : toMs(h.percentile(99)), cap)
    }
    const now = Date.now()
    if (!s.firstAt) s.firstAt = now
    s.lastAt = now
    inflight--
  }

  let out
  try {
    out = als.run({ wait }, fn)
  } catch (e) {
    finish(true)
    throw e
  }
  if (!out || typeof out.then !== 'function') { finish(true); return out }
  return out.then(
    (v) => { finish(false); return v },
    (e) => { finish(false); throw e }
  )
}

const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null)

/** 和 `avg` 一样，但空样本回 0（算"等待占了多少"时 0 比 null 好算） */
const avg0 = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : 0)

/**
 * 分位数（最近邻法：第 `ceil(p/100 × n)` 个）。
 *
 * 🔴 2026-10-16 审计（P1）：原来只有**均值**和**最大值** —— 而工具耗时是长尾的，
 *    均值会被一两次超时拖走、最大值又只是"运气最差那一次"。看"值不值得搬 Worker"
 *    要看的是 **p95 是不是持续高**，不是"平均高不高"。
 */
function pct (arr, p) {
  if (!arr.length) return null
  const a = [...arr].sort((x, y) => x - y)
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))
  return a[i]
}

/**
 * 墙钟短于这个值就**不给占比**（`cpuRatio` 记 `null`，不编个 0 出来骗人）。
 *
 * ⚠️ 实测（Windows / Node 22）：`process.cpuUsage()` 的分辨率是**一个 ~15.6ms 的时钟节拍**，
 *    不是微秒 —— 5ms 忙循环报 16ms、**20ms 忙循环报 0**、60ms 报 78ms。
 *    所以任何比"两个节拍"还短的样本，`cpuMs` 只是量化噪声；拿它除墙钟算出的占比
 *    （0%、150%、whatever）**看着像数据，其实是噪声**。宁可报"判不了"，也不报假结论。
 *
 * 顺带把 `check-perf-monitor.mjs` 那条"抛错的动作 ⇒ 占比记 null"从**看运气**变成确定：
 * 以前判据是 `wallMs && …` —— 靠 `toMs` 四舍五入正好落到 0 才成立，而 `new Error()`
 * 抓栈耗时恰好在 0.05ms 上下抖 ⇒ 同一台机器上时红时绿。
 */
const RATIO_MIN_WALL_MS = 32

/**
 * 把"墙钟 / 进程 CPU"翻成占比三件套（`cpuRatio` / `cpuRatioRaw` / `cpuOverWall`）。
 *
 * 🔴 实机逮到（2026-10-16，`实机验证\性能\live-perf.mjs`）：
 *    `process.cpuUsage()` 是**整个进程**的（含 GC 线程 / Worker 线程 / V8 编译线程），
 *    **不是**"主线程占了多少墙钟" —— 所以这个比值**可能超过 1**。
 *    实测 `mc_observe`：p95 墙钟 890.9ms / p95 CPU 921ms ⇒ **110%**。
 *    超过 1 的时候它**不是一个比例**，拿它跟 0.5 比大小是错的。
 *    所以：如实夹到 1（"这段时间主线程基本没闲着"），原始值单独放 `cpuRatioRaw`，
 *    并打一个 `cpuOverWall` 让判据知道"这个占比不可信"。
 *
 * 墙钟太短也不给占比：CPU 计时在 Windows 上是一个 ~15.6ms 的节拍，
 * 比两个节拍还短的样本算出来的占比是**量化噪声**（实测 20ms 忙循环报 0ms CPU）。
 */
export function cpuShareOf (wallMs, cpuMs) {
  const bad = wallMs == null || cpuMs == null
    || !Number.isFinite(Number(wallMs)) || !Number.isFinite(Number(cpuMs))
    || wallMs < RATIO_MIN_WALL_MS
  if (bad) return { cpuRatio: null, cpuRatioRaw: null, cpuOverWall: false }
  const raw = Math.round((cpuMs / wallMs) * 100) / 100
  return { cpuRatio: Math.min(1, raw), cpuRatioRaw: raw, cpuOverWall: cpuMs > wallMs * 1.05 }
}

/** 给 `mc_diag` 的结构化快照 */
export function perfSnapshot () {
  if (!perfEnabled()) {
    return { enabled: false, note: '已用 DSH_MC_AGENT_PERF=off 关掉（想开就删掉这个环境变量）' }
  }
  const h = ensureHist()
  const calls = [...stats.entries()].map(([name, s]) => {
    const wallMs = avg(s.wall)
    const cpuMs = avg(s.cpu)
    /* 四类耗时（审计 P1 的"②"）：
     *   cpu    —— 真的烧 CPU（`process.cpuUsage()` 差）
     *   path   —— 等 pathfinder 算路（`src/movement.mjs` 上报）
     *   event  —— 等游戏事件（`src/wait.mjs` 上报）
     *   server —— 剩下的：等服务器响应 / 其它 I/O（= 墙钟 − 上面三个，负数夹到 0）
     * 四个加起来**约等于**墙钟。分开记的意义：只有 `cpu` 高才值得考虑 Worker。 */
    const waitPathMs = avg0(s.waitPath)
    const waitEventMs = avg0(s.waitEvent)
    const waitServerMs = avg0(s.waitServer)
    const restMs = Math.max(0, Math.round(((wallMs ?? 0) - (cpuMs ?? 0) - waitPathMs - waitEventMs) * 10) / 10)
    return {
      name, n: s.n, wallMs, cpuMs,
      /* p50 / p95（审计 P1 的"①"）—— 判据看 p95，不看均值 */
      wallP50Ms: pct(s.wall, 50), wallP95Ms: pct(s.wall, 95),
      cpuP50Ms: pct(s.cpu, 50), cpuP95Ms: pct(s.cpu, 95),
      /* 🔴 实机逮到的第一处（2026-10-16，`实机验证\性能\live-perf.mjs`）：
       *    `process.cpuUsage()` 是**整个进程**的（含 GC 线程 / Worker 线程 / V8 编译线程），
       *    **不是**"主线程占了多少墙钟" —— 所以这个比值**可能超过 1**。
       *    实测 `mc_observe`：p95 墙钟 890.9ms / p95 CPU 921ms ⇒ 110%。
       *    超过 1 的时候它**不是一个比例**，拿它跟 0.5 比大小是错的。
       *    如实夹到 1（"这段时间主线程基本没闲着"），并把原始值单独放 `cpuRatioRaw`、
       *    打一个 `cpuOverWall` 让判据知道"这个占比不可信"。 */
      ...cpuShareOf(wallMs, cpuMs),
      wait: {
        cpuMs: cpuMs ?? 0,
        pathMs: waitPathMs,
        eventMs: waitEventMs,
        serverMs: Math.round((waitServerMs + restMs) * 10) / 10,
        reportedServerMs: waitServerMs,
        wallMs: wallMs ?? 0,
      },
      /* 全是同步调用的动作：整段墙钟都在堵事件循环（`loopMax` 就是墙钟） */
      sync: s.sync === s.n,
      loopMaxMs: s.loopMax.length ? Math.max(...s.loopMax) : null,
      loopP99Ms: s.loopP99.length ? Math.max(...s.loopP99) : null,
    }
  }).sort((a, b) => (b.wallMs ?? 0) - (a.wallMs ?? 0))

  return {
    enabled: true,
    resolutionMs: perfResolution(),
    ...(histError ? { histogramError: histError } : {}),
    ...(startedAt ? { watchingSince: new Date(startedAt).toISOString() } : {}),
    /* 全局健康度（进程起来到现在，不 reset 的那一份） */
    loop: h ? { p50Ms: toMs(h.percentile(50)), p99Ms: toMs(h.percentile(99)), maxMs: toMs(h.max) } : null,
    calls,
    verdict: perfVerdict(calls),
  }
}

/**
 * 把数字翻成"该不该上 Worker"的结论（纯函数，测试好写）。
 *
 * 🔴 2026-10-16 审计（P1）改了三条判据：
 *   ① 看 **p95** 不看均值 —— 均值会被一两次超时拖走；
 *   ② 判"CPU 密集"用 **p95 CPU** 而不是均值 CPU；
 *   ③ "等待"**分四类说**（等寻路 / 等事件 / 等服务器 / 其它），因为
 *      「等寻路」和「等服务器」都不是搬 Worker 的理由 —— 搬过去只是换个线程继续等。
 */
export function perfVerdict (calls = []) {
  /* 兼容两种形状：`perfSnapshot()` 产出的（带 `wallP95Ms` / `wait`），
   * 以及手写的最小形状（只有 `wallMs` / `cpuMs` / `cpuRatio`）——
   * 后者按"剩下的都算等服务器"补上，判据才不会因为缺字段而漏判。 */
  const norm = (c) => {
    const wallMs = c.wallMs ?? 0
    const cpuMs = c.cpuMs ?? 0
    return {
      ...c,
      _wallP95: c.wallP95Ms ?? wallMs,
      _cpuP95: c.cpuP95Ms ?? cpuMs,
      _wait: c.wait ?? {
        cpuMs,
        pathMs: 0,
        eventMs: 0,
        serverMs: Math.max(0, wallMs - cpuMs),
        wallMs,
      },
    }
  }
  const all = calls.map(norm)
  /* 「值得搬 Worker」要同时满足三件事 —— 用户 m11448 的原话是
   * 「只对**持续占用事件循环**且**可安全序列化**的计算启用 Worker」：
   *   ① 够慢：p95 墙钟 ≥ 30ms（不到 30ms 的活，搬过去的通信开销比它本身还大）；
   *   ② 真的是 CPU 活：p95 CPU ≥ 30ms，且占比可信（`cpuOverWall` 时那个比值不是比例，不采信）；
   *   ③ **真的在堵事件循环**：整段同步（`sync === true`），或者期间事件循环 p99 延迟 ≥ 30ms。
   *      —— 只满足 ①② 不满足 ③ 的，是"CPU 忙但没堵住主线程"（活被 `await` 切碎了、
   *         或者本来就已经在别的线程上），搬它没有收益。
   * 🔴 这条 ③ 是实机补的：离线判据原来只看 ①②，于是 `mc_observe` 这种
   *    "墙钟长、CPU 也高，但一大半时间在等服务器"的动作会被判成该搬。 */
  const blocksLoop = (c) => c.sync === true || (c.loopP99Ms != null && c.loopP99Ms >= 30)
  const heavy = all.filter((c) => c._wallP95 >= 30 && c._cpuP95 >= 30 && blocksLoop(c)
    && !(c.cpuOverWall && c.sync !== true))
  const slow = all.filter((c) => c._wallP95 >= 1000)
  const out = []
  /* 贴着 bot 的工具：里面**读世界**那一段依赖实时游戏状态，搬走 = 拿过期快照做决定 */
  const BOT_COUPLED = new Set(['mc_observe', 'mc_map', 'mc_scan', 'mc_move', 'mc_dig', 'mc_build', 'mc_act', 'mc_task', 'mc_inventory', 'mc_chest', 'mc_furnace'])
  if (heavy.length) {
    out.push('🐌 CPU 密集（会阻塞事件循环，**值得搬 Worker**）：'
      + heavy.map((c) => `${c.name}（p95 墙钟 ${c._wallP95}ms / p95 CPU ${c._cpuP95}ms = ${Math.round((c.cpuRatio ?? 0) * 100)}%`
        + `${c.sync ? '，而且整段是同步的' : ''}）`).join('、'))
    const coupled = heavy.filter((c) => BOT_COUPLED.has(c.name))
    if (coupled.length) {
      out.push('⚠️ 但 `' + coupled.map((c) => c.name).join('` / `') + '` 是**贴着 bot 的**工具：'
        + '读世界那一段（`bot.blockAt()` 这类依赖实时游戏状态的操作）**必须留在主线程**，'
        + '只能把其中**纯计算**的那一段搬走（例如像素循环 / 纯数组变换）。'
        + '整段搬走 = 拿一份过期的世界快照做决定。')
    }
  }
  /* 慢但**不**烧 CPU 的：再按"在等什么"分桶说清楚（这是"②"要的四类） */
  const buckets = [
    ['pathMs', '等寻路（pathfinder 在算）'],
    ['eventMs', '等游戏事件'],
    ['serverMs', '等服务器响应 / 其它 I/O'],
  ]
  const hitOf = (c, key) => (c._wait[key] ?? 0) >= c._wait.wallMs * 0.4 && (c._wait[key] ?? 0) >= 100
  for (const [key, label] of buckets) {
    const hit = slow.filter((c) => (c.cpuRatio ?? 1) < 0.2 && hitOf(c, key))
    if (!hit.length) continue
    out.push(`⏳ ${label}（**不要**搬 Worker —— 搬过去只是换个线程继续等）：`
      + hit.map((c) => `${c.name}（p95 墙钟 ${c._wallP95}ms，其中等 ${Math.round(c._wait[key])}ms、CPU ${Math.round(c._wait.cpuMs)}ms）`).join('、'))
  }
  /* 慢、CPU 也不高，但三类等待都没占到 —— 说清楚"没归好类"，别假装知道 */
  const unclassified = slow.filter((c) => (c.cpuRatio ?? 1) < 0.2
    && !buckets.some(([key]) => hitOf(c, key)))
  if (unclassified.length) {
    out.push('❓ 慢但没归好类（看不出在等什么 —— 先别搬，看看是不是日志/GC）：'
      + unclassified.map((c) => `${c.name}（p95 墙钟 ${c._wallP95}ms / CPU ${Math.round(c._wait.cpuMs)}ms）`).join('、'))
  }
  /* 🔴 实机补的说明（2026-10-16）：四类耗时**不是互斥的饼图** ——
   *    `cpu` 是**进程级**的（含 GC / Worker / V8 编译线程），可能超过墙钟（实测 `mc_observe` 110%）；
   *    `path` / `event` / `server` 才是**墙钟归属**，三者之和 ≤ 墙钟。
   *    寻路那一段主线程通常**也在**烧 CPU ⇒ "CPU"和"等寻路"会重叠。
   *    只有在真有动作超过墙钟时才说 —— 否则每次结论都挂一段解释，看的人会当成噪声。 */
  const overWall = calls.filter((c) => c.cpuOverWall)
  if (overWall.length) {
    out.push('ℹ️ `' + overWall.map((c) => c.name).join('` / `') + '` 的 CPU 占比**超过了 100%**（已夹到 1，原始值在 `cpuRatioRaw`）：'
      + '`process.cpuUsage()` 是**整个进程**的（含 GC / Worker / 编译线程），不是"主线程占了多少墙钟"。'
      + '**四类耗时不是互斥的饼图** —— CPU 与"等寻路"会重叠（寻路那一段主线程也在烧），'
      + '判"值不值得搬"时别只看这个占比。')
  }
  if (!out.length) out.push('（还没有够多、够大的样本 —— 多跑几次 mc_map / mc_move / mc_observe 再看）')
  return out
}

/** 多行文本（`mc_diag` / 日志 / 人工看） */
export function perfText (snap = null) {
  const s = snap ?? perfSnapshot()
  if (!s.enabled) return `📊 性能监测：${s.note}`
  const lines = [`📊 性能监测（直方图分辨率 ${s.resolutionMs}ms）`]
  if (s.loop) lines.push(`  事件循环延迟（全程）：p50 ${s.loop.p50Ms}ms ｜ p99 ${s.loop.p99Ms}ms ｜ 最大 ${s.loop.maxMs}ms`)
  if (!s.calls.length) {
    lines.push('  还没采到样本。')
  } else {
    lines.push('  动作 ｜ 次数 ｜ 墙钟 p50/p95 ｜ CPU p50/p95 ｜ CPU占比 ｜ 四类耗时(cpu/寻路/事件/服务器) ｜ 期间延迟最大/p99')
    for (const c of s.calls) {
      lines.push(`  · ${c.name} ｜ ${c.n} ｜ ${c.wallP50Ms}/${c.wallP95Ms}ms ｜ ${c.cpuP50Ms}/${c.cpuP95Ms}ms ｜ `
        + `${c.cpuRatio == null ? '?' : Math.round(c.cpuRatio * 100) + '%' + (c.cpuOverWall ? `（原始 ${Math.round((c.cpuRatioRaw ?? 0) * 100)}%，别的线程也在烧）` : '')} ｜ `
        + `${Math.round(c.wait.cpuMs)}/${Math.round(c.wait.pathMs)}/${Math.round(c.wait.eventMs)}/${Math.round(c.wait.serverMs)}ms ｜ `
        + `${c.loopMaxMs == null ? '（并发，没记）' : `${c.loopMaxMs}/${c.loopP99Ms}ms${c.sync ? '（同步，整段都在堵）' : ''}`}`)
    }
    /* 有 "?" 就说清楚为什么 —— 别让人以为"占比没算出来"是坏了 */
    if (s.calls.some((c) => c.cpuRatio == null && (c.wallMs ?? 0) < RATIO_MIN_WALL_MS)) {
      lines.push(`  （占比 "?" = 样本太短（平均墙钟不足 ${RATIO_MIN_WALL_MS}ms）判不了：`
        + 'CPU 计时在 Windows 上是一个 ~15.6ms 的节拍，短样本算出来的占比是噪声，不如不报）')
    }
    /* 🔴 实机逮到的第二处：四类耗时**不是互斥的饼图**，必须说清楚，否则会被当成记账错误。 */
    lines.push('  （"四类"读法：**CPU 是进程级**（含 GC / Worker / 编译线程），可能超过墙钟 ⇒ 占比夹到 100%、'
      + '并标 `cpuRatioRaw`；**寻路 / 事件 / 服务器是墙钟归属**，三者之和 ≤ 墙钟。'
      + '寻路那一段主线程通常**也在**烧 CPU，所以"CPU"和"等寻路"会重叠 —— 别把四类当互斥的饼图。）')
    if (s.calls.some((c) => c.cpuOverWall)) {
      lines.push('  （标了 `cpuOverWall` 的动作：这段时间**别的线程也在烧 CPU**，'
        + '所以那个占比不是"主线程占了多少墙钟"，判"值不值得搬"时不能只看它。）')
    }
  }
  for (const v of s.verdict) lines.push(`  ${v}`)
  return lines.join('\n')
}

/** 清空样本（换场景重测时用） */
export function perfReset () {
  stats.clear()
  inflight = 0
  try { hist?.reset() } catch { /* 忽略 */ }
  startedAt = perfEnabled() ? Date.now() : 0
  return true
}
