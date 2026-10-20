#!/usr/bin/env node
/**
 * check-danger-not-interrupt.mjs —— 「**不要打断只提醒**」的回归检查
 *
 * 用户原话（2026-10-19）：
 *   问「还有哪些会导致当前行为退出」→ 我列了自保层那 4 种 kind（hurt / fireball / breath / hostile，
 *   都会让 `mc_sequence` / `mc_build` / `mc_dig` 带进度退出）→ 他答：**「不要打断只提醒」**。
 *
 * 为什么重要：长动作一挨打就交回控制权，等于每挨一巴掌就白跑一轮 ——
 *   挖一半的竖井、搭一半的桥都得重发，AI 还得先处理怪、再看现场，一来一回好几个回合。
 *   现在默认**把险情写成一行 `⚠️ … —— 只提醒，没打断`放进结果的 `warnings`，活照跑完这一轮**
 *   （每轮本来就 ≤11 秒）；停下来处理由反射层（`mc_auto`）的叫醒决定。
 *   想恢复旧行为：`mc_admin_config set stopOnDanger true`。
 *
 * 这个脚本钉死四件事：
 *   ① `dangerNotice()` / `noticeKey()` 的形状（null 进 null 出、同种险情一个 key）；
 *   ② `runSequence()` 默认**不**中断：`warnings` 有内容、没有 `interrupted`、失败数为 0；
 *   ③ `stopOnDanger: true` 时恢复旧的"带进度退出"（`interrupted:'danger'` + `stoppedAt`）；
 *   ④ `mc_build` / `mc_dig` / 配置 / 接线也都跟着改了（源码级断言，防止只改一处）。
 *
 * 用法：node tools/check-danger-not-interrupt.mjs
 *   ✅ 这个脚本**不需要 node_modules**（`src/sequence.mjs` 与 `src/danger.mjs` 都不 import 游戏库）。
 */
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

const { dangerNotice, noticeKey, dangerText } = await import(new URL('../src/danger.mjs', import.meta.url))
const { runSequence } = await import(new URL('../src/sequence.mjs', import.meta.url))

/** 够用的 Vec3 替身（`breathNear` 只用到 `distanceTo`） */
class V3 {
  constructor (x, y, z) { this.x = x; this.y = y; this.z = z }
  distanceTo (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) }
}

/** 脚边 4 格处有一团龙息云、血没掉（不会被判成 hurt） */
const breathBot = () => ({
  entity: { position: new V3(0, 64, 0) },
  health: 20,
  entities: { 7: { id: 7, name: 'area_effect_cloud', position: new V3(0, 64, -4) } },
})
const cleanBot = () => ({ entity: { position: new V3(0, 64, 0) }, health: 20, entities: {} })

/** `runSequence` 只要这么点东西（wait 步骤不碰别的） */
const mkSelf = (bot, cfg) => ({ bot, msLeft: () => 5000, callLeft: () => 5000, abortSignal: null, ...(cfg ? { cfg } : {}) })

/* ─────────── ① dangerNotice / noticeKey ─────────── */
section('① dangerNotice() / noticeKey()')
{
  const d = { kind: 'breath', distance: 4, position: { x: 0, y: 64, z: -4 }, escape: { x: 0, z: 1, blocks: 10 } }
  const t = dangerNotice(d)
  ok(typeof t === 'string' && t.includes('龙息云'), '龙息云能出一句话', t ?? '(null)')
  ok(t.includes('只提醒') && t.includes('没打断'), '话里明说「只提醒，没打断」')
  ok(t.startsWith('⚠️'), '带 ⚠️ 前缀（模型一眼能挑出来）')
  ok(dangerNotice(null) === null, 'null 进 null 出')
  ok(dangerNotice({ kind: 'hurt', hp0: 20, health: 12 })?.includes('正在挨打'), 'hurt 也能出话')
  ok(noticeKey(d) === 'breath:area_effect_cloud' || noticeKey(d).startsWith('breath'), '同种险情一个 key', noticeKey(d))
  ok(noticeKey(d) === noticeKey({ ...d, distance: 5 }), '距离变了还是同一个 key（不会每格刷一行）')
  ok(noticeKey({ kind: 'hostile', name: 'zombie' }) !== noticeKey({ kind: 'hostile', name: 'skeleton' }), '不同怪算不同险情')
  ok(noticeKey(null) === '', 'null 的 key 是空串')
  ok(dangerText(d)?.includes('跑'), 'dangerText 仍带「往哪跑」')
}

