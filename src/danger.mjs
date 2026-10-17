/*
 * 危险信号 —— 回答一个问题：**"现在，值得把控制权从循环里抢回来吗？"**
 *
 * ── 为什么要有这一层（2026-10-17 实机，用户报"工具排队执行、延迟很大"）────────────
 * `mc_sequence` 一次能塞 64 步，AI 常塞十几步。实机日志（一个晚上 61 次调用）：
 *
 *     总工具耗时        334.6 秒
 *     其中 >=5000ms 的  301.4 秒   ← 占 90%
 *     mc_sequence       34 次  平均 7071ms  最长 11010ms（顶到 CALL_MS 硬上限）
 *     同一时段「mc_auto 叫醒 AI」18 次
 *
 * 而**一次工具调用是原子的** —— 循环里只查 `abortSignal` 和预算，**没有一处查"我正在挨打"**。
 * 于是这一幕成立（用户截图那次）：12 个 `break` 往下挖竖井 → 骷髅跟下来一路射 →
 * 直到那 10 秒过完 AI 才知道。日志里两行紧挨着：
 *
 *     00:16:31  mc_auto：zombie 贴上来 → 已叫醒 AI 定策略（血 17/20）
 *     00:16:36  [调度器] 动作 a73 mc_act 3471ms completed
 *
 * **反射层 5 秒前就把 AI 叫醒了**，但 AI 动不了 —— 它卡在还没返回的调用里。
 * 调度器那边没问题（`模式 observe-only`，不排队），卡的是"动作发出去就没人能打断"。
 *
 * ── 这一层的规矩 ──────────────────────────────────────────────────────────────
 * 判据**保守**，只认两件事：
 *   ① 这次循环期间**掉过血**（`hp0` = 循环开始时的血）—— 最直接的证据；
 *   ② 敌对怪贴到 `DANGER_HOSTILE_R` 格内 —— 还没打到，但已经来不及了。
 * **8 格外有只僵尸不算**：反射层会为它叫醒 AI，但没必要把一个正常的挖掘串砍断 ——
 * 砍断太勤会让"挖 12 格"变成 12 次调用，反而更慢（这正是我们要修的病）。
 *
 * 只读，**不动 bot、不发指令、不占资源** —— 怎么用由调用方（`sequence` / `build` / `mining`
 * 的循环）决定：它们拿到非 null 就带进度 `break`，把 `next` 交回给 AI。
 *
 * 形状：只认 `b.entities` / `b.entity` / `b.health` 三样（与 `world-scan.mjs` 同一套路数），
 * 不 import 游戏库、不 import `core.mjs`。
 */
import { HOSTILE_RE, hostilityOf } from './entity-names.mjs'

/** 敌对怪贴到这个距离内 ⇒ 紧急（3 格：僵尸再走一步就够到了） */
export const DANGER_HOSTILE_R = 3
/** 这次循环期间掉这么多血就算"挨打了"（1 点 = 被僵尸碰一下） */
export const DANGER_HP_LOST = 1

/** 读血量；读不到回 `null`（**不回 0** —— 那会让"不知道"变成"血空了"） */
export function healthOf (b) {
  /* 🔴 `Number(null) === 0` 而且 `Number.isFinite(0)` 为真 —— 少了这道 null 判，
   *    "读不到血"会变成"血 = 0"，于是 `hp <= hp0 - 1` 恒成立 ⇒ 每步都以为在挨打。
   *    （同款坑见 `踩坑档案.md` 第 112 / 113 条。） */
  const h = b?.health
  if (h == null || h === '') return null
  const n = Number(h)
  return Number.isFinite(n) ? n : null
}

/**
 * 最近的敌对怪（`radius` 格内），没有就回 `null`。
 * 与 `extensions/mc_auto.mjs` 的 `hostilesNear()` 同一套判据（那边自带一份正则，见 `entity-names.mjs` 的注释）。
 */
export function nearestHostile (b, radius = DANGER_HOSTILE_R) {
  const me = b?.entity?.position
  if (!me) return null
  let best = null
  for (const e of Object.values(b?.entities ?? {})) {
    if (!e || e === b.entity || !e.position) continue
    const nm = String(e.name ?? e.username ?? '')
    /* 🔴 2026-10-18 审计：末影人/猪灵在 `HOSTILE_RE` 里，但**默认中立** ——
     *    走过去一只末影人就把正在跑的 12 步序列砍断（"有怪贴脸"），可它根本不打人。
     *    中立怪只有**正在打我**（它的 target 是我）才算威胁。 */
    const stance = hostilityOf(nm, e.kind)
    const targetingMe = e.target === b.entity || (e.target != null && e.target.id != null && e.target.id === b.entity?.id)
    if (stance !== 'hostile' && !(stance === 'neutral' && targetingMe)) continue
    const d = e.position.distanceTo(me)
    if (!Number.isFinite(d) || d > radius) continue
    if (!best || d < best.distance) {
      best = {
        name: nm || String(e.type ?? '?'),
        distance: Math.round(d * 10) / 10,
        position: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) },
      }
    }
  }
  return best
}

/**
 * 现在危险吗？`hp0` 传**循环开始时**的血量（不传就只查怪）。
 * @returns {null | { kind: 'hurt'|'hostile', health: number|null, hp0?: number, lost?: number, name?: string, distance?: number, position?: object }}
 */
export function dangerNow (b, { hp0 = null, radius = DANGER_HOSTILE_R, lost = DANGER_HP_LOST } = {}) {
  const hp = healthOf(b)
  /* ① 掉血优先报：它是"已经打到我身上了"，比"有怪在附近"硬。
   *    `hp0 == null`（循环开始时就读不到血）⇒ 这一条**不判**，不能拿 null 比大小。 */
  if (hp != null && hp0 != null && hp <= hp0 - lost) {
    return { kind: 'hurt', health: hp, hp0, lost: Math.round((hp0 - hp) * 10) / 10 }
  }
  const foe = nearestHostile(b, radius)
  if (foe) return { kind: 'hostile', health: hp, ...foe }
  return null
}

/** 给人看的一句话（`null` 进 `null` 出） */
export function dangerText (d) {
  if (!d) return null
  if (d.kind === 'hurt') return `正在挨打（血 ${d.hp0} → ${d.health}）`
  const where = d.position ? `（${d.position.x}, ${d.position.y}, ${d.position.z}）` : ''
  return `${d.name} 贴到 ${d.distance} 格了${where}`
}
