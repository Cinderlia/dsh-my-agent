#!/usr/bin/env node
/**
 * 兜底弹道自检 —— `src/ballistics.mjs`
 *
 * 🔴 起因（用户 2026-10-19）：「要它在空中射中」「在低上往上射」。
 *    实机表现：站在地面（y≈63）往飞到 y≈85 的末影龙射，仰角 40°~70°，
 *    hawkeye 一律返回 `undefined`（提示「算不出弹道：目标 31.1 格、角度也刁」），
 *    于是"低处往高处打"这条路整个走不通。这个模块是给它兜底的：
 *    按 Minecraft 箭的真实运动（每 tick 位置 += 速度、速度 ×0.99、v.y −= 0.05）
 *    暴力扫仰角，挑落点离目标最近的一条，带提前量。
 *
 * 钉死这几件事：
 *   ① 拉弓时长 → 初速照原版 `charge = (t²+2t)/3`，1 秒封顶 3.0 格/tick；
 *   ② 解出来的 `yaw/pitch` 和 `bot.lookAt` 同一套约定（`yaw = atan2(-dx,-dz)`，pitch 正 = 往上看）；
 *   ③ 把解带回去模拟，落点必须真的落在目标附近（自洽）；
 *   ④ 大仰角（低打高）能解出来 —— 这正是 hawkeye 解不了的那一段；
 *   ⑤ 带提前量：朝前飞的靶子要把瞄点往前放；
 *   ⑥ 退化输入（目标就在脚下 / 坐标不是数）返回 `null`，不瞎给个角度。
 *
 * 用法：node tools/check-ballistics.mjs
 */
const {
  ARROW_SPEED_FULL, ARROW_GRAVITY, ARROW_DRAG,
  arrowSpeedFor, traceArrow, solveArrow, solveArrowLead,
} = await import(new URL('../src/ballistics.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` —— ${extra}` : ''}`) }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

console.log('\n① 拉弓时长 → 初速（原版 charge 公式）')
{
  ok(near(ARROW_SPEED_FULL, 3.0, 1e-9), '满拉弓初速 3.0 格/tick', String(ARROW_SPEED_FULL))
  const chargeOf = (ms) => { const t = Math.min(20, Math.max(0, ms / 50)) / 20; return Math.min(1, (t * t + 2 * t) / 3) }
  ok(near(arrowSpeedFor(20), Math.max(0.05, chargeOf(20) * 3), 1e-9), '1 tick（20ms）还没拉起来', String(arrowSpeedFor(20)))
  ok(near(arrowSpeedFor(500), (() => { const t = 0.5; return (t * t + 2 * t) / 3 })() * 3, 1e-9), '500ms 按 charge 公式走', String(arrowSpeedFor(500)))
  ok(near(arrowSpeedFor(1000), 3.0, 1e-9), '1000ms 恰好拉满', String(arrowSpeedFor(1000)))
  ok(near(arrowSpeedFor(1500), 3.0, 1e-9), '1500ms 也不会超速（封顶）', String(arrowSpeedFor(1500)))
  ok(arrowSpeedFor(700) > 1.7 && arrowSpeedFor(700) < 2.0, '700ms 约 1.8 格/tick', String(arrowSpeedFor(700)))
  ok(arrowSpeedFor(0) > 0 && arrowSpeedFor(0) < 0.3, '0ms 几乎不动（但不为 0，避免 NaN 方向）', String(arrowSpeedFor(0)))
  ok(arrowSpeedFor('abc') > 0, '垃圾输入也不炸', String(arrowSpeedFor('abc')))
}

console.log('\n② 运动模型：正上方 / 正前方')
{
  /* 垂直向上射：速度 3、重力 0.05 ⇒ 在 y 方向上升约 3/0.05 ≈ 60 格（含阻尼更少） */
  const r = traceArrow({ from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 30, z: 0 }, ux: 0, uz: 0, pitch: Math.PI / 2 })
  ok(r.err < 0.6, '垂直向上：从正下方打得到 30 格高的点', JSON.stringify(r))
  ok(r.ticks > 5 && r.ticks < 40, '垂直向上：飞行 tick 数合理', String(r.ticks))
  const flat = traceArrow({ from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 20 }, ux: 0, uz: 1, pitch: 0 })
  ok(flat.err > 0.5, '平射 20 格：不抬枪就打不到（箭会掉下去）', JSON.stringify(flat))
}

