/* ============================================================================
 * implicit —— **隐式工具**（用户 2026-10-24：正常不暴露给 agent，走统一路由）
 * ----------------------------------------------------------------------------
 * 与"工具"（mc_navi / mc_collect…）的区别：agent **看不到也调不到**它们，
 * 它们只由别的任务在队列里插入使用（`board.yieldFor` / `handOff`）。
 *
 * 分类（用户要求"最好分类一下"）：
 *   · storage  —— 开箱取物（箱子 / 木桶 / 熔炉 / 漏斗 / 发射器 / 潜影盒）
 *   · combat   —— 打生物收集掉落物（进战斗前先 navi 到跟前）
 *   · craft    —— 制作（**占位**，还没实现）
 *
 * 每个隐式工具都导出 `implicitJob(self, name, opts)` → 一个可直接塞给
 * `JobBoard.yieldFor()` 的任务规格 `{kind, summary, plan, run}`。
 *
 * ⚠️ 叶子任务内部用**同步** pathfinder 走短距离（4.5 格内），不再往队列里插 navi ——
 *    否则会出现"任务-子任务-孙任务"三层排队，收益为零。
 * ========================================================================== */
import Vec3 from 'vec3'
import { isAir } from './block-names.mjs'

/** 容器方块（有物品格、能开的那种） */
export const CONTAINER_BLOCKS = [
  'chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker',
  'dispenser', 'dropper', 'hopper', 'shulker_box',
]
/** 交互距离：专家用户定的 4.5 格 */
export const CONTAINER_REACH = 4.5

/** 分类表（给路由/文档用） */
export const IMPLICIT_CATEGORIES = {
  storage: ['open_container'],
  combat: ['attack_mob'],
  craft: ['craft'],
}

/** 全部隐式工具名 */
export function implicitNames () {
  return Object.values(IMPLICIT_CATEGORIES).flat()
}

/** 这个生物会掉什么（用于"collect 的目标来自生物"时反查） */
export const MOB_DROPS = {
  cow: ['leather', 'beef'],
  pig: ['porkchop'],
  chicken: ['feather', 'chicken'],
  sheep: ['wool', 'mutton'],
  rabbit: ['rabbit_hide', 'rabbit', 'rabbit_foot'],
  horse: ['leather'],
  donkey: ['leather'],
  mule: ['leather'],
  llama: ['leather'],
  wolf: ['leather'],
  fox: ['leather'],
  skeleton: ['bone', 'arrow'],
  wither_skeleton: ['bone', 'coal'],
  zombie: ['zombie_flesh', 'iron_ingot', 'carrot', 'potato'],
  husk: ['zombie_flesh'],
  drowned: ['zombie_flesh', 'copper_ingot'],
  creeper: ['gunpowder'],
  spider: ['spider_eye', 'string'],
  cave_spider: ['spider_eye', 'string'],
  enderman: ['ender_pearl'],
  slime: ['slime_ball'],
  magma_cube: ['magma_cream'],
  blaze: ['blaze_rod'],
  ghast: ['gunpowder', 'ghast_tear'],
  squid: ['ink_sac'],
  glow_squid: ['glow_ink_sac'],
  salmon: ['salmon'],
  cod: ['cod'],
  tropical_fish: ['tropical_fish'],
  pufferfish: ['pufferfish'],
  witch: ['glass_bottle', 'glowstone_dust', 'sugar', 'spider_eye'],
  guardian: ['prismarine_shard', 'prismarine_crystals'],
  elder_guardian: ['prismarine_shard', 'prismarine_crystals', 'wet_sponge'],
  phantom: ['phantom_membrane'],
  shulker: ['shulker_shell'],
  iron_golem: ['iron_ingot', 'poppy'],
  snow_golem: ['snowball'],
  bee: ['honeycomb'],
  turtle: ['seagrass', 'scute'],
  panda: ['bamboo'],
}

/** 目标物品 → 该打什么生物（反向索引；`wool`/`leather` 这类泛名要能对上） */
export function mobsForDrop (itemName) {
  const want = String(itemName ?? '').toLowerCase()
  if (!want) return []
  const out = []
  for (const [mob, drops] of Object.entries(MOB_DROPS)) {
    if (drops.some((d) => d === want || (want === 'wool' && d === 'wool') || d.startsWith(want))) out.push(mob)
  }
  return out
}

