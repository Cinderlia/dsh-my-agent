/**
 * live-column-liquid.mjs —— 竖列图的**水 / 岩浆**分支：实机验证（真服 + 真方块名）
 *
 * 用户 2026-10-15 看着竖列图问：「如果是水和岩浆呢」。
 *
 * 为什么必须实机：离线套件用的是**假世界**，方块名是我自己写的字符串（`'water'` / `'lava'`）；
 * 它证明不了**真服上报出来的名字**能不能被 `columnKindOf` 认成液体 ——
 * 真名可能是 `flowing_water`、`water`、带 level 的 `lava`…… 名字对不上，这一整套就白做。
 *
 * 分三段，能跑哪段跑哪段：
 *   A 注册表核对 —— 永远能跑：服务端报的方块清单里到底有没有 `water` / `lava`，名字长什么样；
 *   B 天然水 / 天然岩浆 —— 在已加载区域里 `findBlock` 找，找到就拿真方块跑 `columnOf`；
 *   C 自建试验台 —— **只在有指令权限时**才跑（脚本先探测，被拒就不硬来）。
 *
 * 🔴 C 段踩过的两个坑（都写在这里，免得下次再踩）：
 *   ① **`/fill` 的目标区块必须已加载**，否则服务端回 "That position is not loaded" 直接拒绝 ——
 *      所以**不能**先 `/fill` 再 `/tp`（那时机器人还在出生点，目标区块根本没加载）。
 *      现在改成**在机器人头顶的空域搭台子**：区块肯定加载着，也不用 tp 找场地。
 *   ② `/tp` 之后要等位置真的变了、再等区块 —— 否则 `blockAt` 全回 `null`（见踩坑档案第 98 条）。
 *
 * 用法：node live-column-liquid.mjs
 * 产物：同目录 live-column-liquid.log
 */
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vec3 } from 'vec3'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const HOST = '127.0.0.1'
const PORT = 25565
const NAME = 'wc_colliq'
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/地图'

const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const { columnOf, columnText, columnKindOf } = await import('file:///' + PKG + '/src/map-render.mjs')

const LOGFILE = join(OUT, 'live-column-liquid.log')
try { writeFileSync(LOGFILE, '') } catch { /* 忽略 */ }
const log = (...a) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(s)
  try { appendFileSync(LOGFILE, s + '\n') } catch { /* 忽略 */ }
}

let pass = 0; let fail = 0
const ok = (cond, what, extra = '') => {
  if (cond) { pass++; log('  ✓ ' + what + (extra ? `  ${extra}` : '')) } else { fail++; log('  ✗ ' + what + (extra ? `  ${extra}` : '')) }
}
const skip = (what) => log('  ⏭ 跳过：' + what)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dir = mkdtempSync(join(tmpdir(), 'wc-colliq-'))
const mc = new McBot({ instanceId: NAME, logFile: join(dir, 'mc.log') })

let bot = null
let rig = null          // { x1,y1,z1,x2,y2,z2 } —— 收尾靠它填回 air
const replies = []      // 服务端回话（指令被拒只有这里看得见）

/* 🔴 `bot.chat()` 不带 `/` 就是普通聊天 —— 指令压根不会执行（见踩坑档案第 97 条） */
const chat = async (cmd, ms = 400) => {
  const c = String(cmd).startsWith('/') ? String(cmd) : '/' + String(cmd)
  bot.chat(c)
  log(`  > ${c}`)
  await sleep(ms)
}
const nameAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name ?? null

/** `findBlock` 的 `matching` 在不同版本里可能收到方块对象或字符串，两个都认 */
const findNamed = (names, max = 48) => {
  const want = new Set(names)
  try { return bot.findBlock({ matching: (b) => want.has(typeof b === 'string' ? b : b?.name), maxDistance: max }) } catch { return null }
}

/** 从机器人上方往上找一段**连续空气**（区块肯定已加载，也不会砸到地形） */
const findAirAbove = (x, z, fromY, need = 8) => {
  let run = 0
  for (let y = fromY; y <= fromY + 48; y++) {
    const n = nameAt(x, y, z)
    if (n === 'air') { run++; if (run >= need) return y - need + 1 } else run = 0
  }
  return null
}

