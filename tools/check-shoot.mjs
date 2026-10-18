#!/usr/bin/env node
/**
 * 射箭自检 —— `src/shoot.mjs` / `mc_act {mode:"shoot"}`
 *
 * 用户 2026-10-19：「hawkeye 主要是水晶和末影龙」—— 也就是末地战那两个用法：
 *   · 末影水晶：**坐标**目标（柱顶那颗），静止；
 *   · 末影龙：**实体**目标，会飞，必须带提前量。
 *
 * 这一套钉死七件事：
 *   ① 目标必须二选一 —— `who` 或 `x/y/z`，都给/都不给都要**明确报错**，不许猜；
 *   ② 没弓 / 没箭 / 换不上弓 ⇒ **一箭都不射**（不拉空弓、不浪费这一轮）；
 *   ③ 顺序必须是 **look → activate → (等拉满) → release** —— 反了就是照着上一次朝向射；
 *   ④ 弹道由 hawkeye 算；**算不出来（`undefined`）就如实说"太远/角度刁"**，绝不拿默认角度瞎射；
 *   ⑤ 放箭之后**数箭**确认真的出去了；箭数没变（服务端不认）⇒ `ok:false`；
 *   ⑥ 创造模式**不耗箭**，不能拿"箭数没变"当失败；
 *   ⑦ 真 hawkeye 能通过 `loadMcDep('hawkeye')` 找到、且 `getMasterGrade()` 返回的
 *      `yaw/pitch` 是**弧度**（直接喂 `bot.look`）。
 *
 * 用法：node tools/check-shoot.mjs
 */
import vec3pkg from 'vec3'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const { shoot, arrowsIn, infiniteArrows } = await import(new URL('../src/shoot.mjs', import.meta.url))
const { loadMcDep } = await import(new URL('../src/plugins.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `  → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const throws = async (p, re, label) => {
  try { await p(); ok(false, label, '没报错') } catch (e) { ok(re.test(String(e?.message ?? e)), label, String(e?.message ?? e)) }
}

/** 假 bot：只实现 shoot 真正碰到的那几个接口（其余一律没有 ⇒ 用了就会炸，正好当"越界"探针） */
const makeBot = ({ items = [], gameMode = 'survival', consumeArrow = true, equipWorks = true, consumeDelayMs = 0, held = null } = {}) => {
  const log = []
  const inv = items.map(([name, count]) => ({ name, count }))
  const bot = {
    entity: { position: new Vec3(0, 64, 0), height: 1.8 },
    entities: {},
    game: { gameMode },
    heldItem: held ? { name: held, count: 1 } : null,
    inventory: { items: () => inv },
    async equip (item, dest) {
      log.push(['equip', item.name, dest])
      if (equipWorks) bot.heldItem = { name: item.name, count: item.count ?? 1 }
    },
    async look (yaw, pitch, force) { log.push(['look', Number(yaw), Number(pitch), force]) },
    async activateItem () { log.push(['activate']) },
    async deactivateItem () {
      log.push(['release'])
      if (!consumeArrow) return
      const eat = () => {
        const a = inv.find((i) => /arrow/i.test(i.name))
        if (a && a.count > 0) a.count -= 1
      }
      if (consumeDelayMs > 0) setTimeout(eat, consumeDelayMs)   // 服务端回包慢：箭数过一会儿才掉
      else eat()
    },
    blockAt: (pos) => ({ name: pos && pos.y > 100 ? 'stone' : 'air' }),
    __log: log,
    __inv: inv,
  }
  return bot
}

const ctxOf = (grade, extra = {}) => ({
  t: async (p) => await p,
  callLeft: () => 8_000,
  minDrawMs: 0,                     // 测试不等那 1 秒
  pollMs: 0,                        // 也不等"箭数掉下来"的轮询间隔
  grade,
  ...extra,
})

const GRADE = { yaw: Math.PI / 2, pitch: -0.3, grade: -17.2, nearestDistance: 0.5, blockInTrayect: null }

/* ────────────────────────── ① 目标二选一 ────────────────────────── */
section('① 目标：who 或 x/y/z，只能给一个')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  await throws(() => shoot(b, {}, ctxOf(() => GRADE)), /射谁|射哪/, 'who/坐标都不给 ⇒ 报错')
  await throws(() => shoot(b, { who: 'ender_dragon', x: 1, y: 2, z: 3 }, ctxOf(() => GRADE)), /只能给一个/, 'who + 坐标同时给 ⇒ 报错')
  await throws(() => shoot(b, { x: 1, y: 2 }, ctxOf(() => GRADE)), /射谁|射哪/, '坐标缺一个 ⇒ 报错')
  await throws(() => shoot(b, { x: 1, y: 2, z: 3, weapon: 'sword' }, ctxOf(() => GRADE)), /weapon/, 'weapon 不认识 ⇒ 报错')
}

