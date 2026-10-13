/**
 * 背包那一层（路线图第 ④ 条第七刀）。
 *
 * 用户 2026-10-08 的路线图：`src\core.mjs` 渐进拆分，顺序是"先纯函数，再实体/背包/感知，
 * 移动与挖掘最后"。前六刀搬走的都是**纯函数**；这一刀是第一次搬"读 bot 实时状态"的东西。
 *
 * 这些函数以前是 `McBot` 的私有方法（`#heldText` / `#invSnap` / `#invUsed` /
 * `#canHarvestNow` / `#toolKinds` / `#freeSlot`）和一个公开方法（`countOf`）。
 * 搬出来之后签名多了一个 `b`（mineflayer bot）—— 函数体**逐字未改**，只把
 * `this.#invSnap(b)` 换成 `invSnap(b)`。
 *
 * 三条约定（跟前面几刀一样）：
 *   ① 本模块**不 import `core.mjs`**（不许反向依赖），也**不 import 任何游戏库**：
 *      它只读传进来的 `b`。
 *   ② 只读、不改状态：不看世界、不发包、不 await。所以搬走不会动到异步流程。
 *      （⚠️ 第十九刀搬进来的四个**动作**是例外：它们发包、会 await、会改背包 —— 见下面那一段分节注释；
 *       它们仍然不 import 游戏库，实例相关的东西由 `ctx` 传进来。）
 *      （第三十二刀又加进来一个 `equipFor`（动手前换对的工具）：它要读 `self.mcPlugins`、
 *       要调实例的预算闸门 `this.#t`（由 core 的薄包装塞进 `ctx.t`），所以它收 `self`。）
 *   ③ `core.mjs` 里那些同名方法**保留**（`countOf` 是公开面，一行都不能少），
 *      它们变成薄包装或直接调这里 —— 外部调用点一行都不用改。
 *
 * ⚠️ 改这些判据时请连着 `src\core.mjs` 的调用点一起想：`heldText` 的文案会出现在
 * `mc_dig` / `mc_act` / `mc_build` 的结果里，是 AI 判断"我手里现在是什么"的唯一来源。
 */
import { sleep } from './async-util.mjs'
/* 第三十二刀：`equipFor` 要比较「手上这把 / 背包里最快那把」的挖掘耗时（`digMsFor` / `bestToolFor`）。
 * 依赖方向是 inventory → dig-speed → world-observer，不成环。 */
import { digMsFor, bestToolFor } from './dig-speed.mjs'

/** 手上那叠的短名（`dirtx18`）；空手就是 `空手` */
export function heldText (b) {
  return b?.heldItem ? `${b.heldItem.name}x${b.heldItem.count}` : '空手'
}

/**
 * 装备栏那五格 —— `bot.inventory.slots` 的 **5/6/7/8/45**（头/身/腿/脚/副手）。
 *
 * 为什么要有这一段（2026-10-13 用户报"它现在看不到自己身上的装备"）：
 * `bot.inventory.items()` 只回**背包范围**（`minecraft:inventory` 窗口的 `inventoryStart..inventoryEnd`
 * = 槽 9–44，也就是主背包 + 快捷栏）。5–8 的盔甲和 45 的副手**不在里面** —— 所以以前
 * `mc_inventory` / `mc_observe` 的"背包"里根本看不到身上穿着什么，AI 会以为自己光着，
 * 于是把已经穿在身上的头盔又做一遍。
 *
 * 名字用 `bot.getEquipmentDestSlot()` 那套（`head` / `torso` / `legs` / `feet` / `off-hand`），
 * 这样 `mc_act {mode:"equip", name, to}` 能直接拿它当 `to` 用。
 */
export const EQUIP_SLOTS = [
  [5, 'head', '头'],
  [6, 'torso', '身'],
  [7, 'legs', '腿'],
  [8, 'feet', '脚'],
  [45, 'off-hand', '副手'],
]

/** 身上穿着什么：`{ head: 'iron_helmetx1' | null, torso, legs, feet, 'off-hand' }` */
export function equipmentOf (b) {
  const slots = b?.inventory?.slots
  const out = {}
  for (const [i, dest] of EQUIP_SLOTS) {
    const it = Array.isArray(slots) ? slots[i] : null
    out[dest] = it ? `${it.name}x${it.count}` : null
  }
  return out
}

