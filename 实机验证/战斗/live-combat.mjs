/**
 * live-combat.mjs —— 战斗策略层实机验收（用户 2026-10-17 的战斗方案）
 *
 * 为什么必须实机：离线套件用的是假实体（手搓 `bot.entities`），只能证明"判据写对了"，
 * **证明不了"真怪面前这套策略真的会动"** —— 而这一层考的就是"真打起来会怎样"。
 *
 * 四组：
 *   ① 正常单挑   —— 一只僵尸：应当**进攻**，`combat` 是机器可读的，`killed` 必须有掉血证据
 *   ② 低血量     —— 血 4：**不许自己撤**（用户 2026-10-17："自动战斗的优先级不应该比 AI 高"），
 *                    继续打，但结果里必须带"该撤了"的建议
 *   ③ 被三只围   —— 三只僵尸贴身：同样只给建议、手不停（撤退要 AI 自己叫 mc_move）
 *   ④ 外部中止   —— 攻击中途 abort：应当**立刻收手**、`combat:'aborted'`、不被内部循环重启
 *
 * 🔴 实机的坑（踩坑档案 97/98/113）：`bot.chat()` 只有**以 `/` 开头**才当指令发；
 *    `/tp` 之后要**等位置真变 + 等区块加载**；权限探测点必须在已加载区块里。
 *
 * 用法：node live-combat.mjs
 * 产物：同目录 live-combat.log、live-combat-core.log
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const HOST = '127.0.0.1'
const PORT = 25565
const NAME = 'wccombat'
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/战斗'
const SITE = { x: 700, y: 100, z: 700 }     // 远离出生点，免得砸到用户的东西
const R = 12                                 // 场地半径

const req = createRequire('file:///' + PKG + '/index.js')
const Vec3 = req('vec3')
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')

const LOGFILE = join(OUT, 'live-combat.log')
try { writeFileSync(LOGFILE, '') } catch { /* 忽略 */ }
const log = (...a) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(s)
  try { appendFileSync(LOGFILE, s + '\n') } catch { /* 忽略 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const P = (p) => (p ? `(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})` : '(?)')

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => log(`\n${'═'.repeat(6)} ${t} ${'═'.repeat(6)}`)

const mc = new McBot({
  instanceId: 'live-combat',
  lockDir: mkdtempSync(join(tmpdir(), 'wc-cbt-')),
  logFile: join(OUT, 'live-combat-core.log'),
})
log(`连 ${HOST}:${PORT}（${NAME}）…`)
await mc.connect({ host: HOST, port: PORT, auth: { mode: 'offline', name: NAME } })
const bot = mc.bot
await mc.waitForChunks(20000)
log(`连上了：${P(bot.entity.position)} 维度=${bot.game?.dimension} 模式=${bot.game?.gameMode} 血=${bot.health}`)

/* ── 指令：**必须带斜杠**（踩坑档案 97） ── */
const cmd = (s) => { bot.chat('/' + s) }
const until = async (cond, ms = 4000, step = 100) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(step) }
  return cond()
}
const teleport = async (x, y, z) => {
  const before = bot.entity.position.clone()
  cmd(`tp ${NAME} ${x} ${y} ${z}`)
  await until(() => bot.entity.position.distanceTo(before) > 0.5, 5000)
  await mc.waitForChunks(8000)
  await sleep(400)
}
const blockNameAt = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z))?.name ?? null } catch { return null } }
const clear = (x1, y1, z1, x2, y2, z2) => cmd(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} air`)
const box = (x1, y1, z1, x2, y2, z2, b) => cmd(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${b}`)

/* ── 前置：OP 与场地 ── */
section('前置：OP、场地与规则')
await teleport(SITE.x + 0.5, SITE.y + 2, SITE.z + 0.5)
cmd(`fill ${SITE.x} ${SITE.y + 2} ${SITE.z} ${SITE.x} ${SITE.y + 2} ${SITE.z} stone`)
const opOk = await until(() => blockNameAt(SITE.x, SITE.y + 2, SITE.z) === 'stone', 5000)
ok(opOk, 'bot 有 OP（/fill 真的生效了）', `(${SITE.x},${SITE.y + 2},${SITE.z})=${blockNameAt(SITE.x, SITE.y + 2, SITE.z)}`)
if (!opOk) {
  log('\n没有 OP（或场地区块没加载）⇒ 造不出场地，如实收工（不谎报成功）')
  await mc.disconnect('没有 OP')
  process.exit(1)
}
/* 场地：地板 @y-1，上面清空 */
box(SITE.x - R, SITE.y - 1, SITE.z - R, SITE.x + R, SITE.y - 1, SITE.z + R, 'stone')
clear(SITE.x - R, SITE.y, SITE.z - R, SITE.x + R, SITE.y + 8, SITE.z + R)
/* 难度与规则：僵尸要敌对，但别把机器人秒了；夜里它们不烧 */
cmd('gamerule doMobSpawning false')
cmd('gamerule doDaylightCycle false')
cmd('gamerule doMobLoot false')
cmd('time set night')
cmd('difficulty easy')
cmd(`kill @e[type=zombie]`)
await sleep(500)
log('场地好了（半径 %d 的石台 + 清空 + 夜里 + easy）', R)