/* ────────────────────────── ② 没弓 / 没箭 ────────────────────────── */
section('② 没弓 / 没箭 / 换不上弓 ⇒ 一箭都不射')
{
  {
    const b = makeBot({ items: [['arrow', 10]] })
    await throws(() => shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE)), /背包里没有 bow/, '没弓 ⇒ 报错')
    ok(!b.__log.some((e) => e[0] === 'activate'), '没弓时没拉弓')
  }
  {
    const b = makeBot({ items: [['bow', 1], ['crossbow', 1]] })
    await throws(() => shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE)), /没有箭/, '有弓没箭 ⇒ 报错（生存）')
  }
  {
    const b = makeBot({ items: [['bow', 1], ['arrow', 5]], equipWorks: false })
    await throws(() => shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE)), /换 bow 没成功/, '换不上弓 ⇒ 报错')
  }
}

/* ────────────────────────── ③ 顺序 + 一箭射出去 ────────────────────────── */
section('③ 顺序 look → activate → release，且数箭确认')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  const r = await shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE))
  const idx = (k) => b.__log.findIndex((e) => e[0] === k)
  ok(r.ok === true, 'ok:true', JSON.stringify(r))
  ok(r.fired === 1, '射了 1 箭', String(r.fired))
  ok(idx('look') >= 0 && idx('look') < idx('activate'), '先瞄准再拉弓', JSON.stringify(b.__log))
  ok(idx('release') > idx('activate'), '拉弓之后才放箭')
  ok(b.__log.find((e) => e[0] === 'look')[3] === true, 'look 带 force=true（不会被平滑插值拖偏）')
  ok(r.arrows.before === 10 && r.arrows.after === 9, '箭数 10 → 9', JSON.stringify(r.arrows))
  ok(r.shots[0].arrowsUsed === 1, '这一箭记了 arrowsUsed:1')
  ok(r.shots[0].yawDeg === 90, 'yaw 弧度 → 度数换算对（π/2 = 90）', String(r.shots[0].yawDeg))
  ok(r.shots[0].pitchDeg === -17.2, 'pitch 弧度 → 度数换算对（-0.3 ≈ -17.2）', String(r.shots[0].pitchDeg))
  ok(r.shots[0].aimError === 0.5, 'aimError 透传 nearestDistance')
  ok(Array.isArray(r.target?.at) && r.target.at[1] === 70, '结果报目标坐标', JSON.stringify(r.target))
  ok(r.held === 'bowx1', '结果报手上是弓', String(r.held))
  ok(b.__log.some((e) => e[0] === 'equip' && e[1] === 'bow'), '没拿弓时先换弓')
}

/* ────────────────────────── ④ 算不出弹道 ⇒ 不瞎射 ────────────────────────── */
section('④ hawkeye 返回 undefined ⇒ 停手 + 说清为什么')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  const r = await shoot(b, { x: 0, y: 70, z: 200 }, ctxOf(() => undefined))
  ok(r.ok === false, 'ok:false')
  ok(r.fired === 0, '一箭没射')
  ok(/算不出弹道/.test(String(r.why)), 'why 说"算不出弹道"', String(r.why))
  ok(!b.__log.some((e) => e[0] === 'look'), '没瞄也没拉（不瞎射）')
}

/* ────────────────────────── ⑤ 服务端不认 ⇒ ok:false ────────────────────────── */
section('⑤ 箭数没变（服务端没认）⇒ ok:false')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]], consumeArrow: false })
  const r = await shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE))
  ok(r.ok === false, 'ok:false')
  ok(/箭数没变/.test(String(r.why)), 'why 说"箭数没变"', String(r.why))
  ok(r.fired === 1, '只放了这一次就停（不接着空放）', String(r.fired))
}

/* ────────────────────────── ⑥ 创造模式不耗箭 ────────────────────────── */
section('⑥ 创造模式：不耗箭也不算失败')
{
  const b = makeBot({ items: [['bow', 1]], gameMode: 'creative' })
  ok(infiniteArrows(b) === true, 'infiniteArrows 认 creative')
  ok(arrowsIn(b) === 0, '创造模式背包里没箭')
  const r = await shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE))
  ok(r.ok === true, 'ok:true（没箭也能射）', JSON.stringify(r))
  ok(r.creative === true, '结果标了 creative:true')
  ok(r.fired === 1, '射出去了')
}

