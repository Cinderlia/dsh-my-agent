import Vec3 from 'vec3'
/* interact —— 通用交互（上船/锄地/播种/繁殖/剪羊毛/挤奶/开关门）
 * 统一骨架：找目标 → 走过去 → 换上该用的东西 → 右键 → 回报。
 */
const BREED_FOOD = {
  cow: ['wheat'], sheep: ['wheat'], goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds'],
  rabbit: ['carrot', 'golden_carrot', 'dandelion'],
  horse: ['golden_apple', 'golden_carrot', 'apple'],
  llama: ['wheat'], panda: ['bamboo'],
}
const VEHICLE_RE = /(boat|raft|minecart|horse|donkey|mule|skeleton_horse|zombie_horse|pig|strider|camel|llama)/i
const SHEARABLE_RE = /(sheep|mooshroom)/i
const MILKABLE_RE = /(cow|mooshroom|goat)/i
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

export function findItem (b, patterns) {
  const list = Array.isArray(patterns) ? patterns : [patterns]
  const items = []
  try { for (const it of b.inventory.items()) items.push(it) } catch { return null }
  for (const p of list) {
    const re = p instanceof RegExp ? p : new RegExp(String(p))
    const hit = items.find((it) => re.test(it.name))
    if (hit) return hit
  }
  return null
}

export function nearestEntity (b, re, maxDist = 16) {
  let best = null, bestD = Infinity
  for (const e of Object.values(b.entities ?? {})) {
    if (!e?.position || e === b.entity) continue
    if (!re.test(String(e.name ?? ''))) continue
    const d = b.entity.position.distanceTo(e.position)
    if (d <= maxDist && d < bestD) { bestD = d; best = e }
  }
  return best ? { ent: best, dist: bestD } : null
}

async function approach (b, pos, { range = 2.5, timeoutMs = 12_000 } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const d = b.entity.position.distanceTo(pos)
    if (d <= range) return { ok: true, dist: d }
    if (!b.pathfinder) break
    try {
      const goals = require('mineflayer-pathfinder').goals
      b.pathfinder.setGoal(new goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), Math.max(1, Math.floor(range))))
    } catch { break }
    await sleep(250)
  }
  try { b.pathfinder?.setGoal(null) } catch { /* ignore */ }
  const d = b.entity.position.distanceTo(pos)
  return { ok: d <= range + 1.5, dist: d }
}

async function pickBlockNear (b, req, re, radius) {
  if (Number.isFinite(Number(req.x)) && Number.isFinite(Number(req.y)) && Number.isFinite(Number(req.z))) {
    const blk = b.blockAt(new Vec3(Number(req.x), Number(req.y), Number(req.z)))
    return blk ? { blk } : null
  }
  try {
    const ids = Object.keys(b.registry?.blocksByName ?? {})
      .filter((n) => re.test(n)).map((n) => b.registry.blocksByName[n].id)
    if (!ids.length) return null
    const p = b.findBlock({ matching: ids, maxDistance: radius })
    if (!p) return null
    const blk = b.blockAt(p)
    return blk ? { blk } : null
  } catch { return null }
}