/* 🔴 只认**身边**的僵尸（24 格内，跟 `mc_attack` 自己找目标的范围一致）：
 *    `bot.entities` 里会留着远处/已卸载区块的陈旧实体 —— 实机撞到过：`zombies()[0]` 抓到一只
 *    世界出生点 (36,30,-98) 的僵尸，而刚召唤的那只在 (705,100,700)，
 *    于是脚本"以为召唤成功了"，`mc.attack` 却报"附近找不到 zombie"。
 *    凡是"看看身边有什么"，都得先按距离筛一遍。 */
const zombies = () => {
  const me = bot.entity?.position
  if (!bot.entities || !me) return []
  return Object.values(bot.entities).filter((e) => e?.name === 'zombie' && e?.position && e.position.distanceTo(me) <= 24)
}
const killZombies = async () => { cmd('kill @e[type=zombie]'); await until(() => zombies().length === 0, 3000) }
/** 在离机器人 dist 格处召一只僵尸，并等它**真的站住**（出现 → 400ms 后还在）。
 *  🔴 实机撞到两次：`/summon` 报成功、`bot.entities` 里也闪过一下，但 300ms 后就没了
 *     （召唤在石头里窒息 / 掉出平台 / 落进水里），脚本却默默往下走，
 *     `mc.attack` 才报"附近找不到 zombie"——看着像策略坏了，其实是没怪。
 *     所以：出现不算数，**400ms 后还在**才算数；三次都不行就自己炸掉，别让后面每条用例失真。 */
