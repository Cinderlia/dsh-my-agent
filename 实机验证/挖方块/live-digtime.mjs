/* 挖矿速度实机验证：真服上挖一块**上游数据写错 material 的矿石**（铜/铁/金/青金石/深层…），
 * 证明 `bot.digTime` 被修成了原版真值、机器人真的按真值挖，而且**没有**"复原"。
 *
 * 用法：node live-digtime.mjs [账号名]        （默认 wcdigtime_live）
 *
 * 病根（见 踩坑档案.md 第 38 条）：minecraft-data 1.21.9 把这 108 个"要石镐以上"的方块的
 *   `material` 写成了品级门标签 `incorrect_for_wooden_tool` ⇒ 石/铁/钻石镐查不到倍率 ⇒
 *   速度按 1 算 ⇒ 挖铁矿永远 4550ms（真值：石镐 1150、铁镐 750）。
 * 本脚本的判据：
 *   ① `bot.__wcDigTimePatched === true`（补丁装上了）
 *   ② `bot.digTime(矿) < bot.__wcOrigDigTime(矿)`（按真值变小了；石镐挖铜矿 1302 vs 4550）
 *   ③ `diggingCompleted` 的实际耗时 ≈ ② 那个值（机器人真的按真值挖）
 *   ④ 服务端发了 `block_change{air}`、1.5 秒后还是 air（没有"复原"）
 *   ⑤ 背包里多了对应的原矿（真的挖到了）
 * 🔴 必须先有一把**采得动这块矿**的镐（木镐采不动铜/铁矿 ⇒ 上游那个 37500ms 是"挖不动"，
 *    补丁**故意不修**）。所以脚本会先凑齐 3 个圆石做石镐。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NAME = process.argv[2] ?? 'wcdigtime_live'
const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const craftExt = await import('file:///' + PKG + '/extensions/mc_craft.mjs')

const registered = new Map()
const sessions = new Map()
const fakeHost = {
  ctx: { tools: { register: (d) => registered.set(d.name, d), guard: () => {}, get: () => undefined }, on: () => () => {}, get: () => undefined, logger: { info: () => {}, warn: () => {} } },
  config: {},
  registry: { peek: (id) => sessions.get(String(id)), listSessions: () => [] },
  asTool: (s) => s,
  getSession: (e) => sessions.get(String(e?.agent?.id)),
  memory: {}, memoryFor: () => ({}), workspaceOf: () => null,
  logLine: (l) => console.log('[log]', l), Watchdog: class {}, ensureWatchdog: () => {},
}
await craftExt.apply(fakeHost)
const cSpec = registered.get('mc_craft')

const mc = new McBot({ instanceId: 'live-digtime', lockDir: mkdtempSync(join(tmpdir(), 'wc-digtime-live-')) })
sessions.set('A1', { agentId: 'A1', bot: mc })
const EXEC = { agent: { id: 'A1' } }
const craft = (a) => cSpec.execute(a, EXEC)

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const say = (s) => console.log('\n=== ' + s + ' ===')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const short = (x, n = 220) => { const s = typeof x === 'string' ? x : JSON.stringify(x); return s.length > n ? s.slice(0, n) + '…' : s }

await mc.connect({ host: '127.0.0.1', port: 25565, auth: { mode: 'offline', name: NAME } })
await mc.waitForChunks(20_000)
const bot = mc.requireBot()
const Vec3 = bot.entity.position.constructor
const cnt = (n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0)
const bag = () => bot.inventory.items().map((i) => `${i.name}×${i.count}`).join(' ') || '（空）'
const here = () => bot.entity.position.floored()
const eyeOf = () => bot.entity.position.offset(0, 1.62, 0)
const reachOf = (blk) => eyeOf().distanceTo(blk.position.offset(0.5, 0.5, 0.5))
const inWaterNow = () => Boolean(bot.entity.isInWater) || /water/.test(bot._getBlockAtEyeLevel?.()?.name ?? '')
const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
const WET = /water|lava/
const solidAt = (b) => Boolean(b) && b.name !== 'air' && !WET.test(b.name) && b.boundingBox !== 'empty'

bot.on('message', (m) => { const s = m.toString().trim(); if (s) console.log('[chat]', s) })

/* 挖完的真实耗时：`diggingCompleted` 是服务端确认之后才发的。🔴 `digStart` 只在"要量的那一次"之前设，
 * 不然会把前面砍树/挖石头的耗时也算进来（第一版就踩了：报出 5773ms / 7870ms 两条幽灵记录）。 */
