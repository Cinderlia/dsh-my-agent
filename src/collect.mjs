/* ============================================================================
 * collect —— **收集物品**（用户 2026-10-24 定义的"工具"：本地脚本自己把活干完）
 * ----------------------------------------------------------------------------
 * 规则（用户原话）：
 *   · 参数是要收集的物品；
 *   · **创造模式直接拿**；
 *   · **生存模式只支持"自然方块"**这类能直接采集的东西；
 *     合成品直接**转交 craft**（craft 还没实现，这里只占位并说清楚）；
 *   · 本地 find 16 格内的目标 → navi 过去 → dig → **比对前后背包**确认掉落物有没有捡起 →
 *     没捡起就 navi 到掉落物上 → 确认收到才算成功；
 *   · 任意一步失败 → 返回**失败原因**（不是笼统的"失败了"）。
 *
 * 与 navi 的分工：navi 是异步队列里的独立任务；collect **自己**跑在执行体内、内部同步等
 * navi 结束 —— 它不能在队列里再排一个 navi（会自己等自己，死锁）。
 * ========================================================================== */
import Vec3 from 'vec3'
import { isAir } from './block-names.mjs'

/** 采集半径（用户定的 16 格） */
export const COLLECT_RADIUS = 16
/** 等掉落物进背包的最长时间 */
const PICKUP_WAIT_MS = 2500
/** 单个物品最多挖几次（防止一块挖不出来时死循环） */
const MAX_DIG_TRIES = 3

/**
 * 物品名 → 它从哪种**方块**掉（只在"名字不是方块"时才用）。
 * 没列进来的物品一律当"合成品"，转 craft。
 */