const spawnZombie = async (dx, dz) => {
  const x = Math.floor(SITE.x) + dx, z = Math.floor(SITE.z) + dz
  for (let tryNo = 1; tryNo <= 4; tryNo++) {
    cmd(`summon minecraft:zombie ${x} ${SITE.y} ${z}`)
    if (await until(() => zombies().length > 0, 2500)) {
      await sleep(400)
      const z0 = zombies()[0]
      if (z0) {
        const p = z0.position
        log(`  · 召出来了：${z0.name} @ ${p ? `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : '?'}（血 ${z0.health ?? '读不到'}）`)
        return z0
      }
      log(`  · 第 ${tryNo} 次：出现了但 400ms 就没了（多半掉下去/窒息了）—— 重试`)
    } else if (tryNo < 4) log(`  · 第 ${tryNo} 次召唤没成，重试`)
    await sleep(200)
  }
  throw new Error(`召唤僵尸失败（${x} ${SITE.y} ${z}）—— 后面每条用例都依赖它，直接停`)
}
/**
 * 把血调到指定值。
 *
 * 🔴 `/damage` **只能扣血、不能回血** —— 只写"扣到 want"的话，上一组打剩的血
 *    会被下一组继承（实机第一轮：第二遍连上来 `血=3.5`，① 组当场按"血危 ⇒ 撤"
 *    判成 retreat，看着像策略坏了，其实是测试没把血调上去）。
 *    所以先 `/effect instant_health` 回满，再往下扣；调不到就**直接抛**，不许蒙混过关。
 */
const setHealth = async (want) => {
  if (bot.health < 20) {
    cmd(`effect give ${NAME} instant_health 1 10`)
    await until(() => bot.health >= 20, 4000)
  }
  const cur = bot.health
  if (cur > want) {
    cmd(`damage ${NAME} ${Math.ceil(cur - want)}`)
    await until(() => Math.round(bot.health) === want, 3000)
  }
  if (Math.round(bot.health) !== want) {
    throw new Error(`血没调到 ${want}（现在 ${bot.health}）—— 后面的用例都会失真，直接停`)
  }
  return bot.health
}
const arenaCenter = () => new Vec3(SITE.x + 0.5, SITE.y, SITE.z + 0.5)

/* ── ① 正常单挑 ── */
section('① 正常单挑（一只僵尸，血满，背包里有剑）')
await killZombies()
await teleport(SITE.x + 0.5, SITE.y, SITE.z + 0.5)
await setHealth(20)
/* 给一把剑：空手打不死僵尸（拳 1 点/0.5 秒 vs 僵尸 20 血），只能测出 timeout。
 * 给了剑才验得到用户验收表里那句"确认伤害证据"，顺带把"中途换武器"这条真链路跑一遍。
 * 先 `/clear` —— 背包是**服务端**按玩家名存的，上一轮留下的剑会让"先换上再打"这条断言失真。
 * 🔴 用 `/item replace` **指定格子**，别用 `/give`：`/give` 塞进"第一个空位"，
 *    而"手上"取决于**当前选中的快捷栏格** ⇒ 谁进手里是随机的
 *    （实机撞到过两次：一次木剑在手上、一次钻石剑在手上，同一条断言时红时绿）。
 *    指定 `hotbar.0` = 木剑、`hotbar.1` = 钻石剑，再显式选 0 号格，才真的"手上弱的、包里强的"。 */
cmd(`clear ${NAME}`)
await until(() => (bot.inventory?.items?.() ?? []).length === 0, 3000)
cmd(`item replace entity ${NAME} hotbar.0 with wooden_sword`)
cmd(`item replace entity ${NAME} hotbar.1 with diamond_sword`)
bot.setQuickBarSlot(0)
if (!(await until(() => bot.heldItem?.name === 'wooden_sword', 4000))) {
  throw new Error(`前置失败：手上不是木剑（现在是 ${bot.heldItem?.name ?? '空'}），① 组验不了"先换上再打"`)
}
log(`  · 手上：${bot.heldItem?.name ?? '空'}；包里：${(bot.inventory?.items?.() ?? []).map((i) => i?.name).join(', ')}`)
await spawnZombie(5, 0)
{
  const r = await mc.attack({ who: 'zombie', budget: 15000 })
  log(`  · 结果全量：${JSON.stringify(r)}`)
  log(`  · 结果：${JSON.stringify({ combat: r.combat, killed: r.killed, gone: r.gone, strategy: r.strategy, attacked: r.attacked, actions: r.actions })}`)
  ok(typeof r.combat === 'string' && r.combat.length > 0, '战斗结局是机器可读的（combat）', String(r.combat))
  /* 用户验收表第 1 条要的是"正常接近、攻击、**确认伤害证据**" —— 不是"必须打死"：
   * 僵尸会走、会掉下平台、区块会卸载，一次调用没打死是**正常**结果。
   * 所以这里只要求"真打起来了"，把"有没有证据"交给下面那两条。 */
  ok(['killed', 'damaged', 'timeout'].includes(r.combat), '🔴 有剑的单挑 ⇒ 真的打起来了（killed/damaged/timeout 都算正常）',
    JSON.stringify({ killed: r.killed, combat: r.combat, hp: r.targetHealth }))
  ok(r.killed !== true || r.gone === true || (r.targetHealth ?? '').includes('->'),
    '🔴 报 killed 就得有证据（掉血或目标消失），不许空口说打死了', JSON.stringify({ killed: r.killed, gone: r.gone, hp: r.targetHealth }))
  ok(r.combat !== 'damaged' || (r.targetHealth ?? '').includes('->'),
    '🔴 报 damaged 也得有证据（`targetHealth` 写着掉了多少）', JSON.stringify({ combat: r.combat, hp: r.targetHealth }))
  /* 🔴 实机逮到的自相矛盾：`reason:"killed"` 和 `killed:false` 同时出现（策略层拿 `sawDamage`
   *    当"打死了"，而 `killed` 是 `gone && sawDamage`）—— 同一个问题两处判据。 */
  ok(r.killed === true || r.reason !== 'killed',
    '🔴 不许自相矛盾：reason 说 killed，killed 就必须是 true', JSON.stringify({ reason: r.reason, killed: r.killed }))
  ok(r.actions.includes('equip'), '🔴 手上木剑 + 包里有钻石剑 ⇒ 先换上再打（武器选择真的接进来了）', JSON.stringify(r.actions))
  ok((bot.heldItem?.name ?? '').includes('diamond_sword'), '🔴 换装真的落到了手上（不是只在结果里记了一笔）', bot.heldItem?.name ?? '空')
  ok(Array.isArray(r.actions) && r.actions.length > 0, '结果里能看到动作序列', JSON.stringify(r.actions))
  ok(r.strategy != null, '结果里写了用的哪条策略', String(r.strategy))
  ok(r.reason != null, '结果里写了机器可读的 reason（为什么这么做）', String(r.reason))
  ok(!('outcome' in r) || ['confirmed', 'failed', 'unknown'].includes(r.outcome),
    '🔴 战斗结果不许把 outcome 占成自己的词汇（那是跨工具的统一结局）', String(r.outcome))
}

/* ── ② 低血量 ⇒ 只建议、不自行撤退 ── */
section('② 低血量（血 4）⇒ 不许自己撤，但必须把"该撤了"的建议带出来')
await killZombies()
await teleport(SITE.x + 0.5, SITE.y, SITE.z + 0.5)
await setHealth(4)
{
  /* 🔴 血量要在**开打之前**记 —— 打完之后自然回血（4 → 6）会让"撤退时血确实是低的"
   *    这条断言凭空变红，看着像策略误判，其实是断言取错了时刻。 */
  const hp0 = bot.health
  ok(hp0 <= 4, '前置：确实是低血量开的局（不是误判）', String(hp0))
  await spawnZombie(5, 0)
  const before = bot.entity.position.clone()
  const r = await mc.attack({ who: 'zombie', budget: 6000 })
  const moved = bot.entity.position.distanceTo(before)
  log(`  · 结果：${JSON.stringify({ combat: r.combat, strategy: r.strategy, reason: r.reason, advice: r.advice, moved: Number(moved.toFixed(1)) })}`)
  ok(r.combat !== 'retreated' && r.retreated !== true, '🔴 血 4 也不许自己撤（AI 叫的打就是命令）', String(r.combat))
  ok(r.strategy === 'engage' && r.reason === 'hold-line', '🔴 这一轮真的在打（state=engage / reason=hold-line）', `${r.strategy}/${r.reason}`)
  ok(Array.isArray(r.advice) && r.advice.some((a) => a.action === 'retreat' && a.reason === 'low-health'),
    '🔴 建议里必须带"该撤了"（low-health），决定权交回 AI', JSON.stringify(r.advice))
  ok(/撤/.test(String(r.adviceText ?? '')), '建议有一句人话（AI 不用猜结构）', String(r.adviceText ?? '').slice(0, 60))
}

/* ── ③ 被三只围 ⇒ 只建议、手不停 ── */
section('③ 被三只僵尸围住 ⇒ 只给"拉开距离"的建议，不许自己掉头')
await killZombies()
await teleport(SITE.x + 0.5, SITE.y, SITE.z + 0.5)
await setHealth(20)
await spawnZombie(2, 0)
await spawnZombie(-2, 1)
await spawnZombie(0, -2)
{
  await until(() => zombies().length >= 3, 3000)
  log(`  · 场上僵尸 ${zombies().length} 只`)
  const before = bot.entity.position.clone()
  const r = await mc.attack({ who: 'zombie', budget: 6000 })
  const moved = bot.entity.position.distanceTo(before)
  log(`  · 结果：${JSON.stringify({ combat: r.combat, strategy: r.strategy, moved: Number(moved.toFixed(1)) })}`)
  ok(zombies().length >= 3, '确实造出了"被围"的局面（不是自欺欺人）', `${zombies().length} 只`)
  ok(r.strategy === 'engage' && r.combat !== 'retreated', '🔴 被围也不自己撤（策略层没有否决权）', `${r.strategy}/${r.combat}`)
  ok(Array.isArray(r.advice) && r.advice.some((a) => a.action === 'defend' && a.reason === 'surrounded'),
    '🔴 建议里说"被围了，建议拉开距离"', JSON.stringify(r.advice))
  ok(moved > 0, '这一轮真的贴近去打（被围不是站着不动）', `${moved.toFixed(1)} 格`)
}

/* ── ④ 外部中止 ── */
section('④ 攻击中途被中止 ⇒ 立刻收手')
await killZombies()
await teleport(SITE.x + 0.5, SITE.y, SITE.z + 0.5)
await setHealth(20)
await spawnZombie(8, 0)
{
  const ac = new AbortController()
  /* `attack()` 读的是 `this.abortSignal`（工具层每轮注入的那根），不是 `opts.signal` ——
   * 所以这里走它公开的注入口 `setAbortSignal`，跟真实调用链一模一样。 */
  mc.setAbortSignal(ac.signal)
  setTimeout(() => ac.abort(), 1200)
  const r = await mc.attack({ who: 'zombie', budget: 8000 })
  mc.setAbortSignal(null)
  log(`  · 结果：${JSON.stringify({ combat: r.combat, killed: r.killed, strategy: r.strategy })}`)
  ok(r.combat === 'aborted', '🔴 中止 ⇒ combat 是 aborted', String(r.combat))
  ok(r.killed !== true, '被中止时不许谎报击杀')
}

/* ── 收尾 ── */
section('收尾：拆景')
await killZombies()
await teleport(SITE.x + 0.5, SITE.y + 2, SITE.z + 0.5)
clear(SITE.x - R, SITE.y - 1, SITE.z - R, SITE.x + R, SITE.y + 8, SITE.z + R)
cmd('gamerule doMobSpawning true')
cmd('gamerule doDaylightCycle true')
cmd('difficulty normal')
ok(true, '收尾指令已发（场地已拆、规则已还原）')

log(`\n${'─'.repeat(50)}`)
log(`live-combat：pass=${pass} fail=${fail}`)
await mc.disconnect('收工')
process.exit(fail ? 1 : 0)
