/* 搭方块选料实机验证 —— 用户 2026-10-06 报的"它搭方块会用非实体方块搭"
 *
 * 验两件事（都在真服上、用真 registry、真背包）：
 *   ① `pickPlaceItem(bot, null)`：没指定方块时，挑出来的必须是**整方块**，不能是火把/树苗/门/半砖
 *   ② `scaffoldingItemIds(bot)`：交给 pathfinder 垫脚的那份名单里不能有非实体方块
 *   ③ 真调一次 `mc.placeBlock()`（不给 name），落下去的方块必须是整方块
 *
 * 安全约定：**只在一格本来就空的、贴着地面的位置上放一块，验完立刻挖回来** —— 净变化为零。
 *          基地范围（x 0..6 / z 3..9 / y 78..86）内一律不碰。
 * 用法：node live-place.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const core = await import('file:///' + PKG + '/src/core.mjs')
const { default: McBot, pickPlaceItem, scaffoldingItemIds, isFullBlockItem } = core
const craftExt = await import('file:///' + PKG + '/extensions/mc_craft.mjs')

const registered = new Map()
const sessions = new Map()
const mkApi = () => ({
  ctx: { tools: { register: (d) => registered.set(d.name, d), guard: () => {}, get: () => undefined }, on: () => () => {}, get: () => undefined, logger: { info: () => {}, warn: () => {} } },
  config: {},
  registry: { peek: (id) => sessions.get(String(id)), listSessions: () => [] },
  asTool: (s) => s,
  getSession: (e) => sessions.get(String(e?.agent?.id)),
  memory: {}, memoryFor: () => ({}), workspaceOf: () => null,
  logLine: (l) => console.log('[log]', l), Watchdog: class {}, ensureWatchdog: () => {},
})
await craftExt.apply(mkApi())
const cSpec = registered.get('mc_craft')

const mc = new McBot({ instanceId: 'live-place', lockDir: mkdtempSync(join(tmpdir(), 'live-place-')) })
sessions.set('A1', { agentId: 'A1', bot: mc })
const EXEC = { agent: { id: 'A1' } }
const craft = (a) => cSpec.execute(a, EXEC)

await mc.connect({ host: '127.0.0.1', port: 25565, auth: { mode: 'offline', name: 'mcfurnace_live' } })
await mc.waitForChunks(20_000)
const bot = mc.requireBot()
const reg = bot.registry

const bag = () => bot.inventory.items().map((i) => `${i.name}×${i.count}`).join(' ') || '（空）'
const say = (s) => console.log('\n=== ' + s + ' ===')
const firstLine = (t) => String(t).split('\n')[0]
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const vecAt = (x, y, z) => { const p = bot.entity.position.clone(); p.x = x; p.y = y; p.z = z; return bot.blockAt(p) }
const nameOf = (id) => reg.items[id]?.name ?? String(id)
const countOf = (n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0)
/** 是方块、但不是整方块（火把/半砖/门…）—— 这才是能验出"选错料"的东西 */
const isNonFullBlock = (n) => !!reg.blocksByName[n] && !isFullBlockItem(bot, n)
const hasFullBlock = () => bot.inventory.items().some((i) => isFullBlockItem(bot, i.name))
const hasNonFullBlock = () => bot.inventory.items().some((i) => isNonFullBlock(i.name))
/** 这个坐标在玩家基地里吗（一律不碰）—— 旧存档的基地框，外加"附近有建筑方块"兜底 */
const BUILT = /(_planks|_door|_trapdoor|_slab|_stairs|_fence|_wall|glass|wool|brick|concrete|terracotta|chest|barrel|furnace|crafting_table|torch|ladder|_sign|_bed|glass_pane)/
const inBase = (p) => (p.x >= -1 && p.x <= 7 && p.z >= 2 && p.z <= 10 && p.y >= 77 && p.y <= 87) || looksBuilt(p)
const looksBuilt = (p) => {
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
    const b = vecAt(p.x + dx, p.y + dy, p.z + dz)
    if (b && BUILT.test(b.name)) return true
  }
  return false
}

bot.on('message', (m) => { const s = m.toString().trim(); if (s) console.log('[chat]', s) })

say('连上了')
console.log('模式', bot.game.gameMode, '｜位置', JSON.stringify(bot.entity.position.floored()))
console.log('背包', bag())

/* ── A 备料：背包里要同时有「整方块」和「非实体方块」─────────────────── */
say('A1 保证背包里有一个**整方块**（placeBlock 要有东西可放）')
if (!hasFullBlock()) {
  console.log('  背包里没有整方块 —— 挖两块土（土不需要工具）')
  console.log('  ' + JSON.stringify(await mc.dig({ name: 'dirt', count: 2, maxDistance: 16 })))
} else {
  console.log('  已经有整方块了')
}
console.log('背包', bag())

