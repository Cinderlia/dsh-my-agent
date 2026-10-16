#!/usr/bin/env node
/**
 * 实机验证（**需要 OP / 允许作弊**）：`mc_act {mode:"bridge"}` 的受控验收。
 *
 * 为什么不用"就地找场地"那套：本地服是雪原，地表往下 3 格就是石头（徒手挖不动），
 * 而且 bot 每次连上的落点都不一样（还掉进过上一轮自己挖的坑里）—— 场地不可控，测不出结论。
 * 这里改成用 `/fill` 在高空造一块干净的石头平台，再挖出一条真沟，三个场景逐个跑。
 *
 * 需要先做两件事（用户侧）：
 *   ① 局域网设置里勾上「允许作弊」
 *   ② 在游戏里执行 `/op bridge_test`
 *
 * 安全约定：平台建在 **y=96..100、x 200..210、z 200..204** 的高空（离基地很远），
 *           跑完（**包括中途抛错**）一定在 finally 里 `/fill ... air` 拆干净。
 *
 * 用法：node 实机验证/搭路/live-bridge-op.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠️ 实机脚本一律用相对路径，别走 `~/.dsh/profiles/desktop/node_modules/dsh-mc-agent` 那个 junction
const core = await import('../../src/core.mjs')
const { McBot } = core
const Vec3 = (await import('vec3')).Vec3

const NAME = 'bridge_test'
const log = (...a) => console.log(...a)
const P = (p) => `(${p.x},${p.y},${p.z})`

// 平台：x 200..210、z 200..204、y 96 是实心底，97..100 是路面/沟体；桥面在 y=100（bot 站 y=101）
const DECK = 100
const GAP = { x1: 205, x2: 207, z1: 200, z2: 204 }
const STAND = { x: 204, y: 101, z: 202 }
const TARGET = { x: 208, y: DECK, z: 202 }

const mc = new McBot({ instanceId: `bridge-op-${Date.now()}`, lockDir: mkdtempSync(join(tmpdir(), 'bridge-op-')) })
let ok = 0
let bad = 0
const check = (label, pass, extra = '') => { if (pass) { ok++; log(`  ✅ ${label}${extra ? ` —— ${extra}` : ''}`) } else { bad++; log(`  ❌ ${label}${extra ? ` —— ${extra}` : ''}`) } }

/** 连上之后才有；finally 里的拆平台要用 */
let botRef = null
/** 平台真建起来了才需要拆 */
let needTeardown = false
const teardown = async () => {
  if (!needTeardown || !botRef) return
  needTeardown = false
  const say = async (cmd, ms = 900) => { botRef.chat(cmd.startsWith('/') ? cmd : `/${cmd}`); await botRef.waitForTicks(Math.ceil(ms / 50)) }
  log('\n── 拆平台 ──')
  try {
    await say(`fill 200 96 200 210 100 204 air`)
    await say(`fill 200 101 200 210 106 204 air`)
    const a = botRef.blockAt(new Vec3(STAND.x, DECK, STAND.z))?.name ?? null
    const b = botRef.blockAt(new Vec3(200, 96, 200))?.name ?? null
    log(`拆完：${P({ x: STAND.x, y: DECK, z: STAND.z })}=${a} / (200,96,200)=${b}`)
  } catch (e) {
    log(`⚠️ 拆平台出错（手动清一下 x200..210 / z200..204 / y96..106）：${e?.message ?? e}`)
  }
}

