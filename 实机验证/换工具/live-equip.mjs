/**
 * live-equip.mjs —— 「动手前自动换对的工具 + 如实报手上是什么」的实机验证
 *
 * 现场（用户 2026-10-07 转来游戏里 AI 的原话）："搭路以后 ai 不知道手里的东西是什么，
 * 刚刚它拿稿子搭完以后它不知道，在用泥土挖石头。" 玩家在游戏里那句更直接："怎么用手挖方块"。
 *
 * 离线回归是 `tools\check-core-equip.mjs`（43/0，假机器人）。这里验的是**真服上的真方块**：
 *   ① 空手 + 背包里没有镐 ⇒ 挖石头必须**直接拒绝**（不许白花一轮去硬挖），世界不许变；
 *   ② 老老实实备料：砍 3 根原木 → 工作台 → 木镐（真 recipes.json 走 mc_craft）；
 *   ③ 手上攥着泥土去挖石头 ⇒ **自动换成镐**、结果里带 `tool: dirtxN → wooden_pickaxex1` + `held` + `digMs`；
 *   ④ 工具对但这一轮挖不完 ⇒ 文案说"还没挖掉（手上是 X，这块要 N 秒）"，**不许赖"服务端拒绝"**；
 *   ⑤ `placeBlock` 结果里带 `held`；
 *   ⑥ 收尾：把挖掉的格子填回去（石头变回 cobblestone、土填回坑），报净变化。
 *
 * 用法：node live-equip.mjs
 * 产物：同目录 live-equip.log
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const HOST = '127.0.0.1'
const PORT = 25565
const NAME = 'wcequip_live'
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/换工具'

const req = createRequire('file:///C:/Users/BLUE/.dsh/profiles/desktop/node_modules/mineflayer/index.js')
const Vec3 = req('vec3')
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const craftExt = await import('file:///' + PKG + '/extensions/mc_craft.mjs')

const LOGFILE = join(OUT, 'live-equip.log')
try { writeFileSync(LOGFILE, '') } catch { /* 忽略 */ }
const log = (...a) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(s)
  try { appendFileSync(LOGFILE, s + '\n') } catch { /* 忽略 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const at = (b, x, y, z) => b.blockAt(new Vec3(x, y, z))
const nameAt = (b, x, y, z) => { try { return at(b, x, y, z)?.name ?? null } catch { return null } }
const cell = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
const heldOf = (b) => (b.heldItem ? `${b.heldItem.name}x${b.heldItem.count}` : '空手')
const countOf = (b, n) => b.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0)

let pass = 0, fail = 0, skipped = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const skip = (why) => { skipped++; log(`  ⏭ ${why}（跳过，不算失败）`) }
const section = (t) => log(`\n${t}`)

/* ───────────────── 假宿主：只挂 mc_craft ───────────────── */
const registered = new Map()
const sessions = new Map()
await craftExt.apply({
  ctx: {
    tools: { register: (d) => registered.set(d.name, d), guard: () => {}, get: () => undefined },
    on: () => () => {},
    get: () => undefined,
    logger: { info: () => {}, warn: (m) => log('[craft warn]', String(m)) },
  },
  config: {},
  registry: { peek: (id) => sessions.get(String(id)), listSessions: () => [...sessions.values()] },
  asTool: (s) => s,
  getSession: (exec) => sessions.get(String(exec?.agent?.id)),
  memory: {}, memoryFor: () => ({}), workspaceOf: () => null,
  logLine: (l) => log('[craft]', String(l)),
  ensureWatchdog: () => {},
  Watchdog: class {},
})
const craftTool = registered.get('mc_craft')
const EXEC = { agent: { id: 'live' } }

/* ───────────────── 连服 ───────────────── */
const mc = new McBot({
  instanceId: 'live-equip',
  lockDir: mkdtempSync(join(tmpdir(), 'wc-equip-')),
  logFile: join(OUT, 'live-equip-core.log'),
})
const call = async (ms, fn) => { mc.setCallDeadline(ms); return fn() }
const craft = async (args) => {
  mc.setCallDeadline(10_000)
  const r = await craftTool.execute(args, EXEC)
  return String(r?.text ?? JSON.stringify(r))
}
const digFor = async (name, want, maxDistance, tries) => {
  for (let i = 0; i < tries; i++) {
    if (countOf(mc.requireBot(), name) >= want) return true
    mc.setCallDeadline(10_000)
    const r = await mc.dig({ name, count: want, maxDistance }).catch((e) => [`❌ ${e?.message}`])
    log(`    mc_dig ${name}（第 ${i + 1} 次）：${(Array.isArray(r) ? r : [String(r)]).join(' ｜ ')}`)
    if (countOf(mc.requireBot(), name) >= want) return true
  }
  return countOf(mc.requireBot(), name) >= want
}

const dug = []          // 我挖掉的格子（用于收尾填回）
const remember = (p, nm) => { const c = { ...cell(p), was: nm }; if (!dug.some((d) => d.x === c.x && d.y === c.y && d.z === c.z)) dug.push(c) }

/** 走到 (x,y,z) 附近（多叫几次 walkTo，每次 7 秒；远距离靠它磨） */
const goNear = async (x, y, z, within = 4, tries = 8) => {
  for (let i = 0; i < tries; i++) {
    const me = mc.requireBot().entity.position
    if (me.distanceTo(new Vec3(x + 0.5, y + 0.5, z + 0.5)) <= within) return true
    await call(9_000, () => mc.walkTo({ x: x + 0.5, y: y + 1, z: z + 0.5 }, { budget: 7_000 })).catch(() => {})
  }
  return mc.requireBot().entity.position.distanceTo(new Vec3(x + 0.5, y + 0.5, z + 0.5)) <= within
}

/** 在附近找一列"地表往下第一块需要工具的方块最好是 stone"的柱子（木镐挖得动 stone、挖不动铜/铁矿） */
const findColumn = (b, maxR = 5) => {
  const me = cell(b.entity.position)
  const ring = []
  for (let dx = -maxR; dx <= maxR; dx++) for (let dz = -maxR; dz <= maxR; dz++) if (dx || dz) ring.push([dx, dz])
  ring.sort((p, q) => (p[0] ** 2 + p[1] ** 2) - (q[0] ** 2 + q[1] ** 2))
  let col = null
  for (const [dx, dz] of ring) {
    const x = me.x + dx, z = me.z + dz
    let top = null
    for (let y = me.y + 2; y >= me.y - 5; y--) { const nm = nameAt(b, x, y, z); if (nm && nm !== 'air') { top = y; break } }
    if (top == null) continue
    for (let y = top; y >= top - 14; y--) {
      const nm = nameAt(b, x, y, z)
      if (!nm || nm === 'air') break
      const blk = at(b, x, y, z)
      const tool = Boolean(blk?.harvestTools && Object.keys(blk.harvestTools).length)
      if (!tool) continue
      if (nm === 'stone') return { x, z, top, firstY: y, first: nm }
      if (!col) col = { x, z, top, firstY: y, first: nm }
    }
  }
  return col
}

/** 走到柱子上、往下挖到石头为止，返回那块石头的坐标（挖掉的格子都 remember 了） */
const mineDownToStone = async (label) => {
  const b = mc.requireBot()
  const col = findColumn(b, 5)
  if (!col) { log(`  ${label}：附近 5 格内没有"往下是石头"的柱子`); return null }
  log(`  ${label}：柱子 (${col.x},*,${col.z}) 地表 y=${col.top}，往下第 ${col.top - col.firstY} 格是 ${col.first}（y=${col.firstY}）`)
  await call(9_000, () => mc.walkTo({ x: col.x + 0.5, y: col.top + 1, z: col.z + 0.5 }, { budget: 7_000 })).catch(() => {})
  for (let i = 0; i < 16; i++) {
    const me = cell(b.entity.position)
    const below = { x: me.x, y: me.y - 1, z: me.z }
    const nm = nameAt(b, below.x, below.y, below.z)
    if (nm === 'stone') { log(`  脚下 (${below.x},${below.y},${below.z}) 是 stone ⇒ 用它当目标`); return below }
    if (nm !== 'grass_block' && nm !== 'dirt') { log(`  脚下是 ${nm}（不是土/石头），停`); return null }
    const r = await call(8_000, () => mc.breakBlock(below).catch((e) => ({ err: e?.message })))
    log(`  breakBlock(${below.x},${below.y},${below.z})（${nm}）⇒ ${JSON.stringify(r)}`)
    if (r?.broken) remember(below, nm)
    await sleep(350)
  }
  return null
}

try {
  await mc.connect({ host: HOST, port: PORT, auth: { mode: 'offline', name: NAME } })
  sessions.set('live', { agentId: 'live', bot: mc })
  const b = mc.requireBot()
  log(`连上了：${NAME} @ ${JSON.stringify(cell(b.entity.position))} 手上=${heldOf(b)} 血=${b.health} 饥饿=${b.food}`)
  log(`起始背包：${mc.inventory().items.map((i) => `${i.name}x${i.count}`).join('、') || '（空）'}`)

  /* ─────────── ① 挑一列"往下就是石头"的柱子挖下去：空手 + 没镐 ⇒ 必须拒绝 ─────────── */
  section('① 空手 + 背包里没有镐 ⇒ 挖石头直接拒绝（不许白花一轮硬挖）')
  const reach = (p) => b.entity.position.distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)) <= 4.2
  const target = await mineDownToStone('① 找一列往下挖')
  if (!target) {
    skip('没能挖到够得着的石头 ⇒ 跳过①③④')
  } else {
    log(`  目标石头：(${target.x},${target.y},${target.z}) 手上=${heldOf(b)} 背包里有镐吗=${/pickaxe/.test(mc.inventory().items.map((i) => i.name).join(','))}`)
    const before = nameAt(b, target.x, target.y, target.z)
    let threw = null
    const r = await call(8_000, () => mc.breakBlock(target).catch((e) => { threw = e; return null }))
    log(`  breakBlock(石头) ⇒ ${threw ? `抛错：${threw.message}` : JSON.stringify(r)}`)
    ok(Boolean(threw), '没有镐时**直接拒绝**（抛错），不是硬挖到超时', threw ? threw.message.slice(0, 90) : '竟然没抛错')
    ok(/手上是/.test(threw?.message ?? ''), '拒绝文案里写清"手上是什么"', String(threw?.message).slice(0, 60))
    ok(/需要镐/.test(threw?.message ?? ''), '写清"挖它需要镐"（人话，不是 pickaxe）')
    ok(/硬挖会一直超时/.test(threw?.message ?? ''), '写清硬挖的后果')
    ok(/mc_craft/.test(threw?.message ?? ''), '给出路：先 mc_craft 一把')
    ok(nameAt(b, target.x, target.y, target.z) === before, '世界没变（石头还在）', String(nameAt(b, target.x, target.y, target.z)))
    ok(!r, '没有返回"挖掉了"')

    /* ─────────── ② 老老实实备料：3 根原木 → 工作台 + 木镐 ─────────── */
    section('② 备料：砍 3 根原木 → 工作台 → 木板/木棍 → 木镐（真配方；木镐 3 木板 + 2 木棍、工作台 4 木板 = 9 木板 ⇒ 要 3 根原木）')
    const wood = (b.findBlocks({ matching: (blk) => /_log$/.test(blk?.name ?? ''), maxDistance: 128, count: 1 })[0])
    const woodName = wood ? nameAt(b, wood.x, wood.y, wood.z) : null
    log(`  128 格内最近的原木：${wood ? `${woodName} @ (${wood.x},${wood.y},${wood.z}) d=${b.entity.position.distanceTo(new Vec3(wood.x + 0.5, wood.y + 0.5, wood.z + 0.5)).toFixed(1)}` : '（没有）'}`)
    if (!wood) {
      skip('128 格内没有原木 ⇒ 拿不到镐，跳过③④')
    } else {
      const gotLog = await digFor(woodName, 3, 128, 20)
      log(`  原木：${gotLog ? `拿到 ${countOf(b, woodName)} 根` : `只拿到 ${countOf(b, woodName)} 根`}`)
      if (countOf(b, woodName) < 2) {
        skip('原木没挖到（树被清过/走不过去），跳过③④')
      } else {
        const t0 = await craft({ name: 'crafting_table' })
        log(`  mc_craft crafting_table ⇒ ${t0.replace(/\n/g, ' | ')}`)
        const t1 = await craft({ name: 'wooden_pickaxe', placeTable: true })
        log(`  mc_craft wooden_pickaxe（placeTable）⇒ ${t1.replace(/\n/g, ' | ')}`)
        const hasPick = /pickaxe/.test(mc.inventory().items.map((i) => i.name).join(','))
        ok(hasPick, '背包里真的出现了木镐', mc.inventory().items.map((i) => `${i.name}x${i.count}`).join('、'))

        /* ─────────── ③ 攥着泥土去挖石头 ⇒ 自动换镐 ─────────── */
        section('③ 手上攥着泥土 + 背包里有镐 ⇒ 自动换成镐再挖，并报换了什么')
        if (!hasPick) {
          skip('没有镐，跳过③')
        } else {
          // 就在这儿往下挖到石头（砍完树已经跑到 100 多格外了，没必要走回原来的坑）
          const target3 = await mineDownToStone('③ 就地找一列往下挖')
          if (!target3) {
            skip('附近找不到够得着的石头，跳过③')
          } else {
          const before = nameAt(b, target3.x, target3.y, target3.z)
          // 把手上换成泥土（背包里应该有：刚才往下挖出来一堆）
          let dirtOk = countOf(b, 'dirt') > 0
          if (!dirtOk) {
            const g = b.findBlocks({ matching: (blk) => /^(grass_block|dirt)$/.test(blk?.name), maxDistance: 4, count: 1 })[0]
            if (g) {
              const nm = nameAt(b, g.x, g.y, g.z)
              const rr = await call(8_000, () => mc.breakBlock({ x: g.x, y: g.y, z: g.z }).catch((e) => ({ err: e?.message })))
              log(`    挖脚边 ${nm} @(${g.x},${g.y},${g.z}) ⇒ ${JSON.stringify(rr)}`)
              if (rr?.broken) remember({ x: g.x, y: g.y, z: g.z }, nm)
              dirtOk = countOf(b, 'dirt') > 0
            }
          }
          if (dirtOk) {
            const eq = await call(5_000, () => mc.equip({ name: 'dirt' }))
            log(`    mc_act equip dirt ⇒ ${JSON.stringify(eq)}`)
            ok(b.heldItem?.name === 'dirt', '手上现在是泥土', heldOf(b))
            await goNear(target3.x, target3.y, target3.z, 4, 4)
            const t0 = Date.now()
            const rr = await call(10_000, () => mc.breakBlock(target3).catch((e) => ({ err: e?.message })))
            log(`    breakBlock(石头 @${target3.x},${target3.y},${target3.z}) ⇒ ${JSON.stringify(rr)}（${Date.now() - t0}ms）`)
            ok(rr?.broken && rr.broken !== false, '石头真被挖掉了', String(rr?.now))
            ok(typeof rr?.tool === 'string' && /dirtx\d+/.test(rr.tool) && /pickaxe/.test(rr.tool), '结果里写明换了什么工具', String(rr?.tool))
            ok(/pickaxe/.test(String(rr?.held)), '结果里写明现在手上是镐', String(rr?.held))
            ok(Number.isFinite(rr?.digMs) && rr.digMs < 5_000, '结果里带 digMs（木镐挖石头 < 5 秒）', String(rr?.digMs))
            if (rr?.broken) remember(target3, before)
          } else {
            skip('挖不到土/背包里没有泥土，跳过③（自动换镐那条）')
          }
          }
        }

        /* ─────────── ④ 工具对但这一轮挖不完 ⇒ 别赖"服务端拒绝" ─────────── */
        section('④ 工具对、但这块这一轮挖不完 ⇒ 文案要说实话')
        if (hasPick) {
          // 找一块石头，给 400ms 预算（木镐挖石头 ~1.2 秒 ⇒ 必然没挖完）
          const me = cell(b.entity.position)
          let s2 = null
          for (let dy = -1; dy >= -3 && !s2; dy--) {
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              if (nameAt(b, me.x + dx, me.y + dy, me.z + dz) === 'stone') { s2 = { x: me.x + dx, y: me.y + dy, z: me.z + dz }; break }
            }
          }
          if (!s2) {
            skip('附近 3 格内找不到第二块石头，跳过④')
          } else {
            const r4 = await call(400, () => mc.breakBlock(s2).catch((e) => ({ err: e?.message, mcTimeout: e?.mcTimeout })))
            log(`    breakBlock(${s2.x},${s2.y},${s2.z}) 给 400ms ⇒ ${JSON.stringify(r4)}`)
            ok(r4?.broken === false, '如实报 broken=false', JSON.stringify(r4).slice(0, 80))
            ok(/还没挖掉/.test(r4?.note ?? ''), 'note 说"还没挖掉"', String(r4?.note).slice(0, 100))
            ok(!/服务端可能拒/.test(r4?.note ?? ''), '**不再**赖"服务端可能拒了这次破坏"', String(r4?.note).slice(0, 100))
            ok(nameAt(b, s2.x, s2.y, s2.z) === 'stone', '这块确实没被挖掉', String(nameAt(b, s2.x, s2.y, s2.z)))
          }
        }
      }
    }

    /* ─────────── ⑤ placeBlock 结果里带 held ─────────── */
    section('⑤ placeBlock 的结果里带 held（手上还剩几块）')
    /* 🔴 必须"挖完**立刻**放回去"：这个世界有别的东西在动（玩家 / 游戏里那个 AI 都在同一片地方挖挖补补），
     *    走开十几秒再回来，刚才挖的坑已经被填回 dirt 了 ⇒ 只会得到"已被 dirt 占住"。
     *    所以就在身旁那一格：挖 → 确认是 air → 马上放。 */
    let placed = null
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      if (countOf(b, 'dirt') < 1) break
      const me = cell(b.entity.position)
      const c = { x: me.x + dx, y: me.y, z: me.z + dz }
      const nm = nameAt(b, c.x, c.y, c.z)
      if (nm !== 'grass_block' && nm !== 'dirt') continue
      const rr = await call(8_000, () => mc.breakBlock(c).catch((e) => ({ err: e?.message })))
      log(`    ⑤ 挖身旁 ${nm} @(${c.x},${c.y},${c.z}) ⇒ ${JSON.stringify(rr)}`)
      if (!rr?.broken) continue
      remember(c, nm)
      await sleep(150)
      if (nameAt(b, c.x, c.y, c.z) !== 'air') { log('    （挖完 150ms 内就被填回去了 —— 这片地方有别的东西在动，换一格）'); continue }
      const before = countOf(b, 'dirt')
      const r5 = await call(8_000, () => mc.placeBlock({ x: c.x, y: c.y, z: c.z, name: 'dirt' }).catch((e) => ({ err: e?.message })))
      log(`    placeBlock dirt @(${c.x},${c.y},${c.z}) ⇒ ${JSON.stringify(r5)}`)
      if (r5?.placed) { placed = { r5, before }; break }
    }
    if (!placed) {
      skip('没能找到"挖完立刻能放回去"的格子（别的东西在动 / 没泥土），跳过⑤')
    } else {
      const { r5, before } = placed
      ok(typeof r5?.held === 'string' && /dirtx\d+/.test(r5.held), '结果里带 held（手上还剩几块泥土）', String(r5?.held))
      ok(countOf(b, 'dirt') === before - 1, '泥土真的少了一块（放下去了）', `${before} → ${countOf(b, 'dirt')}`)
    }
  }

  /* ─────────── ⑥ 收尾：把挖掉的格子填回去 ─────────── */
  section('⑥ 收尾：把挖掉的格子填回去')
  // 判据必须对**全部 dug** 求，不能只看"上一轮筛出来的那批"（那样断言恒真）
  const stateOf = (d) => nameAt(b, d.x, d.y, d.z)
  let holes = dug.filter((d) => stateOf(d) === 'air')
  const unknown = dug.filter((d) => stateOf(d) == null)
  log(`  挖过 ${dug.length} 格，现在状态：${dug.map((d) => `(${d.x},${d.y},${d.z})原${d.was}→${stateOf(d) ?? '(未加载)'}`).join(' ')}`)
  log(`  其中还空着 ${holes.length} 格${unknown.length ? `（另有 ${unknown.length} 格区块没加载、读不到）` : ''}`)
  const cobble = countOf(b, 'cobblestone')
  const dirtHave = countOf(b, 'dirt')
  log(`  手上备料：dirt=${dirtHave} cobblestone=${cobble}`)
  if (!holes.length) {
    log('  没有空着的格子')
  } else {
    for (const d of holes) {
      const want = /^(grass_block|dirt|sand|gravel|podzol|coarse_dirt|rooted_dirt|clay)$/.test(d.was)
        ? (countOf(b, 'dirt') > 0 ? 'dirt' : null)
        : (countOf(b, 'cobblestone') > 0 ? 'cobblestone' : null)
      if (!want) { log(`  ⏭ (${d.x},${d.y},${d.z})（原 ${d.was}）没有能填的方块了 —— **这一格还空着**`); continue }
      const stand = { x: d.x + 2.5, y: d.y + 1, z: d.z + 0.5 }
      await goNear(stand.x, stand.y, stand.z, 3.5, 8)
      const rr = await call(8_000, () => mc.placeBlock({ x: d.x, y: d.y, z: d.z, name: want }).catch((e) => ({ err: e?.message })))
      log(`    填回 (${d.x},${d.y},${d.z})（原 ${d.was}）用 ${want} ⇒ ${JSON.stringify(rr)}`)
    }
    holes = dug.filter((d) => stateOf(d) === 'air')
    ok(holes.length === 0, '挖掉的格子都填回去了（对全部 dug 求）', holes.length ? `还空着 ${holes.length} 格：${holes.map((d) => `(${d.x},${d.y},${d.z})`).join(' ')}` : `${dug.length} 格都不是 air`)
  }
  const inv = mc.inventory()
  log(`  最终背包：${inv.items.map((i) => `${i.name}x${i.count}`).join('、') || '（空）'}｜手上=${inv.held}`)
  log(`  世界改动：${dug.length} 格被动过（${dug.map((d) => `${d.was}@(${d.x},${d.y},${d.z})`).join(' ')}）`)
  try { await mc.disconnect('实机验证结束') } catch { /* 忽略 */ }
} catch (e) {
  log('❌ 脚本异常：', e?.stack ?? e)
  fail++
} finally {
  log(`\n结果：pass=${pass} fail=${fail}（跳过 ${skipped}）`)
  process.exit(fail === 0 ? 0 : 1)
}
