/* ============================================================================
 * collect —— **收集物品**（用户 2026-10-24 定义的"工具"）
 * ----------------------------------------------------------------------------
 * 规则（用户原话）：
 *   · 参数是要收集的物品；
 *   · **创造模式直接拿**；
 *   · **生存模式只支持"自然方块"**这类能直接采集的东西；合成品转交 craft（占位）；
 *   · 本地 find 16 格内的目标 → 满足条件**直接挖**；不满足 → **把 navi 插到自己前面**，
 *     自己挂起等它；navi 跑完回到自己，重新判定距离，够了就继续；
 *   · 挖完**比对前后背包**确认掉落物被捡起，没捡起就插一个 navi 去捡；
 *   · 任意一步失败 → 返回**失败原因**。
 *
 * 🔴 架构要点（用户纠正过）：这里**不是**内部同步调用 navi，而是：
 *     `board.yieldFor(job, {kind:'navi', …})` → 子任务插到队首、自己挂起排第二；
 *     子任务跑完，队列重新调用本函数的 `run()`，从 `job.state` 恢复进度。
 *     所以 `runCollect` 是**状态机**，每一步只推进一个阶段，需要别人帮忙时立即 yield 返回。
 * ========================================================================== */
import Vec3 from 'vec3'
import { isAir } from './block-names.mjs'
import { buildNaviPlan, runNavi } from './navi.mjs'

/** 采集半径（用户定的 16 格） */
export const COLLECT_RADIUS = 16
/** 够得着的距离：≤ 这个值就直接挖，不排 navi */
export const DIG_REACH = 4.2
/** 等掉落物进背包的最长时间 */
const PICKUP_WAIT_MS = 2500

/**
 * 物品名 → 它从哪种**方块**掉（只在"名字不是方块"时才用）。
 * 没列进来的物品一律当"合成品"，转 craft。
 */
export const ITEM_SOURCE = {
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
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
  sugar_cane: ['sugar_cane'],
  wheat: ['wheat'],
  carrot: ['carrots'],
  potato: ['potatoes'],
  beetroot: ['beetroots'],
  apple: ['oak_leaves', 'dark_oak_leaves'],
}

/** 这个名字是不是"能直接挖的方块"（返回方块名；不是就 null） */
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
    ok: true, name, block: block ?? null, count, mode, creative,
    radius: COLLECT_RADIUS, reach: DIG_REACH,
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

/** 附近掉落物实体（item），按距离升序 */
function dropsNear (b, pos, r = 6) {
  const out = []
  for (const e of Object.values(b.entities ?? {})) {
    if (!e?.position) continue
    const nm = String(e.name ?? e.displayName ?? '')
    if (!/^(item|Item)$/.test(nm)) continue
    const d = Math.hypot(e.position.x - pos.x, e.position.y - pos.y, e.position.z - pos.z)
    if (d <= r) out.push({ x: e.position.x, y: e.position.y, z: e.position.z, d })
  }
  return out.sort((a, c) => a.d - c.d)
}

/** 创造模式：直接拿（并回读背包确认） */
async function runCreative (b, plan) {
  const item = b.registry?.itemsByName?.[plan.name]
  if (!item) throw new Error(`不认识的物品 ${plan.name}`)
  const before = invCount(b, plan.name)
  for (let i = 0; i < plan.count; i += item.stackSize ?? 64) {
    const chunk = Math.min(plan.count - i, item.stackSize ?? 64)
    const slot = b.inventory.firstEmptySlot('items')
    if (slot === null || slot === undefined) throw new Error('背包满了，腾个位置再拿')
    await b.creative.setInventorySlot(slot, item.id, chunk)
  }
  const after = invCount(b, plan.name)
  if (after <= before) throw new Error('创造模式塞物品没生效（背包没变化）')
  return after - before
}

/**
 * 执行（**可恢复的状态机**）。每次被队列调用时推进到下一个"要等别人"的点。
 *
 * `ctx` = { signal, movements, job, board, log }
 * 需要移动时：`board.yieldFor(job, {kind:'navi', …})` 然后 `return { yielded: true }`。
 */