try {
  await mc.connect({ host: '127.0.0.1', port: 25565, auth: { mode: 'offline', name: NAME } })
  await mc.waitForChunks(20_000)
  const bot = mc.requireBot()
  botRef = bot
  // 把服务端回的话打出来 —— 指令被拒（没权限 / 语法错）时只有这里看得见
  bot.on('message', (m) => { const s = m.toString().trim(); if (s) log(`  [服务端] ${s}`) })
  await bot.waitForTicks(20)
  log(`✅ 连上：${bot.version} / ${bot.game?.gameMode} / 落点 ${P(bot.entity.position)}`)

  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name ?? null
  // ⚠️ 必须带 `/` —— mineflayer 的 bot.chat() 只有以 `/` 开头才当**指令**发，否则就是普通聊天
  // （实机踩到过：日志里回显成 `<bridge_test> fill 200 …`，指令压根没执行）
  const chat = async (cmd, ms = 500) => { bot.chat(cmd.startsWith('/') ? cmd : `/${cmd}`); await bot.waitForTicks(Math.ceil(ms / 50)) }
  /** `/tp` 之后**等位置真的变了、再等区块到** —— 不然 blockAt 全是 null（看着像"指令没生效"） */
  const tpTo = async (x, y, z) => {
    await chat(`tp ${NAME} ${x} ${y} ${z}`, 400)
    for (let i = 0; i < 60; i++) {
      const p = bot.entity.position
      if (Math.abs(p.x - x) < 1.5 && Math.abs(p.z - z) < 1.5) break
      await bot.waitForTicks(5)
    }
    await mc.waitForChunks(20_000).catch(() => {})
    await bot.waitForTicks(20)
    return { ...bot.entity.position }
  }

  // ── 建平台 ──
  //   ⚠️ 必须**先 /tp 过去再检查**：/fill 是服务端干的活，但 bot 在 200 格外时那一带区块没加载，
  //   `blockAt` 会回 null（看起来像"没建起来"，其实只是看不见）。
  log('\n── 搭测试平台 ──')
  await chat(`fill 200 96 200 210 96 204 stone`, 900)
  await chat(`fill 200 97 200 210 100 204 stone`, 900)
  await chat(`fill 200 101 200 210 106 204 air`, 900)
  await tpTo(STAND.x + 0.5, STAND.y, STAND.z + 0.5)
  const deck0 = at(STAND.x, DECK, STAND.z)
  log(`平台路面 ${P({ x: STAND.x, y: DECK, z: STAND.z })} = ${deck0}`)
  if (deck0 === null || deck0 === 'air') throw new Error(`平台没建起来（路面还是 ${deck0}）—— /fill 被拒了？`)
  needTeardown = true
  log(`人已就位 ${P(bot.entity.position)}`)

  /** 挖开沟 + 把 bot 放到起点 + 给料；返回后直接可以跑 mc.bridge */
  const setup = async ({ lava = false, give = 64 } = {}) => {
    await chat(`fill ${GAP.x1} 97 ${GAP.z1} ${GAP.x2} ${DECK} ${GAP.z2} air`, 900)
    if (lava) await chat(`setblock 206 98 202 lava`, 700)
    await chat(`clear ${NAME}`, 500)
    if (give > 0) await chat(`give ${NAME} dirt ${give}`, 700)
    await tpTo(STAND.x + 0.5, STAND.y, STAND.z + 0.5)
    const inv = bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(', ') || '（空）'
    log(`  沟：${GAP.x1}..${GAP.x2} × y97..${DECK} 已挖空${lava ? '（沟里放了岩浆）' : ''}；站位 ${P(bot.entity.position)}；背包 ${inv}`)
  }

  // ── 场景 A：正常 3 格沟 ⇒ 应该搭过去 ──
  log('\n══ 场景 A：正常沟，有料 ⇒ 期望搭过去 ══')
  await setup()
  const tA = Date.now()
  const rA = await mc.bridge({ x: TARGET.x, y: TARGET.y, z: TARGET.z })
  await bot.waitForTicks(20)
  log(`  返回（${Date.now() - tA}ms）：${JSON.stringify(rA)}`)
  const deckA = [GAP.x1, GAP.x1 + 1, GAP.x2].map((x) => at(x, DECK, TARGET.z))
  const feetA = { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y + 0.001), z: Math.floor(bot.entity.position.z) }
  log(`  桥面三格：${deckA.join(' / ')}；人站在 ${P(feetA)}`)
  check('返回 ok:true', rA?.ok === true, `ok=${rA?.ok}`)
  check('三格桥面都铺上了', deckA.every((n) => n && n !== 'air'), deckA.join('/'))
  check('人真走到对岸', feetA.x === TARGET.x && feetA.z === TARGET.z, P(feetA))
  check('没被标成 stopped', !rA?.stopped, `stopped=${rA?.stopped} why=${rA?.why ?? '-'}`)

  // ── 场景 B：沟里放岩浆 ⇒ 应该**开铺前就停**，一块都不放 ──
  log('\n══ 场景 B：沟里有岩浆 ⇒ 期望危险停止、一块不放 ══')
  await setup({ lava: true })
  const rB = await mc.bridge({ x: TARGET.x, y: TARGET.y, z: TARGET.z })
  await bot.waitForTicks(10)
  log(`  返回：${JSON.stringify(rB)}`)
  const deckB = [GAP.x1, GAP.x1 + 1, GAP.x2].map((x) => at(x, DECK, TARGET.z))
  log(`  沟面三格：${deckB.join(' / ')}`)
  check('没有 ok:true（危险时不该硬上）', rB?.ok !== true, `ok=${rB?.ok}`)
  check('一块都没放', deckB.every((n) => n === 'air'), deckB.join('/'))
  check('说清了原因（提到岩浆/危险）', /岩浆|lava|危险|致命/.test(String(rB?.why ?? rB?.hint ?? '')), String(rB?.why ?? ''))

  // ── 场景 C：没料 ⇒ 应该报"先 mc_dig"，而不是空手硬铺 ──
  //   创造模式里 placeBlock 会自己"变"出方块 ⇒ 这条判据测不出来，跳过（并在结果里说明）
  if (bot.game?.gameMode === 'creative') {
    log('\n══ 场景 C：跳过 —— 现在是创造模式，placeBlock 会自动取物，"没材料"根本走不到 ══')
  } else {
    log('\n══ 场景 C：背包清空 ⇒ 期望报"先 mc_dig 挖料" ══')
    await setup({ give: 0 })
    let rC = null
    let errC = ''
    try { rC = await mc.bridge({ x: TARGET.x, y: TARGET.y, z: TARGET.z }) } catch (e) { errC = String(e?.message ?? e) }
    log(`  返回：${rC ? JSON.stringify(rC) : ''}${errC ? ` 抛错：${errC}` : ''}`)
    check('明确说了要先去挖料', /mc_dig|没有能当搭路料|材料/.test(`${errC} ${JSON.stringify(rC ?? {})}`), errC || JSON.stringify(rC))
  }

  await teardown()
  log(`\n══ 结果：${ok} ✅ / ${bad} ❌ ══`)
  process.exitCode = bad ? 1 : 0
} catch (e) {
  log(`\n❌ 出错：${e?.stack ?? e}`)
  process.exitCode = 1
} finally {
  await teardown()
  try { await mc.disconnect() } catch {}
  log('\n已断开')
}
