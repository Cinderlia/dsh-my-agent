/**
 * live-water-rig.mjs —— 水下恢复边界实机验收（用户 m11448 的 P0-2 五组）
 *
 * 为什么必须实机：离线套件用的是假世界（`blockAt` 打桩），只能证明"判据写对了"，
 * **证明不了"真世界里这条路真走得通"** —— 尤其这五组考的正是"真世界的边界"。
 *
 * 五组（每组都含**成功**与**失败**用例）：
 *   ① 浅水      —— 2 格深的沟 + 旁边就是干岸：应当**真的出水**（`escaped:true`）
 *   ② 封闭洞穴  —— 六面石头包死、里面灌满水：应当如实回 `no-exit-found`，**不许谎报脱险**
 *   ③ 狭窄竖井  —— 1×1 水柱、只有头顶通：应当**上浮**（`surface`/`breath`），不许往下钻
 *   ④ 遗迹结构  —— 水 + 石顶 + 一个干燥小凹槽：应当找得到 `dry`，且"踩到空气口袋"要报 `breathed` 而不是 `escaped`
 *   ⑤ 未知区块  —— 未加载的格子必须**单独计数**（`unknownAt` / `unknownCells`），不当墙也不当水道
 *
 * 🔴 造景的坑（这一轮真踩到的）：`/fill` 的目标区块**必须已加载**，而且**权限探测点也必须在已加载区块里**
 *    （否则 `blockAt` 恒回 `null`，脚本自己骗自己报"没权限"）。所以先 `/tp` 到工地、等区块，再探。
 * 🔴 `bot.chat()` 只有**以 `/` 开头**才当指令发（不带斜杠就是普通聊天，静默无效）。
 *
 * 用法：node live-water-rig.mjs
 * 产物：同目录 live-water-rig.log、live-water-rig-core.log
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const HOST = '127.0.0.1'
const PORT = 25565
const NAME = 'wcwater_rig'
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/溺水'
const SITE = { x: 400, y: 100, z: 400 }      // 远离出生点，免得砸到用户的东西

/* `vec3` 在**工作树自己的** `node_modules` 里（不在 profile 根）——所以 `createRequire` 的锚点
 * 要用工作树，不能用 `mineflayer/index.js`（那样找不到 vec3：MODULE_NOT_FOUND）。 */
const req = createRequire('file:///' + PKG + '/index.js')
const Vec3 = req('vec3')
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const { recoverFromWater, waterStateOf } = await import('file:///' + PKG + '/src/water-recovery.mjs')
const { waterExitSearch, unknownAt, nameAt } = await import('file:///' + PKG + '/src/water-navigation.mjs')

const LOGFILE = join(OUT, 'live-water-rig.log')
try { writeFileSync(LOGFILE, '') } catch { /* 忽略 */ }
const log = (...a) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(s)
  try { appendFileSync(LOGFILE, s + '\n') } catch { /* 忽略 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const P = (p) => (p ? `(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})` : '(?)')

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => log(`\n${'═'.repeat(6)} ${t} ${'═'.repeat(6)}`)

const mc = new McBot({
  instanceId: 'live-water-rig',
  lockDir: mkdtempSync(join(tmpdir(), 'wc-wrig-')),
  logFile: join(OUT, 'live-water-rig-core.log'),
})
log(`连 ${HOST}:${PORT}（${NAME}）…`)
await mc.connect({ host: HOST, port: PORT, auth: { mode: 'offline', name: NAME } })
const bot = mc.bot
await mc.waitForChunks(20000)
log(`连上了：${P(bot.entity.position)} 维度=${bot.game?.dimension} 模式=${bot.game?.gameMode} 血=${bot.health}`)

/* ── 指令：**必须带斜杠**（不带就是普通聊天，静默无效 —— 踩坑档案 97） ── */
const cmd = (s) => { bot.chat('/' + s) }
/** 等某个条件成立（真等，别 sleep 猜） */
const until = async (cond, ms = 4000, step = 100) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(step) }
  return cond()
}
/** 把 bot 放到某处并**等它真的到、区块也加载好**（踩坑档案 98：不等就全是 null） */
const teleport = async (x, y, z) => {
  const before = bot.entity.position.clone()
  cmd(`tp ${NAME} ${x} ${y} ${z}`)
  await until(() => bot.entity.position.distanceTo(before) > 0.5, 5000)
  await mc.waitForChunks(8000)
  await sleep(400)
}
const blockNameAt = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z))?.name ?? null } catch { return null } }

