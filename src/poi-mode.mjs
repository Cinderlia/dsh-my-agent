/* ============================================================================
 * poi-mode —— **雷达图的展示节奏 + 专注模式**（用户 2026-10-26 的需求）
 * ----------------------------------------------------------------------------
 * 用户原话（摘要）：
 *   · 「平时除了现在有的 POI，如果玩家附近空气方块占比超过 50%，就常驻地形图，
 *      然后每隔 9 次展示 1 次雷达图。如果空气方块比较少，地形图失效就不展示，
 *      但是提高雷达图展示频率到每隔 4 次展示 1 次雷达图。」
 *   · 「agent 可以根据原语切换为专注模式，不展示地形图的同时常驻雷达图。
 *      专注模式可以 agent 手动退出，同时设置倒计时，5 分钟后自动退出，
 *      不用提醒 LLM 还有多久，退出时提醒一次就可以了，让 LLM 自己续。」
 *
 * 状态按 **agentId** 存（一个会话一份），放模块里而不是插件闭包里：
 * 这样"每轮注入"（index.js 的 poiLineOf）和"agent 的原语"（mc_probe{what:"poi"}）
 * 读写的是同一份状态，不用在两个闭包之间传引用。
 * ========================================================================== */

/** 专注模式默认时长（用户指定 5 分钟） */
export const FOCUS_MS = 5 * 60_000
/** 头顶开阔（空气 > 50%）时的雷达图间隔：每 9 轮一次 */
export const RADAR_EVERY_OPEN = 9
/** 空气少（矿洞/室内）时的雷达图间隔：每 4 轮一次 */
export const RADAR_EVERY_TIGHT = 4
/** 空气占比超过它就认为"头顶开阔" */
export const OPEN_SKY_RATIO = 0.5

const STATE = new Map()

/** 拿（必要时建）某个会话的节奏状态 */
function stateOf (agentId) {
  const k = String(agentId ?? '')
  let s = STATE.get(k)
  if (!s) {
    s = {
      turns: 0,          // 已经注入过多少轮（每到 every%1 展示雷达图）
      focusUntil: 0,     // 专注模式到期时间戳（0 = 没开）
      noticeDone: true,  // 这一轮专注模式的"到期提醒"发过没有
    }
    STATE.set(k, s)
  }
  return s
}

/** 专注模式还要多久（毫秒；没开就是 0） */
export function focusLeftMs (agentId) {
  return Math.max(0, (STATE.get(String(agentId ?? ''))?.focusUntil ?? 0) - Date.now())
}

/** 专注模式开着吗 */
export function focusOn (agentId) {
  return focusLeftMs(agentId) > 0
}

/**
 * 开 / 续专注模式。
 * @param {string} agentId
 * @param {number} [ms] 时长（默认 5 分钟）
 * @returns {{until:number, ms:number}} 到期时间戳与实际时长
 */
export function startFocus (agentId, ms = FOCUS_MS) {
  const s = stateOf(agentId)
  const span = Math.max(1, Math.min(Number(ms) || FOCUS_MS, 60 * 60_000))
  s.focusUntil = Date.now() + span
  s.noticeDone = false
  return { until: s.focusUntil, ms: span }
}

/** 手动退出专注模式（不发提醒——是 agent 自己关的） */
export function stopFocus (agentId) {
  const s = stateOf(agentId)
  s.focusUntil = 0
  s.noticeDone = true
}

/**
 * 推进一轮，并算这一轮要展示什么。
 * @param {string} agentId
 * @param {boolean} openSky 这一轮测到的"空气占比 > 50%"
 * @returns {{turn:number, focus:boolean, expired:boolean, showRadar:boolean, showTerrain:boolean, every:number}}
 *   `expired` = 这一轮该发一次"专注模式到期"提醒（只会为 true 一次）。
 */
export function tick (agentId, openSky) {
  const s = stateOf(agentId)
  s.turns += 1
  const focused = Date.now() < s.focusUntil
  let expired = false
  if (!focused && s.focusUntil && !s.noticeDone) {
    expired = true          // 到期了：提醒一次，然后彻底关掉
    s.focusUntil = 0
    s.noticeDone = true
  }
  /* 专注模式：雷达图常驻、不看地形图 */
  if (focused) {
    return { turn: s.turns, focus: true, expired: false, showRadar: true, showTerrain: false, every: 1 }
  }
  const every = openSky ? RADAR_EVERY_OPEN : RADAR_EVERY_TIGHT
  return {
    turn: s.turns,
    focus: false,
    expired,
    showRadar: s.turns % every === 1,   // 第 1 轮就给一次，之后每 N 轮一次
    showTerrain: openSky,               // 头顶开阔才给地形图
    every,
  }
}

/** 测试 / 诊断用：清掉所有状态 */
export function resetPoiMode () {
  STATE.clear()
}
