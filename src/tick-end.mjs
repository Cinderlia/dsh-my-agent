/* ============================================================================
 * tick-end —— 给「26.3 及之后」的服务端补发 `tick_end`（框架 bug 的兜底补丁）
 * ----------------------------------------------------------------------------
 * 🔴 现象（2026-10-24，用户服务器 26.3 实测）：
 *    机器人刚进服就被踢，服务端只说一句
 *      `multiplayer.disconnect.invalid_player_movement`（"Invalid move player packet received"）
 *    进服约 1.7 秒、发出**第二个**位置包时必踢 —— 跟寻路、插件、账户都没关系。
 *
 * 🔴 根因（上游 issue PrismarineJS/mineflayer#4189）：
 *    26.3 的原版服务端 `handleMovePlayer` 里，每个客户端 tick **只允许一个**位置包；
 *    这个"本 tick 已经收到过位置"的标记**只有在收到 `serverbound client_tick_end` 时才清掉**。
 *    原版客户端从 1.21.2 起每个物理 tick 结束都发 `tick_end`；
 *    而**已发布的 mineflayer 4.39.0（2026-09-06）不会发**它 —— 修复 #4137 只在 master 上，
 *    下一次发版之前所有 release 都有这个问题。于是第二个位置包 → 服务端判定非法移动 → 硬踢。
 *
 * ✅ 修法（就是上游 issue 里验证过的 workaround）：每写一个会让服务端计数的移动包
 *    （position / position_look / look / flying）之后，紧接着补一个 `tick_end`。
 *    26.1 起的协议里它就在（id 0x0d）；**1.21.4 ~ 26.2 都有**，写了不会抛；
 *    更老的协议（如 1.21.2/1.21.3 的数据里没有这个包）写了会抛，这里**整段吞掉**，对老服务器零影响。
 *    实测：同一台 26.3 服，插件连接用 1.21.8 / 26.1 两种协议都 6 秒在线、tick_end 全部写出、0 失败。
 *
 * ✅ 何时挂：`installTickEnd()` 每次 `createBot()` 之后都挂（幂等，重复调用只挂一次）。
 *    不动 mineflayer 源码、不依赖 node_modules 的布局（pnpm 的 .pnpm 深路径也一样），
 *    以后上游发版修好了，这里也无害。
 * ========================================================================== */

/** 哪些服务端包会让 26.3 的"本 tick 位置计数" +1 */
export const TICK_END_AFTER = new Set(['position', 'position_look', 'look', 'flying'])

/**
 * 判断这次连接要不要补 `tick_end`。
 * 现在**一律补**：26.x 之后的服务端都要它，老协议写了会抛、被吞掉，代价是每 tick 一个空包。
 * 留这个函数是给将来"上游修好了想关掉"用的：`DSH_MC_AGENT_TICK_END=off` 就能关。
 */
export function tickEndEnabled (env = process.env) {
  const v = String(env.DSH_MC_AGENT_TICK_END ?? '').toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no')
}

/**
 * 给一个 bot 挂上 `tick_end` 补发。幂等：同一个 `_client` 只包一次。
 * @param {Object} bot mineflayer 的 bot（只用 `bot._client`）
 * @returns {{ installed: boolean, reason?: string, stats?: Object }}
 */
export function installTickEnd (bot, { env = process.env } = {}) {
  const client = bot?._client
  if (!client || typeof client.write !== 'function') return { installed: false, reason: 'no-client' }
  if (client.__dshTickEnd) return { installed: true, reason: 'already', stats: client.__dshTickEnd }
  if (!tickEndEnabled(env)) return { installed: false, reason: 'disabled' }

  const stats = { sent: 0, failed: 0, lastError: null }
  const origWrite = client.write.bind(client)
  const write = (name, packet) => {
    let result
    let threw = null
    try { result = origWrite(name, packet) } catch (err) { threw = err } // 原包的错要原样往上抛
    if (!threw && TICK_END_AFTER.has(name)) {
      try {
        origWrite('tick_end', {})
        stats.sent++
      } catch (err) {
        // 老协议没有这个包 —— 正常情况，只记第一次
        stats.failed++
        if (stats.failed === 1) stats.lastError = err?.message ?? String(err)
      }
    }
    if (threw) throw threw
    return result
  }
  client.write = write
  client.__dshTickEnd = stats
  return { installed: true, reason: 'installed', stats }
}

/** 拆掉补丁（自检/诊断用）。 */
export function uninstallTickEnd (bot) {
  const client = bot?._client
  if (!client) return false
  if (!client.__dshTickEnd) return false
  delete client.__dshTickEnd
  return true
}

/** 连接层填日志用的一句话（只在真装上了才说）。 */
export function describeTickEnd (res) {
  if (!res) return ''
  if (res.reason === 'disabled') return 'tick_end 补丁已按环境变量关闭'
  if (!res.installed) return `tick_end 补丁没挂上（${res.reason}）`
  return '已补 tick_end（26.3+ 服务器必需，见 mineflayer#4189）'
}