say('A2 再弄一个**非实体方块**（火把最好；做不出来就退而做木半砖）')
if (!hasNonFullBlock()) {
  console.log('  试做火把：' + firstLine((await craft({ name: 'torch', count: 4 })).text))
  if (!hasNonFullBlock()) {
    // 2×2 背包里能做出来的非实体方块：按钮（1 木板）/ 压力板（2 木板）。
    // 半砖/门/栅栏都要 3 格宽 → 得先有工作台，这里不折腾。
    if (!bot.inventory.items().some((i) => /_planks$/.test(i.name))) {
      if (!bot.inventory.items().some((i) => /_log$/.test(i.name))) {
        console.log('  没木头，先挖原木：' + JSON.stringify(await mc.dig({ name: 'oak_log', count: 1, maxDistance: 32 })))
      }
      const log = bot.inventory.items().find((i) => /_log$/.test(i.name))
      if (log) console.log('  做木板：' + firstLine((await craft({ name: log.name.replace(/_log$/, '_planks') })).text))
    }
    const planks = bot.inventory.items().find((i) => /_planks$/.test(i.name))
    if (planks) {
      const wood = planks.name.replace(/_planks$/, '')
      for (const want of [wood + '_button', wood + '_pressure_plate']) {
        if (hasNonFullBlock()) break
        console.log(`  做 ${want}：` + firstLine((await craft({ name: want, count: 1 })).text))
      }
    }
  }
} else {
  console.log('  已经有非实体方块了')
}
console.log('背包', bag())
const nonFullNames = bot.inventory.items().filter((i) => isNonFullBlock(i.name)).map((i) => i.name)
ok(hasNonFullBlock(), '背包里有**非实体方块**（用来验选料会不会挑错）', nonFullNames.join('、') || '（没有）')
ok(hasFullBlock(), '背包里有**整方块**（用来真放一块）')

/* ── B 选料函数：不能挑到火把/半砖 ── */
say('B1 pickPlaceItem(bot, null) —— 没指定方块时挑谁')
const picked = pickPlaceItem(bot, null)
console.log('  挑到：', picked ? `${picked.name}（slot ${picked.slot}）` : 'null')
ok(!!picked, '挑到了东西')
ok(!!picked && isFullBlockItem(bot, picked.name), '挑出来的是**整方块**', picked?.name)
ok(!!picked && !isNonFullBlock(picked.name), '**没挑非实体方块**（旧版 items[0] 会照拿）', picked?.name)
console.log('  背包顺序：', bot.inventory.items().map((i) => `${i.slot}:${i.name}`).join(' '))

say('B2 scaffoldingItemIds(bot) —— 交给 pathfinder 垫脚的名单')
const ids = scaffoldingItemIds(bot)
const scaffoldNames = ids.map(nameOf)
console.log('  名单：', scaffoldNames.join('、') || '（空）')
ok(ids.every((id) => isFullBlockItem(bot, nameOf(id))), '名单里全是整方块', scaffoldNames.join('、'))
ok(!scaffoldNames.some((n) => isNonFullBlock(n)), '名单里没有非实体方块', scaffoldNames.join('、'))

/* ── C 真放一块：挑一格贴着地面的空气，放下→验→挖回来 ── */
say('C1 找一格"贴着地面、本来就空、且不在基地里"的位置')
const p0 = bot.entity.position.floored()
let cell = null
for (let r = 1; r <= 4 && !cell; r++) {
  for (let dx = -r; dx <= r && !cell; dx++) {
    for (let dz = -r; dz <= r && !cell; dz++) {
      if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue
      const x = p0.x + dx, y = p0.y, z = p0.z + dz
      const here = vecAt(x, y, z), below = vecAt(x, y - 1, z)
      if (!here || !below) continue
      if (here.name !== 'air' && here.name !== 'cave_air') continue
      if (!isFullBlockItem(bot, below.name)) continue
      if (inBase({ x, y, z })) continue
      cell = { x, y, z, was: here.name }
    }
  }
}
ok(!!cell, '找到落脚点', cell ? `${cell.x},${cell.y},${cell.z}（原来是 ${cell.was}，下面是 ${vecAt(cell.x, cell.y - 1, cell.z).name}）` : '没找到')

if (cell) {
  say('C2 mc.placeBlock() **不给 name** —— 看它落下去的是什么')
  let placed = null, err = null
  try { placed = await mc.placeBlock({ x: cell.x, y: cell.y, z: cell.z }) } catch (e) { err = e }
  console.log('  返回：', JSON.stringify(placed), err ? '｜错误：' + err.message : '')
  const after = vecAt(cell.x, cell.y, cell.z)
  console.log('  现在这一格是：', after?.name)
  ok(!err, '放置没报错', err?.message ?? '')
  ok(!!after && after.name !== cell.was, '方块真的落下去了', after?.name)
  ok(!!after && isFullBlockItem(bot, after.name), '落下去的是**整方块**', after?.name)
  ok(!!after && !isNonFullBlock(after.name), '**没放非实体方块**', after?.name)

  say('C3 收尾：挖回来，恢复成空气')
  try {
    const p = bot.entity.position.clone(); p.x = cell.x; p.y = cell.y; p.z = cell.z
    await mc.dig({ name: after.name, pos: { x: cell.x, y: cell.y, z: cell.z }, maxDistance: 6, count: 1 })
  } catch (e) { console.log('  挖回来失败：', e.message) }
  await new Promise((r) => setTimeout(r, 1200))
  const back = vecAt(cell.x, cell.y, cell.z)
  console.log('  现在这一格是：', back?.name)
  ok(back && (back.name === 'air' || back.name === 'cave_air'), '恢复成空气了', back?.name)
  if (back && back.name !== 'air' && back.name !== 'cave_air') {
    try { await mc.dig({ name: back.name, pos: { x: cell.x, y: cell.y, z: cell.z }, maxDistance: 6, count: 1 }) } catch {}
  }
}

say('最后背包')
console.log(bag())
console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：pass=${pass} fail=${fail}`)
await mc.disconnect().catch(() => {})
process.exit(fail === 0 ? 0 : 1)
