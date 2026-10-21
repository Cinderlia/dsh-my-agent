/*
 * 移动那一层：现在只有两个"原地按/松控制位"的小原语 —— `jump` 与 `swimUp`。
 *
 * 大件按路线图第 ④ 条逐步搬进来：第三十五刀两个纯控制位（`jump` / `swimUp`）、
 * 第三十六刀移动主体（`walkSwim` / `walkTo` / `flyTo`）、第三十七刀 `walkPathfinder`（移动最后一块）。
 *
 * 两条都是"按住某个控制位一小会儿"：
 *   · `jump(self, ctx)` —— 原地蹦一下（爬台阶 / 从卡住里出来）。领移动号、只在还是自己时才松 jump，
 *     落地缓冲不超过本轮剩余时间；已 abort 或本轮时间用完就如实拒绝（不再固定占 520ms）。
 *   · `swimUp(self, opts, ctx)` —— 在水里按住 jump **上浮换气**（不是"跳"：水里按 jump 是浮在水面游）。
 *     判据用 `inWaterNow(b)` 而不是 `entity.isInWater`（泡在水柱里没贴水面时后者读出来是 undefined）。
 *
 * 形状：读写全是实例状态（`requireBot` / `callLeft` / `msLeft` / `abortSignal` / `position` / `_moveGen`）
 * ⇒ 第一参数收 `self`；`#beginMove` 是私有方法、模块够不着 ⇒ 由 core 的薄包装塞进 `ctx.bumpGen`
 *（迁移规矩第 28 条；`_moveGen` 本身是下划线公开字段，模块里照旧读它判"还是不是我"）。
 */
import { sleep, raceAbort, abortError, withTimeout, DESYNC_HINT } from './async-util.mjs'
import vec3pkg from 'vec3'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg
import { callBudget, callSecText, budgetSecText, CALL_BUDGET_MS } from './budget.mjs'
import { inWaterNow } from './world-observer.mjs'
import { heldText, invSnap, invUsed } from './inventory.mjs'
import { isAir, isLiquid, isPassable, isSolidBlock } from './block-names.mjs'
import { BRIDGE_FATAL } from './bridge.mjs'
import { classifyTerrainCached } from './terrain.mjs'
import { recoverFromWater } from './water-recovery.mjs'
/* 🔴 2026-10-16 审计（P1，四类耗时）：`goto` 这一段的墙钟**几乎全是"等寻路"** ——
 *    把它上报给性能监测，`mc_move` 才不会在 `perf` 里显示成"慢得可疑、要不要搬 Worker"。
 *    没人包 `perfWrap` 时它是空操作（零成本）。 */
import { perfWait } from './perf-monitor.mjs'

/**
 * 给水下恢复控制器用的执行器 —— **就是这一层已有的 `walkTo` / `swimUp`**，不另起一套按键。
 * 用户 2026-10-15 的约束原话："实际移动仍通过现有接口执行，避免另起一套按键控制、移动代次或资源锁"。
 * `noWaterRecover` 防递归：恢复过程中再走一次路时不许再次触发恢复。
 */
function recoverCtxOf (self, ctx) {
  return {
    walkTo: (s, p, o = {}) => walkTo(s, p, { arrive: o.arrive, budget: o.budget }, { ...ctx, noWaterRecover: true }),
    swimUp: (s, o) => swimUp(s, o, ctx),
  }
}

/**
 * 把走路目标的 y 收到底面：那个 y **站不住**时，往下找最近能站的一层。
 *
 * 🔴 为什么必须有（用户 2026-10-13 实机报的"搭路一直搭到空气上"）：
 *    AI 给的走路目标 y 常常是**半空**——`mc_map`/`mc_scan` 报的"地表高度"在树林里是树冠顶、
 *    在山上是最高的石头，从实体/玩家那抄来的 y 也可能是对方站在高处时的值。
 *    `goals.GoalNear` 是按**三维距离**算的，于是 pathfinder 为了"离那个 y 近一点"，
 *    会一路**垫方块把自己顶上去**（返回值里的 `pillared`）——玩家看到的就是"往空气上搭"。
 *    实机证据：`mc_move {x:10,y:68,z:-100}` 只挪了 1 格却 `pillared: 9`（目标比脚下高 9 格）。
 *
 * 判据：脚下那格是**实心**（不是空气/液体）且这一格与头上一格都能穿过（`isPassable`）。
 * 找不到就**原样返回**（跨沟搭桥那种目标本来就该让 pathfinder 自己想办法）。
 *
 * @param {object} b 机器人
 * @param {number} x 目标 x
 * @param {number} y 目标 y（可能偏高）
 * @param {number} z 目标 z
 * @returns {number} 修正后的 y
 */
export function standableY (b, x, y, z) {
  const gx = Math.floor(x); const gy = Math.floor(y); const gz = Math.floor(z)
  const at = (xx, yy, zz) => {
    try { return b.blockAt(new Vec3(xx, yy, zz)) } catch { return null }
  }
  const canStand = (yy) => {
    const u = at(gx, yy - 1, gz); const a = at(gx, yy, gz); const c = at(gx, yy + 1, gz)
    if (!u || !a || !c) return false
    if (isAir(u.name) || isLiquid(u.name)) return false
    return isPassable(a.name) && isPassable(c.name)
  }
  if (canStand(gy)) return gy
  for (let d = 1; d <= 4; d++) if (canStand(gy - d)) return gy - d
  for (let d = 1; d <= 2; d++) if (canStand(gy + d)) return gy + d
  return gy
}
/** 原地跳一下（爬台阶用） */
export async function jump (self, ctx = {}) {
  const bumpGen = ctx.bumpGen ?? (() => ++self._moveGen)
  const b = self.requireBot()
  endHoverFlight(b)   // 悬停着就别想蹦/走：先恢复重力（否则走路全废，见 endHoverFlight）
  /* 🔴 2026-10-08 审计⑥：以前固定占 520ms —— 不看预算、不认中断。
   *    探针：已 abort + `setCallDeadline(0)` 时仍按 jump 526ms 才返回（同条件 `flyTo` 1ms 就抛
   *    `mcAborted`）。用户已经点了停止，还会多做一个真实的跳跃动作。 */
  if (self.abortSignal?.aborted) throw abortError('跳跃', self.abortSignal)
  const left = self.msLeft()
  if (left <= 120) {
    throw new Error(`这一轮的 ${callSecText()}用完了（单次调用最多 ${budgetSecText()}）—— 过一会儿再叫一次 mc_move{mode:"jump"}`)
  }
  /* 🔴 审计（第四份报告②）：jump 以前**不领 `_moveGen` 号**，finally 里无条件松 jump
   *    ⇒ 会把"接管者"（另一次移动/反射层）正按着的 jump 松掉。现在领号，只在还是自己时才松。 */
  const gen = bumpGen()
  const hold = Math.max(60, Math.min(320, left - 120))
  b.setControlState('jump', true)
  try {
    await raceAbort(sleep(hold), self.abortSignal, '跳跃')
  } finally {
    if (self._moveGen === gen) { try { b.setControlState('jump', false) } catch { /* 忽略 */ } }
  }
  // 落地缓冲（别超过本轮剩余时间）
  const rest = Math.max(0, Math.min(200, self.msLeft() - 60))
  if (rest > 0) await raceAbort(sleep(rest), self.abortSignal, '跳跃')
  return { position: self.position }
}

/**
 * 上浮换气（在水里按住 jump 游泳）。**淹死的机制**是氧气（`air`）掉到 0 之后开始掉血，
 * 所以正确动作是"先浮上来换气"，而不是挖水（水/岩浆是流体，挖不掉）。
 * 一次最多 3 秒（和别的动作一样，宁可少量多次），返回 rose（涨了几格）与 air。
 */
export async function swimUp (self, { hold = 3_000 } = {}, ctx = {}) {
  const bumpGen = ctx.bumpGen ?? (() => ++self._moveGen)
  const b = self.requireBot()
  const e = b.entity
  const airOf = () => (Number.isFinite(b.oxygenLevel) ? b.oxygenLevel : null)
  const y0 = e?.position?.y ?? null
  const air0 = airOf()
  /* 🔴 2026-10-08 实机：这里以前只看 `entity.isInWater` —— 而它在**泡在水柱里但没贴水面**
   *    时读出来是 undefined（prismarine-physics 的入水 AABB 从底部缩了 0.401）。
   *    实测机器人沉在 (-31,59,261)、脚/头两格都是 water、`onGround:false`，
   *    `swimUp` 却回"我本来就没在水里" ⇒ 淹死也救不了自己。改用和挖矿守卫同一个判据。 */
  if (!inWaterNow(b)) {
    return { inWater: false, air: air0, note: '我本来就没在水里 —— 这条是给"在水里憋气"用的' }
  }
  const want0 = Number.isFinite(Number(hold)) ? Number(hold) : 9_000
  /* 🔴 2026-10-08 第四份审计报告 ①④⑧：swimUp 以前三个病一起犯 ——
   *   ① 完全不认中断（abort 后仍空转满 3 秒，`heldMs` 还是**假数据**）；
   *   ④ 预算归零时 `Math.max(200, …)` 白送 200ms（探针：`setCallDeadline(0)` ⇒ 真按了 215ms）；
   *   ⑧ `Number(hold) || 3_000` 把 `hold: 0` 当成 3000。
   *   现在：先看预算、领 `_moveGen` 号、每轮查 abort 与号、`heldMs` 报实际按住时长。 */
  const left = self.callLeft()
  if (left <= 300) {
    return {
      inWater: true, airBefore: air0, air: air0, rose: 0, heldMs: 0, reason: 'call-over', remaining: 1,
      hint: `这一轮的 ${callSecText()}用完了，我没按 —— 过一会儿再叫一次 mc_move{"mode":"swim"} 接着上浮`,
    }
  }
  /* 🔴 2026-10-19 实机（用户："swim 现在不行，得改"）：以前上限写死 3 秒 —— 水深 15+ 格时
   *    一次只升 1~3 格，松手又沉下去，看着就是原地晃。给到 10 秒（工具 12 秒超时留余量），
   *    一次调用就能真浮上来。 */
  const want = Math.max(0, Math.min(want0, 10_000, left - 300))
  if (want <= 0) {
    return { inWater: true, airBefore: air0, air: air0, rose: 0, heldMs: 0, note: 'hold 是 0（没让我按）—— 要上浮就再叫一次 mc_move{"mode":"swim"}' }
  }
  const gen = bumpGen()
  const t0 = Date.now()
  let held = 0
  let preempted = false
  try {
    b.setControlState('jump', true)
    while (Date.now() - t0 < want) {
      if (self.abortSignal?.aborted) throw abortError('上浮', self.abortSignal)
      await raceAbort(sleep(100), self.abortSignal, '上浮')
      held = Date.now() - t0
      if (self._moveGen !== gen) { preempted = true; break }              // 被别人接管了
      if (!inWaterNow(b)) break                                     // 已经出水
      const a = airOf()
      const rose = y0 != null && b.entity?.position ? b.entity.position.y - y0 : 0
      if (held > 500 && rose >= 0.4 && a != null && a >= 20) break        // 头露出水面、气在恢复
    }
  } finally {
    /* 🔴 报告②：只在**还是自己**的时候松 jump —— 否则会把接管者正按着的 jump 松掉。 */
    if (self._moveGen === gen) { try { b.setControlState('jump', false) } catch { /* 忽略 */ } }
  }
  const y = b.entity?.position?.y ?? null
  const air = airOf()
  const still = inWaterNow(b)
  if (preempted) {
    return {
      inWater: still, airBefore: air0, air, rose: y0 != null && y != null ? Math.round((y - y0) * 100) / 100 : null,
      heldMs: held, reason: 'preempted', remaining: 1,
      hint: '另一次移动把我接管了（我没再按着 jump）—— 再叫一次 mc_move{"mode":"swim"} 接着上浮',
    }
  }
  return {
    inWater: still,
    airBefore: air0, air,
    rose: y0 != null && y != null ? Math.round((y - y0) * 100) / 100 : null,
    heldMs: held,
    ...(still
      ? {
          remaining: 1,
          hint: air != null && air >= 18
            ? '已经浮到水面、气在恢复 —— 接着用 mc_move 往岸上走（不知道岸在哪就先 mc_scan 找干燥方块）'
            : '还在水里 —— 再叫一次 mc_move{"mode":"swim"} 接着上浮；水挖不掉，别去 mc_dig 水',
        }
      : { note: '已经出水了' }),
  }
}

/* ─────────── 第三十六刀：移动主体（walkTo / walkSwim / flyTo）───────────
 * 三件都在这一层：`walkTo` 是公开入口，水里先走 `walkSwim`（A* 不把水当节点），
 * 上岸再交回 `#walkPathfinder`（那个留在 core，用 `ctx.walkPathfinder` 递进来 —— 它跟
 * 移动编号 / 控制位租约 / 事件监听缠得最紧，按路线图放最后）。
 * `#beginMove` / `#releaseControls` 也是私有件，同样走 `ctx`。
 */
/**
 * 在水里"直接游"到目标附近（**绕开 pathfinder**）。
 *
 * 🔴 为什么水里不能用 pathfinder：vendor 里那份 mineflayer-pathfinder 的 A* 明确
 *    拒绝把水当节点 —— `lib/movements.js:503` `if (blockC.liquid) return // dont go underwater`、
 *    `:523` 同一句、`:571` `if (self.getBlock(node,0,0,0).liquid) return // cant jump from water`；
 *    控制器在水里只会按住 jump（`index.js:611-613`）。所以"泡在水里、目标在岸上"时
 *    它要么只给一条只有一个节点的路、要么直接 NoPath，实机表现就是**"4 秒只挪 1 格"**。
 *    直接控制 `forward + jump` 实测 **2.05~2.27 格/秒**（正好等于 prismarine-physics 的
 *    水里水平极限 `liquidAcceleration/(1-waterInertia)` = 0.02/0.2 = 0.1 格/tick），快近 10 倍。
 *    水里按 jump 不是为了"跳"，是**浮在水面**游（贴底会卡、也慢）。
 *
 * 上岸就交还给 pathfinder（返回 `outOfWater: true`），别自己在地面上走 —— 地面上它比手写按键靠谱。
 */
/* ─────────── 游泳的"按什么决定方向"（2026-10-17，用户方案：分水域控制 + 有效进度检测）───────────
 * 用户实机点出的两件事：
 *   ① 水面游和水下游用的是**同一套**控制（一直按住 jump）⇒ 目标在水下时它永远下不去，
 *      在低矮水道里会被顶在天花板上；
 *   ② 循环里没有"这一段时间到底有没有**靠近**目标"的判据 —— `moved` 报的是**总位移**，
 *      被水推着横着漂很远也算"游了很多"，可离目标一步没近。
 * 这里补两件轻量的东西：**按目标高度决定要不要上浮** + **按窗口看"有没有靠近"**。
 * ⚠️ 不新建第二套控制器：移动仍然是 `forward` + `jump` 两个控制位，代次/中断/释放一律走原有机制。
 *
 * 关于水流：`prismarine-physics` 的 `simulatePlayer` 里 `isInWaterApplyCurrent()` 会把
 * `getFlow()` 的方向**每 tick 加 0.014 到速度上**（`index.js:687-702`）⇒ 机器人**真的会被水推**。
 * 🔴 2026-10-17 复审更正：这里原先写"0.014/tick ≈ 0.28 格/秒，只有游泳速度的 1/7" —— **算错了**。
 *    0.014 是**每 tick 的速度增量**（加速度），而水里每 tick 还有横向阻尼（速度乘 0.8），
 *    稳态速度是 `a / (1 - 0.8) = 5a` ≈ 0.07 格/tick ≈ **1.4 格/秒**，和游泳速度（≈2 格/秒）**同一量级**。
 *    ⇒ 结论要分两种水：**静水**（水源方块 `level=0`，`getFlow()` 为 0）根本不受力；
 *      **流动水**（河/瀑布/排水道）里逆着强流是**游不动**的。
 *    但仍然**不做**"往上游瞄准"补偿：流向得自己从方块 `level` 推，算错方向比不算更糟，
 *    而窗口进度 + 纠偏已经能把"游不动"如实报出来。真要做，先实机量出静水/顺流/逆流的实际速度差。
 *    真正的"游不动"多数是**撞墙 / 顶到天花板 / 目标在脚下**。
 */
export const SWIM_WINDOW_MS = 600          // 观测窗口（用户建议 500–750ms）
export const SWIM_STALL_WINDOWS = 2        // 连续两个窗口没靠近才算"卡住"（别过度调整）
export const SWIM_PROGRESS_EPS = 0.2       // 一个窗口至少靠近这么多格才算有进展
/** 水流横向漂移的判定阈值（格/窗口）：超过它就反压一档方向键 */
export const SWIM_DRIFT_EPS = 0.35
export const SWIM_FIXUPS = 2               // 纠偏最多试两次，再不行就交给水下自救
export const SWIM_MIN_AIR = 6              // 气低于这个数，不管目标在哪都先上浮
export const SWIM_VERT_EPS = 0.6           // 目标比脚高/低这么多，才算"要去上一层/下一层"

/**
 * 这一轮该不该按住 jump（= 上浮）。
 *
 * 水里按 jump **不是跳**，是往上浮（`prismarine-physics` 里 `isInWater` 时 `vel.y += 0.04`）。
 * 所以它该由"目标在哪个高度"决定，而不是一直按着：
 *   · 快没气了 ⇒ 先上去（命比目标重要）；
 *   · 目标在**下面**（比脚低 `SWIM_VERT_EPS` 以上）⇒ **松开**，让它自己沉下去；
 *   · 目标在**同一层或上面** ⇒ 按着 —— 水里不按 jump 会以 ≈2 格/秒往下沉
 *     （`waterGravity 0.02` / `1-waterInertia 0.2`），横渡时非沉不可。
 * @returns {boolean}
 */
export function swimJumpWanted (b, goal, me, air) {
  if (Number.isFinite(air) && air < SWIM_MIN_AIR) return true
  if (!me) return true
  if (goal.y < me.y - SWIM_VERT_EPS) return false
  return true
}