/** 装备栏一行字（`头 空 · 身 铁胸甲x1 · 腿 空 · 脚 空 · 副手 空`） */
export function equipmentText (b) {
  const eq = equipmentOf(b)
  return EQUIP_SLOTS.map(([, dest, label]) => `${label} ${eq[dest] ?? '空'}`).join(' · ')
}

/**
 * 物品名 → 该穿在哪一格。不认名字就回 `hand`（照旧"拿到手上"）。
 *
 * 判据照 `extensions\mc_auto.mjs` 的 `ARMOR_SLOTS`（自动穿甲那套）抄，多认了 `elytra`、
 * `carved_pumpkin` 和盾/图腾（盾和 `totem_of_undying` 是副手件 —— 1.21 里副手就是
 * `off-hand`，`simple_inventory.js:19` 加的键名带连字符）。
 */
export function equipDestOf (name) {
  const n = String(name ?? '')
  if (/(_helmet|_cap)$/.test(n) || n === 'turtle_helmet' || /_skull$/.test(n) || n === 'carved_pumpkin') return 'head'
  if (/(_chestplate|_tunic)$/.test(n) || n === 'elytra') return 'torso'
  if (/(_leggings|_pants)$/.test(n)) return 'legs'
  if (/_boots$/.test(n)) return 'feet'
  if (n === 'shield' || n === 'totem_of_undying') return 'off-hand'
  return 'hand'
}

/** 背包按**名字合计**快照（走路/挖矿前后比"路上用掉了什么"） */
export function invSnap (b) {
  const m = new Map()
  try { for (const i of b.inventory?.items?.() ?? []) m.set(i.name, (m.get(i.name) ?? 0) + i.count) } catch { /* 假 bot 没有就算了 */ }
  return m
}

/** 相比快照少掉的东西（按少掉的数量降序） */
export function invUsed (b, snap) {
  if (!snap?.size) return []
  const now = invSnap(b)
  const used = []
  for (const [name, n0] of snap) {
    const n1 = now.get(name) ?? 0
    if (n1 < n0) used.push({ name, lost: n0 - n1 })
  }
  return used.sort((a, z) => z.lost - a.lost)
}

/** 手上这叠现在能不能挖这块方块（`harvestTools` = {物品id:true}；没这项 = 徒手就行） */
export function canHarvestNow (b, blk) {
  if (b?.game?.gameMode === 'creative') return true
  const need = Object.keys(blk?.harvestTools ?? {})
  if (!need.length) return true
  return Boolean(b?.heldItem && blk.harvestTools[b.heldItem.type])
}

/** 挖它需要什么工具（人话：镐／斧／锹；minecraft-data 里是 pickaxe/axe/shovel 这种英文） */
export function toolKinds (b, blk) {
  const CN = { pickaxe: '镐', axe: '斧', shovel: '锹', hoe: '锄', shears: '剪刀', sword: '剑' }
  const kinds = [...new Set(Object.keys(blk?.harvestTools ?? {})
    .map((id) => b.registry?.items?.[id]?.name).filter(Boolean)
    .map((n) => CN[n.split('_').pop()] ?? n.split('_').pop()))]
  return kinds.length ? `需要${kinds.join('／')}` : '需要合适的工具'
}

/**
 * 背包里某样东西有几个（同名合计，含手上那叠）—— 任务恢复时的"现场状态"。
 *
 * 读不到背包（假 bot、还没连上、inventory.items 不存在）就回 `null`：
 * **别回 0** —— 0 是"背包里确实没有"，`null` 是"读不到"，任务台账要靠这个区分。
 */
export function countOf (b, name) {
  if (!b?.inventory?.items) return null
  const want = String(name ?? '').trim()
  if (!want) return null
  let n = 0
  try { for (const i of b.inventory.items()) if (i?.name === want) n += Number(i.count) || 0 } catch { return null }
  return n
}

