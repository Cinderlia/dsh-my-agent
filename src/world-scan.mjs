/**
 * 附近扫描与实体列表 —— 从 `src/core.mjs` 搬出来的"感知"那一层（路线图第 ④ 条第十二刀）。
 *
 * 约定（每一刀都照这个来）：
 *   ① **不反向 import `core.mjs`** —— 这些函数只吃传进来的 `b`（mineflayer bot）。
 *   ② 只借 `vec3`（`new Vec3()`）与纯方块名判据，不直接 import mineflayer —— 依赖方向保持"叶子 → 上层"。
 *   ③ **只读、不 await、不改状态** —— 不碰控制位、不发包、不受看图门禁限制。
 *
 * 两个函数都是"把 `bot` 已经知道的东西读出来、分类、排序、截断"，没有自研算法：
 *   · `scanAround(b, opts)`  —— 周围方块的计数（不点名）或按名字找（点名时按距离升序取前 N 个）。
 *   · `entitiesNear(b, …)`   —— 附近有谁：名字 / 坐标 / 距离 / 上下差 / 血量 / 是不是远程。
 *
 * 🔴 `core.mjs` 里留了**同名薄包装**（`scan()` / `entities()`），因为它们俩是**公开方法** ——
 *    调用方（`index.js` 的 `mc_scan`、`extensions\mc_observe.mjs` 的"程序检测到"、套件）用的是
 *    `bot.scan()` / `bot.entities()`，而不是"`core.mjs` 导出了这个名字"，re-export 救不了方法。
 *    薄包装里照样先 `requireBot()`，保持"不在线就抛"的语义。
 */

import { Vec3 } from 'vec3'
import { isAir, cropStageOf } from './block-names.mjs'
import { entityNameOf, HOSTILE_RE, RANGED_RE, hostilityOf } from './entity-names.mjs'

export function scanAround (b, { radius = 16, height = 4, name = null, limit = 10, y = null } = {}) {
  /* 半径默认 16 = **1 区块**（2026-10-13 用户要求，先定 32 后改回 16）：一次扫 33×33 格，
   * 找树 / 找矿 / 找水源够用，又不至于每次调用都查几万格。上限 48 留给显式传大半径的场合。 */
  const R = Math.min(Math.max(radius, 1), 48)
  const H = Math.min(Math.max(height, 0), 16)
  const c = b.entity.position.floored()
  /* 🔴 2026-10-19（用户在末地亲眼看着我一层层挖）：竖向窗口是**以我的脚底为中心**的 ±H，
   *    可我站在 y=72 时怎么扫都扫不到 y=94 的头 —— 当时我连着判了三次"没有要塞/没建上"，
   *    全是这个原因，白挖了两轮。所以给一个 `y`：**指定竖向中心**（不用先把自己 tp 上去）。 */
  const rawY = y === null || y === undefined || y === '' ? null : Number(y)
  const cy = rawY !== null && Number.isFinite(rawY) ? Math.trunc(rawY) : c.y
  const counts = new Map()
  const found = []
  let unloaded = 0
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      for (let dy = -H; dy <= H; dy++) {
        const pos = new Vec3(c.x + dx, cy + dy, c.z + dz)
        const blk = b.blockAt(pos)
        if (!blk) { unloaded++; continue }
        if (isAir(blk.name)) continue
        if (name) {
          if (blk.name === name) {
            /* 🔴 2026-10-08 第五份审计报告 ③：以前只 `found.push` 再 `slice(0, limit)` ——
             *    而三层循环是 `dx → dz → dy`，所以"前 N 个"全落在 x/z 最负的那个角
             *    （半径 24 时能差 30 多格）。AI 于是跑去够不着的地方挖，或据此判"附近没有"。
             *    现在带距离一起记，最后**按到我的距离升序**取前 N 个。 */
            const d = Math.hypot(pos.x + 0.5 - b.entity.position.x, pos.y + 0.5 - b.entity.position.y, pos.z + 0.5 - b.entity.position.z)
            /* 方块**状态**（`getProperties()`）：作物 age、楼梯朝向、活板门开关…
             * 🔴 2026-10-18 用户实机：AI 种完小麦说"成熟度看不到——工具只告诉我那格是 wheat"，
             *    于是它只能靠 `mc_act {use}` 碰巧带出的 `age: 0 → 3` 去猜。名字之外的状态必须一起给。
             *    读不到（或没有状态）就是 null，不编。 */
            let state = null
            try {
              const p = blk.getProperties?.()
              if (p && Object.keys(p).length) state = p
            } catch { state = null }
            found.push({ pos: `${pos.x},${pos.y},${pos.z}`, d: Math.round(d * 10) / 10, state })
          }
        } else counts.set(blk.name, (counts.get(blk.name) ?? 0) + 1)
      }
    }
  }
  if (name) {
    found.sort((a, b2) => a.d - b2.d)
    /* 🔴 2026-10-15 审计：`found` 是 `string[]`，而 `nearest` 以前塞的是内部的 `{pos,d}` 对象
     *    ⇒ 两套形状，谁把它当字符串用就会拿到 `[object Object]`。统一成字符串坐标。 */
    const top = found.slice(0, limit)
    const crops = top.map((f) => cropStageOf(name, f.state)).filter(Boolean)
    return {
      found: top.map((f) => f.pos),
      total: found.length, unloaded,
      nearest: found.length ? found[0].pos : null,
      /* 竖向窗口的**真实中心**（给了 `y` 就是那个 y，没给就是我的脚底）——
       * 让人一眼看出"这一扫覆盖的是哪一层"，别再拿它当"整座山都没有"的证据 */
      center: { x: c.x, y: cy, z: c.z }, height: H,
      /* 一句话结论（作物才有）：让 AI 一眼看到"能收几株"，不用自己数 blocks[] */
      ...(crops.length
        ? { cropSummary: `🌾 ${name}：${crops.filter((c) => c.ripe).length}/${crops.length} 已成熟（ripe=true 就能收，其余再等等；age/maxAge 见每一条）` }
        : {}),
      /* 每一处的方块状态（作物成熟度就从这里看）：
       * `age/maxAge/ripe` 是给作物的现成结论（各作物上限不同，别让 AI 背"7 就是熟"），
       * `state` 是原始属性（楼梯 facing、活板门 open、水田 moisture…）。 */
      blocks: top.map((f) => {
        const crop = cropStageOf(name, f.state)
        return {
          pos: f.pos,
          distance: f.d,
          ...(crop ? { age: crop.age, maxAge: crop.maxAge, ripe: crop.ripe } : {}),
          ...(f.state ? { state: f.state } : {}),
        }
      }),
    }
  }
  return {
    center: { x: c.x, y: cy, z: c.z }, radius: R, height: H, unloaded,
    counts: [...counts.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 25).map(([n, v]) => ({ name: n, count: v })),
  }
}

