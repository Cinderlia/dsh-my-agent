/* 实机验证：寻路到底能不能"从门里走过去"（2026-10-18）
 *
 * 复现的是用户转述的 AI 原话：
 *   「你屋里我寻路进不去，我的寻路不会开门，只会硬挖，已经挖了你两块木板。」
 *
 * 本脚本做的事（全部只读 + 走一趟，不改用户建筑）：
 *   ① 连 25565（局域网），找最近的一扇门（48 格内，木门/栅栏门/活板门都算）
 *   ② 记下门和它前后左右的方块（"挖过就看得出来"）
 *   ③ 走到门**另一侧**的落脚点 —— 只有真能穿门才走得到（门开着也不算实心才对）
 *   ④ 断言：门还在（没被挖）、门被按开了、人到了门另一侧、`dug` 不含门
 *   ⑤ 再走回来一趟（反方向同样要穿门）
 *
 * 跑法（游戏里"对局域网开放"之后）：node live-door.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const core = await import('file:///' + PKG + '/src/core.mjs')
const McBot = core.default ?? core.McBot
const mc = new McBot({ instanceId: 'live-door', lockDir: mkdtempSync(join(tmpdir(), 'wc-live-door-')) })

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}

const HOST = process.env.MC_HOST ?? '127.0.0.1'
console.log(`① 连接 ${HOST}:25565 …`)
await mc.connect({ host: HOST, port: 25565, auth: { mode: 'offline', name: 'wc_door_live' } })
await mc.waitForChunks(20_000)
const b = mc.requireBot()
const V = (x, y, z) => b.entity.position.offset(x - b.entity.position.x, y - b.entity.position.y, z - b.entity.position.z)
const at = (x, y, z) => b.blockAt(V(x, y, z))
const nm = (x, y, z) => at(x, y, z)?.name ?? '?'
const P = () => `(${b.entity.position.x.toFixed(1)}, ${b.entity.position.y.toFixed(1)}, ${b.entity.position.z.toFixed(1)})`
console.log('   进入位置', P(), '｜pathfinder 就绪 =', mc.pfReady)

console.log('\n② 找最近的一扇门（48 格内）')
const DOOR_RE = /_(door|trapdoor|fence_gate)$/
const ids = []
const byName = b.registry?.blocksByName ?? {}
for (const [name, blk] of Object.entries(byName)) if (DOOR_RE.test(name) && Number.isFinite(blk?.id)) ids.push(blk.id)
/* 木门优先（栅栏门 vendor 本来就认，木门才是这次要验的） */
const doorIds = []
const gateIds = []
for (const blk of Object.values(b.registry?.blocksByName ?? {})) {
  if (!Number.isFinite(blk?.id)) continue
  if (/_door$/.test(blk.name)) doorIds.push(blk.id)
  else if (DOOR_RE.test(blk.name)) gateIds.push(blk.id)
}
let found = b.findBlocks({ matching: doorIds, maxDistance: 96, count: 6 })
const kind = '木门'
if (!found.length) {
  found = b.findBlocks({ matching: gateIds, maxDistance: 48, count: 6 })
  console.log('   （96 格内没有木门，退而验栅栏门/活板门）')
} else console.log('   96 格内找到木门', found.length, '个')
console.log('   候选方块 id 数 =', ids.length, '｜找到', found.length, '个位置')
if (!found.length) {
  console.log('   ⚠️ 附近 48 格内没有门：请站在有门的屋子里再跑一次')
  await mc.disconnect('没找到门')
  process.exit(2)
}

/* 选一扇"能确定朝向"的门 */
const doorOf = (pos) => {
  let blk = b.blockAt(pos)
  if (blk?.name && /_door$/.test(blk.name) && blk.getProperties?.()?.half === 'upper') blk = b.blockAt(pos.offset(0, -1, 0))
  return blk
}
let door = null
for (const pos of found) {
  const blk = doorOf(pos)
  if (blk?.name && DOOR_RE.test(blk.name)) { door = blk; break }
}
if (!door) { console.log('   ⚠️ 找到的位置都取不到门方块，放弃'); await mc.disconnect('没门'); process.exit(2) }
const dp = door.position
console.log(`   选中 ${door.name} @ (${dp.x}, ${dp.y}, ${dp.z})｜open=${door.getProperties?.()?.open}`)