export async function walkSwim (self, target, { arrive = 1.6, budget = self.cfg.moveBudgetMs, intent = 'near' } = {}, ctx = {}) {
  const pre = intentOf(intent)
  if (arrive === 1.6) arrive = pre.arrive
  const b = self.bot
  endHoverFlight(b)   // 悬停着就别想蹦/走：先恢复重力（否则走路全废，见 endHoverFlight）
  const goal = new Vec3(Number(target.x), Number(target.y), Number(target.z))
  const at = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
  const r2 = (n) => Math.round(n * 100) / 100
  if (!inWaterNow(b)) {
    // 本来就在岸上（`mc_move {"mode":"swim"}` 给了坐标时可能这样）：按普通走路走
    /* 🔴 2026-10-08 第四份审计报告 ⑨：这里以前把**没按 `msLeft()` 钳过**的 `budget` 直接往下传 ——
     *    平时走不到（`walkTo` 判 `isInWater` 与这里判 `#inWaterNow` 之间没有 await，读的是同一个值），
     *    但哪天 `cfg.moveBudgetMs` 变成历史遗留的大值，`withTimeout(work, budget)` 就会是几十秒。
     *    埋着的雷，照样钳一遍（`budgetAsked` 仍留原值，供 cutByCall 判"是被本轮截断还是真走不通"）。 */
    const leftMs = self.msLeft()
    const r = await ctx.walkPathfinder(goal, {
      arrive,
      intent,
      budget: Math.max(0, Math.min(callBudget(budget), leftMs)),
      budgetAsked: callBudget(budget),
    })
    return { ...r, swam: false, outOfWater: true, note: '我没在水里，这条就按普通走路走' }
  }
  const t0 = Date.now()
  const start = b.entity.position.clone()
  /* 🔴 2026-10-08 审计①：这条游泳循环以前**不认中断、也不领移动号** ——
   *    已 abort 的信号 + budget 1200ms 实测照样跑满 1313ms、forward/jump 各按 5 次
   *    （同条件 `flyTo` 1ms 就抛 mcAborted）；用户点停止后机器人还在水里游，而且它的 finally
   *    会把别人正在走的那份控制位一起松掉。现在：领号 + 每轮查 abort/号，收尾也看号。 */
  const gen = ctx.beginMove()
  const left0 = self.msLeft()
  const bd = left0 <= 100 ? 0 : Math.max(0, Math.min(callBudget(budget), left0))
  let moved = 0
  /* 窗口进度（用户方案第 4 条）：每个 `SWIM_WINDOW_MS` 看一次"离目标近了没有"。
   * ⚠️ 判据必须是**离目标变近**，不是"总位移" —— 被水推着横着漂很远也是位移。 */
  let winLeft = start.distanceTo(goal)
  let winAt = t0
  let stallWins = 0
  let fixups = 0
  let jumpOverride = null       // 纠偏时强行指定一轮"按/不按 jump"
  /* 2026-10-18 审计 P2-7：水流会把"直着游"推成斜的 —— 每个窗口量一次横向漂移，
   * 反压一档方向键；漂了很久还没靠近，就如实说"水在推你"，别让 AI 以为是自己不努力。 */
  let winFrom = start.clone?.() ?? start
  let lastStrafe = null
  let drift = null
  let driftFixes = 0
  /* 🔴 只在"该不该按"**变了**的时候才写控制位：机器人默认就是没按 jump，
   *    每一轮都写一遍 `jump: false` 除了白发包，还会让"被抢占时不松别人的控制位"这条判据失灵
   *    （收尾那一轮写的 false 会被当成"抢了新移动者的控制位"）。 */
  let lastJump = false
  let stuckWhy = null
  const airOf = () => (Number.isFinite(b.oxygenLevel) ? b.oxygenLevel : null)
  const preemptResult = (end) => ({
    arrived: false, position: at(end), ms: Date.now() - t0,
    remaining: r2(end.distanceTo(goal)), moved: r2(start.distanceTo(end)),
    via: 'swim', stuck: true, reason: 'preempted', outOfWater: !inWaterNow(b),
    hint: '这次游泳被**另一次移动**接管了：等它结束，再叫一次 mc_move 往同一个目标游就行，**不是游不动**。',
  })
  try {
    while (Date.now() - t0 < bd) {
      if (self.abortSignal?.aborted) throw abortError('游泳', self.abortSignal)
      if (self._moveGen !== gen) return preemptResult(b.entity?.position ?? start)
      const me = b.entity.position
      const left = me.distanceTo(goal)
      moved = r2(start.distanceTo(me))
      if (left <= arrive) {
        return { arrived: true, position: at(me), ms: Date.now() - t0, moved, via: 'swim', remaining: r2(left) }
      }
      // 每 250ms 重新对准：水流、撞岸、浮起来都会把朝向推偏（只对准一次会游歪）
      try { await b.lookAt(goal.offset(0, 1.0, 0), true) } catch { /* 假 bot 没有 lookAt */ }
      b.setControlState('forward', true)
      /* 🔴 上浮由"目标在哪个高度"决定（见 `swimJumpWanted`）：目标在水下就松开 jump 让它沉下去。
       *    `jumpOverride` 只在纠偏的那一轮生效，之后立刻回到按高度决定。 */
      const wantJump = jumpOverride === null ? swimJumpWanted(b, goal, me, airOf()) : jumpOverride
      if (wantJump !== lastJump) { b.setControlState('jump', wantJump); lastJump = wantJump }
      await raceAbort(sleep(250), self.abortSignal, '游泳')   // 可中断（用户点停止要立刻出来）
      jumpOverride = null
      /* 🔴 窗口进度必须用**等完之后**的位置采样（2026-10-17 复审）。
       *    原来这里直接拿循环开头那个 `me` 去算 —— `me` 只是 `b.entity.position` 的**引用**，
       *    靠"物理 tick 原地改这个 Vec3"才碰巧是对的；一旦哪次传送把 `position` 换成新对象，
       *    读到的就是 250ms 之前的旧坐标，`gained` 恒 0 ⇒ 明明在靠近也会被判"没进展"。
       *    快照下来，判据就不再依赖"别人会不会原地改它"。 */
      const sample = b.entity?.position?.clone?.() ?? b.entity?.position ?? me
      const nowLeft = sample.distanceTo(goal)
      /* ── 窗口进度：连续 `SWIM_STALL_WINDOWS` 个窗口都没靠近 ⇒ 先纠偏，纠不动就如实收手 ──
       * 用户原话："连续两个窗口没有有效进展时，才启动纠偏；一直有进展就保持原有控制"；
       * "确认通道被堵住后，再调用现有水下恢复控制器" —— 这里 `break` 出去，
       * `walkTo` 看到 `stuck:true` 就会把这一趟交给 `recoverFromWater`（找出口那套）。 */
      if (Date.now() - winAt >= SWIM_WINDOW_MS) {
        /* 上一轮的反压方向键只在那一轮有效 */
        if (lastStrafe) { try { b.setControlState(lastStrafe, false) } catch {} ; lastStrafe = null }
        /* 这一窗口实际挪了多少、横向偏了多少（垂直的不算：上浮下沉本来就该有） */
        let mvx = 0, mvz = 0
        try { mvx = sample.x - winFrom.x; mvz = sample.z - winFrom.z } catch {}
        winFrom = sample.clone?.() ?? sample
        const gx = goal.x - sample.x, gz = goal.z - sample.z
        const gl = Math.hypot(gx, gz) || 1
        const perp = (mvx * (-gz / gl) + mvz * (gx / gl))
        if (Math.abs(perp) >= SWIM_DRIFT_EPS) {
          drift = { x: r2(perp), z: r2(gl - Math.hypot(gx, gz)) }
          driftFixes++
          // 漂向哪边，就往反方向压一档（下一轮开头会松开）
          lastStrafe = perp > 0 ? 'right' : 'left'
          try { b.setControlState(lastStrafe, true) } catch {}
        }
        const gained = winLeft - nowLeft
        winLeft = nowLeft
        winAt = Date.now()
        if (gained < SWIM_PROGRESS_EPS) {
          stallWins++
          if (stallWins >= SWIM_STALL_WINDOWS) {
            if (fixups < SWIM_FIXUPS) {
              /* 纠偏：把上浮/下沉**反过来**试一轮 —— "以为该浮着"却纹丝不动时，
               * 十有八九是顶在天花板上，或者目标其实在脚下。 */
              fixups++
              stallWins = 0
              jumpOverride = !wantJump
            } else {
              stuckWhy = 'swim-stuck'
              break
            }
          }
        } else {
          stallWins = 0
        }
      }
      // 已经上岸：剩下的路交给 pathfinder（地面上它更靠谱）
      if (!inWaterNow(b) && b.entity?.onGround) break
    }
  } finally {
    if (lastStrafe) { try { b.setControlState(lastStrafe, false) } catch {} ; lastStrafe = null }
    // 只有"我还是最新那次移动"才允许松控制位（被抢占时松了会把正在走的那份一起停掉）
    if (self._moveGen === gen) ctx.releaseControls()
  }
  const end = b.entity?.position ?? start
  /* 2026-10-18 审计 Bug 2（泳：同一份三维分量，别让 water 路径只剩 `moved`）。 */
  const swimDx = r2(end.x - start.x), swimDy = r2(end.y - start.y), swimDz = r2(end.z - start.z)
  moved = r2(start.distanceTo(end))
  const left = r2(end.distanceTo(goal))
  const outOfWater = !inWaterNow(b)
  const reason = outOfWater ? 'swim-shore' : (stuckWhy ?? 'swim-budget')
  return {
    arrived: false,
    position: at(end),
    ms: Date.now() - t0,
    remaining: left,
    moved,
    movedHorizontal: r2(Math.hypot(swimDx, swimDz)),
    movedVertical: swimDy,
    moved3d: r2(Math.hypot(swimDx, swimDy, swimDz)),
    /* 水里的"实际漂移"：对抗水流 / 判断有没有被冲走就靠它（报告 P2 第 7 条） */
    delta: { x: swimDx, y: swimDy, z: swimDz },
    via: 'swim',
    /* 🔴 2026-10-18 审计：以前 `stuck: stuckWhy != null || !outOfWater` ——
     *    只要这一趟结束时人还在水里就报 stuck，哪怕它是**笔直往前游、一直在靠近目标**。
     *    上层（`walkTo`）看到 stuck 就把整趟交给 `recoverFromWater`（找出口那套），
     *    于是"正常游过去"被当成"游不动"、白烧一轮自救预算。
     *    现在只有**真的没进展**（`swim-stuck`）才算 stuck；上岸了报 `swim-shore`，
     *    时间用完报 `swim-budget`，都如实写在 `reason` 里。 */
    stuck: stuckWhy != null,
    reason,
    outOfWater,
    ...(fixups ? { fixups } : {}),
    ...(driftFixes ? { drift, driftFixes } : {}),
    hint: outOfWater
      ? `已经上岸了（游了 ${moved} 格，离目标 ${left} 格）—— 再叫一次 mc_move 到同一个目标，它会自己走完。`
      : reason === 'swim-stuck'
        ? `还在水里，**这一段确实游不过去了**：连续 ${SWIM_STALL_WINDOWS} 个窗口离目标都没靠近，把上浮/下沉反过来试了 ${fixups} 次也没用（多半是撞墙、顶在天花板上，或者那边根本不通）。**别再往这个方向硬游** —— 换个方向/换个出口，或者先上岸绕过去。`
          + (driftFixes >= 2 ? `（水流一直在横向推你：已经反压了 ${driftFixes} 次方向键 —— 能找到岸边就从岸上绕。）` : '')
        : `还在水里：游了 ${moved} 格（离目标 ${left} 格）—— 再叫一次 mc_move 往同一个目标游，会接着游。`,
  }
}

/**
 * 通过 mineflayer-pathfinder 走到目标。
 * 这是唯一的移动实现：不再保留手写的按键、盲跳、挖方块或垫脚兜底。
 * ⚠️ 唯一的例外：**在水里**先交给 `#walkSwim`（A* 不把水当节点，见它的注释）。
 */
/* ── 长路线续行（2026-10-18 审计 P1） ────────────────────────────────────────
 * 一次 `mc_move` 只有 10 秒，长路必然要"再叫一次接着走"。但同一目标反反复复走、
 * 每次只报"这一趟挪了几格"时，AI 看不出"我已经在这个目标上耗了三分钟" ——
 * 于是原样重试第四次。
 * 这里在 bot 上记一条**只读的路线账**：同一个目标（水平 3 格内、垂直 3 格内、90 秒内）
 * 连着走就累计次数/累计位移/累计耗时；连着 3 趟、平均每趟不到半格，就在 `hint` 里
 * 明说"别再原样重试"。**只记账，不改路线、不改目标** —— 怎么绕仍由 AI 决定。 */
const ROUTE_TTL_MS = 90_000
const ROUTE_SAME_R = 3

export function routeTrack (self, target, info) {
  const t = Date.now()
  const prev = self._navRoute ?? null
  const tx = Number(target?.x), tyTarget = Number(target?.y), tz = Number(target?.z)
  const same = Boolean(prev) && t - prev.at < ROUTE_TTL_MS &&
    Math.hypot(prev.target.x - tx, prev.target.z - tz) <= ROUTE_SAME_R &&
    Math.abs(prev.target.y - tyTarget) <= ROUTE_SAME_R
  const attempts = same ? prev.attempts + 1 : 1
  const rd2 = (n) => Math.round(n * 100) / 100
  const movedTotal = rd2((same ? prev.movedTotal : 0) + (Number(info?.moved) || 0))
  const elapsedMs = (same ? prev.elapsedMs : 0) + (Number(info?.ms) || 0)
  self._navRoute = { target: { x: tx, y: tyTarget, z: tz }, at: t, attempts, movedTotal, elapsedMs }
  const route = { attempts, movedTotal, elapsedMs, sameTarget: same }
  const stalled = attempts >= 3 && movedTotal < attempts * 0.5 && info?.arrived !== true
  if (!stalled) return route
  return {
    ...route,
    stalled: true,
    hint: `**已经第 ${attempts} 次走同一个目标了**，累计只挪了 ${movedTotal} 格（${Math.round(elapsedMs / 1000)} 秒）—— 别再原样重试。`
      + '先换做法：走不动就看 `blockedAhead` / `shaft`（头顶封着什么、四面哪边通），'
      + '挖掉挡路那一格、换个 `intent`（`stand`/`interact`/`same-level`）、绕到另一侧，或者用 `mc_act {mode:"bridge"}` 搭过去。',
  }
}

export async function walkTo (self, target, { arrive = 1.6, budget = self.cfg.moveBudgetMs, noTower = true, intent = 'near', waterRecover, noDig = false } = {}, ctx = {}) {
  let info = await walkToOnce(self, target, { arrive, budget, noTower, intent, waterRecover, noDig }, ctx)
  /* 🔴 2026-10-20（实机连撞两次）：vendor 的 `goal_reached` 是**全局**事件（`lib/goto.js:60` 不看 goal），
   *    别的寻路（自主层逃跑/跟随、或者上一次走路的残留 promise）到点时会顺手把**我这次** goto 一起
   *    resolve ⇒ 本次调用 45~85ms 就返回 goal-reached-elsewhere，人一步没动。以前只能让 AI 再手动叫
   *    一次；这里自己重试一次（**还剩 1.2 秒以上预算**才重试，不抢下一轮的时间）。只重试这一个 reason ——
   *    NoPath / stuck / call-over 重试是同参数撞墙，没意义。 */
  if (!info.arrived && info.reason === 'goal-reached-elsewhere' && self.msLeft() > 1_200) {
    try { ctx.stopPathing?.(self.requireBot()) } catch {}
    const retried = await walkToOnce(self, target, { arrive, budget, noTower, intent, waterRecover, noDig }, ctx)
    info = { ...retried, retriedElsewhere: true }
  }
  const route = routeTrack(self, target, info)
  if (!route?.stalled) return { ...info, route }
  return { ...info, route, hint: `${info.hint ? info.hint + '\n' : ''}${route.hint}` }
}

