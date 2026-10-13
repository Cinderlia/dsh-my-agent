/**
 * "使用/交互"那一层（路线图第 ④ 条第二十刀）。
 *
 * 搬走 `McBot` 的四个成员（第二十刀两个，第二十七刀又补两个）：
 *   · `useBlock ({x,y,z,who})` —— 右键**方块或实体**（`activateBlock` / `activateEntity`）：
 *     开箱子、按按钮、拉杆、开门、喂动物、上船…
 *   · `useItem ({hold})`       —— 对着**空气**用**手上的东西**（`activateItem` / `deactivateItem`）：
 *     扔末影之眼/珍珠/雪球/鸡蛋、拉弓射箭、喝药水。
 *
 * 两者的共同点：**服务端都不回执**（上游 `mineflayer\lib\plugins\inventory.js` 只 `await lookAt`
 * 再写一个包），所以这一层的全部价值在"**怎么复核**"：容器看窗口开没开、门/按钮看方块状态翻没翻、
 * 骑乘看 `bot.vehicle`、物品看用完之后还剩几个。
 *
 * 三条约定（跟前面几刀一样）：
 *   ① **不反向 import `core.mjs`** —— 只吃传进来的 `b`（mineflayer bot）。
 *   ② 只借 `vec3` 与兄弟模块（`camera.mjs` / `block-names.mjs` / `entity-names.mjs` / `async-util.mjs`），
 *      **不直接 import mineflayer**，依赖方向保持"叶子 → 上层"。
 *   ③ 属于插件实例状态的东西走 `ctx`（迁移规矩第 17 / 24 条）：
 *      `ctx.t(promise, kind, label)` 是本轮 11 秒闸门 + 中断（`core.mjs` 的 `#t`）；
 *      `ctx.callLeft()` 是"这一轮还剩多少毫秒"（`useItem` 要留 400ms 给松手包）。
 *      `t` 的兜底写成"直接 await"，自写冒烟就不必造真闸门。
 */
import { Vec3 } from 'vec3'
import { sleep } from './async-util.mjs'
import { aimAt } from './camera.mjs'
import { CONTAINER_RE, TOGGLE_RE } from './block-names.mjs'
import { entityNameOf, pickEntity } from './entity-names.mjs'
import { heldText } from './inventory.mjs'

/**
 * 使用/激活方块或实体（开门、按按钮、拉杆、开箱子、喂动物…）。
 *
 * 🔴 2026-10-08 审计改了两处：
 *   ① 交互**到底成没成要复核**：`activateBlock`/`activateEntity` 内部只 `await lookAt` +
 *      写一个包（`mineflayer\lib\plugins\inventory.js:195-258`），**服务端不会回执** ——
 *      旧版无条件 `return { usedBlock }`，等于"包发出去了"就报成功。
 *      现在：容器看窗口开没开、门/按钮看方块状态翻没翻、骑乘看 `bot.vehicle`。
 *   ② `who` 用和 `attack()` 同一套匹配（中文别名/displayName 都认），找不到时列出附近实际有谁。
 */