/** 附近的容器方块（按距离升序） */
export function findContainers (b, radius = CONTAINER_REACH) {
  if (!b?.entity?.position) return []
  const me = b.entity.position
  const found = []
  const R = Math.ceil(radius)
  const base = me.floored()
  for (let dx = -R; dx <= R; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -R; dz <= R; dz++) {
        const p = new Vec3(base.x + dx, base.y + dy, base.z + dz)
        const blk = b.blockAt(p)
        if (!blk || !CONTAINER_BLOCKS.includes(blk.name)) continue
        const d = Math.hypot(p.x + 0.5 - me.x, p.y + 0.5 - me.y, p.z + 0.5 - me.z)
        if (d > radius) continue
        found.push({ x: p.x, y: p.y, z: p.z, name: blk.name, d })
      }
    }
  }
  return found.sort((a, c) => a.d - c.d)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 走到某个坐标（短距离，同步等） */
async function walkNear (b, Goals, x, y, z, { timeoutMs = 20_000, range = 2 } = {}) {
  const pf = b.pathfinder
  if (!pf || !Goals?.GoalNear) return { ok: false, why: '没有 pathfinder' }
  try {
    await Promise.race([
      pf.goto(new Goals.GoalNear(new Vec3(x, y, z), range)),
      new Promise((_, rej) => setTimeout(() => { try { pf.stop?.() } catch {} ; rej(new Error('走过去超时')) }, timeoutMs)),
    ])
    return { ok: true }
  } catch (e) {
    return { ok: false, why: e.message }
  }
}

/**
 * **换武器**（用户：攻击前触发自动更换合适工具 —— 留个空接口，等下做）。
 * 现在只回报"没换"，调用方照常打。
 */
export async function prepareWeapon (self, target) {
  return { changed: false, note: '自动换武器还没实现（接口已留）', target: target?.name ?? null }
}

/* ── ① storage：开箱取物 ─────────────────────────────────────────────── */

async function runOpenContainer (self, plan, { signal = null, Goals = null, log = () => {} } = {}) {
  const b = self?.bot
  if (!b?.entity) throw new Error('掉线了')
  const { x, y, z, name } = plan.container
  const t0 = Date.now()
  const me = b.entity.position
  const dist = Math.hypot(me.x - (x + 0.5), me.y - (y + 0.5), me.z - (z + 0.5))
  if (dist > 4.5) {
    const w = await walkNear(b, Goals, x, y, z, { range: 2 })
    if (!w.ok) return { ok: false, text: `❌ 走不到 ${name}（${x},${y},${z}）：${w.why}` }
  }
  const blk = b.blockAt(new Vec3(x, y, z))
  if (!blk) return { ok: false, text: `❌ ${x},${y},${z} 那格没加载` }
  let win = null
  try {
    win = await b.openContainer(blk)
  } catch (e) {
    return { ok: false, text: `❌ 打不开 ${blk.name}（${x},${y},${z}）：${e.message}` }
  }
  const got = []
  try {
    /* 目标可以是**一组同族物品**（oak_log / cherry_log …），哪个有就拿哪个 */
    const wantNames = Array.isArray(plan.items) && plan.items.length ? plan.items : [plan.item]
    const wantIds = new Set(wantNames.map((n) => b.registry?.itemsByName?.[n]?.id).filter((v) => v != null))
    const stackMaxOf = (id) => b.registry?.items?.[id]?.stackSize ?? 64
    if (!wantIds.size) return { ok: false, text: `❌ 不认识的物品 ${wantNames.join('/')}` }
    let need = plan.count
    // 容器里的物品：按名字匹配（槽位里可能有多个同类）
    /* 🔴 用户 2026-10-25：「collect 从箱子里拿物品，不要小家子气，直接整组整组拿，
     *    优先拿不到堆叠上限的组，不够再拿满组。」 */
    const slots = win.slots ?? []
    const stackMax = item.stackSize ?? 64
    const groups = []
    for (const it of slots) {
      if (!it || !wantIds.has(it.type)) continue
      groups.push({ id: it.type, count: it.count, full: it.count >= stackMaxOf(it.type) })
    }
    // 先零头（不满一组），再满组
    groups.sort((a, c) => Number(a.full) - Number(c.full) || a.count - c.count)
    for (const g of groups) {
      if (need <= 0) break
      const take = Math.min(need, g.count)
      await win.withdraw(g.id, null, take)
      got.push(take)
      need -= take
    }
    await sleep(200)
    const total = got.reduce((a, c) => a + c, 0)
    return {
      ok: total > 0,
      took: total,
      ms: Date.now() - t0,
      via: 'container',
      text: total > 0
        ? `📦 从 ${blk.name}（${x},${y},${z}）取出 ${wantNames[0]} ×${total}`
        : `${blk.name}（${x},${y},${z}）里没有 ${wantNames.join('/')}`,
    }
  } catch (e) {
    return { ok: false, took: 0, text: `❌ 开箱取物失败：${e.message}` }
  } finally {
    try { win?.close?.() } catch { /* 已经关了 */ }
  }
}