/* ────────────────────────── ⑦ 实体目标 + 提前量 ────────────────────────── */
section('⑦ 实体目标（末影龙）：按实测速度算提前量')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  let x = 0
  const dragon = { name: 'ender_dragon', type: 'mob', isValid: true }
  Object.defineProperty(dragon, 'position', { get: () => new Vec3((x += 1), 70, 30) })
  b.entities = { 7: dragon }
  let sawSpeed = null
  let sawTarget = null
  const r = await shoot(b, { who: 'ender_dragon' }, ctxOf((target, speed) => { sawSpeed = speed; sawTarget = target; return GRADE }))
  ok(sawTarget === dragon, 'grade 拿到的是那个实体（不是坐标壳）')
  ok(sawSpeed && Math.abs(sawSpeed.x) > 0, '速度非零（实测位置差，不是读 velocity）', JSON.stringify(sawSpeed))
  ok(r.ok === true && r.target?.name === 'ender_dragon', '结果报目标名', JSON.stringify(r.target))
  ok(r.target.dist > 29.5 && r.target.dist < 32, '结果报距离（≈30 格）', String(r.target.dist))
  ok(b.__log.filter((e) => e[0] === 'look').length >= 2, '实体目标会"放箭前再瞄一次"（目标在动）')
}
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  await throws(() => shoot(b, { who: 'ender_dragon' }, ctxOf(() => GRADE)), /找不到 "ender_dragon"/, '半径内没这个实体 ⇒ 报错')
}

/* ────────────────────────── ⑧ 连射上限 + 静止目标不取提前量 ────────────────────────── */
section('⑧ count 上限 5；坐标目标速度为零')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 30]] })
  const speeds = []
  const r = await shoot(b, { x: 0, y: 70, z: 20, count: 99, waitTime: 5 }, ctxOf((t, s) => { speeds.push(s); return GRADE }))
  ok(r.shots.length === 5, 'count:99 最多射 5 箭', String(r.shots.length))
  ok(speeds.every((s) => s.x === 0 && s.y === 0 && s.z === 0), '坐标目标的速度是零向量')
  ok(r.arrows.before === 30 && r.arrows.after === 25, '连射 5 箭扣 5 支', JSON.stringify(r.arrows))
}

/* ────────────────────────── ⑨ 真 hawkeye：找得到、弧度对 ────────────────────────── */
section('⑨ 真 hawkeye 接线（vendor 里那个包）')
{
  const bind = await loadMcDep('hawkeye')
  ok(typeof bind === 'function', 'loadMcDep("hawkeye") 找到注入函数', String(typeof bind))
  if (typeof bind === 'function') {
    const stub = { entity: { position: new Vec3(0, 64, 0) }, world: { raycast: () => null } }
    bind(stub)
    ok(typeof stub.hawkEye?.getMasterGrade === 'function', '注入后 bot.hawkEye.getMasterGrade 在')
    /* 20 格外的地面目标（比自己低 4 格）：pitch 应该是**负**的（往下压），且是弧度不是度数 */
    const g = stub.hawkEye.getMasterGrade({ position: new Vec3(0, 60, 20), isValid: true }, new Vec3(0, 0, 0), 'bow')
    ok(Boolean(g), '20 格目标算得出弹道')
    if (g) {
      ok(Number.isFinite(g.yaw) && Number.isFinite(g.pitch), 'yaw/pitch 都是有限数')
      ok(g.pitch < 0, '目标更低 ⇒ pitch < 0', String(g.pitch))
      ok(Math.abs(g.pitch) < Math.PI / 2, 'pitch 是弧度（|pitch| < π/2，不是度数）', String(g.pitch))
      ok(Number.isFinite(g.nearestDistance) && g.nearestDistance <= 4, '落点误差 ≤ 4 格', String(g.nearestDistance))
    }
    /* 200 格外：hawkeye 自己会返回 undefined（落点误差 > 4 格）—— 这正是 shoot 必须处理的分支 */
    const far = stub.hawkEye.getMasterGrade({ position: new Vec3(0, 64, 200), isValid: true }, new Vec3(0, 0, 0), 'bow')
    ok(far === undefined, '200 格外 ⇒ undefined（不硬算）', JSON.stringify(far))
  }
}

