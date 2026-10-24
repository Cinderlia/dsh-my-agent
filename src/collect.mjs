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
import { findContainers, implicitJob, mobsForDrop, MOB_DROPS } from './implicit.mjs'

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
  const mobs = creative ? [] : mobsForDrop(name)
  if (!creative && !block && !mobs.length) {
    /* 用户 2026-10-24：合成品不是错误 —— 状态机插入一个 craft 任务、自己退队。 */
    return {
      ok: true,
      craft: true,
      name, count, mode, creative: false,
      radius: COLLECT_RADIUS, reach: DIG_REACH,
      why: `「${name}」是合成品/加工品，转交 craft`,
    }
  }
  /* 生物掉落：物品不是方块、但能由某个生物掉落 → 走 attack（不是"合成品"） */
  return {
    ok: true, craft: false, name, block: block ?? null, count, mode, creative,
    radius: COLLECT_RADIUS, reach: DIG_REACH,
    ...(mobs.length ? { mobs } : {}),
    strategy: creative ? 'give' : block ? 'dig' : mobs.length ? 'attack' : 'dig',
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

/**
 * 从 item 实体的 metadata 里读物品 id（读不到返回 null）。
 * mineflayer 把 slot 放在 metadata[8]（部分版本 7），形状可能是 `{itemId}` 或 `{itemId:{value}}`。
 */
function itemIdOfEntity (e) {
  const meta = e?.metadata
  if (!Array.isArray(meta)) return null
  for (const idx of [8, 7]) {
    const v = meta[idx]
    if (!v) continue
    const raw = (typeof v === 'object' && 'value' in v) ? v.value : v
    if (typeof raw === 'number') return raw
    if (raw && typeof raw === 'object') {
      const id = raw.itemId
      if (typeof id === 'number') return id
      if (id && typeof id === 'object' && typeof id.value === 'number') return id.value
    }
  }
  return null
}

/**
 * 附近掉落物实体（item），按距离升序。
 * **只挑目标物品**：能从 metadata 读到 itemId 的才严格比对；
 * 读不到（老版本/元数据没解析）才退回"有掉落物就算候选"，并标 `unknown:true`。
 */
function dropsNear (b, pos, r = 6, wantName = null) {
  const out = []
  for (const e of Object.values(b.entities ?? {})) {
    if (!e?.position) continue
    const nm = String(e.name ?? e.displayName ?? '')
    if (!/^(item|Item)$/.test(nm)) continue
    const d = Math.hypot(e.position.x - pos.x, e.position.y - pos.y, e.position.z - pos.z)
    if (d > r) continue
    const id = itemIdOfEntity(e)
    /* 🔴 只在**明确**不是目标物品时才跳过：用 registry 反查名字。
     *    反查不到（io 解析不出/版本差异）一律当候选 —— 宁可多跑一趟，
     *    也不能因为"读不准"把该捡的掉落物跳过（实测踩过：5 次挖完一次都没去捡）。 */
    let unknown = true
    if (id !== null) {
      const it = b.registry?.items?.[id] ?? null
      if (it?.name) {
        unknown = false
        if (wantName && it.name !== wantName) continue
      }
    }
    out.push({ x: e.position.x, y: e.position.y, z: e.position.z, d, itemId: id, unknown })
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

  /* ① 合成品 → 插 craft、自己退队（永远不再回来） */
  if (plan.craft) {
    if (!board || !job) throw new Error('内部错误：没有队列上下文，无法转交 craft')
    const ok = board.handOff(job, {
      kind: 'craft',
      agentId: job.agentId,
      summary: `制作 ${plan.name} ×${plan.count}`,
      plan: { name: plan.name, count: plan.count },
      run: async () => ({ ok: false, text: `craft 还没实现（占位）：要制作 ${plan.name} ×${plan.count}` }),
    })
    return { handedOff: ok, text: ok ? `🔀 已转交 craft（制作 ${plan.name} ×${plan.count}），collect 退队` : '转交 craft 失败' }
  }

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

  /* 🔴 用户 2026-10-24 定的失败条件**只有两种**：
   *    ① 一开始扫描就发现附近总量不够；
   *    ② 挖到最后（附近的目标全挖完了）发现还不够。
   *    掉落物被抢**不算失败** —— 继续挖下一个补上。 */
  if (st.phase === 'find' && !st.scanned) {
    st.scanned = true
    const all = findTargets(b, plan.block, plan.radius, 64)
    const loose = dropsNear(b, b.entity.position, plan.radius, plan.name).length
    st.available = all.length + loose
    if (st.available < plan.count) {
      return fail(`附近 ${plan.radius} 格内只有 ${st.available} 个 ${plan.block}（含地上的掉落物），要 ${plan.count} 个 —— 不开始挖`)
    }
    log(`附近可用 ${st.available} 个（方块 ${all.length} + 掉落物 ${loose}），要 ${plan.count} 个`)
  }

  for (let guard = 0; guard < 64; guard++) {
    if (signal?.aborted) throw new Error('被取消')

  /* ①·5 仓库优先（用户 2026-10-24）：先看 4.5 格内有没有箱子/木桶/熔炉，
   *      有就插 open_container 去拿；拿到够数就直接完成，不再去挖。 */
  if (st.phase === 'find' && !st.storageTried) {
    st.storageTried = true
    const boxes = findContainers(b, 4.5)
    if (boxes.length) {
      log(`4.5 格内发现 ${boxes.length} 个容器：${boxes.map((x) => x.name).join(',')}`)
      st.storageBoxes = boxes
      st.storageIdx = 0
      st.phase = 'storage'
      continue
    }
  }


    /* ② 开箱阶段：逐个容器插 open_container */
    if (st.phase === 'storage') {
      const boxes = st.storageBoxes ?? []
      const box = boxes[st.storageIdx]
      if (!box) {
        /* 箱子都翻完了，没拿到 → 回正常流程去挖/打 */
        st.phase = 'find'
        continue
      }
      const need = plan.count - st.got
      if (need <= 0) return done()
      if (!board || !job) return fail('内部错误：没有队列上下文，无法插入开箱任务')
      const inserted = board.yieldFor(job, implicitJob(self, 'open_container', {
        item: plan.name, count: need, container: { x: box.x, y: box.y, z: box.z, name: box.name },
      }, { Goals: self?._pf?.goals ?? self?._pf?.Goals ?? null, log }))
      if (!inserted) return fail('插入开箱任务失败（队列状态不对）')
      st.storageIdx = (st.storageIdx ?? 0) + 1
      steps.push(`插入开箱 ${box.name}（${box.x},${box.y},${box.z}）`)
      return { yielded: true, text: `⏸ 已插入开箱任务（${box.name}），collect 挂起等待` }
    }

    if (st.phase === 'find') {
      if (st.got >= plan.count) return done()
      /* 目标来自生物（bone/gunpowder/leather…）：插 attack，打完再回来捡 */
      if (!plan.block && plan.mobs?.length) {
          if (!board || !job) return fail('内部错误：没有队列上下文，无法插入攻击任务')
          const mob = plan.mobs.find((m) => Object.values(b.entities ?? {}).some((e) => String(e.name ?? '') === m))
          if (!mob) return fail(`附近没有会掉 ${plan.name} 的生物（找过：${plan.mobs.join('/')}）`)
          const need = plan.count - st.got
          const inserted = board.yieldFor(job, implicitJob(self, 'attack_mob', { mob, count: Math.min(need, 2) }, {
            Goals: self?._pf?.goals ?? self?._pf?.Goals ?? null, log,
          }))
          if (!inserted) return fail('插入攻击任务失败（队列状态不对）')
          steps.push(`插入攻击 ${mob}`)
          st.phase = 'verify'
          st.before = invCount(b, plan.name)
          return { yielded: true, text: `⏸ 已插入攻击任务（打 ${mob}），collect 挂起等待掉落` }
      }
      const targets = findTargets(b, plan.block, plan.radius, 1)
      if (!targets.length) {
        return fail(`附近的 ${plan.block} 都挖完了，只收到 ${st.got}/${plan.count}`)
      }
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
      if (st.pickupTries > 4) return fail('挖掉了但一直捡不到（已试着去捡 4 次）')
      const t = st.target
      const drops = dropsNear(b, { x: t.x + 0.5, y: t.y + 0.5, z: t.z + 0.5 }, 6, plan.name)
      if (!drops.length) {
        /* 掉落物没了（被抢/掉岩浆/没生成）：**不算失败** —— 回去挖下一个补上。
         * 只有"附近全挖完还不够"才失败（见上面 find 阶段）。 */
        st.lost = (st.lost ?? 0) + 1
        steps.push(`掉落物不见了（第 ${st.lost} 个，继续挖下一个）`)
        st.phase = 'find'
        continue
      }
      const drop = drops[0]
      if (drop.unknown) steps.push('掉落物读不到物品 id，按位置去捡（可能捡错）')
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