console.log('\n③ solveArrow 自洽（解出来的角度真的能打到）')
{
  const cases = [
    { name: '平射 20 格（同高）', from: { x: 0, y: 65, z: 0 }, to: { x: 0, y: 65, z: 20 } },
    { name: '低打高：20 格远、高 20 格（hawkeye 解不了的那种）', from: { x: 0, y: 63, z: 0 }, to: { x: 0, y: 83, z: 20 } },
    { name: '低打高：30 格远、高 22 格', from: { x: 0, y: 63, z: 0 }, to: { x: 0, y: 85, z: 30 } },
    { name: '高打低：目标在脚下 20 格', from: { x: 0, y: 85, z: 0 }, to: { x: 10, y: 63, z: 0 } },
    { name: '远距离 80 格', from: { x: 0, y: 65, z: 0 }, to: { x: 0, y: 65, z: 80 } },
  ]
  for (const c of cases) {
    const sol = solveArrow(c)
    ok(!!sol, `${c.name}：解得出`, 'null')
    if (!sol) continue
    const dx = c.to.x - c.from.x
    const dz = c.to.z - c.from.z
    const h = Math.hypot(dx, dz)
    const back = traceArrow({ from: c.from, to: c.to, ux: dx / h, uz: dz / h, pitch: sol.pitch })
    ok(back.err <= 0.6, `${c.name}：把解带回去模拟，落点误差 ≤ 0.6`, String(back.err.toFixed(2)))
    ok(near(sol.yaw, Math.atan2(-dx, -dz), 1e-9), `${c.name}：yaw 与 bot.lookAt 同约定`)
    const up = c.to.y - c.from.y
    ok(up >= 0 ? (sol.deg > -5 && sol.deg < 90) : (sol.deg < 5 && sol.deg > -90), `${c.name}：仰角方向对（目标在上就抬头、在下就低头）`, String(sol.deg))
  }
}

console.log('\n④ 低打高必须能解（这正是 hawkeye 挂掉的那段）')
{
  const from = { x: 0, y: 63, z: 0 }
  for (const up of [10, 18, 25, 32]) {
    const to = { x: 12, y: 63 + up, z: 12 }
    const sol = solveArrow({ from, to })
    ok(!!sol && sol.err <= 0.6, `目标高出 ${up} 格：解得出来且落点准`, sol ? String(sol.err.toFixed(2)) : 'null')
    ok(!!sol && sol.deg > 20, `目标高出 ${up} 格：仰角确实是"往上打"`, sol ? String(sol.deg) : 'null')
  }
}

console.log('\n⑤ 提前量')
{
  const from = { x: 0, y: 65, z: 0 }
  const to = { x: 0, y: 65, z: 30 }
  const still = solveArrowLead({ from, to })
  ok(!!still && still.lead === false, '静止目标：lead = false', JSON.stringify(still?.lead))
  /* 目标以 0.4 格/tick（8 格/秒）横向飞 */
  const vel = { x: 0.4, y: 0, z: 0 }
  const lead = solveArrowLead({ from, to, vel })
  ok(!!lead && lead.lead === true, '动的目标：lead = true')
  ok(!!lead && lead.aim.x > to.x + 1, '瞄点在目标前方（x 正方向）', lead ? String(lead.aim.x.toFixed(2)) : 'null')
  ok(!!lead && lead.err <= 0.8, '带提前量的解仍然落点准', lead ? String(lead.err.toFixed(2)) : 'null')
  /* 速度是 0 向量 ⇒ 和不带一样 */
  const zero = solveArrowLead({ from, to, vel: { x: 0, y: 0, z: 0 } })
  ok(!!zero && zero.lead === false, '零速度向量等同静止')
}