const digs = []
let digStart = null
bot.on('diggingCompleted', (block) => {
  if (digStart == null) return
  digs.push({ name: block?.name, ms: Date.now() - digStart })
})

/* 听服务端原始包：判"这次破坏服务端认没认"**只能**看包，`bot.blockAt()` 是客户端预测世界 */
let pktLog = []
const watchPos = (pos) => {
  pktLog = []
  const onPkt = (data, meta) => {
    const nm = meta?.name
    if (nm !== 'block_change' && nm !== 'block_update') return
    const l = data?.location ?? data?.position
    if (!l || l.x !== pos.x || l.y !== pos.y || l.z !== pos.z) return
    pktLog.push({ nm, type: data.type, t: Date.now() })
  }
  bot._client.on('packet', onPkt)
  return () => bot._client.removeListener('packet', onPkt)
}

/** 半径内找方块，按"离我多远"从近到远（findBlocks 返回坐标，matcher 里**不能**碰 .position） */
const near = (pred, maxDistance = 64, count = 256) => {
  const me = bot.entity.position
  return bot.findBlocks({ matching: pred, maxDistance, count })
    .map((p) => bot.blockAt(p)).filter(Boolean)
    .sort((a, b) => me.distanceTo(a.position) - me.distanceTo(b.position))
}
/** 旁边有干地落脚点的方块（上一轮踩过：矿在水塘/崖壁上，落水或悬空后挖掘守卫会拒绝）。
 *  🔴 落脚点要按**站上去以后眼距够不够得着**挑：只看"离我多远"会选到自己脚下那格，
 *     走过去眼距 4.9 还是够不着（实测第三跑就是这么连试 4 块全失败）。 */
const drySpotNear = (blk, r = 4) => {
  const p = blk.position, me = bot.entity.position, cand = []
  const center = p.offset(0.5, 0.5, 0.5)
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (Math.abs(dx) + Math.abs(dz) > r || (dx === 0 && dz === 0)) continue
    for (let dy = -1; dy <= 2; dy++) {
      const y = p.y + dy
      const foot = at(p.x + dx, y, p.z + dz), head = at(p.x + dx, y + 1, p.z + dz), below = at(p.x + dx, y - 1, p.z + dz)
      if (!foot || !head || !below) continue
      if (foot.name !== 'air' || head.name !== 'air' || !solidAt(below)) continue
      const eye = new Vec3(p.x + dx + 0.5, y + 1.62, p.z + dz + 0.5).distanceTo(center)
      cand.push({ x: p.x + dx, y, z: p.z + dz, eye, d: me.distanceTo(new Vec3(p.x + dx, y, p.z + dz)) })
    }
  }
  return cand.sort((a, c) => (a.eye <= 4.3 ? 0 : 1) - (c.eye <= 4.3 ? 0 : 1) || a.eye - c.eye || a.d - c.d)[0] ?? null
}

say('连上了')
console.log('模式', bot.game.gameMode, '｜位置', JSON.stringify(here()), '｜背包', bag())
console.log('digTime 补丁：', bot.__wcDigTimePatched === true ? '已装上' : '**没装上**')

if (inWaterNow()) {
  say('我泡在水里，先上浮换气')
  await mc.swimUp({ hold: 3000 })
  await sleep(600)
}

// ── ① 先弄到一把**采得动矿**的镐（木镐不行：铜/铁矿要石镐以上）────────────────────────────
say('① 准备镐子')
const PICK = /_pickaxe$/
/* 🔴 不能按名字长度挑"最好的镐"：`wooden_pickaxe`(14) 比 `stone_pickaxe`(13) 长，
 *    第一版就因此挑中木镐、白跑一轮（木镐采不动铜/铁矿）。按品级排。 */
