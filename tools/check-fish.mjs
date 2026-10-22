/** `src/fish.mjs` 的回归检查（用户 2026-10-22：「加一个钓鱼的功能」）。
 *
 * 假 bot 只需要 fishOnce 用到的那几个面：entity / heldItem / inventory.items /
 * equip / activateItem / entities。不连服务器、不碰协议。
 *
 * 跑：node tools/check-fish.mjs
 */
import { fishOnce, findBobber } from '../src/fish.mjs'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}`) }
}

/** bobber 的 y 轨迹：抛竿后按 drops 数组逐帧下沉 */
function mkBot ({ rod = true, spawn = false, drops = null } = {}) {
  const b = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    heldItem: rod ? { name: 'fishing_rod' } : null,
    inventory: { items: rod ? [{ name: 'fishing_rod', slot: 36, count: 1 }] : [] },
    entities: {},
    activated: 0,
    equipped: 0,
    hits: 0,
    async equip () { b.equipped++ },
    async activateItem () {
      b.activated++
      if (spawn && b.activated === 1) {
        b.entities['e1'] = { name: 'fishing_bobber', position: { x: 1, y: 63.2, z: 1 } }
      }
    },
  }
  if (drops) {
    // 抛竿后再按时间轴改 y
    const base = 63.2
    let i = 0
    const timer = setInterval(() => {
      const e = b.entities['e1']
      if (!e) return
      if (i >= drops.length) { clearInterval(timer); return }
      e.position.y = base + drops[i++]
    }, 90)
    timer.unref?.()
  }
  return b
}

console.log('── 1. 没有竿')
{
  const r = await fishOnce(mkBot({ rod: false }), { timeoutMs: 300 })
  ok(r.ok === false, 'ok=false')
  ok(r.reason === 'no-rod', 'reason=no-rod')
  ok(/fishing_rod/.test(r.message), '提示里点名 fishing_rod')
}

console.log('── 2. 有竿但抛出去没有浮标（前方不是水）')
{
  const b = mkBot({ rod: true, spawn: false })
  const t0 = Date.now()
  const r = await fishOnce(b, { timeoutMs: 300 })
  ok(r.ok === false, 'ok=false')
  ok(r.reason === 'no-bobber', 'reason=no-bobber')
  ok(/水/.test(r.message), '提示里说不是水')
  ok(b.activated === 1, '只抛了一次')
  ok(Date.now() - t0 >= 1400, '等满了浮标出现的窗口（1.5s）')
}

console.log('── 3. 浮标明显下沉 ⇒ 咬钩、收竿')
{
  const b = mkBot({ rod: true, spawn: true, drops: [0, 0, -0.2, -0.25] })
  const r = await fishOnce(b, { timeoutMs: 3000 })
  ok(r.ok === true, 'ok=true')
  ok(r.reason === 'bitten', 'reason=bitten')
  ok(b.activated === 2, '抛竿 + 收竿共两次 activateItem')
}

console.log('── 4. 浮标只微微动 ⇒ 不算咬钩，超时如实报')
{
  const b = mkBot({ rod: true, spawn: true, drops: [0.01, -0.01, 0.02, -0.02, 0.01] })
  const r = await fishOnce(b, { timeoutMs: 400 })
  ok(r.ok === false, 'ok=false')
  ok(r.reason === 'timeout', 'reason=timeout')
  ok(r.bobber && Number.isFinite(r.bobber.x), '带上浮标坐标，方便下次接着盯')
  ok(b.activated === 1, '没咬钩就不收竿')
}

console.log('── 5. 手上不是竿但从背包换出来')
{
  const b = mkBot({ rod: true })
  b.heldItem = { name: 'diamond_sword' }
  b.entities['e1'] = { name: 'fishing_bobber', position: { x: 1, y: 63.2, z: 1 } }
  const r = await fishOnce(b, { timeoutMs: 300 })
  ok(b.equipped === 1, '换过一次（equip fishing_rod）')
  ok(r.reason === 'timeout' || r.reason === 'bobber-gone', '换完照常往下走，不报 no-rod')
}

console.log('── 6. findBobber 认名字')
{
  ok(findBobber({ entities: { a: { name: 'fishing_bobber', position: {} } } }) !== null, 'fishing_bobber 认得出')
  ok(findBobber({ entities: { a: { name: 'zombie', position: {} } } }) === null, 'zombie 不算浮标')
  ok(findBobber({}) === null, '没有 entities 也不崩')
}

console.log(`\ncheck-fish：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
