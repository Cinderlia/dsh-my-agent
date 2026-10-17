#!/usr/bin/env node
/**
 * 危险信号自检 —— `src/danger.mjs`（长循环"挨打就带进度退出"的判据层）
 *
 * 为什么有这一套（用户 2026-10-17「工具排队执行，有个队列工具使用，延迟很大」）：
 *   实机一个晚上 61 次调用、总耗时 334.6 秒，其中 **301.4 秒（90%）在 >=5000ms 的调用里**；
 *   `mc_sequence` 34 次平均 7071ms、最长 11010ms（顶到 CALL_MS 硬上限）。
 *   而**一次调用是原子的** —— 循环里只查 `abortSignal` 和预算，没人查"我正在挨打"。
 *   于是：12 个 break 往下挖竖井 → 骷髅跟下来一路射 → AI 要等 10 秒过完才知道
 *   （日志里 `mc_auto：zombie 贴上来 → 已叫醒 AI 定策略` 比那条调用结束早 5 秒）。
 *
 * 这一套钉死四件事：
 *   ① **判据保守** —— 掉血最硬；怪只认 `DANGER_HOSTILE_R`（3）格内的。
 *      **8 格外有只僵尸不算**：反射层会为它叫醒 AI，但砍断一个正常的挖掘串会让"挖 12 格"
 *      变成 12 次调用，反而更慢（那正是要修的病）。
 *   ② **读不到 ≠ 没有** —— `healthOf()` 读不到回 `null` 不回 0；`hp0 == null`（循环开始时
 *      就读不到血）时**掉血这一条不判**，不能拿 null 比大小。
 *   ③ **掉血优先于有怪** —— "已经打到我身上了"比"有怪在附近"硬。
 *   ④ **真接进了长循环** —— 三个循环（`sequence` / `build` / `mining`）都要 import 它、
 *      每轮调 `dangerNow()`，而且**排在预算检查之前**（还剩 8 秒也不该继续挖）。
 *
 * 用法：node tools/check-danger.mjs
 */