async function walkToOnce (self, target, { arrive = 1.6, budget = self.cfg.moveBudgetMs, noTower = true, intent = 'near', waterRecover, noDig = false } = {}, ctx = {}) {
  const b = self.requireBot()
  endHoverFlight(b)   // 悬停着就别想蹦/走：先恢复重力（否则走路全废，见 endHoverFlight）
  /* 🔴 2026-10-19 用户：「水下自救要让 ai 能开关」+「要默认开」——
   *    默认走自救，调用方显式 `waterRecover: false` 才关。 */
  if (waterRecover !== undefined) ctx = { ...ctx, waterRecover: waterRecover !== false }
  // 🔴 在水里：A* 不把水当节点（见 #walkSwim 的注释），实机表现是"4 秒挪 1 格"。
  //    先直接游；上了岸、还有时间，再把剩下的路交给 pathfinder 走完。
  //    ⚠️ 判据用 `#inWaterNow`：`entity.isInWater` 在泡水柱里会读出 undefined（实机踩过）。
  if (inWaterNow(b)) {
    const swim = await walkSwim(self, target, { arrive, budget, intent }, ctx)
    const canWalk = self.pfReady && typeof b.pathfinder?.goto === 'function'
    /* 🔴 用户点名的"水下寻路"就接在这里（2026-10-15）：**游不动了**（还泡在水里、没到目标）
     * 就交给恢复控制器 —— 它负责**找出口、选路线、复核进度**；
     * 真正移动仍然走这一层已有的 `walkTo` / `swimUp`，**不另起一套游泳按键控制**
     * （用户："建议新增模块只管理水域导航策略。实际移动仍通过现有接口执行"）。
     * `noWaterRecover` 防递归：恢复过程中再走一次路时，不许再次触发恢复。
     * 🔴 时间不够就**别开这一趟**（用户："继续用现有预算与取消机制，避免一次出口搜索
     *    耗尽整个工具调用预算"）—— 剩不到 1.5 秒时老实把"还在水里"报回去。 */
    /* 🔴 2026-10-19 用户：先要"不要自动到干燥方块"，紧接着改成「要默认开」—— 所以这一趟
     *    **默认就走**，只有调用方显式 `waterRecover: false`（`mc_move {waterRecover:false}`
     *    或 `mc_auto set {"waterRecover":false}`）才关掉。开关权在 AI 手里。 */
    /* 🔴 2026-10-20 审计（真 bug）：上面注释写的 `noWaterRecover` 防递归**从来没被读过** ——
     *    条件里只有 `ctx.waterRecover !== false`。于是"恢复→walkTo→还在水里→再恢复"可以
     *    一层层套下去，每层吃掉 900ms+，一次 10 秒的 `mc_move` 被吃光，最后返回的是最内层的 hint。
     *    现在真读它：恢复过程中（`recoverCtxOf` 传了 `noWaterRecover:true`）不再触发第二次恢复。 */
    if (swim.stuck && ctx.noWaterRecover !== true && ctx.waterRecover !== false && self.msLeft() > 1_500) {
      const rec = await recoverFromWater(self, { budgetMs: Math.min(12_000, Math.max(0, self.msLeft() - 900)) }, recoverCtxOf(self, ctx))
      const out = !inWaterNow(b)
      return {
        ...swim,
        stuck: !out,
        outOfWater: out,
        waterRecover: rec,
        hint: rec?.escaped === true
          ? `我**自己从水里出来了一趟**（${rec.note}）—— 原来的目标还要不要接着走，你看一眼再定。`
          : `还在水里${rec?.ok ? '（能喘口气了，但没出去）' : ''}，没找到出口（${rec?.reason ?? 'unknown'}）：${rec?.note ?? ''}`,
      }
    }
    if (swim.arrived || !swim.outOfWater || !canWalk) return swim
    const left = self.msLeft()
    if (left < 500) return swim
    const rest = await ctx.walkPathfinder(target, { arrive, noTower, intent, noDig, budget: Math.max(0, Math.min(callBudget(budget), left)), budgetAsked: callBudget(budget) })
    return { ...rest, swam: true, swimMoved: swim.moved, swimMs: swim.ms }
  }
  if (!self.pfReady || typeof b.pathfinder?.goto !== 'function') {
    return {
      arrived: false,
      position: { x: Math.floor(b.entity.position.x), y: Math.floor(b.entity.position.y), z: Math.floor(b.entity.position.z) },
      remaining: Number(Math.hypot(b.entity.position.x - target.x, b.entity.position.z - target.z).toFixed(2)),
      moved: 0,
      via: 'pathfinder-unavailable',
      stuck: true,
      reason: 'PathfinderUnavailable',
      hint: 'mineflayer-pathfinder 没有加载，已停止移动，避免盲跳。请重启 DSH 并检查 dsh-mc-agent.log。',
    }
  }
  /* 🔴 2026-10-08 审计⑦：以前是 `Math.max(150, Math.min(callBudget(budget), self.msLeft()))`
   *    —— `msLeft()` 已经是 0 时，`Math.min` 给出 0，外层 `Math.max` 又把它抬回 150 ⇒ 照样再跑 150ms。
   *    本轮时间真的用完了就**别开始**，如实告诉模型"再叫一次接着走"。 */
  const leftMs = self.msLeft()
  if (leftMs <= 100) {
    return {
      arrived: false,
      position: { x: Math.floor(b.entity.position.x), y: Math.floor(b.entity.position.y), z: Math.floor(b.entity.position.z) },
      remaining: Number(Math.hypot(b.entity.position.x - target.x, b.entity.position.z - target.z).toFixed(2)),
      moved: 0,
      via: 'pathfinder',
      stuck: true,
      reason: 'call-over',
      hint: `这一轮的走路时间已经用完了（单次调用最多 ${budgetSecText()}）—— 直接再叫一次 mc_move 往同一个目标走，会接着走。`,
    }
  }
  return await ctx.walkPathfinder(target, {
    arrive,
    noTower,
    noDig,
    intent,
    // 🔴 单次调用 ≤11 秒：预算收进 CALL_BUDGET_MS，且不超过本轮剩余时间。
    //    走不到不是失败，是"这一轮用完了"—— 再叫一次接着走。
    //    `msLeft()` 没设截止时刻时返回 CALL_MS（11000），用完时返回 0（别再 `||` 补 10 秒）。
    budget: Math.max(0, Math.min(callBudget(budget), leftMs)),
    budgetAsked: callBudget(budget),
  })
}

/**
 * 飞到某个坐标（仅创造模式）。
 *
 * 🔴 **刻意不使用 mineflayer 的 `bot.creative.flyTo`** —— 它有两处硬伤，
 *    2026-09-15 真机（mc）踩得很惨，三个症状全部源于它：
 *
 *   ① 结尾是 `await once(bot, 'move', 0)` —— **timeout 传 0 = 永不超时**。
 *      服务端不回 move 回执就永久挂住。真机日志里 `飞行 超时（30000ms）` /
 *      `接近放置点 超时（30000ms）` 反复出现，就是这个。
 *      **表现特别坑**：客户端位移其实已经改了 → **动作生效了，但工具迟迟不返回、
 *      最后报超时**（用户原话："移动有时候已经生效了，但等很久工具才返回，返回的是超时"）。
 *
 *   ② 它调 `startFlying()` 把 `physics.gravity` 置 0，却**从不 `stopFlying()`**。
 *      一次失败就把机器人永久留在**零重力** → 之后 `walkTo` 完全失效
 *      （真机症状：fly 超时之后 walk 30s 原地不动）。
 *
 * 所以这里自己实现：小步推进 + **进度检测**（推不动就早停，不耗满预算）+ 预算上限，
 * 并且**无论如何在 finally 里恢复重力**。到位就返回，**不等服务端回执**。
 *
 * 🔴 2026-10-19（用户：「创造模式 fly 现在用不了」）—— 两个真根因，都在这一版修掉了：
 *
 *   A. **没告诉服务端"我在飞"**。`b.creative.startFlying()`（含上游 `flyTo`）只把本地
 *      `physics.gravity` 置 0，**一个包都不发**；而服务端判位移是否合法看的是
 *      **abilities 里 flying 那一位**（原版客户端起飞时发 `serverbound abilities`）。
 *      于是服务端按"空中站着乱漂"把我拉回去 → 客户端位移改了又被打回，工具报
 *      「没到目标」/`preempted`。现在起飞前/落地后都发一次：
 *      `b._client.write('abilities', { flags })`（1.21.4 该包只有 flags 一个字段）。
 *
 *   B. **位移速度超了服务端上限**。旧实现每 60ms 硬写 `b.entity.position` 挪 2 格
 *      = **约 33 m/s**（原版创造飞行上限约 10.9 m/s），就算权限对也一定被判"移动太快"
 *      而拉回。现在改成**按 tick 给速度**：每 50ms 把 `b.entity.velocity` 设成朝目标的
 *      `FLY_SPEED_PER_TICK = 0.45 格/tick ≈ 9 m/s`，由 mineflayer 的物理循环积分成位移
 *      —— 速度真实、服务端肯认，撞墙也会被物理层挡住（不再穿墙）。
 */
export const FLY_TICK_MS = 50
export const FLY_SPEED_PER_TICK = 0.45
export const ABILITY_INVULNERABLE = 0x01
export const ABILITY_FLYING = 0x02
export const ABILITY_ALLOW_FLYING = 0x04
export const ABILITY_CREATIVE = 0x08

/** 告诉服务端"我在飞 / 我落地了"（原版客户端起飞时就是这么发的）。没有连接时静默返回 false。 */
export function setFlyingAbilities (b, flying) {
  const w = b?._client?.write
  if (typeof w !== 'function') return false       // 没连接/假 bot：别炸，但别谎报成功
  const flags = ABILITY_INVULNERABLE | ABILITY_ALLOW_FLYING | ABILITY_CREATIVE | (flying ? ABILITY_FLYING : 0)
  try {
    w.call(b._client, 'abilities', { flags })
    return true
  } catch {
    return false
  }
}

/** 脚下 `depth` 格内有实心方块吗？（读不到方块 = 没加载 ⇒ 当"悬空"，宁可悬着也别掉下去） */
export function solidUnder (b, pos, depth = 3) {
  const x = Math.floor(pos.x)
  const y = Math.floor(pos.y)
  const z = Math.floor(pos.z)
  for (let d = 1; d <= depth; d++) {
    let blk = null
    try { blk = b?.blockAt?.(new Vec3(x, y - d, z)) ?? null } catch { blk = null }
    if (blk === null) return false
    if (isSolidBlock(blk.name ?? blk)) return true
  }
  return false
}

/**
 * 结束"悬停飞行"：速度归零 + 发 abilities(不 flying) + 恢复重力。
 *
 * 🔴 2026-10-19（用户选「要悬停，走路时自动落地」）：`flyTo` 飞到**空中**的目标后会保持飞行状态
 *    （原版玩家松手就是悬停），此时 `physics.gravity` 是 0 —— **任何地面移动开跑前必须先调它**，
 *    否则走路全废（这正是上游 `creative.flyTo` 从不 `stopFlying` 留下的坑）。
 */
export function endHoverFlight (b) {
  if (!b?._hoverFlying) return false
  try { b.entity.velocity = new Vec3(0, 0, 0) } catch { /* 忽略 */ }
  setFlyingAbilities(b, false)
  try { b.creative?.stopFlying?.() } catch { /* 忽略 */ }
  b._hoverFlying = false
  return true
}

export async function flyTo (self, x, y, z, { budget = CALL_BUDGET_MS } = {}, ctx = {}) {
  const b = self.requireBot()
  if (b.game?.gameMode !== 'creative') throw new Error('飞行只在创造模式可用（当前 ' + b.game?.gameMode + '）')
  const target = new Vec3(Number(x), Number(y), Number(z))
  const t0 = Date.now()
  /* 🔴 单次调用 ≤11 秒（创造模式飞远路要分几次）；`msLeft()` 用完时是 0，别 `||` 补 10 秒。
   * 🔴 2026-10-08 审计⑤⑦：默认值以前是 20_000（比单次上限还大），而且调用方**不传 budgetMs** ⇒
   *    AI 写 `budgetMs:2000` 想"飞一小段"照样跑满 10 秒；`msLeft()` 用完时又被外层 max 抬回 150ms。 */
  const leftMs = self.msLeft()
  if (leftMs <= 100) throw new Error(`这一轮的 ${callSecText()}用完了（单次调用最多 ${budgetSecText()}）—— 过一会儿再叫一次 mc_move{mode:"fly"}`)
  const bd = Math.max(0, Math.min(callBudget(budget), leftMs))
  /* 🔴 2026-10-08 第四份审计报告 ⑥⑦：flyTo 以前**不领 `_moveGen` 号**（体系外的一块）——
   *    它靠直接写 `b.entity.position` 移动，不看控制位也不看 pathfinder，
   *    所以别的移动/反射层"抢占"它时它照飞；循环里的 `sleep(60)` 也没 `raceAbort`（中断最多晚 60ms）。
   *    现在领号 + 每轮查号 + 可中断 sleep + finally 只在还是自己时 `stopFlying()`。 */
  const gen = ctx.beginMove()
  let preempted = false
  let flying = false                       // 这次调用有没有真的 startFlying（收尾要认它，不认号）
  let hovering = false                     // 收尾后是不是留在空中悬停（见 finally）
  let last = b.entity.position.clone()
  let lastProgress = Date.now()
  self._selfMovingAt = Date.now()          // 别把自己飞当成"被传送"
  try {
    setFlyingAbilities(b, true)            // 🔴 先告诉服务端我在飞，否则位移会被打回（见上面 A）
    b.creative.startFlying()
    flying = true
    while (Date.now() - t0 < bd) {
      if (self.abortSignal?.aborted) throw abortError('飞行', self.abortSignal)
      if (self._moveGen !== gen) { preempted = true; break }
      const pos = b.entity.position
      const v = target.minus(pos)
      const mag = Math.hypot(v.x, v.y, v.z)
      if (mag <= 1.5) break
      const step = Math.min(mag, FLY_SPEED_PER_TICK)   // 约 9 m/s，别超原版创造飞行上限
      b.physics.gravity = 0
      b.entity.velocity = new Vec3((v.x / mag) * step, (v.y / mag) * step, (v.z / mag) * step)
      await raceAbort(sleep(FLY_TICK_MS), self.abortSignal, '飞行')
      if (b.entity.position.distanceTo(last) > 0.3) {
        last = b.entity.position.clone()
        lastProgress = Date.now()
      } else if (Date.now() - lastProgress > 2500) {
        break                               // 推不动了（被地形挡住 / 服务端不接受），别耗满预算
      }
    }
  } finally {
    // 🔴 必须恢复重力：否则之后走路全废（见上面 ②）
    /* 🔴 报告⑥：被接管了就别动接管者的状态。
     * 🔴 报告 H7（2026-10-13）：但 `startFlying()` 是**这次调用**做的，重力必须由这次调用恢复 ——
     *    以前这里也带 `_moveGen === gen` 守卫，被抢占那条路（号变了）会跳过它，而全仓没有第二处
     *    `stopFlying` ⇒ `physics.gravity` 永久为 0（之后走路/跳跃全废，只能重连）。
     *    判据改成"我起过飞就我收"，跟号无关：别人接管的是"继续移动"，不是"替我恢复重力"。 */
    try { b.entity.velocity = new Vec3(0, 0, 0) } catch { /* 忽略 */ }
    /* 🔴 2026-10-19（用户选「要悬停，走路时自动落地」）：飞完人还在空中就**保持飞行状态悬停**
     *    （原版玩家飞到半空松手就是这样），不再往下掉。
     *    两条硬约束：① 被抢占时交给接管者，**不许**留着零重力；② 之后的 walk/jump 必须先调
     *    `endHoverFlight() &&` 恢复重力，否则走路全废（踩坑档案 209 的 ②）。 */
    hovering = flying && !preempted && !solidUnder(b, b.entity.position, 3)
    if (hovering) {
      b.physics.gravity = 0
      b._hoverFlying = true
    } else {
      setFlyingAbilities(b, false)         // 落地了要告诉服务端，不然它一直当我在飞
      if (flying) { try { b.creative.stopFlying() } catch { /* 忽略 */ } }
      b._hoverFlying = false
    }
    self._selfMovingAt = Date.now()
  }
  const p = b.entity.position
  const distance = Number(p.distanceTo(target).toFixed(2))
  const arrived = distance <= 2.5
  return {
    position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
    distance, arrived, ms: Date.now() - t0,
    ...(hovering ? { hovering: true, hint: '脚下没实物，我**悬在空中**没落地（原版飞行手感）—— 想落地或走路就 mc_move{mode:"walk"}（会自动关飞行），继续飞就再叫一次 fly。' } : {}),
    ...(preempted ? { reason: 'preempted', hint: '另一次移动把我接管了（我停了飞行）—— 再叫一次 mc_move{mode:"fly"} 往同一个点飞' } : {}),
    ...(arrived ? {} : {
      note: `没到目标（还差 ${distance} 格）。`
        + (Date.now() - t0 >= bd - 120
          ? `这一轮的 ${callSecText()}用完了（飞了 ${Math.round((Date.now() - t0) / 1000)} 秒）—— 直接再叫一次 mc_move{mode:"fly"} 往同一个点飞，会接着飞。`
          : '飞不动了：多半是**撞到地形**（物理层挡住了，往上抬一点再飞），或者服务端不认飞行权限（先确认自己是创造模式）—— 也可以改用 mc_move{mode:"walk"}。'),
    }),
  }
}

/* ══ P0-1 移动进度监控 + 自动脱困阶梯（用户 2026-10-15 方案）══════════════════
 *
 * 为什么要有这一层：vendor 的 pathfinder 只在"**3.5 秒没走到下一个路径节点**"时
 * 自己 `resetPath('stuck')`（`mineflayer-pathfinder/index.js:632`）——那只是**重算**，
 * 既不换策略，也不如实告诉模型"我卡住了"。实机表现就是用户报的：能走到附近，
 * 但绕路、卡方块边缘、反复跳跃，最后要么谎报到达、要么无限重试。
 *
 * 判据（**用户特别点名的坑**："不要只根据速度为零判断卡住"）：
 *   · 只认"**既没挪动、也没靠近**"——`剩余距离`连续 `MOVE_STUCK_MS` 没有改善才算卡住；
 *   · 跳跃、落地、等方块更新时位置本来就不前进 ⇒ "正在挖 / 正在放 / 悬空"算**正常等待**，
 *     把进度时钟往后推（最多推 `MOVE_BUSY_MAX_MS`，免得一直挖个不停就永远不判卡）。
 *
 * 脱困阶梯三级（见 `MOVE_ESCAPES`）：重算路径 → 跳跃脱困 → 后退再寻路；三级用完还是
 * 没进展就明确报 `unreachable`，**不再无限重试**。
 */
/* ── 2026-10-18 审计 P1-2：**导航意图** ────────────────────────────────
 * "到"的标准本来就不止一种：站到那一格上 / 走到旁边够得着 / 跟目标同一层再说话。
 * 以前只有一个 `arrive`，调用方只能瞎猜；猜小了走不到、猜大了报"到了"却用不了。
 * 这里把四种意图的（到点多远、能接受多大高差）固定下来，`intent` 一路传到到达复核。
 *   near       走到附近就算到（默认，兼容老行为）
 *   stand      要站到那一格上（误差 0.8 格、高差 0.6）
 *   interact   到"够得着"的位置（2.2 格内，允许高差 2.5 —— 开箱子/按按钮/砍树）
 *   same-level 必须有同一层可站的地方（高差 ≤0.9，防止站在坑底/树顶说到了） */
export const INTENTS = {
  near: { arrive: 1.6, vertTol: 1.5 },
  stand: { arrive: 0.8, vertTol: 0.6 },
  interact: { arrive: 2.2, vertTol: 2.5 },
  'same-level': { arrive: 1.6, vertTol: 0.9 },
}
/** 未知意图按 `near` 处理（不报错：模型写错一个词不该让整次移动失败）。 */
export function intentOf (intent) { return INTENTS[intent] ?? INTENTS.near }

export const MOVE_SAMPLE_MS = 600       // 采样间隔（用户建议 500–1000ms）
export const MOVE_STUCK_MS = 2400       // 连续这么久"既没挪动也没靠近" ⇒ 卡住（用户建议 2–3 秒）
export const MOVE_PROGRESS_EPS = 0.35   // 靠近这么多格才算"有进展"
export const MOVE_BUSY_MAX_MS = 6000    // 一直挖/一直悬空超过这么久，就不再当"正常等待"
export const MOVE_JUMP_MS = 320         // 跳跃脱困按住 jump 多久
export const MOVE_BACK_MS = 420         // 后退脱困按住 back 多久
/* P1：一次 `goto` 里路径被**失效**这么多次 ⇒ 别再等"没进展"了，直接进脱困阶梯。
 * 依据：vendor 自己会在 3.5s 无节点进展时 `resetPath('stuck')`，但它只会**重算同一条**；
 * 一个 goto 里失效这么多次，说明"光重算没用"（世界在变 / 一直被人挡），换策略才有意义。 */
