/* ============================================================================
 * water-landing —— 自动落地水（MLG 水桶）被动工具（用户 2026-10-25）
 * ----------------------------------------------------------------------------
 * 触发（全满足才动手，复杂情况一律不碰）：背包有 water_bucket · 不在下界 ·
 *   survival/adventure · 没骑乘/睡觉/死亡 · 正在下落（y 在降、没踩实）。
 * 判"会摔伤"：脚下往正下方扫，**最近的实体方块**与 bot 之间必须**全是空气**，
 *   这段空气距离（=跌落距离）> 5 ⇒ 会摔伤 ⇒ armed。中途撞见水/岩浆/栏杆/火把
 *   这类"非空气非实体"= 复杂情况 ⇒ 放弃，不触发。
 * 放水时机：下落途中等脚下那块实地进入够得着的窗口（间隙 ≤ 3 格）再朝下放水——
 *   放早了会从水上继续摔、放晚了来不及。放完继续掉，落进水里（无摔伤）。
 * 收水时机：水放成功且 y 不再下降、人站到"之前那块实地上方"⇒ 舀回水，再把手上切回原物。
 * ========================================================================== */
import vec3pkg from 'vec3'
import { aimAt } from './camera.mjs'
import { isAir, isSolidBlock } from './block-names.mjs'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg

const TICK_MS = 50
const FALL_MIN = 5
const PLACE_AT = 3
const MAX_LOOK = 72
const LAND_TIMEOUT_MS = 4000

