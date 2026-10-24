/* ============================================================================
 * craft —— **合成状态机**（用户 2026-10-25：重头戏，超级复杂）
 * ----------------------------------------------------------------------------
 * 用户规则（逐条落地）：
 *   ① 参数只要"物品 + 数量"，**不让 LLM 自己判断背包**，它只提需求；
 *   ② 本地**直接算合成链**（复用 mc_craft 的 `planCraft`：递归配方 + 虚拟背包记账）；
 *   ③ 统计背包，缺料**自动插 collect**（不自己挖）；
 *   ④ 需要工作台时：
 *        · 16 格内有 → navi 过去；
 *        · 16 格内没有、背包里有 → 放到附近可放位置（没有就垫脚下）；
 *        · 背包里也没有 → **递归 craft 一个工作台**（缺木料再 collect）；
 *        · 两条都失败 → 报明确原因；
 *   ⑤ 合成完**回收自己放的工作台**（插 collect 挖回来）。
 *
 * 全部动作都走队列：`yieldFor`（自己挂起等子任务）而不是内部 await 调用 ——
 * 与 collect / navi 完全同一套机制。所以 `runCraft` 是**可恢复状态机**。
 * ========================================================================== */
import Vec3 from 'vec3'
import {
  planCraft, resolveItem, listTablesNearby, runPlan,
} from '../extensions/mc_craft.mjs'
import { planCollect, runCollect } from './collect.mjs'
import { buildNaviPlan, runNavi } from './navi.mjs'

/** 工作台查找半径（用户定的 16 格） */
export const TABLE_RADIUS = 16
/** 合成阶段一次最多干多久（留给队列呼吸） */
const CRAFT_SLICE_MS = 8_000

const clamp = (v, lo, hi, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : d
}

/** 解析"我要做什么"（只认物品名 + 数量；名字可以写简称） */
export function resolveCraftRequest (self, args = {}) {
  const b = self?.bot
  if (!b?.entity) return { ok: false, why: '还没进服（先 mc_connect）' }
  const name = String(args.name ?? args.item ?? '').trim()
  if (!name) return { ok: false, why: '要给要合成的物品名（如 oak_planks / stick / crafting_table）；不用先看背包，直接提需求' }
  const count = clamp(args.count ?? 1, 1, 64, 1)
  try {
    const { item, note } = resolveItem(b, name, null, count)
    return { ok: true, itemId: item.id, itemName: item.name, count, ...(note ? { note } : {}) }
  } catch (e) {
    return { ok: false, why: e?.message ?? String(e) }
  }
}

/** 背包里某物品有几个（按数字 id 数，多叠求和） */
const have = (b, id) => {
  let n = 0
  try {
    for (const it of b.inventory.items()) if (it.type === id) n += it.count
  } catch { /* 没背包 */ }
  return n
}

/**
 * 找一个"能放工作台"的位置（4 格内）：要空气、且相邻有实心方块可依附。
 * 找不到返回 null（调用方再试垫脚）。
 */
export function findPlaceSpot (b, radius = 4) {
  const me = b.entity?.position
  if (!me) return null
  const base = me.floored()
  const solid = (p) => {
    const blk = b.blockAt(p)
    return Boolean(blk) && blk.boundingBox === 'block'
  }
  const air = (p) => {
    const blk = b.blockAt(p)
    return Boolean(blk) && blk.name === 'air'
  }
  const cands = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = 0; dy <= 2; dy++) {
        const p = new Vec3(base.x + dx, base.y + dy, base.z + dz)
        if (!air(p)) continue
        let attached = false
        for (const [ox, oy, oz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
          if (solid(p.offset(ox, oy, oz))) { attached = true; break }
        }
        if (!attached) continue
        const d = Math.hypot(dx, dz)
        if (d > radius) continue
        cands.push({ x: p.x, y: p.y, z: p.z, d })
      }
    }
  }
  if (!cands.length) return null
  cands.sort((a, c) => a.d - c.d)
  return cands[0]
}

/**
 * 执行（**状态机**）。`ctx` = { signal, movements, job, board, log }
 */