console.log('\n⑥ 退化输入')
{
  ok(solveArrow({ from: { x: 0, y: 65, z: 0 }, to: { x: 0, y: 65, z: 0 } }) === null, '目标就在脚下：返回 null')
  ok(solveArrow({ from: { x: 0, y: 65, z: 0 }, to: { x: 0, y: NaN, z: 5 } }) === null, '目标坐标不是数：返回 null')
  ok(solveArrowLead({ from: { x: 0, y: 65, z: 0 }, to: { x: 0, y: 65, z: 10 }, vel: null }) !== null, 'vel 为 null 也能解')
  const noTicks = traceArrow({ from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 5 }, ux: 0, uz: 1, pitch: 0, maxTicks: 1 })
  ok(Number.isFinite(noTicks.err), 'maxTicks = 1 也不炸', JSON.stringify(noTicks))
}

console.log('\n⑦ 常量交代清楚（改常量的人得知道自己在改什么）')
{
  ok(ARROW_GRAVITY === 0.05, '每 tick 重力 0.05', String(ARROW_GRAVITY))
  ok(ARROW_DRAG === 0.99, '每 tick 阻尼 0.99', String(ARROW_DRAG))
}


console.log('\n\u2467 与真 hawkeye 对齐（冻结的实机读数，容差 1 度）')
{
  const from = { x: 7.69, y: 64.62, z: -16.98 }
  const fixtures = [
    { to: { x: 7, y: 80, z: -2 }, hawkeyePitch: 48.6 },
    { to: { x: 2, y: 98, z: -8 }, hawkeyePitch: 74.4 },
  ]
  for (const f of fixtures) {
    const sol = solveArrow({ from, to: f.to, speed: ARROW_SPEED_FULL })
    ok(!!sol && Math.abs(sol.deg - f.hawkeyePitch) <= 1, `\u4e0e hawkeye \u5bf9\u9f50\uff1a${f.hawkeyePitch} \u5ea6`, sol ? String(sol.deg.toFixed(1)) : 'null')
  }
}

console.log('\n⑨ 优先平射（用户 2026-10-19「优先平射」）')
{
  /* 实机：22 格的静止末影水晶被解成 pitch 83.5°（高抛），箭落在 z=16、靶在 z=20 —— 短了 4 格；
   * 同一颗靶 19.7 格给 3.9°（平射），一发就炸。所以解算要优先挑平的那条。 */
  const from = { x: 0, y: 64.62, z: 0 }
  const far = { x: 0, y: 64, z: 40 }          // 40 格、同高度：默认解会挑 78° 的高抛
  const best = solveArrow({ from, to: far, speed: ARROW_SPEED_FULL })
  const low = solveArrow({ from, to: far, speed: ARROW_SPEED_FULL, preferLow: true })
  ok(!!best && Math.abs(best.deg) > 45, '这个距离默认解确实是高抛（> 45°）', best ? String(best.deg) : 'null')
  ok(!!low && Math.abs(low.deg) <= 45, 'preferLow：换成平射解（≤ 45°）', low ? String(low.deg) : 'null')
  ok(!!low && low.err <= best.err + 0.15 + 1e-9, 'preferLow：误差没显著变差（≤ +0.15 格；小目标容不下更大）', `${best.err.toFixed(2)} → ${low.err.toFixed(2)}`)
  const same = solveArrow({ from, to: far, speed: ARROW_SPEED_FULL, preferLow: false })
  ok(same.deg === best.deg, 'preferLow:false 与默认行为一致')
  const near = solveArrow({ from, to: { x: 0, y: 64, z: 10 }, speed: ARROW_SPEED_FULL, preferLow: true })
  ok(!!near && Math.abs(near.deg) <= 45, '近距离目标也不会被带成高抛', near ? String(near.deg) : 'null')
  ok(!!near && near.err <= 0.35 + 1e-9, '近距离的平射解误差仍然很小', near ? String(near.err.toFixed(2)) : 'null')
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