export const MOVE_RESET_LIMIT = 4
/** 脱困阶梯（第 1 级 = `MOVE_ESCAPES[0]`）。走完还没进展 ⇒ 报 `unreachable`。 */
export const MOVE_ESCAPES = ['repath', 'jump', 'backoff']
/* 🔴 2026-10-18（实机，AI 原话：「窄隧道和 1 格台阶上它基本走不动，10 秒原地蹭 0.8 格」）：
 *    在 1×2 高的**窄隧道**里遇到 1 格台阶时，A* 上不去 —— 站上台阶要 3 格净高，而这里只有 2 格；
 *    vendor 的 `JumpUp` 只查"头顶有没有空"，**不会计划去挖那个天花板**。于是 `goto` 找不出路：
 *    表现就是 `stuck` + `moved:0` + `remaining:0.8`（人就在目标旁边，却一步不动），
 *    模型只能手工 `break 脚 + break 头 + move` 一段段爬（实机 15:09–15:12 就是这么干的）。
 *    这里把那套手工动作**收进走路层**：卡住且离目标 ≤ `MOVE_CARVE_RADIUS` 时，朝目标方向
 *    挖开"挡在脚上/头顶"的那一格（只挖实心、非危险、底下有支撑的），然后重试同一个 `goto`。
 *    不改脱困阶梯的顺序（那是用户 2026-10-15 定的），只在阶梯**之前**补这一次。 */
export const MOVE_CARVE_RADIUS = 4.5    // 离目标这么近还卡住，才值得动镐子（远处改看"眼前有没有挡路的"）
/* ── 2026-10-18 实机：**门** ────────────────────────────────────────────────
 * 用户原话："现在 move 遇到门不会开，会直接从墙挖进去"。
 * 根因：vendor 的 `Movements.canOpenDoors` 默认 **false**（`movements.js:101`，
 * 注释写着"Causes issues"），门在 A* 眼里就是实心方块；而 `canDig` 是 true ——
 * 于是"挖墙过去"永远比"绕路"便宜，模型看到的就是"从墙里挖进去"。
 * 分层修：
 *   ① `canOpenDoors = true`（`src/plugins.mjs`）—— 让 A* **规划**穿门；
 *   ② 执行层自己开门：走到门边上 `activateBlock` 一下（这份 vendor 的 `useOne`
 *      只有规划、没有执行，指望不上）；
 *   ③ 门的方块进 `CARVE_PROTECTED` —— 卡住时的那种"挖开挡路的"绝不砸门。 */
export const DOOR_RE = /(_door|_trapdoor|_fence_gate)$/
export const DOOR_OPEN_R = 2.6

/**
 * 一扇门的"门轴坐标"：门有两格（下/上），按任意一格都能开关；**按两格 = 开了又关**。
 * 这里把上半格折算到下半格，同一次扫描里只按一格。
 */
export function doorBaseKey (blk) {
  const p = blk?.position
  if (!p) return null
  let y = Number(p.y)
  try {
    if (blk.getProperties?.().half === 'upper') y -= 1
  } catch {}
  return `${Math.floor(p.x)},${Math.floor(y)},${Math.floor(p.z)}`
}

/** 铁门/铁活板门：只有红石能开，手动按不开 —— 别反复空点。 */
export const DOOR_IRON_RE = /^iron_(?:door|trapdoor)$/

/** 同一扇门两次按之间的冷却：门开了之后 **再按一下就关回去了**（实机"卡在门外一直开门"）。 */
export const DOOR_PRESS_COOL_MS = 1_500

/** 按完之后等服务端把 `open` 同步回来：6 × 50ms = 最多 300ms。 */
export const DOOR_CONFIRM_TRIES = 6
export const DOOR_CONFIRM_MS = 50

/**
 * 读到方块时统一折算成"逻辑门"（下半块）。
 *
 * 🔴 2026-10-18 用户指出：真实游戏数据里**上半块的 `open` 可能根本不存在**，
 *    只读上半块会得到 `undefined` —— 被当成"还关着"，于是再按一次，把刚开的门关回去。
 *    所以判断和交互都必须落在下半块上。
 */
export function doorFaceOf (b, blk) {
  try {
    if (blk?.getProperties?.().half === 'upper' && typeof b?.blockAt === 'function') {
      const p = blk.position
      const lower = b.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)))
      if (lower?.name && DOOR_RE.test(lower.name)) return lower
    }
  } catch {}
  return blk
}

/**
 * 门的开合状态：`'open' | 'closed' | 'unknown'`。
 * **不知道 ≠ 关着**：状态读不到时绝不能再点（再点可能就是关）。
 */
export function doorOpenStateOf (blk) {
  let props = null
  try { props = blk?.getProperties?.() } catch { return 'unknown' }
  if (!props || typeof props !== 'object') return 'unknown'
  if (props.open === true) return 'open'
  if (props.open === false) return 'closed'
  return 'unknown'
}

/** 按完之后回读，等它真的变成 `open`（最多 `DOOR_CONFIRM_TRIES` 次）。 */
async function confirmDoorOpen (b, target) {
  const read = () => doorOpenStateOf(typeof b?.blockAt === 'function' ? b.blockAt(target.position) : target)
  let st = read()
  for (let i = 0; i < DOOR_CONFIRM_TRIES && st !== 'open'; i++) {
    await new Promise((r) => setTimeout(r, DOOR_CONFIRM_MS))
    st = read()
  }
  return st
}

/**
 * **前方那扇门现在是不是开着**（2026-10-18 用户指出：卡住恢复里只看"这一轮新开了几扇"）。
 *
 * 🔴 缺口：`openNearbyDoor()` 返回的是**本次新打开的数量**。门上一轮已经开了、
 *    或者被 AI 自己开过、或者定时器 400ms 开过 —— 这时它返回 0，恢复分支就误以为
 *    "门口没门"，转头去**挖旁边的墙**。判定要问的是"挡路的门现在通不通"，不是"我刚开了几扇"。
 *
 * 只认**朝向目标那半边的门**（点积为正），避免屋里别处的门开着就把挖台阶补救整个挡掉。
 * 读不到状态（`unknown`）不算开 —— 不知道 ≠ 通。
 *
 * @returns {boolean}
 */
export function doorAheadOpen (b, target) {
  try {
    const p = b?.entity?.position
    if (!p || typeof b.blockAt !== 'function') return false
    const gx = Number(target?.x)
    const gz = Number(target?.z)
    if (!Number.isFinite(gx) || !Number.isFinite(gz)) return false
    const dx = gx - p.x
    const dz = gz - p.z
    const len = Math.hypot(dx, dz)
    if (len < 0.01) return false
    const ux = dx / len
    const uz = dz / len
    const me = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const done = new Set()
    for (let ox = -2; ox <= 2; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let oz = -2; oz <= 2; oz++) {
          const pos = new Vec3(me.x + ox, me.y + oy, me.z + oz)
          if (!DOOR_RE.test(String(b.blockAt(pos)?.name ?? ''))) continue
          const target2 = doorFaceOf(b, b.blockAt(pos))
          const key = doorBaseKey(target2) ?? `${pos.x},${pos.y},${pos.z}`
          if (done.has(key)) continue
          done.add(key)
          if (DOOR_IRON_RE.test(target2?.name ?? '')) continue
          if (doorOpenStateOf(target2) !== 'open') continue
          const ddx = pos.x + 0.5 - p.x
          const ddz = pos.z + 0.5 - p.z
          const dl = Math.hypot(ddx, ddz)
          if (dl > 2.6 || dl < 0.01) continue
          /* 朝向目标：点积 > 0.2·dl ⇒ 这扇门在前进方向上（不是背后的门） */
          if ((ddx * ux + ddz * uz) / dl < 0.2) continue
          return true
        }
      }
    }
  } catch {}
  return false
}

/**
 * **前进方向的走廊里有没有门**（2026-10-18 用户指出）：`carveStepAhead` 只查"要挖的那格"
 * 是不是受保护方块 —— 门前一格的普通石头不在名单里，照样会被挖穿，等于把门/门框拆了。
 *
 * 判据按**当前移动方向 + 门洞位置**，而不是"门周围两格一律保护"：
 * 沿主轴/副轴往前 `cells + 1` 格、脚/头两层找普通门（铁门按不开，不算）。
 * 找到了就返回那扇门，调用方据此**不做自动补挖**（开门/重算路径/交给 AI 决定）。
 *
 * @returns {object|null} 门方块
 */
export function doorOnRoute (b, target, { cells = MOVE_CARVE_CELLS } = {}) {
  try {
    const me = b?.entity?.position
    if (!me || !target || typeof b.blockAt !== 'function') return null
    const fx = Math.floor(me.x), fy = Math.floor(me.y), fz = Math.floor(me.z)
    const dx = Number(target.x) - me.x
    const dz = Number(target.z) - me.z
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null
    const sx = Math.sign(dx), sz = Math.sign(dz)
    const dirs = []
    if (Math.abs(dx) >= Math.abs(dz)) { if (sx) dirs.push([sx, 0]); if (sz) dirs.push([0, sz]) }
    else { if (sz) dirs.push([0, sz]); if (sx) dirs.push([sx, 0]) }
    const check = (x, z) => {
      for (let dy = 0; dy <= 1; dy++) {
        let blk = null
        try { blk = b.blockAt(new Vec3(x, fy + dy, z)) } catch { continue }
        const n = blk?.name
        if (typeof n === 'string' && DOOR_RE.test(n) && !DOOR_IRON_RE.test(n)) return blk
      }
      return null
    }
    for (const [ddx, ddz] of dirs) {
      for (let d = 1; d <= cells + 1; d++) {
        const x = fx + ddx * d, z = fz + ddz * d
        if (x === fx && z === fz) continue
        const hit = check(x, z)
        if (hit) return hit
      }
    }
    return null
  } catch { return null }
}

/**
 * **从门里走过去**（2026-10-18 实机验证：门开着时 A* 规划"穿过门那格"偶尔原地磨到超时）。
 *
 * 门在规划层是"能穿的一格"，但出门这一两步没必要交给 A*：找到前进方向上的门 →
 * 确保它开着 → 看着门中心按住 forward，直到门落到身后再松手。**不改 goal**。
 *
 * @returns {Promise<{passed:boolean, door?:string, why?:string, moved?:number}>}
 */
export async function walkThroughDoor (b, target, { budgetMs = 1_600, radius = 3.2 } = {}) {
  try {
    const p = b?.entity?.position
    if (!p || typeof b?.blockAt !== 'function') return { passed: false, why: 'no-bot' }
    const dir = doorOnRoute(b, target, { cells: 2 })
    if (!dir) return { passed: false, why: 'no-door' }
    const face = doorFaceOf(b, dir) ?? dir
    if (DOOR_IRON_RE.test(String(face?.name ?? ''))) return { passed: false, why: 'iron' }
    if (doorOpenStateOf(face) !== 'open') {
      await openNearbyDoor(b, radius).catch(() => 0)
      await sleep(160)
    }
    if (doorOpenStateOf(doorFaceOf(b, dir) ?? dir) !== 'open') return { passed: false, why: 'closed', door: face?.name }
    /* 🔴 `doorBaseKey()` 返回的是 **字符串** `"x,y,z"`（给去重用的），不是对象 ——
     * 第一版拿它当 `{x,y,z}` 用 ⇒ 中心点变 NaN ⇒ `lookAt(NaN)` ⇒ 物理把位置算成 NaN
     * （实机表现为 bot 位置直接变 NaN、寻路全废）。这里直接取下半块的 `position`。 */
    const base = (doorFaceOf(b, dir) ?? dir)?.position
    if (!base || !Number.isFinite(base.x) || !Number.isFinite(base.z)) return { passed: false, why: 'bad-pos' }
    const center = new Vec3(base.x + 0.5, base.y, base.z + 0.5)
    const start = b.entity.position.clone()
    const before = Math.hypot(target.x - start.x, target.z - start.z)
    try { await b.lookAt(center, true) } catch {}
    b.setControlState('forward', true)
    const t0 = Date.now()
    try {
      while (Date.now() - t0 < budgetMs) {
        await raceAbort(sleep(80), b.abortSignal, '穿门')
        const now = b.entity.position
        const toTargetX = Number(target.x) - now.x
        const toTargetZ = Number(target.z) - now.z
        const toDoorX = center.x - now.x
        const toDoorZ = center.z - now.z
        if (toDoorX * toTargetX + toDoorZ * toTargetZ < 0) break   // 门已经在身后
        if (Math.hypot(toTargetX, toTargetZ) < 1.2) break           // 已经到目标附近
      }
    } finally {
      try { b.setControlState('forward', false) } catch {}
    }
    const end = b.entity.position.clone()
    const after = Math.hypot(target.x - end.x, target.z - end.z)
    const moved = Math.round(Math.hypot(end.x - start.x, end.z - start.z) * 100) / 100
    return { passed: after < before - 0.15, door: face?.name, moved, before: Math.round(before * 100) / 100, after: Math.round(after * 100) / 100 }
  } catch (e) {
    return { passed: false, why: String(e?.message ?? e).slice(0, 120) }
  }
}

/**
 * 把身边关着的门/栅栏门/活板门打开（只开、不管关；够不着就什么都不做）。
 *
 * 顺序很要紧（2026-10-18 用户指出，实机"卡在门外一直开门"）：
 * ① 先折算成下半块 → ② 按门轴 key **先去重** → ③ 再看它是不是已经开着
 * → ④ 冷却/在途锁 → ⑤ **先上锁再 await** → ⑥ 回读确认才报"开了"。
 *
 * @returns {Promise<number>} 这一轮**确认**真的开了几扇（`b.__doorLast` 里有明细）
 */
export async function openNearbyDoor (b, radius = DOOR_OPEN_R) {
  try {
    const p = b?.entity?.position
    if (!p || typeof b.activateBlock !== 'function' || typeof b.blockAt !== 'function') return 0
    let opened = 0
    const closed = []
    const unknown = []
    const iron = []
    const r = Math.ceil(radius)
    const me = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const pressAt = b.__doorPressAt instanceof Map ? b.__doorPressAt : (b.__doorPressAt = new Map())
    const inFlight = b.__doorInFlight instanceof Set ? b.__doorInFlight : (b.__doorInFlight = new Set())
    const now = Date.now()
    const done = new Set()   // 这一轮碰过的门轴（上下半格只算一次）
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          const pos = new Vec3(me.x + dx, me.y + dy, me.z + dz)
          if (pos.distanceTo(me) > radius) continue
          let blk = null
          try { blk = b.blockAt(pos) } catch { continue }
          if (!blk?.name || !DOOR_RE.test(blk.name)) continue
          const target = doorFaceOf(b, blk)
          const key = doorBaseKey(target) ?? `${pos.x},${pos.y},${pos.z}`
          /* ① 先整扇门去重：哪怕它已经开着，这一轮也不再碰它 ——
           *    绝不能让"上半格没有 open 属性"把一扇开着的门判成关着。 */
          if (done.has(key)) continue
          done.add(key)
          if (DOOR_IRON_RE.test(target?.name ?? '')) { iron.push(key); continue }
          const state = doorOpenStateOf(target)
          /* ② 开着 ⇒ 不按；**读不到 ⇒ 也不按**（不知道 ≠ 关着，按错了就是把门关上）。 */
          if (state !== 'closed') { if (state === 'unknown') unknown.push(key); continue }
          if (inFlight.has(key)) continue
          /* ③ 冷却：按过之后客户端那一格还没刷新时**不能再按**。 */
          if (now - Number(pressAt.get(key) ?? 0) < DOOR_PRESS_COOL_MS) continue
          /* ④ 先上锁再 await：400ms 定时器可能重入，两次调用都过了检查就会各按一次。 */
          inFlight.add(key)
          pressAt.set(key, Date.now())
          try {
            await b.activateBlock(target)
            const after = await confirmDoorOpen(b, target)
            if (after === 'open') {
              opened++
              /* 记一笔"这扇是我们按开的"：vendor 规划里的 `useOne` 走到门口还会再按一次，
               * 那一下会把门关回去（实机"开了但不走门"）。`guardDoorActivate` 据此忽略重复按。 */
              if (b.__autoOpenedDoors instanceof Map) b.__autoOpenedDoors.set(key, Date.now())
              for (const s of [target, blk]) {
                const q = s?.position
                if (q && b.__autoOpenedDoors instanceof Map) b.__autoOpenedDoors.set(`${q.x},${q.y},${q.z}`, Date.now())
              }
            } else if (after === 'closed') {
              closed.push(key)
            } else {
              unknown.push(key)
            }
          } catch (e) {
            unknown.push(key)
          } finally {
            inFlight.delete(key)
          }
        }
      }
    }
    b.__doorLast = { opened, closed, unknown, iron }
    return opened
  } catch { return 0 }
}

/* 🔴 2026-10-18 审计（报告 Bug 3）：自动补救挖的是**世界**，不能只凭"它挡路"就挖。
 *    箱子 / 各种矿石 / 工作台熔炉附魔台 / 刷怪笼 / 重生锚 …… 一律不碰：那些是 AI 的资源、
 *    容器或装置，挖掉是不可逆的损失。要让某类方块可挖，得由 AI 自己调 `mc_act{break}`，
 *    别把它做成"走路失败就顺手挖了"。 */
export const CARVE_PROTECTED = new RegExp('(' + [
  '_ore$', '^ancient_debris$', '^raw_[a-z_]+$',
  '^chest$', '^trapped_chest$', '^barrel$', '^shulker_box$', '_shulker_box$',
  '^crafting_table$', '^furnace$', '^blast_furnace$', '^smoker$', '^enchanting_table$',
  '^anvil$', '^chipped_anvil$', '^damaged_anvil$', '_bed$', '^spawner$', '^trial_spawner$',
  '^vault$', '^beacon$', '^lectern$', '^brewing_stand$', '^cauldron$', '^hopper$',
  '^dispenser$', '^dropper$', '^respawn_anchor$', '^nether_portal$', '^end_portal',
  '_door$', '_trapdoor$', '_fence_gate$',
].join('|') + ')')
/**
 * 2026-10-18 审计 P1-1：走不到的时候，把"竖井里到底有什么"一次给全。
 *
 * 以前 `unreachable` 只有一句"没路"，AI 得自己一步步 `mc_observe` / `mc_map` 去摸：
 * 头顶是不是封死的、能不能跳、四面哪边通、背包里有没有能垫/能填的方块。
 * 一次摸一格，一轮叫醒就烧掉好几个工具调用 —— 而这些都是走路层**本来就能读到**的。
 *
 * 只读、不动手：给事实 + 一句建议，挖不挖、垫不垫仍由 AI 决定。
 * @returns {{headroom:number, ceiling:string|null, canJump:boolean,
 *            sides:{n:string|null,e:string|null,s:string|null,w:string|null},
 *            pillar:number, floor:string|null, hint:string}|null}
 */