const TIER = { netherite: 5, diamond: 4, iron: 3, stone: 2, golden: 1, wooden: 0 }
const pickTier = (n) => TIER[String(n).replace(/_pickaxe$/, '')] ?? -1
const bestPick = () => bot.inventory.items().filter((i) => PICK.test(i.name)).sort((a, b) => pickTier(b.name) - pickTier(a.name))[0] ?? null
let pick = bestPick()
console.log('现有镐子：', pick ? `${pick.name}×${pick.count}` : '没有')
if (!pick) {
  // 一把都没有：正常玩法做一把木镐（砍树 → 木板 → 工作台 → 木镐）
  const LOGS = ['oak_log', 'jungle_log', 'birch_log', 'spruce_log', 'acacia_log', 'dark_oak_log']
  const logCnt = () => LOGS.reduce((a, n) => a + cnt(n), 0)
  for (let i = 0; i < 4 && logCnt() < 4; i++) {
    const logs = near((b) => /_log$/.test(b?.name ?? ''), 24, 64)
    if (!logs.length) { console.log('  · 附近没树，停'); break }
    const s = drySpotNear(logs[0]) ?? { x: logs[0].position.x, y: logs[0].position.y, z: logs[0].position.z }
    await mc.walkTo({ x: s.x, y: s.y, z: s.z, arrive: 2 }).catch(() => {})
    try { console.log('  · ' + short(await mc.dig({ name: logs[0].name, count: 4 - logCnt(), maxDistance: 8 }))) } catch (e) { console.log('  · 砍树失败：' + e.message) }
  }
  const anyLog = LOGS.find((n) => cnt(n) > 0)
  if (anyLog) {
    console.log('  · ' + short(await craft({ name: anyLog.replace('_log', '_planks'), count: 8 })))
    console.log('  · ' + short(await craft({ name: 'crafting_table', count: 1 })))
    console.log('  · ' + short(await craft({ name: 'wooden_pickaxe', count: 1 })))
  }
  pick = bestPick()
}
if (pick && /wooden_pickaxe/.test(pick.name) && cnt('cobblestone') < 3) {
  for (let round = 1; round <= 8 && cnt('cobblestone') < 3; round++) {
    const need = 3 - cnt('cobblestone')
    console.log(`  [${round}] 挖石头 ${need} 个（现有圆石 ${cnt('cobblestone')}）`)
    try { console.log('    ' + short(await mc.dig({ name: 'stone', count: need, maxDistance: 8 }))) } catch (e) { console.log('    挖石头失败：' + e.message) }
    if (cnt('cobblestone') >= 3) break
    // 石头在地下：把脚下那块挖掉，露出下一层
    const p = here()
    const below = at(p.x, p.y - 1, p.z)
    if (!below || below.name === 'air' || WET.test(below.name)) { console.log('    脚下是空的/水，换不了层，停'); break }
    try { console.log('    往下挖开一层：' + short(await mc.dig({ x: p.x, y: p.y - 1, z: p.z, count: 1 }))) } catch (e) { console.log('    往下挖失败：' + e.message) }
    await sleep(400)
  }
}
if (!pick || /wooden_pickaxe/.test(pick.name)) {
  if (cnt('cobblestone') < 3) { console.log(`  圆石只有 ${cnt('cobblestone')} 个，做不了石镐`); }
  else {
    /* 🔴 `mc_craft` 只在**身边 4 格**内找工作台（`findTableBlock` 的 radius 默认 4）⇒ 上一轮放在
     *    世界里的工作台如果离得远，它就当"没有工作台"（实测：(-74,90,-29) 那张离我 6.6 格 ⇒
     *    报"缺料 crafting_table"）。所以先走过去。 */
    if (cnt('crafting_table') === 0) {
      const tables = near((b) => b.name === 'crafting_table', 32, 32)
      if (tables.length) {
        console.log(`  附近有 ${tables.length} 张工作台，先走过去用（最近 ${tables[0].position.x},${tables[0].position.y},${tables[0].position.z}）`)
        for (let i = 0; i < 3; i++) {
          const t = tables[0].position
          const r = await mc.walkTo({ x: t.x, y: t.y, z: t.z, arrive: 2 })
          if (bot.entity.position.distanceTo(t) <= 4) break
          console.log(`    walkTo ⇒ arrived=${r?.arrived} moved=${r?.moved}｜离工作台 ${bot.entity.position.distanceTo(t).toFixed(2)}`)
        }
      } else console.log('  附近没有工作台，也没有工作台在背包里')
    }
    console.log('  ' + short(await craft({ name: 'stone_pickaxe', count: 1 })))
  }
}
pick = bestPick()
if (pick) await bot.equip(pick, 'hand').catch((e) => console.log('  · 换手上失败：', e.message))
console.log('最终镐子：', bot.heldItem?.name ?? '空手', '｜背包', bag())
const heldType = bot.heldItem?.type ?? null
if (!pick || !/stone_pickaxe|iron_pickaxe|diamond_pickaxe|netherite_pickaxe/.test(pick.name)) {
  console.log('\n没有石镐以上的镐子 ⇒ 测不了这个修复（木镐挖铜/铁矿本来就算"挖不动"，补丁故意不修）。')
  await mc.disconnect('没镐子')
  process.exit(2)
}