export const ITEM_SOURCE = {
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  charcoal: ['coal_ore', 'deepslate_coal_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
  lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'],
  emerald: ['emerald_ore', 'deepslate_emerald_ore'],
  quartz: ['nether_quartz_ore'],
  raw_iron: ['iron_ore', 'deepslate_iron_ore'],
  raw_gold: ['gold_ore', 'deepslate_gold_ore'],
  raw_copper: ['copper_ore', 'deepslate_copper_ore'],
  flint: ['gravel'],
  string: ['cobweb'],
  leather: ['cow', 'horse', 'donkey', 'mule', 'llama'],
  feather: ['chicken'],
  wool: ['sheep'],
  egg: ['chicken'],
  ink_sac: ['squid', 'glow_squid'],
  glow_ink_sac: ['glow_squid'],
  bone: ['skeleton', 'wither_skeleton'],
  gunpowder: ['creeper', 'ghast'],
  slime_ball: ['slime'],
  ender_pearl: ['enderman'],
  blaze_rod: ['blaze'],
  zombie_flesh: ['zombie', 'husk', 'drowned'],
  spider_eye: ['spider', 'cave_spider'],
  honey_bottle: ['bee'],
  sugar_cane: ['sugar_cane'],
  wheat: ['wheat'],
  carrot: ['carrots'],
  potato: ['potatoes'],
  beetroot: ['beetroots'],
  apple: ['oak_leaves', 'dark_oak_leaves'],
}

/** 这个名字是不是"能直接挖的方块" */
export function blockNameOf (name, registry) {
  const n = String(name ?? '').trim().toLowerCase()
  if (!n) return null
  if (registry?.blocksByName?.[n]) return n
  const src = ITEM_SOURCE[n]
  if (Array.isArray(src) && src.length) return src.find((s) => registry?.blocksByName?.[s]) ?? null
  return null
}

/** 判定：创造直接拿 / 生存挖方块 / 合成品转 craft */
export function planCollect (self, args = {}) {
  const b = self?.bot
  if (!b?.entity?.position) return { ok: false, why: '我还没有位置（没连上或区块没加载完）' }
  const name = String(args.name ?? args.item ?? '').trim().toLowerCase()
  if (!name) return { ok: false, why: '要给要收集的物品名（如 oak_log / stone / diamond）' }
  const count = Math.max(1, Math.min(Number(args.count ?? 1), 64))
  const mode = String(b.game?.gameMode ?? '').toLowerCase()
  const creative = mode === 'creative'
  const reg = b.registry ?? null
  const block = blockNameOf(name, reg)
  /* 名字既不是方块、也没有来源映射 ⇒ 合成品/加工品：按用户规则转 craft（占位） */
  if (!creative && !block) {
    return {
      ok: false,
      needsCraft: true,
      name, count,
      why: `「${name}」不是能直接采集的方块（是合成品/加工品）—— 这个要交给 craft（还没实现，先占位）。`
        + '\n现在能采集的是：自然方块（原木/石头/泥土/沙子/矿石…），或掉这些的物品名（如 diamond←diamond_ore）。',
    }
  }
  return {
    ok: true,
    name,
    block: block ?? null,
    count,
    mode,
    creative,
    radius: COLLECT_RADIUS,
    strategy: creative ? 'give' : 'dig',
  }
}

/** 背包里这个物品现在有几个 */
export function invCount (b, name) {
  let n = 0
  try {
    for (const it of b.inventory.items()) if (it?.name === name) n += it.count
  } catch { /* 没背包 */ }
  return n
}

/** 等一小会儿（可被 signal 打断） */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 走到某个坐标（用调用方给的 movements；失败抛错并带原因）。
 * `Goals` 必须由调用方递进来 —— pathfinder 的 Goals 挂在**插件模块**上（`self._pf.Goals`），
 * 不在 bot 上，也不该在这里硬 import（pathfinder 是可选依赖）。
 */
async function walkTo (b, movements, Goals, x, y, z, { timeoutMs = 30_000 } = {}) {
  const pf = b.pathfinder
  if (!pf) throw new Error('没有可用的 pathfinder')
  const goal = Goals?.GoalNear ? new Goals.GoalNear(new Vec3(x, y, z), 2) : null
  if (!goal) throw new Error('pathfinder 的 Goals 没挂上（先 mc_move 一次让它初始化）')
  if (movements) { try { pf.setMovements(movements) } catch { /* 老版本 */ } }
  await Promise.race([
    pf.goto(goal),
    new Promise((_, rej) => setTimeout(() => { try { pf.stop?.() } catch {} ; rej(new Error(`走过去超时（${Math.round(timeoutMs / 1000)} 秒）`)) }, timeoutMs)),
  ])
}

/** 找附近目标方块（按距离升序） */
export function findTargets (b, blockName, radius = COLLECT_RADIUS, want = 1) {
  let list = []
  try {
    list = b.findBlocks({ matching: (blk) => blk?.name === blockName, maxDistance: radius, count: Math.max(want * 4, 8) })
  } catch { list = [] }
  const me = b.entity.position
  return list
    .map((p) => ({ x: p.x, y: p.y, z: p.z, d: me.distanceTo(p) }))
    .sort((a, c) => a.d - c.d)
}

/**
 * 执行收集。**会阻塞到干完**（由任务队列把它当异步任务跑）。
 * @returns {Promise<{ok:boolean, collected:number, name:string, ms:number, steps:string[], text:string}>}
 */
export async function runCollect (self, plan, { signal = null, movements = null, log = () => {} } = {}) {
  const b = self?.bot
  const t0 = Date.now()
  const steps = []
  if (!b?.entity) throw new Error('执行时已经掉线了')
  if (!plan?.ok) throw new Error(plan?.why ?? '规划失败')
  const goals = self?._pf?.Goals ?? self?._pf?.default?.Goals ?? null

  /* ① 创造模式：直接拿 */
  if (plan.creative) {
    let given = 0
    try {
      const item = b.registry?.itemsByName?.[plan.name]
      if (!item) throw new Error(`不认识的物品 ${plan.name}`)
      const before = invCount(b, plan.name)
      for (let i = 0; i < plan.count; i += item.stackSize ?? 64) {
        const chunk = Math.min(plan.count - i, item.stackSize ?? 64)
        const slot = b.inventory.firstEmptySlot('items')
        if (slot === null || slot === undefined) throw new Error('背包满了，腾个位置再拿')
        await b.creative.setInventorySlot(slot, item.id, chunk)
        given += chunk
      }
      const after = invCount(b, plan.name)
      if (after <= before) throw new Error('创造模式塞物品没生效（背包没变化）')
      steps.push(`创造模式直接拿 ${after - before} 个`)
      return { ok: true, collected: after - before, name: plan.name, ms: Date.now() - t0, steps, via: 'give', text: `✅ 创造模式直接拿到 ${plan.name} ×${after - before}` }
    } catch (e) {
      return { ok: false, collected: given, name: plan.name, ms: Date.now() - t0, steps, text: `❌ 创造模式取物失败：${e.message}` }
    }
  }

  /* ② 生存模式：找 → 走 → 挖 → 验证捡起 → 捡 */
  const need = plan.count
  let gained = 0
  let lastWhy = null
  for (let round = 0; round < need; round++) {
    if (signal?.aborted) throw new Error('被取消')
    const before = invCount(b, plan.name)
    const targets = findTargets(b, plan.block, plan.radius, 1)
    if (!targets.length) {
      lastWhy = `附近 ${plan.radius} 格内没有 ${plan.block}`
      break
    }
    const t = targets[0]
    log(`第 ${round + 1} 个：${plan.block} @ ${t.x},${t.y},${t.z}（${t.d.toFixed(1)} 格）`)
    // 走过去
    try {
      await walkTo(b, movements, goals, t.x, t.y, t.z)
      steps.push(`走到 ${t.x},${t.y},${t.z}`)
    } catch (e) {
      lastWhy = `走不过去：${e.message}`
      break
    }
    // 挖
    let dug = false
    for (let attempt = 0; attempt < MAX_DIG_TRIES && !dug; attempt++) {
      const blk = b.blockAt(new Vec3(t.x, t.y, t.z))
      if (!blk || isAir(blk.name) || blk.name !== plan.block) {
        lastWhy = attempt === 0 ? `那格已经不是 ${plan.block}（${blk?.name ?? '未加载'}）` : lastWhy
        break
      }
      try {
        if (typeof b.canDigBlock === 'function' && !b.canDigBlock(blk)) throw new Error('够不着或没有合适的工具')
        await b.dig(blk)
        dug = true
        steps.push(`挖掉 ${blk.name}`)
      } catch (e) {
        lastWhy = `挖不动：${e.message}`
        await sleep(300)
      }
    }
    if (!dug) break
    // 等自动吸附，再比对背包
    let after = before
    const deadline = Date.now() + PICKUP_WAIT_MS
    while (Date.now() < deadline) {
      await sleep(200)
      after = invCount(b, plan.name)
      if (after > before) break
    }
    if (after > before) {
      gained += after - before
      steps.push(`背包 +${after - before}（${plan.name}）`)
      continue
    }
    // 没进背包：走到掉落物上
    const drop = Object.values(b.entities ?? {}).find((e) =>
      e?.position && /^item$|^Item$/.test(String(e.name ?? e.displayName ?? '')) &&
      Math.hypot(e.position.x - (t.x + 0.5), e.position.y - (t.y + 0.5), e.position.z - (t.z + 0.5)) <= 6)
    if (drop) {
      try {
        await walkTo(b, movements, goals, Math.floor(drop.position.x), Math.floor(drop.position.y), Math.floor(drop.position.z), { timeoutMs: 15_000 })
        steps.push('走到掉落物上')
      } catch (e) { lastWhy = `去捡掉落物失败：${e.message}` }
    } else {
      lastWhy = '挖掉了，但附近没看到掉落物实体（可能被别人捡走/掉进岩浆/没生成）'
    }
    // 再等一会儿
    const deadline2 = Date.now() + PICKUP_WAIT_MS
    while (Date.now() < deadline2) {
      await sleep(200)
      after = invCount(b, plan.name)
      if (after > before) break
    }
    if (after > before) {
      gained += after - before
      steps.push(`捡起 +${after - before}`)
    } else {
      lastWhy = lastWhy ?? '挖掉了但没捡到（背包没变化）'
      break
    }
  }

  const ok = gained >= need
  return {
    ok,
    collected: gained,
    name: plan.name,
    ms: Date.now() - t0,
    steps,
    ...(ok ? {} : { why: lastWhy ?? `只收到 ${gained}/${need}` }),
    text: ok
      ? `✅ 收集到 ${plan.name} ×${gained}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`
      : `❌ 收集 ${plan.name} 失败：${lastWhy ?? `只收到 ${gained}/${need}`}`,
  }
}

export { walkTo }