export function shaftInfoOf (b, target) {
  try {
    const p = b?.entity?.position
    if (!p) return null
    const nameAt = (x, y, z) => {
      try { return b.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))?.name ?? null } catch { return null }
    }
    const solidAt = (x, y, z) => { const n = nameAt(x, y, z); return Boolean(n) && isSolidBlock(n) && !BRIDGE_FATAL.test(n) }
    const feetY = Math.floor(p.y)
    // 头顶净空：从脑袋上一格往上数，数到第一块实心为止（最多 6 格，够看出"能跳/堵死"）
    let headroom = 0
    let ceiling = null
    for (let y = feetY + 2; y <= feetY + 8; y++) {
      const n = nameAt(Math.floor(p.x), y, Math.floor(p.z))
      if (n != null && isSolidBlock(n)) { ceiling = n; break }
      headroom++
    }
    const dirs = [[0, -1, 'n'], [1, 0, 'e'], [0, 1, 's'], [-1, 0, 'w']]
    const sides = {}
    for (const [dx, dz, key] of dirs) {
      const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz
      const feet = nameAt(x, feetY, z), head = nameAt(x, feetY + 1, z), floor = nameAt(x, feetY - 1, z)
      const open = (!feet || isPassable(feet) || isLiquid(feet)) && (!head || isPassable(head) || isLiquid(head))
      sides[key] = open ? (floor ?? 'air') : `${feet ?? '?'}`
    }
    // 背包里"可以拿来垫/填"的便宜方块（只在提示里用；真垫不垫由 AI 决定）
    let pillar = 0
    try {
      for (const it of (b.inventory?.items?.() ?? [])) {
        if (/(dirt|cobblestone|cobbled_deepslate|netherrack|sand|gravel|stone|planks)/.test(it?.name ?? '')) pillar += Number(it?.count) || 0
      }
    } catch { /* 没有背包就是 0 */ }
    const floor = nameAt(Math.floor(p.x), feetY - 1, Math.floor(p.z))
    const openSides = Object.entries(sides).filter(([, v]) => !/:/.test(v) && v !== '?').map(([k]) => k)
    const hint = headroom === 0
      ? `头上就是 **${ceiling ?? '实心'}**（y=${feetY + 2}）—— **跳不起来**，原地垫脚也不行。要么往 ${openSides.join('/') || '四面'} 挖出去，要么先挖开头顶那格。`
      : `头顶有 ${headroom} 格净空${ceiling ? `（再往上是 **${ceiling}**）` : '（上面没扫到实心）'} —— ${headroom >= 1 ? '能跳' : '只能贴地爬'}；四面 ${openSides.length ? openSides.join('/') + ' 有路' : '全堵着'}${pillar ? `；背包里有 ${pillar} 个能垫的方块` : '；背包里没有能垫的方块'}。`
    return { headroom, ceiling, canJump: headroom >= 1, sides, pillar, floor, hint }
  } catch { return null }
}

export const MOVE_CARVE_CELLS = 2       // 一次最多往前看几格
export const MOVE_CARVE_TRIES = 2       // 一次 walkPathfinder 里最多补挖几次

/** 第 `n` 级脱困动作（0 起）；超出阶梯返回 `null`（= 该认输了）。 */
export function escapeStepOf (n) { return MOVE_ESCAPES[n] ?? null }

/** 脱困动作的中文名（日志 / 返回值文案用）。 */
export function escapeTextOf (step) {
  return step === 'repath' ? '重算路径'
    : step === 'jump' ? '跳跃脱困'
      : step === 'backoff' ? '后退再寻路'
        : '放弃'
}

/**
 * 眼前有没有"挡路的、能挖的、挖了不会掉下去"的那一格。（Bug 4：卡住该不该试挖，
 * 看的是**眼前障碍**，不是"离终点还有几格"。）
 *
 * 判据与 `carveStepAhead` 完全一致（同方向、同保护名单、同"底下要有支撑"），
 * 所以它说"有"就一定能挖；返回 `null` 表示"没有可下手的障碍"。
 * @returns {null | {x:number,y:number,z:number,name:string,cell:'feet'|'head',headroom:number}}
 */
export function obstacleAheadOf (b, target, { cells = MOVE_CARVE_CELLS } = {}) {
  const me = b?.entity?.position
  if (!me || !target) return null
  const fx = Math.floor(me.x), fy = Math.floor(me.y), fz = Math.floor(me.z)
  const dx = Number(target.x) - me.x, dz = Number(target.z) - me.z
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null
  const at = (x, y, z) => { try { return b.blockAt(new Vec3(x, y, z)) } catch { return null } }
  const nameOf = (blk) => { try { return blk?.name ?? null } catch { return null } }
  const solid = (n) => Boolean(n) && isSolidBlock(n)
  const diggable = (n) => {
    if (!solid(n) || BRIDGE_FATAL.test(n) || isLiquid(n) || CARVE_PROTECTED.test(n)) return false
    return !/^(bedrock|barrier|command_block|chain_command_block|repeating_command_block|obsidian|end_portal_frame)$/.test(n)
  }
  const sx = Math.sign(dx), sz = Math.sign(dz)
  const dirs = []
  if (Math.abs(dx) >= Math.abs(dz)) { if (sx) dirs.push([sx, 0]); if (sz) dirs.push([0, sz]) }
  else { if (sz) dirs.push([0, sz]); if (sx) dirs.push([sx, 0]) }
  /* 2026-10-19 实机（"1 格宽巷道会卡，break 前面那格就过去"）：斜着拐弯时挡路的
   * 既不在正前也不在正侧，而在对角那一格 —— 两条轴都走不通时再看一眼对角线。 */
  if (sx && sz) dirs.push([sx, sz])
  for (const [ddx, ddz] of dirs) {
    for (let d = 1; d <= cells; d++) {
      const x = fx + ddx * d, z = fz + ddz * d
      if (x === fx && z === fz) continue
      const feetN = nameOf(at(x, fy, z))
      const headN = nameOf(at(x, fy + 1, z))
      const floorN = nameOf(at(x, fy - 1, z))
      if (!floorN || !solid(floorN) || BRIDGE_FATAL.test(floorN) || isLiquid(floorN)) continue
      const headroom = solid(headN) ? 0 : 1
      if (solid(feetN) && diggable(feetN)) return { x, y: fy, z, name: feetN, cell: 'feet', headroom }
      if (solid(headN) && diggable(headN)) return { x, y: fy + 1, z, name: headN, cell: 'head', headroom }
    }
  }
  return null
}

/**
 * 窄隧道/台阶的"手工补救"：朝目标方向挖掉挡在**脚上**或**头顶**的那一格实心方块。
 *
 * 背景见 `MOVE_CARVE_RADIUS` 的注释（实机：1×2 窄道里的 1 格台阶，A* 上不去）。
 * 只做**最保守**的那一件：
 *   - 只朝目标方向（主轴优先，再看另一条轴）看 `MOVE_CARVE_CELLS` 格；
 *   - 只挖"脚下这一层或头顶那一层"的实心块，且要求**底下（y-1）有支撑**（不然挖完是往坑里走）；
 *   - 岩浆/火/水/细雪/仙人掌/黑曜石/基岩/命令方块**一概不碰**；
 *   - 永不挖自己站的那一格。
 *
 * 返回挖了几格（0 = 没得挖 / 不该挖）。**只挖不改走路** —— 挖完由调用方重跑同一个 `goto`。
 */
export async function carveStepAhead (b, target, { cells = MOVE_CARVE_CELLS, radius = MOVE_CARVE_RADIUS, ignoreRange = false } = {}) {
  const me = b?.entity?.position
  if (!me || !target) return 0
  const fx = Math.floor(me.x), fy = Math.floor(me.y), fz = Math.floor(me.z)
  const dx = Number(target.x) - me.x, dz = Number(target.z) - me.z
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return 0
  /* Bug 4：卡住的起因常常是**眼前这一格**，不是"离终点还远"。到底该不该挖由调用方判
   * （`obstacleAheadOf`），这里只保留"直接调用时的保守默认"。 */
  if (!ignoreRange && Math.hypot(dx, dz) > radius) return 0
  const at = (x, y, z) => { try { return b.blockAt(new Vec3(x, y, z)) } catch { return null } }
  const nameOf = (blk) => { try { return blk?.name ?? null } catch { return null } }
  const solid = (blk) => { const n = nameOf(blk); return Boolean(n) && isSolidBlock(n) }
  /* 能挖：实心 + 不是危险方块 + 不是"挖了会出事/挖不动"的那些。名单和搭路共用 BRIDGE_FATAL。 */
  const diggable = (blk) => {
    const n = nameOf(blk)
    if (!n || !isSolidBlock(n)) return false
    if (BRIDGE_FATAL.test(n) || isLiquid(n)) return false
    if (CARVE_PROTECTED.test(n)) return false      // 容器 / 矿石 / 装置：不替 AI 做这种不可逆的决定
    return !/^(bedrock|barrier|command_block|chain_command_block|repeating_command_block|obsidian|end_portal_frame)$/.test(n)
  }
  /* 方向：先主轴（离得远的那个轴），再另一条轴 —— 斜着走楼梯时两条都要看。 */
  const sx = Math.sign(dx), sz = Math.sign(dz)
  const dirs = []
  if (Math.abs(dx) >= Math.abs(dz)) { if (sx) dirs.push([sx, 0]); if (sz) dirs.push([0, sz]) }
  else { if (sz) dirs.push([0, sz]); if (sx) dirs.push([sx, 0]) }
  /* 2026-10-19 实机（"1 格宽巷道会卡，break 前面那格就过去"）：斜着拐弯时挡路的
   * 既不在正前也不在正侧，而在对角那一格 —— 两条轴都走不通时再看一眼对角线。 */
  if (sx && sz) dirs.push([sx, sz])
  const digOne = async (blk) => {
    try {
      const tool = typeof b.pathfinder?.bestHarvestTool === 'function' ? b.pathfinder.bestHarvestTool(blk) : null
      if (tool && typeof b.equip === 'function') await b.equip(tool, 'hand')
      await b.dig(blk, true)
      return true
    } catch { return false }
  }
  let dug = 0
  for (const [ddx, ddz] of dirs) {
    for (let d = 1; d <= cells; d++) {
      const x = fx + ddx * d, z = fz + ddz * d
      if (x === fx && z === fz) continue
      const feet = at(x, fy, z)
      const head = at(x, fy + 1, z)
      const floor = at(x, fy - 1, z)
      const feetHard = solid(feet), headHard = solid(head)
      if (!feetHard && !headHard) continue            // 这一格本来就过得去
      /* 🔴 底下没有支撑就别挖：那说明前面是坑/悬空，挖开只会多一个掉下去的口子。 */
      const floorName = nameOf(floor)
      if (!floorName || !isSolidBlock(floorName) || BRIDGE_FATAL.test(floorName) || isLiquid(floorName)) continue
      const picks = []
      if (feetHard && diggable(feet)) picks.push(feet)
      if (headHard && diggable(head)) picks.push(head)
      if (!picks.length) continue
      for (const blk of picks) { if (await digOne(blk)) dug++ }
      if (dug > 0) return dug       // 先挖第一处，挖完让 goto 重算（别一口气把路改了）
    }
  }
  return dug
}

/**
 * "现在算不算正常等待" —— 挖着 / 放着 / 悬空（跳跃落地中）时位置不前进是正常的。
 * 防假 bot：字段缺了当 false（不是"忙"，照常判卡）。
 */
export function moveBusyNow (b) {
  try {
    const pf = b?.pathfinder
    if (pf?.isMining?.() === true || pf?.isBuilding?.() === true) return true
    return b?.entity?.onGround === false
  } catch { return false }
}

/**
 * 移动进度采样器（P0-1）。每 `sampleMs` 看一眼"离目标还有多远"，判卡住时 **reject**
 * 一个带 `mcStuck: true` 的错误；其余情况永远 pending，由 `stop()` 收尾。
 *
 * ⚠️ 不自己按控制位：`pathfinder` 每个 physicsTick 都会把 `forward/jump/sprint`
 *    按回去（vendor `monitorMovement`），采样器里按什么都会被立刻覆盖 —— 脱困动作
 *    必须由调用方在"pathfinder 已经停掉"的窗口里做（见 `escapeMove`）。
 *
 * 注入 `now` / `setTimer` / `clearTimer` 是为了离线测试能拿假时钟驱动它。
 *
 * @returns {{ promise: Promise<void>, stop: () => void, info: () => object }}
 */
export function moveProgressWatcher (b, target, {
  arrive = 1.6, ty = null,
  sampleMs = MOVE_SAMPLE_MS, stuckMs = MOVE_STUCK_MS,
  busyMaxMs = MOVE_BUSY_MAX_MS, progressEps = MOVE_PROGRESS_EPS,
  resetsOf = null, resetLimit = MOVE_RESET_LIMIT,
  now = () => Date.now(),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (h) => clearInterval(h),
} = {}) {
  const goalVec = new Vec3(target.x, ty ?? target.y, target.z)
  const distOf = () => {
    try { return b.entity.position.distanceTo(goalVec) } catch { return Infinity }
  }
  let stopped = false
  let reject = null
  let best = distOf()
  let lastProgressAt = now()
  let busySince = null
  let stuckInfo = null
  const promise = new Promise((_, rej) => { reject = rej })
  // ⚠️ 竞速可能先结束、采样器随后才 reject ⇒ 自己吞掉，否则是"未处理拒绝"（会炸宿主）。
  promise.catch(() => {})
  /** 路径被失效了几次（`resetsOf` 抛错就当 0 —— 判卡不该因为数数失败而失效）。 */
  const resetsNow = () => { try { return resetsOf ? Number(resetsOf()) || 0 : 0 } catch { return 0 } }
  /**
   * 认输：收掉定时器 + reject 一个带 `mcStuck` 的错误。
   * `thrash` = 成因是"路径一直被失效"（而不是"2.4 秒没进展"）—— 两者给模型的下一步不一样。
   */
  const giveUp = (d, { ms = 0, thrash = false } = {}) => {
    stopped = true
    try { clearTimer(timer) } catch {}
    stuckInfo = { ms, remaining: Number(d.toFixed(2)), ...(thrash ? { thrash: true, resets: resetsNow() } : {}) }
    const err = new Error(thrash
      ? `路径被反复失效（这一次 goto 里被重算了 ${resetsNow()} 次）—— 光重算没用（离目标还有 ${d.toFixed(1)} 格）`
      : `移动卡住：${(stuckMs / 1000).toFixed(1)} 秒里既没挪动、也没靠近（离目标还有 ${d.toFixed(1)} 格）`)
    err.mcStuck = true
    err.remaining = Number(d.toFixed(2))
    if (thrash) err.mcPathThrash = true
    reject(err)
  }
  const timer = setTimer(() => {
    if (stopped) return
    const t = now()
    const d = distOf()
    if (d <= arrive + 0.6 || d < best - progressEps) {
      // 到了 / 真的靠近了 —— 有进展，进度时钟归零（**在进展面前，失效次数不算数**：
      // 一直被打断但还在往前挪，那就让它挪）
      best = Math.min(best, d)
      lastProgressAt = t
      busySince = null
      return
    }
    if (moveBusyNow(b)) {
      // 挖着 / 放着 / 悬空：算正常等待，推后进度时钟（但最多推 busyMaxMs）
      if (busySince == null) busySince = t
      if (t - busySince < busyMaxMs) { lastProgressAt = t; return }
    } else busySince = null
    /* P1：**路径失效重算** —— vendor 自己会 `resetPath('stuck')` 重算，但它只重算**同一条**。
     * 一个 `goto` 里"没进展 + 又失效了太多次" ⇒ 世界在变 / 一直被挡，"光重算没用"，
     * 直接进脱困阶梯换策略，不用再等满 `stuckMs`。 */
    if (resetsOf && resetLimit > 0 && resetsNow() >= resetLimit) { giveUp(d, { ms: t - lastProgressAt, thrash: true }); return }
    if (t - lastProgressAt >= stuckMs) giveUp(d, { ms: t - lastProgressAt })
  }, sampleMs)
  return {
    promise,
    stop () { if (stopped) return; stopped = true; try { clearTimer(timer) } catch {} },
    info: () => ({ best: Number(best.toFixed(2)), stuck: stuckInfo }),
  }
}

/**
 * 走一级脱困动作（P0-1）。**必须在"pathfinder 已经停掉"的窗口里跑**：
 * 先 `ctx.stopPathing(b)`（`setGoal(null)` ⇒ `resetPath` + `clearControlStates`），
 * 否则 vendor 每个 physicsTick 都会把 `forward/jump` 按回去，我们按什么都被立刻覆盖；
 * 顺带让上一轮的 `goto` 以 `GoalChanged` 收场（调用方已经 `.catch(()=>{})`）。
 *
 * ⚠️ 三级动作**都不换 goal 对象** —— vendor 的 `goto` 监听 `goal_updated`，换了对象
 *    就直接以 `GoalChanged` 拒绝（`lib/goto.js:35`），等于把这次走路判死。
 */
export async function escapeMove (b, goal, step, ctx = {}) {
  try { ctx.stopPathing?.(b) } catch {}
  await sleep(60)                       // 让 pathfinder 的 physicsTick 把控制位松开
  if (step === 'jump') {
    try { b.setControlState('jump', true) } catch {}
    await sleep(MOVE_JUMP_MS)
    try { b.setControlState('jump', false) } catch {}
  } else if (step === 'backoff') {
    // 贴墙/贴角时原地重算还是同一条死路 —— 先退开半步再重算
    try { b.setControlState('back', true) } catch {}
    await sleep(MOVE_BACK_MS)
    try { b.setControlState('back', false) } catch {}
  }
  // 'repath' 不做额外动作：重新 `goto` 本身就是一次重算
}