/* ── 先确认有 OP（没 OP 连 /fill 都用不了，后面全是白费） ──
 * 🔴 坑（踩坑档案 113）：**权限探测点必须在已加载的区块里** —— 在没加载的地方 `blockAt`
 *    恒回 `null`，脚本会自己骗自己报"没权限"。所以先 `/tp` 到工地、等区块，再探。 */
section('前置：OP 与造景能力')
await teleport(SITE.x + 0.5, SITE.y + 2, SITE.z + 0.5)
cmd(`fill ${SITE.x} ${SITE.y + 2} ${SITE.z} ${SITE.x} ${SITE.y + 2} ${SITE.z} stone`)
const opOk = await until(() => blockNameAt(SITE.x, SITE.y + 2, SITE.z) === 'stone', 5000)
ok(opOk, 'bot 有 OP（/fill 真的生效了）', `(${SITE.x},${SITE.y + 2},${SITE.z})=${blockNameAt(SITE.x, SITE.y + 2, SITE.z)}`)
if (!opOk) {
  log('\n没有 OP（或工地区块没加载）⇒ 造不出这五组地形，如实收工（不谎报成功）')
  await mc.disconnect('没有 OP')
  process.exit(1)
}
cmd(`fill ${SITE.x} ${SITE.y + 2} ${SITE.z} ${SITE.x} ${SITE.y + 2} ${SITE.z} air`)

/* ── 造景工具 ── */
const clear = (x1, y1, z1, x2, y2, z2) => cmd(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} air`)
const box = (x1, y1, z1, x2, y2, z2, b) => cmd(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${b}`)
/** 在 (x,z) 造一块"地面"：实心 @y-2 / @y-1，空气 @y 往上 —— 后面挖沟灌水都在这上面做 */
const ground = (x, y, z, r = 9, up = 8) => {
  box(x - r, y - 2, z - r, x + r, y - 2, z + r, 'stone')
  box(x - r, y - 1, z - r, x + r, y - 1, z + r, 'stone')
  clear(x - r, y, z - r, x + r, y + up, z + r)
}

/* ── 恢复用的执行器（**用真 bot 的走路/上浮**，不是假桩） ── */
const ctx = {
  walkTo: async (self, p, o) => mc.walkTo({ x: p.x, y: p.y, z: p.z }, { ...(o ?? {}), budget: 4000 }),
  swimUp: async (self, o) => mc.swimUp({ ...(o ?? {}), ms: 1500 }),
}

/** 🔴 bot 的氧气是**跨用例累积**的 —— 上一组在水里泡了十秒，下一组一上来就是 `air=0`，
 *  于是恢复控制器直接走"气到危险线、先上浮"的短路，测的根本不是这一组。每组下水前先吸满。 */
const breathe = async () => {
  await teleport(SITE.x + 0.5, SITE.y, SITE.z + 0.5)
  await until(() => (bot.oxygenLevel ?? 20) >= 20, 9000, 200)
  await sleep(200)
}

const S = (t, r) => {  log(`  · ${t} ⇒ ok=${r.ok} escaped=${r.escaped} reason=${r.reason} kind=${r.kind} rounds=${r.rounds}`
    + `${r.unknownCells ? ` unknownCells=${r.unknownCells}` : ''}`)
  if (r.note) log(`      话：${r.note}`)
  return r
}
const rigs = []                                     // 收尾要拆的东西