try {
  log(`连 ${HOST}:${PORT} …`)
  await mc.connect({ host: HOST, port: PORT, auth: { mode: 'offline', name: NAME } })
  await mc.waitForChunks(20_000)
  bot = mc.requireBot()
  bot.on('message', (m) => { try { replies.push(m.toString()) } catch { /* 忽略 */ } })
  const p0 = bot.entity.position
  log(`版本 ${bot.version}｜模式 ${bot.game?.gameMode ?? '?'}｜落点 (${p0.x.toFixed(1)}, ${p0.y.toFixed(1)}, ${p0.z.toFixed(1)})`)

  // ═══════════════════════════════════════════════════════════════════
  log('\n═══ A 注册表核对（只读，永远能跑）═══')
  const reg = bot.registry?.blocksByName ?? {}
  log(`  注册表里 ${Object.keys(reg).length} 种方块`)
  for (const n of ['water', 'lava', 'flowing_water', 'flowing_lava', 'obsidian']) {
    log(`  ${n}: ${reg[n] ? `id=${reg[n].id}` : '（没有）'}`)
  }
  ok(Boolean(reg.water), '🔴 服务端方块表里有 `water` 这个名字')
  ok(Boolean(reg.lava), '🔴 服务端方块表里有 `lava` 这个名字')
  ok(!reg.flowing_water && !reg.flowing_lava,
    '没有 `flowing_water` / `flowing_lava` 这种独立名字（流动是同一方块带 level 属性）')
  ok(columnKindOf('water') === 'water' && columnKindOf('lava') === 'lava',
    '🔴 服务端报的这两个名字，`columnKindOf` 认成 water / lava')
  ok(columnKindOf(reg.water?.name) === 'water' && columnKindOf(reg.lava?.name) === 'lava',
    '用注册表里**拿出来的名字**（不是我写死的字符串）再认一遍，还是 water / lava')

  // ═══════════════════════════════════════════════════════════════════
  log('\n═══ B 天然水 / 天然岩浆（只读）═══')
  const wb = findNamed(['water'])
  if (!wb) skip('48 格内没有天然水')
  else {
    log(`  找到天然水 @ (${wb.position.x}, ${wb.position.y}, ${wb.position.z}) = ${wb.name}`)
    ok(wb.name === 'water', '天然水那格 `blockAt` 报的名字就是 water', wb.name)
    const col = columnOf(bot, { x: wb.position.x, z: wb.position.z, yTop: wb.position.y, yBottom: -6 })
    for (const l of columnText(col).split('\n')) log('  | ' + l)
    ok(col.firstGap?.kind === 'water', '🔴 拿天然水当脚底 ⇒ firstGap.kind = water', String(col.firstGap?.kind))
    const t = columnText(col)
    ok(/🌊/.test(t) && /脚底那一格是 \*\*水\*\*/.test(t), '🔴 走的是"脚底是水"那一支')
    ok(/水会灌下来/.test(t) && !/就会掉下去/.test(t), '🔴 说"水会灌下来"，**不说**"掉下去"')
    ok(col.hazards?.water?.length >= 1, 'hazards.water 有记录', JSON.stringify(col.hazards))
  }
  const lb = findNamed(['lava'])
  if (!lb) skip('48 格内没有天然岩浆（这一条只能靠离线测试 + 注册表核对）')
  else {
    log(`  找到天然岩浆 @ (${lb.position.x}, ${lb.position.y}, ${lb.position.z}) = ${lb.name}`)
    ok(lb.name === 'lava', '天然岩浆那格报的名字就是 lava', lb.name)
    const col = columnOf(bot, { x: lb.position.x, z: lb.position.z, yTop: lb.position.y, yBottom: -6 })
    for (const l of columnText(col).split('\n')) log('  | ' + l)
    ok(col.firstGap?.kind === 'lava', '🔴 拿天然岩浆当脚底 ⇒ firstGap.kind = lava', String(col.firstGap?.kind))
    const t = columnText(col)
    ok(/🔥/.test(t) && /脚底那一格是 \*\*岩浆\*\*/.test(t), '🔴 走的是"脚底是岩浆"那一支')
    ok(/先挪一步，别在这上面挖/.test(t) && !/就会掉下去/.test(t), '🔴 最重的措辞，**不说**"掉下去"')
  }

  // ═══════════════════════════════════════════════════════════════════
  log('\n═══ C 自建试验台（先探指令权限，被拒就不硬来）═══')
  /* 探测点必须在**已加载**的区块里 —— 离机器人几十格的话区块没加载，`blockAt` 恒回 null，
   * "有没有权限"根本测不出来（自己骗自己）。用机器人头顶上方。 */
  const px = Math.floor(p0.x); const pz = Math.floor(p0.z)
  const probeY = Math.floor(p0.y) + 6
  const before = nameAt(px, probeY, pz)
  replies.length = 0
  await chat(`setblock ${px} ${probeY} ${pz} stone`, 900)
  const after = nameAt(px, probeY, pz)
  log(`  探测：(${px},${probeY},${pz}) 放石头前=${before} 后=${after}`)
  if (replies.length) log(`  服务端回话：${JSON.stringify(replies)}`)
  const canBuild = after === 'stone'
  log(`  ⇒ ${canBuild ? '有指令权限' : '没有指令权限（命令被拒 / 或这格本来就不是 stone）'}`)
  if (canBuild) await chat(`setblock ${px} ${probeY} ${pz} air`, 400)

  if (!canBuild) {
    skip('没有指令权限 —— C 段整段跳过；水/岩浆的文案分支已由 B 段 + 离线套件覆盖')
    log('      （要跑 C 段：暂停菜单 → 对局域网开放 → 允许作弊=开 → 开始局域网世界，然后重跑本脚本）')
  } else {
    /* 台子搭在机器人**头顶的空域**：区块已加载（`/fill` 才不会被拒），也不砸到地形（填回 air 是零改动）。
     * 机器人站在台面正上方，不用长途 tp、也就不会摔。 */
    const baseY = findAirAbove(px + 4, pz, Math.floor(p0.y) + 4, 10)
    if (baseY == null) throw new Error('头顶 48 格内找不到 10 格连续空气，搭不了台子')
    const bx = px + 4
    const TOP = baseY + 5                 // 台面那一层
    rig = { x1: bx, y1: baseY, z1: pz - 1, x2: bx + 8, y2: TOP, z2: pz + 1 }
    const RX = { air: bx + 1, water: bx + 3, lava: bx + 5, deepLava: bx + 7 }
    log(`  台子 x=${rig.x1}..${rig.x2} y=${rig.y1}..${rig.y2} z=${rig.z1}..${rig.z2}（台面 y=${TOP}）`)

    log('  C1 搭试验台')
    replies.length = 0
    await chat(`fill ${rig.x1} ${rig.y1} ${rig.z1} ${rig.x2} ${rig.y2} ${rig.z2} stone`, 1200)
    const built = nameAt(rig.x1, TOP, pz)
    log(`  台面读回来 = ${built}${replies.length ? `｜服务端回话 ${JSON.stringify(replies)}` : ''}`)
    ok(built === 'stone', '🔴 `/fill` 真把台子搭起来了（区块已加载，没被 "not loaded" 拒掉）', String(built))
    if (built !== 'stone') throw new Error('/fill 没生效，C 段没法继续')

    log('  C2 挪机器人到台面正上方（原地，不掉）')
    await chat(`tp ${NAME} ${RX.air + 0.5} ${TOP + 1} ${pz + 0.5}`, 900)
    for (let i = 0; i < 40; i++) {
      const p = bot.entity.position
      if (Math.abs(p.x - (RX.air + 0.5)) < 1.2 && Math.abs(p.z - (pz + 0.5)) < 1.2 && Math.abs(p.y - (TOP + 1)) < 1.5) break
      await sleep(250)
    }
    await mc.waitForChunks(20_000); await sleep(500)
    const p1 = bot.entity.position
    log(`  落点 (${p1.x.toFixed(1)}, ${p1.y.toFixed(1)}, ${p1.z.toFixed(1)})｜血量 ${bot.health}`)
    ok(Math.abs(p1.y - (TOP + 1)) < 1.5, 'tp 到位、站在台面上（没掉下去）', `y=${p1.y.toFixed(1)} vs ${TOP + 1}`)

    log('  C3 凿竖井 + 灌水灌岩浆（四面石头，不会流出去）')
    for (const c of [
      `setblock ${RX.air} ${TOP - 3} ${pz} air`, `setblock ${RX.air} ${TOP - 4} ${pz} air`,
      `setblock ${RX.water} ${TOP - 3} ${pz} water`, `setblock ${RX.water} ${TOP - 4} ${pz} water`,
      `setblock ${RX.lava} ${TOP - 3} ${pz} lava`,
      `setblock ${RX.deepLava} ${TOP - 2} ${pz} air`, `setblock ${RX.deepLava} ${TOP - 4} ${pz} lava`,
    ]) await chat(c, 250)
    await sleep(700); await mc.waitForChunks(20_000)

    const raw = { water: nameAt(RX.water, TOP - 3, pz), lava: nameAt(RX.lava, TOP - 3, pz), deepLava: nameAt(RX.deepLava, TOP - 4, pz) }
    log('  C4 真服读到的名字 ' + JSON.stringify(raw))
    ok(raw.water === 'water', '自建水那格报 water', String(raw.water))
    ok(raw.lava === 'lava', '🔴 自建岩浆那格报 lava（不是被水浇成的 obsidian）', String(raw.lava))
    ok(raw.deepLava === 'lava', '深处那格岩浆也报 lava', String(raw.deepLava))

    const scan = (x) => columnOf(bot, { x, z: pz, yTop: TOP, yBottom: -6 })
    const cAir = scan(RX.air); const cWat = scan(RX.water); const cLav = scan(RX.lava); const cDeep = scan(RX.deepLava)
    const tAir = columnText(cAir); const tWat = columnText(cWat); const tLav = columnText(cLav); const tDeep = columnText(cDeep)
    for (const [n, t] of [['空腔', tAir], ['水', tWat], ['岩浆', tLav], ['深处岩浆', tDeep]]) {
      log(`  ── ${n} ──`); for (const l of t.split('\n')) log('  | ' + l)
    }
    ok(cAir.firstGap?.kind === 'air' && /⚠️/.test(tAir) && /就会掉下去/.test(tAir), '空腔 ⇒ ⚠️ + "就会掉下去"')
    ok(cWat.firstGap?.kind === 'water' && /🌊/.test(tWat) && /挖进水/.test(tWat) && !/就会掉下去/.test(tWat),
      '🔴 水 ⇒ 🌊 + "挖进水"，不说"掉下去"')
    ok(cLav.firstGap?.kind === 'lava' && /🔥/.test(tLav) && /挖穿到岩浆/.test(tLav) && /掉进去会死/.test(tLav) && !/就会掉下去/.test(tLav),
      '🔴 岩浆 ⇒ 🔥 + "掉进去会死，别挖"')
    ok(cDeep.firstGap?.kind === 'air' && cDeep.hazards?.lava?.length === 1 && /再往下还有 \*\*岩浆\*\*/.test(tDeep),
      '🔴 第一处是空腔、更深处有岩浆 ⇒ 单独提一行')
  }
} catch (e) {
  fail++
  log('✗ 这一轮没验成：' + (e?.message ?? e))
} finally {
  if (bot && rig) {
    log('\n拆台子（整块填回 air）')
    replies.length = 0
    try { await chat(`fill ${rig.x1} ${rig.y1} ${rig.z1} ${rig.x2} ${rig.y2} ${rig.z2} air`, 1200) } catch { /* 忽略 */ }
    try { log(`  台面读回来 = ${nameAt(rig.x1, rig.y2, Math.floor(bot.entity.position.z))}`) } catch { /* 忽略 */ }
  }
  try { await mc.disconnect() } catch { /* 忽略 */ }
  log(`\n结果：${pass} ✅ / ${fail} ❌`)
  process.exit(fail ? 1 : 0)
}