export async function useBlock (b, { x, y, z, who = null } = {}, ctx = {}) {
  const t = ctx.t ?? ((p) => p)
  if (who) {
    const me = b.entity?.position
    const list = Object.values(b.entities ?? {}).filter((e) => e !== b.entity).map((e) => {
      let d = Infinity
      try { d = e.position.distanceTo(me) } catch { /* 假 bot 没有 position */ }
      return { e, d }
    })
    const { hit, near } = pickEntity(list, who)
    if (!hit) {
      throw new Error(`附近找不到实体 "${who}"（附近实际有：${near.length ? near.join('、') : '什么都没有'}）`
        + '—— 名字要跟 mc_observe "程序检测到"里显示的一致（中文叫法也认）')
    }
    const ent = hit.e
    const dist = Number.isFinite(hit.d) ? Number(hit.d.toFixed(1)) : null
    if (dist != null && dist > 4.5) {
      return {
        usedEntity: entityNameOf(ent), distance: dist, reached: false,
        note: `太远了（${dist} 格，交互要 4.5 格内）—— 先 mc_move 到它旁边（或者 mc_act {mode:"toward", who:"${who}"}）再 use`,
      }
    }
    aimAt(b, { x: ent.position.x, y: ent.position.y + 1, z: ent.position.z })
    await t(Promise.resolve(b.activateEntity(ent)), 'act', `与 ${who} 交互`)
    await sleep(220)
    const riding = b.vehicle && b.vehicle.id === ent.id
    return {
      usedEntity: entityNameOf(ent), ...(dist != null ? { distance: dist } : {}),
      ...(riding ? { riding: entityNameOf(ent) } : {
        note: '交互包已经发出去了 —— 服务端**不会回执**，我没法确认它生效（`activateEntity` 内部只瞄一下再发包）。'
          + '如果没反应：确认它在 4.5 格内、你没被方块挡住、它不是别人拴着的/有主人的',
      }),
    }
  }
  const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  const blk = b.blockAt(pos)
  if (!blk) throw new Error(`${pos.x},${pos.y},${pos.z} 未加载`)
  const at = { x: pos.x, y: pos.y, z: pos.z }
  const props0 = { ...(blk.getProperties?.() ?? {}) }
  aimAt(b, new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5))
  await t(Promise.resolve(b.activateBlock(blk)), 'act', `使用 ${blk.name}`)
  // ① 容器类：窗口该弹出来 —— 这是唯一硬证据
  if (CONTAINER_RE.test(blk.name)) {
    for (let i = 0; i < 10; i++) {
      await sleep(120)
      const w = b.currentWindow
      if (w && w !== b.inventory) {
        return {
          usedBlock: blk.name, at, opened: w.type,
          ...(typeof w.containerItems === 'function' ? { slots: w.containerItems().length } : {}),
        }
      }
    }
    return {
      usedBlock: blk.name, at, opened: false,
      note: `${blk.name} 的窗口**没有打开**（等了 1.2 秒）—— 包发出去了但服务端没回应：`
        + '够不着（要 4.5 格内、看得见）/ 被别的玩家占着 / 位置读错了。别当成开成功了。'
        + '先 mc_move 走近再试，或者 mc_scan 看一眼那格到底是什么',
    }
  }
  // ② 门/活板门/栅栏门/按钮/拉杆：方块状态应该翻转
  if (TOGGLE_RE.test(blk.name)) {
    await sleep(280)
    const after = b.blockAt(pos)
    const props1 = { ...(after?.getProperties?.() ?? {}) }
    const changed = Object.keys(props1).filter((k) => props0[k] !== props1[k])
    return {
      usedBlock: blk.name, at,
      ...(changed.length
        ? { toggled: true, changed: changed.map((k) => `${k}: ${props0[k]} → ${props1[k]}`) }
        : { toggled: false, note: `${blk.name} 的状态**一点没变**（${Object.entries(props0).map(([k, v]) => `${k}=${v}`).join(' ') || '没有可读状态'}）—— 交互没生效：够不着（4.5 格内、看得见）或被红石/插件锁着` }),
    }
  }
  // ③ 其它（床、蛋糕、炼药锅…）：只能如实说"包发出去了"
  await sleep(280)
  const after2 = b.blockAt(pos)
  const props2 = { ...(after2?.getProperties?.() ?? {}) }
  const changed2 = Object.keys(props2).filter((k) => props0[k] !== props2[k])
  return {
    usedBlock: blk.name, at,
    ...(changed2.length ? { changed: changed2.map((k) => `${k}: ${props0[k]} → ${props2[k]}`) } : {}),
    note: '交互包已经发出去了 —— 服务端**不会回执**，我没法确认生效（`activateBlock` 内部只瞄一下再发包）。'
      + '如果没反应：确认 4.5 格内、看得见、没被挡住',
  }
}

/**
 * 对着**空气**用**手上的东西**（右键）：扔末影之眼 / 末影珍珠 / 雪球 / 鸡蛋，拉弓射箭，喝药水。
 *
 * 为什么单独一个动作：`useBlock` 只能右键**方块或实体**（`activateBlock` / `activateEntity`），
 * 而上面这些用的是 `activateItem`（对着空气用物品）。2026-10-06 用户问"现在能通关吗"时
 * 定位到的硬缺口就是它 —— 没有它**找不到要塞**（扔末影之眼是原版唯一办法），也射不掉
 * 末影水晶、射不了烈焰人。补之前全仓一次 `activateItem` 都没有。
 *
 * `hold`：按住多少毫秒再松手（`deactivateItem`）。
 *   - 拉弓**必须给**（弦拉满约 1000ms，不给就只是"举起弓"不射箭）；
 *   - 喝药水约 1600ms；
 *   - 可扔物（眼睛 / 珍珠 / 雪球）给了也无害，松手包是幂等的。
 */