/**
 * 用 pathfinder 走到目标（**现成的防卡住寻路**：自己绕路、挖穿挡路的方块、垫 1×1 塔、过门）。
 *
 * 返回值保持 `arrived / moved / remaining / stuck / hint` 结构；
 * 上层 `mc_move` 和自主层直接使用；额外带 `via:"pathfinder"` 便于排查。
 */
/* ───────────── 传送门（末地 / 下界 / 末地门） ───────────── */

/**
 * 三种"站进去就会被服务端送走"的方块。
 * 🔴 2026-10-19 用户：「还有把末影传送门视为危险方块」—— 走要塞那一趟就栽在这儿：
 *    传送门格子在 y=-40 与地板同层，寻路器**不肯走进去**（默认 `GoalNear` 半径 1，
 *    它停在外圈 1 格就报"到了"），我最后靠"在门上方垫方块再挖掉让自己掉进去"硬闯过去。
 *    传送门不是危险地形，**是目的地**：这里是唯一出处，走路层据此把目标半径收到 0 并补最后一步。
 */
export const PORTAL_RE = /^(end_portal|end_gateway|nether_portal)$/

/**
 * 目标附近（含脚/头两格、半径 `r`）有没有传送门方块；有就返回**最近那一格**的坐标。
 * @returns {{name:string, x:number, y:number, z:number}|null}
 */
export function portalAt (b, x, y, z, r = 1) {
  const cx = Math.floor(Number(x))
  const cy = Math.floor(Number(y))
  const cz = Math.floor(Number(z))
  if (![cx, cy, cz].every(Number.isFinite)) return null
  const nameAt = (px, py, pz) => { try { return b.blockAt(new Vec3(px, py, pz))?.name ?? null } catch { return null } }
  let best = null
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (const dy of [0, 1, -1]) {
        const n = nameAt(cx + dx, cy + dy, cz + dz)
        if (!n || !PORTAL_RE.test(n)) continue
        const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 2      // 同层优先
        if (!best || d < best.d) best = { name: n, x: cx + dx, y: cy + dy, z: cz + dz, d }
      }
    }
  }
  return best ? { name: best.name, x: best.x, y: best.y, z: best.z } : null
}

/** 人现在是不是已经站在传送门里（脚内/头内那格是传送门）。 */
export function inPortalNow (b) {
  const p = b?.entity?.position
  if (!p) return null
  const feet = Math.floor(p.y)
  const head = Math.floor(p.y + (b.entity.eyeHeight ?? 1.62))
  for (const py of [feet, head]) {
    try {
      const n = b.blockAt(new Vec3(Math.floor(p.x), py, Math.floor(p.z)))?.name
      if (n && PORTAL_RE.test(n)) return n
    } catch { /* 读不到就当不在 */ }
  }
  return null
}

/**
 * 最后一步：寻路器只肯走到门旁边，**迈进去**得自己来（朝那格中心转过去，按住前进 + 起跳）。
 * 传送是服务端做的：站在门方块里之后由服务端发 `respawn`/位置包把人送走，
 * 所以这里判"进没进"看的是**维度变了**或**位置瞬移了**，不是看按键。
 */
export async function stepIntoPortal (b, cell, { ms = 700, signal = null } = {}) {
  const dim0 = b?.game?.dimension
  const p0 = b?.entity?.position?.clone?.() ?? null
  const teleported = () => {
    const p1 = b?.entity?.position
    if (!p1 || !p0) return false
    if (b.game?.dimension !== dim0) return true
    return p0.distanceTo(p1) > 8
  }
  if (inPortalNow(b) || teleported()) return { entered: true, already: true }
  /* 🔴 2026-10-20 审计：这里原来没带 `force=true` —— mineflayer 的 `lookAt` 不带 force 会
   *   `await lookingTask.promise`，那个 promise 只在物理循环发出 look 包时 finish；站着不动时
   *   物理循环 early return（physics.js:158-162）⇒ **永远挂着**，下面"照样顶"的分支根本走不到。 */
  try { await b.lookAt(new Vec3(cell.x + 0.5, b.entity.position.y + 1.1, cell.z + 0.5), true) } catch { /* 转不过去也照样顶 */ }
  try {
    b.setControlState('forward', true)
    b.setControlState('sprint', true)
    await raceAbort(sleep(ms), signal, '走进传送门')
  } catch { /* 被打断就把控制位松开 */ } finally {
    try { b.setControlState('forward', false); b.setControlState('sprint', false) } catch { /* 忽略 */ }
  }
  return { entered: teleported() || Boolean(inPortalNow(b)) }
}

/**
 * 目标点 + `GoalNear` 半径（纯函数，方便单测）。
 * 传送门是**目的地**：半径必须收到 0（人得站在门方块那一格上才会被送走），
 * 否则寻路器在门外 1 格就满足、报"到了"却什么都没发生。
 */
export function goalPointFor ({ target, ty, arriveUsed, portal = null } = {}) {
  if (portal) return { x: portal.x, y: portal.y, z: portal.z, radius: 0, portal: true }
  return {
    x: Math.floor(Number(target?.x)),
    y: ty,
    z: Math.floor(Number(target?.z)),
    radius: Math.max(0, Math.round(Number(arriveUsed ?? 1.6) - 0.6)),
    portal: false,
  }
}