/* ────────────────────────── ⑩ 射完把手换回去 + 箭数回包慢 ────────────────────────── */
section('⑩ 射完换回原来的东西（用户 2026-10-19）')
{
  /* 手里拿着剑来射箭：射完必须回到剑上，别让"为了射一箭"把弓留在手里 */
  {
    const b = makeBot({ items: [['bow', 1], ['arrow', 10], ['diamond_sword', 1]], held: 'diamond_sword' })
    const r = await shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE))
    ok(r.ok && r.fired === 1, '照常射出去', JSON.stringify({ ok: r.ok, fired: r.fired }))
    ok(b.heldItem?.name === 'diamond_sword', '射完手里是原来的剑', b.heldItem?.name)
    ok(r.heldRestored === 'diamond_sword', '结果报 heldRestored = diamond_sword', String(r.heldRestored))
    ok(r.held === 'diamond_swordx1', 'held 报的是"换回来之后"的手上', String(r.held))
    ok(b.__log.some((e) => e[0] === 'equip' && e[1] === 'diamond_sword' && e[2] === 'hand'), '确实发生过"换回手上"')
  }
  /* 半路停（算不出弹道）也要换回去 —— 不能让"没射成"留下弓在手里 */
  {
    const b = makeBot({ items: [['bow', 1], ['arrow', 10], ['iron_sword', 1]], held: 'iron_sword' })
    const r = await shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => undefined))
    ok(r.ok === false && r.fired === 0, '算不出弹道 ⇒ 一箭没射', JSON.stringify({ ok: r.ok, fired: r.fired }))
    ok(b.heldItem?.name === 'iron_sword', '没射成也换回剑', b.heldItem?.name)
  }
  /* 抛错也要换回去（没箭 ⇒ 直接抛） */
  {
    const b = makeBot({ items: [['bow', 1], ['golden_sword', 1]], held: 'golden_sword' })
    await throws(() => shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE)), /没有箭/, '没箭 ⇒ 抛错')
    ok(b.heldItem?.name === 'golden_sword', '抛错之后手里还是原来的剑', b.heldItem?.name)
  }
  /* 原来空手：不假装还原（射完手里就是弓） */
  {
    const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
    const r = await shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE))
    ok(!r.heldRestored, '空手开局 ⇒ 不报 heldRestored')
    ok(r.held === 'bowx1', 'held 如实报"手里是弓"', String(r.held))
  }
  /* 原来那件在背包里没了（比如刚丢完）：如实说一句，不算失败 */
  {
    const b = makeBot({ items: [['bow', 1], ['arrow', 10]], held: 'netherite_sword' })
    const r = await shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE))
    ok(r.ok && r.fired === 1, '箭照样射出去了', JSON.stringify({ ok: r.ok, fired: r.fired }))
    ok(/netherite_sword/.test(String(r.heldRestoreWhy)), 'heldRestoreWhy 说清"背包里没有它了"', String(r.heldRestoreWhy))
  }
}

section('⑫ 中文叫法：末影龙 / 末影水晶')
{
  const mk = (name) => {
    const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
    const e = { name, displayName: name, position: new Vec3(0, 70, 15), isValid: true, velocity: new Vec3(0, 0, 0) }
    b.entities = { 1: e }
    return b
  }
  const r1 = await shoot(mk('ender_dragon'), { who: '末影龙' }, ctxOf(() => GRADE))
  ok(r1.ok && r1.fired === 1, 'who:"末影龙" 找得到 ender_dragon', JSON.stringify({ ok: r1.ok, fired: r1.fired }))
  ok(/ender_dragon/.test(String(r1.target?.name)), 'target 报的是 ender_dragon', String(r1.target?.name))
  const r2 = await shoot(mk('ender_crystal'), { who: '末影水晶' }, ctxOf(() => GRADE))
  ok(r2.ok && r2.fired === 1, 'who:"末影水晶" 找得到 ender_crystal', JSON.stringify({ ok: r2.ok, fired: r2.fired }))
}

section('⑫ 箭数回包慢 200ms：不能当成"没射出去"')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]], consumeDelayMs: 200 })
  const r = await shoot(b, { x: 0, y: 70, z: 20, count: 2 }, ctxOf(() => GRADE, { pollMs: 100 }))
  ok(r.fired === 2, '两箭都算射出去了（不是被 120ms 误判打断）', String(r.fired))
  ok(r.shots.every((s) => s.arrowsUsed === 1), '每箭都数到"扣了 1 支"', JSON.stringify(r.shots.map((s) => s.arrowsUsed)))
  ok(r.ok === true, '整体 ok', String(r.ok))
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
