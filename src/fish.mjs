/** 钓鱼（用户 2026-10-22：「加一个钓鱼的功能」）。
 *
 * 单次调用最多盯 `timeoutMs`（默认 8000ms，别超过工具 11 秒的死线）：
 *   手里没竿 → 报缺竿
 *   抛竿没浮标 → 报「前方不是水面」
 *   浮标在但没咬 → 报「还在等」，再调一次 `mc_act {mode:"fish"}` 接着盯（浮标不会消失）
 *   咬钩（浮标往下沉 BITE_DROP 格）→ 收竿
 *
 * 咬钩判定不读 metadata（版本差异大），只看**浮标最低点比起点低多少**——
 * 静水时浮标只上下微动（±0.02），真咬钩会明显沉下去。
 */

const POLL_MS = 80
const BITE_DROP = 0.12
const SPAWN_WAIT_MS = 1500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function isRod (it) {
  return Boolean(it) && /(^|:)fishing_rod$/.test(String(it.name ?? ''))
}

/** 世界上属于"浮标"的实体（mineflayer 里叫 fishing_bobber） */
export function findBobber (b) {
  const ents = b?.entities ?? {}
  for (const k of Object.keys(ents)) {
    const e = ents[k]
    if (!e || !e.position) continue
    const name = String(e.name ?? e.displayName ?? '')
    if (/bobber/i.test(name)) return e
  }
  return null
}

export async function fishOnce (b, { timeoutMs = 8000 } = {}) {
  if (!b?.entity) return { ok: false, reason: 'offline', message: '机器人不在线' }

  const held = b.heldItem
  let rod = isRod(held) ? held : null
  if (!rod) {
    const items = b.inventory?.items ?? []
    rod = items.find((i) => isRod(i)) ?? null
    if (!rod) return { ok: false, reason: 'no-rod', message: '手上和背包里都没有 fishing_rod —— 先 mc_craft {name:"fishing_rod"}' }
    await b.equip(rod, 'hand')
    await sleep(120)
  }

  // 上一轮留下的浮标：先收掉再抛，免得两杆叠着
  let bob = findBobber(b)
  if (bob) {
    await b.activateItem()
    await sleep(300)
  }

  bob = findBobber(b)
  if (!bob) {
    await b.activateItem()
    const t = Date.now()
    while (!bob && Date.now() - t < SPAWN_WAIT_MS) {
      await sleep(POLL_MS)
      bob = findBobber(b)
    }
    if (!bob) {
      return {
        ok: false,
        reason: 'no-bobber',
        message: '抛竿了但没出现浮标 —— 前方多半不是水：走到水边（2~4 格内、看得见水面）再钓',
      }
    }
  }

  const y0 = bob.position.y
  let lowest = y0
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await sleep(POLL_MS)
    const cur = findBobber(b)
    if (!cur) return { ok: false, reason: 'bobber-gone', message: '浮标没了（被水冲走/区块卸载）—— 再抛一次' }
    if (cur.position.y < lowest) lowest = cur.position.y
    if (lowest <= y0 - BITE_DROP) {
      await b.activateItem() // 收竿（再按一次）
      await sleep(400)
      return { ok: true, reason: 'bitten', waitedMs: Date.now() - t0, message: '咬钩了，已收竿 —— 捡一下掉在水边的东西' }
    }
  }

  return {
    ok: false,
    reason: 'timeout',
    waitedMs: Date.now() - t0,
    bobber: { x: Math.floor(bob.position.x), y: Math.floor(bob.position.y), z: Math.floor(bob.position.z) },
    message: `等了 ${Math.round((Date.now() - t0) / 1000)} 秒还没咬钩；浮标还在水里，再调一次 mc_act {mode:"fish"} 接着盯`,
  }
}
