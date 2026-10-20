/**
 * Boss 血条（末影龙 / 凋灵）—— 从 `bot.bossBars` 读。
 *
 * 🔴 2026-10-19 用户点出来的坑："读不到末影龙血量"。
 *    末影龙的 HP **不在**实体元数据里（`entitiesNear()` 走的 `util.entity.getHealth` /
 *    `entity.health` 对它一律是 null）—— 原版客户端是拿 **Boss Bar 包**（`boss_bar`，
 *    action 0 创建 / 2 改血 / 1 删）画那条顶上的紫条的，而 mineflayer 自带的
 *    `lib/plugins/boss_bar.js` 已经把这条包解析好了，就挂在 `bot.bossBars` 上：
 *    每项 `{ title（prismarine-chat 对象）, health（0~1 的比例！）, isDragonBar, ... }`。
 *    ⇒ 打龙时**唯一**能读到它血量的地方就是这里，而且 health 是**百分比不是点数**，
 *    要乘上限（末影龙 200、凋灵 300）才是"还剩多少血"。
 *
 * 约定：纯读、同步、不 import core / 不 import mineflayer、不碰世界。
 */

/** 已知 Boss 的最大血量（拿不到就只报百分比，别瞎猜） */
const MAX_HP_BY_NAME = [
  [/ender\s*dragon|末影龙|終界龍/i, 200],
  [/wither|凋灵|凋靈/i, 300],
]

/**
 * 把 prismarine-chat / 裸字符串 / 组件对象压成一行文本。
 * （不同版本的 title 形状差很多：字符串、ChatMessage、{type:'string',value}、{text}…）
 */
export function bossTitleText (t) {
  if (t == null) return ''
  if (typeof t === 'string') return t
  if (typeof t === 'number') return String(t)
  try {
    if (typeof t.value === 'string' && t.value) return t.value
  } catch { /* 忽略 */ }
  try {
    if (typeof t.text === 'string' && t.text) return t.text
  } catch { /* 忽略 */ }
  try {
    const s = typeof t.toString === 'function' ? t.toString() : ''
    if (s && s !== '[object Object]') return s
  } catch { /* 忽略 */ }
  return ''
}

/** 按名字（或 `isDragonBar` 标志）猜最大血量；认不出返回 null */
export function bossMaxHp (title, bar = null) {
  if (bar?.isDragonBar === true) return 200
  const s = String(title ?? '')
  for (const [re, hp] of MAX_HP_BY_NAME) if (re.test(s)) return hp
  return null
}

/**
 * 读当前所有 Boss 血条。
 * @param {object|null} b mineflayer bot（或 McBot 代理，只要能摸到 `bossBars`）
 * @returns {Array<{title:string, percent:number|null, pct:number|null, hp:number|null, maxHp:number|null, isDragonBar:boolean}>}
 */
export function readBossBars (b) {
  let raw = null
  try { raw = b?.bossBars ?? null } catch { raw = null }          // 上游是 getter，读它可能抛
  if (raw == null && b?._bot) { try { raw = b._bot.bossBars ?? null } catch { raw = null } }
  const bars = Array.isArray(raw) ? raw : []
  const out = []
  for (const bar of bars) {
    if (!bar) continue
    const title = bossTitleText(bar.title)
    const frac = Number(bar.health)
    const percent = Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : null
    const maxHp = bossMaxHp(title, bar)
    const hp = percent == null || maxHp == null ? null : Math.round(percent * maxHp * 10) / 10
    out.push({
      title,
      percent,
      pct: percent == null ? null : Math.round(percent * 1000) / 10,
      hp,
      maxHp,
      isDragonBar: bar.isDragonBar === true,
    })
  }
  return out
}

/**
 * 一行话（给状态条 / 感知块用）。没有 Boss 时返回空字符串。
 * 形状：`末影龙 62% ≈ 124/200 血`（认不出上限时只报百分比）
 */
export function formatBossBars (bars) {
  const list = Array.isArray(bars) ? bars.filter(Boolean) : []
  if (!list.length) return ''
  return list.map((x) => {
    const name = x.title || 'Boss'
    if (x.percent == null) return `${name}（读不到血量）`
    const head = `${name} ${x.pct}%`
    return x.hp == null ? head : `${head} ≈ ${x.hp}/${x.maxHp} 血`
  }).join('；')
}
