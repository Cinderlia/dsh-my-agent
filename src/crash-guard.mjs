/**
 * dsh-mc-agent / crash-guard.mjs —— 把「寻路被停」这类**已知良性**的未处理拒绝挡在宿主之外。
 *
 * 背景（2026-10-20，GitHub issue #1，用户 Hankxu-316 报的，附完整栈）：
 *   MC 模式正常游玩，`mc_move` 被调度器抢占之后**整个 DSH 应用闪退**（不是掉线），
 *   一晚上复现 3 次，栈一模一样：
 *
 *     [调度器] 动作 a19 mc_move（用户）持 movement 44892ms preempted
 *     ⚠️ 未处理拒绝（宿主可能会因此 exit(1)…）：PathStopped: Path was stopped before it could be completed!
 *        at error (mineflayer-pathfinder/lib/goto.js:2)
 *        at EventEmitter.pathStopped (goto.js:40) → emit → stop (index.js:394) → resetPath (139)
 *        at bot.pathfinder.setGoal (146) → goto.js:64 → bot.pathfinder.goto (159)
 *
 * 为什么现有的两层保险没盖住：
 *   ① `src/movement.mjs` 里 `const work = b.pathfinder.goto(goal); work.catch(() => {})` ——
 *      盖住的是 `goto` **直接返回的那个 promise**；
 *   ② `src/plugins.mjs` 的 `guardPathfinderRejections()` —— 同样只包住那一个返回值。
 *   但真正泄出来的是**派生链**：`withTimeout(work, …)` → `raceAbort(...)` → `Promise.race([...])`，
 *   或者 `mineflayer-collectblock` 内部 co 生成器里 `yield bot.pathfinder.goto(...)` 包出来的那个；
 *   别人先赢、派生 promise 后来才 reject ⇒ 没人接了。**往里补 catch 是补不完的。**
 *
 * 做法（issue 给的方向，采纳）：不动 `process.exit`（拦不住），而是**别让宿主的 fail-loud 收到这条拒绝** ——
 *   把现有的 `unhandledRejection` 监听摘下来，换一个"白名单内吞掉并记日志、其余原样转交"的包装。
 *   宿主装的是 `installFailLoud()`（`packages/boot/app-boot/src/index.ts`），任何未处理拒绝都当致命 ⇒ exit(1)。
 *
 * 白名单只有三个名字，全是 pathfinder 的**正常语义**（被新的目的地顶掉、没路、目标变了）：
 *   `PathStopped` / `NoPath` / `GoalChanged`（还有 goto.js 里的 `Timeout`，见下）。
 *   **不吞别的**：真 bug 照旧转交给宿主，让它崩、让它留栈 —— 我们不掩盖错误。
 *
 * 开关：环境变量 `DSH_MC_AGENT_REJECTION_GUARD=off`（`0/no/false` 同义）关掉。
 */

/** pathfinder 的"这次走不了"四种结局 —— 都是可控语义，不是 bug。 */
export const PATH_REJECTION_NAMES = Object.freeze(['PathStopped', 'NoPath', 'GoalChanged', 'Timeout'])

const OFF_RE = /^(0|off|false|no|disable|disabled)$/i

/** 已装的话把状态放这儿（幂等标记 + 给自检/诊断看） */
const STATE = Symbol.for('dsh-mc-agent.rejectionGuard')

const nameOf = (reason) => String(reason?.name ?? reason?.constructor?.name ?? '')

/**
 * 装守卫。**幂等**：重复调用不会重复包装（`installed:false, reason:'already'`）。
 *
 * @param log      记一行日志（默认什么都不做 —— 调用方传自己的 logLine）
 * @param names    白名单（默认 `PATH_REJECTION_NAMES`）
 * @param enabled  显式开关；不传就看环境变量（`off` 系列值 = 关）
 * @returns {{installed:boolean, reason?:string, forwarded?:number, existing?:number}}
 */
export function installRejectionGuard ({ log = null, names = PATH_REJECTION_NAMES, enabled = null } = {}) {
  if (process[STATE]) return { installed: false, reason: 'already' }

  const on = enabled === null
    ? !OFF_RE.test(String(process.env.DSH_MC_AGENT_REJECTION_GUARD ?? ''))
    : enabled === true
  if (!on) return { installed: false, reason: 'disabled' }

  const allow = new Set((Array.isArray(names) ? names : PATH_REJECTION_NAMES).map(String))
  /* 把现有的监听**全摘下来**（宿主的 fail-loud 排在前面，我们自己那条"遗言"也在里面），
   * 然后只挂自己这一条：白名单内吞、其余逐个转交。 */
  const existing = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')

  const say = typeof log === 'function' ? log : () => {}
  const st = { swallowed: 0, forwarded: 0, lastFew: [] }

  const handler = (reason, promise) => {
    const nm = nameOf(reason)
    if (allow.has(nm)) {
      st.swallowed++
      st.lastFew.push(nm)
      if (st.lastFew.length > 5) st.lastFew.shift()
      /* 每次只记一行、最多 20 行：这东西可能一晚上几十次，别把日志刷爆 */
      if (st.swallowed <= 20) say(`寻路拒绝已拦下（不会让宿主 exit）：${nm} — ${String(reason?.message ?? '').slice(0, 120)}`)
      return
    }
    st.forwarded++
    for (const h of existing) {
      try { h.call(process, reason, promise) } catch (e) {
        try { say(`转交未处理拒绝给原监听时出错（不影响）：${e?.message ?? e}`) } catch {}
      }
    }
  }

  process.on('unhandledRejection', handler)
  process[STATE] = { handler, existing, allow, st }

  return { installed: true, forwarded: existing.length, existing: existing.length }
}

/** 卸掉（自检用；生产没人调）。 */
export function uninstallRejectionGuard () {
  const s = process[STATE]
  if (!s) return false
  process.removeListener('unhandledRejection', s.handler)
  for (const h of s.existing) process.on('unhandledRejection', h)
  delete process[STATE]
  return true
}

/** 统计（诊断用）：吞了几条、转交几条、最近几条是谁。 */
export function rejectionGuardStats () {
  const s = process[STATE]
  if (!s) return { installed: false }
  return {
    installed: true,
    allow: [...s.allow],
    swallowed: s.st.swallowed,
    forwarded: s.st.forwarded,
    lastFew: [...s.st.lastFew],
    wrapped: s.existing.length,
  }
}

/**
 * 补挂：如果**装完之后**又有人注册了 `unhandledRejection`（宿主的 fail-loud 可能在插件之后才装，
 * 或者别的插件后来插了一条），那条会排在我们的 handler **后面**单独跑 —— 我们拦下的它照样能收到，
 * 于是还是会 exit。这里把"不是我们自己那条"的监听摘下来收进 `existing`，保持"只有我们一个 handler"。
 *
 * 幂等、便宜（一次 listeners 快照）；建议起一个低频定时器调它。
 *
 * @returns 新收编了几条
 */
export function refreshRejectionGuard ({ log = null } = {}) {
  const s = process[STATE]
  if (!s) return 0
  const others = process.listeners('unhandledRejection').filter((h) => h !== s.handler)
  if (!others.length) return 0
  for (const h of others) {
    process.removeListener('unhandledRejection', h)
    s.existing.push(h)
  }
  const say = typeof log === 'function' ? log : () => {}
  try { say(`未处理拒绝守卫：又收编了 ${others.length} 个后挂的监听（保持"只有我们一个 handler"）`) } catch {}
  return others.length
}