export async function runCraft (self, req, ctx = {}) {
  const { signal = null, movements = null, job = null, board = null, log = () => {} } = ctx
  const b = self?.bot
  if (!b?.entity) throw new Error('执行时已经掉线了')
  if (!req?.ok) throw new Error(req?.why ?? '请求不合法')

  const t0 = Number(job?.startedAt ?? Date.now())
  const st = job
    ? (job.state ??= { phase: 'plan', table: null, placedTable: null, gathers: 0, misses: 0 })
    : { phase: 'plan', table: null, placedTable: null, gathers: 0, misses: 0 }
  const notes = (st.notes ??= [])

  const fail = (why) => ({
    ok: false, name: req.itemName, want: req.count, have: have(b, req.itemId),
    ms: Date.now() - t0, notes,
    text: `❌ 合成 ${req.itemName} ×${req.count} 失败：${why}`,
  })
  const done = () => ({
    ok: true, name: req.itemName, want: req.count, have: have(b, req.itemId),
    ms: Date.now() - t0, notes,
    text: `✅ 合成 ${req.itemName}：背包现在 ${have(b, req.itemId)} 个（要 ${req.count}）`
      + (notes.length ? '\n' + notes.join('\n') : ''),
  })

  for (let guard = 0; guard < 40; guard++) {
    if (signal?.aborted) throw new Error('被取消')

    /* ── ① 算链 ── */
    if (st.phase === 'plan') {
      const plan = planCraft(b, req.itemId, req.count, null)
      if (plan.ok) { st.phase = 'craft'; continue }
      const missing = plan.missing ?? []
      log('缺料：' + missing.map((m) => `${m.name}(要${m.need}有${m.have})`).join('、'))
      const tableMiss = missing.find((m) => m.name === 'crafting_table')
      const other = missing.find((m) => m.name !== 'crafting_table')
      if (other) {
        st.gather = { name: other.name, count: Math.max(1, Number(other.need) - Number(other.have)) }
        st.phase = 'gather'
        continue
      }
      if (tableMiss) { st.phase = 'table'; continue }
      return fail(`缺料但说不清缺什么（${missing.map((m) => m.name).join('、') || '空'}）`)
    }

    /* ── ② 缺普通材料 → 插 collect ── */
    if (st.phase === 'gather') {
      if (!board || !job) return fail('内部错误：没有队列上下文，无法插入收集任务')
      const plan = planCollect(self, st.gather)
      if (!plan.ok) return fail(`收集 ${st.gather.name} 失败：${plan.why}`)
      const inserted = board.yieldFor(job, {
        kind: 'collect', agentId: job.agentId,
        summary: `craft 缺料：收集 ${st.gather.name} ×${st.gather.count}`,
        plan,
        run: (sig, child) => runCollect(self, plan, { signal: sig, movements, job: child, board, log }),
      })
      if (!inserted) return fail('插入收集任务失败（队列状态不对）')
      st.gathers += 1
      notes.push(`插入 collect：${st.gather.name} ×${st.gather.count}`)
      st.phase = 'plan'
      return { yielded: true, text: `⏸ 缺 ${st.gather.name}，已插入收集任务，craft 挂起等待` }
    }

    /* ── ③ 工作台 ── */
    if (st.phase === 'table') {
      if (!board || !job) return fail('内部错误：没有队列上下文')
      const tables = listTablesNearby(b, TABLE_RADIUS, 5)
      if (tables.length) {
        const t = tables[0]
        const navPlan = buildNaviPlan(self, { x: t.x, y: t.y, z: t.z, radius: 16 })
        if (navPlan.ok) {
          const inserted = board.yieldFor(job, {
            kind: 'navi', agentId: job.agentId,
            summary: `craft 去工作台 ${t.x},${t.y},${t.z}`,
            plan: navPlan,
            run: (sig) => runNavi(self, navPlan, { signal: sig, movements }),
          })
          if (inserted) {
            st.table = { x: t.x, y: t.y, z: t.z }
            st.phase = 'craft'
            notes.push(`用附近的工作台 ${t.x},${t.y},${t.z}`)
            return { yielded: true, text: '⏸ 已插入导航（去工作台），craft 挂起' }
          }
        }
      }
      const tableId = b.registry?.itemsByName?.crafting_table?.id
      if (tableId != null && have(b, tableId) > 0) {
        const spot = findPlaceSpot(b, 4)
        if (spot) {
          try {
            await b.placeBlock({ x: spot.x, y: spot.y, z: spot.z, name: 'crafting_table' })
            st.placedTable = { x: spot.x, y: spot.y, z: spot.z }
            st.table = st.placedTable
            st.phase = 'craft'
            notes.push(`放了一个工作台 ${spot.x},${spot.y},${spot.z}（做完会回收）`)
            continue
          } catch (e) { log('放工作台失败：' + e.message) }
        }
        try {
          const me = b.entity.position.floored()
          const under = new Vec3(me.x, me.y - 1, me.z)
          await b.placeBlock({ x: under.x, y: under.y, z: under.z, name: 'crafting_table' })
          st.placedTable = { x: under.x, y: under.y, z: under.z }
          st.table = st.placedTable
          st.phase = 'craft'
          notes.push(`垫脚放了工作台 ${under.x},${under.y},${under.z}（做完会回收）`)
          continue
        } catch (e) { log('垫脚放工作台也失败：' + e.message) }
      }
      if (tableId == null) return fail('这个版本没有 crafting_table 物品（registry 里查不到）')
      const tableReq = { ok: true, itemId: tableId, itemName: 'crafting_table', count: 1 }
      const inserted = board.yieldFor(job, {
        kind: 'craft', agentId: job.agentId,
        summary: 'craft 缺工作台：先做一个工作台',
        plan: tableReq,
        run: (sig, child) => runCraft(self, tableReq, { signal: sig, movements, job: child, board, log }),
      })
      if (!inserted) return fail('插入"合成工作台"失败（队列状态不对）')
      st.misses += 1
      if (st.misses > 2) return fail('工作台：放了/做了两次还是用不了（可能被方块占住或合成窗口打不开）')
      notes.push('插入子任务：合成工作台')
      st.phase = 'table'
      return { yielded: true, text: '⏸ 没有可用工作台，已插入"合成工作台"，craft 挂起' }
    }

    /* ── ④ 执行合成（切片） ── */
    if (st.phase === 'craft') {
      /* 🔴 用工作台之前**复核它还在不在**：坐标可能来自过期扫描（方块被拆/没加载），
       *    直接拿去 activateBlock 会因为 block 是 undefined 崩在 mineflayer 里（实测）。 */
      /* 🔴 planCraft / runPlan 的 table 参数要的是**方块对象**（不是 {x,y,z}）——
       *    传坐标会在 mineflayer 的 craft 里 `block.position.offset` 崩掉（实测）。
       *    这里统一转成 block，并顺手复核它还在不在。 */
      let tableBlock = null
      if (st.table) {
        tableBlock = b.blockAt(new Vec3(st.table.x, st.table.y, st.table.z))
        if (!tableBlock || !String(tableBlock.name).includes('crafting_table')) {
          notes.push(`工作台 ${st.table.x},${st.table.y},${st.table.z} 不在了（${tableBlock?.name ?? '未加载'}），重新找`)
          st.table = null
          tableBlock = null
          st.phase = 'table'
          continue
        }
      }
      const plan = planCraft(b, req.itemId, req.count, tableBlock)
      if (!plan.ok) { st.phase = 'plan'; continue }
      try {
        /* runPlan 的第二个参数是**整个 plan 对象**（它自己读 plan.steps）——传 steps 会炸 */
        /* msLeftFn 要给**剩余毫秒**，给 0 会被当成"一点时间都没有"直接空转（实测） */
        await runPlan(b, plan, tableBlock, CRAFT_SLICE_MS, notes, () => CRAFT_SLICE_MS)
        const got = have(b, req.itemId)
        if (got >= req.count) { st.phase = 'cleanup'; continue }
        return {
          ok: false, partial: true, name: req.itemName, want: req.count, have: got,
          ms: Date.now() - t0, notes,
          text: `⏳ 合成进行中：${req.itemName} 现在 ${got}/${req.count}（这一轮的时间用完了，再叫一次接着做）`
            + (notes.length ? '\n' + notes.join('\n') : ''),
        }
      } catch (e) {
        return fail(`合成时出错：${e?.message ?? e}`)
      }
    }

    /* ── ⑤ 回收自己放的工作台 ── */
    if (st.phase === 'cleanup') {
      const spot = st.placedTable
      if (!spot) return done()
      const plan = planCollect(self, { name: 'crafting_table', count: 1 })
      if (!plan.ok) { notes.push('工作台回收跳过：' + plan.why); return done() }
      const inserted = board.yieldFor(job, {
        kind: 'collect', agentId: job.agentId,
        summary: `craft 回收工作台 ${spot.x},${spot.y},${spot.z}`,
        plan,
        run: (sig, child) => runCollect(self, plan, { signal: sig, movements, job: child, board, log }),
      })
      if (!inserted) { notes.push('工作台回收插入失败'); return done() }
      st.placedTable = null
      notes.push('插入子任务：回收工作台')
      st.phase = 'done'
      return { yielded: true, text: '⏸ 合成完成，已插入回收工作台，craft 挂起' }
    }

    if (st.phase === 'done') return done()
    return fail(`未知阶段 ${st.phase}`)
  }
  return fail('推进次数超限（可能卡住了）')
}

/** 一句话报告（工具返回用） */
export function craftRequestText (req) {
  if (!req?.ok) return `❌ ${req?.why ?? '请求不合法'}`
  return `🧱 合成 ${req.itemName} ×${req.count}`
    + (req.note ? `\n（${req.note}）` : '')
    + '\n▶ 已入队：会先算合成链，缺料自动收集、缺工作台自动找/放（做完回收）'
}