/**
 * 附近有谁（怪 / 玩家 / 动物 / 掉落物）—— 名字、坐标、距离、上下差、血量、是不是远程。
 *
 * 上游原版只有"名字 / 类型 / 坐标 / 距离"，2026-10-06 用户问"可不可以获取附近怪物的位置"
 * 之后补上了**分类 + 血量 + 远程标记**。**不用自己算**：mineflayer 内核本来就把周围所有实体
 * 放在 `bot.entities`（服务端 spawn / teleport / relative-move 包喂进去的），每条都有
 * `.name` / `.position` / `.kind` / `.metadata`。这里只是**读出来 + 分类 + 按距离排序 + 截断**，
 * 没有任何自研算法。
 *
 * 血量和距离用**现成的** `@nxg-org/mineflayer-util-plugin`（`bot.util.entity.*`）：
 * 它是 `mineflayer-auto-eat` 的依赖，auto-eat 注入时会 `bot.loadPlugin()` 它
 * （见 `mineflayer-auto-eat/dist/index.js:2,6`），所以我们加载 auto-eat 之后 `bot.util` 就在。
 * 它按版本挑 metadata 槽位读怪的血（1.17+ 用 9），比 `entity.health` 靠谱 ——
 * mineflayer **不给别的实体**暴露 `.health`（只有 bot 自己的）。助手不在/抛错就退回自己算。
 *
 * 🔴 只读：不碰世界、不按控制位、不受看图门禁限制。
 */
export function entitiesNear (b, radius = 24, { kind = 'all', limit = 40 } = {}) {
  const me = b.entity?.position
  if (!me) return { error: '还没有位置信息（区块没加载完？）' }
  const R = Math.min(Math.max(Number(radius) || 24, 1), 128)
  const want = String(kind ?? 'all').toLowerCase()
  const ue = b?.util?.entity ?? null                       // 现成助手（可能没装）
  const distOf = (e) => {
    try {
      const d = Number(ue?.entityDistance?.(e))
      if (Number.isFinite(d)) return d
    } catch { /* 助手不可用就自己算 */ }
    try { return e.position.distanceTo(me) } catch { return Infinity }
  }
  const healthOf = (e) => {
    try {
      const h = Number(ue?.getHealth?.(e))
      if (Number.isFinite(h) && h > 0) return Math.round(h * 10) / 10
    } catch { /* 同上 */ }
    const h2 = Number(e?.health)
    return Number.isFinite(h2) && h2 > 0 ? Math.round(h2 * 10) / 10 : null
  }
  const list = []
  for (const e of Object.values(b.entities ?? {})) {
    if (!e || e === b.entity || !e.position) continue
    const nm = entityNameOf(e)
    const isPlayer = Boolean(e.username) || e.type === 'player'
    /* 🔴 2026-10-17（用户实机："怪物好像不显示中立"）：原来只有 `player / hostile / other` 三档，
     *    末影人、猪灵这类**中立**怪被算成 hostile ⇒ AI 以为它们要打自己；狼、蜜蜂、铁傀儡
     *    被塞进 `other` ⇒ 又完全看不出它们是"惹了才打你"。现在四档，且判定只有 `hostilityOf()` 一处。 */
    const stance = isPlayer ? 'player' : hostilityOf(nm, e.kind)
    const hostile = stance === 'hostile'
    const neutral = stance === 'neutral'
    const group = stance === 'passive' ? 'other' : stance
    if (want === 'hostile' && group !== 'hostile') continue
    if (want === 'neutral' && group !== 'neutral') continue
    if (want === 'player' && group !== 'player') continue
    if (want === 'mob' && group === 'player') continue
    const d = distOf(e)
    if (d > R) continue
    const hp = healthOf(e)
    list.push({
      name: nm, kind: group, hostile, neutral, ranged: RANGED_RE.test(nm),
      distance: Math.round(d * 100) / 100,
      position: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) },
      dy: Math.round((e.position.y - me.y) * 10) / 10,
      ...(hp === null ? {} : { health: hp }),
      ...(isPlayer ? { player: true } : {}),
    })
  }
  list.sort((a, c) => a.distance - c.distance)
  const counts = { hostile: 0, neutral: 0, player: 0, other: 0 }
  for (const x of list) counts[x.kind]++
  return {
    me: { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) },
    radius: R, kind: want, counts,
    total: list.length,
    list: list.slice(0, Math.min(Math.max(Number(limit) || 40, 1), 64)),
  }
}
