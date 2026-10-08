/**
 * skin-look.mjs —— 不需要 MC 服务器：用真皮肤贴图 + 假世界，从四个方向把玩家画出来，
 * 并把贴图与渲染结果都放大，方便肉眼核对。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const PKG = 'file:///C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const { decodePng, makeSkin, fetchBytes } = await import(`${PKG}/extensions/mc_skin.mjs`)
const { renderView } = await import(`${PKG}/extensions/mc_view-render.mjs`)
const { encodePng } = await import(`${PKG}/src/png.mjs`)

const DIR = 'C:/Users/BLUE/AppData/Local/Temp/wc-diag/live-skin'
mkdirSync(DIR, { recursive: true })

const skinBuf = readFileSync(`${DIR}/skin-Bluezi.png`)
const skinPng = decodePng(skinBuf)
const CAPE_URL = 'http://textures.minecraft.net/texture/cb40a92e32b57fd732a00fc325e7afb00a7ca74936ad50d8e860152e482cfbde'
let cape = null
try {
  const cb = readFileSync(`${DIR}/cape-Bluezi.png`)
  cape = decodePng(cb)
  console.log('披风：用本地缓存')
} catch {
  try {
    const cb = await fetchBytes(CAPE_URL, 8000)
    writeFileSync(`${DIR}/cape-Bluezi.png`, cb)
    cape = decodePng(cb)
    console.log(`披风：下载 ${cb.length} 字节`)
  } catch (e) {
    console.log('披风下载失败：', e.message)
  }
}

const skin = makeSkin({ width: skinPng.width, height: skinPng.height, rgba: skinPng.rgba, model: 'slim', cape })
console.log(`皮肤 ${skinPng.width}×${skinPng.height} slim=${skin.model === 'slim'} cape=${!!skin.cape}`)

/* 假世界：y<=63 石头、y=64 草、其余空气 */
const world = {
  getBlock: ({ x, y, z }) => (y <= 63 ? { name: 'stone', boundingBox: 'block' } : y === 64 ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }),
}

/* 放大工具：最近邻，factor 倍 */
function zoom (rgba, w, h, f, x0 = 0, y0 = 0, cw = w, ch = h) {
  const out = Buffer.alloc(cw * f * ch * f * 4)
  for (let y = 0; y < ch * f; y++) {
    for (let x = 0; x < cw * f; x++) {
      const sx = x0 + Math.floor(x / f)
      const sy = y0 + Math.floor(y / f)
      const s = (sy * w + sx) * 4
      const d = (y * cw * f + x) * 4
      out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3]
    }
  }
  return { w: cw * f, h: ch * f, rgba: out }
}

const z = zoom(skinPng.rgba, skinPng.width, skinPng.height, 6)
writeFileSync(`${DIR}/skin-Bluezi-6x.png`, encodePng(z.w, z.h, z.rgba))
console.log(`贴图放大 6× → ${z.w}×${z.h}`)

const W = 320, H = 180
const ent = { id: 1, type: 'player', username: 'Bluezi', x: 0, y: 64, z: -3, width: 0.6, height: 1.8 }
const views = [
  ['front', Math.PI, [0, 65.62, 0]],
  ['back', 0, [0, 65.62, 0]],
  ['left', Math.PI / 2, [0, 65.62, 0]],
  ['right', -Math.PI / 2, [0, 65.62, 0]],
]
for (const [name, yaw, origin] of views) {
  const f = renderView({
    world, origin, yaw: 0, pitch: 0, width: W, height: H, distance: 48,
    entities: [{ ...ent, yaw }], skins: { Bluezi: skin }, crosshair: false, hand: false,
  })
  writeFileSync(`${DIR}/look-${name}.png`, encodePng(W, H, f.rgba))
  const zz = zoom(f.rgba, W, H, 4, 110, 20, 100, 150)
  writeFileSync(`${DIR}/look-${name}-4x.png`, encodePng(zz.w, zz.h, zz.rgba))
  console.log(`look-${name}.png 实体像素=${f.stats.entityPixels} skinned=${f.stats.skinned}`)
}