/**
 * 选一个槽位放取来的物品。优先级：
 *   ① 已经放着**同一种**东西的槽（重复取同款不占新格，也不会覆盖别的）
 *   ② 快捷栏（36–44）的空槽
 *   ③ 手上那格（实在满了才覆盖）
 * 为什么要在意：连建一面墙会反复调 placeBlock → giveItem，
 * 若每次都挑"第一个空槽"，很快就把之前取的方块覆盖掉，导致后面莫名"背包里没有 X"。
 */
export function freeSlot (b, itemName = null) {
  const slots = b.inventory?.slots ?? []
  if (itemName) {
    for (let s = 36; s <= 44; s++) {
      if (slots[s]?.name === itemName) return s
    }
  }
  for (let s = 36; s <= 44; s++) {
    if (!slots[s]) return s
  }
  return b.quickBarSlot != null ? 36 + b.quickBarSlot : 36
}

/* ═══════════════ 第十九刀：把"背包动作"也搬过来（读 + 动，同一个模块） ═══════════════
 *
 * 前七刀这一层只读背包；这一刀把三个**动作**也收进来：`inventoryView`（一览）、
 * `giveItem`（创造取物）、`clearInventory`（清空）、`tossItem`（丢弃）。
 *
 * 与前七刀的区别：这三个要**发包**，所以都 `await`。它们仍然不 import 任何游戏库 ——
 * 需要"这一轮还剩多少时间"和"造一个 Item"这两件实例/库相关的事，由 `core.mjs` 的
 * 薄包装打包成 `ctx` 传进来（迁移规矩第 17 条）：
 *   · `ctx.t(promise, kind, label)` —— 本轮的 11 秒闸门 + 中断（`core.mjs` 的 `#t`）
 *   · `ctx.makeItem(type, n)`       —— `new (prismarine-item)(registry)(type, n)`
 */

/**
 * 背包一览（`mc_inventory` 的正文）。
 *
 * 🔴 按**名字合计**，而且只报一次"手上"。
 * 实机教训（2026-10-07）：旧实现回 `{held, items}`，而 mineflayer 的 `inventory.items()`
 * **本来就包含手上那一格** —— 同一叠东西在输出里出现两遍，模型当场数了两遍：
 * 「held oak_planksx2 + items oak_planksx2 = 4 块木板」，于是它以为 `mc_craft` 在撒谎
 * （其实它只有 2 块，做工作台要 4 块），跑去砍树了。工具输出必须**一眼看得出总数**。
 */
export function inventoryView (b) {
  const all = b.inventory.items()
  const totals = new Map()
  for (const i of all) totals.set(i.name, (totals.get(i.name) ?? 0) + i.count)
  const items = [...totals].map(([name, count]) => ({ name, count }))
  const held = b.heldItem ? `${b.heldItem.name}x${b.heldItem.count}` : null
  const lines = [held ? `手上：${held}（这一叠已经算在下面的合计里，别再加一遍）` : '手上：空']
  lines.push(items.length ? `背包（同名已合计、**含手上那叠**）：${items.map((i) => `${i.name}x${i.count}`).join('、')}` : '背包：空')
  /* 🔴 2026-10-08 第五份审计旁注：`all.length` 是**叠数**（`items()` 一叠一条、不含 0-8 那九格），
   *    写"格"会让模型以为"背包只剩 3 格空位"。改成"叠"，并补一句空位。 */
  const free = (() => { try { return b.inventory.emptySlotCount() } catch { return null } })()
  lines.push(`共 ${all.length} 叠 / ${items.length} 样${free != null ? `（背包还有 ${free} 个空位）` : ''}`)
  /* 装备栏单独一行（2026-10-13 用户要求）：这几格不在 `items()` 里，以前完全看不见。
   * 用 `mc_act {mode:"equip", name, to}` 往里穿；`to` 就是这里的 head/torso/legs/feet/off-hand。 */
  const equipment = equipmentOf(b)
  lines.push(`装备栏：${equipmentText(b)}（这几格不占背包位，穿装备用 mc_act {mode:"equip"}）`)
  return { text: lines.join('\n'), held, items, equipment }
}