import { readFileSync } from 'node:fs'
import vec3pkg from 'vec3'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const {
  DANGER_HOSTILE_R, DANGER_HP_LOST,
  healthOf, nearestHostile, dangerNow, dangerText,
} = await import(new URL('../src/danger.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `  → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 假 bot：只要 `entity.position` / `entities` / `health` 三样（`danger.mjs` 只认这三样） */
const fakeBot = ({ at = [0, 64, 0], health = 20, mobs = [] } = {}) => ({
  health,
  entity: { position: new Vec3(at[0], at[1], at[2]) },
  entities: Object.fromEntries(mobs.map((m, i) => [i + 1, {
    name: m.name,
    kind: m.kind,
    type: m.type ?? 'mob',
    position: new Vec3(m.at[0], m.at[1], m.at[2]),
  }])),
})

section('① healthOf：读不到回 null，不回 0')
ok(healthOf({ health: 17 }) === 17, '数字照读', String(healthOf({ health: 17 })))
ok(healthOf({ health: 0 }) === 0, '0 是合法值（真死了）—— 不能和"读不到"混为一谈')
ok(healthOf({}) === null, '没有 health ⇒ null', String(healthOf({})))
ok(healthOf({ health: 'abc' }) === null, '不是数字 ⇒ null')
ok(healthOf(null) === null, 'bot 都没有 ⇒ null')
ok(healthOf({ health: NaN }) === null, 'NaN ⇒ null')

section('② nearestHostile：只认近处的敌对怪')
{
  const b = fakeBot({ mobs: [
    { name: 'cow', at: [1, 64, 0] },              // 近，但不是敌对
    { name: 'zombie', at: [2, 64, 0] },           // 敌对，2 格
    { name: 'skeleton', at: [1.5, 64, 0] },       // 敌对，更近
    { name: 'creeper', at: [30, 64, 0] },         // 敌对，太远
  ] })
  const n = nearestHostile(b, DANGER_HOSTILE_R)
  ok(n?.name === 'skeleton', '最近的敌对怪是 skeleton（不是更近的 cow）', String(n?.name))
  ok(n?.distance === 1.5, '距离算得对', String(n?.distance))
  ok(n?.position?.x === 1 && n?.position?.y === 64 && n?.position?.z === 0, '带上整数坐标（给 AI 看的）', JSON.stringify(n?.position))
}
{
  const b = fakeBot({ mobs: [{ name: 'zombie', at: [5, 64, 0] }] })
  ok(nearestHostile(b, 3) === null, '5 格外、半径 3 ⇒ null（不砍断正常干活）')
  ok(nearestHostile(b, 8)?.name === 'zombie', '半径给 8 就看得见')
}
{
  const b = fakeBot({ mobs: [{ name: 'something', kind: 'Hostile mobs', at: [1, 64, 0] }] })
  ok(nearestHostile(b, 3)?.name === 'something', '名字认不出但 kind 是 Hostile mobs ⇒ 也算（与 mc_auto 同判据）')
}
{
  const b = fakeBot({ mobs: [{ name: 'player_steve', type: 'player', at: [1, 64, 0] }] })
  ok(nearestHostile(b, 3) === null, '玩家不算敌对（不自动把玩家当威胁）')
}
{
  const b = fakeBot({ mobs: [{ name: 'zombie', at: [1, 64, 0] }] })
  b.entity = null
  ok(nearestHostile(b, 3) === null, '读不到自己坐标 ⇒ null（不编）')
  ok(nearestHostile(null, 3) === null, '没有 bot ⇒ null')
}

section('③ dangerNow：掉血最硬，其次才是怪贴脸')
{
  const b = fakeBot({ health: 17, mobs: [{ name: 'zombie', at: [1, 64, 0] }] })
  const d = dangerNow(b, { hp0: 20 })
  ok(d?.kind === 'hurt', '掉了 3 点血 ⇒ kind=hurt（哪怕旁边也有怪）', JSON.stringify(d))
  ok(d?.hp0 === 20 && d?.health === 17 && d?.lost === 3, '把 20 → 17 如实带上', JSON.stringify(d))
}
ok(dangerNow(fakeBot({ health: 20 }), { hp0: 20 }) === null, '一点没掉、也没怪 ⇒ null')
ok(dangerNow(fakeBot({ health: 20 }), { hp0: 20.5 }) === null, '掉 0.5 点 < DANGER_HP_LOST(1) ⇒ 不算挨打')
ok(DANGER_HP_LOST === 1, 'DANGER_HP_LOST 就是 1（被僵尸碰一下）', String(DANGER_HP_LOST))
ok(DANGER_HOSTILE_R === 3, 'DANGER_HOSTILE_R 就是 3（僵尸再走一步就够到）', String(DANGER_HOSTILE_R))
{
  const b = fakeBot({ health: 20, mobs: [{ name: 'zombie', at: [2, 64, 0] }] })
  const d = dangerNow(b, { hp0: 20 })
  ok(d?.kind === 'hostile', '没掉血但有怪贴脸 ⇒ kind=hostile', JSON.stringify(d))
  ok(d?.name === 'zombie' && d?.distance === 2, '怪的名字和距离都在', JSON.stringify(d))
}
{
  /* 🔴 这一条是"不能拿 null 比大小"的正面用例：循环开始时就读不到血 ⇒ 掉血这条**不判** */
  const b = fakeBot({ health: 3 })
  ok(dangerNow(b, { hp0: null }) === null, 'hp0 读不到 ⇒ 不掉血这条不判（3 点血也不许凭 null 判挨打）')
  const b2 = fakeBot({ health: null, mobs: [{ name: 'zombie', at: [2, 64, 0] }] })
  ok(dangerNow(b2, { hp0: 20 })?.kind === 'hostile', '现在读不到血、但有怪 ⇒ 只报怪，不报掉血')
}
{
  const b = fakeBot({ health: 20, mobs: [{ name: 'zombie', at: [2, 64, 0] }] })
  ok(dangerNow(b, { hp0: 20, radius: 1 }) === null, '半径能调（1 格内没怪 ⇒ null）')
}

section('④ dangerText：给人看的一句话')
ok(dangerText(null) === null, 'null 进 null 出')
{
  const t = dangerText({ kind: 'hurt', hp0: 20, health: 17 })
  ok(/20/.test(t) && /17/.test(t), '挨打那句带上血量变化', t)
}
{
  const t = dangerText({ kind: 'hostile', name: 'zombie', distance: 2, position: { x: 1, y: 64, z: 0 } })
  ok(/zombie/.test(t) && /2/.test(t), '怪那句带上名字和距离', t)
  ok(/1, 64, 0/.test(t), '还带上坐标（AI 要知道它在哪）', t)
}

section('⑤ 接线：三个长循环都真接上了，而且排在预算检查之前')
for (const [file, label] of [
  ['../src/sequence.mjs', 'sequence'],
  ['../src/build.mjs', 'build'],
  ['../src/mining.mjs', 'mining'],
]) {
  const src = read(file)
  ok(/from '\.\/danger\.mjs'/.test(src), `${label}：import 了 danger.mjs`)
  ok(/dangerNow\(/.test(src), `${label}：真调了 dangerNow()`)
  ok(/healthOf\(/.test(src), `${label}：循环开始时记了血量（healthOf）`)
}
{
  const src = read('../src/sequence.mjs')
  ok(/interrupted: 'danger'/.test(src), 'sequence：结果里有 interrupted:\'danger\'（能直接判，不用啃自然语言）')
  ok(/const hp0 = healthOf\(self\.bot\)/.test(src), 'sequence：hp0 在循环**外面**记一次')
  /* 🔴 顺序断言：危险检查必须在预算检查**之前** —— 否则"预算还有 8 秒"会先 break，怪就白来了 */
  const iDanger = src.indexOf('danger = dangerNow(self.bot, { hp0 })')
  const iBudget = src.indexOf('if (Date.now() - t0 > bd)')
  ok(iDanger > 0 && iBudget > 0 && iDanger < iBudget, 'sequence：危险检查排在预算检查之前', `danger@${iDanger} budget@${iBudget}`)
  ok(/steps 从第 \$\{next \+ 1\} 步往后发/.test(src), 'sequence：hint 告诉 AI 从哪一步接着发（不白挖前面那几步）')
}
{
  const src = read('../src/build.mjs')
  ok(/interrupted: 'danger'/.test(src), 'build：结果里有 interrupted:\'danger\'')
  const iDanger = src.indexOf('danger = dangerNow(b, { hp0 })')
  const iDead = src.indexOf('if (deadline - Date.now() < 300) break')
  ok(iDanger > 0 && iDead > 0 && iDanger < iDead, 'build：危险检查排在预算检查之前')
}
{
  const src = read('../src/mining.mjs')
  const iDanger = src.indexOf('danger = dangerNow(b, { hp0 })')
  const iLeft = src.indexOf('const left = leftOf()')
  ok(iDanger > 0 && iLeft > 0 && iDanger < iLeft, 'mining：危险检查排在预算检查之前')
  ok(/先别挖了/.test(src), 'mining：收工时如实说"先别挖了"')
}

console.log(`\n${'─'.repeat(50)}\ncheck-danger：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
