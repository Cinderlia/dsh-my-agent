/* 三段式感知实机验证：真服上调一次 `mc_observe`，看它给的是不是
 *   ① 我看到（图里数出来的）② 程序检测到（游戏数据）③ 不确定（别把推测当事实）
 * 并且证明**两套眼睛能互相印证**（渲染内核的准星射线 vs prismarine-world 的独立 raycast）。
 *
 * 用法：node live-percept.mjs [账号名]        （默认 wcpercept_live）
 *
 * 为什么要它（用户 2026-10-08 的要求）："不要只让 AI 看截图，也不要只让 AI 读取方块坐标…
 * 让 AI 能判断我看到什么、程序实际检测到什么、哪些信息不确定。"
 * 离线套件（tools/check-mc-observe-host.mjs）只能证明"装配对"，证明不了**真服上射线一致、
 * 实体/血量/饥饿读得出来**——那份假 bot 的 `entities` 是对象映射、`world` 没有 `raycast`，
 * 所以那两条探针在套件里是"如实报没跑出来"。这里补上真数据。
 *
 * 判据：
 *   ① 三段标题都在；
 *   ② `percept.seen.crosshair.block` 与 `out.crosshair.block` 一致（图里数出来的 == 渲染给的）；
 *   ③ `percept.sensed.ray.block` 非空，且**与渲染准星同名**（两套独立实现互相印证）；
 *   ④ `percept.sensed.entities` 是数组、里面有玩家（真服上玩家常在 24 格内）；
 *   ⑤ 生命/饥饿/坐标是真的（和 `out.*` 一致）；
 *   ⑥ 不确定清单非空，且点出"客户端预测""按方块数据重建"；
 *   ⑦ `percept:false` 退回旧的一段式摘要；`entities:false` 两段都如实说"没收集实体"；
 *   ⑧ 图真的落盘（PNG 签名正确）。
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NAME = process.argv[2] ?? 'wcpercept_live'
const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const viewExt = await import('file:///' + PKG + '/extensions/mc_observe.mjs')

const wsDir = mkdtempSync(join(tmpdir(), 'wc-percept-live-'))
const registered = new Map()
const sessions = new Map()
const saved = []
const fakeHost = {
  ctx: {
    tools: { register: (d) => registered.set(d.name, d), guard: () => {}, get: () => undefined },
    on: () => () => {},
    get: (svc) => (svc === 'attachments'
      ? { saveImage: async ({ data, mediaType, name }) => { const a = { id: 'att-' + saved.length, mediaType, name, bytes: data?.length ?? 0 }; saved.push(a); return a } }
      : undefined),
    logger: { info: () => {}, warn: () => {} },
  },
  config: {},
  registry: { peek: (id) => sessions.get(String(id)), listSessions: () => [] },
  asTool: (s) => s,
  getSession: (e) => sessions.get(String(e?.agent?.id)),
  memory: {}, memoryFor: () => ({}),
  workspaceOf: (agent) => agent?.session?.header?.cwd ?? null,
  logLine: (l) => console.log('[log]', l),
  Watchdog: class {}, ensureWatchdog: () => {},
}
await viewExt.apply(fakeHost)
const viewSpec = registered.get('mc_observe')

const mc = new McBot({ instanceId: 'live-percept', lockDir: mkdtempSync(join(tmpdir(), 'wc-percept-lock-')) })
sessions.set('P1', { agentId: 'P1', bot: mc })
const EXEC = { agent: { id: 'P1', session: { header: { cwd: wsDir } } } }
const view = (a) => viewSpec.execute(a, EXEC)

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const say = (s) => console.log('\n=== ' + s + ' ===')
const short = (x, n = 300) => { const s = typeof x === 'string' ? x : JSON.stringify(x); return s.length > n ? s.slice(0, n) + '…' : s }

await mc.connect({ host: '127.0.0.1', port: 25565, auth: { mode: 'offline', name: NAME } })
await mc.waitForChunks(20_000)
const bot = mc.requireBot()
const Vec3 = bot.entity.position.constructor
bot.on('message', (m) => { const s = m.toString().trim(); if (s) console.log('[chat]', s) })

say(`0 环境（${NAME} @ ${bot.entity.position.floored()}）`)
console.log('  背包：', bot.inventory.items().map((i) => `${i.name}×${i.count}`).join(' ') || '（空）')
console.log('  玩家：', Object.values(bot.players ?? {}).map((p) => p.username).join(' ') || '（就我一个）')

// 低头看脚下那块，保证准星一定压着方块（不然会测到"指着天空"那条分支）
await bot.look(bot.entity.yaw, -1.2, true)
await new Promise((r) => setTimeout(r, 300))

say('1 默认（三段式感知）')
const out = await view({ width: 192, height: 108, distance: 24 })
console.log(out.text.split('\n').map((l) => '  | ' + l).join('\n'))
const P = out.percept ?? {}

ok(typeof out.text === 'string' && out.text.includes('👁 **我看到**'), 'text 第一段是"我看到"')
ok(out.text.includes('🎯 **程序检测到**'), 'text 第二段是"程序检测到"')
ok(out.text.includes('⚠️ **不确定**'), 'text 第三段是"不确定"')
ok(out.text.split('\n').length <= 16, '整段不超过 16 行（不占 token）', String(out.text.split('\n').length))

ok(P.seen && P.sensed && Array.isArray(P.uncertain), 'percept 结构齐（seen / sensed / uncertain）')
ok(P.seen?.crosshair && typeof P.seen.crosshair === 'object' && P.seen.crosshair.block === out.crosshair?.block,
  '图里数出来的准星方块 == 渲染给的准星方块',
  `seen=${short(P.seen?.crosshair)} out=${short(out.crosshair && { block: out.crosshair.block, distance: out.crosshair.distance })}`)

say('2 两套射线互相印证（渲染内核 castRay vs prismarine-world raycast）')
console.log('  程序射线：', short(P.sensed?.ray))
console.log('  渲染准星：', short(out.crosshair && { block: out.crosshair.block, distance: out.crosshair.distance }))
ok(P.sensed?.ray && !P.sensed.ray.error, '程序射线跑出来了（prismarine-world raycast 在真服可用）', short(P.sensed?.ray))
ok(Boolean(P.sensed?.ray?.block), '程序射线打到了方块（低头看着地面）', String(P.sensed?.ray?.block))
ok(P.sensed?.ray?.block === out.crosshair?.block, '两套射线打到**同一个方块**（互证）',
  `程序=${P.sensed?.ray?.block} 渲染=${out.crosshair?.block}`)
ok(out.text.includes('和渲染一致'), 'text 里点名"和渲染一致"')

say('3 程序侧实体 / 生命 / 饥饿 / 坐标')
const ents = P.sensed?.entities
console.log('  实体：', short(ents, 500))
console.log('  计数：', short(P.sensed?.counts), ' 总：', String(P.sensed?.total))
ok(Array.isArray(ents), 'sensed.entities 是数组（走 core 的 entities()，同一份判据）', Array.isArray(ents) ? `${ents.length} 个` : short(ents))
const names = (ents ?? []).map((x) => x.name)
// 真服上玩家不一定在 24 格内 ⇒ 钉"半径内的**别人**一个都不能漏"，而不是钉某个名字
// （🔴 第一版忘了排除自己：`bot.entities` 里我自己的实体也带 `username`，于是报"漏了 wcpercept_live"）
const nearbyPlayers = Object.values(bot.entities ?? {}).filter((e) => e?.username && e?.position &&
  e.id !== bot.entity.id && e.position.distanceTo(bot.entity.position) <= 24)
ok(nearbyPlayers.every((p) => names.includes(p.username) || (ents ?? []).some((x) => x.player && x.name === p.username)),
  '半径内每个玩家都出现在 sensed.entities 里（不漏人）',
  `附近玩家 ${nearbyPlayers.map((p) => p.username).join(',') || '（无）'} ｜ 列表 ${names.join(',') || '（空）'}`)
ok(typeof P.sensed?.health === 'number' && typeof P.sensed?.food === 'number' && P.sensed.health === out.health,
  '生命/饥饿是真的（与 status 一致）', `血 ${P.sensed?.health} 饥饿 ${P.sensed?.food}`)
ok(P.sensed?.position && P.sensed.position.x === out.position.x && P.sensed.position.y === out.position.y,
  'sensed.position 与 out.position 一致', short(P.sensed?.position))
ok(out.text.includes('格内实体：'), 'text 里给了"半径内实体：敌对 x ｜ 玩家 y ｜ 其它 z"')

say('4 不确定清单')
P.uncertain.forEach((t, i) => console.log(`  ${'①②③④⑤⑥⑦⑧⑨'[i] ?? '·'} ${t}`))
ok(P.uncertain.length > 0, '不确定清单非空', `${P.uncertain.length} 条`)
ok(P.uncertain.some((t) => /客户端预测/.test(t)), '点名"方块世界是客户端预测的"（挖了可能复原）')
ok(P.uncertain.some((t) => /重建/.test(t)), '说明图是按方块数据重建的、不是真实画面')

say('5 图真的落盘了')
console.log('  文件：', out.image?.file, ' 大小：', String(out.image?.bytes), ' 内联：', String(out.image?.attachment?.mediaType))
ok(Boolean(out.image?.file) && existsSync(join(wsDir, out.image.file)), 'PNG 落在工作区里', String(out.image?.file))
if (out.image?.file) {
  const buf = readFileSync(join(wsDir, out.image.file))
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  ok(sig.every((b, i) => buf[i] === b), '落盘的是真 PNG（签名正确）', buf.slice(0, 8).toString('hex'))
  const keep = join(tmpdir(), 'wc-percept-shot.png')
  try { readFileSync(join(wsDir, out.image.file)); await import('node:fs').then((fs) => fs.copyFileSync(join(wsDir, out.image.file), keep)) } catch {}
  console.log('  想看图：', keep)
}
ok(saved.length >= 1, '宿主 attachments.saveImage 被调用', String(saved.length))

say('6 开关：percept:false 退回旧摘要')
const outPlain = await view({ width: 128, height: 72, distance: 24, percept: false })
console.log(outPlain.text.split('\n').map((l) => '  | ' + l).join('\n'))
ok(outPlain.percept === undefined, 'percept:false 不产出感知块')
ok(outPlain.text.includes('👁 第一人称') && outPlain.text.includes('🎯 准星') && outPlain.text.includes('🧱 画面'),
  'percept:false 退回旧的一段式摘要（标题/准星/画面）')

say('7 开关：entities:false 两段都如实说"没收集实体"')
const outNoEnt = await view({ width: 128, height: 72, distance: 24, entities: false })
console.log(outNoEnt.text.split('\n').map((l) => '  | ' + l).join('\n'))
ok(outNoEnt.text.includes('这次没收集实体'), 'text 里如实说"这次没收集实体"')
ok(outNoEnt.percept?.sensed?.entities === null && (outNoEnt.percept?.seen?.entities ?? []).length === 0,
  '感知块里实体为空（不是"0 个实体"这种假话）')
ok((outNoEnt.percept?.uncertain ?? []).some((t) => /entities:false/.test(t)), '不确定清单里点出 entities:false')

say('8 收尾')
console.log('  最终位置：', bot.entity.position.floored(), ' 血/饿：', bot.health, '/', bot.food)
await mc.disconnect('感知实机验证结束').catch(() => {})
try { rmSync(wsDir, { recursive: true, force: true }) } catch {}
console.log(`\n感知实机验证：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
