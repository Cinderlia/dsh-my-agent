/**
 * live-skin.mjs —— 实机验证：连 127.0.0.1:25565，抓一个真玩家的真皮肤，
 * 用 mc_observe 的渲染内核把人画出来，同时把下载到的皮肤 PNG 存下来对照。
 *
 *   node live-skin.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'

const PKG = 'file:///C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const { createSkinStore, fetchBytes } = await import(`${PKG}/extensions/mc_skin.mjs`)
const { renderView } = await import(`${PKG}/extensions/mc_view-render.mjs`)
const { encodePng } = await import(`${PKG}/src/png.mjs`)
const mineflayer = (await import('file:///C:/Users/BLUE/.dsh/profiles/desktop/node_modules/mineflayer/index.js')).default

const OUT = 'C:/Users/BLUE/AppData/Local/Temp/wc-diag/live-skin'
mkdirSync(OUT, { recursive: true })

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'skintest', auth: 'offline', version: false })
bot.on('kicked', (r) => console.log('kicked:', r))
bot.on('error', (e) => console.log('error:', e.message))
await once(bot, 'spawn')
console.log('spawn 于', bot.entity.position, 'yaw=', bot.entity.yaw.toFixed(3))
await bot.waitForChunksToLoad()
console.log('chunks 就绪')

const players = Object.values(bot.players)
console.log('服上玩家：', players.map((p) => `${p.username}${p.skinData?.url ? '(有皮肤)' : '(无)'}`).join(' / '))

const target = players.find((p) => p.username !== bot.username && p.skinData?.url && p.entity)
if (!target) {
  console.log('没有带真皮肤的玩家可测 —— 退出')
  bot.quit()
  process.exit(0)
}
const tp = target.entity.position
console.log(`目标 ${target.username}：位置 ${tp} yaw=${target.entity.yaw.toFixed(3)} model=${target.skinData.model ?? 'classic'}`)
console.log('皮肤 URL:', target.skinData.url)

// 存一份皮肤贴图，方便肉眼对照
try {
  const png = await fetchBytes(target.skinData.url, 8000)
  writeFileSync(`${OUT}/skin-${target.username}.png`, png)
  console.log(`皮肤 PNG 已存（${png.length} 字节）`)
} catch (e) {
  console.log('皮肤下载失败：', e.message)
}

const store = createSkinStore({ logLine: (s) => console.log('[skin]', s), timeoutMs: 8000 })
const t0 = Date.now()
const skin = await store.skinFor(target.username, target.skinData, OUT)
console.log(`skinFor 用时 ${Date.now() - t0} ms →`, skin ? `${skin.width}×${skin.height} ${skin.model} legacy=${skin.legacy} cape=${!!skin.cape}` : 'null')
if (!skin) { bot.quit(); process.exit(1) }

const head = { x: tp.x, y: tp.y + 1.575, z: tp.z }
const face = { x: -Math.sin(target.entity.yaw), z: -Math.cos(target.entity.yaw) }
const ents = [{
  id: target.entity.id, type: 'player', username: target.username,
  x: tp.x, y: tp.y, z: tp.z, width: 0.6, height: 1.8, yaw: target.entity.yaw,
}]

function shoot (name, camPos) {
  const dx = head.x - camPos[0]
  const dy = head.y - camPos[1]
  const dz = head.z - camPos[2]
  const len = Math.hypot(dx, dy, dz)
  const yaw = Math.atan2(-dx, -dz)
  const pitch = Math.asin(dy / len)
  const t1 = Date.now()
  const f = renderView({
    world: bot.world, origin: camPos, yaw, pitch,
    width: 320, height: 180, distance: 48, entities: ents,
    skins: { [target.username]: skin }, crosshair: false, hand: false,
  })
  writeFileSync(`${OUT}/${name}.png`, encodePng(320, 180, f.rgba))
  console.log(`${name}: ${Date.now() - t1} ms  skinned=${f.stats.skinned} 实体像素=${f.stats.entityPixels} 皮肤=${JSON.stringify(f.stats.entities[0]?.skin)}`)
}

// 相机放在玩家正前方 3.5 格、正后方 3.5 格，各拍一张
shoot('view-front', [head.x + face.x * 3.5, tp.y + 1.62, head.z + face.z * 3.5])
shoot('view-back', [head.x - face.x * 3.5, tp.y + 1.62, head.z - face.z * 3.5])
shoot('view-side', [head.x + face.z * 3.5, tp.y + 1.62, head.z - face.x * 3.5])

console.log('图片目录：', OUT)
bot.quit()
setTimeout(() => process.exit(0), 300)