export async function runCollect (self, plan, ctx = {}) {
  const { signal = null, movements = null, job = null, board = null, log = () => {} } = ctx
  const b = self?.bot
  if (!b?.entity) throw new Error('执行时已经掉线了')
  if (!plan?.ok) throw new Error(plan?.why ?? '规划失败')
  const t0 = Number(job?.startedAt ?? Date.now())

  /* 创造模式：一把干完 */
  if (plan.creative) {
    const got = await runCreative(b, plan)
    return { ok: true, collected: got, name: plan.name, ms: Date.now() - t0, via: 'give', text: `✅ 创造模式直接拿到 ${plan.name} ×${got}` }
  }

  const st = job
    ? (job.state ??= { phase: 'find', got: 0, target: null, before: 0, tries: 0 })
    : { phase: 'find', got: 0, target: null, before: 0, tries: 0 }
  const steps = (st.steps ??= [])
  const fail = (why) => ({ ok: false, collected: st.got, name: plan.name, ms: Date.now() - t0, steps, why, text: `❌ 收集 ${plan.name} 失败：${why}` })
  const done = () => ({
    ok: true, collected: st.got, name: plan.name, ms: Date.now() - t0, steps,
    text: `✅ 收集到 ${plan.name} ×${st.got}（${((Date.now() - t0) / 1000).toFixed(1)} 秒，${steps.length} 步）`,
  })

  for (let guard = 0; guard < 64; guard++) {
    if (signal?.aborted) throw new Error('被取消')

    if (st.phase === 'find') {
      if (st.got >= plan.count) return done()
      const targets = findTargets(b, plan.block, plan.radius, 1)
      if (!targets.length) return fail(`附近 ${plan.radius} 格内没有 ${plan.block}`)
      st.target = targets[0]
      st.phase = 'approach'
      log(`目标 ${plan.block} @ ${st.target.x},${st.target.y},${st.target.z}（${st.target.d.toFixed(1)} 格）`)
      continue
    }

    if (st.phase === 'approach') {
      const t = st.target
      if (!t) { st.phase = 'find'; continue }
      const me = b.entity.position
      const d = Math.hypot(me.x - (t.x + 0.5), me.y - t.y, me.z - (t.z + 0.5))
      if (d <= plan.reach) { st.phase = 'dig'; continue }
      /* 距离不够 → 把 navi 插到自己前面，自己挂起 */
      if (!board || !job) return fail('内部错误：没有队列上下文，无法插入导航任务')
      const navPlan = buildNaviPlan(self, { x: t.x, y: t.y, z: t.z, radius: COLLECT_RADIUS })
      if (!navPlan.ok) return fail(`走到目标失败：${navPlan.why}`)
      const inserted = board.yieldFor(job, {
        kind: 'navi',
        agentId: job.agentId,
        summary: `collect: 前往 ${t.x},${t.y},${t.z}`,
        plan: navPlan,
        run: (sig) => runNavi(self, navPlan, { signal: sig, movements }),
      })
      if (!inserted) return fail('插入导航任务失败（队列状态不对）')
      steps.push(`插入导航 → ${t.x},${t.y},${t.z}（${d.toFixed(1)} 格）`)
      return { yielded: true, text: `⏸ 距离 ${d.toFixed(1)} 格，已插入 navi，collect 挂起等待` }
    }

    if (st.phase === 'dig') {
      const t = st.target
      const blk = t ? b.blockAt(new Vec3(t.x, t.y, t.z)) : null
      if (!blk || isAir(blk.name) || blk.name !== plan.block) {
        st.phase = 'find'
        continue
      }
      if (typeof b.canDigBlock === 'function' && !b.canDigBlock(blk)) {
        st.tries += 1
        if (st.tries >= 3) return fail(`挖不动 ${plan.block}（够不着或没有合适的工具）`)
        st.phase = 'approach'
        continue
      }
      st.before = invCount(b, plan.name)
      try {
        await b.dig(blk)
      } catch (e) {
        st.tries += 1
        if (st.tries >= 3) return fail(`挖 ${plan.block} 出错：${e.message}`)
        st.phase = 'find'
        continue
      }
      steps.push(`挖掉 ${plan.block}`)
      st.phase = 'verify'
      continue
    }

    if (st.phase === 'verify') {
      let after = st.before
      const deadline = Date.now() + PICKUP_WAIT_MS
      while (Date.now() < deadline) {
        await sleep(200)
        after = invCount(b, plan.name)
        if (after > st.before) break
      }
      if (after > st.before) {
        st.got += after - st.before
        steps.push(`背包 +${after - st.before}`)
        st.phase = 'find'
        st.tries = 0
        continue
      }
      st.phase = 'pickup'
      continue
    }

    if (st.phase === 'pickup') {
      st.pickupTries = (st.pickupTries ?? 0) + 1
      if (st.pickupTries > 2) return fail('挖掉了但一直捡不到（已试着去捡 2 次）')
      const t = st.target
      const drops = dropsNear(b, { x: t.x + 0.5, y: t.y + 0.5, z: t.z + 0.5 }, 6)
      if (!drops.length) return fail('挖掉了，但附近没看到掉落物实体（被捡走/掉进岩浆/没生成）')
      const drop = drops[0]
      if (!board || !job) return fail('内部错误：没有队列上下文，无法插入捡取任务')
      const navPlan = buildNaviPlan(self, { x: Math.floor(drop.x), y: Math.floor(drop.y), z: Math.floor(drop.z), radius: COLLECT_RADIUS })
      if (!navPlan.ok) return fail(`去捡掉落物失败：${navPlan.why}`)
      const inserted = board.yieldFor(job, {
        kind: 'navi',
        agentId: job.agentId,
        summary: `collect: 去捡掉落物 ${Math.floor(drop.x)},${Math.floor(drop.y)},${Math.floor(drop.z)}`,
        plan: navPlan,
        run: (sig) => runNavi(self, navPlan, { signal: sig, movements }),
      })
      if (!inserted) return fail('插入捡取任务失败（队列状态不对）')
      steps.push('插入导航去捡掉落物')
      st.phase = 'verify'
      st.before = invCount(b, plan.name)
      return { yielded: true, text: '⏸ 已插入 navi 去捡掉落物，collect 挂起等待' }
    }

    return fail(`未知阶段 ${st.phase}`)
  }
  return fail('推进次数超限（可能卡在某个阶段）')
}
