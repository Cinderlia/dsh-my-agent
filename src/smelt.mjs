/* ============================================================================
 * smelt —— **熔炼状态机**（用户 2026-10-25）
 * ----------------------------------------------------------------------------
 * 规则：
 *   · 支持"自动冶炼"：放原矿 + 放够燃料 → 等它烧完 → 取出；
 *   · 燃料优先**煤炭**，其次木制品（会把原木拆成木板来烧）；复用 mc_furnace 的 `pickFuel`；
 *   · 缺原料 → 自动插 collect；缺熔炉 → 背包有就放，没有就 craft 一个；
 *   · 熔炉查找半径 16 格（和 craft 的工作台一致）。
 *
 * 和 craft 一样：**每个动作都是队列子任务**（find/navi/place/craft/collect），
 * 自己只做决策 + 状态推进。
 * ========================================================================== */
import Vec3 from 'vec3'
import {
  smeltInputsFor, pickFuel, findFurnaceBlock, furnaceInInventory, waitForOutput,
} from '../extensions/mc_furnace.mjs'
import { planCollect, runCollect } from './collect.mjs'
import { buildNaviPlan, runNavi } from './navi.mjs'
import { resolveCraftRequest, runCraft } from './craft.mjs'

/** 熔炉查找半径 */
export const FURNACE_RADIUS = 16
/** 一次最多烧几组（防呆） */
const MAX_BATCH = 64

/** 这个物品能不能靠熔炼得到（返回可用原料表） */
export function smeltablesFor (bot, name) {
  try { return smeltInputsFor(bot, name) ?? [] } catch { return [] }
}

/** 解析熔炼请求 */
export function resolveSmeltRequest (self, args = {}) {
  const b = self?.bot
  if (!b?.entity) return { ok: false, why: '还没进服（先 mc_connect）' }
  const name = String(args.name ?? args.item ?? '').trim().toLowerCase().replace(/^minecraft:/, '')
  if (!name) return { ok: false, why: '要给要熔炼出的物品名（如 iron_ingot / glass / charcoal）' }
  const count = Math.max(1, Math.min(Number(args.count ?? 1) || 1, MAX_BATCH))
  const inputs = smeltablesFor(b, name)
  if (!inputs.length) return { ok: false, why: `没有找到能烧出「${name}」的配方（smeltInputsFor 为空）` }
  const outId = b.registry?.itemsByName?.[name]?.id
  if (outId == null) return { ok: false, why: `不认识的物品 ${name}` }
  return { ok: true, itemName: name, itemId: outId, count, inputs }
}

/** 背包里某物品几个 */
const have = (b, id) => {
  let n = 0
  try { for (const it of b.inventory.items()) if (it.type === id) n += it.count } catch { /* 没背包 */ }
  return n
}

/** 走一小段（同步） */
async function walkNear (b, Goals, x, y, z, { timeoutMs = 20_000, range = 2.5 } = {}) {
  const pf = b.pathfinder
  if (!pf || !Goals?.GoalNear) return { ok: false, why: '没有 pathfinder' }
  try {
    await Promise.race([
      pf.goto(new Goals.GoalNear(new Vec3(x, y, z), range)),
      new Promise((_, rej) => setTimeout(() => { try { pf.stop?.() } catch {} ; rej(new Error('走过去超时')) }, timeoutMs)),
    ])
    return { ok: true }
  } catch (e) { return { ok: false, why: e.message } }
}

/** 放一个熔炉（4 格内找可依附空气格；不行垫脚下） */
export async function placeFurnaceNearby (self, st, notes = []) {
  const b = self?.bot
  if (!b?.entity) return { ok: false, text: '❌ 放熔炉：掉线了' }
  const air = (p) => { const blk = b.blockAt(p); return blk && blk.name === 'air' }
  const solid = (p) => { const blk = b.blockAt(p); return blk && blk.boundingBox === 'block' }
  const me = b.entity.position.floored()
  const cands = []
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (let dy = 0; dy <= 2; dy++) {
        const p = new Vec3(me.x + dx, me.y + dy, me.z + dz)
        if (!air(p)) continue
        let attached = false
        for (const [ox, oy, oz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
          if (solid(p.offset(ox, oy, oz))) { attached = true; break }
        }
        if (attached) cands.push({ x: p.x, y: p.y, z: p.z, d: Math.hypot(dx, dz) })
      }
    }
  }
  cands.sort((a, c) => a.d - c.d)
  const tryPlace = async (pos) => {
    await b.placeBlock({ x: pos.x, y: pos.y, z: pos.z, name: 'furnace' })
    st.furnace = { x: pos.x, y: pos.y, z: pos.z }
    st.placedFurnace = { ...st.furnace }
    notes.push(`放了熔炉 ${pos.x},${pos.y},${pos.z}（做完会回收）`)
    return { ok: true, text: `🧱 放好熔炉 ${pos.x},${pos.y},${pos.z}` }
  }
  for (const c of cands.slice(0, 3)) {
    try { return await tryPlace(c) } catch (e) { notes.push(`放到 ${c.x},${c.y},${c.z} 失败：${e.message}`) }
  }
  try {
    return await tryPlace({ x: me.x, y: me.y - 1, z: me.z })
  } catch (e) {
    return { ok: false, text: `❌ 放熔炉失败：${e.message}` }
  }
}

