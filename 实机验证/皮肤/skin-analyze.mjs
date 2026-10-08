/**
 * skin-analyze.mjs —— 把下载到的皮肤贴图逐面打印出来，作为渲染结果的"真值"对照。
 */
import { readFileSync } from 'node:fs'

const PKG = 'file:///C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const { decodePng, makeSkin, PART_LAYOUT, faceRect } = await import(`${PKG}/extensions/mc_skin.mjs`)

const DIR = 'C:/Users/BLUE/AppData/Local/Temp/wc-diag/live-skin'
const buf = readFileSync(`${DIR}/skin-Bluezi.png`)
const { width, height, rgba } = decodePng(buf)
console.log(`贴图 ${width}×${height}`)

const skin = makeSkin({ width, height, rgba, model: 'slim', cape: null })
const px = (x, y) => {
  const i = (y * width + x) * 4
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
}
const glyph = (c) => {
  const [r, g, b, a] = c
  if (a < 100) return '.'
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  if (mx - mn < 30) return mx > 220 ? 'W' : mx < 60 ? 'K' : 'w'
  if (r >= g && r >= b) return g > b + 40 ? 'Y' : b > g + 40 ? 'M' : 'R'
  if (g >= r && g >= b) return b > r + 40 ? 'C' : r > b + 40 ? 'Y' : 'G'
  return r > g + 40 ? 'M' : g > r + 40 ? 'C' : 'B'
}

console.log('\n=== 贴图全貌（每字符 1 像素，. = 透明）===')
for (let y = 0; y < height; y++) {
  let line = ''
  for (let x = 0; x < width; x++) line += glyph(px(x, y))
  console.log(String(y).padStart(2) + ' ' + line)
}

console.log('\n=== 各部件各面（基准层 + 覆盖层合成后）的平均色 ===')
const avg = (rect) => {
  const [x0, y0, w, h] = rect
  let r = 0, g = 0, b = 0, n = 0
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const [pr, pg, pb, pa] = skin.sample(part, face, (x - x0 + 0.5) / w, (y - y0 + 0.5) / h)
      r += pr; g += pg; b += pb; n++
    }
  }
  return `#${[r / n, g / n, b / n].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}
let part = '', face = ''
for (const p of Object.keys(PART_LAYOUT)) {
  const L = PART_LAYOUT[p]
  const out = []
  for (const f of ['front', 'back', 'left', 'right', 'top', 'bottom']) {
    part = p; face = f
    out.push(`${f}=${avg(faceRect(L.x, L.y, L.w, L.h, L.d, f))}`)
  }
  console.log(`${p.padEnd(9)} ${out.join('  ')}`)
}
