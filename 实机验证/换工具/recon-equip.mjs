/**
 * recon-equip.mjs —— 实机侦察：这个机器人手上是什么、背包里有没有镐、附近有没有石头
 * 只读，不动世界。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = new URL('../../', import.meta.url).pathname.replace(/^\//, '')
const { default: McBot } = await import(new URL('../../src/core.mjs', import.meta.url).href)

const lockDir = mkdtempSync(join(tmpdir(), 'wcequip-recon-'))
const mc = new McBot({ instanceId: 'recon-equip', lockDir, logFile: join(lockDir, 'recon.log') })

const log = (...a) => console.log(...a)

try {
  await mc.connect({ host: '127.0.0.1', port: 25565, auth: { mode: 'offline', name: 'wcequip_recon' } })
  log('连上了：', JSON.stringify(mc.bot?.entity?.position))
  const b = mc.requireBot()

  const inv = mc.inventory()
  log('手上：', inv.held)
  log('背包：', inv.items.map((i) => `${i.name}x${i.count}`).join('、') || '（空）')

  const held = b.heldItem
  log('heldItem：', held ? `${held.name}x${held.count} type=${held.type}` : '（空手）')

  for (const nm of ['stone', 'dirt', 'grass_block', 'cobblestone', 'iron_ore']) {
    const p = b.findBlocks({ matching: (blk) => blk?.name === nm, maxDistance: 24, count: 3 })
    log(`附近 ${nm}：`, p.length ? p.map((v) => `${v.x},${v.y},${v.z}`).join(' | ') : '无')
    if (p.length) {
      const blk = b.blockAt(p[0])
      const digTime = (() => { try { return Math.round(b.digTime(blk)) } catch (e) { return `(算不出：${e.message})` } })()
      log(`  ${nm} 第一块：harvestTools=`, blk?.harvestTools ? Object.keys(blk.harvestTools).join(',') : '（无 ⇒ 徒手也行）', ' digTime=', digTime)
    }
  }

  const stone = b.findBlocks({ matching: (blk) => blk?.name === 'stone', maxDistance: 24, count: 1 })[0]
  if (stone) {
    const blk = b.blockAt(stone)
    log('手上这叠能挖石头吗：', blk?.harvestTools ? Boolean(blk.harvestTools[held?.type]) : '（不需要工具）')
  }
  log('血量/饥饿：', b.health, '/', b.food)
} catch (e) {
  log('❌ 侦察失败：', e?.stack ?? e)
} finally {
  try { await mc.disconnect('侦察结束') } catch {}
  process.exit(0)
}