/**
 * 执行（**状态机**）。ctx = { signal, movements, job, board, log }
 */
export async function runSmelt (self, req, ctx = {}) {
  const { signal = null, movements = null, job = null, board = null, log = () => {} } = ctx
  const b = self?.bot
  if (!b?.entity) throw new Error('执行时已经掉线了')
  if (!req?.ok) throw new Error(req?.why ?? '请求不合法')

  const t0 = Number(job?.startedAt ?? Date.now())
  const st = job
    ? (job.state ??= { phase: 'find', furnace: null, placedFurnace: null, tries: 0 })
    : { phase: 'find', furnace: null, placedFurnace: null, tries: 0 }
  const notes = (st.notes ??= [])
  const Goals = self?._pf?.goals ?? self?._pf?.Goals ?? null

  const fail = (why) => ({
    ok: false, name: req.itemName, want: req.count, have: have(b, req.itemId), notes,
    ms: Date.now() - t0,
    text: `❌ 熔炼 ${req.itemName} ×${req.count} 失败：${why}`,
  })
  const done = () => ({
    ok: true, name: req.itemName, want: req.count, have: have(b, req.itemId), notes,
    ms: Date.now() - t0,
    text: `✅ 熔炼 ${req.itemName}：背包现在 ${have(b, req.itemId)} 个（要 ${req.count}）`
      + (notes.length ? '\n' + notes.join('\n') : ''),
  })

  for (let guard = 0; guard < 30; guard++) {
    if (signal?.aborted) throw new Error('被取消')

    /* ── ① 找熔炉（16 格内） ── */
    if (st.phase === 'find') {
      const f = findFurnaceBlock(b, { radius: FURNACE_RADIUS })
      if (f) {
        const me = b.entity.position
        const d = Math.hypot(me.x - (f.x + 0.5), me.y - f.y, me.z - (f.z + 0.5))
        if (d > 4.2) {
          if (!board || !job) return fail('内部错误：没有队列上下文')
          const navPlan = buildNaviPlan(self, { x: f.x, y: f.y, z: f.z, radius: FURNACE_RADIUS })
          if (!navPlan.ok) return fail(`去熔炉失败：${navPlan.why}`)
          const inserted = board.yieldFor(job, {
            kind: 'navi', agentId: job.agentId,
            summary: `smelt 去熔炉 ${f.x},${f.y},${f.z}`,
            plan: navPlan,
            run: (sig) => runNavi(self, navPlan, { signal: sig, movements }),
          })
          if (!inserted) return fail('插 navi 失败（队列状态不对）')
          st.furnace = { x: f.x, y: f.y, z: f.z }
          notes.push(`插 navi：去熔炉 ${f.x},${f.y},${f.z}（${d.toFixed(1)} 格）`)
          st.phase = 'load'
          return { yielded: true, text: '⏸ 熔炉够不着，已插 navi，smelt 挂起' }
        }
        st.furnace = { x: f.x, y: f.y, z: f.z }
        st.phase = 'load'
        continue
      }
      /* 没有熔炉：背包有 → 插 place；没有 → craft 一个 */
      if (!board || !job) return fail('内部错误：没有队列上下文')
      const inv = furnaceInInventory(b)
      if (inv) {
        const inserted = board.yieldFor(job, {
          kind: 'place_furnace', agentId: job.agentId,
          summary: 'smelt 放置熔炉',
          run: async () => placeFurnaceNearby(self, st, notes),
        })
        if (!inserted) return fail('插 place 失败（队列状态不对）')
        st.phase = 'load'
        return { yielded: true, text: '⏸ 背包有熔炉，已插 place，smelt 挂起' }
      }
      const craftReq = resolveCraftRequest(self, { name: 'furnace', count: 1 })
      if (!craftReq.ok) return fail(`需要熔炉但做不了：${craftReq.why}`)
      const inserted = board.yieldFor(job, {
        kind: 'craft', agentId: job.agentId,
        summary: 'smelt 缺熔炉：先做一个熔炉',
        plan: craftReq,
        run: (sig, child) => runCraft(self, craftReq, { signal: sig, movements, job: child, board, log }),
      })
      if (!inserted) return fail('插 craft 失败（队列状态不对）')
      st.tries += 1
      if (st.tries > 2) return fail('熔炉：做了两次还是找不到/用不了')
      notes.push('插 craft：做一个熔炉')
      st.phase = 'find'
      return { yielded: true, text: '⏸ 没有熔炉，已插 craft 做熔炉，smelt 挂起' }
    }

    /* ── ② 放原料 + 燃料 ── */
    if (st.phase === 'load') {
      const f = st.furnace
      const blk = f ? b.blockAt(new Vec3(f.x, f.y, f.z)) : null
      if (!blk || String(blk.name) !== 'furnace') {
        st.phase = 'find'
        continue
      }
      const need = req.count - have(b, req.itemId)
      if (need <= 0) { st.phase = 'take'; continue }
      /* 原料：逐个来源找背包里有哪种 */
      const src = req.inputs.find((n) => have(b, b.registry?.itemsByName?.[n]?.id) > 0)
      if (!src) {
        const inserted = board.yieldFor(job, {
          kind: 'collect', agentId: job.agentId,
          summary: `smelt 缺原料：收集 ${req.inputs[0]}`,
          plan: planCollect(self, { name: req.inputs[0], count: need }),
          run: (sig, child) => {
            const p = planCollect(self, { name: req.inputs[0], count: need })
            return p.ok ? runCollect(self, p, { signal: sig, movements, job: child, board, log }) : { ok: false, text: p.why }
          },
        })
        if (!inserted) return fail('插 collect 失败（队列状态不对）')
        notes.push(`插 collect：收 ${req.inputs[0]}`)
        return { yielded: true, text: `⏸ 缺原料 ${src ?? req.inputs[0]}，已插 collect，smelt 挂起` }
      }
      /* 燃料：煤炭优先，其次木制品 */
      const fuel = pickFuel(b, Math.min(need, 64), req.itemId)
      if (!fuel) {
        return fail('背包里没有可用燃料（需要煤/木炭/木头/木板/木棍）')
      }
      try {
        const win = await b.openContainer(blk)
        try {
          const srcId = b.registry?.itemsByName?.[src]?.id
          await win.deposit(srcId, null, Math.min(need, 64))
          await win.deposit(fuel.id, null, fuel.count)
          notes.push(`装料：${src} ×${Math.min(need, 64)} + 燃料 ${fuel.name} ×${fuel.count}`)
        } finally {
          try { win.close?.() } catch { /* 已关 */ }
        }
      } catch (e) {
        return fail(`装料失败：${e.message}`)
      }
      st.phase = 'wait'
      notes.push('等熔炉烧完')
      continue
    }

    /* ── ③ 等烧完 ── */
    if (st.phase === 'wait') {
      const f = st.furnace
      const blk = f ? b.blockAt(new Vec3(f.x, f.y, f.z)) : null
      if (!blk) { st.phase = 'find'; continue }
      await new Promise((r) => setTimeout(r, Math.min(4000, 800 + req.count * 1200)))
      st.phase = 'take'
      continue
    }

    /* ── ④ 取出成品 ── */
    if (st.phase === 'take') {
      const f = st.furnace
      const blk = f ? b.blockAt(new Vec3(f.x, f.y, f.z)) : null
      if (!blk) { st.phase = 'find'; continue }
      try {
        const win = await b.openContainer(blk)
        try {
          const before = have(b, req.itemId)
          await win.withdraw(req.itemId, null, Math.min(req.count - before, 64))
          await new Promise((r) => setTimeout(r, 300))
          const after = have(b, req.itemId)
          if (after > before) notes.push(`取出 ${req.itemName} ×${after - before}`)
        } finally {
          try { win.close?.() } catch { /* 已关 */ }
        }
      } catch (e) {
        notes.push('取成品失败：' + e.message)
      }
      if (have(b, req.itemId) >= req.count) { st.phase = 'cleanup'; continue }
      st.phase = 'load'   // 还没烧够，继续装料
      if ((st.rounds = (st.rounds ?? 0) + 1) > 6) return fail('反复装料 6 次还没烧够')
      continue
    }

    /* ── ⑤ 回收自己放的熔炉 ── */
    if (st.phase === 'cleanup') {
      const spot = st.placedFurnace
      if (!spot) return done()
      const plan = planCollect(self, { name: 'furnace', count: 1 })
      if (!plan.ok) { notes.push('熔炉回收跳过：' + plan.why); return done() }
      const inserted = board.yieldFor(job, {
        kind: 'collect', agentId: job.agentId,
        summary: `smelt 回收熔炉 ${spot.x},${spot.y},${spot.z}`,
        plan,
        run: (sig, child) => runCollect(self, plan, { signal: sig, movements, job: child, board, log }),
      })
      if (!inserted) { notes.push('熔炉回收插入失败'); return done() }
      st.placedFurnace = null
      notes.push('插 collect：回收熔炉')
      st.phase = 'done'
      return { yielded: true, text: '⏸ 熔炼完成，已插回收熔炉，smelt 挂起' }
    }

    if (st.phase === 'done') return done()
    return fail(`未知阶段 ${st.phase}`)
  }
  return fail('推进次数超限（可能卡住了）')
}
