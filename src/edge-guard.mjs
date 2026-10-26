/* ============================================================================
 * edge-guard —— **边缘保护 + 摔落伤害本地计算**（用户 2026-10-25）
 * ----------------------------------------------------------------------------
 * LLM 绕过 navi、直接用移动原语（mc_apply / mc_input / mc_move）时，
 * 动手前先看移动方向上有没有**超过 2 格高**的缺口：
 *   · 有 → 预处理（forbiddenSoft）并给出分级提示：
 *       不会受伤 / 会掉 x 颗心 / 会摔死
 *   · 伤害按 MC 公式本地算（含护甲、保护、羽毛靴、跳跃提升）
 *
 * MC 摔落伤害（Java 版，1.20+）：
 *   ① 基础伤害 = floor(落差 - 3 - 跳跃提升级数)
 *   ② 羽毛靴：每级 -12%，上限 4 级（-48%）
 *   ③ 护甲：×(1 - min(20, 护甲值)/25)
 *   ④ 保护附魔：每级 -4%（上限 20 点）
 *   1 点伤害 = 半颗心；20 点血 = 10 颗心
 * ========================================================================== */
import Vec3 from 'vec3'

/** 视野方向：0=南(+Z) 90=西(-X) 180=北(-Z) 270=东(+X) */
const DIRS = {
  south: [0, 1], north: [0, -1], east: [1, 0], west: [-1, 0],
}

/** 从玩家朝向取"前方"的 (dx,dz) */
export function facingDelta (yawRad) {
  const deg = ((yawRad * 180) / Math.PI + 360) % 360
  if (deg >= 315 || deg < 45) return [0, 1]       // 南
  if (deg < 135) return [-1, 0]                   // 西
  if (deg < 225) return [0, -1]                   // 北
  return [1, 0]                                   // 东
}

/** 玩家护甲点数（穿着的四件） */
export function armorPoints (b) {
  let total = 0
  try {
    for (const slot of ['head', 'torso', 'legs', 'feet']) {
      const it = b.inventory?.slots?.[b.getEquipmentSlot?.(slot) ?? -1]
      if (it && it.armorPoints != null) total += Number(it.armorPoints)
    }
  } catch { /* 读不到按 0 */ }
  /* 更可靠的来源：把四件装备的防御值加起来 */
  try {
    let pts = 0
    for (const [slot, key] of [[5, 'head'], [6, 'torso'], [7, 'legs'], [8, 'feet']]) {
      const it = b.inventory?.slots?.[slot]
      if (it?.name) {
        const armor = String(it.name)
        pts += /netherite/.test(armor) ? 3 : /diamond/.test(armor) ? 3 : /iron/.test(armor) ? 2
          : /golden/.test(armor) ? 1 : /leather/.test(armor) ? 1 : /chainmail/.test(armor) ? 2 : 0
      }
    }
    if (pts > 0) total = pts
  } catch { /* ignore */ }
  return Math.min(20, total)
}

/** 附魔等级（取手上/身上最高的对应附魔） */
export function enchantLevel (b, name) {
  let best = 0
  try {
    for (const slot of [5, 6, 7, 8]) {
      const it = b.inventory?.slots?.[slot]
      const lv = it?.enchants?.find?.((e) => String(e.name).includes(name))?.lvl ?? 0
      if (lv > best) best = lv
    }
  } catch { /* ignore */ }
  return best
}

/**
 * 落地伤害（点）；1 点 = 半颗心。
 * @param {number} distance 落差（格）
 * @param {object} mods   { armor, featherFalling, protection, jumpBoost }
 */
export function fallDamage (distance, mods = {}) {
  const armor = Math.min(20, Number(mods.armor ?? 0))
  const feather = Math.min(4, Number(mods.featherFalling ?? 0))
  const protect = Math.min(20, Number(mods.protection ?? 0))
  const jump = Math.max(0, Number(mods.jumpBoost ?? 0))
  let raw = Math.floor(Number(distance ?? 0) - 3 - jump)
  if (raw <= 0) return 0
  raw *= 1 - feather * 0.12
  raw *= 1 - armor / 25
  raw *= 1 - protect * 0.04
  return Math.max(0, Math.round(raw))
}