/* ─────────── ② 默认：只提醒，不打断 ─────────── */
section('② runSequence 默认只提醒（不中断、照跑完）')
{
  const r = await runSequence(mkSelf(breathBot()), [{ op: 'wait', sec: 0 }, { op: 'wait', sec: 0 }])
  ok(r.interrupted === undefined, '没有 interrupted 字段（没被打断）')
  ok(r.stoppedAt === undefined, '没有 stoppedAt（不是"停在半路"）')
  ok(r.succeeded === 2 && r.failed === 0, '两步都做完了', `succeeded=${r.succeeded} failed=${r.failed}`)
  ok(Array.isArray(r.warnings) && r.warnings.length === 1, 'warnings 有且只有一条（同种险情不重复）', JSON.stringify(r.warnings))
  ok(String(r.warnings?.[0] ?? '').includes('龙息云'), 'warnings 里是龙息云那句话')
  ok(r.danger === undefined, '也不给 danger 字段（那是旧行为）')
}
{
  const r = await runSequence(mkSelf(cleanBot()), [{ op: 'wait', sec: 0 }])
  ok(r.warnings === undefined && r.interrupted === undefined, '身边没事时连 warnings 都不出现（不多花 token）')
}
{
  /* 没传 cfg（老会话 / 单测直接调）也按"只提醒"走 —— 默认值不能反过来。 */
  const r = await runSequence(mkSelf(breathBot()), [{ op: 'wait', sec: 0 }, { op: 'wait', sec: 0 }])
  ok(r.interrupted === undefined && r.warnings?.length === 1, 'self.cfg 缺失时默认仍是"只提醒"')
}

/* ─────────── ③ 想恢复旧行为：stopOnDanger: true ─────────── */
section('③ stopOnDanger: true 恢复「带进度退出」')
{
  const r = await runSequence(mkSelf(breathBot(), { stopOnDanger: true }), [{ op: 'wait', sec: 0 }, { op: 'wait', sec: 0 }])
  ok(r.interrupted === 'danger', '给出 interrupted:"danger"', String(r.interrupted))
  ok(r.stoppedAt === 0, 'stoppedAt = 0（第一步就没做）', String(r.stoppedAt))
  ok(r.succeeded === 0, '一步都没做（跟旧行为一致）')
  ok(r.warnings === undefined, '旧行为下不出 warnings')
  ok(r.danger?.kind === 'breath', 'danger.kind = breath', String(r.danger?.kind))
  ok(String(r.hint ?? '').includes('第 1 步'), 'hint 说清从第几步重发')
}

/* ─────────── ④ 另外两个长动作 + 配置 + 接线 ─────────── */
section('④ mc_build / mc_dig / 配置 / 接线都跟着改了')
{
  const build = src('../src/build.mjs')
  ok(/const stopOnDanger = self\.cfg\?\.stopOnDanger === true/.test(build), 'mc_build 读同一个开关')
  ok(/if \(stopOnDanger\) \{ danger = d; break \}/.test(build), 'mc_build：只有开了开关才 break')
  ok(/\.\.\.\(notices\.length \? \{ warnings: notices \} : \{\}\)/.test(build), 'mc_build 结果里带 warnings')

  const mining = src('../src/mining.mjs')
  ok(/const stopOnDanger = self\.cfg\?\.stopOnDanger === true/.test(mining), 'mc_dig 读同一个开关')
  ok(/if \(stopOnDanger\) \{[\s\S]{0,220}?先别挖了/.test(mining), 'mc_dig：开了开关才停下并说"先别挖了"')
  ok(/out\.push\(`\$\{dangerNotice\(danger\)\}（挖到/.test(mining), 'mc_dig 默认只往结果里加一句提醒')

  const seq = src('../src/sequence.mjs')
  ok(/if \(stopOnDanger\) \{ danger = d; next = i; break \}/.test(seq), 'mc_sequence：只有开了开关才 next=i 退出')
  ok(/\.\.\.\(notices\.length \? \{ warnings: notices \} : \{\}\)/.test(seq), 'mc_sequence 结果里带 warnings')

  const cfg = src('../src/config.mjs')
  ok(/stopOnDanger: false,/.test(cfg), '配置默认 false（= 只提醒）')
  ok(/top === 'stopOnDanger'/.test(cfg), 'stopOnDanger 会被 validate 当布尔校验')

  const index = src('../index.js')
  ok(/Object\.defineProperty\(this\.bot\.cfg, 'stopOnDanger', \{[\s\S]{0,200}?get: \(\) => this\.config\?\.get\?\.\('stopOnDanger'\) === true/.test(index),
    'index.js 给 cfg 挂了活的 getter（mc_admin_config 改完立即生效）')
  ok(/stopOnDanger`（true = 遇险打断动作；默认 false 只提醒）/.test(index), 'mc_admin_config 的可用键里写了它')
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
