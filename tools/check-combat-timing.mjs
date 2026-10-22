#!/usr/bin/env node
/**
 * check-combat-timing.mjs —— 挥砍节奏算得对不对（swingCooldownMsOf / attackSpeedOf / hasteLevelOf）
 *
 * 背景：2026-10-22，`src/attack.mjs` 的手动分支原来写死 `await sleep(620)`。
 *   620ms 只对**剑**成立（攻速 1.6 ⇒ 20/1.6 = 12.5 tick ≈ 625ms）；
 *   拿斧（0.8~1.0）时该等 1000~1250ms，620ms 挥一次等于每次都在冷却没满时挥，
 *   那一刀是**打折伤害** —— 看起来"打不死"，其实是自己在白挥。
 *
 * 钉死的事：
 *   ① 表与原版一致（剑 1.6 / 斧 0.8~1.0 / 镐 1.2 / 空手 other 4.0）；
 *   ② `ticks = ceil(20 / 攻速)`，字符串里"剑"要算出 13 tick（12.5 进位 + 默认 1 tick 余量）；
 *   ③ 急迫按 `×(1 + 0.1×等级)` 缩短，且**同样只报数**；
 *   ④ 认不出的武器 / 空手 / heldItem 为 null 时回 `other`，**不许产出 NaN**；
 *   ⑤ `marginTicks:0` 能拿回"刚好一整轮冷却"的 tick 数。
 *
 * 用法：node tools/check-combat-timing.mjs（**必须从包目录跑**）
 */
import { ATTACK_SPEED, attackSpeedOf, hasteLevelOf, swingCooldownMsOf } from '../src/combat-timing.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')) } }

const bot = (name, effects) => ({ heldItem: name ? { name } : null, ...(effects ? { entity: { effects } } : {}) })

console.log('\n── 攻速表 ──')
ok(ATTACK_SPEED.diamond_sword === 1.6, '钻石剑 1.6')
ok(ATTACK_SPEED.iron_axe === 0.9, '铁斧 0.9')
ok(ATTACK_SPEED.diamond_pickaxe === 1.2, '钻石镐 1.2')
ok(ATTACK_SPEED.other === 4.0, '兜底 other 4.0')
ok(attackSpeedOf('diamond_sword') === 1.6, 'attackSpeedOf 读表')
ok(attackSpeedOf('nonexistent_item') === 4.0, '不认识的物品回 other')
ok(attackSpeedOf(null) === 4.0, 'null 也回 other（不能 undefined → NaN）')

console.log('\n── tick 数（ceil(20/攻速) + 余量）──')
{
  const r = swingCooldownMsOf(bot('diamond_sword'))
  ok(r.ticks === 14, '剑：ceil(12.5)=13，再加默认 1 tick 余量 = 14 tick', String(r.ticks))
  ok(r.ms === 700, '剑 ⇒ 700ms（含余量；不吃余量则 625ms）', String(r.ms))
}
{
  const r = swingCooldownMsOf(bot('diamond_sword'), { marginTicks: 0 })
  ok(r.ticks === 13, '剑、不要余量 ⇒ ceil(12.5)=13（本来就是 13）', String(r.ticks))
}
{
  const r = swingCooldownMsOf(bot('wooden_axe'), { marginTicks: 0 })
  ok(r.ticks === 25, '木斧 0.8 ⇒ 25 tick', String(r.ticks))
  ok(r.ms === 1250, '木斧 ⇒ 1250ms（旧代码只用 620ms，一半都不到）', String(r.ms))
}
{
  const r = swingCooldownMsOf(bot('diamond_pickaxe'), { marginTicks: 0 })
  ok(r.ticks === 17, '镐 1.2 ⇒ ceil(16.67)=17 tick', String(r.ticks))
}
{
  const r = swingCooldownMsOf(bot(null), { marginTicks: 0 })
  ok(r.ticks === 5, '空手 other 4.0 ⇒ 5 tick', String(r.ticks))
  ok(r.weapon === null, 'weapon 如实报 null', String(r.weapon))
}

console.log('\n── 急迫 ──')
ok(hasteLevelOf(bot('diamond_sword')) === 0, '没有 effects ⇒ 0')
ok(hasteLevelOf({ entity: { effects: { 3: { amplifier: 1 } } } }) === 1, '急迫 II（amplifier 1）⇒ 1')
ok(hasteLevelOf({ entity: { effects: { 3: { level: 3 } } } }) === 2, '旧字段 level:3 ⇒ amplifier 2')
{
  const r = swingCooldownMsOf({ heldItem: { name: 'diamond_sword' }, entity: { effects: { 3: { amplifier: 1 } } } }, { marginTicks: 0 })
  ok(r.speed > 1.6, '急迫让有效攻速变高', String(r.speed))
  ok(r.ticks < 13, '急迫 II 下剑的 tick 数变少', String(r.ticks))
  ok(r.haste === 1, 'haste 如实报出来')
}

console.log('\n── 不许出 NaN / 0 ──')
{
  const weird = [{}, { heldItem: {} }, { heldItem: { name: 42 } }, { entity: null }]
  let bad = 0
  for (const w of weird) {
    const r = swingCooldownMsOf(w)
    if (!Number.isFinite(r.ms) || r.ms <= 0 || !Number.isFinite(r.ticks)) bad++
  }
  ok(bad === 0, '各种畸形 bot 都算得出正数毫秒', 'bad=' + bad)
}

console.log(`\ncheck-combat-timing：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
