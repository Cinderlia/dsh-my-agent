/* 实机验证：pathfinder 补丁能不能治好「走不动」
 *
 * 复现的是用户会话里那次失败：机器人掉在 x=-4..-3 / z=5..6 的 1 格深沟里，
 * 往东（+x）要上 1 格台阶，结果 30 秒只挪 1.27 格，一直磨。
 *
 * 跑法：node live-walk.mjs
 * 期望：第 ② 步 `arrived=true`、`moved` 明显大于 2、`via=pathfinder`。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const core = await import('file:///' + PKG + '/src/core.mjs')
const McBot = core.default ?? core.McBot
const mc = new McBot({ instanceId: 'live-walk', lockDir: mkdtempSync(join(tmpdir(), 'wc-live-walk-')) })

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}

console.log('① 连接 192.168.1.104:25565 …')
await mc.connect({ host: '192.168.1.104', port: 25565, auth: { mode: 'offline', name: 'wcpath_live' } })
await mc.waitForChunks(20_000)
const b = mc.requireBot()
const V = (x, y, z) => { const p = b.entity.position.clone(); p.x = x; p.y = y; p.z = z; return p }
const nm = (x, y, z) => b.blockAt(V(x, y, z))?.name ?? '?'
const P = () => `(${b.entity.position.x.toFixed(2)}, ${b.entity.position.y.toFixed(2)}, ${b.entity.position.z.toFixed(2)})`
console.log('   进入位置', P(), '｜pathfinder 就绪 =', mc.pfReady)

console.log('\n② 先走进那条沟（-3,66,6）')
const r1 = await mc.walkTo({ x: -3, y: 66, z: 6 }, { arrive: 1, budget: 25_000 })
console.log('   结果', JSON.stringify(r1))
console.log('   到了之后位置', P())

console.log('\n③ 沟里的地形（脚柱 -3,5）')
console.log(`   y65=${nm(-3, 65, 5)}  y66=${nm(-3, 66, 5)}  y67=${nm(-3, 67, 5)}`)
console.log(`   东 (-2,5) y66=${nm(-2, 66, 5)}（要上 1 格）｜西 (-4,5) y66=${nm(-4, 66, 5)}｜北 (-3,4) y66=${nm(-3, 66, 4)}`)

console.log('\n④ 关键一步：走到 (4,66,3) —— 用户会话里失败的那个目标')
const t0 = Date.now()
const r2 = await mc.walkTo({ x: 4, y: 66, z: 3 }, { arrive: 2, budget: 40_000 })
console.log(`   结果 ${JSON.stringify(r2)}（耗时 ${Date.now() - t0}ms）`)
ok(r2.arrived === true, 'arrived=true', `via=${r2.via} moved=${r2.moved}`)
ok(Number(r2.moved) > 2, 'moved > 2（真的走出去了，不是原地磨）', `moved=${r2.moved}`)
ok(r2.stuck !== true, '没有 stuck')

console.log('\n⑤ 回归：平地上再走一段')
const r3 = await mc.walkTo({ x: 12, y: 66, z: 10 }, { arrive: 2, budget: 30_000 })
console.log('   结果', JSON.stringify(r3))
ok(r3.arrived === true, '平地上照旧走得动')

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败项'}：pass=${pass} fail=${fail}`)
await mc.disconnect('验证结束')
process.exit(fail === 0 ? 0 : 1)
