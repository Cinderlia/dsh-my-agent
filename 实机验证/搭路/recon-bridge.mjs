/* 搭路（P0-2）实机侦察 —— 先看清"我在哪、什么模式、周围长什么样、有没有现成的沟/悬崖"
 *
 * 只读：连上、报坐标/模式/血量/背包、扫一圈方块，不做任何改动。
 * 用法：node recon-bridge.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')

const mc = new McBot({ instanceId: 'recon-bridge', lockDir: mkdtempSync(join(tmpdir(), 'recon-bridge-')) })
await mc.connect({ host: '127.0.0.1', port: 25565, auth: { mode: 'offline', name: 'recon_bridge' } })
await mc.waitForChunks(20_000)
const bot = mc.requireBot()
const p = bot.entity.position.floored()
const name = (x, y, z) => { try { return bot.blockAt(p.offset(x, y, z))?.name ?? 'null' } catch { return 'ERR' } }

console.log('=== 基本情况 ===')
console.log('版本    ', bot.version)
console.log('模式    ', bot.game?.gameMode, '| 难度', bot.game?.difficulty)
console.log('坐标    ', `${p.x} ${p.y} ${p.z}`)
console.log('血量/饱食', `${bot.health} / ${bot.food}`)
console.log('在地面  ', bot.entity.onGround)
console.log('背包    ', bot.inventory.items().map((i) => `${i.name}×${i.count}`).join(' ') || '（空）')
console.log('玩家里  ', Object.keys(bot.players).join(', '))

console.log('\n=== 脚下一层（y-1）9×9 俯视（. = 空气/未加载） ===')
for (let dz = -4; dz <= 4; dz++) {
  let row = ''
  for (let dx = -4; dx <= 4; dx++) {
    const n = name(dx, -1, dz)
    row += (dx === 0 && dz === 0) ? '@' : (n === 'air' || n === 'null' ? '.' : '#')
  }
  console.log('  ' + row)
}

console.log('\n=== 四周有没有"沟/悬崖"（同一列往下找地面，深度 ≥3 记为深） ===')
let deep = 0
for (let dz = -6; dz <= 6; dz++) {
  for (let dx = -6; dx <= 6; dx++) {
    if (!dx && !dz) continue
    let d = 0
    for (let dy = -1; dy >= -12; dy--) {
      const n = name(dx, dy, dz)
      if (n === 'null') break
      if (n !== 'air') { d = -dy - 1; break }
    }
    if (d >= 3) { deep++; if (deep <= 8) console.log(`  深 ${d} 格 @ (${p.x + dx},${p.z + dz})`) }
  }
}
console.log(`  ⇒ 6 格内"落差 ≥3"的列：${deep} 个`)

console.log('\n=== 危险方块（岩浆/火/水）在 6 格内吗 ===')
const bad = /lava|fire|water|magma|soul_fire|powder_snow|cactus/
for (let dy = -3; dy <= 2; dy++) {
  for (let dz = -6; dz <= 6; dz++) {
    for (let dx = -6; dx <= 6; dx++) {
      const n = name(dx, dy, dz)
      if (bad.test(n)) console.log(`  ${n} @ (${p.x + dx},${p.y + dy},${p.z + dz})`)
    }
  }
}

console.log('\n=== 手里能当搭路料的（整方块） ===')
const { isFullBlockItem } = await import('file:///' + PKG + '/src/place-items.mjs')
const solid = bot.inventory.items().filter((i) => isFullBlockItem(bot, i.name))
console.log(' ', solid.map((i) => `${i.name}×${i.count}`).join(' ') || '（一块都没有）')

await mc.disconnect('recon 完成')
process.exit(0)