export function startWaterLanding (self, ctx = {}) {
  const { report = () => {}, log = () => {} } = ctx
  let stopped = false
  let timer = null
  // 状态机：idle → armed → placed → （收水）→ idle
  let state = 'idle'
  let lastY = null
  let stillTicks = 0
  let targetSolidY = null
  let armedGap = null
  let placeAt = 0
  let prevHeld = null
  let prevSlot = null
  let busy = false

  const bot = () => self?.bot ?? null

  const scanBelow = (b) => {
    const feet = b.entity?.position
    if (!feet) return null
    const bx = Math.floor(feet.x), bz = Math.floor(feet.z)
    const feetBlockY = Math.floor(feet.y)
    for (let d = 1; d <= MAX_LOOK; d++) {
      let blk = null
      try { blk = b.blockAt(new Vec3(bx, feetBlockY - d, bz)) } catch { blk = null }
      const name = blk?.name
      if (name == null || isAir(name)) continue
      if (isSolidBlock(name)) return { gap: d, solidY: feetBlockY - d, clean: true, bx, bz }
      return { gap: d, solidY: feetBlockY - d, clean: false, bx, bz }
    }
    return { gap: null, solidY: null, clean: false, bx, bz }
  }

  const hasWaterBucket = (b) => { try { return b.inventory.items().some((it) => it.name === 'water_bucket') } catch { return false } }
  const waterBucketItem = (b) => { try { return b.inventory.items().find((it) => it.name === 'water_bucket') } catch { return null } }

  const ineligible = (b) => {
    const dim = String(b.game?.dimension ?? '')
    if (/nether/i.test(dim)) return 'nether'
    const gm = String(b.game?.gameMode ?? '')
    if (gm === 'creative' || gm === 'spectator') return 'gamemode'
    if (b.vehicle || (typeof b.isRiding === 'function' && b.isRiding())) return 'riding'
    if (Number(b.health ?? 20) <= 0) return 'dead'
    if (b.isSleeping) return 'sleeping'
    return null
  }

  /* 朝脚下那块目标：先 aimAt 写好角度，再发一次强制朝向包，最后 activateItem 一次。
   * place=true 用水桶往实地顶面倒水；place=false 用空桶把水舀回。 */
  const useDownward = (b, bx, bz, targetY) => {
    if (!b.entity?.position) return false
    // aimAt 直接把 entity.yaw/pitch 拧到脚下那块（朝下）；b.look(force=true) 立刻发一个转向包，
    // 再 activateItem 就按这个朝向打射线。和 mc_act {useitem, x,y,z} 同一个套路（不 await b.look，
    // 静止时它会挂在物理 tick 上；下落时物理在跑，但 force 那一下本就即时，不必等）。
    const a = aimAt(b, { x: bx + 0.5, y: targetY + 0.5, z: bz + 0.5 })
    try { if (a && typeof b.look === 'function') b.look(a.yaw, a.pitch, true) } catch { /* aimAt 已写好角度 */ }
    try { b.activateItem(); return true } catch (e) { log('落地水 useItem 失败：' + (e?.message ?? e)); return false }
  }

  const equipWaterBucket = async (b) => {
    const wb = waterBucketItem(b)
    if (!wb) return false
    if (b.heldItem?.type !== wb.type) { try { await b.equip(wb, 'hand') } catch { return false } }
    return true
  }

  const restoreHeld = async (b) => {
    try {
      if (prevHeld?.name) {
        const it = b?.inventory?.items?.().find((i) => i.name === prevHeld.name)
        if (it && b.heldItem?.name !== prevHeld.name) { await b.equip(it, 'hand'); prevHeld = null; return }
      }
      if (prevSlot != null && b && typeof b.setQuickBarSlot === 'function') b.setQuickBarSlot(prevSlot)
    } catch { /* 还原失败就算了 */ }
    prevHeld = null; prevSlot = null
  }

  const reset = () => { state = 'idle'; lastY = null; stillTicks = 0; targetSolidY = null; armedGap = null }

  const tick = async () => {
    if (stopped || busy) return
    const b = bot()
    if (!b?.entity) { if (state !== 'idle') reset(); return }
    if (ineligible(b)) { if (state !== 'idle') { await restoreHeld(b); reset() } return }
    busy = true
    try {
      const y = Number(b.entity.position?.y ?? 0)
      const onGround = b.entity.onGround === true
      const dy = lastY == null ? 0 : y - lastY
      lastY = y
      if (dy < -0.02) stillTicks = 0; else stillTicks++

      if (state === 'idle') {
        if (onGround || dy >= -0.02) return                 // 没在下落
        if (!hasWaterBucket(b)) return
        const s = scanBelow(b)
        if (!s || !s.clean || s.gap == null) return         // 复杂情况 / 没实地
        if (s.gap > FALL_MIN) {
          state = 'armed'; targetSolidY = s.solidY; armedGap = s.gap; placeAt = 0
          log(`落地水 armed：脚下 ${armedGap} 格到实地，会摔伤，等放水窗口`)
        }
        return
      }

      if (state === 'armed') {
        if (onGround) { reset(); return }                    // 还没放水就落地（够矮/有梯子）
        const s = scanBelow(b)
        if (!s || !s.clean || s.gap == null) { reset(); return }
        targetSolidY = s.solidY
        if (s.gap > PLACE_AT) return                          // 还太高，再等
        // 先把"原手持 + 快捷栏槽"记下来（equip 水桶会把原手持顶掉，收尾还原要靠它）
        if (!prevHeld && b.heldItem && b.heldItem.name !== 'water_bucket' && b.heldItem.name !== 'bucket') prevHeld = { name: b.heldItem.name }
        if (prevSlot == null && typeof b.quickBarSlot === 'number') prevSlot = b.quickBarSlot
        if (!(await equipWaterBucket(b))) { log('落地水：切不出水桶，放弃'); if(prevHeld) await restoreHeld(b); reset(); return }
        const ok = await useDownward(b, s.bx, s.bz, s.solidY)
        if (ok) { state = 'placed'; placeAt = Date.now(); report(`💧 落地水：${armedGap} 格跌落，脚下倒水缓冲`) }
        else { await restoreHeld(b); reset() }
        return
      }

      if (state === 'placed') {
        if (Date.now() - placeAt > LAND_TIMEOUT_MS) { log('落地水：超时未判定落地，放弃收水'); await restoreHeld(b); reset(); return }
        const feetBlockY = Math.floor(y)
        const landed = stillTicks >= 2 && targetSolidY != null && feetBlockY >= targetSolidY && feetBlockY <= targetSolidY + 2
        if (!landed) return
        // 手上是放完水后的空桶；若不在手上，找把 bucket 切过来舀
        if (b.heldItem?.name !== 'bucket' && b.heldItem?.name !== 'water_bucket') {
          const bt = b.inventory.items().find((i) => i.name === 'bucket')
          if (bt) { try { await b.equip(bt, 'hand') } catch { /* 用现在手上的 */ } }
        }
        const bx = Math.floor(b.entity.position.x), bz = Math.floor(b.entity.position.z)
        const waterY = targetSolidY != null ? targetSolidY + 1 : (scanBelow(b)?.solidY ?? feetBlockY)
        const ok = await useDownward(b, bx, bz, waterY)
        const filled = b.heldItem?.name === 'water_bucket'
        report(ok && filled ? '💧 落地水：已站稳，水收回来了'
          : '💧 落地水：已站稳（水没舀回来，可能已流散，先不管）')
        await restoreHeld(b)
        reset()
        return
      }
    } catch (e) {
      log('落地水出错：' + (e?.message ?? e))
      if (Date.now() - placeAt > LAND_TIMEOUT_MS) { try { await restoreHeld(bot()) } catch {} ; reset() }
    } finally {
      busy = false
    }
  }

  timer = setInterval(() => { tick().catch((e) => log('落地水 tick 抛错：' + (e?.message ?? e))) }, TICK_MS)
  return {
    stop () { stopped = true; if (timer) clearInterval(timer) },
    status () { return { state, armedGap, targetSolidY } },
  }
}