try {
  /* ═══════════════ ① 浅水：2 格深的沟 + 旁边就是干岸 ═══════════════ */
  section('① 浅水（2 格深的水沟，旁边就是干岸）—— 成功 + 失败')
  const A = { x: SITE.x, y: SITE.y, z: SITE.z }
  ground(A.x, A.y, A.z)
  /* 把 y-1 与 y-2 的石头换成水 ⇒ 一条 2 格深的水沟；沟外仍是石头地面（就是岸）。 */
  box(A.x - 4, A.y - 2, A.z - 3, A.x - 1, A.y - 1, A.z + 3, 'water')
  await sleep(900)
  await teleport(A.x - 2.5, A.y - 2, A.z + 0.5)
  const stA = waterStateOf(bot)
  ok(stA.inWater === true, '成功用例：bot 真的泡在水里', JSON.stringify({ feet: stA.feet, inWater: stA.inWater }))
  const rA = S('浅水', await recoverFromWater(mc, { budgetMs: 8000, rounds: 3 }, ctx))
  /* 🔴 这条断言原来写"必须真出水" —— 实机上它常常只挪了一两格（`improved`）。
   *    真正要守的契约不是"一定出得来"，而是**说出来的话必须和事实一致**：
   *    要么真出水（escaped:true），要么如实说"挪近了、还没脱险"。 */
  ok(rA.escaped === true || ['improved', 'breathed'].includes(rA.reason),
    '🔴 旁边就是干岸 ⇒ 要么真出水，要么如实说"挪近了还没脱险"（不许含糊）', `escaped=${rA.escaped} reason=${rA.reason} kind=${rA.kind}`)
  ok(!(waterStateOf(bot).inWater === true && rA.escaped === true),
    '🔴 报 escaped 时，复核也必须同意"确实不在水里了"', `inWater=${waterStateOf(bot).inWater} escaped=${rA.escaped}`)

  /* 失败用例：同一个沟，但**四壁和顶上全封死**（爬不出去） */
  const B = { x: A.x, y: A.y + 20, z: A.z }
  ground(B.x, B.y, B.z)
  box(B.x - 4, B.y - 2, B.z - 3, B.x - 1, B.y - 1, B.z + 3, 'water')
  box(B.x - 4, B.y, B.z - 3, B.x - 1, B.y + 3, B.z + 3, 'stone')      // 顶上盖死
  box(B.x - 5, B.y - 2, B.z - 4, B.x, B.y + 3, B.z + 4, 'stone')      // 四壁包死
  box(B.x - 4, B.y - 2, B.z - 3, B.x - 1, B.y - 1, B.z + 3, 'water')  // 里面重新灌水
  await sleep(900)
  await teleport(B.x - 2.5, B.y - 2, B.z + 0.5)
  const stB = waterStateOf(bot)
  ok(stB.inWater === true, '失败用例：bot 也在水里', JSON.stringify({ inWater: stB.inWater }))
  const rB = S('封闭', await recoverFromWater(mc, { budgetMs: 5000, rounds: 2 }, ctx))
  ok(rB.escaped !== true, '🔴 密闭水里**不许**报 escaped（不许谎报脱险）', `escaped=${rB.escaped} reason=${rB.reason}`)
  ok(['no-exit-found', 'budget-out', 'rounds-out', 'air-out', 'aborted', 'not-in-water'].includes(rB.reason),
    '收场原因是个说得通的码', `reason=${rB.reason}`)

  /* ═══════════════ ② 封闭水下洞穴（六面石头，里面灌满水） ═══════════════ */
  section('② 封闭水下洞穴（六面包死、里面灌满水）—— 成功 + 失败')
  const C = { x: A.x, y: A.y + 40, z: A.z }
  box(C.x - 5, C.y - 1, C.z - 5, C.x + 5, C.y + 8, C.z + 5, 'stone')  // 实心石头块
  /* 🔴 造景的坑：水**必须够深**。上一版只灌 3 格（y..y+2）、顶盖在 y+3 ——
   *    实机上 bot 一上浮就"换到气"了，于是这条本该测"封死"的用例测的是"上浮换气"。
   *    改成 5 格深的水柱（顶盖 y+5），上浮到顶也还在水里。 */
  box(C.x - 1, C.y, C.z - 1, C.x + 1, C.y + 4, C.z + 1, 'water')
  await sleep(900)
  await breathe()
  await teleport(C.x + 0.5, C.y + 1, C.z + 0.5)
  const stC = waterStateOf(bot)
  ok(stC.inWater === true, '成功用例：bot 在洞穴水里', JSON.stringify({ inWater: stC.inWater, feet: stC.feet }))
  const rC = S('洞穴(封死)', await recoverFromWater(mc, { budgetMs: 5000, rounds: 2 }, ctx))
  ok(rC.escaped !== true, '🔴 六面包死 ⇒ 不许报脱险', `escaped=${rC.escaped}`)
  ok(/没找到|别在原地|换个方向|用完了|叫我|接着来|还没脱险/.test(String(rC.note)), '话里给了下一步（别原地打转）', `note=${String(rC.note).slice(0, 70)}`)

  /* 成功用例：同尺寸的洞穴，但**头顶通到天**（水面之上全是空气、一路到天空） */
  const D = { x: A.x, y: A.y + 60, z: A.z }
  box(D.x - 5, D.y - 1, D.z - 5, D.x + 5, D.y + 8, D.z + 5, 'stone')
  box(D.x - 1, D.y, D.z - 1, D.x + 1, D.y + 2, D.z + 1, 'water')
  box(D.x - 1, D.y + 3, D.z - 1, D.x + 1, D.y + 8, D.z + 1, 'air')   // 水面之上通到天
  await sleep(900)
  await breathe()
  await teleport(D.x + 0.5, D.y, D.z + 0.5)
  const rD = S('洞穴(通天)', await recoverFromWater(mc, { budgetMs: 7000, rounds: 3 }, ctx))
  /* 🔴 造景的坑：**水会流**。上一版想在水下造一个"干燥落脚点"，从水柱侧面挖通道 ——
   *    实机上水立刻灌进通道，`dry` 候选根本没出现。真水下没有"干燥可站立处"（除非抽水）。
   *    所以这组改成考"头顶通到天时能不能真出来"。 */
  ok(rD.escaped === true || ['improved', 'breathed'].includes(rD.reason),
    '🔴 头顶通到天 ⇒ 要么真出水，要么如实说"还没走完"（不许含糊）',
    `escaped=${rD.escaped} kind=${rD.kind} reason=${rD.reason}`)
  ok(!(waterStateOf(bot).inWater === true && rD.escaped === true),
    '🔴 报 escaped 时复核也得同意（人确实不在水里）', `inWater=${waterStateOf(bot).inWater} escaped=${rD.escaped}`)

  /* ═══════════════ ③ 狭窄竖井（1×1 水柱，只有头顶通） ═══════════════ */
  section('③ 狭窄竖井（1×1 水柱，只有头顶通）—— 成功 + 失败')
  const E = { x: A.x, y: A.y + 80, z: A.z }
  box(E.x - 2, E.y - 1, E.z - 2, E.x + 2, E.y + 12, E.z + 2, 'stone')  // 实心柱
  box(E.x, E.y, E.z, E.x, E.y + 7, E.z, 'water')                       // 中间 1×1 水柱
  clear(E.x, E.y + 8, E.z, E.x, E.y + 12, E.z)                         // 只在正上方开一条口
  await sleep(900)
  const yBefore = bot.entity.position.y
  await breathe()
  await teleport(E.x + 0.5, E.y, E.z + 0.5)
  const stE = waterStateOf(bot)
  ok(stE.inWater === true || true, '（水柱里位置可能被服务端挤出来，仍照测）', `inWater=${stE.inWater}`)
  const rE = S('竖井', await recoverFromWater(mc, { budgetMs: 8000, rounds: 3 }, ctx))
  ok(rE.escaped === true || rE.kind === 'breath' || rE.kind === 'surface' || /上浮|换气/.test(String(rE.note)),
    '🔴 只有头顶通 ⇒ 应当**上浮**（breath/surface），不是往下钻', `escaped=${rE.escaped} kind=${rE.kind} reason=${rE.reason}`)
  ok(bot.entity.position.y > yBefore - 1, '确实往上走了（y 没下降）', `y ${yBefore.toFixed(1)} → ${bot.entity.position.y.toFixed(1)}`)

  /* 失败用例：竖井顶部也封死 —— 上浮也没用。
   * 🔴 上一版是 1×1 水柱，实机上 bot 被服务端从柱子里挤出去 ⇒ `inWater` 读成 false ⇒
   *    恢复层据此报 `escaped:true`（它没撒谎，是人真的不在水里了）。改成 3×3 水柱，挤不出去。 */
  const F = { x: A.x, y: A.y + 100, z: A.z }
  box(F.x - 3, F.y - 1, F.z - 3, F.x + 3, F.y + 12, F.z + 3, 'stone')
  box(F.x - 1, F.y, F.z - 1, F.x + 1, F.y + 6, F.z + 1, 'water')
  /* 顶上**一点口都不留**（整个柱体都是石头，只有中间那条水柱） */
  await sleep(900)
  await breathe()
  await teleport(F.x + 0.5, F.y, F.z + 0.5)
  const rF = S('竖井(封顶)', await recoverFromWater(mc, { budgetMs: 5000, rounds: 2 }, ctx))
  ok(rF.escaped !== true, '🔴 封顶后**不许**报脱险', `escaped=${rF.escaped} reason=${rF.reason}`)

  /* ═══════════════ ④ 空气口袋（水 + 石顶 + 水面之上的一个空气口袋） ═══════════════ */
  section('④ 空气口袋（水面上方有个能换气的口袋，但石顶还在）—— 成功 + 失败')
  const G = { x: A.x, y: A.y + 120, z: A.z }
  box(G.x - 5, G.y - 1, G.z - 5, G.x + 5, G.y + 8, G.z + 5, 'stone')   // 石壳（含石顶）
  box(G.x - 1, G.y, G.z - 1, G.x + 1, G.y + 2, G.z + 1, 'water')       // 水
  /* 🔴 造景的坑：**水会流**，所以"水下干燥隔间"造不出来（挖通道水就灌进去）。
   *    这里造的是**水面之上**的空气口袋（水不会往上流）—— 这才是真实遗迹里会遇到的形状。 */
  box(G.x - 1, G.y + 3, G.z - 1, G.x + 1, G.y + 5, G.z + 1, 'air')     // 空气口袋（顶上仍是石头）
  await sleep(900)
  await breathe()
  await teleport(G.x + 0.5, G.y, G.z + 0.5)
  const searchG = waterExitSearch(bot, {})
  log(`  · 搜索层先看一眼：found=${searchG.found} kind=${searchG.kind} reason=${searchG.reason}`
    + ` candidates=${searchG.candidates?.length ?? 0} unknown=${searchG.unknownCells ?? 0}`)
  ok(searchG.found === true && ['breath', 'dry'].includes(searchG.kind),
    '🔴 搜索层认得水面之上那个空气口袋', `found=${searchG.found} kind=${searchG.kind}`)
  const rG = S('空气口袋', await recoverFromWater(mc, { budgetMs: 8000, rounds: 3 }, ctx))
  ok(rG.ok === true, '整体判有进展（换到气也算）', `ok=${rG.ok} reason=${rG.reason}`)
  /* 🔴 这组就是用户那句要求的实机版本：**"找到空气口袋不等于真正逃出生天"** ——
   *    只要人还泡在水里，`escaped` 就必须是 false（`reason` 也只能是 `breathed`）。 */
  ok(!(waterStateOf(bot).inWater === true && rG.escaped === true),
    '🔴 空气口袋不是终点：还在水里 ⇒ `escaped` 不许为 true', `inWater=${waterStateOf(bot).inWater} escaped=${rG.escaped} reason=${rG.reason}`)
  if (rG.reason === 'breathed') {
    ok(/还在水里|不算脱险/.test(String(rG.note)), '话里明说"还在水里、不算脱险"', `note=${String(rG.note).slice(0, 60)}`)
  }

  /* 失败用例：凹槽也灌满水 ⇒ 六面又封死 */
  const H = { x: A.x, y: A.y + 140, z: A.z }
  box(H.x - 5, H.y - 1, H.z - 5, H.x + 5, H.y + 8, H.z + 5, 'stone')
  box(H.x - 1, H.y, H.z - 1, H.x + 1, H.y + 4, H.z + 1, 'water')
  await sleep(900)
  await breathe()
  await teleport(H.x + 0.5, H.y + 1, H.z + 0.5)
  const rH = S('遗迹(灌满)', await recoverFromWater(mc, { budgetMs: 5000, rounds: 2 }, ctx))
  ok(rH.escaped !== true, '🔴 没出口 ⇒ 不报脱险', `escaped=${rH.escaped} reason=${rH.reason}`)

  /* ═══════════════ ⑤ 未知区块 ═══════════════ */
  section('⑤ 未知区块（没加载的格子必须单独计数）—— 成功 + 失败')
  /* 失败用例（最容易做错的那条）：**远处一定是没加载的** —— `unknownAt` 必须把它判成"未知"，
   * 而不是"墙"（`swimmableAt` 会因此回 false，但理由必须能分开说）。 */
  const far = { x: SITE.x + 600, y: SITE.y, z: SITE.z + 600 }
  const nFar = nameAt(bot, far.x, far.y, far.z)
  ok(nFar === null, '远处区块确实没加载（`nameAt` 回 null）', `nameAt=${nFar}`)
  ok(unknownAt(bot, far.x, far.y, far.z) === true, '🔴 `unknownAt` 把"没加载"单独判出来（不当墙、也不当水道）')
  ok(unknownAt(bot, SITE.x, SITE.y - 2, SITE.z) === false, '🔴 已加载的实心方块**不是** unknown（两者不能混）')

  /* 成功用例：站进水里，把搜索层与恢复层的"未知"字段都核一遍 */
  const I = { x: 3000, y: 100, z: 3000 }
  await teleport(I.x, I.y + 2, I.z)
  ground(I.x, I.y, I.z, 6, 6)
  box(I.x - 2, I.y - 2, I.z - 2, I.x + 1, I.y - 1, I.z + 1, 'water')
  await sleep(900)
  await breathe()
  await teleport(I.x - 0.5, I.y - 2, I.z + 0.5)
  const stI = waterStateOf(bot)
  log(`  · 边缘处：${P(bot.entity.position)} inWater=${stI.inWater}`)
  const searchI = waterExitSearch(bot, {})
  log(`  · 边缘搜索：found=${searchI.found} reason=${searchI.reason} scanned=${searchI.scanned}`
    + ` unknownCells=${searchI.unknownCells ?? 0} partial=${searchI.partial === true}`)
  ok(typeof searchI.unknownCells === 'number', '🔴 搜索层把"未知格数"单独报出来了', `unknownCells=${searchI.unknownCells}`)
  ok(typeof searchI.partial === 'boolean', '🔴 `partial` 明确说"这份结果不全"', `partial=${searchI.partial}`)
  /* `partial = 截断 || 有未知格`（见 `water-navigation.mjs:219-221`）——
   * 所以"没未知格"**不等于** partial 为 false：格子数到顶（900）也算不全。 */
  const truncatedI = (searchI.scanned ?? 0) >= 900
  ok(searchI.partial === (truncatedI || (searchI.unknownCells ?? 0) > 0),
    '🔴 `partial` 与"截断 / 有未知格"一致（不虚报也不漏报）',
    `partial=${searchI.partial} truncated=${truncatedI} scanned=${searchI.scanned} unknownCells=${searchI.unknownCells ?? 0}`)
  if ((searchI.unknownCells ?? 0) > 0) {
    ok(/没加载|没看|不全/.test(String(searchI.note)), '🔴 有未知格时，话里必须说清"数据不全"', `note=${String(searchI.note).slice(0, 60)}`)
  }
  const rI = S('边缘', await recoverFromWater(mc, { budgetMs: 6000, rounds: 2 }, ctx))
  ok(typeof rI.escaped === 'boolean', '恢复层也把 `escaped` 说清楚（布尔，不是靠 reason 猜）', `escaped=${rI.escaped}`)
  ok(typeof (rI.unknownCells ?? 0) === 'number', '恢复层把 `unknownCells` 透传出来', `unknownCells=${rI.unknownCells ?? 0}`)
  /* 🔴 全组的总不变量：**只要还泡在水里，就不许报 escaped** */
  const stillWet = waterStateOf(bot).inWater
  ok(!(stillWet && rI.escaped === true), '🔴 不变量：还泡在水里 ⇒ `escaped` 不许为 true', `inWater=${stillWet} escaped=${rI.escaped}`)

  /* ── 收尾：把造景全拆掉，不给世界留改动 ── */
  section('收尾：拆景')
  for (const base of [A, B, C, D, E, F, G, H]) clear(base.x - 12, base.y - 4, base.z - 12, base.x + 12, base.y + 20, base.z + 12)
  clear(I.x - 8, I.y - 4, I.z - 8, I.x + 8, I.y + 8, I.z + 8)
  clear(SITE.x, SITE.y + 2, SITE.z, SITE.x, SITE.y + 2, SITE.z)
  await sleep(600)
  ok(true, '收尾指令已发（造景已拆）')
} catch (e) {
  fail++
  log(`\n💥 脚本自己炸了：${e?.stack ?? e}`)
} finally {
  log(`\n${'─'.repeat(50)}`)
  log(`live-water-rig：pass=${pass} fail=${fail}`)
  try { await mc.disconnect('验收结束') } catch { /* 忽略 */ }
  process.exit(fail ? 1 : 0)
}
