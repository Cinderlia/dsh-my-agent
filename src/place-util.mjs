import Vec3 from 'vec3'
import { notePlaced } from './bot-placed.mjs'

/**
 * 放一个方块（裸 mineflayer 版）。
 *
 * 🔴 2026-10-25 实机：`b.placeBlock is not a function` / `reading 'plus'` ——
 *    McBot 上的 `placeBlock({x,y,z,name})` 是插件自己的封装，裸 mineflayer bot 没有这个签名。
 *    这里用原生 `bot.placeBlock(refBlock, faceVec)`：先把手上的方块换到主手，再找相邻实心块当参照。
 */
export async function placeAt (b, x, y, z, name) {
  const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  let item = null
  if (name) {
    const id = b.registry?.itemsByName?.[name]?.id
    if (id == null) throw new Error(`不认识方块 ${name}`)
    item = b.inventory.items().find((it) => it.type === id) ?? null
    if (!item) throw new Error(`背包里没有 ${name}`)
  } else {
    item = b.heldItem
    if (!item) throw new Error('手上没有方块')
  }
  await b.equip(item, 'hand')
  /* 参照方块：目标格的下/东/西/南/北，取第一个实心的，face 指回目标格 */
  const refs = [
    { d: [0, -1, 0], f: [0, 1, 0] },
    { d: [1, 0, 0], f: [-1, 0, 0] },
    { d: [-1, 0, 0], f: [1, 0, 0] },
    { d: [0, 0, 1], f: [0, 0, -1] },
    { d: [0, 0, -1], f: [0, 0, 1] },
  ]
  for (const r of refs) {
    const ref = b.blockAt(pos.offset(r.d[0], r.d[1], r.d[2]))
    if (ref && ref.boundingBox === 'block') {
      await b.placeBlock(ref, new Vec3(r.f[0], r.f[1], r.f[2]))
      /* 用户 2026-10-26：记一笔「自己放的」，雷达图里它永远不折叠。 */
      try { notePlaced(b, pos.x, pos.y, pos.z, name ?? b.blockAt(pos)?.name ?? null) } catch { /* 记账失败不影响放置 */ }
      return { ok: true, x: pos.x, y: pos.y, z: pos.z }
    }
  }
  throw new Error('目标格六面都没有可依附的方块')
}