// ── ② 找一块**上游 material 写错的**矿石，且手上这把采得动、旁边有干地落脚点 ────────────────
say('② 找一块 material 写错的矿石')
const BAD_ORES = ['copper_ore', 'iron_ore', 'lapis_ore', 'gold_ore', 'deepslate_copper_ore', 'deepslate_iron_ore', 'redstone_ore', 'diamond_ore', 'emerald_ore']
const all = near((b) => BAD_ORES.includes(b?.name ?? ''), 64, 256)
/* 🔴 `canHarvest` 返回的是真值/undefined（不是 true/false）⇒ 必须 `Boolean()`，
 *    第一版写成 `!== false` 把 256 块采不动的都当"采得动"。 */
const usable = all.filter((b) => Boolean(b.canHarvest?.(heldType)))
console.log(`64 格内 ${all.length} 块，手上 ${pick.name} 采得动的 ${usable.length} 块：`,
  usable.slice(0, 6).map((b) => `${b.name}@${b.position.x},${b.position.y},${b.position.z}(${reachOf(b).toFixed(1)})`).join(' '))
if (!usable.length) {
  console.log('\n附近没有这块镐采得动的铜/铁/金/青金石/红石/钻石/绿宝石矿 —— 先跑到有矿的地方再跑。')
  await mc.disconnect('没找到矿')
  process.exit(2)
}
/* 优先挑"旁边有干地落脚点 + 离我最近"的（崖壁上的矿够不着） */
const ranked = usable.slice(0, 24).map((b) => ({ b, spot: drySpotNear(b), d: bot.entity.position.distanceTo(b.position) }))
  .sort((x, y) => (x.spot ? 0 : 1) - (y.spot ? 0 : 1) || (x.spot?.eye ?? 99) - (y.spot?.eye ?? 99) || x.d - y.d)

// ── ③ 挨个试：走到旁边的干地，直到眼距 ≤4.5 ────────────────────────────────────────────
say('③ 靠近')
let target = null, spot = null
for (const c of ranked.slice(0, 6)) {
  console.log(`  试 ${c.b.name}@${c.b.position.x},${c.b.position.y},${c.b.position.z}（${c.d.toFixed(1)} 格，落脚点 ${c.spot ? `有（站上去眼距约 ${c.spot.eye.toFixed(1)}）` : '没有'}）`)
  if (c.spot) {
    for (let i = 0; i < 5 && reachOf(c.b) > 4.3; i++) {
      const r = await mc.walkTo({ x: c.spot.x, y: c.spot.y, z: c.spot.z, arrive: 1 })
      console.log(`    walkTo ⇒ arrived=${r?.arrived} moved=${r?.moved}｜现在眼距 ${reachOf(c.b).toFixed(2)}`)
      if ((r?.moved ?? 0) < 0.3) break
    }
  }
  if (reachOf(c.b) <= 4.5) { target = c.b; spot = c.spot; break }
  console.log(`    还是够不着（眼距 ${reachOf(c.b).toFixed(2)}），换下一块`)
}
if (!target) { console.log('\n4 块都够不着 —— 先 mc_move 走到矿脉边上再跑这个脚本。'); await mc.disconnect('够不着'); process.exit(2) }
const tName = target.name, tPos = target.position.clone()
await sleep(500)   // 让物理落稳（`onGround` 在刚走完路时会瞬时为 false，会污染 digTime 的 /5）
const origMs = bot.__wcOrigDigTime ? bot.__wcOrigDigTime(target) : null
const patchedMs = bot.digTime(target)
console.log(`目标：${tName}@${tPos.x},${tPos.y},${tPos.z}｜眼距 ${reachOf(target).toFixed(2)}｜hardness ${target.hardness}｜material ${target.material}`)
console.log(`digTime：上游 ${origMs}ms → 现在 ${patchedMs}ms（手上 ${bot.heldItem?.name ?? '空手'}）`)
ok(Number.isFinite(origMs) && Number.isFinite(patchedMs) && patchedMs < origMs,
  `digTime 按真值变小了（${origMs} → ${patchedMs}）`, '这是"挖铁矿 4.5 秒"的直接证据')