/** 把伤害点翻译成"掉几颗心 / 会不会摔死" */
export function fallVerdict (b, distance, mods = {}) {
  const dmg = fallDamage(distance, mods)
  const hp = Number(b?.health ?? 20)
  if (dmg <= 0) return { dmg, hearts: 0, fatal: false, level: 'safe', text: '不会受伤' }
  const hearts = dmg / 2
  if (dmg >= hp) return { dmg, hearts, fatal: true, level: 'fatal', text: `**会摔死**（约 ${hearts.toFixed(1)} 颗心，当前只有 ${(hp / 2).toFixed(1)} 颗）` }
  if (hearts >= hp / 2 / 2) return { dmg, hearts, fatal: false, level: 'danger', text: `**会掉 ${hearts.toFixed(1)} 颗心**（剩 ${((hp - dmg) / 2).toFixed(1)} 颗，有点危险）` }
  return { dmg, hearts, fatal: false, level: 'warn', text: `会掉 ${hearts.toFixed(1)} 颗心` }
}

/**
 * 检查"往 (dx,dz) 方向走 1~2 格"有没有**超过 2 格**的缺口。
 * @returns {{hazard:boolean, drop?:number, at?:{x,y,z}, verdict?:object}}
 */
export function checkEdge (b, dx, dz, { maxDrop = 2, reach = 3, depth = 40 } = {}) {
  const me = b?.entity?.position
  if (!me) return { hazard: false }
  const base = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) }
  /* 🔴 2026-10-25 实机两次摔死：原来**第一个超过 maxDrop 的就返回**，
   *    前方第 1 格 4 格、第 2 格 15 格时只报了 4 格（预测 0.5 颗心，实际摔死）。
   *    现在扫完 reach 格，取**最深**的那个。往下探 40 格（36 格落差也能报出来）。 */
  let worst = null
  for (let step = 1; step <= reach; step++) {
    const x = base.x + dx * step
    const z = base.z + dz * step
    let groundY = null
    for (let dy = 0; dy >= -depth; dy--) {
      const blk = b.blockAt(new Vec3(x, base.y + dy, z))
      if (blk && blk.boundingBox === 'block') { groundY = base.y + dy; break }
    }
    const drop = groundY == null ? depth : (base.y - 1) - groundY
    if (drop > maxDrop && (!worst || drop > worst.drop)) {
      worst = { x, y: groundY == null ? base.y - depth : groundY + 1, z, drop }
    }
  }
  if (!worst) return { hazard: false }
  return { hazard: true, drop: worst.drop, at: { x: worst.x, y: worst.y, z: worst.z } }
}


/** 检查后给出完整预警（含伤害） */
export function edgeWarning (b, dx, dz, reach = 3) {
  /* reach：看前方几格。逐格走（用户 2026-10-25）时传 1 —— 只看**下一格**的落差，
   * 否则斜披上第一步就会因为 3 格外的深坑被拦下，永远走不动。 */
  const r = checkEdge(b, dx, dz, { reach })
  if (!r.hazard) return null
  const mods = {
    armor: armorPoints(b),
    featherFalling: enchantLevel(b, 'feather_falling'),
    protection: enchantLevel(b, 'protection'),
  }
  const v = fallVerdict(b, r.drop, mods)
  return {
    ...r, mods, verdict: v,
    text: `⚠️ 边缘预警：前方 ${r.at.x},${r.at.z} 落差 ${r.drop} 格 —— ${v.text}\n`
      + `（护甲 ${mods.armor} 点、保护 ${mods.protection} 级、羽毛靴 ${mods.featherFalling} 级；确认要跳吗？）`,
  }
}