export async function useItem (b, { hold = 0 } = {}, ctx = {}) {
  const t = ctx.t ?? ((p) => p)
  const item = b.heldItem
  if (!item) {
    throw new Error('手上没东西 —— 先用 mc_act{mode:"equip",name:"…"} 拿到手上（mc_inventory 看背包里有什么）')
  }
  // 别把一轮 11 秒全用来"按住不放"：最多 3 秒，且**给松手留 400ms 余量**。
  // 🔴 这个余量是必需的：松手包（`deactivateItem`）也要过 `#t` 的预算闸门，
  //    如果按住把这一轮吃干，松手会被拒 ⇒ 拉弓变成"一直举着弓、箭永远不出去"
  //    （实测就是被自己的回归套件 check-core-useitem ⑤ 抓到的）。
  const raw = ctx.callLeft ? Number(ctx.callLeft()) : 11_000
  const left = Number.isFinite(raw) ? raw : 11_000
  const want = Math.max(0, Number(hold) || 0)
  const ms = Math.max(0, Math.min(want, 3_000, Math.max(0, left - 400)))
  await t(Promise.resolve(b.activateItem()), 'act', `使用 ${item.name}`)
  if (ms > 0) await sleep(ms)
  if (want > 0 && typeof b.deactivateItem === 'function') {
    await t(Promise.resolve(b.deactivateItem()), 'act', `松开 ${item.name}`)
  }
  const out = { used: item.name, count: item.count, heldMs: ms }
  /* 🔴 2026-10-08 第五份审计报告 ⑦：`count` 是**使用前**的快照 —— 末影珍珠/雪球扔出去后
   *    仍报旧数量，模型以为手上还有 N 个。这里补一个"用完之后还剩多少"。 */
  const after = (() => {
    try {
      const h = b?.heldItem
      if (h && h.name === item.name) return h.count
      const all = b.inventory.items().filter((i) => i.name === item.name)
      return all.reduce((s, i) => s + i.count, 0)
    } catch { return null }
  })()
  if (after != null) {
    out.left = after
    if (after >= item.count && item.name !== 'bow' && item.name !== 'crossbow') {
      out.note = `手上还是 ${after} 个（没少）—— 这一下可能没真用出去（服务端不回执这类动作，用 mc_inventory 复核）`
    }
  }
  if (want > ms) {
    out.note = [out.note, `这一轮剩下的时间不够按住 ${want}ms（只按了 ${ms}ms）—— 过一会儿再叫一次 mc_act{useitem} 补`].filter(Boolean).join('；')
  }
  return out
}

/** 统一交互入口：mode = look / place / break / toward */
export async function interact (self, args = {}) {
  const mode = String(args.mode ?? 'look')
  if (mode === 'look') return { mode, ...(await self.lookAt(args)) }
  if (mode === 'place') return { mode, ...(await self.placeBlock(args)) }
  if (mode === 'break') return { mode, ...(await self.breakBlock(args)) }
  if (mode === 'toward') {
    const b = self.requireBot()
    if (!args.who) throw new Error('toward 需要 who（玩家名）')
    const r = await self.lookAt({ who: args.who })
    if (args.approach !== false) {
      const target = b.entity.position.clone()
      const eye = { x: r.lookingAt.x, y: target.y, z: r.lookingAt.z }
      await self.walkTo(eye, { arrive: 3, budget: callBudget(args.budgetMs) })
      await self.lookAt({ who: args.who })
    }
    return { mode, ...(await self.lookAt({ who: args.who })), position: self.position }
  }
  throw new Error(`未知 mode：${mode}（可用 look / place / break / toward）`)
}

/** 装备某物到手上 */
export async function equip (self, { name } = {}, ctx = {}) {
  const t = ctx.t ?? ((p) => p)
  const b = self.requireBot()
  const before = heldText(b)
  const item = b.inventory.items().find((i) => i.name === String(name))
  if (!item) throw new Error(`背包里没有 ${name}（用 mc_inventory 看有什么）`)
  await t(b.equip(item, 'hand'), 'equip', `手持 ${name}`)
  /* 🔴 `held` 必须**读回来**（2026-10-08 审计：旧版拿装备前那个 item 对象拼字符串，
   *    换手静默失败时照样报"手上是 X"） */
  const held = heldText(b)
  const ok = b.heldItem?.name === item.name
  return {
    held, ...(before !== held ? { before } : {}),
    ...(ok ? {} : { note: `换手没成功（现在手上是 ${held}）—— 那一叠可能被占用了，或刚被用掉；再叫一次 mc_act{mode:"equip",name:"${name}"}，先用 mc_inventory 看还剩什么` }),
  }
}