export async function walkPathfinder (self, target, { arrive = 1.6, budget = self.cfg.moveBudgetMs, budgetAsked = null, noTower = true, intent = 'near', noDig = false } = {}, ctx = {}) {
  const b = self.bot
  endHoverFlight(b)   // 悬停着就别想蹦/走：先恢复重力（否则走路全废，见 endHoverFlight）
  /* 2026-10-18 审计 P1-2：意图决定"到"的标准（arrive / 允许高差） */
  const pre = intentOf(intent)
  const arriveUsed = arrive === 1.6 ? pre.arrive : arrive
  const vertTol = pre.vertTol
  /* 2026-10-18 审计 P1-3：规划耗时 / 实际移动耗时分开记（以前只有一个 ms，看不出"是在算路还是在挪腿"） */
  let plannedAt = null

  const { goals, Movements } = self._pf
  const t0 = Date.now()
  const start = b.entity.position.clone()
  const at = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
  const startRemaining = Math.hypot(start.x - target.x, start.z - target.z)
  /* P0-A（2026-10-17 实机）：`moved` 只有**水平**位移（`Math.hypot(dx, dz)`）—— 那天在要塞里垫
   * 柱子时放方块被拒（vendor `mineflayer-pathfinder/index.js:563` 的 `place_error`：先
   * `setControlState('jump', true)` 再往脚下 `placeBlock`，方块没放成人已经在半空），人从 y=68
   * 掉到 y=47，工具却报 `moved: 4.24` + `hint: 不是走不通，再叫一次` ⇒ 模型又爬又掉第二次
   * （y=33、血 1.9）。**垂直位移必须自己报出来**，否则"掉下去了"和"没走到"在模型眼里一模一样。 */
  const fellOf = (p) => {
    const d = Number(start.y) - Number(p?.y ?? start.y)
    return Number.isFinite(d) && d >= 3 ? Number(d.toFixed(1)) : null
  }
  const fellInfo = (p) => {
    const f = fellOf(p)
    return f == null ? {} : { fell: f, fellFrom: Math.floor(start.y), fellTo: Math.floor(p.y) }
  }
  const fellNote = (p) => {
    const f = fellOf(p)
    return f == null ? '' : `🔴 **你掉下去了 ${f} 格**（从 y=${Math.floor(start.y)} 掉到 y=${Math.floor(p.y)}）—— `
      + '多半是垫柱子/搭路时**放方块被服务端拒了**（那一刻人已经在半空）。先看清脚下站稳没有，'
      + '**别对着同一个高度反复爬**。'
  }
  /* 🔴 2026-10-18 审计（用户转来的报告 Bug 2）：`moved` 只有水平位移（`hypot(dx, dz)`）。
   *    掉下去 21 格时它报 4.24（靠 `fell` 补），上一格台阶时它报 0（`fell` 又不触发）——
   *    模型没法从 `moved` 本身看出"我到底是平移了、爬上去了，还是掉下去了"。
   *    现在一次给全：`moved`（兼容，仍是水平）+ `movedHorizontal` / `movedVertical`（dy，正=上升）/
   *    `moved3d`（三维直线距离）/ `delta: {x,y,z}`。判"有没有进展"要看水平，判"上没上去"看垂直。 */
  const deltaOf = (p) => {
    const dx = Number((Number(p?.x ?? start.x) - start.x).toFixed(2))
    const dy = Number((Number(p?.y ?? start.y) - start.y).toFixed(2))
    const dz = Number((Number(p?.z ?? start.z) - start.z).toFixed(2))
    const horizontal = Number(Math.hypot(dx, dz).toFixed(2))
    return {
      moved: horizontal,
      movedHorizontal: horizontal,
      movedVertical: dy,
      moved3d: Number(Math.hypot(dx, dy, dz).toFixed(2)),
      delta: { x: dx, y: dy, z: dz },
    }
  }
  /** 垂直位移的一句人话（≥1 格才说，平地不算）。 */
  const vertNote = (p) => {
    const d = deltaOf(p)
    if (Math.abs(d.movedVertical) < 1) return ''
    return d.movedVertical > 0
      ? `，垂直上升了 ${Math.abs(d.movedVertical)} 格`
      : `，垂直下降了 ${Math.abs(d.movedVertical)} 格`
  }
  /* 🔴 目标 y 可能是半空（地图/扫描给的是"地表高度"、树冠、别人站的 y）—— 直接朝那个 y 走，
   *    pathfinder 会一路垫方块往上爬（"搭路一直搭到空气上"）。收到底面再走。 */
  const ty = standableY(b, target.x, target.y, target.z)
  /* 🔴 2026-10-19 用户：「还有把末影传送门视为危险方块」—— 真正的原因是**目标半径**：
   *    `GoalNear(…, max(0, round(arrive-0.6)))` 默认半径 1，人在门外 1 格就满足 ⇒
   *    "到了但没进去"。目标（或它旁边）是传送门时把半径收到 **0**（必须站在那一格上），
   *    并在到了之后补一步"迈进去"（`stepIntoPortal`）。 */
  const portal = portalAt(b, Math.floor(target.x), ty, Math.floor(target.z))
  const gp = goalPointFor({ target, ty, arriveUsed, portal })
  const goal = new goals.GoalNear(gp.x, gp.y, gp.z, gp.radius)
  // 地形分类（导航 P2，用户 m02868 的"地形分类 + 路径评分"）：
  // **只换权重，不换算法** —— 台阶上把挖穿调便宜一点、沟边把垫方块调便宜一点、
  // 岩浆边一格都不许往下跳。看错了顶多走回原来的路，不会让机器人做危险动作。
  /* 2026-10-18 审计 P1「地形局部重估」：这份只是**出发时**的看法；脱困/挖开台阶之后
   * 世界已经变了，循环里会用 `classifyTerrainCached`（缓存键含脚下坐标，`blockUpdate` 会顶版本号）
   * 再判一次，变了就按新地形重调权重。 */
  let terrain = classifyTerrainCached(b)
  let terrainReeval = 0
  const mv = ctx.movements(terrain)
  if (!mv) throw new Error('pathfinder 的 Movements 造不出来（插件没挂上？）')
  /* 🔴 2026-10-20 用户：「move 加一个不破坏方块的模式」——
   *    `movements.canDig` 是 A* 唯一的一条"挖穿挡路方块"的路（`movements.js` 的
   *    `getBreakCost`/`safeOrBreak`）。把这一份的 `canDig` 关掉，它就只能绕路 / 跳 / 下蹲过缝 /
   *    搭路，**一格都不挖**。这是 `noDig` 的第一处（另外两处在脱困重建 Movements 时）。 */
  if (noDig) mv.canDig = false
  /* 🔴 2026-10-17（用户实机：逃跑时寻路器把方块垫在自己脚下往上爬，一路升到 y=57，越跑越远）：
   *    vendor 的 `allow1by1towers` 默认是 **true**，而**全仓没有任何一处设置过它**
   *    （只出现在两处注释里）⇒ 一直吃的是默认值。赶路时偶尔垫一块无伤大雅，
   *    **逃跑时它是纯亏**：垫脚要停下来、要耗方块、还让你离地面更远。
   *    `noTower: true` 把这条腿关掉 —— 挖穿 / 绕路 / 跳 1 格 / 下蹲过缝**全都还在**，
   *    只是不再"原地把自己顶高"。（⚠️ 别改成清空 `scafoldingBlocks`：那会把 1×1 柱子的
   *    整条 move 也剪掉，掉坑里就真出不来了 —— 见 `src\plugins.mjs` 的注释。） */
  if (noTower) mv.allow1by1towers = false
  if (terrain.kind !== 'flat' && terrain.kind !== 'unknown') {
    self.log(`🧭 脚边是${terrain.text}（${terrain.note}）—— 按这一类调寻路权重`)
  }
  // 🔴 上一次 `mc_dig` 超时可能留下一个还在后台跑的采集任务（它按着 forward、
  //    占着 pathfinder）—— 不先停掉，这次走路会和它抢控制权：实机表现是
  //    "15 秒只挪 0.03 格、reason:stuck"。见 #cancelCollect 的注释。
  if (ctx.collectBusy(b)) {
    self.log('⚠️ 上次的采集任务还在后台跑（超时没停掉）—— 先停掉它再走路')
    await ctx.cancelCollect(b)
  }
  const gen = ctx.beginMove()      // 领号：这次走路从此是"最新的一次移动"
  b.pathfinder.setMovements(mv)
  let why = null
  let dug = 0, placed = 0
  const held0 = heldText(b)
  const snap0 = invSnap(b)     // 垫路会吃掉背包里的方块 —— 走完要如实报"用掉了什么、手上还剩什么"
  /**
   * 垫路/挖路的如实报告：`pillared` 只说了"垫了几块"，模型据此**不知道垫的是泥土**
   * 也不知道手上现在攥着什么（2026-10-07 实机：垫完爬出矿坑后拿着泥土去刨石头）。
   */
  const roadInfo = () => {
    if (!placed) return {}
    const used = invUsed(b, snap0)
    const held = heldText(b)
    return {
      ...(used.length ? { pillaredWith: used[0].name } : {}),
      ...(held !== held0 ? { held, heldBefore: held0 } : {}),
    }
  }
  let emptyNoPath = false
  const onUpdate = (r) => {
    /* 2026-10-18 审计 P1-3：第一次算出路径的时刻 —— 规划耗时 / 实际移动耗时从这里分开计 */
    if (!plannedAt) plannedAt = Date.now()
    if (r?.status && r.status !== 'success') why = r.status
    /* 🔴 2026-10-08 审计③：A* 一个邻居都生成不出来时 `path = []`，vendor 的 `lib/goto.js:22-30`
     *    对**空路径**的 noPath 分支是"无错 resolve"（只有非空路径才 reject NoPath）⇒ 我们拿到
     *    "成功"却离目标很远。旧代码据此报 `preempted`（"不是走不通"），模型于是一遍遍重发同一个
     *    到不了的点。这里把"空路径的 noPath"单独记下来。 */
    if (r?.status === 'noPath' && Array.isArray(r?.path) && r.path.length === 0) emptyNoPath = true
  }
  /* P1：**路径失效计数** —— vendor 会在 3.5s 无节点进展时 `resetPath('stuck')`，另外还有
   * `block_updated` / `path_stopped` / `goal_updated` 等理由。同一个 `goto` 里反复失效
   * = 这条路一直在被世界变化（别人放的方块、实体、岩浆流）打断，**光重算没用**。 */
  let pathResets = 0                 // 本轮 goto（每一轮都归零）
  let pathResetsTotal = 0            // 整次调用
  const resetReasons = {}
  const onReset = (reason) => {
    why = reason
    pathResets++; pathResetsTotal++
    const k = String(reason ?? 'unknown')
    resetReasons[k] = (resetReasons[k] ?? 0) + 1
  }
  const onDig = () => { dug++ }
  const onBlock = (oldB, newB) => { if (oldB && newB && oldB.boundingBox !== 'block' && newB.boundingBox === 'block') placed++ }
  // ⚠️ 事件名要防着"假 bot"（自检里的最小物理 bot 没有 on/removeListener）
  const off = []
  const listen = (ev, fn) => { if (typeof b.on === 'function') { b.on(ev, fn); off.push([ev, fn]) } }
  listen('path_update', onUpdate); listen('path_reset', onReset)
  listen('diggingCompleted', onDig); listen('blockUpdate', onBlock)
  /* P0-1：一次 `goto` 到底不够 —— 卡住时按阶梯换策略再试（见上面的常量注释）。
   * 每一轮都是**全新的 `goto(同一个 goal 对象)`**：重发前先由 `escapeMove` 把上一轮真停掉，
   * 所以不会攒下重复的 `goal_reached` 监听器。 */
  let repathCount = 0
  /* P1：其中有多少次是**因为路径被反复失效**而进阶梯的（不是"没进展"）—— 分开报，
   * 因为给模型的下一步不同：一个该换目标点，一个该先看看世界在变什么。 */
  let pathThrash = 0
  /* 2026-10-18：窄隧道/台阶的"手工补救"（见 `carveStepAhead` 注释）。 */
  let carveTries = 0
  let carved = 0
  /* 2026-10-19：默认 `noTower` 让"往上一格"常常无路 —— 真走不通、目标又在上方时，
   * 允许**一次**垫柱兜底（只翻一次，别来回摇）。 */
  let towerTried = 0
  /* 因"门"重试的次数（用户 2026-10-18 指出缺口）：门开着重算一次就该走通；
   * 连着两轮还卡，说明不是门的事 ⇒ 交给脱困阶梯，别原地空转。 */
  let doorTries = 0
  let watch = null
  /* 执行层开门：规划已经允许穿门（canOpenDoors），但这份 vendor 的 `useOne` 没有执行者 ——
   * 一边走一边探身边有没有关着的门，够得着就按一下。只在移动期间跑，收尾必清。 */
  const doorTimer = setInterval(() => { openNearbyDoor(b).catch(() => {}) }, 400)
  doorTimer.unref?.()
  const doorsAt0 = Number(b.__doorOpens ?? 0)
  /** 脱困次数（P0-1）与路径失效次数（P1）：>0 才报 —— 模型据此知道"这次走得磕磕绊绊"。
   *  外加地形分类（P2）：只有不是平地时才报（平地是默认，报了纯占地方）。
   *  `opts.arrived` —— **到达时**把出发时那份改名成 `terrainAtStart`。到了新位置还叫 `terrain`
   *  会被读成"我现在脚边是这个"：从沟边跨到平地上，它仍写着 `gap`，属**主动误导**。 */
  /* 穿门结果（在 `try` 之前就要声明：`moveInfo()` 闭包要读它） */
  let doorWalk = null
  const moveInfo = (opts = {}) => ({
    ...(doorWalk ? { doorWalk } : {}),
    ...(terrain.kind === 'flat' || terrain.kind === 'unknown' ? {}
      : { [opts.arrived ? 'terrainAtStart' : 'terrain']: terrain.kind }),
    ...(() => {
      const n = Number(b.__doorOpens ?? 0) - doorsAt0
      return n > 0 ? { doorsOpened: n } : {}
    })(),
    ...(repathCount ? { repathCount } : {}),
    ...(terrainReeval ? { terrainReeval } : {}),
    ...(carved ? { carved } : {}),
    ...(pathThrash ? { pathThrash } : {}),
    ...(pathResetsTotal >= 1 ? { pathResets: pathResetsTotal, pathResetReasons: { ...resetReasons } } : {}),
  })
  /** 到达时**重算落点地形**：`classifyTerrainCached` 的缓存键含脚下坐标，走到新位置会自动重算，
   *  不用手动清缓存。平地/未知照旧不报（默认值）。 */
  const arrivedTerrain = () => {
    const now = classifyTerrainCached(b)
    if (now.kind === 'flat' || now.kind === 'unknown') return {}
    return { arrivedTerrain: now.kind, ...(now.note ? { arrivedNote: now.note } : {}) }
  }
  try {
    /* `attempt` 手动推进（不在 for 头里自增）："挖开挡路的台阶"是**同一次尝试内的重试**，
     * 不该白吃一级脱困阶梯 —— 2026-10-18 实机加的，见 `carveStepAhead`。 */
    /* 🔴 2026-10-18 实机（用户："你屋里我寻路进不去"的后续验证）：门开着时 A* 规划
     * "穿门那一格"偶尔原地磨到超时（`path_reset: goal_updated` 反复）。
     * 出门这一两步不交给 A*：先看着门中心物理走过去，再让 A* 走剩下的路。 */
    try {
      if (doorOnRoute(b, target, { cells: 2 }) && Date.now() - t0 < budget - 900) {
        const leftMs = Math.max(500, Math.min(1_600, budget - (Date.now() - t0) - 700))
        doorWalk = await walkThroughDoor(b, target, { budgetMs: leftMs })
        if (doorWalk?.passed) self.log(`🚪 从门里走过去（${doorWalk.door ?? '门'}）`)
      }
    } catch {}
    /* 2026-10-19 实机（lessons：`doorWalk:{passed:false, why:"closed"}` 时它直接放弃）：
     * 门没过去 = 再按一次门、再走一次，而不是立刻交给脱困阶梯。 */
    if (doorWalk && doorWalk.passed !== true) {
      try {
        const opened = await openNearbyDoor(b)
        const leftMs2 = Math.max(400, Math.min(1_200, budget - (Date.now() - t0) - 600))
        const again = await walkThroughDoor(b, target, { budgetMs: leftMs2 })
        doorWalk = { ...again, retry: true, opened: Number(opened) || 0 }
        if (again?.passed) self.log(`🚪 门没开透，补按 ${opened} 下后走过去了（${again.door ?? '门'}）`)
      } catch {}
    }
    let attempt = 0
    for (;;) {
      if (attempt > 0) {
        const step = escapeStepOf(attempt - 1)
        if (!step) {
          /* 阶梯走完还是没进展：**如果目标在上方、头顶又是空的**，先试一次垫柱兜底
           * （2026-10-19 实机：`noTower` 默认之后，楼梯/竖井这类"往上一格"目标反而更难上）。 */
          if (!towerTried) {
            const p0 = b.entity?.position
            const upGap = p0 ? Number(target?.y) - p0.y : 0
            const nameAt = (x, y, z) => { try { return b.blockAt(new Vec3(x, y, z))?.name ?? null } catch { return null } }
            const hardAt = (y) => { if (!p0) return true; const n = nameAt(Math.floor(p0.x), y, Math.floor(p0.z)); return Boolean(n) && isSolidBlock(n) }
            if (p0 && upGap >= 1.5 && !hardAt(Math.floor(p0.y) + 2) && !hardAt(Math.floor(p0.y) + 3)) {
              towerTried = 1
              const mv3 = ctx.movements(terrain)
              mv3.allow1by1towers = true
              if (noDig) mv3.canDig = false
              b.pathfinder.setMovements(mv3)
              self.log('🧱 目标在上方、头顶有空 —— 这次允许垫一格往上（只翻这一次）')
              attempt = 0
              continue
            }
          }
          // 阶梯走完还是没进展 —— 如实认输，**不再无限重试**
          const err = new Error(`脱困阶梯用完了（重算 ${repathCount} 次）还是走不动`)
          err.mcStuck = true
          err.mcExhausted = true
          throw err
        }
        repathCount++
        self.log(`🔁 走不动了 → 第 ${attempt} 级脱困：${escapeTextOf(step)}（累计重算 ${repathCount} 次）`)
        await escapeMove(b, goal, step, ctx)
        /* 地形局部重估（2026-10-18 审计 P1）：上一轮可能挖开了台阶/垫了方块/被浆果丛卡过 ——
         * 世界变了，出发时那份地形判断就不再可靠。只重判脚下这一圈（缓存键含坐标），
         * 类别真变了才重建 `Movements`，没有变化就完全不动。 */
        const fresh = classifyTerrainCached(b)
        if (fresh.kind !== terrain.kind && fresh.kind !== 'unknown') {
          terrainReeval++
          self.log(`🧭 脱困后地形变了：${terrain.text} → ${fresh.text}（按新地形重调权重）`)
          terrain = fresh
          const mv2 = ctx.movements(terrain)
          if (mv2) {
            if (noTower) mv2.allow1by1towers = false
            if (noDig) mv2.canDig = false
            b.pathfinder.setMovements(mv2)
          }
        }
      }
      pathResets = 0                               // 本轮重新数（脱困动作自己也会 reset 一次）
      const pfT0 = Date.now()
      const work = b.pathfinder.goto(goal)
      work.catch(() => {})                         // race 可能先结束：别让它变成"未处理拒绝"（会炸宿主）
      // `ctx.watchOpts` 是给离线测试注入假时钟用的（不然一套断言要真等 2.4 秒 × 4 轮）
      watch = moveProgressWatcher(b, target, {
        arrive, ty, resetsOf: () => pathResets, ...(ctx.watchOpts ?? {}),
      })
      try {
        await Promise.race([
          // 总时间仍以 `budget` 为界（脱困动作也吃时间，所以这里用**剩余**预算）
          raceAbort(withTimeout(work, Math.max(200, budget - (Date.now() - t0)), '寻路'),
            self.abortSignal, '寻路'),
          watch.promise,
        ])
        watch.stop(); watch = null
        break                                      // 正常结束（到了 / 普通失败）⇒ 下面照旧复核距离
      } catch (e) {
        watch.stop(); watch = null
        if (e?.mcPathThrash) pathThrash++          // P1：这次是被"路径反复失效"逼进阶梯的
        if (e?.mcStuck) {
          /* 2026-10-18：**阶梯之前**先试一次"挖开挡路的台阶/天花板"（见 `carveStepAhead`）。
           * 2026-10-18 审计后（Bug 3 / Bug 4）：
           *   · 挖**必须服从配置**：`walkCanDig:false`（寻路不许挖）或 `walkCarveStep:false`
           *     （单独关掉这个补救）时，一步都不许挖；
           *   · 该不该动手看**眼前障碍**（`obstacleAheadOf`），不是"离终点还剩几格" ——
           *     目标在 20 格外的台阶，照样卡在眼前这一格上。
           * 挖到了就重跑同一个 `goto`（不算一级脱困）。 */
          /* `!noDig`：`mc_move {noDig:true}` / `mode:"walk-nodig"` 是用户点名的
           * "不破坏方块"模式 —— 卡死也不许挖，宁可报 `blockedAhead` 让 AI 自己决定绕路。 */
          const carveAllowed = !noDig && ctx.cfg?.walkCanDig !== false && ctx.cfg?.walkCarveStep !== false
          /* 卡住时先按一下门（2026-10-18 实机：门关着，寻路不认 ⇒ 停 8 秒）。
           * 便宜、只读、无副作用：附近没有门就是一个空扫描。 */
          const doorOpened = await openNearbyDoor(b).catch(() => 0)
          /* 🔴 门"通不通" ≠ "这一轮新开了几扇"：门可能早被定时器/AI 开好了，
           *    `openNearbyDoor()` 这时返回 0。只看数量就会误判成"门口没门"，
           *    接着进挖台阶分支 —— 把门旁边的墙挖掉。 */
          const doorAlreadyOpen = doorOpened === 0 && doorAheadOpen(b, target)
          if (doorOpened > 0 || doorAlreadyOpen) {
            if (doorTries < 2) {
              doorTries++
              self.log(doorOpened > 0
                ? `🚪 卡在门口 —— 按开了 ${doorOpened} 扇门，再试一次`
                : '🚪 前方的门本来就开着 —— 重新算路再试一次（不挖墙）')
              attempt = Math.max(0, attempt - 1)   // 不算一级脱困：门开了原地就能继续走
              await sleep(120)                     // 等服务端把"已开门"的碰撞状态同步给客户端
              continue
            }
            /* 门开着重试两轮还是卡：不是门的问题，但**绝不能挖门边的墙**（那多半是把门框拆了）。
             * 直接交给脱困阶梯/失败出口（那里会报 `blockedAhead`/`shaft` 让 AI 决定）。 */
            self.log('🚪 门开着却还是过不去 —— 不挖墙，交给脱困阶梯')
            attempt++
            continue
          }
          /* 🔴 通行方向上还有门（关着/读不到/按不开）⇒ **一律不补挖**：
           *    门前那一格、门框、门槛都不是"挡路的台阶"，挖它们等于拆房子。
           *    交给脱困阶梯/失败出口，让 AI 看见 `blockedAhead`/`shaft` 自己决定。 */
          const doorBlocking = doorOnRoute(b, target)
          if (doorBlocking) {
            self.log(`🚪 前方 ${doorBlocking.name} 在通行路线上 —— 不挖门、门框、门槛，交给脱困阶梯`)
            attempt++
            continue
          }
          if (carveAllowed && carveTries < MOVE_CARVE_TRIES) {
            const end = b.entity.position
            const dNow = Math.hypot(end.x - target.x, end.z - target.z)
            const obstacle = obstacleAheadOf(b, target)
            if (dNow <= MOVE_CARVE_RADIUS || obstacle) {
              carveTries++
              try { ctx.stopPathing?.(b) } catch {}
              await sleep(60)
              const n = await carveStepAhead(b, target, { ignoreRange: true })
              if (n > 0) {
                carved += n
                self.log(`⛏ ${obstacle ? `眼前 ${obstacle.name} 挡路` : `离目标 ${dNow.toFixed(1)} 格走不动`} —— 挖开了 ${n} 格，再试一次`)
                continue
              }
            }
          }
          attempt++                                // 卡住 ⇒ 下一轮走脱困阶梯
          continue
        }
        throw e
      } finally {
        /* 这一轮 `goto` 的墙钟（含脱困动作之前的等待）—— 见文件头 import 处的说明。
         * `continue` / `throw` 之前都会走到这里。 */
        perfWait('path', Date.now() - pfT0)
      }
    }
    const end = b.entity.position
    // 复核距离要用**收过的 ty**（不然目标 y 在半空时，明明站到它脚下了也会被判成"还差 9 格"）
    const left = end.distanceTo(new Vec3(target.x, ty, target.z))
    /* P1：**到达判定分两轴看** —— 只看三维距离会漏掉一种假成功：水平已经到位、垂直却差着一两格
     * （站在目标正上方/正下方，比如目标格旁边有个坑），三维距离照样小于阈值 ⇒ 被报成"到了"。
     * 水平仍用 `arrive + 1.0`（宽松，允许"到附近"）；垂直卡在 ±1.5 格（一步台阶以内）。 */
    const horiz = Math.hypot(end.x - target.x, end.z - target.z)
    const vert = end.y - ty
    const vertBad = vert < -vertTol || vert > vertTol
    /* 🔴 2026-10-18 审计（用户转来的报告 Bug 1）：判"到没到"**不能先看距离、后看"是不是我的目标"**。
     *    vendor 的 `goal_reached` 是全局事件，别人的移动到点会把我这次 goto 一起 resolve；
     *    只要人恰好落在宽松距离（`arrive + 1.0`）以内，旧代码就直接报 arrived，绕过了 mine 诊断。
     *    现在先算 mine：`mine === false` 一律按"不是我的目标"处理（走下面 goal-reached-elsewhere），
     *    距离只用来区分"插件早报但确实是我的目标"。`mine === null` = 判不了（假 bot 没有真 Vec3）。 */
    const fp = typeof end?.floored === 'function' ? end.floored() : null
    const up1 = fp && typeof fp.offset === 'function' ? fp.offset(0, 1, 0) : null
    const mine = !fp || typeof goal?.isEnd !== 'function' ? null
      : Boolean(goal.isEnd(fp) || (up1 && goal.isEnd(up1)))
    // ⚠️ 现成的插件报"到了"，也**自己核一遍距离**：`goal_reached` 个别情况会早一点
    //    （目标格被占住 / 站在半砖上 / 只到附近），盲信就又变成"谎报 arrived"。
    /* 站在目标点上（≤0.5 格）就不必再问 `isEnd`：GoalNear 的半径本来就允许这一圈。
     * 反过来，只要离得远、又不满足当前 goal，就一律先按"不是我的目标"处理。 */
    const onSpot = left <= 0.5 && !vertBad
    if (!onSpot && (mine === false || left > arriveUsed + 1.0 || vertBad)) {
      // 🔴 先分清"插件真的早报"还是"别人的 goal_reached 把我这次 goto 一起 resolve 了"。
      //    vendor 的 lib/goto.js:60 监听的是 bot 上的**全局** `goal_reached`，`goalReached()`
      //    连事件带的 goal 参数都不看 ⇒ 自主层的逃跑/跟随同时在走时，**它**到点会顺手把
      //    我这次 goto resolve 掉。实机表现（2026-10-06 打怪实测）：连续 19 次 mc_move
      //    秒返回 `moved=0` + `goal_reached-but-far`，模型被告知"插件说到了但还差 5 格"。
      //    判据：pathfinder 自己用的是 `stateGoal.isEnd(pos.floored())`（index.js:590，
      //    还允许 +1 格），**我自己的 goal 没满足 ⇒ 这次 resolve 必然来自别人的 goal**。
      if (self._moveGen !== gen) {
        return {
          arrived: false, position: at(end), ms: Date.now() - t0,
          remaining: Number(left.toFixed(2)),
          ...deltaOf(end),
          via: 'pathfinder', stuck: true, reason: 'preempted',
          ...roadInfo(), ...moveInfo(), ...fellInfo(end),
          hint: `${fellNote(end)}这次走路被**另一次移动**接管了（旁边有怪时是自保反射先跑，也可能是又发了一次 mc_move）：`
            + `我从 ${startRemaining.toFixed(1)} 格挪到了 ${left.toFixed(1)} 格，但走到目标的是那一份。`
            + (fellOf(end) != null
              ? '**先别急着再叫 mc_move** —— 你刚掉下来，先站稳、看清脚下和四周，再决定往哪走。'
              : '等它结束，再叫一次 mc_move 往同一个目标走就行，**不是走不通**。'),
        }
      }
      /* 🔴 2026-10-08 审计③：走到这里 = "goto 无错 resolve 但我没到"，两种成因**必须分开说**：
       *    · `emptyNoPath`：A* 连一个邻居都生成不出来（空路径假成功）⇒ **真没路**，再叫也没用；
       *    · `mine === false`：vendor 的 `goal_reached` 是**全局**事件（`lib/goto.js:60`），
       *      自主层的逃跑/跟随到点时会顺手把我这次 goto resolve 掉 ⇒ 只是被别人的到点顶了。
       *    旧代码两种都报 `preempted` + "不是走不通"，把"死路"说成"再叫一次就行"。 */
      /* P1：**"站错层"要优先于"别人的锅"报出来** —— 水平已经到位（`horiz` 落在"到附近"以内）
       * 却差了 1.5 格以上的高度时，成因是**这一层站错了**，不是"另一次寻路到点把我顶掉"、
       * 也不是"没路"。⚠️ 旧代码在这条路上会一路落进下面 `mine === false` 那条诊断：插件自己的
       * `GoalNear` 是**三维球**（半径 `round(arrive-0.6)`），人站在上层它当然不满足 ⇒ `mine` 为假，
       * 于是把"高度不对"说成"别人的锅"，模型就一直重叫同一个目标。 */
      if (vertBad && horiz <= arriveUsed + 1.0) {
        return {
          arrived: false, position: at(end), ms: Date.now() - t0,
          remaining: Number(left.toFixed(2)),
          ...deltaOf(end),
          via: 'pathfinder', stuck: true, reason: 'goal_reached-but-far', ...moveInfo(), ...fellInfo(end),
          // P1：把两个轴分开报 —— 否则"水平到了但高了两格"看起来和"还差 5 格"一模一样
          horiz: Number(horiz.toFixed(2)), vert: Number(vert.toFixed(2)),
          hint: `${fellNote(end)}寻路插件说到了，但**高度不对**：水平只差 ${horiz.toFixed(1)} 格，垂直差了 ${Math.abs(vert).toFixed(1)} 格`
            + `（我${vert > 0 ? '站在目标上方' : '站在目标下方'}）—— 先 \`mc_move\` 走到目标**同一层**，或换个目标点。`,
        }
      }
      if (emptyNoPath || mine === false) {
        return {
          arrived: false, position: at(end), ms: Date.now() - t0,
          remaining: Number(left.toFixed(2)),
          ...deltaOf(end),
          via: 'pathfinder', stuck: true,
          reason: emptyNoPath ? 'NoPath' : 'goal-reached-elsewhere',
          ...roadInfo(), ...moveInfo(), ...fellInfo(end),
          hint: emptyNoPath
            ? `${fellNote(end)}寻路**没路可走**（被墙 / 水 / 悬崖挡住，或目标在实心方块里）：离目标还有 ${left.toFixed(1)} 格。`
              + '先 `mc_scan` 看挡路的是什么：是方块就 `mc_act{mode:"break"}` 挖开；'
              + '**是沟/缺口就 `mc_act{mode:"bridge"}`**（寻路插件不会水平搭桥，只会报没路）——'
              + '朝对岸那一格铺过去（x/y/z 给对岸**脚下一层**的坐标）。换个目标点再叫 mc_move 也一样走不通。'
            : `寻路插件报的"到了"**不是我这次的目标**（另一次寻路到点时顺手把我这次 goto 一起 resolve 掉了）`
              + `—— 我还在 ${left.toFixed(1)} 格外：等它结束，再叫一次 mc_move 往同一个目标走就行，**不是走不通**。`,
        }
      }
      return {
        arrived: false, position: at(end), ms: Date.now() - t0,
        remaining: Number(left.toFixed(2)),
        ...deltaOf(end),
        via: 'pathfinder', stuck: true, reason: 'goal_reached-but-far', ...moveInfo(), ...fellInfo(end),
        hint: `${fellNote(end)}寻路插件说到了，但离目标还有 ${left.toFixed(1)} 格（可能被占住或只到附近）—— 再走一次，或换个目标点。`,
      }
    }
    /* 🔴 2026-10-19：目标（或旁边）是**传送门**时，"站在那一格上"还不算完 ——
     *    服务端要等人真的进入门方块才发传送包。寻路器只肯走到门边（半径 0 也只是贴到格心），
     *    所以这里补最后一步：朝门那格顶一下，再按"维度变了 / 位置瞬移了"判进没进。 */
    let portalInfo = null
    if (portal) {
      let step = { entered: false }
      try { step = await stepIntoPortal(b, portal, { ms: 700, signal: self.abortSignal }) } catch { step = { entered: false } }
      portalInfo = { name: portal.name, at: { x: portal.x, y: portal.y, z: portal.z }, entered: step.entered === true }
    }
    return {
      arrived: true,
      position: at(end),
      ms: Date.now() - t0,
      ...(portalInfo ? { portal: portalInfo } : {}),
      ...deltaOf(end),
      /* 到了也报 `remaining`（实机第 6 跑：`walkTo` 明明到了、`remaining` 却是 undefined，
       * 测试脚本只能打 `-`，看着像"谎报到达"）。 */
      remaining: Number(left.toFixed(2)),
      via: 'pathfinder',
      ...(dug ? { dug } : {}), ...(placed ? { pillared: placed } : {}), ...roadInfo(),
      ...moveInfo({ arrived: true }), ...arrivedTerrain(), ...fellInfo(end),
      /* 2026-10-18 审计 P1-3：规划耗时（第一次算出路径）/ 实际移动耗时，分开报 ——
       * "一直没动"到底是 A* 在算、还是腿在挪但被挡住，一眼能看出来。 */
      timing: { planMs: plannedAt ? plannedAt - t0 : null, walkMs: plannedAt ? Date.now() - plannedAt : null, totalMs: Date.now() - t0 },
      ...(portalInfo && !portalInfo.entered
        ? {
            hint: `我站到了**${portalInfo.name}**这一格（${portalInfo.at.x}, ${portalInfo.at.y}, ${portalInfo.at.z}）上，`
              + '但**还没被送走** —— 传送是服务端结算的：再叫一次 `mc_move` 往同一格走，或 `mc_move {mode:"jump"}` 原地跳一下；'
              + '还不行就是服务端/客户端不同步（`mc_connect {force:true}` 重登会把它结算掉）。'
              + '**别自己垫方块/挖方块硬闯**（以前就是这么把简单事做难的）。',
          }
        : {}),
    }
  } catch (e) {
    if (e?.mcAborted) throw e
    const end = b.entity.position
    const d = deltaOf(end)
    const moved = d.moved
    const remaining = Number(end.distanceTo(new Vec3(target.x, ty, target.z)).toFixed(2))
    /* P0-1：`mcStuck` = 采样器判卡住（脱困阶梯走完还没进展）—— 这跟"时间用完了"、
     * "被抢占"、"没路可走"都是**不同结局**，必须分开报，否则模型会继续原地重发。 */
    const exhausted = Boolean(e?.mcStuck)
    const nm = exhausted
      ? (pathThrash
        ? `**路一直在被改 / 一直被挡**（脱困 ${repathCount} 次，其中 ${pathThrash} 次是"路径被反复失效"）`
        : `**真的走不动了**（原地试了 ${repathCount} 次脱困：重算路径 / 跳跃 / 后退，位置都没改善）`)
      : e?.mcTimeout ? `走了 ${Math.round((Date.now() - t0) / 1000)} 秒还没到`
      : e?.name === 'NoPath' ? '寻路说**没路可走**（被墙/水/悬崖/沟挡住，或目标在实心方块里）'
        : e?.name === 'Timeout' ? '寻路想路线超时'
          : e?.name === 'PathStopped' || e?.name === 'GoalChanged' ? '寻路被打断'
            : `寻路失败（${e?.name ?? '错误'}：${String(e?.message ?? '').slice(0, 80)}）`
    // 是"这一轮 11 秒用完了"还是"真走不通"—— 给模型的下一步完全不同。
    // 🔴 第三种情况最容易漏：`budget` 本身就被 `CALL_BUDGET_MS`（10 秒）压过 —— 走长路
    //    到点返回是**正常**的，不是死路。以前只看 `msLeft() <= 400`，DSH 把截止时刻设成
    //    一整轮时，预算到点的 `msLeft()` 还剩 ~1 秒 → 判成"真走不通"，
    //    于是模型被告知"换个目标点"，明明再叫一次就能接着走。
    const cutByCall = Boolean(e?.mcCallOver) || self.msLeft() <= 400
    /* 🔴 2026-10-15 审计（报告 C 第 4 条）：这里原来还有第三个析取
     *    `Boolean(e?.mcTimeout) && budget <= Number(budgetAsked ?? budget) + 50` ——
     *    而 `budget = min(callBudget(budgetAsked), leftMs)` **恒 ≤ budgetAsked**；`budgetAsked` 缺省时
     *    退化成 `budget <= budget + 50`，也恒真 ⇒ 整个条件**恒真**（`reason: 'timeout'` 那条分支
     *    因此永远走不到）。副作用更糟：下面 `noProgress && !cutByCall` 那条"真没走通"永远为假，
     *    一格没挪也会被告知"这一轮的走路时间用完了、**不是走不通**" —— 正是 2026-10-08 那次审计
     *    要修的病。改成如实区分两件事：`cutByCall`（这一轮的时间用完了）与 `timeUp`（预算到点）。
     *    注意 `timeUp` **不能**再退回"恒真" —— 它只用于选文案，判据是"内部计时器真的响过"。 */
    const timeUp = cutByCall || Boolean(e?.mcTimeout)
    // 被抢占（自保反射先跑 / 又发了一次 mc_move）：编号已经不是我的了。
    // 这跟"走不通"完全是两回事 —— 必须说清楚，否则模型会以为目标不可达。
    const preempted = self._moveGen !== gen
    /* 🔴 2026-10-08 审计（会话 step 789 实机）：
     *    `{"moved":0,"remaining":2.3,...,"reason":"Error","hint":"…挪了 0 格）—— 这一轮的走路时间用完了，
     *      **不是走不通**：直接再叫一次 mc_move 往同一个目标走，会接着走。"}`
     *    —— 4 秒一格没挪，却告诉模型"不是走不通"，于是它一次次重发同一个走不到的点。
     *    判据补一条：**既没挪动、也没靠近** 就不算"时间到了"，得如实说卡住了。 */
    const noProgress = moved < 0.6 && remaining >= startRemaining - 0.3
    /* P1（用户报告“失败结果要可操作”）：卡住时别只说"没路/没进展"，把眼前那格也报出来，
     * 让 AI 自己决定挖、绕、搭桥还是换目标 —— 走路层不替它做这个决定。 */
    let blockedAhead = null
    try { blockedAhead = obstacleAheadOf(b, target) } catch { blockedAhead = null }
    /* `reason` 也别把内部字符串原样透出去（旧版漏出过 `Error` / `block_updated`） */
    /* 🔴 2026-10-21 用户：「我看经常 reset」—— 原来这张表只认得 5 个理由，vendor 真正会发的
     *    `chunk_loaded`（走一趟要触发好多次，属于正常重算）、`goal_moved`、`movements_updated`、
     *    `dig_error`、`place_error`、`no_scaffolding_blocks` 全落进兜底的 'path-reset'，
     *    看起来就像「老是路被重置」。现在逐条翻成人话，看到就知道是哪一类。 */
    const REASON_TEXT = {
      stuck: 'stuck（3.5 秒没挪动，vendor 自己判的）',
      block_updated: 'block-changed（路过的方块变了）',
      goal_changed: 'goal-changed（目标被换掉）',
      goal_moved: 'goal-moved（目标点动了）',
      path_stopped: 'stopped（被主动停）',
      chunk_loaded: 'chunk-loaded（区块刚加载，正常重算）',
      movements_updated: 'movements-updated（移动配置变了）',
      dig_error: 'dig-error（该挖的没挖成）',
      place_error: 'place-error（该垫的没垫成）',
      no_scaffolding_blocks: 'no-scaffolding（没方块可垫）',
      path_reset: 'path-reset（其它原因）',
    }
    const PF_ERR = new Set(['NoPath', 'Timeout', 'PathStopped', 'GoalChanged', 'NoPathFound'])
    /* 🔴 2026-10-08 实机（熔炼验证，真服）：`why` 记的是**中途**事件（`path_reset` 在
     *    A* 重算 / 踩到方块更新 / 3.5 秒没推进时都会发），不能拿它盖过"这一轮时间用完了"
     *    这个真正结局 —— 那次跑出 `{"moved":32,"remaining":6.11,"reason":"path-reset"}`，
     *    10 秒明明正常挪了 32 格、只是预算到点，模型看到 "path-reset" 却会以为路被重置了、
     *    以为走不通。时间到点 + 有进展 ⇒ 如实报 budget/timeout。 */
    const reasonOut = preempted ? 'preempted'
      : exhausted ? 'unreachable'
      : (e?.mcTimeout && !noProgress ? (cutByCall ? 'budget' : 'timeout')
        : (why ? (REASON_TEXT[why] ?? 'path-reset') : (PF_ERR.has(String(e?.name)) ? String(e.name) : 'walk-failed')))
    /* 🔴 2026-10-19 用户：「还有把末影传送门视为危险方块」——
     *    寻路说"没路"，可人明明就站在传送门边上（要塞那趟就是这样：门格与地板同层，
     *    A* 生成不出"站进门里"的节点）。这时候**直接迈进去**，不再走
     *    "门上方垫方块 → 挖掉 → 让自己掉下去"那套又慢又容易摔/被踢的老办法。 */
    if (portal && !preempted && remaining <= 4) {
      let step = { entered: false }
      try { step = await stepIntoPortal(b, portal, { ms: 700, signal: self.abortSignal }) } catch { step = { entered: false } }
      if (step.entered === true) {
        return {
          arrived: true,
          position: at(b.entity.position),
          ms: Date.now() - t0,
          remaining: 0,
          via: 'portal',
          portal: { name: portal.name, at: { x: portal.x, y: portal.y, z: portal.z }, entered: true },
          hint: `寻路说没路，但我已经在 **${portal.name}** 边上，就直接迈进去了 —— **已被传送走**（维度或位置变了）。`,
        }
      }
    }
    return {
      arrived: false,
      position: at(end),
      ms: Date.now() - t0,
      remaining,
      ...d,
      via: 'pathfinder',
      stuck: true,
      reason: reasonOut,
      ...(dug ? { dug } : {}), ...(placed ? { pillared: placed } : {}), ...roadInfo(), ...moveInfo(), ...fellInfo(end),
      ...(blockedAhead ? { blockedAhead } : {}),
      /* 2026-10-18 审计 P1-1：走不到时把"头顶/四面/能垫的方块"一次给全 */
      ...((exhausted || e?.name === 'NoPath') && !preempted ? (() => { const sh = shaftInfoOf(b, target); return sh ? { shaft: sh } : {} })() : {}),
      hint: `${fellNote(end)}${nm}（从 ${startRemaining.toFixed(1)} 格变成 ${remaining.toFixed(1)} 格，挪了 ${moved} 格${vertNote(end)}）`
         // 地形那一句（导航 P2）：只在**真有用**的时候说 —— 沟要说"用 bridge"，
         // 危险地形要说"别走这边"，平地/未知不说（说了纯占地方）
         // 眼前那格挡路的方块（P1：AI 自己决定挖/绕/搭桥，走路层只把事实摆出来）
         + (blockedAhead && !preempted
           ? `—— 眼前挡路的是 **${blockedAhead.name}**（${blockedAhead.cell === 'feet' ? '齐脚那格' : '头顶那格'} `
             + `${blockedAhead.x},${blockedAhead.y},${blockedAhead.z}）：挖得动的话直接 `
             + (DOOR_RE.test(blockedAhead.name)
               ? `是**门**：\`mc_act {mode:"use", x:${blockedAhead.x}, y:${blockedAhead.y}, z:${blockedAhead.z}}\` 按开它（或走近再叫一次 mc_move，会自动开门），**别挖墙也别挖门**。`
               : `\`mc_act {mode:"break", x:${blockedAhead.x}, y:${blockedAhead.y}, z:${blockedAhead.z}}\` 挖掉它，再叫 mc_move。`)
           : '')
         + (!preempted && terrain.kind === 'gap'
           ? `—— 你脚边是**${terrain.text}**（${terrain.note}）：别绕着试了，直接 \`mc_act {mode:"bridge"}\` 朝目标搭过去。`
           : !preempted && terrain.kind === 'hazard'
             ? `—— 你脚边是**${terrain.text}**（${terrain.note}）：别从这边走，换个方向绕。`
             : '')
         + (!preempted && !exhausted && pathResetsTotal > 0
           ? `—— 途中路径被重算了 ${pathResetsTotal} 次`
             + `（${Object.entries(resetReasons).map(([k, v]) => `${REASON_TEXT[k] ?? k}×${v}`).join('、')}）：`
             + '**不是走不通** —— chunk-loaded 那种是正常重算，stuck 是挪不动被 vendor 判的；直接再叫一次 mc_move 往同一目标走就行。'
           : '')
         + (preempted
           ? (fellOf(end) != null
            ? '—— 这次走路被**另一次移动**打断了（旁边有怪时是自保反射先跑），但更值得注意的是：**你刚掉下来了**。先站稳、看清脚下，再决定往哪走，别对着同一个高度反复爬。'
            : '—— 这次走路被**另一次移动**打断了（旁边有怪时是自保反射先跑，也可能是又发了一次 mc_move）：等它结束，再叫一次 mc_move 往同一个目标走就行，**不是走不通**。')
           : exhausted
             ? (pathThrash
               ? `—— 这一轮**路径被重算了 ${pathResetsTotal} 次**`
                 + `（${Object.entries(resetReasons).map(([k, v]) => `${REASON_TEXT[k] ?? k}×${v}`).join('、')}）：`
                 + '说明**路一直在被世界变化打断**（别人放的方块 / 走过来的实体 / 岩浆流 / 方块更新），'
                 + '不是"找不到路"——光重算没用，所以停了。**换个走法**：'
               : '')
               /* 2026-10-18 实机：1×2 窄道里的 1 格台阶，人贴在目标 0.8 格处一步不动。
                * 自动补救（carveStepAhead）已经试过两次；还不行就把"手工挖台阶"的办法交给模型。 */
               + (!preempted && remaining <= 2.5 && (carved || carveTries)
                 ? `—— 你离目标只剩 ${remaining.toFixed(1)} 格，多半是**窄道/台阶**：脚下或头顶有一格挡着。`
                   + '照实机的办法来：先 `mc_act {mode:"break",x:…,y:…,z:…}` 挖掉**脚前那一格**，再用同样方式挖掉它**头顶那一格**，然后叫 `mc_move` 走一步。'
                 : '')
               + `—— **别原地重试了**（已经替你换过 ${repathCount} 次策略都没用）：把长路**拆成几段**，`
               + '先走到中间一个能站住的点、再走下一段；或者用 `mc_scan` 看挡在中间的是什么（墙 / 水 / 栅栏 / 半砖）。'
               + '　要是"脚下明明没东西却还是走不动"，可能是我这边的世界和服务端对不上（客户端预测的方块缓存）——'
               + '走远 32 格再回来让区块重发。'
               + DESYNC_HINT
             : noProgress && !timeUp
             ? '—— **是真没走通**（一格没挪、也没靠近）：先 `mc_act {mode:"jump"}` 蹦一下（可能是卡在方块里 / 台阶上），再 `mc_scan` 看脚下和目标那格是什么；换个近一点的目标点通常更快。'
                  + '　要是"脚下明明没东西却还是走不动"，可能是我这边的世界和服务端对不上（客户端预测的方块缓存）——'
                  + '走远 32 格再回来让区块重发。'
                  + DESYNC_HINT
             : timeUp
               ? `—— 这一轮的走路时间用完了（单次调用最多 ${budgetSecText()}），**不是走不通**：直接再叫一次 mc_move 往同一个目标走，会接着走。`
               : noProgress
                 ? '—— 这一轮**一格没挪**（时间到了，但也没靠近）：再叫一次 mc_move 试试；两次都一样就换个目标点。'
                 : '—— 换个能走到的目标点，或先解除挡住它的方块。'),
    }
  } finally {
    // P0-1：采样器的定时器必须收掉 —— 留着会把进程钉住（也会在返回之后误判"卡住"）。
    try { clearInterval(doorTimer) } catch {}
    try { watch?.stop() } catch {}
    for (const [ev, fn] of off) { try { b.removeListener?.(ev, fn) } catch {} }
    // 🔴 只有"我还是最新那次移动"才允许收尾（停 pathfinder + 松控制位）。
    //    被抢占时绝不能动：否则会把正在走的那一份一起停掉 —— 实机表现就是
    //    "动了一下不动了"。见 _moveGen 的注释。
    if (self._moveGen === gen) {
      // 🔴 2026-10-08 审计②：`stop()` 只是置标志 —— 必须 `setGoal(null)` 才真停
      //    （详见 #stopPathing 的注释：不然控制位会被插件按回去，甚至返回之后才开始挖方块）。
      try { ctx.stopPathing(b) } catch {}
      ctx.releaseControls()
    }
  }
}