/* 门朝向 → 门两侧的两个点（门板法线方向） */
const facing = door.getProperties?.()?.facing ?? 'north'
const axis = (facing === 'east' || facing === 'west') ? 'x' : 'z'
const sideA = axis === 'x' ? dp.offset(-2, 0, 0) : dp.offset(0, 0, -2)
const sideB = axis === 'x' ? dp.offset(2, 0, 0) : dp.offset(0, 0, 2)
console.log(`   朝向 ${facing}（法线轴 ${axis}）｜两侧点 A=${sideA.x},${sideA.y},${sideA.z}  B=${sideB.x},${sideB.y},${sideB.z}`)

/* ③ 记录现场：门 + 前后 1 格 + 头顶 */
const snapshot = () => {
  const out = {}
  for (const d of [dp, dp.offset(0, 1, 0), sideA.offset(0, 0, 0), sideA.offset(0, 1, 0), sideB, sideB.offset(0, 1, 0)]) {
    out[`${d.x},${d.y},${d.z}`] = b.blockAt(d)?.name ?? '?'
  }
  return out
}
const before = snapshot()
console.log('   现场快照', JSON.stringify(before))

/* 选起点：站到门的一侧（若已经在另一侧就先走过去） */
const near = (p) => b.entity.position.distanceTo(p) < 1.6
const startSide = near(sideA) ? sideA : near(sideB) ? sideB : (b.entity.position.distanceTo(sideA) <= b.entity.position.distanceTo(sideB) ? sideA : sideB)
const farSide = startSide === sideA ? sideB : sideA
console.log(`\n③ 先站到近侧（${startSide.x}, ${startSide.y}, ${startSide.z}）`)
const r0 = await mc.walkTo({ x: startSide.x, y: startSide.y, z: startSide.z }, { arrive: 1.2, budget: 20_000 })
console.log('   结果', JSON.stringify({ arrived: r0.arrived, moved: r0.moved, reason: r0.reason }))

/* ④ 关键一步：走到门的另一侧 */
console.log(`\n④ 穿门：走到另一侧（${farSide.x}, ${farSide.y}, ${farSide.z}）`)
let openedSeen = false
const watcher = setInterval(() => {
  const now = doorOf(dp)
  if (now?.getProperties?.()?.open === true) openedSeen = true
}, 100)
const t0 = Date.now()
const r1 = await mc.walkTo({ x: farSide.x, y: farSide.y, z: farSide.z }, { arrive: 1.4, budget: 25_000 })
clearInterval(watcher)
console.log(`   结果 ${JSON.stringify(r1)}（${Date.now() - t0}ms）`)
console.log('   走完之后位置', P(), '｜门方块 =', doorOf(dp)?.name ?? '（没了）')

const after = snapshot()
const doorNow = doorOf(dp)
const around = Object.entries(after).filter(([k, v]) => before[k] !== v)
console.log('   现场变化', around.length ? JSON.stringify(around) : '（无）')

ok(Boolean(doorNow) && DOOR_RE.test(doorNow.name ?? ''), '🔴 门还在（没有被寻路器挖掉）', doorNow?.name)
ok(r1.arrived === true, '走到了门的另一侧', `reason=${r1.reason}`)
ok(Number(r1.moved) >= 1, 'moved 明显大于 0', `moved=${r1.moved}`)
ok(openedSeen === true || doorNow?.getProperties?.()?.open === true, '门是被"按开"的（看到过 open=true）')
const dugDoor = Number(r1.dug ?? 0)
ok(dugDoor === 0, '这一趟 dug = 0（没有挖任何方块）', `dug=${dugDoor}`)

/* ⑤ 再走回来 */
console.log(`\n⑤ 反方向再穿一次（回 ${startSide.x}, ${startSide.y}, ${startSide.z}）`)
const r2 = await mc.walkTo({ x: startSide.x, y: startSide.y, z: startSide.z }, { arrive: 1.4, budget: 25_000 })
console.log('   结果', JSON.stringify({ arrived: r2.arrived, moved: r2.moved, dug: r2.dug, reason: r2.reason }))
ok(r2.arrived === true, '反方向也穿得过去', `reason=${r2.reason}`)
ok(Boolean(doorOf(dp)), '门仍然在')
ok(Number(r2.dug ?? 0) === 0, '反方向 dug = 0', `dug=${r2.dug}`)

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败项'}：pass=${pass} fail=${fail}`)
await mc.disconnect('门验证结束')
process.exit(fail === 0 ? 0 : 1)
