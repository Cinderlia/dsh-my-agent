/*
 * 搭建那一层：批量放置（`mc_build` 的正文）。
 *
 * 为什么单独一层：它是"范围 → 一堆坐标 → 逐个 `placeBlock`"的调度，
 * 自己不放方块（真放方块是 core 的 `placeBlock`，会自己走近/垫脚），
 * 只负责**跳过已经放对的、如实报失败、到点就带着已放好的结果收手**。
 *
 * 三条判据（都是 2026-10-08 审计之后钉下的）：
 *   ① 只有 `placeBlock` 回 `placed`（复核过真放上去了）才算 placed —— 旧版无条件 ok.push，
 *      于是 `mc_build` 报的数量是假的；
 *   ② 不给 `name` 时，格子已经有东西（不是空气）就跳过并如实说，别让 placeBlock 一个个抛
 *      "已被 X 占住"攒够 5 个把整次调用报成失败；
 *   ③ 单次调用 ≤11 秒：到点带着已放好的返回，再叫一次同一个范围就行（放对的会跳过）。
 *
 * 形状：要回调实例方法（`placeBlock`）与实例状态（`requireBot` / `callLeft`）⇒ 第一参数收 `self`
 *（迁移规矩第 27 条）。
 */
import vec3pkg from 'vec3'
import { isAir } from './block-names.mjs'
import { heldText, countOf } from './inventory.mjs'
import { callSecText } from './budget.mjs'
import { dangerNow, dangerText, dangerNotice, healthOf, noticeKey } from './danger.mjs'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
/**
 * 批量放置：从 (x1,y1,z1) 到 (x2,y2,z2) 的实心长方体。
 * 逐个调用 placeBlock（会自己走近/垫脚），count 上限保护。
 */
