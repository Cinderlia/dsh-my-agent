// -*- coding: utf-8 -*-
/**
 * dsh-mc-agent / async-util.mjs —— 异步小工具（`sleep` / `withTimeout` / `raceAbort` / `abortError`）
 * ---------------------------------------------------------------------------
 * 从 `src/core.mjs` 搬出来的（路线图第 ④ 条第三刀，2026-10-08）。
 *
 * 挑它的理由：这四个是**叶子** —— 不碰 `this`、不碰 mineflayer、不碰事件、不碰世界，
 * 只是 Promise 与 AbortSignal 的算术；而且 `withTimeout` 被 4 个扩展
 * （`mc_chest` / `mc_craft` / `mc_furnace` / `mc_observe`）从 `../src/core.mjs` 导入，
 * `raceAbort` 被 `selfcheck.mjs` 从 `./src/core.mjs` 导入 ⇒ `core.mjs` 必须
 * **保留同名导出**（re-export），外部 import 一行都不用改。
 *
 * 迁移规矩（见 README「渐进拆分 core.mjs」）：
 *   1. 一次只搬一个模块；
 *   2. `core.mjs` 保留同名导出；
 *   3. 搬完先 `grep` 被搬走的名字 —— 套件里"按文件找代码"的静态断言要跟着改（踩坑档案第 46 条）；
 *   4. **移动和挖掘最后再拆**（共享状态、异步中断、事件监听最密）。
 */

/** 等一会儿（毫秒）。 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 给可能永不 settle 的 promise 套超时。超时抛出的错误带 `mcTimeout: true`。
 */
export function withTimeout (promise, ms, label) {
  let timer
  const guard = new Promise((_, reject) => {
    // ⚠️ 这里**故意不 unref**：守卫定时器代表"有真实工作在等"，unref 掉会让
    //    "只有它在跑"时进程直接退出、超时永不触发（selfcheck 里实测踩到）。
    timer = setTimeout(() => reject(new Error(`__MC_TIMEOUT__${label}`)), ms)
  })
  return Promise.race([promise, guard])
    .catch((e) => {
      if (String(e?.message ?? '').startsWith('__MC_TIMEOUT__')) {
        // ⚠️ 这句文案以前写的是"服务端没有回应，机器人可能已失步"——**误导**：
        //    超时的绝大多数原因是**目标够不着 / 寻路失败**（本地算的，跟服务端无关），
        //    模型看到"可能已失步"就会去 mc_connect 重连，白断一次线。
        //    改成如实描述 + 说清"已经做了什么"，让它先换目标而不是先重连。
        const err = new Error(`${label} 超时（${ms}ms）：这一步在限定时间内没做完`
          + '（常见原因：目标够不着、寻路失败，或服务端没回应）。'
          + '控制位已经松开；如果是挖方块/采集，后台任务也已经停掉。'
          + '可以换个近一点/好走的目标点重试，或先用 mc_status / mc_diag 看状态。')
        err.mcTimeout = true
        throw err
      }
      throw e
    })
    .finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * 与 AbortSignal 赛跑 —— 让"停止按钮"真正有效。
 *
 * 为什么必须单独做：宿主的停止链路（GUI 停止键 → POST /api/session/cancel →
 * `agent.cancel({kind:'user'})` → `phase.abort.abort(cause)`）**只是 abort 一个
 * signal**，它没有能力抛弃同进程里 pending 的 promise（宿主源码原话：
 * `tools/index.ts:219` "it cannot hard-kill same-process code"）。
 * 所以工具必须自己在 await 上监听 signal，否则：
 *   本地超时兜底最长要等 25s（dig），用户按停止后仍然"卡着不动"。
 *
 * 拿到 exec.signal 的路径：`ToolExecutionInput.signal`（`exec.signal`），
 * 由 `executeToolCalls(..., signal)` 传入，就是本轮 turn 的 abort signal。
 */
export function raceAbort (promise, signal, label) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError(label, signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(label, signal))
    signal.addEventListener('abort', onAbort, { once: true })
    const settle = (fn) => (v) => { signal.removeEventListener('abort', onAbort); fn(v) }
    promise.then(settle(resolve), settle(reject))
  })
}

/** 中断错误（带 `mcAborted: true`，`core.mjs` 靠它判断"是人叫停的"而不是失败）。 */
export function abortError (label, signal) {
  const err = new Error(`${label} 被中断（用户停止 / 会话取消）`)
  err.mcAborted = true
  try { err.reason = signal?.reason } catch {}
  return err
}