// ── ④ 挖它：比 digTime、听服务端包、看背包 ──────────────────────────────────────────────
say('④ 挖')
const stopWatch = watchPos(tPos)
const DROPS = {
  copper_ore: 'raw_copper', deepslate_copper_ore: 'raw_copper',
  iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron',
  gold_ore: 'raw_gold', deepslate_gold_ore: 'raw_gold',
  lapis_ore: 'lapis_lazuli', deepslate_lapis_ore: 'lapis_lazuli',
  redstone_ore: 'redstone', deepslate_redstone_ore: 'redstone',
  diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond',
  emerald_ore: 'emerald', deepslate_emerald_ore: 'emerald',
}
const dropName = DROPS[tName] ?? tName
const before = { drop: cnt(dropName), bag: bag() }
console.log(`  开挖前：isInWater=${bot.entity.isInWater}｜眼那格=${bot._getBlockAtEyeLevel?.()?.name}｜onGround=${bot.entity.onGround}｜vy=${bot.entity.velocity?.y?.toFixed(3)}`)
console.log(`  背包（前）：${before.bag}`)
digs.length = 0
digStart = Date.now()
const t0 = Date.now()
/* 🔴 必须给**坐标**：`mc.dig({name})` 会自己挑最近的同类方块（第一版就是它挖了 z=-20 那块，
 *    而我一直盯着 z=-21 那块听包 ⇒ 一条包都没收到、结论全错）。
 *    另外 `McBot.dig()` 收的是 `{ pos }`（`index.js` 的 `mc_dig` 工具才把 x/y/z 转成 pos）——
 *    直接调 McBot 时传 x/y/z 会抛 `需要 name 或 pos`。 */
const r = await mc.dig({ pos: { x: tPos.x, y: tPos.y, z: tPos.z }, count: 1 })
const wall = Date.now() - t0
const lines = Array.isArray(r) ? r : [short(r)]
for (const l of lines) console.log('  ·', l)
console.log(`  · mc.dig 整轮 ${wall}ms（上游估 ${origMs}ms / 修正后估 ${patchedMs}ms）`)
console.log(`  · 服务端包：${pktLog.map((p) => `${p.nm} type=${p.type} +${p.t - t0}ms`).join(' | ') || '（一个都没收到）'}`)
console.log(`  · diggingCompleted：${digs.map((d) => `${d.name} ${d.ms}ms`).join(' | ') || '（没触发）'}`)
await sleep(1500)
stopWatch()
digStart = null
/* 掉落物有时来不及捡（`mc.dig` 这一轮的预算用完就返回了，第二跑就是 `raw_copper 0→0`）⇒
 * 再给它一次机会走过去捡 —— 这一步测的是"挖到了没"，不是"捡得快不快"。 */
for (let i = 0; i < 3 && cnt(dropName) === before.drop; i++) {
  const it = Object.values(bot.entities ?? {})
    .filter((e) => /^item$/i.test(String(e?.name ?? '')) && e?.position?.distanceTo)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
  if (!it) break
  const d = it.position.distanceTo(bot.entity.position)
  if (d > 10) break
  console.log(`  · 掉落物还在 ${d.toFixed(1)} 格外，走过去捡`)
  await mc.walkTo({ x: it.position.x, y: it.position.y, z: it.position.z, arrive: 1 }).catch(() => {})
  await sleep(700)
}
const after = { drop: cnt(dropName), bag: bag() }
const stillThere = bot.blockAt(tPos)?.name
console.log(`  · 背包（后）：${after.bag}`)
console.log(`  · ${dropName} ${before.drop}→${after.drop}｜1.5 秒后那格是 ${stillThere}`)

// ── ⑤ 断言 ────────────────────────────────────────────────────────────────────────────
say('⑤ 结论')
ok(bot.__wcDigTimePatched === true, 'digTime 补丁装上了')
/* 第一条 `diggingCompleted` 就是这次挖掘本身（实测还会再补一条收尾记录，取最后一条会偏大）。 */
const dg = digs[0]
if (dg) ok(Math.abs(dg.ms - patchedMs) < 900, `实际挖完用了 ${dg.ms}ms（digTime 报 ${patchedMs}ms）`)
else console.log(`  · diggingCompleted 没触发（不影响结论，用服务端回包时间判）`)
if (dg) ok(dg.ms < origMs * 0.5, `真正挖掘 ${dg.ms}ms < 上游估 ${origMs}ms 的一半（上游那个"4.5 秒"级别的估值真的被绕过了）`)
ok(wall < origMs + 2_000, `整轮 ${wall}ms（上游估 ${origMs}ms）—— 整轮还要走过去捡掉落物，只做宽松核对`)
ok(pktLog.some((p) => p.type === 0), '服务端发回了 air 方块更新（这次破坏被认了）')
ok(stillThere !== tName, `1.5 秒后那格不是 ${tName} 了（没有"复原"）`, String(stillThere))
ok(after.drop > before.drop, `背包里真的多了 ${dropName}（不是"报了成功其实没挖到"）`, `${before.drop}→${after.drop}`)

await mc.disconnect('测完')
console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