/**
 * 创造模式直接获取物品。
 *
 * 为什么不用 /give：多数服对非 OP 关掉 /give，而**创造模式改槽位是协议级能力**
 * （`set_creative_slot` 包），服务端一般照收。所以走 `bot.creative.setInventorySlot`。
 * 这也是用户点名的缺口："连创造模式直接获取物品的方法都没有"。
 */
export async function giveItem (b, { name, count = 1, slot = null } = {}, ctx = {}) {
  const t = ctx.t ?? ((p) => p)
  if (b.game?.gameMode !== 'creative') {
    throw new Error(`取物只在创造模式可用（当前 ${b.game?.gameMode ?? '未知'}）；生存模式请挖或合成`)
  }
  const itemName = String(name ?? '').trim()
  if (!itemName) throw new Error('要给物品名（如 oak_planks / diamond_sword）')
  const type = b.registry?.itemsByName?.[itemName]
  if (!type) throw new Error(`未知物品：${itemName}（用英文 id，如 oak_planks）`)
  const n = Math.min(Math.max(Number(count) || 1, 1), type.stackSize ?? 64)
  /* 🔴 2026-10-08 第五份审计报告 M3：`slot` 的文档以前写"0-44"，但 **0-8 不是背包槽**
   *    （`prismarine-windows` 的 `minecraft:inventory` 是 `{ start: 9, end: 44 }`：
   *     0 = 合成结果槽、1-4 = 2×2 合成格、5-8 = 盔甲槽）。
   *    写 0-8 会把物品塞进合成格/盔甲槽（模型以为是"背包第 1 格"）。
   *    现在钳到 9-44，并如实告诉它被挪过。 */
  const asked = slot != null ? Number(slot) : null
  const target = asked != null && Number.isFinite(asked)
    ? Math.min(Math.max(Math.floor(asked), 9), 44)
    : freeSlot(b, itemName)

  const item = ctx.makeItem ? ctx.makeItem(type, n) : null
  await t(b.creative.setInventorySlot(target, item, 800), 'give', `取物 ${itemName}`)
  await sleep(120)
  const nowItem = b.inventory.slots?.[target] ?? null
  const now = nowItem ? `${nowItem.name}x${nowItem.count}` : null
  const moved = asked != null && Number.isFinite(asked) && target !== Math.floor(asked)
    ? `你要的第 ${Math.floor(asked)} 格不是背包格（背包是 9-44：0=合成结果、1-4=合成格、5-8=盔甲）—— 我放进第 ${target} 格了；`
    : ''
  return {
    gave: `${itemName}x${n}`, slot: target, now,
    ...(moved ? { slotAsked: Math.floor(asked) } : {}),
    /* 🔴 2026-10-08 审计：旧版**无条件**说"已放进背包/快捷栏"，即使那格还是空的。文案要跟 `now` 走。 */
    ...(now
      ? { note: moved + (target >= 36 ? `已放进快捷栏第 ${target - 35} 格` : '已放进背包') }
      : { note: `**没放进去**（第 ${target} 格现在还是空的）—— 服务端没认这次 setInventorySlot（失步 / 权限 / 那格被别的窗口占着）。别当成拿到了` }),
  }
}

/** 清空背包（创造模式） */
export async function clearInventory (b, ctx = {}) {
  const t = ctx.t ?? ((p) => p)
  if (b.game?.gameMode !== 'creative') throw new Error('清空背包只在创造模式可用')
  await t(b.creative.clearInventory(), 'give', '清空背包')
  /* 🔴 2026-10-08 第五份审计报告 ⑥：以前直接 `return { cleared: true }` —— 而 `giveItem`
   *    已经改成"读回槽位再说结果"。清完抽查一遍，别谎报"清空成功"。 */
  await sleep(200)
  const left = (() => { try { return b.inventory.items() } catch { return [] } })()
  if (!left.length) return { cleared: true }
  const names = [...new Set(left.map((i) => i.name))].slice(0, 6)
  return {
    cleared: false,
    left: left.length,
    names,
    note: `**没清干净** —— 背包里还剩 ${left.length} 叠（${names.join('、')}${left.length > names.length ? '…' : ''}）。`
      + '服务端可能没认这次清空（失步 / 权限 / 那几格被别的窗口占着）。别当成背包空了。',
  }
}