/* ── ② combat：打生物（先 navi 到跟前） ───────────────────────────────── */

async function runAttackMob (self, plan, { signal = null, Goals = null, log = () => {} } = {}) {
  const b = self?.bot
  if (!b?.entity) throw new Error('掉线了')
  const mob = String(plan.mob ?? '')
  const t0 = Date.now()
  let killed = 0
  let rounds = 0
  while (killed < (plan.count ?? 1) && rounds < 12) {
    rounds++
    if (signal?.aborted) throw new Error('被取消')
    const ent = Object.values(b.entities ?? {}).find((e) => {
      if (!e?.position) return false
      const nm = String(e.name ?? '')
      return nm === mob && b.entity.position.distanceTo(e.position) <= 32
    })
    if (!ent) break
    const me = b.entity.position
    const d = me.distanceTo(ent.position)
    if (d > 3) {
      const w = await walkNear(b, Goals, ent.position.x, ent.position.y, ent.position.z, { range: 2, timeoutMs: 20_000 })
      if (!w.ok) log(`接近 ${mob} 失败：${w.why}`)
    }
    // 换武器（空接口）
    const w2 = await prepareWeapon(self, ent)
    if (w2?.note) log(w2.note)
    const hp0 = Number(ent.health ?? 20)
    try { b.attack(ent) } catch (e) { log('攻击出错：' + e.message) }
    // 等它死（最多 8 秒）
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      await sleep(150)
      const hp = Number(ent.health ?? 0)
      if (!ent.isValid || hp <= 0 || !b.entities?.[ent.id]) break
    }
    if (!ent.isValid || Number(ent.health ?? 0) <= 0) killed++
    else log(`打了一下 ${mob}（血 ${hp0} → ${ent.health ?? '?'}）`)
  }
  return {
    ok: killed > 0,
    killed,
    ms: Date.now() - t0,
    via: 'attack',
    text: killed > 0 ? `⚔ 打死了 ${killed} 只 ${mob}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）` : `❌ 没能打死 ${mob}（附近没有/打不动）`,
  }
}

/* ── ③ craft：占位 ───────────────────────────────────────────────────── */

async function runCraft (self, plan) {
  return { ok: false, text: `🧩 craft 还没实现（占位）：要制作 ${plan.name} ×${plan.count}` }
}

const RUNNERS = {
  open_container: runOpenContainer,
  attack_mob: runAttackMob,
  craft: runCraft,
}

/**
 * 造一个隐式任务的规格（可以直接 `board.yieldFor(job, spec)`）。
 * @param {Object} self
 * @param {'open_container'|'attack_mob'|'craft'} name
 * @param {Object} opts 该任务需要的参数
 * @param {Object} [ctx] { Goals } —— pathfinder 的 goals（由调用方递进来）
 */
export function implicitJob (self, name, opts = {}, ctx = {}) {
  const run = RUNNERS[name]
  if (!run) throw new Error(`未知的隐式工具 ${name}（可用：${Object.keys(RUNNERS).join(' / ')}）`)
  const summaryOf = {
    open_container: `开箱取 ${opts.item} ×${opts.count}（${opts.container?.x},${opts.container?.y},${opts.container?.z}）`,
    attack_mob: `打 ${opts.mob} ×${opts.count ?? 1}`,
    craft: `制作 ${opts.name} ×${opts.count}`,
  }
  return {
    kind: name,
    summary: summaryOf[name] ?? name,
    plan: opts,
    run: (signal) => run(self, opts, { signal, Goals: ctx.Goals ?? null, log: ctx.log ?? (() => {}) }),
  }
}

/** 给 mc_probe 用的隐式工具清单（分类展示） */
export function implicitCatalog () {
  return Object.entries(IMPLICIT_CATEGORIES).map(([cat, names]) => ({
    category: cat,
    tools: names.map((n) => ({ name: n, visible: false })),
  }))
}