export async function build (self, { x1, y1, z1, x2, y2, z2, name = null, max = 64 } = {}) {
  const pts = []
  const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)]
  const [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)]
  const [az, bz] = [Math.min(z1, z2), Math.max(z1, z2)]
  for (let y = ay; y <= by; y++) for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) pts.push({ x, y, z })
  if (pts.length > max) throw new Error(`要放 ${pts.length} 个方块，超过上限 ${max}（缩小范围或调大 max）`)
  const b = self.requireBot()
  const want = name == null ? null : String(name)
  // 🔴 单次调用 ≤11 秒：到点就带着已放好的结果返回，剩下的下次再叫。
  //    再叫一次时**已经放对的点会跳过**（不报"这格已经有方块"），所以直接重发同一个范围就行。
  // 🔴 `self.callLeft()`：本轮已经用掉的时间要算进去（`mc_sequence` 里"走一段再搭"只剩几秒）。
  const callLeftMs = self.callLeft()
  const deadline = Date.now() + callLeftMs
  /* 🔴 2026-10-17（实机：「mc_sequence 会假失败：秒回报 stoppedAt:0 / 本轮时间不够，但方块其实已经挖掉了」）：
   *    `callLeft()` 太小 ⇒ 下面 `deadline - Date.now() < 300` 立刻成立 ⇒ **一块都不放**。
   *    这是"没做"，不是"没做成" —— 必须分开说，否则模型会把已经放好的重放一遍、
   *    或者在 `mc_task` 里反复撞同一堵墙（踩坑档案第 107 条）。 */
  const noBudget = callLeftMs < 300
  const ok = []
  const fail = []
  const skipped = []
  const held0 = heldText(b)
  let used = null                       // 实际用了哪种方块（"搭完手里还剩什么"是模型最缺的一条）
  let done = 0
  /* 有多少次失败是"空着的位置放不下去"（= 多半没材料了），而不是"被别的方块占住" */
  let blockedEmpty = 0
  /* 🔴 2026-10-17（用户报"工具排队执行、延迟很大"）：一次调用是**原子**的 —— 挨打了也得把
   *    这一轮走完才轮得到 AI。搭高的时候最容易招怪（站在柱子上、没掩体），所以每放一块查一次。 */
  const hp0 = healthOf(b)
  let danger = null
  /* 🔴 2026-10-19 用户：「不要打断只提醒」—— 搭高时最容易招怪（站在柱子上、没掩体），
   *    但一挨打就带进度退出，等于每挨一巴掌就白搭一轮。默认改成只记一句、接着放；
   *    想恢复旧行为把 config.stopOnDanger 设成 true。 */
  const stopOnDanger = self.cfg?.stopOnDanger === true
  const notices = []
  const noticed = new Set()
  for (const p of pts) {
    const d = dangerNow(b, { hp0 })
    if (d) {
      if (stopOnDanger) { danger = d; break }
      const k = noticeKey(d)
      if (!noticed.has(k)) { noticed.add(k); notices.push(dangerNotice(d)) }
    }
    if (deadline - Date.now() < 300) break
    done++
    const at = `${p.x},${p.y},${p.z}`
    try {
      const cur = b.blockAt(new Vec3(p.x, p.y, p.z))?.name ?? null
      // ① 已经是想要的那种方块 ⇒ 跳过（重发同一范围时不算失败）
      if (want && cur === want) { ok.push(at); continue }
      /* ② 没指定方块、但这格已经有东西了 ⇒ 跳过并如实说
       *    （旧版会让 placeBlock 一个个抛"已被 X 占住，放不进去"，攒够 5 个就把整次调用报成失败） */
      if (!want && cur && !isAir(cur)) { skipped.push(`${at}:${cur}`); continue }
      const r = await self.placeBlock({ ...p, name })
      /* 🔴 只有**复核过真放上去了**才算 placed（2026-10-08 审计：旧版无条件 ok.push，
       *    placeBlock 回 placed:false 时也照算 ⇒ mc_build 报的数量是假的） */
      if (r?.placed) { if (!used) used = r.placed; ok.push(at) } else {
        const nowName = r?.now ?? null
        if (nowName == null || isAir(nowName)) blockedEmpty++
        fail.push(`${at}: 现在那里是 ${nowName ?? '未加载'}`)
        if (fail.length >= 5) break
      }
    } catch (e) { fail.push(`${at}: ${e.message}`); if (fail.length >= 5) break }
  }
  const left = pts.length - done
  const held = heldText(b)
  /* 材料还剩多少：`countOf` 读不到回 `null`，正好拿来区分"不知道"和"真没了"。
   * 🔴 为什么非报不可：缺料时下面那条 `hint` 正在教 AI「再叫一次 mc_build（同一个范围就行）」，
   *    而它会把这句话**照做** —— 一遍遍重发、每轮撞 5 个失败然后 break，刷一堆调用全白费。
   *    光看 `failures`（"现在那里是 未加载"）读不出这是"没材料"。 */
  const bagLeft = want ? countOf(b, want) : null
  const outOfMat = Boolean(want) && bagLeft === 0 && blockedEmpty > 0
  return {
    requested: pts.length, placed: ok.length, failed: fail.length, failures: fail.slice(0, 5),
    ...(want ? { bagLeft } : {}),
    ...(skipped.length ? { skipped: skipped.length, skippedWhy: `这 ${skipped.length} 格本来就有方块（不是我要放的那种），没动它们：${skipped.slice(0, 3).join('、')}` } : {}),
    ...(used ? { used } : {}),
    ...(held !== held0 ? { held, heldBefore: held0 } : { held }),
    ...(left > 0 ? { remaining: left } : {}),
    ...(notices.length ? { warnings: notices } : {}),
    ...(danger ? { interrupted: 'danger', danger: { ...danger, text: dangerText(danger) } } : {}),
    ...(noBudget && ok.length === 0 ? { noBudget: true, callLeftMs } : {}),
    ...(danger
      ? { hint: `⚠️ 有东西贴上来了（${dangerText(danger)}）—— 先处理它：\`mc_act {mode:"attack"}\` 打掉、或者 \`mc_move\` 躲开、\`mc_act {mode:"equip"}\` 换上装备。安全了再叫一次 mc_build（同一个范围就行，放对的会跳过）` }
      : noBudget && ok.length === 0
        ? { noBudget: true, callLeftMs, hint: `⚠️ 这次调用**自己没分到时间**（外层只剩 ${callLeftMs}ms）—— **一块都没放**。`
          + '**这不等于那些格子还是空的**：先 `mc_scan` / `mc_map` 复核一下，'
          + '确认真没放再单独叫一次 mc_build（**别塞在 mc_task 里**）。' }
        : outOfMat
          ? { outOfMaterial: want, hint: `背包里 ${want} 已经用完了（还有 ${left} 个位置没放）—— 先 mc_craft {name:"${want}"} 或 mc_dig 补料，或者换一种方块；**别原样重发**` }
          : (left > 0 ? { hint: `这一轮的 ${callSecText()}用完了，还有 ${left} 个没放 —— 再叫一次 mc_build（同一个范围就行，放对的会跳过）` } : {})),
  }
}