/** 丢弃手上的物品（`name` 给了就先换上那个） */
export async function tossItem (b, { name = null, count = 1 } = {}, ctx = {}) {
  const t = ctx.t ?? ((p) => p)
  let item = b.heldItem
  if (name) {
    const want = String(name)
    item = b.inventory.items().find((i) => i.name === want)
    if (!item) throw new Error(`背包里没有 ${want}（用 mc_inventory 看有什么）`)
    if (b.heldItem?.name !== want) await t(b.equip(item, 'hand'), 'equip', `手持 ${want}`)
  }
  if (!item) throw new Error('手上没东西可丢')
  const n = Math.min(Math.max(Number(count) || 1, 1), item.count)
  const snap = invSnap(b)
  await t(Promise.resolve(b.toss(item.type, null, n)), 'toss', `丢弃 ${item.name}`)
  /* 🔴 2026-10-08 审计：`bot.toss` 底层是 `transfer()`（clickWindow + 等窗口回包），resolve 只说明
   *    "服务端回包了" —— 到底掉出去几个要按**背包数量差**说，别把"想丢几个"当结果。 */
  const lost = (snap.get(item.name) ?? 0) - (invSnap(b).get(item.name) ?? 0)
  return {
    tossed: `${item.name}x${n}`,
    ...(lost === n ? {} : { note: `背包里只少了 ${Math.max(0, lost)} 个（想丢 ${n} 个）—— 东西可能还在地上或没丢出去，用 mc_inventory 看一眼` }),
  }
}

/* ─────────── 第三十二刀：动手前换工具（原来 core 的私有 `#equipFor`） ─────────── */

/**
 * 动手前把对的工具拿到手上。
 *
 * 🔴 为什么必须做（2026-10-07 实机）：机器人从矿底**垫方块爬回地面后手上还攥着泥土**，
 *    接着对石头连发 6 次 `mc_act{mode:"break"}` —— 徒手挖石头要 7.5 秒，比一轮预算还长，
 *    于是每次都超时，工具还回一句"服务端可能拒了这次破坏"，模型完全看不出问题在哪，
 *    直到玩家在游戏里问「怎么用手挖方块」才反应过来。**手上工具不对 = 挖得极慢**，
 *    这件事必须由插件自己处理 + 明说，不能指望模型记得自己手里攥着什么。
 *
 * 🔴 不只"能不能挖"，还有"挖得多慢"（2026-10-08 实机反馈：玩家转来"快挖完的时候会重置"）：
 *    手上攥着**石剑**去挖原木（剑砍木头 ≈ 3 秒，石斧 ≈ 0.9 秒），一轮预算被啃掉大半，
 *    挖到八成到点松手 → **破坏进度清零**，模型看到的就是"快挖完就重置"。
 *    所以这里还会比较"换成背包里最快的工具能快多少"，快 1.4 倍以上就换。
 */
export async function equipFor (self, b, blk, label = '换工具', ctx = {}) {
  const heldBefore = heldText(b)
  const canNow = canHarvestNow(b, blk)
  const nowMs = digMsFor(b, blk, b?.heldItem?.type ?? null)
  const best = bestToolFor(b, blk)
  const faster = Boolean(best && nowMs != null && best.ms < nowMs * 0.72
    && best.item?.name !== b?.heldItem?.name)
  if (canNow && !faster) return { heldBefore, held: heldBefore, changed: false }
  try {
    if (faster) {
      await ctx.t(b.equip(best.item, 'hand'), 'equip', label)
    } else if (self.mcPlugins?.tool && typeof b.tool?.equipForBlock === 'function') {
      await ctx.t(b.tool.equipForBlock(blk, { requireHarvest: false }), 'equip', label)
    } else {
      const pick = best?.item ?? (b.inventory?.items?.() ?? []).find((it) => blk?.harvestTools?.[it.type])
      if (pick && b.heldItem?.name !== pick.name) await ctx.t(b.equip(pick, 'hand'), 'equip', label)
    }
  } catch { /* 换不上就照旧：调用方按"手上还是不对"如实拒绝 */ }
  const held = heldText(b)
  return { heldBefore, held, changed: held !== heldBefore }
}