export async function runInteract (self, req = {}) {
  const b = self?.bot
  if (!b?.entity) return { ok: false, text: '❌ 还没进服' }
  const action = String(req.action ?? 'use').toLowerCase()
  const itemName = req.item ? String(req.item).toLowerCase() : null
  const equipIf = async (patterns) => {
    const it = itemName
      ? (b.inventory.items().find((x) => x.name === itemName) ?? null)
      : findItem(b, patterns)
    if (!it) return { ok: false, why: `背包里没有 ${itemName ?? patterns}` }
    if (b.heldItem?.type !== it.type) await b.equip(it, 'hand')
    return { ok: true, name: it.name }
  }

  switch (action) {
    case 'board': {
      const want = req.who ? String(req.who) : null
      const re = want ? new RegExp(want, 'i') : VEHICLE_RE
      const near = nearestEntity(b, re, 16)
      if (!near) return { ok: false, text: `❌ 16 格内没看到${want ? ` ${want}` : '能上的载具（船/矿车/马/猪）'}` }
      const ap = await approach(b, near.ent.position, { range: 2.5 })
      if (!ap.ok) return { ok: false, text: `❌ 走不到 ${near.ent.name} 旁边（还差 ${ap.dist.toFixed(1)} 格）` }
      try { await b.activateEntity(near.ent) } catch (e) { return { ok: false, text: `❌ 上 ${near.ent.name} 失败：${e.message}` } }
      await sleep(500)
      const veh = b.vehicle ?? b.entity?.vehicle
      return veh
        ? { ok: true, text: `🚢 上了 ${near.ent.name}（${ap.dist.toFixed(1)} 格远），现在骑着 ${veh.name ?? '载具'}` }
        : { ok: false, text: `⚠️ 右键了 ${near.ent.name}，但没坐上去（可能没鞍/被挡住/已经有人骑）` }
    }
    case 'dismount': {
      const veh = b.vehicle ?? b.entity?.vehicle
      if (!veh) return { ok: false, text: '❌ 现在没骑任何东西' }
      try { await b.dismount() } catch (e) { return { ok: false, text: `❌ 下不来：${e.message}` } }
      await sleep(400)
      return { ok: true, text: `🚶 从 ${veh.name ?? '载具'} 上下来了` }
    }
    case 'hoe': {
      const eq = await equipIf(/_hoe$/)
      if (!eq.ok) return { ok: false, text: `❌ ${eq.why}` }
      const target = await pickBlockNear(b, req, /^(grass_block|dirt|dirt_path|coarse_dirt|rooted_dirt)$/, 4)
      if (!target) return { ok: false, text: '❌ 附近 4 格内没有可锄的地（草方块/泥土）' }
      try { await b.activateBlock(target.blk) } catch (e) { return { ok: false, text: `❌ 锄地失败：${e.message}` } }
      await sleep(300)
      const now = b.blockAt(target.blk.position)
      return { ok: true, text: `🌱 锄了 ${target.blk.position.x},${target.blk.position.y},${target.blk.position.z}（现在是 ${now?.name ?? '?'}）` }
    }
    case 'plant': {
      const eq = await equipIf(/(_seeds$|carrot|potato|beetroot_seeds)$/)
      if (!eq.ok) return { ok: false, text: `❌ ${eq.why}` }
      const target = await pickBlockNear(b, req, /^farmland$/, 4)
      if (!target) return { ok: false, text: '❌ 附近 4 格内没有 farmland（先用 action:"hoe" 锄地）' }
      try { await b.activateBlock(target.blk) } catch (e) { return { ok: false, text: `❌ 播种失败：${e.message}` } }
      return { ok: true, text: `🌾 在 ${target.blk.position.x},${target.blk.position.y},${target.blk.position.z} 种下 ${eq.name}` }
    }
    case 'breed': {
      const kind = String(req.who ?? '').toLowerCase()
      const re = kind ? new RegExp(kind, 'i') : /(cow|sheep|pig|chicken|rabbit|horse|donkey|llama|goat|panda)/i
      const foods = (kind && BREED_FOOD[kind]) ? BREED_FOOD[kind] : /(wheat|carrot|potato|beetroot|seeds|apple|golden)/
      const eq = await equipIf(foods)
      if (!eq.ok) return { ok: false, text: `❌ ${eq.why}` }
      const list = Object.values(b.entities ?? {})
        .filter((e) => e?.position && e !== b.entity && re.test(String(e.name ?? '')))
        .map((e) => ({ e, d: b.entity.position.distanceTo(e.position) }))
        .filter((x) => x.d <= 16).sort((a, c) => a.d - c.d)
      if (list.length < 2) return { ok: false, text: `❌ 16 格内只找到 ${list.length} 只${kind || '可繁殖动物'}，繁殖要两只` }
      let fed = 0
      for (const { e } of list.slice(0, 2)) {
        const ap = await approach(b, e.position, { range: 2.5 })
        if (!ap.ok) continue
        try { await b.activateEntity(e); fed += 1 } catch { /* 换下一只 */ }
        await sleep(400)
      }
      return fed >= 2
        ? { ok: true, text: `🐮 喂了 ${list.slice(0, 2).map((x) => x.e.name).join(' 和 ')}（各一次，等它们冒爱心）` }
        : { ok: false, text: `⚠️ 只喂成功 ${fed}/2 只` }
    }
    case 'shear': {
      const eq = await equipIf(/shears/)
      if (!eq.ok) return { ok: false, text: `❌ ${eq.why}（剪羊毛要 shears）` }
      const near = nearestEntity(b, SHEARABLE_RE, 16)
      if (!near) return { ok: false, text: '❌ 16 格内没有羊/哞菇' }
      const ap = await approach(b, near.ent.position, { range: 2.5 })
      if (!ap.ok) return { ok: false, text: `❌ 走不到羊旁边（还差 ${ap.dist.toFixed(1)} 格）` }
      try { await b.activateEntity(near.ent) } catch (e) { return { ok: false, text: `❌ 剪毛失败：${e.message}` } }
      await sleep(400)
      return { ok: true, text: `🐑 剪了 ${near.ent.name} 的毛` }
    }
    case 'milk': {
      const eq = await equipIf(/^bucket$/)
      if (!eq.ok) return { ok: false, text: `❌ ${eq.why}（挤奶要空桶）` }
      const near = nearestEntity(b, MILKABLE_RE, 16)
      if (!near) return { ok: false, text: '❌ 16 格内没有牛/哞菇/山羊' }
      const ap = await approach(b, near.ent.position, { range: 2.5 })
      if (!ap.ok) return { ok: false, text: `❌ 走不到牛旁边（还差 ${ap.dist.toFixed(1)} 格）` }
      try { await b.activateEntity(near.ent) } catch (e) { return { ok: false, text: `❌ 挤奶失败：${e.message}` } }
      await sleep(400)
      return { ok: true, text: `🥛 挤了 ${near.ent.name} 的奶（背包里应该有 milk_bucket）` }
    }
    case 'open':
    case 'toggle': {
      const target = await pickBlockNear(b, req, /(door|fence_gate|trapdoor|button|lever|chest|barrel|crafting_table|furnace)/, 4)
      if (!target) return { ok: false, text: '❌ 4 格内没有可交互的方块（门/按钮/拉杆/箱子）' }
      try { await b.activateBlock(target.blk) } catch (e) { return { ok: false, text: `❌ 交互失败：${e.message}` } }
      return { ok: true, text: `🔘 点了 ${target.blk.name} @ ${target.blk.position.x},${target.blk.position.y},${target.blk.position.z}` }
    }
    case 'sleep':
    case 'wake':
      return { ok: false, text: `❌ 睡觉/起床请用 mc_act {mode:"${action}"}` }
    default:
      return { ok: false, text: `❌ 不认识的 action：${action}（可用：board/dismount/hoe/plant/breed/shear/milk/open/toggle）` }
  }
}
