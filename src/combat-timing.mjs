/**
 * 近战挥砍节奏 —— 一次挥砍要等多久（**按手里的武器算，不再写死 620ms**）。
 *
 * 为什么有这个文件（2026-10-22）：
 *   `src/attack.mjs` 的手动分支原来是 `await sleep(620)` —— 那个数字只对**剑**成立
 *   （剑攻速 1.6 ⇒ 20/1.6 = 12.5 tick ≈ 625ms）。真实情况是：
 *     · 斧 0.8~1.0 ⇒ 一次要 1000~1250ms，620ms 挥一次等于**每次都是弱击**（伤害被缩放）；
 *     · 镐 1.2 ⇒ 833ms；铲 1.0 ⇒ 1000ms；空手/锄 other 4.0 ⇒ 250ms；
 *     · 有急迫（Haste）时更快，喝了药水还照 620ms 就是白等。
 *   参考实现 mineflayer-pvp 的 `lib/AttackSpeeds.json` + `getCooldown = floor(1/attackSpeed*20)`
 *   （对剑正好算出 12 tick）——这里沿用它的表，并补上它没管的急迫。
 *
 * 口径（**只报数，不替 AI 决策**）：
 *   · `ticks = ceil(20 / 有效攻速)`，`ms = ticks * 50`；
 *   · 再多留一个 tick 的余量（`marginTicks`）—— 掐着点挥会吃到"冷却没满、伤害打折"；
 *   · 急迫按原版：有效攻速 = 攻速 × (1 + 0.1 × 等级)。
 */

/** 武器攻速表（与 mineflayer-pvp `lib/AttackSpeeds.json` 完全一致；`other` 是兜底） */
export const ATTACK_SPEED = {
  wooden_sword: 1.6, golden_sword: 1.6, stone_sword: 1.6, iron_sword: 1.6, diamond_sword: 1.6, netherite_sword: 1.6,
  trident: 1.1,
  wooden_shovel: 1.0, golden_shovel: 1.0, stone_shovel: 1.0, iron_shovel: 1.0, diamond_shovel: 1.0, netherite_shovel: 1.0,
  wooden_pickaxe: 1.2, golden_pickaxe: 1.2, stone_pickaxe: 1.2, iron_pickaxe: 1.2, diamond_pickaxe: 1.2, netherite_pickaxe: 1.2,
  wooden_axe: 0.8, golden_axe: 1.0, stone_axe: 0.8, iron_axe: 0.9, diamond_axe: 1.0, netherite_axe: 1.0,
  wooden_hoe: 1.0, golden_hoe: 1.0, stone_hoe: 2.0, iron_hoe: 3.0, diamond_hoe: 4.0, netherite_hoe: 4.0,
  other: 4.0,
}

/** 一件东西的攻速；不认识的一律按 `other`（**不能返回 undefined** —— 否则 tick 变 NaN） */
export function attackSpeedOf (itemName) {
  const n = String(itemName ?? '')
  const v = ATTACK_SPEED[n]
  if (Number.isFinite(v) && v > 0) return v
  return ATTACK_SPEED.other
}

/** 急迫等级（0 = 没有）。`effects` 在 mineflayer 上是按 id 索引的对象；急迫 = 3 */
export function hasteLevelOf (b) {
  try {
    const e = b?.entity?.effects?.[3]
    if (!e) return 0
    const amp = Number(e.amplifier ?? (e.level != null ? Number(e.level) - 1 : 0))
    return Number.isFinite(amp) && amp > 0 ? amp : 0
  } catch { return 0 }
}

/**
 * 两次挥砍之间该等多久：`{ ms, ticks, speed, weapon, haste }`
 *
 * `marginTicks` 默认 1 —— 宁可多等 50ms，也别在冷却没满时挥（那一刀伤害是打折的）。
 */
export function swingCooldownMsOf (b, { marginTicks = 1 } = {}) {
  const weapon = b?.heldItem?.name ?? null
  const base = attackSpeedOf(weapon)
  const haste = hasteLevelOf(b)
  const speed = base * (1 + 0.1 * haste)
  const ticks = Math.max(1, Math.ceil(20 / speed)) + Math.max(0, Number(marginTicks) || 0)
  return { ms: ticks * 50, ticks, speed, weapon, haste }
}
