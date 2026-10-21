/**
 * dsh-mc-agent —— 浏览器半端（client bundle）
 * ============================================================================
 * 会话标题旁的状态条 + **一个**「强制停止」按钮 + 「MC设置」按钮与其模态框。
 *
 * 设计约束：
 *   1. **只在真正进了游戏的那个会话显示**（`/api/mc/status` 说 active 才渲染）；
 *      没连游戏时返回 null，完全不占位、不干扰其他会话。
 *   2. **只有强制停止**（用户 2026-09-16：移除普通停止）。点下去后端按这个顺序做：
 *        ① 先停 LLM（如果正在输出） ② 先尝试优雅退出游戏 ③ 再清空该会话全部后台任务
 *        ④ 最后再停一次 LLM（避免②③期间的事件/注入把会话留在异常状态）
 *   3. 插槽用 `conversation.session.header.actions`（list/session，增量安全），
 *      **不**替换 `conversation.session.header`（single，会 shadow 掉官方 UI）。
 *   4. 「MC设置」入口有**两个，按会话是否 blank 互斥**（任何时刻只有一个）：
 *      · **新会话页** → 插到 hero 行里**模式选择芯片的正右边**
 *        （锚点 `[data-slot="conversation.hero.agentPreset"]`，只在 hero 相位存在）；
 *      · **已有会话** → `conversation.session.header.actions`（order 45，状态条左边）。
 *      两者都**只在 MC 模式**渲染，判据是**本地的**会话 preset（见 useMcSettingsGate）。
 *
 * 🔴 2026-09-16 真机事故（别再犯）：早先为了在新对话页放按钮，用
 *    `MutationObserver(document.body)` + `[data-composer-card]` 往上找"卡片前面的兄弟"，
 *    于是**模型生成时**输入框那片 DOM 一变动，按钮就被插到输入框上方、渲染成**全宽长条**
 *    （位置全靠猜、时有时无，且普通会话也有）。
 *    ⇒ 结论：**锚点必须只在该出现的地方存在**，观察范围**只限作曲器卡片**，且必须**门控**。
 *      （现在唯一一处 DOM 注入就是 `mountHeroChipButton`，它满足这三条：
 *        锚点 `[data-slot="conversation.hero.agentPreset"]` 只在 hero 相位存在、
 *        观察范围限于 `[data-composer-card]`、并且只在"blank + MC 模式"时挂载。）
 *
 * 2026-09-16 改版（用户："UI 被你搞得乱七八糟" → 重构）：
 *   模态框从**一页长滚动**改成**两栏**：左侧竖排标签（账户 / 指令白名单 / 提示词），
 *   右侧**一次只渲染当前那一页**。旧版那一坨账户界面**原样搬进「账户」页**（字段/请求都没改）。
 *
 * 🔴 文案规矩（用户 2026-09-16）：**UI 里只写用户需要的信息**。
 *    不要出现实现细节/AI 味的话——例如"账号密码只保存在你本机的 DSH 凭据库里，AI 看不到"、
 *    "这个开关一拨就生效（即时保存）"、"当前来源：默认版"、凭据库/接口/令牌之类的词。
 *    那一页就叫**「提示词」**，不要叫"行事准则"（"行事准则"只是那份正文自己的标题）。
 *
 * 🔴 凭据边界：密码/token **只进宿主凭据库**。本文件的 password 输入框是**非受控**的，
 *    值从不进 props/state/data-*，也从不 console.log；接口响应里本来就没有密码。
 *
 * 这是手写 factory bundle：无需构建，`exports["./client"]` 直接指向本文件。
 * 改本文件后由 @deepseek-ai/dsh-client-hmr 自动热换，**不需要** pnpm run dev:web。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-mc-agent',
  factory(require) {
    const React = require('react')

    // 🔴 图标约定（2026-10-04 用户定）：**一律取自 DSH 官方的图标集**，不要自己画、
    //    也不要另引第三方图标库。DSH 把它的图标集（`IconSettingsOutlineRegular` 等）
    //    随 `@deepseek-ai/dsh-client-ui-primitives` 作为**平台内置模块**暴露给所有客户端插件
    //    （shell 的静态模块表里就有它，官方插件也是直接 require 的）——所以这里 require 即得
    //    "同源同款"，与原生「卸载」按钮的 `IconTrashOutlineRegular` 是同一套。
    //    命名：`…OutlineRegular` = 1px 描边（本文按钮用这个），`…OutlineMedium` = 1.3px。
    //    兜底：宿主万一没提供（理论上不该发生），退回"无图标"而不是让整个客户端半端挂掉。
    let IconSettingsOutlineRegular = null
    let IconFolderOpenRegular = null
    let IconCloseOutlineRegular = null
    let IconRunRegular = null
    let IconChevronDownOutlineRegular = null
    let createRoot = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      IconSettingsOutlineRegular = primitives.IconSettingsOutlineRegular
      // 工作区标记：native `WorkspaceChip` 同款文件夹图标（有 label 时就用它、size 16）。
      IconFolderOpenRegular = primitives.IconFolderOpenRegular
      // 弹窗右上角关闭按钮的叉图标（与 DSH 原生弹窗同款）。
      IconCloseOutlineRegular = primitives.IconCloseOutlineRegular
      // 「运行」图标 = **裸的实心向右三角**（不要外圈/描边）——「连接到MC」按钮与弹窗里的「连接」都用它。
      IconRunRegular = primitives.IconTriangleRightFillRegular
      IconChevronDownOutlineRegular = primitives.IconChevronDownOutlineRegular
      // hero 那个「设置」按钮是**纯 DOM**（不是 React 渲染的），拿不到 React 组件本身；
      // 借 react-dom 的一个小根把图标渲染进按钮，图标仍出自同一套官方图标集（不另画、不搬路径）。
      createRoot = require('react-dom/client').createRoot
    } catch (e) { /* 见上：只用图标，拿不到就退回文字，别让按钮变空白 */ }

    const CSS = `
[data-mc-status]{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 6px 0 10px;
  border-radius:999px;background:var(--dsw-alias-bg-overlay);
  color:var(--dsw-alias-label-primary);font-size:12px;line-height:1;white-space:nowrap;
  box-shadow:var(--dsw-elevation-panel,0 1px 2px rgba(0,0,0,.12));}
[data-mc-status][data-mc-busy]{opacity:.6;pointer-events:none;}
[data-mc-dot]{width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-state-success-primary);flex:none;}
[data-mc-dot][data-mc-warn]{background:var(--dsw-alias-state-warn-primary);}
[data-mc-text]{color:var(--dsw-alias-label-secondary);}
[data-mc-sub]{color:var(--dsw-alias-label-tertiary);max-width:24ch;overflow:hidden;text-overflow:ellipsis;}
[data-mc-btn]{display:inline-flex;align-items:center;justify-content:center;height:22px;padding:0 9px;
  border:0;border-radius:999px;background:transparent;cursor:pointer;font-size:12px;line-height:1;
  color:var(--dsw-alias-label-secondary);font-family:inherit;}
[data-mc-btn]:hover{background:var(--dsw-alias-border-inverted);color:var(--dsw-alias-label-primary);}
[data-mc-btn][data-mc-danger]{color:var(--dsw-alias-state-error-primary);}
[data-mc-btn][data-mc-danger]:hover{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground,#fff);}

/* ── 「MC设置」按钮：普通次级按钮（**不**照搬状态条药丸外形）──────────────────
   只由 React 插槽渲染（标题条），**没有任何 DOM 注入**。 */
[data-wc-btn]{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 12px;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.28)));
  border-radius:8px;background:transparent;cursor:pointer;font-size:12px;line-height:1;
  font-family:inherit;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
[data-wc-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));
  color:var(--dsw-alias-label-primary);}
[data-wc-btn]:disabled{opacity:.5;cursor:default;}
[data-wc-btn][data-wc-primary]{border-color:transparent;background:var(--dsw-alias-button-info-fill);
  color:var(--dsw-alias-label-primary-foreground,#fff);}
[data-wc-btn][data-wc-primary]:hover{background:var(--dsw-alias-button-info-hover,var(--dsw-alias-button-info-fill));}
[data-wc-btn][data-wc-primary]:disabled{opacity:.5;}
[data-wc-btn][data-wc-danger]{color:var(--dsw-alias-state-error-primary);}
[data-wc-btn][data-wc-danger]:hover{background:var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-label-primary-foreground,#fff);}
[data-wc-btn][data-wc-tiny]{height:24px;padding:0 9px;font-size:11px;}
/* 只有图标的按钮：收成正方形（边长 = 高度） */
[data-wc-btn][data-wc-icon]{padding:0;width:28px;}
[data-wc-btn][data-wc-tiny][data-wc-icon]{width:24px;}
/* 新会话页那个按钮是插进 hero 行、贴在模式芯片右边的（那一行 gap:2px，这里再给点间距） */
[data-dsh-mc-agent-mc-settings]{margin-left:6px;}
[data-slot="conversation.session.header.actions"] [data-wc-btn]:first-child{margin-left:8px;}
/* 「MC设置」有新版本时的红点（用户 2026-10-20）：不占布局，只在按钮右上角点一下 */
[data-wc-btn][data-wc-update]{position:relative;}
[data-wc-btn][data-wc-update]::after{content:'';position:absolute;top:2px;right:2px;width:7px;height:7px;
  border-radius:50%;background:var(--dsw-alias-state-error-primary,#e5484d);pointer-events:none;
  box-shadow:0 0 0 2px var(--dsw-alias-bg-base,rgba(0,0,0,.55));}
/* 「更新」页给 CHANGELOG / git 输出用的等宽块 */
[data-wc-log]{margin:8px 0 0;padding:8px 10px;max-height:220px;overflow:auto;border-radius:8px;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));white-space:pre-wrap;
  word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);}

/* ── 模态框 ────────────────────────────────────────────────────────────── */
[data-wc-overlay]{position:fixed;inset:0;z-index:1000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));
  display:flex;align-items:center;justify-content:center;padding:24px;}
/* 🔴 **固定尺寸**（用户 2026-09-16）：切换标签页时卡片不许忽大忽小——
   内容少了就下面留空（内容本身居上），内容多了由右侧内容区自己滚动。 */
[data-wc-card]{position:relative;display:flex;flex-direction:column;width:min(760px,100%);
  height:min(86vh,860px);overflow:hidden;border-radius:24px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));
  color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.28));}
[data-wc-head]{display:flex;align-items:center;gap:12px;height:52px;flex:none;padding:0 16px 0 20px;
  border-bottom:1px solid var(--dsw-alias-border-l2,transparent);}
[data-wc-titlewrap]{display:flex;flex-direction:column;gap:3px;min-width:0;}
/* 标题那一行：标题 + （有工作区时）文件夹图标 + 灰色工作区名，小间隔 */
[data-wc-titleline]{display:flex;align-items:center;gap:8px;min-width:0;}
[data-wc-title]{font-size:14px;font-weight:600;line-height:1;}
/* 头部的工作区名（灰、次要色） */
[data-wc-wsname]{display:inline-flex;align-items:center;gap:4px;min-width:0;font-size:12px;
  font-weight:400;color:var(--dsw-alias-label-tertiary);}
[data-wc-wsname] > span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-wc-subhead]{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);}
[data-wc-grow]{flex:1;min-width:0;}

/* —— 「属于本工作区」标记 + 无工作区提示 —— */
[data-wc-wsmark]{display:inline-flex;align-items:center;vertical-align:middle;margin-left:5px;
  color:var(--dsw-alias-label-tertiary);cursor:default;}
[data-wc-wsneed]{display:flex;justify-content:center;align-items:center;gap:6px;margin-top:16px;
  color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}
[data-wc-dimmed]{opacity:.6;}
/* 弹窗右上角关闭：**叉图标**，与标题同色；hover 红；无边框、无底色（2026-10-04 定，其余弹窗照此） */
[data-wc-xbtn]{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;
  padding:0;border:0;background:transparent;border-radius:6px;cursor:pointer;font-family:inherit;
  color:var(--dsw-alias-label-primary);}
[data-wc-xbtn]:hover{color:var(--dsw-alias-state-error-primary);}
[data-wc-xbtn]:disabled{opacity:.5;cursor:default;}
/* ── 「连接到MC」弹窗（2026-10-04）────────────────────────────────────── */
[data-wc-cn-overlay]{position:fixed;inset:0;z-index:1000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));
  display:flex;align-items:center;justify-content:center;padding:24px;}
/* 叠加在「连接到MC」之上的设置弹窗：更高一层 */
[data-wc-overlay][data-wc-nested]{z-index:1200;}
/* **固定窗口**（用户要求）：宽高定死；上方留白、底部 footer 贴底 */
[data-wc-cn-card]{position:relative;display:flex;flex-direction:column;width:min(760px,100%);
  height:min(82vh,600px);overflow:hidden;border-radius:20px;
  background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);
  box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.28));}
/* 内容整体垂直居中，再**上移约 10%**（用户要求）；顶部那点空给浮层错误提示 */
[data-wc-cn-body]{position:relative;flex:1;min-height:0;overflow:auto;padding:24px 52px 84px;
  display:flex;flex-direction:column;justify-content:center;gap:10px;}
[data-wc-cn-foot]{flex:none;padding:10px 24px 14px;
  border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));}
/* 连接出错：**浮在地址上方的留白里**，3s 自动消失（定时器见组件） */
[data-wc-cn-error]{position:absolute;top:7px;left:36px;right:36px;z-index:2;
  padding:5px 10px;border-radius:8px;font-size:12px;line-height:18px;word-break:break-word;
  background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground,#fff);}
/* 「运行」图标：DSH 裸三角几何 → **描边成空心**（不要实心、不要外圈）。
 * 🔴 那个三角在 16×16 viewBox 里只占中间一小块（约 5.7×8），所以默认渲染**又小、四周全是透明边**。
 *    → 用 transform-box:fill-box 按**图形自身**略微放大（**不能放太满**，否则比设置图标还大）。 */
.wc-runicon{overflow:visible;}
.wc-runicon path{fill:none;stroke:currentColor;stroke-width:1.1;stroke-linejoin:round;
  transform-box:fill-box;transform-origin:center;transform:scale(1.35);vector-effect:non-scaling-stroke;}
/* 三角在方框里左右还各留一截透明边 → 放在按钮里会把左边距撑大；用负外边距把它收回去 */
[data-wc-btn] .wc-runicon{margin-left:-4px;margin-right:-2px;}
[data-wc-cn-fieldlabel]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px;}
[data-wc-cn-row]{display:flex;gap:8px;align-items:center;}
/* box-sizing:border-box —— 否则 1px 边框会让输入框比旁边的按钮**高一点点** */
[data-wc-cn-input]{box-sizing:border-box;flex:1;min-width:0;height:34px;padding:0 10px;border-radius:8px;font:inherit;font-size:13px;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.28)));
  background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);outline:none;}
[data-wc-cn-input]:focus{border-color:var(--dsw-alias-state-business-primary,#4a8cff);}
/* 历史气泡行：**不换行、左右滚** */
[data-wc-cn-bubbles]{display:flex;flex-wrap:nowrap;gap:8px;overflow-x:auto;padding-bottom:2px;}
[data-wc-cn-bubble]{flex:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 6px 0 12px;
  border-radius:999px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));
  font-size:12px;white-space:nowrap;color:var(--dsw-alias-label-primary);}
[data-wc-cn-bubblex]{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;
  border:0;background:transparent;border-radius:999px;cursor:pointer;color:var(--dsw-alias-label-tertiary);}
[data-wc-cn-bubblex]:hover{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground,#fff);}
/* 探测中：三方块一行、文案另起一行（**各占一行**，都水平居中） */
[data-wc-cn-probe]{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:10px 0;
  color:var(--dsw-alias-label-tertiary);font-size:12px;}
[data-wc-cn-dots]{display:flex;align-items:center;gap:8px;}
[data-wc-cn-dot]{width:8px;height:8px;border-radius:2px;background:currentColor;opacity:.2;
  animation:wc-breathe 1.4s ease-in-out infinite;}
[data-wc-cn-dot]:nth-child(2){animation-delay:.2s;}
[data-wc-cn-dot]:nth-child(3){animation-delay:.4s;}
@keyframes wc-breathe{0%,100%{opacity:.2;}50%{opacity:1;}}
/* 局域网行区：限高滚动，与下方「选项」栏留距 */
[data-wc-cn-lans]{max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;margin-bottom:4px;}
/* 🔴 整张卡片**就是一个按钮**；运行图标**无缝嵌在里面**（不单独做按钮、没有自己的底色） */
[data-wc-cn-lan]{display:flex;align-items:center;gap:12px;width:100%;min-height:44px;padding:6px 12px;
  border:0;border-radius:10px;background:transparent;cursor:pointer;font:inherit;text-align:left;
  color:var(--dsw-alias-label-primary);transition:background .12s;}
[data-wc-cn-lan]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));}
[data-wc-cn-lan]:disabled{opacity:.6;cursor:default;}
[data-wc-cn-chip]{flex:none;font-size:11px;line-height:18px;padding:0 8px;border-radius:999px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary);}
[data-wc-cn-addr]{flex:none;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:13px;color:var(--dsw-alias-label-primary);}
/* MOTD：地址**右边**、灰色、**固定两行**。
 * 🔴 外层只负责"占两行高度 + **把文字垂直居中**"（否则单行 MOTD 会贴在 2 行框的顶部，看着比地址偏上） */
[data-wc-cn-motd]{flex:1;min-width:0;margin-left:14px;display:flex;align-items:center;
  min-height:32px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;}
[data-wc-cn-motdtext]{width:100%;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;}
[data-wc-cn-count]{flex:none;font-size:12px;color:var(--dsw-alias-state-success-primary);}
/* 版本号（玩家数左边）：在支持范围内绿、超出红 */
[data-wc-cn-ver]{flex:none;font-size:12px;color:var(--dsw-alias-state-success-primary);}
[data-wc-cn-ver][data-wc-cn-bad],[data-wc-cn-count][data-wc-cn-bad]{color:var(--dsw-alias-state-error-primary);}
[data-wc-cn-run]{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-label-secondary);}
[data-wc-cn-lan]:hover [data-wc-cn-run]{color:var(--dsw-alias-label-primary);}
/* 「连接」/ 局域网行的运行按钮：地址行那个与输入框**等高**（34px） */
[data-wc-cn-actions]{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;
  padding:0 12px;border:0;border-radius:8px;cursor:pointer;font-size:12px;font-family:inherit;line-height:1;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));color:var(--dsw-alias-label-primary);white-space:nowrap;}
[data-wc-cn-actions]:hover{background:var(--dsw-alias-state-business-primary,#4a8cff);
  color:var(--dsw-alias-label-primary-foreground,#fff);}
[data-wc-cn-actions]:disabled{opacity:.5;cursor:default;}
/* 底部配置行 */
[data-wc-cn-config]{display:flex;gap:20px;align-items:flex-start;}
/* 账户名后面的「（来源）」要**灰** */
[data-wc-cn-src]{color:var(--dsw-alias-label-tertiary);}
[data-wc-cn-pick]{position:relative;min-width:200px;}
[data-wc-cn-pickbtn]{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:32px;
  padding:0 10px;border-radius:8px;font:inherit;font-size:13px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.28)));
  background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);}
/* 下拉菜单**向上**展开：这一行在弹窗底部，向下会被卡片/滚动区裁掉 */
[data-wc-cn-menu]{position:absolute;left:0;right:0;bottom:calc(100% + 4px);z-index:5;max-height:240px;overflow:auto;
  border-radius:10px;padding:4px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));
  box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.3));}
[data-wc-cn-item]{display:block;width:100%;text-align:left;padding:7px 10px;border:0;border-radius:6px;
  background:transparent;cursor:pointer;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);}
[data-wc-cn-item]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));}
[data-wc-cn-item][data-wc-cn-manage]{color:var(--dsw-alias-label-tertiary);}
[data-wc-cn-extras]{flex:1;min-width:0;}

/* 注入开关 label 里的文件名：文件不存在 → 斜体灰删除线（hover 提示见 title） */
[data-wc-filename]{font-weight:400;}
[data-wc-filename][data-wc-missing]{font-style:italic;color:var(--dsw-alias-label-tertiary);
  text-decoration:line-through;cursor:default;}

/* —— 两栏：左标签页 + 右内容区（一次只渲染一页）—— */
[data-wc-panes]{display:flex;flex:1;min-height:0;}
[data-wc-side]{flex:none;width:132px;padding:12px 8px;overflow:auto;
  border-right:1px solid var(--dsw-alias-border-l2,transparent);
  background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));
  display:flex;flex-direction:column;gap:2px;}
[data-wc-tab]{display:block;width:100%;text-align:left;padding:8px 10px;border:0;border-radius:8px;
  background:transparent;cursor:pointer;font-family:inherit;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-secondary);}
[data-wc-tab]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));
  color:var(--dsw-alias-label-primary);}
[data-wc-tab][data-wc-tab-on]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-overlay));
  color:var(--dsw-alias-label-primary);font-weight:600;}
[data-wc-pane]{flex:1;min-width:0;overflow:auto;padding:16px 20px 24px;}

[data-wc-sec]{margin-bottom:22px;}
[data-wc-sec]:last-child{margin-bottom:0;}
[data-wc-h]{margin:0 0 10px;font-size:12px;font-weight:600;line-height:1.4;
  color:var(--dsw-alias-label-secondary);}
[data-wc-note]{margin:0 0 12px;padding:8px 10px;border-radius:8px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-tertiary);}
[data-wc-alert]{margin:0 0 12px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px;
  word-break:break-word;background:var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-label-primary-foreground,#fff);}
[data-wc-ok]{margin:0 0 12px;padding:6px 10px;border-radius:8px;font-size:11px;line-height:16px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:var(--dsw-alias-label-tertiary);}
[data-wc-dim]{color:var(--dsw-alias-label-tertiary);}

/* ── 账户页：抬头（右上角「添加」）+ 横条 + 类型气泡 ─────────────────────── */
[data-wc-panehead]{display:flex;align-items:center;gap:10px;margin:0 0 12px;}
[data-wc-panehead] [data-wc-h]{margin:0;}
[data-wc-spacer]{flex:1;min-width:0;}
[data-wc-acct]{display:flex;align-items:center;gap:8px;height:44px;padding:0 8px 0 12px;margin-bottom:6px;
  border-radius:10px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));}
[data-wc-acct]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));}
[data-wc-acctname]{font-size:13px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;color:var(--dsw-alias-label-primary);}
/* 第三方账户的服务器名（小字号灰字；没有名字就显示 url） */
/* 「提示词」页顶部的注入状态（2026-09-16）：一眼看出会不会注入、为什么不会 */
[data-wc-injectstatus]{font-size:12px;line-height:18px;color:var(--dsh-text-2,#9aa0a6);margin:0 0 8px;}
[data-wc-injectstatus] [data-wc-note]{font-size:11px;line-height:16px;color:var(--dsh-text-3,#7a8085);margin-top:2px;}
[data-wc-hint] strong{font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6);}
[data-wc-acctsub]{font-size:11px;line-height:16px;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;color:var(--dsw-alias-label-tertiary);}
[data-wc-acctacts]{flex:none;display:flex;align-items:center;gap:2px;}
[data-wc-chip]{display:inline-flex;align-items:center;flex:none;height:20px;padding:0 9px;border-radius:999px;
  font-size:11px;line-height:1;white-space:nowrap;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary);}
[data-wc-chip][data-wc-chip-offline]{background:var(--dsw-alias-state-business-primary,rgba(64,128,255,.18));
  color:var(--dsw-alias-label-primary);}
[data-wc-chip][data-wc-chip-ygg]{background:var(--dsw-alias-state-success-primary,rgba(0,180,120,.18));
  color:var(--dsw-alias-label-primary);}
[data-wc-chip][data-wc-chip-ms]{background:var(--dsw-alias-state-warn-primary,rgba(255,180,0,.18));
  color:var(--dsw-alias-label-primary);}
[data-wc-chip][data-wc-chip-default]{background:transparent;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.3)));}
/* ── 正版（微软）设备码登录：网址 + 大号代码（代码要能一眼看清、能选中） ── */
[data-wc-msauri]{font-size:12px;line-height:18px;word-break:break-all;margin:6px 0 2px;}
[data-wc-msacode]{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:26px;font-weight:700;letter-spacing:3px;text-align:center;padding:10px 0;
  user-select:all;color:var(--dsw-alias-label-primary);}

/* ── 新建/编辑：类型选择 / 字段 / 已缓存服务器标签 ─────────────────────── */
[data-wc-typelist]{display:flex;flex-direction:column;gap:8px;}
[data-wc-type]{display:flex;flex-direction:column;gap:3px;padding:12px 14px;border-radius:12px;text-align:left;
  cursor:pointer;font-family:inherit;border:1px solid transparent;
  background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));color:var(--dsw-alias-label-primary);}
[data-wc-type]:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);}
[data-wc-type]:disabled{opacity:.5;cursor:not-allowed;}
[data-wc-typename]{font-size:13px;font-weight:600;line-height:18px;}
[data-wc-typedesc]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
[data-wc-field]{display:flex;flex-direction:column;gap:6px;margin:0 0 12px;}
[data-wc-label]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);}
[data-wc-field] [data-wc-in]{width:100%;height:32px;box-sizing:border-box;}
[data-wc-tags]{display:flex;flex-wrap:wrap;gap:6px;}
/* 拽托接受区（authlib-injector 卡片）：**要看得见**——老版有一块虚线区，别偷偷摸摸只挂在输入框上 */
[data-wc-drop]{display:flex;align-items:center;justify-content:center;height:36px;margin-top:6px;
  border-radius:8px;font-size:11px;line-height:16px;text-align:center;
  color:var(--dsw-alias-label-tertiary);
  border:1px dashed var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.4)));}
[data-wc-drop][data-wc-drag]{border-color:var(--dsw-alias-state-business-primary);
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));
  color:var(--dsw-alias-label-primary);}
/* 开关放进动作行时不要它自带的下边距 */
[data-wc-acts] [data-wc-switchrow]{margin:0;}
[data-wc-tag]{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 4px 0 10px;border-radius:999px;
  font-size:12px;line-height:1;border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.3)));
  background:transparent;color:var(--dsw-alias-label-secondary);}
[data-wc-tag][data-wc-tag-on]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);}
[data-wc-tagpick]{display:inline-flex;align-items:center;height:24px;padding:0 2px;border:0;background:transparent;
  cursor:pointer;font-family:inherit;font-size:12px;line-height:1;color:inherit;max-width:190px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-wc-tagx]{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;
  border:0;border-radius:999px;background:transparent;cursor:pointer;font-family:inherit;font-size:12px;line-height:1;
  color:var(--dsw-alias-label-tertiary);}
[data-wc-tagx]:hover{background:var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-label-primary-foreground,#fff);}
[data-wc-acts]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px;}
[data-wc-val]{word-break:break-all;user-select:text;}

/* ── 表单控件 ──────────────────────────────────────────────────────────── */
[data-wc-in]{height:28px;padding:0 9px;border-radius:8px;font-size:12px;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.28)));
  background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));
  color:var(--dsw-alias-label-primary);outline:none;min-width:0;}
[data-wc-in]:focus{border-color:var(--dsw-alias-state-business-primary);}
[data-wc-in]::placeholder{color:var(--dsw-alias-label-tertiary);}
select[data-wc-in]{appearance:none;padding-right:22px;
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 14px) 12px,calc(100% - 9px) 12px;background-size:5px 5px,5px 5px;
  background-repeat:no-repeat;}
[data-wc-w-name]{width:130px;}
[data-wc-w-uuid]{width:250px;}
[data-wc-w-grow]{flex:1;min-width:150px;}
[data-wc-form]{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 4px;}
[data-wc-textarea]{display:block;width:100%;min-height:150px;padding:10px;border-radius:8px;
  font-size:12px;line-height:18px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  resize:vertical;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.28)));
  background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));
  color:var(--dsw-alias-label-primary);outline:none;}
[data-wc-textarea]:focus{border-color:var(--dsw-alias-state-business-primary);}
[data-wc-textarea][data-wc-tall]{min-height:300px;}
/* 「已允许所有指令」时白名单框：仍可编辑，但灰掉表示暂不生效 */
[data-wc-textarea][data-wc-dimmed]{opacity:.45;cursor:not-allowed;}
[data-wc-hint]{margin:8px 0 0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);}
[data-wc-hint][data-wc-dirty]{color:var(--dsw-alias-state-warn-primary,rgba(255,180,0,1));}
[data-wc-code]{padding:0 4px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));}
[data-wc-warnnote]{margin:0 0 10px;padding:8px 10px;border-radius:8px;font-size:11px;line-height:16px;
  background:var(--dsw-alias-state-warn-primary,rgba(255,180,0,.18));
  color:var(--dsw-alias-label-primary);}
/* ── 开关（用于「允许所有指令」/「注入 AGENTS.md」）───────────────────── */
[data-wc-switchrow]{display:flex;align-items:flex-start;gap:10px;margin:0 0 12px;}
[data-wc-switchmain]{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}
[data-wc-switchlabel]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);}
[data-wc-switchdesc]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
[data-wc-switch]{flex:none;position:relative;width:34px;height:20px;margin-top:2px;padding:0;
  border:0;border-radius:999px;cursor:pointer;font:inherit;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.3));transition:background .15s ease;}
[data-wc-switch]:disabled{opacity:.4;cursor:not-allowed;}
[data-wc-knob]{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;
  background:var(--dsw-alias-label-primary-foreground,#fff);transition:left .15s ease;}
[data-wc-switch][data-wc-on]{background:var(--dsw-alias-state-business-primary,#4a8cff);}
[data-wc-switch][data-wc-on] [data-wc-knob]{left:16px;}
`

    /* ==================================================================
     * 模块级事件总线
     * ----------------------------------------------------------------
     * hero 那个「MC设置」按钮是**纯 DOM**（宿主没暴露 react-dom，不能 createPortal），
     * 所以它没法直接 setState —— 它只 emit，由 React 侧的 McSettingsHost 订阅并开关模态框。
     * 总线**不传任何凭据**，只传一个空标记。
     * ================================================================== */
    const settingsBus = {
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        for (const fn of Array.from(this.listeners)) {
          try { fn() } catch (e) { /* 单个订阅者出错不影响别人 */ }
        }
      },
    }
    const openSettings = () => settingsBus.emit()
    /** 同款总线：「连接到MC」的 hero 按钮也是纯 DOM，用它叫醒 React 侧的模态框 */
    const connectBus = {
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        for (const fn of Array.from(this.listeners)) {
          try { fn() } catch (e) { /* 单个订阅者出错不影响别人 */ }
        }
      },
    }
    const openConnect = () => connectBus.emit()

    /* ==================================================================
     * 接口小工具（契约见 index.js 的 /api/mc/accounts 等路由）
     * ================================================================== */

    /** 统一的错误对象：带上后端的 needUserAction / hint，方便前端提示得具体些 */
    function apiError(payload, status) {
      const e = new Error(payload?.error || payload?.message || `请求失败（HTTP ${status}）`)
      if (payload?.needUserAction) e.needUserAction = true
      if (payload?.hint) e.hint = String(payload.hint)
      return e
    }

    async function apiFetch(path, opts) {
      const init = Object.assign({ headers: { accept: 'application/json' } }, opts)
      if (init.body !== undefined && init.body !== null) {
        init.method = init.method || 'POST'
        init.headers = Object.assign({}, init.headers, { 'content-type': 'application/json' })
        init.body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
      }
      let res
      try {
        res = await fetch(path, init)
      } catch (e) {
        throw new Error(`连不上后端：${e?.message ?? e}`)
      }
      let payload = null
      try { payload = await res.json() } catch (e) { payload = null }
      if (!res.ok || !payload || payload.ok !== true) throw apiError(payload, res.status)
      return payload
    }

    const apiGet = (path) => apiFetch(path, { method: 'GET' })
    const apiPost = (path, body) => apiFetch(path, { method: 'POST', body })
    const apiPatch = (path, body) => apiFetch(path, { method: 'PATCH', body })
    const apiPut = (path, body) => apiFetch(path, { method: 'PUT', body })
    const apiDelete = (path, body) => apiFetch(path, { method: 'DELETE', body })

    /** 把错误变成模态框顶部红条里的一行字 */
    const errorText = (e) => {
      if (!e) return ''
      const msg = String(e.message ?? e)
      return e.hint ? `${msg}｜${e.hint}` : msg
    }

    /* 2026-10-15 用户：「把命令都列出来并配上开关，把白名单和保存给去了」
     *   ⇒ 白名单页不再是一个多行文本框，`whitelistToText` / `textToWhitelist` 这两个
     *      "数组 ↔ 多行文本"的助手随之删掉（名单现在是数组，服务端下发 `commandCatalog`
     *      逐条给 `on`）。 */

    /* ==================================================================
     * 现有：状态条（3s 轮询 /api/mc/status）
     * ================================================================== */

    /**
     * 轮询本会话的 MC 状态；不在游戏里就不渲染。
     *
     * 🔴 2026-10-15 审计（报告第 6 条）：原来 `.catch(() => { if (alive) setState(null) })`
     *    —— **一次**轮询失败（服务端重启、瞬时 5xx、网络抖动）就把状态清成 null，
     *    而渲染门是 `if (!state || state.active !== true) return null` ⇒
     *    整个状态条（**含唯一入口「强制停止」**）凭空消失，用户既看不到状态、也没法停。
     *    现在：**失败保留上一次读到的状态**，只累加"连续失败次数"，
     *    由 `McStatusBar` 把这件事说出来（读不到 ≠ 不在游戏里）。
     * @returns {[object|null, Function, number]} [状态, setState, 连续失败次数]
     */
    function useMcStatus(sessionId, nonce) {
      const [state, setState] = React.useState(null)
      const [pollFail, setPollFail] = React.useState(0)
      React.useEffect(() => {
        if (!sessionId) return undefined
        let alive = true
        const tick = () => {
          fetch('/api/mc/status?sessionId=' + encodeURIComponent(sessionId), {
            headers: { accept: 'application/json' },
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
              if (!alive) return
              if (j && typeof j === 'object') { setPollFail(0); setState(j) }
              // 非 200 / 空体：**不动 state**，只记一次失败
              else setPollFail((n) => n + 1)
            })
            .catch(() => { if (alive) setPollFail((n) => n + 1) })
        }
        tick()
        const timer = setInterval(tick, 3000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId, nonce])          // nonce 变一次 = 立刻重读一次（强制停止后不用等 3s）
      return [state, setState, pollFail]
    }

    /**
     * 状态条上要显示的**服务器地址**：`host[:port]`（非默认端口才带端口），
     * 有子服时再跟一个 `· 子服域名`（Velocity 的 forced-host）。
     *
     * 🔴 用户 2026-09-16："状态条是不是只显示'在游戏中'？应该显示服务器地址，太长则截断。"
     *    地址由 `/api/mc/status` 的 `connection` 给（只有 host/port/subserver，**没有账号**）。
     * @returns {string} 地址；一个都没有就返回空串（此时状态条只显示"在游戏中"）
     */
    function mcAddress(state) {
      const conn = state?.connection ?? null
      const host = String(conn?.host ?? '').trim()
      const port = Number(conn?.port ?? 0) || 0
      const sub = String(conn?.subserver || state?.sub || '').trim()
      const endPoint = host ? (port && port !== 25565 ? host + ':' + port : host) : ''
      if (endPoint && sub && sub !== host) return endPoint + ' · ' + sub
      return endPoint || sub
    }

    function McStatusBar(props) {
      // session scope 的标准 props；兼容 session 对象形态
      const sessionId = props?.sessionId ?? props?.session?.id
      const [pollNow, setPollNow] = React.useState(0)
      const [state, , pollFail] = useMcStatus(sessionId, pollNow)
      const [busy, setBusy] = React.useState(false)
      // 🔴 报告第 5 条：强制停止原来 `.catch(() => {})` —— 连"服务端说没停成"都看不见。
      const [stopErr, setStopErr] = React.useState('')

      // 只有一个动作：强制停止（用户 2026-09-16："移除停止，只剩强行停止"）。
      // 后端顺序：停 LLM → 优雅退游戏 → 清该会话后台任务 → 再停一次 LLM。
      const stop = React.useCallback(() => {
        if (!sessionId) return
        setBusy(true)
        setStopErr('')
        fetch('/api/mc/stop', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, reason: '用户强制停止' }),
        })
          .then(async (r) => {
            let j = null
            try { j = await r.json() } catch (e) { j = null }
            // 🔴 报告第 5 条：HTTP 层与业务层都要判 —— 以前两个都不看，
            //    服务端回了 `{ok:false, error:…}` 界面上也像"成功"。
            if (!r.ok) throw new Error(`服务端返回 HTTP ${r.status}`)
            if (!j || j.ok !== true) throw new Error(String(j?.error ?? j?.message ?? '服务端没有确认停止'))
            // 停完立刻重读一次状态，别等下一个 3s 轮询（用户点完要马上看到变化）
            setPollNow((n) => n + 1)
          })
          .catch((e) => { setStopErr(String(e?.message ?? e ?? '停止失败')) })
          .finally(() => { setBusy(false) })
      }, [sessionId])

      // 不在游戏里 → 不占位（⚠️ 读不到状态**不算**不在游戏里，见 useMcStatus）
      if (!sessionId || !state || state.active !== true) return null

      const online = state.online === true
      const address = mcAddress(state)
      // 太长就截断（完整地址留在 tooltip 里）
      const shown = address.length > 26 ? address.slice(0, 25) + '…' : address
      const timeouts = Number(state.timeouts ?? 0)
      const stale = timeouts > 0
      // 连续失败 ≥2 次（约 6s）才提示"读不到"，单次抖动不打扰
      const pollBad = pollFail >= 2
      // 🔴 断线但正在自动重连（2026-09-19）：状态条要**说出**这件事，
      //    不能因为 online=false 就整个消失（用户会以为插件把状态忘了、AI 也以为还在游戏里）。
      const reconnecting = !online && state.reconnecting === true
      const label = online ? '在游戏中' : (reconnecting ? '重连中…' : '未上线')
      const tip0 = online
        ? `${address ? address + '：' : ''}在游戏中${stale ? `（有 ${timeouts} 次操作超时，可能已失步）` : ''}`
        : (reconnecting
          ? `连接断了${address ? '（' + address + '）' : ''}，插件正在自动重连…`
          : (address ? `已连接 ${address} 但角色不在线` : '已连接但角色不在线'))
      const tip = [
        tip0,
        pollBad ? `状态读不到（连续 ${pollFail} 次）—— 显示的是最后一次读到的状态` : '',
        stopErr ? `强制停止失败：${stopErr}` : '',
      ].filter(Boolean).join('\n')

      return React.createElement(
        'div',
        {
          'data-mc-status': '',
          ...(busy ? { 'data-mc-busy': '' } : {}),
          ...(reconnecting ? { 'data-mc-reconnecting': '' } : {}),
          ...(pollBad || stopErr ? { 'data-mc-warn': '' } : {}),
          title: tip,
        },
        React.createElement('span', { 'data-mc-dot': '', ...(online && !stale ? {} : { 'data-mc-warn': '' }) }),
        React.createElement('span', { 'data-mc-text': '' }, pollBad ? '状态读不到' : label),
        address ? React.createElement('span', { 'data-mc-sub': '', title: address }, shown) : null,
        stopErr ? React.createElement('span', { 'data-mc-sub': '', title: stopErr }, '停止失败') : null,
        React.createElement('button', {
          type: 'button', 'data-mc-btn': '', 'data-mc-danger': '',
          disabled: busy,
          title: '强制停止：中断当前生成并让机器人退出游戏',
          onClick: () => stop(),
        }, busy ? '停止中…' : '强制停止'),
      )
    }

    /* ==================================================================
     * 标题条上的「MC设置」按钮 + 模态框（同一个插槽条目）
     * ----------------------------------------------------------------
     * order 45 → 排在状态条（50）左边；官方预设标签是 -10，所以最终是
     *   预设标签 → MC设置 → 状态条
     * 按钮和模态框装在**同一个条目**里：列表插槽的每个条目各有一层
     * `display:contents` 包裹 + 错误边界（见 ui-renderer/scoped-slots.tsx），
     * 单独拿一个条目去渲染全屏遮罩会平白多一层无意义包裹；组件返回
     * Fragment（按钮 + 关闭时为 null 的遮罩），关闭状态下 DOM 里只剩按钮。
     *
     * 🔴 **判据必须是本地就有的**：读会话记录的 agent preset
     *    （`props.useSessions` 快照里的 `projectionValues.agentPreset`）——
     *    这正是标题条那个官方「MC模式」标签用的**同一个源**，所以"用户看到什么模式，
     *    按钮就按什么模式显示"，且**不受任何网络请求成败影响**。
     *
     * 🔴 2026-09-16 事故（别再犯）：第一版改成 `fetch('/api/mc/mode')` 问服务端。
     *    浏览器在**新接口上线之前**就通过 HMR 拿到了新客户端 → 那次请求 404 →
     *    组件把它当成"不是 MC 模式"，而且**只问一次、再不重试** ⇒ 重启之后
     *    MC 模式里也永远没有按钮（非得刷新页面）。**门控不许依赖一次性网络请求。**
     *
     * 名单（哪些 preset 算 MC 模式，含 MC+）取服务端 **`/api/mc/presets`**（专门给门控用的极小接口，
     * 不需要 sessionId / 工作区 —— `/api/mc/config` 现在要工作区，用它会被拒而静默退回兜底名单）；
     * 没回来之前先用插件默认值 `['minecraft','minecraft-plus','dsh-mc-agent']`（与后端默认一致）。
     * 服务端 `/api/mc/mode` 仍保留，供排查与测试用，前端不再依赖它。
     * ================================================================== */
    const MC_PRESETS_FALLBACK = ['minecraft', 'minecraft-plus', 'dsh-mc-agent']
    /**
     * 🔴 2026-10-15 审计（报告第 9 条）：这里原来是一个**模块级可变变量** `mcPresetIds`，
     *    由异步 `fetch` 就地改写；而读它的地方是 `useMcSettingsGate` 里的
     *    `localShow = … && mcPresetIds.includes(preset)` —— **普通变量不是 React state，
     *    改了不会触发重渲染**。于是 `/api/mc/presets` 晚到（哪怕只晚一帧）时，
     *    门控会一直拿兜底名单算下去，直到碰巧有别的 state 变化才"突然正确"。
     *    现在改成：模块级只做**一次性的请求缓存**（`mcPresetIdsCache` + 共享的 in-flight Promise），
     *    真正的名单进 hook 的 state —— 晚到也会重渲染。
     */
    let mcPresetIdsCache = null
    let mcPresetIdsPromise = null

    /**
     * 🟢 2026-10-15 审计（报告第 10 条）：同一个接口现在**也带支持版本范围**
     *    （`testedVersions` / `oldestVersion` / `latestVersion`）。以前客户端的版本门控是
     *    `MC_VERSION_IN_RANGE = () => null` —— 一个永远"未知"的桩，于是"版本不匹配"的拦截
     *    与红标**一行都到不了**。现在真判，所以缓存整个门控信息（名单 + 版本范围）。
     */
    let mcGateInfoCache = null
    let mcGateInfoPromise = null

    /**
     * 拉「门控信息」：`{ presets, tested, oldest, latest }`。
     *
     * 一次性缓存 + 共享 in-flight Promise（同 `loadMcPresetIds` 的老规矩）：
     * 空结果/失败都把 promise 置 null，允许下次挂载重试 —— **别让一次网络抖动
     * 把门控永久钉在兜底值上**（2026-09-16 踩过）。
     */
    function loadMcGateInfo() {
      if (mcGateInfoCache) return Promise.resolve(mcGateInfoCache)
      if (mcGateInfoPromise) return mcGateInfoPromise
      mcGateInfoPromise = Promise.resolve()
        .then(() => fetch('/api/mc/presets', { headers: { accept: 'application/json' } }))
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          const presets = Array.isArray(j?.mcModePresets) ? j.mcModePresets.map(String).filter(Boolean) : []
          const tested = Array.isArray(j?.testedVersions) ? j.testedVersions.map(String).filter(Boolean) : []
          const latest = typeof j?.latestVersion === 'string' && j.latestVersion
            ? j.latestVersion
            : (tested[tested.length - 1] ?? null)
          if (!presets.length && !tested.length) {
            mcGateInfoPromise = null            // 空结果不算数，允许下次挂载再试
            return null
          }
          mcGateInfoCache = { presets, tested, oldest: j?.oldestVersion ?? tested[0] ?? null, latest }
          return mcGateInfoCache
        })
        .catch(() => { mcGateInfoPromise = null; return null })   // 失败允许下次挂载再试
      return mcGateInfoPromise
    }

    /** 只要 preset 名单（老调用点用的就是它）。 */
    function loadMcPresetIds() {
      if (mcPresetIdsCache) return Promise.resolve(mcPresetIdsCache)
      if (mcPresetIdsPromise) return mcPresetIdsPromise
      mcPresetIdsPromise = loadMcGateInfo()
        .then((info) => {
          if (info && info.presets.length) { mcPresetIdsCache = info.presets; return info.presets }
          mcPresetIdsPromise = null            // 空结果不算数，允许下次挂载再试
          return null
        })
        .catch(() => { mcPresetIdsPromise = null; return null })   // 失败允许下次挂载再试
      return mcPresetIdsPromise
    }

    /**
     * 「MC设置」入口的**共用门控**。
     *
     * 判据完全本地：会话记录的 agent preset（`props.useSessions` 快照里的
     * `projectionValues.agentPreset`）——这正是标题条那个官方「MC模式」标签用的**同一个源**，
     * 所以"用户看到什么模式，入口就按什么模式出现"，且不受网络请求成败影响。
     *
     * @param props 插槽 props（宿主会给 session scope 注入 `sessionId` / `useSessions`）
     * @param wantBlank true = 只认**新会话页**（会话还是 blank），false = 只认已有会话
     * @returns 是否渲染入口
     */
    function useMcSettingsGate(props, wantBlank) {
      const sessionId = props?.sessionId ?? props?.session?.id
      const useSessions = props?.useSessions
      const [serverMode, setServerMode] = React.useState(null)
      // 🔴 报告第 9 条：名单必须是 state，异步回来才会重渲染
      const [presetIds, setPresetIds] = React.useState(MC_PRESETS_FALLBACK)

      React.useEffect(() => {
        let alive = true
        loadMcPresetIds().then((list) => { if (alive && list) setPresetIds(list) })
        return () => { alive = false }
      }, [])

      // ⚠️ useSessions 是宿主注入的标准 prop（官方标签也用它），组件生命周期内恒定存在，
      //    所以这两个条件调用不会改变 hook 数量。选择器只返回**原始值**，避免每次渲染造新对象。
      const sess = typeof useSessions === 'function' ? useSessions : null
      const blank = sess
        ? sess((state) => {
          const s = state?.byId?.[sessionId]
          return s === undefined ? undefined : s.blank === true
        })
        : undefined
      const preset = sess
        ? sess((state) => {
          const value = state?.byId?.[sessionId]?.projectionValues?.agentPreset
          return typeof value === 'string' ? value : undefined
        })
        : undefined

      const known = blank !== undefined && preset !== undefined

      // 兜底：**只有本地判不了**（拿不到会话数据）时，且只让标题条那个入口去问服务端，
      // 而且**必须重试**——一次性请求失败 = 入口永久消失，这个坑 2026-09-16 刚踩过。
      const needServer = !known && !wantBlank
      React.useEffect(() => {
        if (!needServer || !sessionId) return undefined
        let alive = true
        let tries = 0
        let timer = null
        const tick = () => {
          fetch('/api/mc/mode?sessionId=' + encodeURIComponent(sessionId), {
            headers: { accept: 'application/json' },
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
              if (!alive) return
              if (j?.mcMode === true) setServerMode(true)
              else if (++tries < 20) timer = setTimeout(tick, 3000)
            })
            .catch(() => { if (alive && ++tries < 20) timer = setTimeout(tick, 3000) })
        }
        tick()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [needServer, sessionId])

      const localShow = known && blank === wantBlank && presetIds.includes(preset)

      /**
       * 🔴 2026-09-16 用户："没有选中工作区，则拒绝发起 MC 模式会话和设置。"
       *    当时的做法是"服务端说没工作区 ⇒ **本地 preset 再像 MC 模式也不显示入口**"。
       *
       * 🔴 2026-09-18 用户改口径：**有没有选工作区，只要选中了 MC 模式就显示按钮**，
       *    工作区改到**点按钮那一刻**再检查（没有就提示先选）—— 两个入口**统一**这么办：
       *      · 新对话页 hero 那个入口（`wantBlank`）；
       *      · 已有会话标题条那个入口。
       *    这样也顺手去掉了一条"服务端说不显示就不显示"的网络依赖（曾经让入口永久消失过）。
       *    服务端"没工作区就不套白名单/不注入/不建记忆目录"的行为没变，变的只是入口可见性。
       */
      if (localShow) return true
      if (known) return false
      return !wantBlank && serverMode === true
    }

    /* ==================================================================
     * 「MC设置」的**工作区检查**（2026-09-18 用户要求）
     * ----------------------------------------------------------------
     * 口径变了：**入口一律显示**（只要选中 MC 模式），**点了才检查工作区**。
     * 没选工作区 → 原生提示"先去选一个工作区"（不用自定义模态框：这件事一句话就说完）。
     * 判定取两处，互相兜底：
     *   · **本地**：`useWorkspaceCwd` 读会话的 `cwd`（新对话页工作区一选就落进 projection）；
     *   · **服务端**：`/api/mc/mode` 的 `hasWorkspace`（本地还没落盘时的权威值）。
     * 用三态：`true` 有 · `false` 明确没有 · `null` 还不知道（**拿不准就不拦**，让服务端去拒绝，
     * 免得"一次请求失败 = 用不了设置"这类老坑重演）。
     * ================================================================== */
    function useMcWorkspaceReady(props, active) {
      const sessionId = props?.sessionId ?? props?.session?.id
      const localCwd = useWorkspaceCwd(props)
      const [serverHas, setServerHas] = React.useState(null)
      React.useEffect(() => {
        if (!active || !sessionId) return undefined
        let alive = true
        fetch('/api/mc/mode?sessionId=' + encodeURIComponent(sessionId), { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => { if (alive && typeof j?.hasWorkspace === 'boolean') setServerHas(j.hasWorkspace) })
          .catch(() => { /* 拿不到就不下结论（返回 null ⇒ 不拦） */ })
        return () => { alive = false }
      }, [active, sessionId])
      if (typeof localCwd === 'string' && localCwd) return true
      return serverHas
    }

    /** 没选工作区时的提示（**优先原生**：用户要求） */
    const NO_WORKSPACE_TIP = '请先在这个对话里选择一个工作区，再打开「MC设置」。\n\n'
      + 'MC 模式的记忆与提示词都放在工作区的 .dsh-mc-agent 目录里，没有工作区就没有地方放。'

    /**
     * 当前会话（或新对话页那个 blank 会话）**选中的工作区**。
     * 🔴 2026-09-16：新对话页还没开聊时，会话在服务端可能还没落盘 ——
     *    但**工作区是已经选好了的**，所以把它一起报给服务端（`cwd` 兜底参数），
     *    免得"明明选了工作区却被拒绝"。服务端只认绝对路径、真实存在、**而且要在宿主的工作区
     *    注册表里**（或已经带过 `.dsh-mc-agent/`）的目录 —— 2026-10-15 审计收紧了这条，
     *    以前"任意存在的目录"都会被当工作区（能被 `DELETE /api/mc/express?cwd=…` 递归删）。
     */
    function useWorkspaceCwd(props) {
      const sessionId = props?.sessionId ?? props?.session?.id
      const useSessions = props?.useSessions
      const sess = typeof useSessions === 'function' ? useSessions : null
      return sess && sessionId
        ? sess((state) => {
          const v = state?.byId?.[sessionId]?.cwd
          return typeof v === 'string' && v ? v : undefined
        })
        : undefined
    }

    /* ── 更新红点（用户 2026-10-20）：三个「MC设置」入口共用一份状态 ──────────
     * 这里只缓存"有没有新版本"这一个布尔（后端本来就有 10 分钟缓存，这层再挡一次，
     * 免得三个入口各查一遍）。查不到 / 不是 git 仓库 ⇒ 一律当"没有"，绝不打扰。
     * 🔴 红点 = 按钮上的 `data-wc-update` 属性，样式是 `::after` 画的一个绝对定位点
     *    （见文件顶部 CSS），所以**纯 DOM 注入的 hero 按钮也能用**。 */
    const UPDATE_BADGE_TTL_MS = 10 * 60 * 1000
    const updateBadge = { at: 0, behind: 0, inflight: null, listeners: new Set() }

    function updateBadgeRefresh (force = false) {
      if (!force && updateBadge.inflight === null && Date.now() - updateBadge.at < UPDATE_BADGE_TTL_MS) {
        return Promise.resolve(updateBadge.behind > 0)
      }
      if (updateBadge.inflight) return updateBadge.inflight
      updateBadge.inflight = apiGet('/api/mc/update' + (force ? '?force=1' : ''))
        .then((r) => { updateBadge.behind = Number(r?.behind ?? 0) || 0 })
        .catch(() => { updateBadge.behind = 0 })
        .then(() => {
          updateBadge.at = Date.now()
          updateBadge.inflight = null
          for (const fn of updateBadge.listeners) {
            try { fn(updateBadge.behind > 0) } catch (e) { /* 订阅者自己炸了不影响别人 */ }
          }
          return updateBadge.behind > 0
        })
      return updateBadge.inflight
    }

    /** `active` = 这个入口现在显示不显示；不显示就别去查（非 MC 会话别白轮询）。 */
    function useUpdateBadge (active) {
      const [on, setOn] = React.useState(() => updateBadge.behind > 0)
      React.useEffect(() => {
        if (!active) return undefined
        updateBadge.listeners.add(setOn)
        setOn(updateBadge.behind > 0)
        updateBadgeRefresh(false)
        return () => { updateBadge.listeners.delete(setOn) }
      }, [active])
      return active === true && on
    }

    /**
     * 标题条上的「MC设置」按钮（order 45，落在状态条左边）。
     * 只在**已有会话**里出现；新会话页那个是下面 `McSettingsDockEntry`。
     *
     * 按钮和模态框装在**同一个条目**里：列表插槽的每个条目各有一层
     * `display:contents` 包裹 + 错误边界（见 ui-renderer/scoped-slots.tsx），
     * 单独拿一个条目去渲染全屏遮罩会平白多一层无意义包裹。
     *
     * 🔴 两个入口靠 `blank` **互斥**，所以任何时刻只挂一个模态框。
     *    （模态框之间靠 `settingsBus` 广播打开——两个同时挂着会一起弹出来。）
     * ================================================================== */
    function McSettingsEntry(props) {
      const show = useMcSettingsGate(props, false)
      const wsCwd = useWorkspaceCwd(props)
      const hasUpdate = useUpdateBadge(show)
      if (!show) return null

      return React.createElement(
        React.Fragment,
        null,
        React.createElement('button', {
          type: 'button',
          'data-wc-btn': '',
          'data-wc-icon': '',
          'data-wc-mc-settings': '',
          ...(hasUpdate ? { 'data-wc-update': '' } : {}),
          title: hasUpdate ? 'MC设置：账户、提示词与指令白名单（有新版本）' : 'MC设置：账户、提示词与指令白名单',
          'aria-label': 'MC设置',
          onClick: openSettings,
        }, IconSettingsOutlineRegular ? React.createElement(IconSettingsOutlineRegular, { size: 16 }) : 'MC设置'),
        React.createElement(McSettingsModal, { ...props, wsCwd }),
      )
    }

    /* ==================================================================
     * 「连接到MC」入口①：**标题条**按钮（order 40，落在「设置」左边）
     * ----------------------------------------------------------------
     * 门控与「设置」一致（MC 模式，本地 preset 判定）；**在游戏中时隐藏**。
     * 按钮 = 运行图标 + 文字「连接到MC」。受控打开 `McConnectModal`。
     * ================================================================== */
    function McConnectEntry(props) {
      const sid = props?.sessionId ?? props?.session?.id ?? null
      const show = useMcSettingsGate(props, false)
      // 只在"要显示"时才轮询状态（非 MC 会话别白轮询）
      const [st] = useMcStatus(show ? sid : null)
      const [open, setOpen] = React.useState(false)
      if (!show) return null
      if (st?.active === true) return null          // 在游戏中 → 隐藏
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('button', {
          type: 'button',
          'data-wc-btn': '',
          title: '连接到MC：填地址或选局域网服务器',
          onClick: () => setOpen(true),
        },
        React.createElement(RunIcon, { size: 15 }),
        '连接到MC'),
        React.createElement(McConnectModal, { open, onClose: () => setOpen(false), sessionId: sid, asUser: false }),
      )
    }

    /**
     * 「连接到MC」的 React 宿主：给 hero 的纯 DOM 按钮用（订阅 connectBus）。
     * 🔴 **新对话页**：提示词注入在新会话里不灵 → 改走"**模拟玩家发言**"（`asUser: true`，
     *    正文前加 `[system] `）；对话中（标题条那个）仍走插件提示行。
     */
    function McConnectHost(props) {
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => connectBus.subscribe(() => setOpen(true)), [])
      const sessionId = props?.sessionId ?? props?.session?.id ?? null
      return React.createElement(McConnectModal, { open, onClose: () => setOpen(false), sessionId, asUser: true })
    }

    /* ==================================================================
     * 「MC设置」入口③：**插件页 → dsh-mc-agent 详情页**头部的按钮（2026-10-04，演示）
     * ----------------------------------------------------------------
     * 插件管理页的 `plugins.detail.actions` 插槽是 **root 作用域**（无会话、无工作区），
     * 所以这里**只渲染一个按钮**、不挂模态框（现有模态框依赖 sessionId / 工作区）。
     * 自过滤：只认 dsh-mc-agent 自己的 bundle 页（`subject.kind==='bundle'` 且包名匹配）；
     * 别的 bundle / row / item 一律返回 null（官方约定：对无关 subject 返回 null）。
     * ⚠️ 当前点击是**空操作** —— 只演示入口位置，后端解耦与面板接入待后续。
     * ================================================================== */
    const DETAIL_BUNDLE_NAME = 'dsh-mc-agent'
    /**
     * 「设置」入口③：**插件页 → dsh-mc-agent 详情页**头部的按钮（2026-10-04）。
     * 这个插槽是 **root 作用域**（无会话、无工作区），所以它打开的模态框天然走"无工作区"模式：
     * 全局项（账户 / 白名单 / 分享模式）照常，工作区项隐藏或只读。
     * 自过滤：只认 dsh-mc-agent 自己的 bundle 页（`subject.kind==='bundle'` 且包名匹配）；
     * 别的 bundle / row / item 一律返回 null（官方约定：对无关 subject 返回 null）。
     * ⚠️ `useState` 必须在早返回**之前**调用（hooks 规则）。
     */
    function McSettingsDetailEntry(props) {
      const subject = props?.subject
      const [open, setOpen] = React.useState(false)
      const hasUpdate = useUpdateBadge(true)
      if (subject?.kind !== 'bundle' || subject?.pkg?.name !== DETAIL_BUNDLE_NAME) return null
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('button', {
          type: 'button',
          'data-wc-btn': '',
          'data-wc-mc-settings-detail': '',
          ...(hasUpdate ? { 'data-wc-update': '' } : {}),
          title: hasUpdate ? '设置：账户、提示词与指令白名单（有新版本）' : '设置：账户、提示词与指令白名单',
          onClick: () => setOpen(true),
        },
          // 图标与原生「卸载」按钮同款（同为 DSH 图标集的 13px Regular；见文件头图标约定）
          IconSettingsOutlineRegular ? React.createElement(IconSettingsOutlineRegular, { size: 13 }) : null,
          '设置',
        ),
        // 受控打开：这个入口无 sessionId / 工作区（root 作用域）→ 模态框走"无工作区"模式
        React.createElement(McSettingsModal, { open, onClose: () => setOpen(false) }),
      )
    }

    /* ==================================================================
     * 「MC设置」入口②：**新会话页**，贴在**模式选择芯片的正右边**
     * ----------------------------------------------------------------
     * 为什么这里必须碰 DOM：新会话页那一行是宿主**写死的**标记
     * （`ConversationRoot.tsx` 的 `heroWorkspaceRow` = 官方 WorkspaceChip + 两个
     * **single/root** 插槽 `conversation.hero.workspace` / `.agentPreset`），
     * **没有任何 list 插槽**能塞进那一行；注册 single 槽会把官方模式芯片顶掉。
     * 所以只剩一条路：把按钮插到宿主给模式芯片的壳 `[data-slot="conversation.hero.agentPreset"]` 后面
     * （那个壳是宿主自己承诺的稳定锚点：`ui-renderer/.../scoped-slots.tsx` 里
     *   "every slot render site exposes a stable `[data-slot="<key>"]` wrapper"，
     *   且它是 `display:contents`，所以插进去就是那一行 flex 的下一个子项 = 芯片右边）。
     *
     * 🔴 与 2026-09-16 那个"生成时输入框上方冒出全宽长条"的老 bug 的本质区别：
     *    · **锚点只在新会话页存在**——hero 行只在 hero 相位渲染（`{hero && heroWorkspaceRow}`），
     *      普通对话里**根本插不进去**（老代码是从 `[data-composer-card]` 往上找兄弟，找错了行）；
     *    · **门控**：只有"会话 blank + preset ∈ mcModePresets"时这个 React 组件才挂载（见 useMcSettingsGate）；
     *    · **观察范围只在作曲器卡片内**，不是 `document.body`，而且随组件卸载一起消失；
     *    · 组件卸载立刻把按钮摘掉。
     * ================================================================== */
    const HERO_CHIP_ANCHOR = '[data-slot="conversation.hero.agentPreset"]'
    const HERO_BTN_ATTR = 'data-dsh-mc-agent-mc-settings'
    const HERO_CONNECT_ATTR = 'data-dsh-mc-agent-mc-connect'
    /** hero 行里我们注入的按钮：属性 → 排序（小的靠左）。锚点右边依次是 连接(40) → 设置(45)。 */
    const HERO_BTN_ORDER = { [HERO_CONNECT_ATTR]: 40, [HERO_BTN_ATTR]: 45 }

    /**
     * 把我们的按钮插到 hero 行里模式芯片（锚点）的**右边**，按 {@link HERO_BTN_ORDER} 升序。
     * @param {Array<{attr:string, label:string, title:string, icon?:Function, iconOnly?:boolean,
     *   onClick:()=>void, getDisabled?:()=>boolean, disabledTitle?:string}>} specs
     * @returns `{ dispose, refresh }`：dispose 断开观察者并摘掉按钮；refresh 重算禁用态（不重建 DOM）
     */
    function mountHeroButtons(specs) {
      const entries = specs.map((s) => {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.setAttribute(s.attr, '')
        btn.setAttribute('data-wc-btn', '')
        btn.setAttribute('data-wc-tiny', '')
        if (s.iconOnly) btn.setAttribute('data-wc-icon', '')   // 只有图标 → 收成正方形
        btn.title = s.title
        btn.setAttribute('aria-label', s.label ?? s.title)
        // 纯 DOM 按钮拿不到 React 组件，借 react-dom 的小根把内容渲染进去（图标 + 可选文字）；
        // 渲染不到（理论上不该发生）就退回纯文字，别让按钮变空白。
        let iconRoot = null
        if ((s.icon || s.label) && createRoot) {
          iconRoot = createRoot(btn)
          iconRoot.render(React.createElement(
            React.Fragment, null,
            s.icon ? React.createElement(s.icon, { size: 16 }) : null,
            (s.iconOnly || !s.label) ? null : React.createElement('span', null, s.label),
          ))
        } else {
          btn.textContent = s.label ?? ''
        }
        btn.addEventListener('click', s.onClick)
        // 禁用态：新会话页"只要是 MC/MC+ 就显示"，但**没选工作区时点不动**。
        // 三态由调用方判（`=== false` 才禁用；null = 还不知道，放行）。
        const refresh = () => {
          const off = typeof s.getDisabled === 'function' && s.getDisabled() === true
          btn.disabled = off
          btn.title = off ? (s.disabledTitle ?? s.title) : s.title
          // 有新版本的角标：纯 DOM 按钮拿不到 React，只能改属性让 CSS `::after` 去画
          if (typeof s.getBadge === 'function') {
            if (s.getBadge() === true) btn.setAttribute('data-wc-update', '')
            else btn.removeAttribute('data-wc-update')
          }
        }
        refresh()
        return { btn, attr: s.attr, refresh, iconRoot }
      })
      const ordered = entries.slice().sort((a, b) => (HERO_BTN_ORDER[a.attr] ?? 99) - (HERO_BTN_ORDER[b.attr] ?? 99))
      /**
       * 🔴 2026-10-15 审计（报告第 3 条）：`dispose()` 原来只 `clearTimeout` + `observer.disconnect()`
       *    + 摘掉按钮，**没有"已经销毁"的标志**。而 MutationObserver 的回调是
       *    `Promise.resolve().then(...)` **微任务**：如果销毁正好发生在"变更已排队、微任务还没跑"
       *    这一瞬间，那个微任务照样会执行 `place()`（`insertAdjacentElement` 把按钮**插回 DOM**）
       *    和 `track()`（`observer.observe(...)` **重新武装**）—— 卸载之后按钮又冒出来、
       *    观察者又开始常驻空转。加 `disposed` 标志，所有异步续跑点都先查它。
       */
      let disposed = false
      const refresh = () => { if (disposed) return; for (const e of entries) e.refresh() }

      /**
       * 幂等放置：按 order 依次**紧贴前一个**地排在锚点后面（每个按钮必须紧跟它的前驱）。
       * 🔴 只认**真 anchor 的直接父元素**作为落点（`HERO_CHIP_ANCHOR`），只用它比对身份。
       *    任何"往上找兄弟行"式的猜测都被 2026-09-16 的事故否掉了 —— 不重蹈。
       */
      const place = () => {
        if (disposed) return
        const anchor = document.querySelector(HERO_CHIP_ANCHOR)
        const row = anchor === null ? null : anchor.parentElement
        if (anchor === null || row === null) return
        let prev = anchor
        for (const e of ordered) {
          if (e.btn.parentElement !== row || e.btn.previousElementSibling !== prev) {
            prev.insertAdjacentElement('afterend', e.btn)
          }
          prev = e.btn
        }
      }

      place()

      /* React 重渲染会把注入的节点冲掉 → 必须补回。观察范围是这里的关键：
       * 🔴 2026-09-18 真机 bug（"新会话 MC 模式没选工作区时没有按钮"）：原来只观察
       *    `[data-composer-card]`，而那个标记挂在**输入框自己**身上（`InputBar.tsx:429`），
       *    hero 行（含我们的锚点）是**它的兄弟**（`ConversationRoot.tsx:347-351`）——
       *    于是 hero 行一重渲染（切模式 / 切工作区正是这种情况），按钮被抹掉而**观察者看不见**，
       *    再也补不回来。症状取决于首帧锚点在不在：工作区已选时首帧就在（所以"看着正常"），
       *    没选工作区时锚点晚出现 ⇒ 一直没按钮。
       *    现在改成观察**两者共同的父容器**（`[data-composer-seat]`，退路是锚点当前所在的父元素），
       *    并且在锚点还没出现时先观察那个容器，等它出现再放。
       */
      let observed = null
      let queued = false
      const watchTarget = () => {
        const anchor = document.querySelector(HERO_CHIP_ANCHOR)
        // ① 锚点已在 DOM 里 → 观察它所在的父容器（hero 行的容器 = composerStack）
        if (anchor?.parentElement) return anchor.parentElement
        // ② 锚点还没出现（新会话页首帧、工作区栏还在变）→ 退到作曲器底座，
        //    它一定存在且包含将来会出现的那一行。
        return document.querySelector('[data-composer-seat]') ?? document.querySelector('[data-composer-card]')
      }
      const track = () => {
        if (disposed) return
        const target = watchTarget()
        if (target === null || target === observed) return
        observer.disconnect()
        observer.observe(target, { childList: true, subtree: true })
        observed = target
      }
      const observer = new MutationObserver(() => {
        if (disposed || queued) return
        queued = true
        Promise.resolve().then(() => {
          if (disposed) return          // 🔴 报告第 3 条：销毁后这个微任务不能再 place/track
          queued = false; place(); track(); refresh()
        })
      })
      track()
      // 首帧锚点可能比本组件晚挂上（React 提交顺序不保证）→ 多补几次；有上限，别常驻空转。
      let tries = 0
      let retry = null
      const tick = () => {
        if (disposed) return
        place()
        track()
        refresh()
        if (disposed) return
        if (document.querySelector(HERO_CHIP_ANCHOR) !== null) return   // 已就位，收工
        if (++tries >= 10) return
        retry = setTimeout(tick, 300)
      }
      retry = setTimeout(tick, 120)

      const dispose = () => {
        disposed = true
        if (retry) clearTimeout(retry)
        retry = null
        observer.disconnect()
        for (const e of entries) {
          if (e.iconRoot) e.iconRoot.unmount()
          e.btn.remove()
        }
      }
      return { dispose, refresh }
    }

    /**
     * **新会话页**的「MC设置」驱动组件。
     *
     * 它自己**不渲染任何可见元素**（`return null` / 只挂模态框）：按钮由
     * `mountHeroChipButton` 插到模式芯片右边——也就是用户要的"模式选择右边"。
     * 挂在 `conversation.input.right` 上只是为了拿一个**可靠的挂载时机**
     * （hero 与 composer 都会渲染它；配合 `blank` 门控 ⇒ 只在新会话页挂载）。
     * ⚠️ 它**只**在会话还是 `blank`（还没发过消息）时存在；一旦开聊，入口交给标题条那个。
     */
    function McSettingsDockEntry(props) {
      const show = useMcSettingsGate(props, true)
      const wsCwd = useWorkspaceCwd(props)
      // 🔴 2026-09-18：入口不再因"没工作区"**隐藏**；2026-10-04 改口径：
      //    **只要是 MC/MC+ 就显示**，没选工作区时**禁用**（见下 getDisabled）。
      const wsReady = useMcWorkspaceReady(props, show)
      // 点击回调 / 禁用判定只建一次（DOM 监听不改），所以用 ref 带出"最新"的工作区判定。
      const wsReadyRef = React.useRef(wsReady)
      wsReadyRef.current = wsReady
      const ctlRef = React.useRef(null)
      const hasUpdate = useUpdateBadge(show)
      // DOM 按钮只在 mount 时建一次，所以把"最新"的红点状态放 ref 里让 refresh() 读
      const hasUpdateRef = React.useRef(hasUpdate)
      hasUpdateRef.current = hasUpdate

      React.useEffect(() => {
        if (!show) return undefined
        // 兜底：拿不准（null）时按钮没禁用，点到这儿再拦一次。
        const guard = (fn) => () => {
          if (wsReadyRef.current === false) { window.alert(NO_WORKSPACE_TIP); return }
          fn()
        }
        const isOff = () => wsReadyRef.current === false
        // 两个按钮按 order 排在模式芯片右边：连接(40) 在左、设置(45) 在右
        const ctl = mountHeroButtons([
          {
            attr: HERO_CONNECT_ATTR, label: '连接到MC', title: '连接到MC：填地址或选局域网服务器',
            icon: RunIcon, disabledTitle: '请先选择工作区', getDisabled: isOff, onClick: guard(openConnect),
          },
          {
            attr: HERO_BTN_ATTR, label: 'MC设置', title: 'MC设置：账户、提示词与指令白名单',
            icon: IconSettingsOutlineRegular, iconOnly: true, disabledTitle: '请先选择工作区',
            getDisabled: isOff, getBadge: () => hasUpdateRef.current === true, onClick: guard(openSettings),
          },
        ])
        ctlRef.current = ctl
        return () => { ctlRef.current = null; ctl.dispose() }
      }, [show])

      // 工作区就绪状态一变就刷新禁用态（不重建 DOM、不重挂按钮）
      React.useEffect(() => { if (ctlRef.current) ctlRef.current.refresh() }, [wsReady, show, hasUpdate])

      if (!show) return null
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(McSettingsModal, { ...props, wsCwd }),
        React.createElement(McConnectHost, props),
      )
    }

    /* ==================================================================
     * 历史残留清理（只为清掉老 bundle 留在页面上的按钮）
     * ----------------------------------------------------------------
     * 2026-09-16 那个把按钮插到"输入框上方全宽长条"的旧实现可能还在页面里留了节点
     * （改代码当天 HMR 换过好几版）。这里在 apply 时一次性把 `[data-dsh-mc-agent-mc-settings]`
     * 全摘掉；新实现自己会按需把按钮插回**正确的位置**（模式芯片右边）。
     * ================================================================== */
    function purgeLegacyInjectedButtons() {
      try {
        for (const el of document.querySelectorAll('[data-dsh-mc-agent-mc-settings],[data-dsh-mc-agent-mc-connect]')) el.remove()
      } catch (e) { /* 清理失败无所谓，不影响任何功能 */ }
    }

    /* ==================================================================
     * MC设置模态框（两栏：左标签页 + 右内容区）
     * ================================================================== */

    /** 简写：这一段组件比较多，用 h 比 React.createElement 好读 */
    const h = React.createElement

    /**
     * 「这一项属于本工作区」标记：灰色文件夹图标 + hover 提示。
     * 只挂在**工作区相关**的设置项/标题旁（有工作区时才挂）。
     */
    function WsMark() {
      return h('span', { 'data-wc-wsmark': '', title: '该设置项应用于本工作区' },
        IconFolderOpenRegular ? h(IconFolderOpenRegular, { size: 12 }) : null)
    }

    /** 无工作区时，子页面底部那行居中灰字（带文件夹图标）：告诉用户去哪儿编辑这些设置。 */
    function WsNeedHint() {
      return h('div', { 'data-wc-wsneed': '' },
        IconFolderOpenRegular ? h(IconFolderOpenRegular, { size: 13 }) : null,
        h('span', null, '在对话中打开设置，以编辑工作区详细设置'))
    }

    /**
     * 文件名（用在注入开关的 label 里）。文件不存在时：斜体 + 灰 + 删除线，hover 提示原因。
     * 只是**提示**，不影响开关可用性（开关始终用于改配置）。
     */
    /**
     * 版本号 → 数字段（`"1.21.4"` → `[1,21,4]`；`"26.1"` → `[26,1,0]`）。
     * 拿不出数字段（空、`"未知"`、纯文字）⇒ `null`。
     */
    function mcVersionParts(v) {
      const s = String(v ?? '').trim()
      if (!s) return null
      const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
      if (!m) return null
      return [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0]
    }

    /**
     * 判断一个 MC 版本号是否在本插件支持范围内。
     *
     * 🟢 2026-10-15 审计（报告第 10 条）：以前是 `() => null` 的桩 —— 一个**永远"未知"**的
     * 函数，于是调用方 `lanVersionOk = (s) => MC_VERSION_IN_RANGE(s?.version) !== false`
     * 恒为 `true`：`setError('版本不匹配：…')` 的拦截和局域网列表里 `data-wc-cn-bad` 的红标
     * **一行都到不了**（死代码）。
     *
     * 判据与**上游真实行为**对齐：mineflayer 拿 `latestSupportedVersion` 做**上界拒绝**
     * （见 `src/core.mjs` 的 `libraryInfo()` 注释），而 `testedVersions` 是**稀疏的实测清单**
     * （`1.8.8` / `1.9.4` / … / `1.21.11` / `26.1`，共 28 项）—— 直接 `includes` 会把
     * `1.21.10` 这类"没被单独测过、但协议兼容"的中间版本误标成不支持。
     * 所以：**规范化成数字段后逐段比大小，比 `latest` 新才 `false`**。
     *
     * 拿不到范围信息（接口没回来 / 失败）或版本号解析不出来 ⇒ `null`（未知），
     * 调用方按"在范围内"处理 —— **宁可漏报，不可误拦**。
     *
     * @returns true=在范围内 / false=比实测上界还新 / null=未知
     */
    function MC_VERSION_IN_RANGE(v) {
      const want = mcVersionParts(v)
      const info = mcGateInfoCache
      if (!want || !info) return null
      const latest = mcVersionParts(info.latest)
      if (!latest) return null
      for (let i = 0; i < 3; i++) {
        if (want[i] > latest[i]) return false
        if (want[i] < latest[i]) return true
      }
      return true
    }

    /**
     * 「运行」图标 = DSH 裸三角（`IconTriangleRightFillRegular` 的几何）**描边成空心**
     * （用户 2026-10-04：要**空心三角**，不要带外圈的 play）。靠 `className` 覆盖 path 的 fill。
     */
    function RunIcon(props) {
      if (!IconRunRegular) return null
      return h(IconRunRegular, { size: props?.size ?? 16, className: 'wc-runicon' })
    }

    function FileName(props) {
      const missing = props.missing === true
      return h('span', missing
        ? { 'data-wc-filename': '', 'data-wc-missing': '', title: '目前没有这个文件' }
        : { 'data-wc-filename': '' }, props.name)
    }

    /**
     * 开关。受控：`on` = 当前值，`onToggle(next)` 由调用方决定发不发请求。
     * `disabled` 时按钮真的禁用（例如工作区没有 AGENTS.md 时）。
     * `mark` 为真时在 label 后挂「属于本工作区」标记（见 WsMark）。
     */
    function Switch(props) {
      return React.createElement(
        'div',
        { 'data-wc-switchrow': '' },
        React.createElement(
          'div',
          { 'data-wc-switchmain': '' },
          React.createElement('span', { 'data-wc-switchlabel': '' }, props.label, props.mark ? h(WsMark) : null),
          props.desc ? React.createElement('span', { 'data-wc-switchdesc': '' }, props.desc) : null,
        ),
        React.createElement('button', {
          type: 'button',
          'data-wc-switch': '',
          ...(props.on ? { 'data-wc-on': '' } : {}),
          role: 'switch',
          'aria-checked': props.on ? 'true' : 'false',
          disabled: props.disabled === true,
          // label 可能是节点（带文件名），那种情况不能拿去当 title（否则渲染成 [object Object]）
          title: props.title || (typeof props.label === 'string' ? props.label : undefined),
          onClick: () => { if (!props.disabled) props.onToggle(!props.on) },
        }, React.createElement('span', { 'data-wc-knob': '' })),
      )
    }

    /** 账号类型（气泡文案 + 配色） */
    const ACCT_TYPE = {
      offline: { label: '离线', chip: 'data-wc-chip-offline' },
      yggdrasil: { label: '第三方', chip: 'data-wc-chip-ygg' },
      microsoft: { label: '微软', chip: 'data-wc-chip-ms' },
    }

    /** 类型气泡 */
    function TypeChip(props) {
      const t = ACCT_TYPE[props.type] ?? { label: props.type || '?', chip: 'data-wc-chip' }
      return h('span', { 'data-wc-chip': '', [t.chip]: '' }, t.label)
    }

    /**
     * 账户**横条**：只有「类型气泡 + 名字」+ 右侧两个动作。
     * 细节（UUID / 服务器 / login / innerID）**都不在这里显示** —— 离线点「编辑」进去看。
     * 离线 = 编辑；其余（第三方 / 微软）= 刷新（用户 2026-09-16 定）。
     */
    function AccountRow(props) {
      const { account: acc, busyKey } = props
      const [pendingDelete, setPendingDelete] = React.useState(false)
      const rowBusy = typeof busyKey === 'string' && busyKey.startsWith('row:' + acc.innerID + ':')
      const offline = acc.type === 'offline'
      // 第三方的小灰字 = **「输入的账号（服务器名）」**。
      // 🔴 用户 2026-09-16：主文本是**游戏 ID**（第三方登录成功后回写的档案名），
      //    它跟你输入的账号通常不是一回事（输入的是邮箱，游戏里叫角色名）→ 两个都得看得见。
      //    两者相同时（登录名本身就是角色名）不重复写，只留服务器名。
      //    服务器名没了就退化成 url；都没有就只剩账号。
      const srvLabel = acc.server?.name || acc.server?.url || ''
      const login = String(acc.login ?? '').trim()
      const sub = offline ? '' : (login && login !== acc.name
        ? (srvLabel ? `${login}（${srvLabel}）` : login)
        : srvLabel)

      return h('div', { 'data-wc-acct': '', 'data-wc-account': acc.innerID },
        h(TypeChip, { type: acc.type }),
        h('span', { 'data-wc-acctname': '', title: acc.name }, acc.name || '(无名)'),
        sub ? h('span', { 'data-wc-acctsub': '', title: acc.server?.url || sub }, sub) : null,
        acc.default ? h('span', { 'data-wc-chip': '', 'data-wc-chip-default': '' }, '默认') : null,
        h('span', { 'data-wc-spacer': '' }),
        h('div', { 'data-wc-acctacts': '' },
          acc.type === 'microsoft'
            /* 正版账户没有密码：身份是浏览器里输一次设备码换来的，所以主按钮是「登录」；
               邮箱填错了就进「编辑」改（改了邮箱等于换了缓存目录，要重新登录一次）。 */
            ? [
              h('button', {
                key: 'login', type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-primary': '',
                disabled: rowBusy, title: '走设备码登录（在浏览器里输一次代码）',
                onClick: () => props.onLogin(acc),
              }, '登录'),
              h('button', {
                key: 'edit', type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: rowBusy,
                title: '改名字 / 邮箱 / 认证服务器',
                onClick: () => props.onEdit(acc),
              }, '编辑'),
            ]
            /* 用户 2026-10-15：行里一律给「编辑」（原来第三方那格是「刷新」，改不了填错的东西）；
               「刷新」挪到页头，一下刷全部（见 AccountsPane）。 */
            : h('button', {
              type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: rowBusy,
              title: offline ? '改名字 / UUID' : '改名字 / 账号 / 认证服务器',
              onClick: () => props.onEdit(acc),
            }, '编辑'),
          pendingDelete
            ? [
              h('button', {
                key: 'yes', type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '',
                disabled: rowBusy, onClick: () => props.onDelete(acc),
              }, '确认删除'),
              h('button', {
                key: 'no', type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: rowBusy,
                onClick: () => setPendingDelete(false),
              }, '取消'),
            ]
            : h('button', {
              key: 'del', type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '',
              disabled: rowBusy, onClick: () => setPendingDelete(true),
            }, '删除'),
        ),
      )
    }

    /** 表单里的一行（标签 + 控件） */
    function Field(props) {
      return h('div', { 'data-wc-field': '' },
        props.label ? h('span', { 'data-wc-label': '' }, props.label) : null,
        props.children,
      )
    }

    /** 新建账户第一步：选类型（三种账户 = 三个独立界面） */
    function TypePicker(props) {
      const types = [
        { k: 'new-offline', name: '离线账户', desc: '不需要密码，名字就是身份' },
        { k: 'new-yggdrasil', name: '第三方账户', desc: '皮肤站等外置登录' },
        { k: 'new-microsoft', name: '正版账户', desc: '微软账号，走设备码登录' },
      ]
      return h('div', { 'data-wc-pane-page': 'accounts' },
        h('div', { 'data-wc-panehead': '' },
          h('button', { type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', onClick: props.onBack }, '← 返回'),
          h('div', { 'data-wc-h': '' }, '新建账户'),
        ),
        h('div', { 'data-wc-typelist': '' },
          types.map((t) => h('button', {
            key: t.k, type: 'button', 'data-wc-type': '',
            disabled: t.off === true,
            title: t.off === true ? '未实现' : undefined,
            onClick: () => { if (t.off !== true) props.onPick(t.k) },
          },
          h('span', { 'data-wc-typename': '' }, t.name),
          h('span', { 'data-wc-typedesc': '' }, t.desc))),
        ),
      )
    }

    /** 新建 / 编辑**离线**账户（同一个界面，mode 区分；UUID 这类细节在这里看） */
    function OfflineForm(props) {
      const { busyKey, mode = 'new', account } = props
      const editing = mode === 'edit'
      const [name, setName] = React.useState(editing ? (account?.name ?? '') : 'DeepSeek')
      // 只有在"自定义过 UUID"时才把值填出来；派生值不填（填了就等于把它钉成自定义）
      const [uuid, setUuid] = React.useState(editing && account?.uuidSource === 'custom' ? (account.uuid ?? '') : '')
      const [asDefault, setAsDefault] = React.useState(editing ? account?.default === true : false)
      const key = editing ? 'row:' + account.innerID + ':save' : 'new:offline'
      const busy = busyKey === key

      const submit = () => {
        const n = name.trim()
        if (!n) return
        if (editing) {
          props.onPatch(account.innerID, {
            name: n, uuid: uuid.trim() || null, ...(asDefault ? { default: true } : {}),
          }, key).then((ok) => { if (ok) props.onDone() })
        } else {
          props.onCreate({
            type: 'offline', name: n, uuid: uuid.trim() || undefined, default: asDefault,
          }, key).then((ok) => { if (ok) props.onDone() })
        }
      }

      return h('div', { 'data-wc-pane-page': 'accounts' },
        h('div', { 'data-wc-panehead': '' },
          h('button', { type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', onClick: props.onBack }, '← 返回'),
          h('div', { 'data-wc-h': '' }, editing ? '编辑离线账户' : '新建离线账户'),
        ),
        h(Field, { label: '游戏内名字' },
          h('input', {
            'data-wc-in': '', value: name, disabled: busy, autoFocus: true,
            onChange: (e) => setName(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submit() },
          })),
        h(Field, { label: 'UUID（可留空，留空按名字派生）' },
          h('input', {
            'data-wc-in': '', value: uuid, disabled: busy, spellCheck: false,
            placeholder: editing ? (account?.uuid ?? '') : '',
            onChange: (e) => setUuid(e.target.value),
          })),
        h('div', { 'data-wc-acts': '' },
          h(Switch, { label: '设为默认账户', on: asDefault, onToggle: setAsDefault }),
          h('span', { 'data-wc-spacer': '' }),
          h('button', {
            type: 'button', 'data-wc-btn': '', 'data-wc-primary': '', disabled: busy || !name.trim(),
            onClick: submit,
          }, busy ? '保存中…' : (editing ? '保存' : '创建')),
        ),
      )
    }

    /**
     * 新建 / 编辑**第三方**账户（皮肤站）：**先填认证服务器，再填账号密码**。
     * 编辑时把现值填回去，**密码留空 = 不改密码**（认证服那边只在给了新密码时才覆盖凭据）。
     * 服务器那一块上面是**已缓存的**标签：点一下自动填进输入框，× 从缓存里删掉
     * （LittleSkin 也只是预置的缓存项，一样能删）。
     * 输入框下面有一块**看得见的虚线拽托区**：把 authlib-injector 卡片拖进来即可。
     * 手打一个新地址也行——建账户时后端会顺手把它记住。
     *
     * 🔴 2026-09-16 用户纠正：这里要问的是**认证服务器的名字**（缓存标签里显示它，才看得懂），
     *    **不是**"游戏内名字"——角色名是认证服返回的档案名，问用户填毫无意义（登录后被覆盖）。
     */
    function YggdrasilForm(props) {
      const { servers = [], busyKey, mode = 'new', account } = props
      /* 新建 / 编辑共用同一个表单（`MicrosoftForm` 同款约定）。
         🔴 2026-10-15 用户报的 bug：以前这里**只能新建**，而账户行里给第三方账户的「编辑」
            被路由到了**离线表单**（那个表单没有服务器/密码，改完就把账户写成了离线）。
         编辑时：现值填回去、**密码留空 = 不改密码**、标题与按钮换字。 */
      const editing = mode === 'edit'
      const srvUrl = editing ? (account?.server?.url ?? '') : ''
      // 认证服务器可能已经从缓存里被删了（那时 `server.url` 是 null、名字是「(已移除的服务器)」）
      const srvCached = srvUrl ? (servers.find((s) => s.url === srvUrl) ?? null) : null
      const [picked, setPicked] = React.useState(srvCached ? srvCached.id : null)
      const [url, setUrl] = React.useState(srvUrl)
      const [srvName, setSrvName] = React.useState(srvCached ? (srvCached.name || '') : '')
      const [login, setLogin] = React.useState(editing ? (account?.login ?? '') : '')
      const [asDefault, setAsDefault] = React.useState(editing ? account?.default === true : false)
      const [dragging, setDragging] = React.useState(false)
      // 🔴 密码**不进 state**：非受控 input + ref，提交时读一次就丢；也不进任何 data-*
      const passRef = React.useRef(null)
      /**
       * 🔴 2026-10-15 审计（报告第 4 条）：`submit()` 的守卫是
       *    `if (!u || !login.trim() || !p) return` —— **含密码**；而「创建」按钮的
       *    `disabled` 只判 `!url.trim() || !login.trim()` —— **不含密码**。
       *    于是密码空着时按钮是亮的，点下去**静默无反应**（Enter 也一样），用户只会以为坏了。
       *    修法：用一个**布尔**记住"密码框非空"（布尔不是密码，不违反上面那条纪律），
       *    让按钮的禁用条件与提交守卫完全一致，并且**提前把还差哪几项写出来**。
       */
      const [hasPass, setHasPass] = React.useState(false)
      const busy = busyKey === (editing ? `row:${account.innerID}:save` : 'new:yggdrasil')
      const pickedSrv = picked === null ? null : (servers.find((s) => s.id === picked) ?? null)
      const missing = []
      if (!url.trim()) missing.push('认证服务器地址')
      if (!login.trim()) missing.push('账号')
      if (!editing && !hasPass) missing.push('密码')

      /** 拖入 authlib-injector 卡片：交给后端解析、加进缓存，然后自动选中并填进输入框 */
      const onDropCard = (e) => {
        e.preventDefault()
        setDragging(false)
        const dt = e.dataTransfer
        const card = dt ? (dt.getData('text') || dt.getData('text/plain') || '') : ''
        if (!card.trim()) return
        Promise.resolve(props.onAddCard(card)).then((srv) => {
          if (srv?.url) { setUrl(srv.url); setPicked(srv.id ?? null); setSrvName(srv.name || '') }
        })
      }

      const submit = () => {
        const u = url.trim()
        const p = passRef.current ? passRef.current.value : ''
        if (!u || !login.trim() || (!editing && !p)) return
        const nm = srvName.trim()
        // 账户显示名：先按账号名兜一个（登录/刷新成功后会被档案名覆盖）
        const fallback = login.trim().split('@')[0].replace(/[^\w\u4e00-\u9fa5.]/g, '').slice(0, 32) || 'MC'
        const payload = {
          type: 'yggdrasil',
          // 编辑时**不碰显示名** —— 那多半已经被登录后的档案名覆盖过了，拿账号前缀盖回去是退步
          ...(editing ? {} : { name: fallback }),
          login: login.trim(),
          default: asDefault,
          // 选中的就是缓存里那条 → 用 serverId（改了名字才带上 serverName，让后端改名）
          ...(pickedSrv && pickedSrv.url === u
            ? { serverId: pickedSrv.id, ...(nm && nm !== pickedSrv.name ? { serverName: nm } : {}) }
            : { serverUrl: u, ...(nm ? { serverName: nm } : {}) }),
        }
        // 🔴 编辑时密码留空 = 不改：后端只在给了 `password` 时才覆盖凭据
        if (p) payload.password = p
        const key = editing ? `row:${account.innerID}:save` : 'new:yggdrasil'
        const run = editing ? props.onPatch(account.innerID, payload, key) : props.onCreate(payload, key)
        run.then((ok) => { if (ok) props.onDone() })
      }

      return h('div', { 'data-wc-pane-page': 'accounts' },
        h('div', { 'data-wc-panehead': '' },
          h('button', { type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', onClick: props.onBack }, '← 返回'),
          h('div', { 'data-wc-h': '' }, editing ? '编辑第三方账户' : '新建第三方账户'),
        ),
        h(Field, { label: '认证服务器' },
          servers.length
            ? h('div', { 'data-wc-tags': '' }, servers.map((s) => h('span', {
              key: s.id, 'data-wc-tag': '', ...(pickedSrv?.id === s.id ? { 'data-wc-tag-on': '' } : {}),
            },
            h('button', {
              type: 'button', 'data-wc-tagpick': '', title: s.url || s.name,
              onClick: () => { setPicked(s.id); setUrl(s.url); setSrvName(s.name || '') },
            }, s.name || s.url),
            h('button', {
              type: 'button', 'data-wc-tagx': '', title: '从缓存里删掉',
              disabled: busyKey === 'server:' + s.id,
              onClick: () => props.onRemoveServer(s),
            }, '×'))))
            : null,
          h('input', {
            'data-wc-in': '', value: url, disabled: busy, spellCheck: false,
            placeholder: 'https://example.com/api/yggdrasil',
            onChange: (e) => { setUrl(e.target.value); setPicked(null) },
            onDragOver: (e) => e.preventDefault(),
            onDrop: onDropCard,
          }),
          // 拽托接受区：老版有，别删（用户 2026-09-16 反馈"怎么没了"）
          h('div', {
            'data-wc-drop': '', ...(dragging ? { 'data-wc-drag': '' } : {}),
            onDragOver: (e) => { e.preventDefault(); if (!dragging) setDragging(true) },
            onDragLeave: () => setDragging(false),
            onDrop: onDropCard,
          }, busyKey === 'server:card' ? '正在解析卡片…' : '把 authlib-injector 卡片拖到这里')),
        // 服务器的**名字**紧随服务器那一栏：留空就用域名；填了它，缓存标签里才看得懂
        // （2026-09-16 用户纠正：这里**不是**"游戏内名字"——角色名由认证服返回，不用问用户）
        h(Field, { label: '服务器名字（留空就用域名）' },
          h('input', {
            'data-wc-in': '', value: srvName, disabled: busy, placeholder: '例如：LittleSkin',
            onChange: (e) => setSrvName(e.target.value),
          })),
        h(Field, { label: '账号（邮箱）' },
          h('input', {
            'data-wc-in': '', value: login, disabled: busy, autoComplete: 'off',
            onChange: (e) => setLogin(e.target.value),
          })),
        h(Field, { label: editing ? '密码（留空 = 不改）' : '密码' },
          h('input', {
            'data-wc-in': '', type: 'password', ref: passRef, disabled: busy, autoComplete: 'off',
            onChange: (e) => { const v = e.target.value; setHasPass((prev) => ((v.length > 0) === prev ? prev : v.length > 0)) },
            onKeyDown: (e) => { if (e.key === 'Enter') submit() },
          })),
        // 🔴 报告第 4 条：把"还差什么"提前说出来，别让用户对着亮着的按钮猜
        (missing.length && !busy)
          ? h('p', { 'data-wc-hint': '', 'data-wc-dirty': '' }, '还差：' + missing.join('、'))
          : null,
        h('div', { 'data-wc-acts': '' },
          h(Switch, { label: '设为默认账户', on: asDefault, onToggle: setAsDefault }),
          h('span', { 'data-wc-spacer': '' }),
          h('button', {
            type: 'button', 'data-wc-btn': '', 'data-wc-primary': '',
            // 与 `submit()` 的守卫**完全一致**（含密码），不再出现"亮着但点了没反应"
            disabled: busy || missing.length > 0,
            title: missing.length ? '还差：' + missing.join('、') : '',
            onClick: submit,
          }, busy ? (editing ? '保存中…' : '创建中…') : (editing ? '保存' : '创建')),
        ),
      )
    }

    /**
     * 新建 / 编辑**正版（微软）**账户。
     * 这一步只收**邮箱** —— 它是 `prismarine-auth` 认令牌缓存的那把钥匙（缓存文件名按它起）。
     * 游戏内名字要等登录成功才拿得到，所以这里不填也行（登录后后端会回写）。
     */
    function MicrosoftForm(props) {
      const { busyKey, mode = 'new', account } = props
      const editing = mode === 'edit'
      const [email, setEmail] = React.useState(editing ? (account?.login ?? '') : '')
      const key = editing ? 'row:' + account.innerID + ':save' : 'new:microsoft'
      const busy = busyKey === key
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

      const submit = () => {
        if (!ok || busy) return
        if (editing) {
          props.onPatch(account.innerID, { login: email.trim() }, key).then((r) => { if (r) props.onDone() })
        } else {
          props.onCreate({ type: 'microsoft', login: email.trim() }, key).then((r) => { if (r) props.onDone() })
        }
      }

      return h('div', { 'data-wc-pane-page': 'accounts' },
        h('div', { 'data-wc-panehead': '' },
          h('button', { type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', onClick: props.onBack }, '← 返回'),
          h('div', { 'data-wc-h': '' }, editing ? '编辑正版账户' : '新建正版账户'),
        ),
        h(Field, { label: '微软账号邮箱' },
          h('input', {
            'data-wc-in': '', value: email, disabled: busy, autoFocus: true, spellCheck: false,
            placeholder: 'you@example.com',
            onChange: (e) => setEmail(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submit() },
          })),
        h('div', { 'data-wc-note': '' },
          '不用在这里输密码。建好之后点那个账户的「登录」，页面会给一个 8 位代码和一个网址，去浏览器里输一次就行。'),
        h('div', { 'data-wc-acts': '' },
          h('span', { 'data-wc-spacer': '' }),
          h('button', {
            type: 'button', 'data-wc-btn': '', 'data-wc-primary': '', disabled: busy || !ok,
            onClick: submit,
          }, busy ? '保存中…' : (editing ? '保存' : '创建')),
        ),
      )
    }

    /**
     * 正版账户的**设备码登录**界面。
     * 服务端起一条后台任务（`onStart`），这里把 `userCode` / `verificationUri` 显示出来，
     * 然后每 2 秒问一次「好了没有」（`onPoll`）。
     * 🔴 码是**一次性**的：点「重新开始」会拿到新码，旧码作废。
     */
    function MicrosoftLogin(props) {
      const { account, onBack, onReload, onStart, onPoll } = props
      const innerID = account.innerID
      const [job, setJob] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [copied, setCopied] = React.useState(false)
      const state = err ? 'error' : (job?.state ?? 'starting')

      const start = React.useCallback(() => {
        setErr(''); setJob(null); setCopied(false)
        Promise.resolve()
          .then(() => onStart(innerID))
          .then((j) => setJob(j))
          .catch((e) => setErr(errorText(e)))
      }, [innerID, onStart])

      React.useEffect(() => { start() }, [start])

      React.useEffect(() => {
        if (state !== 'pending') return undefined
        const t = setInterval(() => {
          Promise.resolve()
            .then(() => onPoll(innerID))
            .then((j) => { if (j) setJob(j) })
            .catch(() => { /* 单次轮询失败不算数，下一次接着问 */ })
        }, 2000)
        return () => clearInterval(t)
      }, [state, innerID, onPoll])

      React.useEffect(() => {
        if (state === 'done') { try { onReload?.() } catch { /* 刷新列表失败不影响登录结果 */ } }
      }, [state, onReload])

      const code = job?.code?.userCode ?? null
      const uri = job?.code?.verificationUri ?? null
      const done = job?.state === 'done'

      return h('div', { 'data-wc-pane-page': 'accounts', 'data-wc-msalogin': '' },
        h('div', { 'data-wc-panehead': '' },
          h('button', { type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', onClick: onBack }, '← 返回'),
          h('div', { 'data-wc-h': '' }, `登录「${account.name}」`),
        ),
        err ? h('div', { 'data-wc-warnnote': '' }, err) : null,
        done
          ? h('div', { 'data-wc-oknote': '' },
            `登录成功：${job?.result?.name ?? account.name}。现在可以连服务器了。`)
          : job?.state === 'error'
            ? h('div', { 'data-wc-warnnote': '' },
              `登录失败：${job?.error ?? '原因不明'}`,
              h('div', { 'data-wc-dim': '' }, '点下面的「重新开始」会给你一个新代码。'))
            : h('div', null,
              h('div', { 'data-wc-dim': '' }, '在浏览器里打开下面这个网址，输入代码，然后回来等一会儿（这个页面会自己更新）。'),
              h('div', { 'data-wc-msauri': '' },
                uri
                  ? h('a', { href: uri, target: '_blank', rel: 'noreferrer' }, uri)
                  : h('span', { 'data-wc-dim': '' }, '正在向微软要代码…')),
              h('div', { 'data-wc-msacode': '' }, code ?? '……'),
              h('div', { 'data-wc-acts': '' },
                h('button', {
                  type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: !code,
                  onClick: () => { try { navigator.clipboard.writeText(code); setCopied(true) } catch { /* 剪贴板不给用就算了 */ } },
                }, copied ? '已复制' : '复制代码'),
                h('span', { 'data-wc-spacer': '' }),
                h('span', { 'data-wc-dim': '' }, job?.state === 'pending' ? '等你在浏览器里完成…' : '正在准备…'),
              )),
        h('div', { 'data-wc-acts': '' },
          h('button', { type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', onClick: start }, '重新开始'),
        ),
      )
    }

    /**
     * 页 1：账户。**列表 + 三个独立的新建/编辑界面**：
     *   · 列表 = 横条（类型气泡 + 名字）+ 右侧「编辑/刷新」「删除」；不显示任何细节、不显示 innerID
     *   · 「添加」在右上角 → 先选类型 → 进对应界面
     *   · 离线能进「编辑」（UUID 等细节在那里看）；第三方只有「刷新」
     */
    function AccountsPane(props) {
      const { accounts = [], servers = [], busyKey } = props
      const busy = busyKey !== null
      const [view, setView] = React.useState('list')
      const [editing, setEditing] = React.useState(null)
      const back = () => { setEditing(null); setView('list') }

      if (view === 'pick') return h(TypePicker, { onBack: back, onPick: (k) => setView(k) })
      if (view === 'new-offline' || view === 'edit-offline') {
        return h(OfflineForm, {
          mode: view === 'edit-offline' ? 'edit' : 'new', account: editing, busyKey,
          onBack: back, onDone: back, onPatch: props.onPatch, onCreate: props.onCreate,
        })
      }
      if (view === 'new-yggdrasil' || view === 'edit-yggdrasil') {
        return h(YggdrasilForm, {
          mode: view === 'edit-yggdrasil' ? 'edit' : 'new', account: editing, busyKey,
          servers, onBack: back, onDone: back, onPatch: props.onPatch, onCreate: props.onCreate,
          onRemoveServer: props.onRemoveServer, onAddCard: props.onAddCard,
        })
      }
      /* 正版（微软）：先建账户（只填邮箱），再点「登录」走设备码 */
      if (view === 'new-microsoft' || view === 'edit-microsoft') {
        return h(MicrosoftForm, {
          mode: view === 'edit-microsoft' ? 'edit' : 'new', account: editing, busyKey,
          onBack: back, onDone: back, onPatch: props.onPatch, onCreate: props.onCreate,
        })
      }
      if (view === 'msa-login' && editing) {
        return h(MicrosoftLogin, {
          account: editing, onBack: back, onReload: props.onReload,
          onStart: props.onMsaStart, onPoll: props.onMsaPoll,
        })
      }

      return h('div', { 'data-wc-pane-page': 'accounts' },
        h('div', { 'data-wc-panehead': '' },
          h('div', { 'data-wc-h': '' }, `账户（${accounts.length}）`),
          h('span', { 'data-wc-spacer': '' }),
          /* 用户 2026-10-15：刷新挪到页头（在「添加」左边）—— 原来每行一个，只能刷那一个；
             现在一下刷全部（逐个走刷新接口，各自按类型处理：离线不认证、正版只报缓存状态）。 */
          h('button', {
            type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: busy,
            title: '刷新所有账户的登录状态',
            onClick: () => props.onRefreshAll?.(),
          }, busyKey === 'acct:refreshAll' ? '刷新中…' : '刷新'),
          h('button', {
            type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-primary': '',
            onClick: () => setView('pick'),
          }, '＋ 添加'),
        ),
        accounts.length
          ? accounts.map((a) => h(AccountRow, {
            key: a.innerID, account: a, busyKey,
            onEdit: (acc) => {
              setEditing(acc)
              // 🔴 三种类型各有各的表单：第三方账户漏了分支就会被送进**离线表单**
              //    （2026-10-15 用户报的 bug：「我用的是第三方皮肤站账号，点编辑进去还是离线账号」）
              setView(acc.type === 'microsoft' ? 'edit-microsoft' : acc.type === 'yggdrasil' ? 'edit-yggdrasil' : 'edit-offline')
            },
            onLogin: (acc) => { setEditing(acc); setView('msa-login') },
            onDelete: props.onDelete,
          }))
          : h('div', { 'data-wc-dim': '' }, '还没有账户，点右上角「添加」。'),
      )
    }

    /* ---------------------------------------------------------- 页 2：指令白名单 */
    /*
     * 2026-10-15 用户：「把命令都列出来并配上开关，把白名单和保存给去了」
     *   ⇒ 不再是一个自由文本框 + 「保存」，而是**目录里每条指令一个开关，拨一下就存**。
     *   🔴 `on` 一律是**服务端**算好下发的（`commandInList`，只看名单）—— 客户端一行 import
     *      都没有，自己再抄一份匹配逻辑就等于有两个真相（踩坑档案第 103 条那个教训）。
     *   🔴 白名单里"不在目录里"的条目（正则 / `*` / 目录外的名字）**单独列出来带一个 ×**，
     *      绝不静默丢掉 —— 否则用户永远不知道为什么关了开关那条指令还能用。
     */
    function WhitelistPane(props) {
      const {
        catalog = [], extra = [],
        allowAll, busyKey, cfgOk,
        onAllowAll, onToggleCmd, onDropEntry,
      } = props
      const busy = busyKey !== null
      // 开关**一拨就存**（用户 2026-09-16 定）
      const allowBusy = busyKey === 'cfg:allowAll'
      /**
       * 🔴 2026-10-15 审计（报告第 2 条）：`/api/mc/config` 没读出来 ⇒ 名单是空的、目录也是空的。
       *    那种状态下拨任何一个开关都会拿"空的名单 + 这一条"去覆盖服务端真实白名单，所以全部禁用。
       *    （「允许所有指令」是单键写入、写的是用户明确选的值，不具破坏性，不禁用。）
       */
      const cfgBad = cfgOk === false
      const locked = allowAll === true
      const rowOff = busy || cfgBad || locked

      return h('div', { 'data-wc-pane-page': 'whitelist' },
        h('div', { 'data-wc-sec': '' },
          h(Switch, {
            label: '允许所有指令',
            disabled: allowBusy,
            on: allowAll === true,
            onToggle: (next) => onAllowAll(next),
          }),
          h('div', { 'data-wc-h': '' }, '指令白名单'),
          cfgBad
            ? h('div', { 'data-wc-warnnote': '' },
              '配置没读出来，下面的开关不可信 —— 已全部禁用（现在改会拿空名单覆盖服务端真实白名单）。关掉再打开这个窗口重试。')
            : null,
          locked
            ? h('div', { 'data-wc-warnnote': '' }, '已允许所有指令，白名单不再生效（关掉上面的开关才能改）。')
            : null,
          extra.length
            ? h('div', { 'data-wc-cmdextra': '' },
              h('div', { 'data-wc-cmdgrouph': '' }, '自定义条目'),
              ...extra.map((x) => h('div', { 'data-wc-cmdrow': '' },
                h('div', { 'data-wc-cmdmain': '' },
                  h('span', { 'data-wc-cmdname': '' }, h('code', { 'data-wc-code': '' }, x.entry)),
                  h('span', { 'data-wc-cmddsc': '' },
                    (x.covers ?? []).length
                      ? `罩着：${x.covers.slice(0, 10).join('、')}${x.covers.length > 10 ? ` 等 ${x.covers.length} 条` : ''}`
                      : '没匹配到目录里的任何指令'),
                ),
                h('button', {
                  type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '',
                  disabled: busy || cfgBad,
                  title: '从白名单里删掉这一条',
                  onClick: () => onDropEntry(x.entry),
                }, '×'),
              )),
            )
            : null,
          ...catalog.map((g) => h('div', { 'data-wc-cmdgroup': '' },
            h('div', { 'data-wc-cmdgrouph': '' }, g.group),
            ...g.items.map((it) => h(Switch, {
              label: h('span', { 'data-wc-cmdname': '' }, it.name,
                it.danger ? h('span', { 'data-wc-danger': '' }, '危险') : null),
              desc: it.desc,
              on: it.on === true,
              disabled: rowOff,
              title: it.danger ? '会不可逆地影响世界 / 服务器 / 别人' : `放行 ${it.name}`,
              onToggle: (next) => onToggleCmd(it.name, next),
            })),
          )),
        ),
      )
    }

    /* ------------------------------------------------------------ 页 3：提示词 */

    function PromptPane(props) {
      const {
        /* 🔴 报告 H8（2026-10-13）：`:1584` 用了 `mdPath`，但这里以前**没解构它** ——
         *    `mdPath` 声明在**兄弟函数** `McSettingsModal`（`:2066`）里，不在本函数的闭包链上
         *    ⇒ 渲染「提示词」页必抛 `ReferenceError: mdPath is not defined`。
         *    上层已经把 `mdPath` 当 prop 传进来了（`:2349`），补上解构即可。 */
        mdText, mdSource, mdPath, wsExists, rulesExists, injectStatus,
        injectWc, injectWs, busyKey, onMdText, onSave, onReset, onInjectWc, onInjectWs,
        followVersion, rulesVersion, pluginVersion, onFollowVersion, hasWorkspace,
        // 「默认提示词」那一块（基根 / 新会话的种子）
        dfText, dfInfo, dfReady, onDfText, onDfSave, onDfReset,
      } = props
      const busy = busyKey !== null
      const [confirmReset, setConfirmReset] = React.useState(false)
      const [confirmDfReset, setConfirmDfReset] = React.useState(false)
      const saveBusy = busyKey === 'md:save'
      const resetBusy = busyKey === 'md:reset'
      const dfSaveBusy = busyKey === 'df:save'
      const dfResetBusy = busyKey === 'df:reset'
      const followBusy = busyKey === 'cfg:follow'
      const seg = injectStatus?.segments ?? {}
      const mark = (on) => (on ? '✓' : '✗')

      return React.createElement(
        'div',
        { 'data-wc-pane-page': 'prompt' },
        React.createElement('div', { 'data-wc-sec': '' },
          React.createElement('div', { 'data-wc-h': '' }, '提示词', hasWorkspace ? h(WsMark) : null),
          // 🔴 把"到底会不会注入"直接摆给用户看（2026-09-16：真机上反复出现"没注入"，
          //    原因可能有一堆 —— 不是 MC 模式 / 开关关了 / 文件不在 —— 与其让人猜，不如显示判据）
          injectStatus
            ? React.createElement('div', { 'data-wc-injectstatus': '' },
              `本会话注入：${injectStatus.mcPlus ? 'MC+模式' : 'MC模式'} ${mark(injectStatus.mcMode)} ｜ 本提示词 RULES.md ${mark(seg['agents-md'])} ｜ 版本提示.md ${mark(seg['version-prompt'])} ｜ 工作区 AGENTS.md ${mark(seg['workspace-agents-md'])}`
              + (injectStatus.mcPlus ? ` ｜ MC+ 说明 ${mark(seg['mc-plus-note'])}` : ''),
              injectStatus.notes?.length
                ? React.createElement('div', { 'data-wc-note': '' }, injectStatus.notes.join(' ｜ '))
                : null,
            )
            : null,
        ),

        /* ── 上块：默认提示词（基根那份 = 新会话的种子）─────────────────────────
         * 用户 2026-10-15：「分为会话提示词和默认提示词」。新会话的记忆根是
         * `seedSessionRoot()` 从**基根**拷 `RULES.md` 播种的 ⇒ 改这块只影响**以后**的会话。 */
        React.createElement('div', { 'data-wc-sec': '', 'data-wc-defprompt': '' },
          React.createElement('div', { 'data-wc-h': '' },
            '默认提示词 ',
            h(FileName, { key: 'f', name: 'RULES.md', missing: dfInfo?.exists === false })),
          React.createElement('div', { 'data-wc-note': '' },
            '以后新建的会话用的就是这一份（新会话的记忆根会从它拷一份过去）—— '
            + '改它不影响当前会话。'
            + (dfInfo?.path ? `文件：${dfInfo.path}` : '')),
          // 🔴 没开 memoryPerSession 时基根 === 会话根，两块是**同一份文件**。
          //    不说清楚的话，用户会以为"改上面那块对本会话没生效"，其实是同一处。
          dfInfo?.sharedWithSession === true
            ? React.createElement('div', { 'data-wc-warnnote': '' },
              '⚠️ 「记忆按会话分」没开（memoryPerSession），这一块和下面的「会话提示词」其实是'
              + '同一份文件 —— 在这里改就等于改本会话。')
            : null,
          // 🔴 服务端还没重载时（改了 index.js 但 DSH 宿主没重启/没重载插件），GET 回的仍是旧形状
          //    ⇒ 这里读不到内容。**必须挡住保存**：旧服务端不认 `scope:'default'`，
          //    会把这段文字写进**本会话**那份，看着像"改默认"，其实是把当前会话覆盖了。
          !dfReady
            ? React.createElement('div', { 'data-wc-warnnote': '' },
              '⚠️ 服务端还没重载（index.js 改过之后要重启 DSH 或重新加载插件才生效）—— '
              + '这一块现在读不到内容，也先别保存（旧服务端会把它写进当前会话那份）。')
            : null,
          React.createElement('textarea', {
            'data-wc-textarea': '', 'data-wc-tall': '', value: dfText, spellCheck: false,
            disabled: busy || !dfReady,
            ...(hasWorkspace ? {} : { readOnly: true, 'data-wc-dimmed': '' }),
            onChange: (e) => { if (hasWorkspace && dfReady) onDfText(e.target.value) },
          }),
          hasWorkspace && dfReady
            ? React.createElement(
              'div',
              { 'data-wc-acts': '' },
              React.createElement('button', {
                type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-primary': '',
                disabled: busy, onClick: onDfSave,
              }, dfSaveBusy ? '保存中…' : '保存'),
              confirmDfReset
                ? React.createElement('button', {
                  type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '', disabled: busy,
                  title: '再点一次确认',
                  onClick: () => { setConfirmDfReset(false); onDfReset() },
                }, dfResetBusy ? '恢复中…' : '确认恢复')
                : React.createElement('button', {
                  type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '', disabled: busy,
                  title: '恢复成插件内置的那份（出厂值）',
                  onClick: () => setConfirmDfReset(true),
                }, '恢复内置默认'),
              confirmDfReset
                ? React.createElement('button', {
                  type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: busy,
                  onClick: () => setConfirmDfReset(false),
                }, '取消')
                : null,
            )
            : null,
        ),

        /* ── 下块：会话提示词（本会话正在用的那份）─────────────────────────── */
        React.createElement('div', { 'data-wc-sec': '', 'data-wc-sessionprompt': '' },
          React.createElement('div', { 'data-wc-h': '' },
            '会话提示词 ',
            h(FileName, { key: 'f', name: 'RULES.md', missing: rulesExists === false })),
          React.createElement('div', { 'data-wc-note': '' },
            '本会话正在用的那份。'
            + (mdPath ? `文件：${mdPath}` : '（还没有工作区，这份是内置默认，只读）')),
          // 无工作区：正文只读、展示内置默认提示词（服务端回的 text 就是默认那份）
          React.createElement('textarea', {
            'data-wc-textarea': '', 'data-wc-tall': '', value: mdText, spellCheck: false,
            disabled: busy,
            ...(hasWorkspace ? {} : { readOnly: true, 'data-wc-dimmed': '' }),
            onChange: (e) => { if (hasWorkspace) onMdText(e.target.value) },
          }),
          hasWorkspace
            ? React.createElement(
              'div',
              { 'data-wc-acts': '' },
              React.createElement('button', {
                type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-primary': '',
                disabled: busy, onClick: onSave,
              }, saveBusy ? '保存中…' : '保存'),
              confirmReset
                ? React.createElement('button', {
                  type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '', disabled: busy,
                  title: '再点一次确认',
                  onClick: () => { setConfirmReset(false); onReset() },
                }, resetBusy ? '恢复中…' : '确认恢复')
                : React.createElement('button', {
                  type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '', disabled: busy,
                  title: '用上面「默认提示词」那一份重新播种本会话',
                  onClick: () => setConfirmReset(true),
                }, '恢复为默认'),
              confirmReset
                ? React.createElement('button', {
                  type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: busy,
                  onClick: () => setConfirmReset(false),
                }, '取消')
                : null,
            )
            : null,
        ),
        React.createElement('div', { 'data-wc-sec': '' },
          React.createElement('div', { 'data-wc-h': '' }, '注入'),
          // 🔴 用户 2026-10-15：「这两个去掉」—— 版本提示那一块的界面入口去掉。
          //    文件 `<记忆根>/版本提示.md` 仍在、仍然注入（页面顶部状态行里还看得见它），
          //    只是不再在设置页里编辑。
          // 三个开关只在**有工作区**时出现（它们的值按工作区存）
          hasWorkspace
            ? [
              // 「随版本更新」（默认开）：插件升级时用新版本默认内容替换**「默认提示词」那一块**
              // 🔴 用户 2026-10-15：「对升级只动默认的，会话的不动」—— 所以「会话提示词」不会被它碰。
              React.createElement(Switch, {
                key: 'follow', label: '随版本更新', mark: true,
                desc: followBusy ? '保存中…' : '插件升级时，用新版本默认内容替换「默认提示词」那一块（会覆盖你的修改）；「会话提示词」不动',
                disabled: busy,
                on: followVersion === true,
                onToggle: (next) => onFollowVersion(next),
              }),
              // 注入本提示词（`<工作区>/.dsh-mc-agent/RULES.md`）：版本行作为它的说明，不再单独一行
              React.createElement(Switch, {
                key: 'wc', mark: true, title: '注入本提示词 RULES.md',
                label: ['注入本提示词 ', h(FileName, { key: 'f', name: 'RULES.md', missing: rulesExists === false })],
                desc: `当前内容对应：${rulesVersion ? `v${rulesVersion}` : '未知（还没同步过）'}　·　本插件：v${pluginVersion || '?'}`,
                on: injectWc === true,
                onToggle: (next) => onInjectWc(next),
              }),
              // 注入工作区 AGENTS.md（`<工作区>/AGENTS.md`）：**不因文件缺失禁用**（开关始终用于改配置）
              React.createElement(Switch, {
                key: 'ws', mark: true, title: '注入工作区 AGENTS.md',
                label: ['注入工作区 ', h(FileName, { key: 'f', name: 'AGENTS.md', missing: wsExists === false })],
                desc: 'MC+模式下将固定注入，不受本设置影响',
                on: injectWs === true,
                onToggle: (next) => onInjectWs(next),
              }),
            ]
            : null,
        ),
        !hasWorkspace ? h(WsNeedHint) : null,
      )
    }

    /* ------------------------------------------------------------ 页 4：记忆 */

    /**
     * 「记忆」页（用户 2026-10-20 定）：把原来的「文件分享」整页换掉，分享的开关/base/清除
     * 全部下线。这一页只回答三件事：
     *   ① 这个会话的记忆**存在哪个目录**（`lessons.md` / `world.md` / `README.md` …）；
     *   ② 目录里**现在有哪些文件**（多大、什么时候改的）；
     *   ③ 一键**用系统文件管理器打开**那个目录（点某个文件 = 在里面选中它）。
     * 🔴 路径全部由服务端推导（`GET /api/mc/memory`），前端不拼也不传路径。
     */
    function MemoryPane(props) {
      const { info, busyKey, hasWorkspace, onOpen } = props
      const busy = busyKey !== null
      const openBusy = busyKey === 'memory:open'
      const files = Array.isArray(info?.files) ? info.files : []
      const dirs = Array.isArray(info?.dirs) ? info.dirs : []
      const perSession = info?.memoryPerSession === true
      /* 标准四件套点名（用户 2026-10-20：「包括 lessons.md、world.md」）：没建也照实说没建 */
      const KNOWN_FILES = ['README.md', 'world.md', 'lessons.md', 'tasks.md']
      const missing = KNOWN_FILES.filter((n) => !files.some((f) => f.name === n))

      return React.createElement(
        'div',
        { 'data-wc-pane-page': 'memory' },
        React.createElement('div', { 'data-wc-sec': '' },
          React.createElement('div', { 'data-wc-h': '' }, '记忆目录'),
          React.createElement('p', { 'data-wc-hint': '' },
            info?.dir
              ? `目录：${info.dir}`
              : (hasWorkspace ? '目录：读取中…' : '还没有工作区，记忆目录读不出来。')),
          React.createElement('p', { 'data-wc-hint': '' },
            perSession
              ? '按会话分开存：这里只是本会话那一份，换个会话就是另一个目录。'
              : '所有会话共用这一份（要分开存，把配置项 memoryPerSession 设成 true）。'),
          React.createElement('div', { 'data-wc-acts': '' },
            React.createElement('button', {
              type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-primary': '',
              disabled: busy || !info?.dir,
              title: '在资源管理器 / 访达里打开这个目录',
              onClick: () => onOpen(null),
            }, openBusy ? '打开中…' : '打开文件所在位置')),
        ),
        React.createElement('div', { 'data-wc-sec': '' },
          React.createElement('div', { 'data-wc-h': '' }, '记忆文件'),
          files.length === 0
            ? React.createElement('p', { 'data-wc-hint': '' },
              info?.exists === false ? '这个目录还没建出来（AI 第一次用记忆时才建）。' : '目录里还没有文件。')
            : React.createElement('div', { 'data-wc-acts': '' },
              files.map((f) => React.createElement('button', {
                key: 'f:' + f.name,
                type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '',
                disabled: busy,
                title: `${f.name}${f.bytes != null ? `　${fmtBytes(f.bytes)}` : ''}　（点它 = 在文件夹里选中这个文件）`,
                onClick: () => onOpen(f.name),
              }, `${f.name}${f.bytes != null ? `　${fmtBytes(f.bytes)}` : ''}`))),
          missing.length > 0
            ? React.createElement('p', { 'data-wc-hint': '' },
              `还没建：${missing.join('、')}（AI 第一次往里写才会建出来）`)
            : null,
          dirs.length > 0
            ? React.createElement('p', { 'data-wc-hint': '' },
              `子目录：${dirs.map((d) => d.name).join('、')}（点「打开文件所在位置」就能进去看）`)
            : null,
          React.createElement('p', { 'data-wc-hint': '' },
            '记忆是 AI 跨会话攒下来的东西（踩过的坑、世界事实、任务记录）；它随时会往里写，这里只是让你看得到、找得到。'),
        ),
        !hasWorkspace ? h(WsNeedHint) : null,
      )
    }

    function fmtBytes (n) {
      const v = Number(n ?? 0)
      if (!Number.isFinite(v) || v <= 0) return '0 B'
      if (v < 1024) return `${v} B`
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
      return `${(v / 1024 / 1024).toFixed(1)} MB`
    }

    /* ------------------------------------------------------------ 页 5：更新 */

    /**
     * 「更新」页（用户 2026-10-20）：这个插件是 `link:<源码目录>` 装的、npm 上没有包，
     * 所以"新版本" = git 远端（**优先 gitee**，github 兜底）比本地多出来的提交。
     * 这一页只回答四件事：现在是什么版本 / 有没有新版 / 新版加了什么 / 一键拉取。
     * 🔴 拉完**必须重启 DSH** 才生效（插件在启动时加载），页面上明确写出来。
     */
    function UpdatePane (props) {
      const { info, busyKey, onCheck, onApply } = props
      const busy = busyKey !== null
      const behind = Number(info?.behind ?? 0) || 0
      const dirty = Number(info?.dirty ?? 0) || 0
      const commits = Array.isArray(info?.commits) ? info.commits : []
      /* 复制安装（目录里没有 .git）走「覆盖式更新」：比版本/提交，动手前整份备份（用户 2026-10-20） */
      const isCopy = info?.mode === 'copy'
      const canApply = behind > 0 ? info?.canPull === true : info?.forcePull === true
      const rows = [
        ['当前版本', `${info?.currentVersion ?? '—'}${info?.currentCommit
          ? `（${isCopy ? '上次覆盖 ' : ''}${info.currentCommit}）`
          : (isCopy ? '（复制安装，没有提交记录）' : '')}`],
        ['更新源', info?.source ? (isCopy ? info.source : `${info.source} / ${info.branch ?? '?'}`) : '—'],
        ['远端最新', behind > 0 ? `${info?.latestVersion ?? '—'}（${info?.latestCommit ?? '—'}）` : '与本地一致'],
        ['安装方式', isCopy ? '复制（没有 .git）—— 覆盖式更新' : 'git（快进拉取）'],
      ]
      return h('div', { 'data-wc-pane-page': 'update' },
        h('div', { 'data-wc-sec': '' },
          h('div', { 'data-wc-h': '' }, '版本'),
          rows.map(([k, v]) => h('p', { 'data-wc-hint': '', key: 'row:' + k },
            h('strong', null, `${k}：`), v)),
          behind > 0
            ? h('p', { 'data-wc-hint': '' },
              h('strong', null, `有新版本：落后 ${behind} 个提交`),
              isCopy ? ' —— 点「覆盖到最新」（会先整份备份再覆盖）。' : ' —— 点「立即更新」拉取。')
            : h('p', { 'data-wc-hint': '' },
              info == null
                ? '还没查过。'
                : (info.ready === false
                  ? '查不到新版本（原因见下）。'
                  : (isCopy ? '和远端一致（复制安装：和上次覆盖是同一个提交）。' : '已经是最新版。'))),
          info?.ready === false && info?.reason
            ? h('p', { 'data-wc-hint': '', 'data-wc-dirty': '' }, info.reason)
            : null,
          dirty > 0 && !isCopy
            ? h('p', { 'data-wc-hint': '' },
              `本地有 ${dirty} 个未提交改动 —— git 会拒绝在改到一半时快进合并，`
              + '先提交或 stash 再来点更新。')
            : null,
          h('div', { 'data-wc-acts': '' },
            h('button', {
              type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: busy,
              onClick: () => onCheck(),
            }, busyKey === 'update:check' ? '检查中…' : '检查更新'),
            h('button', {
              type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-primary': '',
              disabled: busy || !canApply,
              title: !canApply
                ? '已经是最新'
                : (isCopy
                  ? '覆盖式更新：先整份备份，再用最新代码覆盖（不碰 .git / node_modules）'
                  : (info?.canPull === true ? '用 git pull --ff-only 拉取' : '现在不能拉（见上面那条原因）')),
              onClick: () => onApply(),
            }, busyKey === 'update:apply' ? '更新中…' : (isCopy ? '覆盖到最新' : '立即更新'))),
          h('p', { 'data-wc-hint': '' },
            '更新完**要重启 DSH** 才生效：插件是启动时加载的，光刷新页面不算。'),
        ),
        h('div', { 'data-wc-sec': '' },
          h('div', { 'data-wc-h': '' }, '新版加了什么'),
          behind === 0 && commits.length === 0
            ? h('p', { 'data-wc-hint': '' }, '没有新提交可看。')
            : h(React.Fragment, null,
              commits.length
                ? h('div', { 'data-wc-acts': '' }, commits.map((c) => h('span', {
                  key: 'c:' + c.hash, 'data-wc-tag': '', title: c.hash,
                }, `${c.hash} ${c.subject}`)))
                : null,
              info?.changelog
                ? h('div', { 'data-wc-log': '' }, info.changelog)
                : h('p', { 'data-wc-hint': '' }, '这几个提交没改 CHANGELOG.md，看上面的提交标题。')),
        ),
        h('div', { 'data-wc-sec': '' },
          h('div', { 'data-wc-h': '' }, '它是怎么工作的'),
          h('p', { 'data-wc-hint': '' },
            '「新版本」只可能来自 git 远端：npm 上没有这个包（源码在 GitHub / Gitee 上，优先取 Gitee）。'),
          isCopy
            ? h('p', { 'data-wc-hint': '' },
              '你这份插件是整份复制进宿主 node_modules 的（目录里没有 .git），所以没有本地远端可比：'
              + '检查更新时会临时 clone 一份最新代码（Gitee 优先、GitHub 兜底）来比版本与提交；'
              + '点「覆盖到最新」会先把整个插件目录备份成 `dsh-mc-agent.bak-日期-时间`，再覆盖代码和文档'
              + '（.git 与 node_modules 一律不碰，备份目录留着，确认没问题可以自己删）。')
            : h('p', { 'data-wc-hint': '' },
              '更新只用 git pull --ff-only（快进合并、不产生 merge commit）；有冲突或本地改动时'
              + '直接把 git 的原话报给你，**不会偷偷 stash**。'),
          h('p', { 'data-wc-hint': '' },
            '检查结果缓存 10 分钟；有新版本时三个「MC设置」入口的右上角都会有个红点。'),
        ),
      )
    }

    const TABS = [
      { id: 'accounts', label: '账户' },
      { id: 'whitelist', label: '指令白名单' },
      { id: 'prompt', label: '提示词' },
      { id: 'memory', label: '记忆' },
      { id: 'update', label: '更新' },
    ]

    /* ==================================================================
     * 「连接到MC」模态框（2026-10-04）
     * ----------------------------------------------------------------
     * 受控（`open` / `onClose`）。点「连接」或点局域网行 →
     *   `POST /api/mc/connect`：**插件注入提示词并让该会话跑一轮**（真正的连接由 LLM 去调
     *   `mc_connect`）；本组件**不自己连**。历史只记**手动输入**的地址，局域网直连不记。
     * 「添加/管理」→ 在**本弹窗之上**叠一个受控的设置弹窗（`initialTab='accounts'`）。
     * ================================================================== */
    function McConnectModal(props) {
      const open = props?.open === true
      const sessionId = props?.sessionId ?? null
      const [address, setAddress] = React.useState('')
      const [servers, setServers] = React.useState([])
      const [accts, setAccts] = React.useState([])
      const [accountId, setAccountId] = React.useState('')
      const [acctOpen, setAcctOpen] = React.useState(false)
      const [lan, setLan] = React.useState(null)          // null = 探测中
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const pickRef = React.useRef(null)
      // 🟢 报告第 10 条：支持版本范围晚到时，催一次重渲染（值本身不读，只当"版本号"用）
      const [, setGateTick] = React.useState(0)

      // 打开时：拉账户 + 历史，并发探测局域网（关闭就丢弃结果）
      React.useEffect(() => {
        if (!open) return undefined
        let alive = true
        setError(''); setLan(null)
        apiGet('/api/mc/accounts').then((a) => {
          if (!alive) return
          const list = Array.isArray(a.accounts) ? a.accounts : []
          setAccts(list)
          setAccountId((cur) => cur || a.defaultAccount || list[0]?.innerID || '')
        }).catch(() => { /* 账户拉不到就不显示账户选择 */ })
        apiGet('/api/mc/servers').then((s) => { if (alive) setServers(Array.isArray(s.servers) ? s.servers : []) }).catch(() => {})
        apiPost('/api/mc/lan', {}).then((r) => { if (alive) setLan(Array.isArray(r.servers) ? r.servers : []) })
          .catch(() => { if (alive) setLan([]) })
        /**
         * 🟢 报告第 10 条：顺手把**支持版本范围**拉回来。
         *
         * 以前 `MC_VERSION_IN_RANGE` 是 `() => null` 的桩，不需要任何数据；现在真判了 ——
         * 若等用户点了「扫描局域网」才拉，第一批结果会按"未知"渲染（不标红、点了也不拦），
         * 看起来就像"这道门时灵时不灵"。接口有一次性缓存，重复调用只发一次请求。
         * 拉不到也不报错：门控退化成"未知 ⇒ 放行"，与以前的行为一致。
         * 结果落在模块级缓存里（`MC_VERSION_IN_RANGE` 直接读它），这里只催一次重渲染。
         */
        loadMcGateInfo().then((info) => { if (alive && info) setGateTick((n) => n + 1) })
        return () => { alive = false }
      }, [open])

      /**
       * 🔴 2026-10-15 审计（报告第 8 条）：上面那个 effect 的依赖只有 `[open]`。
       *    「添加/管理」是在**本弹窗之上**叠一个受控的 `McSettingsModal`（`initialTab='accounts'`），
       *    用户在那里新建 / 删除 / 刷新账户后关掉它，本弹窗的 `accts` **还是打开那一刻的旧快照** ——
       *    刚建的账户不在下拉里，刚删的还在、选中它还会连失败。
       *    这里盯 `settingsOpen` 的 **true → false** 沿：一关就重读一次账户（只重读账户，
       *    不重探局域网，免得平白闪一下）。同时把已经失效的选中项落到默认/第一个。
       */
      const prevSettingsOpen = React.useRef(false)
      React.useEffect(() => {
        const was = prevSettingsOpen.current
        prevSettingsOpen.current = settingsOpen
        if (!open || !was || settingsOpen) return undefined
        let alive = true
        apiGet('/api/mc/accounts').then((a) => {
          if (!alive) return
          const list = Array.isArray(a.accounts) ? a.accounts : []
          setAccts(list)
          setAccountId((cur) => (list.some((x) => x.innerID === cur)
            ? cur
            : (a.defaultAccount || list[0]?.innerID || '')))
        }).catch(() => { /* 读不到就保持原样，别把下拉清空 */ })
        return () => { alive = false }
      }, [settingsOpen, open])

      // 账户下拉：点外面 / Esc 关掉
      React.useEffect(() => {
        if (!acctOpen) return undefined
        const onDown = (e) => { if (pickRef.current && !pickRef.current.contains(e.target)) setAcctOpen(false) }
        const onKey = (e) => { if (e.key === 'Escape') setAcctOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
      }, [acctOpen])

      // Esc 关弹窗（叠着设置弹窗时交给设置弹窗自己关）
      React.useEffect(() => {
        if (!open || settingsOpen) return undefined
        const onKey = (e) => { if (e.key === 'Escape') props.onClose?.() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open, settingsOpen, props?.onClose])

      // 出错提示：**3s 自动消失**（定时器随 error 变化 / 卸载清掉，别在关窗后到点报错）
      React.useEffect(() => {
        if (!error) return undefined
        const t = setTimeout(() => setError(''), 3000)
        return () => clearTimeout(t)
      }, [error])

      if (!open) return null

      const closeAll = () => { if (typeof props.onClose === 'function') props.onClose() }
      const refreshHistory = () => apiGet('/api/mc/servers')
        .then((s) => setServers(Array.isArray(s.servers) ? s.servers : [])).catch(() => {})
      const connect = (addr, via) => {
        const a = String(addr ?? '').trim()
        if (!a) { setError('请先填服务器地址'); return }
        setBusy(true); setError('')
        apiPost('/api/mc/connect', { sessionId, address: a, accountId, via, asUser: props?.asUser === true })
          .then(() => { if (via !== 'lan') refreshHistory(); closeAll() })
          .catch((e) => setError(errorText(e)))
          .finally(() => setBusy(false))
      }
      const removeServer = (addr) => apiDelete('/api/mc/servers', { address: addr })
        .then((r) => setServers(Array.isArray(r.servers) ? r.servers : []))
        .catch((e) => setError(errorText(e)))
      // 账户显示：`名字（来源）` —— **「（来源）」用灰色**（用户 2026-10-04）
      const acctLabelNode = (a) => h('span', null,
        a.name,
        h('span', { 'data-wc-cn-src': '' }, `（${(ACCT_TYPE[a.type] ?? {}).label ?? a.type}）`))
      const current = accts.find((x) => x.innerID === accountId)
      // 局域网行：满了 / 版本不支持 → 标红；点它**直接连接**（不填输入框、不记历史）
      const lanFull = (s) => Boolean(s?.players && s.players.max != null && s.players.online != null && s.players.online >= s.players.max)
      const lanVersionOk = (s) => MC_VERSION_IN_RANGE(s?.version) !== false
      const clickLan = (s) => {
        if (!lanVersionOk(s)) { setError(`版本不匹配：这台服务器是 ${s.version}，当前插件还不支持`); return }
        if (lanFull(s)) { setError(`服务器已满：${s.players.online}/${s.players.max}`); return }
        connect(s.address, 'lan')
      }

      return h(React.Fragment, null,
        h('div', {
          'data-wc-cn-overlay': '', role: 'presentation',
          onClick: closeAll,
          onMouseDown: (e) => { if (e.target === e.currentTarget) e.preventDefault() },
        },
        h('div', {
          'data-wc-cn-card': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': '连接到MC',
          onClick: (e) => e.stopPropagation(),
        },
        h('div', { 'data-wc-head': '' },
          h('div', { 'data-wc-titlewrap': '' },
            h('div', { 'data-wc-titleline': '' }, h('span', { 'data-wc-title': '' }, '连接到MC'))),
          h('span', { 'data-wc-grow': '' }),
          h('button', {
            type: 'button', 'data-wc-xbtn': '', title: '关闭（Esc）', 'aria-label': '关闭', onClick: closeAll,
          }, IconCloseOutlineRegular ? h(IconCloseOutlineRegular, { size: 14 }) : '×'),
        ),
        h('div', { 'data-wc-cn-body': '' },
          // 顶部的**浮层错误提示**（落在地址上方的留白里；3s 自灭，见上面的 effect）
          error ? h('div', { 'data-wc-cn-error': '', role: 'alert' }, error) : null,
          // ① 地址行
          h('div', null,
            h('div', { 'data-wc-cn-fieldlabel': '' }, '服务器地址'),
            h('div', { 'data-wc-cn-row': '' },
              h('input', {
                'data-wc-cn-input': '', value: address, spellCheck: false, disabled: busy,
                placeholder: 'example.com 或 example.com:25565',
                onChange: (e) => setAddress(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') connect(address, 'manual') },
              }),
              h('button', {
                type: 'button', 'data-wc-cn-actions': '', disabled: busy,
                onClick: () => connect(address, 'manual'),
              }, h(RunIcon, { size: 14 }), '连接')),
          ),
          // ② 历史气泡行
          servers.length
            ? h('div', { 'data-wc-cn-bubbles': '' }, servers.map((addr) => h('span', { key: addr, 'data-wc-cn-bubble': '' },
              h('span', null, addr),
              h('button', {
                type: 'button', 'data-wc-cn-bubblex': '', title: '移除这条历史', 'aria-label': '移除',
                onClick: () => removeServer(addr),
              }, IconCloseOutlineRegular ? h(IconCloseOutlineRegular, { size: 11 }) : '×'))))
            : null,
          // ③ 探测中 → ④ 局域网行
          lan === null
            ? h('div', { 'data-wc-cn-probe': '' },
              h('div', { 'data-wc-cn-dots': '' },
                h('span', { 'data-wc-cn-dot': '' }), h('span', { 'data-wc-cn-dot': '' }), h('span', { 'data-wc-cn-dot': '' })),
              h('span', null, '正在寻找DSH所在局域网中的服务器'))
            : (lan.length
                ? h('div', { 'data-wc-cn-lans': '' }, lan.map((s) => h('button', {
                  key: s.address, type: 'button', 'data-wc-cn-lan': '', disabled: busy,
                  title: `直接连接 ${s.address}`,
                  onClick: () => clickLan(s),
                },
                h('span', { 'data-wc-cn-chip': '' }, '局域网'),
                h('span', { 'data-wc-cn-addr': '' }, s.address),
                // MOTD（地址右边）：灰色、固定两行、**垂直居中**
                s.motd ? h('span', { 'data-wc-cn-motd': '' }, h('span', { 'data-wc-cn-motdtext': '' }, s.motd)) : null,
                // 版本号（玩家数**左边**）：不支持 → 红
                s.version
                  ? h('span', { 'data-wc-cn-ver': '', ...(lanVersionOk(s) ? {} : { 'data-wc-cn-bad': '' }) }, String(s.version))
                  : null,
                // 在线人数：满了 → 红
                (s.players && s.players.online != null)
                  ? h('span', { 'data-wc-cn-count': '', ...(lanFull(s) ? { 'data-wc-cn-bad': '' } : {}) },
                    `${s.players.online}/${s.players.max ?? '?'}`)
                  : null,
                // 运行图标：**无缝嵌在卡片里**（不是独立按钮）
                h('span', { 'data-wc-cn-run': '' }, h(RunIcon, { size: 16 })))))
                : null),
        ),
        // ⑤ 配置卡片行：**固定在底部的 footer**（与上方内容之间留白）
        h('div', { 'data-wc-cn-foot': '' },
          h('div', { 'data-wc-cn-config': '' },
            h('div', null,
              h('div', { 'data-wc-cn-fieldlabel': '' }, '账户'),
              h('div', { 'data-wc-cn-pick': '', ref: pickRef },
                h('button', {
                  type: 'button', 'data-wc-cn-pickbtn': '', 'aria-haspopup': 'listbox',
                  'aria-expanded': acctOpen ? 'true' : 'false',
                  onClick: () => setAcctOpen((v) => !v),
                },
                h('span', null, current ? acctLabelNode(current) : '（无账户）'),
                IconChevronDownOutlineRegular ? h(IconChevronDownOutlineRegular, { size: 14 }) : null),
                acctOpen
                  ? h('div', { 'data-wc-cn-menu': '', role: 'listbox' },
                    accts.map((a) => h('button', {
                      key: a.innerID, type: 'button', 'data-wc-cn-item': '', role: 'option',
                      'aria-selected': a.innerID === accountId ? 'true' : 'false',
                      onClick: () => { setAccountId(a.innerID); setAcctOpen(false) },
                    }, acctLabelNode(a))),
                    h('button', {
                      type: 'button', 'data-wc-cn-item': '', 'data-wc-cn-manage': '',
                      onClick: () => { setAcctOpen(false); setSettingsOpen(true) },
                    }, '添加/管理'))
                  : null)),
            // 预留：其余配置插槽
            h('div', { 'data-wc-cn-extras': '' }))),
        )),
      // 叠加在上层的设置弹窗（受控，直接落到「账户」页）——是**兄弟**节点（不嵌在遮罩里，
      // 否则点它会冒泡到连接弹窗的"点遮罩关闭"）
      h(McSettingsModal, {
        open: settingsOpen, initialTab: 'accounts', sessionId, nested: true,
        onClose: () => setSettingsOpen(false),
      }))
    }

    function McSettingsModal(props) {
      // 🔴 提示词是**按会话工作区**的（`.dsh-mc-agent/RULES.md`），所以要把会话 id / 工作区 cwd 带上。
      const sessionId = props?.sessionId ?? null
      const wsCwd = props?.wsCwd ?? null
      /**
       * 设置接口统一走 query 带 `sessionId` / `cwd`：服务端拿它定位**工作区**。
       * 两者都没有 = **无工作区模式**（从插件菜单等入口打开）：全局项照常，
       * 工作区项由服务端回 `null`（见 index.js `configView` / `cwdOf`）。
       */
      const withSid = (p) => {
        const q = []
        if (sessionId) q.push('sessionId=' + encodeURIComponent(sessionId))
        if (wsCwd) q.push('cwd=' + encodeURIComponent(wsCwd))
        return q.length ? p + (p.includes('?') ? '&' : '?') + q.join('&') : p
      }
      const agentsMdPath = withSid('/api/mc/agents-md')

      // 开关：**可选受控** —— 会话入口（标题条 / hero）走 settingsBus（非受控）；
      // 插件详情页那个 root 作用域入口自带 open / onClose（受控）。
      const controlled = props?.open !== undefined
      const [internalOpen, setInternalOpen] = React.useState(false)
      const open = controlled ? props.open === true : internalOpen
      // 初始标签页：受控入口可以指定（如「连接到MC」里的「添加/管理」直接落到「账户」）
      const [tab, setTab] = React.useState(props?.initialTab ?? 'accounts')
      // 组件跨开关复用 → 每次"打开"都回到指定标签页（没指定就不动）
      React.useEffect(() => {
        if (open && props?.initialTab) setTab(props.initialTab)
      }, [open, props?.initialTab])
      const [accounts, setAccounts] = React.useState([])
      const [servers, setServers] = React.useState([])
      const [defaultAccount, setDefaultAccount] = React.useState(null)
      /* 指令白名单：**存数组**（不再是一个多行文本框）—— 设置页把它画成一排开关，
       * 拨一下就 PATCH 一次，服务端回来的新名单/新目录直接覆盖这两份 state。 */
      const [wlList, setWlList] = React.useState([])
      const [cmdCatalog, setCmdCatalog] = React.useState([])
      const [cmdExtra, setCmdExtra] = React.useState([])
      const [allowAll, setAllowAll] = React.useState(false)
      /**
       * 🔴 2026-10-15 审计（报告第 2 条）：`/api/mc/config` **读成功过没有**。
       *    config 分支的 `.catch` 只 `setError` 就吞掉了 rejection ⇒ `Promise.all` 恒 resolve
       *    ⇒ `.then(() => setLoaded(true))` 恒执行，页面看起来"加载好了"，但
       *    `wlList` 还是初始空值。这时改白名单会发
       *    `commandWhitelist: [...]`（只有刚拨的那一条）—— **把服务端真实配置覆盖掉**。
       *    所以：读失败 ⇒ `cfgOk = false` ⇒ 所有"会把配置写小"的入口禁用、调用也硬拒。
       */
      const [cfgOk, setCfgOk] = React.useState(false)
      const [mdText, setMdText] = React.useState('')
      const [mdSource, setMdSource] = React.useState('default')
      const [mdPath, setMdPath] = React.useState('')
      /**
       * 「提示词」页分**上下两块**（用户 2026-10-15：「分为会话提示词和默认提示词」）：
       *   · 上 = **默认提示词**：**基根**那份（`<memoryDir>/RULES.md`）。新会话的记忆根是
       *     `seedSessionRoot()` 从基根**拷** RULES.md 播种的（`SESSION_SEED_FILES`）⇒
       *     改它只影响**以后**新建的会话，不动本会话。
       *   · 下 = **会话提示词**：本会话那份（`memoryRootFor()`），就是上面的 `mdText`。
       * 🔴 没开 `memoryPerSession` 时两块指向**同一份文件**（服务端回 `sharedWithSession:true`），
       *    这时必须如实提示，不能让用户以为"改上面那块没生效"。
       */
      const [dfText, setDfText] = React.useState('')
      const [dfInfo, setDfInfo] = React.useState(null)
      // 🔴 服务端有没有回 `default` 那一块（没回 = 宿主还没重载新代码）⇒ 见 PromptPane 里的警示。
      const [dfReady, setDfReady] = React.useState(true)
      const [injectWc, setInjectWc] = React.useState(true)
      const [injectWs, setInjectWs] = React.useState(false)
      // 「提示词 → 随版本更新」（默认开）：开关与版本记录都**按工作区**存（.dsh-mc-agent/config.json）
      const [followVersion, setFollowVersion] = React.useState(true)
      const [rulesVersion, setRulesVersion] = React.useState(null)
      const [pluginVersion, setPluginVersion] = React.useState('')
      // 「记忆」：这个会话的记忆目录 + 里面有哪些文件（用户 2026-10-20，原来的「文件分享」整页换掉）
      const [memInfo, setMemInfo] = React.useState(null)
      const [upd, setUpd] = React.useState(null)
      const [wsPath, setWsPath] = React.useState('')
      const [wsExists, setWsExists] = React.useState(false)
      // 本提示词那个文件（RULES.md）在不在 —— 给名字加"缺失"样式用
      const [rulesExists, setRulesExists] = React.useState(true)
      const [injectStatus, setInjectStatus] = React.useState(null)
      // 有没有工作区（服务端 config 回的权威值）；无则工作区项隐藏/只读
      const [hasWorkspace, setHasWorkspace] = React.useState(Boolean(wsCwd))
      const [workspaceName, setWorkspaceName] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [loaded, setLoaded] = React.useState(false)
      const [loadError, setLoadError] = React.useState('')
      const [error, setError] = React.useState('')
      const [saved, setSaved] = React.useState('')
      const [busyKey, setBusyKey] = React.useState(null)
      /**
       * 🔴 2026-10-15 审计（报告第 7 条）：`busyKey` 是**单值**，而 `run()` 的 `finally`
       *    里**无条件** `setBusyKey(null)`。两个动作重叠时（例：拨「允许所有指令」的同时
       *    点「保存」）后一个会盖掉前一个的 key，任一个先结束就把它清成 null ⇒
       *    另一个明明还在跑，所有按钮却都解锁了（`busy = busyKey !== null` 是全局门）。
       *    改成按 key 计数的**在飞表**，对外仍暴露一个字符串：
       *      · 0 个在飞 → `null`（不忙）
       *      · 1 个在飞 → 那个 key（对应的按钮显示"保存中…"）
       *      · ≥2 个在飞 → `'*'`（不匹配任何 `busyKey === 'x'`，但 `!== null` ⇒ 全局仍算忙）
       */
      const inflightRef = React.useRef(new Map())
      const syncBusy = React.useCallback(() => {
        const keys = [...inflightRef.current.keys()]
        setBusyKey(keys.length === 0 ? null : (keys.length === 1 ? keys[0] : '*'))
      }, [])

      // 关闭函数（点遮罩 / × / Esc 共用；也供下面的订阅使用）
      const close = React.useCallback(() => {
        setSaved('')          // 关掉时把顶部"已保存"提示也清掉（组件不卸载，别留着）
        if (controlled) { if (typeof props.onClose === 'function') props.onClose() } else { setInternalOpen(false) }
      }, [controlled, props.onClose])
      // 模块级总线订阅：hero 那个 DOM 按钮没有 React 上下文，只能靠它叫醒这里。
      // 受控模式（详情页入口）不开总线，直接由父组件开关。
      // 用 ref 存最新函数，订阅只建一次，避免重复订阅/闭包过期。
      const openRef = React.useRef(null)
      openRef.current = () => { setError(''); setSaved(''); setInternalOpen(true) }
      React.useEffect(() => {
        if (controlled) return undefined
        return settingsBus.subscribe(() => { openRef.current?.() })
      }, [controlled])

      /**
       * 一次读齐三页要的东西：账户 / 配置（白名单+注入开关）/ 提示词。
       * 账户接口是**必需**的（读不到就没法用）；config 与 agents-md 单独容错，
       * 免得一个接口挂了整页空掉。
       */
      const load = React.useCallback(() => {
        setLoading(true)
        setLoadError('')
        setCfgOk(false)                       // 每次重读都先当作"没读到"，成功了再翻 true
        // 更新检查：**不依赖工作区**，也**不阻塞**其它读取 —— 第一次要真去 git fetch，
        // 网络慢的时候别把整个设置页卡在转圈上。失败就当"没有新版"。
        apiGet('/api/mc/update').then((u) => { setUpd(u ?? null) }, () => { setUpd(null) })

        return Promise.all([
          apiGet(withSid('/api/mc/accounts')).then((a) => {
            setAccounts(Array.isArray(a.accounts) ? a.accounts : [])
            setServers(Array.isArray(a.authServers) ? a.authServers : [])
            setDefaultAccount(a.defaultAccount ?? null)
          }),
          apiGet(withSid('/api/mc/config')).then((c) => {
            setCfgOk(true)                    // 🔴 报告第 2 条：这一句就是"白名单可以安全改"的凭证
            const hasWs = c.hasWorkspace === true
            setHasWorkspace(hasWs)
            setWorkspaceName(String(c.workspaceName ?? ''))
            setWlList(Array.isArray(c.commandWhitelist) ? c.commandWhitelist : [])
            setCmdCatalog(Array.isArray(c.commandCatalog) ? c.commandCatalog : [])
            setCmdExtra(Array.isArray(c.commandExtra) ? c.commandExtra : [])
            setAllowAll(c.allowAllCommands === true)
            setInjectWc(c.injectDshMcAgentAgentsMd !== false)
            setInjectWs(c.injectWorkspaceAgentsMd === true)
            // 记忆目录是**按工作区**的：没有工作区时那个接口直接 400，别去碰它。
            if (!hasWs) { setMemInfo(null); return null }
            return apiGet(withSid('/api/mc/memory')).then((m) => {
              setMemInfo(m ?? null)
            }).catch((e) => { setError(errorText(e)) })
          }).catch((e) => {
            // 🔴 报告第 2 条：这里**必须**留下"读失败"的痕迹（以前只有 setError，
            //    错误提示 3 秒后不会消失但按钮照样可点）。cfgOk=false 让
            //    「保存白名单」「保存 base」两个破坏性写入彻底走不通。
            setCfgOk(false)
            setError('配置没读出来（' + errorText(e) + '）—— 白名单 / 分享 base 先别保存，'
              + '现在保存会用空值把服务端真实配置覆盖掉。')
          }),
          apiGet(agentsMdPath).then((m) => {
            setMdText(String(m.text ?? ''))
            setMdSource(m.source === 'custom' ? 'custom' : 'default')
            setMdPath(String(m.path ?? ''))
            // 「默认提示词」那一块（基根那份 / 新会话的种子）
            setDfText(String(m.default?.text ?? ''))
            setDfInfo(m.default ?? null)
            setDfReady(m.default != null)
            setWsPath(String(m.workspacePath ?? ''))
            setWsExists(m.workspaceExists === true)
            setRulesExists(m.rulesExists !== false)
            setInjectStatus(m.injection ?? null)
            setFollowVersion(m.followVersion !== false)
            setRulesVersion(m.rulesVersion ?? null)
            setPluginVersion(String(m.pluginVersion ?? ''))
          }).catch((e) => { setError(errorText(e)) }),
        ])
          .then(() => { setLoaded(true) })
          .catch((e) => { setLoaded(false); setLoadError(errorText(e)) })
          .finally(() => { setLoading(false) })
      }, [agentsMdPath])

      React.useEffect(() => { if (open) load() }, [open, load])

      // Esc 关闭 + 打开时锁住 body 滚动（关闭/卸载都还原）
      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (e) => { if (e.key === 'Escape') close() }
        document.addEventListener('keydown', onKey)
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
          document.removeEventListener('keydown', onKey)
          document.body.style.overflow = prev
        }
      }, [open, close])

      /**
       * 顶部「已保存」提示：**3 秒后自动消失**。
       * 🔴 定时器必须在 saved 变化 / 组件卸载时清掉 —— 否则清场后 3s 到点还会去 setState。
       * （窗口关闭不卸载本组件，所以 close 里也顺手清一次 saved。）
       */
      React.useEffect(() => {
        if (!saved) return undefined
        const t = setTimeout(() => setSaved(''), 3000)
        return () => clearTimeout(t)
      }, [saved])

      /** 所有动作的统一出口：置忙 → 跑 → 刷新 → 归一化错误 */
      const run = React.useCallback((key, fn, okMsg) => {
        // 🔴 报告第 7 条：登记到在飞表（按 key 计数），结束时只减自己的那一份
        const m = inflightRef.current
        m.set(key, (m.get(key) ?? 0) + 1)
        syncBusy()
        setError('')
        setSaved('')
        return Promise.resolve()
          .then(fn)
          .then(() => {
            setSaved(okMsg || '已保存')
            return load().then(() => true)
          })
          .catch((e) => {
            setError(errorText(e))
            // 出错时也刷新——后端可能已经改了一半（例如"设为默认"成功但回读失败）
            return load().then(() => false, () => false)
          })
          .finally(() => {
            const n = (m.get(key) ?? 1) - 1
            if (n <= 0) m.delete(key); else m.set(key, n)
            syncBusy()
          })
      }, [load, syncBusy])

      const patchAccount = React.useCallback((innerID, patch, key) =>
        run(key, () => apiPatch(withSid('/api/mc/accounts'), { innerID, ...patch }), '账户已更新'), [run])

      /* 页头那个「刷新」：逐个刷（各自按类型处理），一个失败不影响其余，最后把列表读回来。
         正版账户在这条路径上**只会报缓存状态**，不会启动设备码（服务端就是这么写的）。 */
      const refreshAllAccounts = React.useCallback((list) =>
        run('acct:refreshAll', async () => {
          const bad = []
          for (const acc of list ?? []) {
            try { await apiPost(withSid('/api/mc/accounts/refresh'), { innerID: acc.innerID }) } catch (e) { bad.push(`${acc.name || acc.innerID}：${errorText(e)}`) }
          }
          if (bad.length) throw new Error(`有 ${bad.length} 个没刷成功 —— ${bad.join('；')}`)
          return { ok: true }
        }, '账户状态已刷新'), [run])

      const deleteAccount = React.useCallback((acc) =>
        run('row:' + acc.innerID + ':delete',
          () => apiDelete(withSid('/api/mc/accounts'), { innerID: acc.innerID }),
          `已删除「${acc.name}」`), [run])

      const createAccount = React.useCallback((body, key) =>
        run(key, () => apiPost(withSid('/api/mc/accounts'), body), '账户已新建'), [run])

      /* ── 正版（微软）登录：设备码流程 ────────────────────────────────────────
       * 服务端**不能**占着一次请求等用户在浏览器里点（那要十几分钟），所以 POST 起一条
       * 后台任务后立刻返回；这里只负责「起一次」和「每 2 秒问一次」。
       * ⚠️ 依赖写 `[sessionId, wsCwd]` 而不是 `[withSid]` —— `withSid` 每次渲染都是新函数，
       *    把它当依赖会让 `MicrosoftLogin` 的启动 effect 每次渲染都重跑一次（码会被反复作废）。 */
      const msaStart = React.useCallback((innerID) =>
        apiPost(withSid('/api/mc/accounts/msa'), { innerID }).then((r) => r?.job ?? null),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [sessionId, wsCwd])

      const msaPoll = React.useCallback((innerID) =>
        apiGet(withSid('/api/mc/accounts/msa?innerID=' + encodeURIComponent(innerID))).then((r) => r?.job ?? null),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [sessionId, wsCwd])

      const reloadAccounts = React.useCallback(() => load(), [load])

      const addServer = React.useCallback((body) =>
        run('server:add', () => apiPost(withSid('/api/mc/authservers'), body), '认证服务器已添加'), [run])

      // 拖放来的卡片：原样把文本交给后端解析（前端不解析、不落任何副本）。
      // ⚠️ 要把**新加的服务器**回传给调用方（「新建第三方账户」拖完要自动选中 + 填进输入框）。
      const addServerCard = React.useCallback(async (card) => {
        let created = null
        await run('server:card',
          () => apiPost(withSid('/api/mc/authservers'), { card }).then((r) => { created = r?.server ?? null; return r }),
          '已从卡片解析并添加认证服务器')
        return created
      }, [run])

      const removeServer = React.useCallback((srv) =>
        run('server:' + srv.id, () => apiDelete(withSid('/api/mc/authservers'), { id: srv.id }), `已移除「${srv.name}」`), [run])

      /* ── 页 2：白名单 ──
       * 「允许所有指令」开关**一拨就存**（用户 2026-09-16 定），失败把开关拨回去；
       * 白名单文本仍由「保存」提交（只发 commandWhitelist）。 */
      const toggleAllowAll = React.useCallback((next) => {
        const prev = allowAll === true
        const want = next === true
        if (want === prev) return Promise.resolve(true)
        setAllowAll(want)                                    // 乐观更新，拨动立刻有反应
        return run('cfg:allowAll', () => apiPatch(withSid('/api/mc/config'), { allowAllCommands: want }),
          want ? '已打开：允许所有指令' : '已关闭：只放行白名单')
          .then((ok) => { if (!ok) setAllowAll(prev); return ok })   // 失败回滚
      }, [run, allowAll])

      /**
       * 白名单改一条：拨一下就发一次 PATCH，**服务端回来的新名单/新目录直接覆盖本地 state**
       *   —— 所以"拨下去却没关掉"（还被某条正则罩着）这种事，界面自己会纠正回来。
       * 目录里有没有这条、`on` 到底是不是真，全以服务端那份为准（客户端不判）。
       */
      const applyWhitelist = React.useCallback((next, key, msg) => run(key, async () => {
        const r = await apiPatch(withSid('/api/mc/config'), { commandWhitelist: next })
        if (Array.isArray(r?.commandWhitelist)) setWlList(r.commandWhitelist)
        if (Array.isArray(r?.commandCatalog)) setCmdCatalog(r.commandCatalog)
        if (Array.isArray(r?.commandExtra)) setCmdExtra(r.commandExtra)
        return r
      }, msg), [run])

      const toggleCmd = React.useCallback((name, on) => {
        // 🔴 报告第 2 条：配置没读出来时本地名单是空的，写下去就是拿"只有这一条"覆盖真实名单。
        if (!cfgOk) {
          setError('配置没读出来，先别改白名单 —— 现在改会覆盖服务端真实配置。'
            + '先关掉再打开这个窗口重试。')
          return Promise.resolve(false)
        }
        /* 关掉时**只删同名精确条目**（`/tp` 这种带前导斜杠的算精确名），正则与 `*` 一律留着
         * —— 它们不是"这一条指令"，删了会连带影响一大片。删不掉的那种情况（还被正则罩着），
         * 服务端回来的 `on` 仍是 true，开关自己弹回去，用户看得到。 */
        const isRe = (t) => t.length > 1 && t.startsWith('/') && t.lastIndexOf('/') > 0
        const next = on
          ? (wlList.some((e) => String(e).trim().replace(/^\//, '').toLowerCase() === name) ? wlList : [...wlList, name])
          : wlList.filter((e) => {
            const t = String(e).trim()
            if (!t || t === '*' || isRe(t)) return true
            return t.replace(/^\//, '').toLowerCase() !== name
          })
        return applyWhitelist(next, `wl:cmd:${name}`, on ? `已放行 ${name}` : `已关掉 ${name}`)
      }, [applyWhitelist, wlList, cfgOk])

      const dropCmdEntry = React.useCallback((entry) => {
        if (!cfgOk) {
          setError('配置没读出来，先别改白名单 —— 现在改会覆盖服务端真实配置。')
          return Promise.resolve(false)
        }
        return applyWhitelist(wlList.filter((e) => String(e) !== String(entry)), 'wl:drop', `已删掉条目 ${entry}`)
      }, [applyWhitelist, wlList, cfgOk])

      /* ── 页 3：提示词：保存 / 恢复默认 / 两个注入开关 ──
       * 🔴 2026-10-15 审计（报告第 1 条）：这四处原来写死 `'/api/mc/agents-md'`，**只把
       *    `sessionId` 塞进 body** —— 而服务端的 `gateOf()` 是
       *    `settingsGate(query.sessionId ?? b?.sessionId, query.cwd ?? b?.cwd)`，它**认 `cwd`**。
       *    会话还没落盘时（新对话页）`sessionId` 定位不到工作区 ⇒ 服务端只能回
       *    "这个会话没有选中工作区"，用户看到的是"提示词看得到、存不进去"。
       *    同文件其它十几处设置写操作全都用了 `withSid`（把 sessionId + cwd 拼进 query），
       *    只有这四处漏了。改成和 GET（`agentsMdPath`）走同一条路。 */
      const saveAgentsMd = React.useCallback(() =>
        run('md:save', () => apiPut(withSid('/api/mc/agents-md'), { text: mdText, sessionId }), '会话提示词已保存'),
      [run, mdText, sessionId, wsCwd])

      /* 「会话提示词 → 恢复为默认」：用**基根那份**重新播种本会话（`from:'default'`）。
       * 🔴 语义（用户 2026-10-15 把这一页分成两块之后）：这里的"默认"= **上面那块**，
       *    不是插件出厂值 —— 用户在「默认提示词」里定制过之后，"恢复默认"该回到
       *    **他自己定的那个默认**。想出厂的，用上面那块自己的「恢复内置默认」。 */
      const resetAgentsMd = React.useCallback(() =>
        run('md:reset', () => apiDelete(withSid('/api/mc/agents-md'), { sessionId, from: 'default' }),
          '已按默认提示词重新播种本会话'), [run, sessionId, wsCwd])

      /* 「默认提示词」那一块（基根 / 新会话的种子）：`scope:'default'`。
       * 🔴 改它**不动本会话** —— 只影响以后新建的会话（新会话记忆根从基根播种）。
       * 🔴 服务端没重载时（`dfReady === false`）**必须硬拒**：旧服务端不认 `scope`，
       *    会把它当成会话那份写下去 —— 看着像"改默认"，其实是把**当前会话**覆盖了。 */
      const saveDefaultMd = React.useCallback(() => {
        if (!dfReady) {
          setError('服务端还没重载（要重启 DSH 或重新加载插件）—— 现在保存会写进当前会话那份，先别存。')
          return Promise.resolve(false)
        }
        return run('df:save', () => apiPut(withSid('/api/mc/agents-md'), { text: dfText, sessionId, scope: 'default' }),
          '默认提示词已保存（影响以后新建的会话）')
      }, [run, dfText, sessionId, wsCwd, dfReady, setError])

      const resetDefaultMd = React.useCallback(() => {
        if (!dfReady) {
          setError('服务端还没重载（要重启 DSH 或重新加载插件）—— 先别动这一块。')
          return Promise.resolve(false)
        }
        return run('df:reset', () => apiDelete(withSid('/api/mc/agents-md'), { sessionId, scope: 'default' }),
          '默认提示词已恢复内置那份')
      }, [run, sessionId, wsCwd, dfReady, setError])

      const toggleInjectWc = React.useCallback((next) =>
        run('cfg:wc', () => apiPatch(withSid('/api/mc/config'), { injectDshMcAgentAgentsMd: next === true }),
          next ? '已开启提示词注入' : '已关闭提示词注入'), [run])

      const toggleInjectWs = React.useCallback((next) =>
        run('cfg:ws', () => apiPatch(withSid('/api/mc/config'), { injectWorkspaceAgentsMd: next === true }),
          next ? '已开启工作区 AGENTS.md 注入' : '已关闭工作区 AGENTS.md 注入'), [run])

      /** 「随版本更新」：一拨就存；**打开时不会立刻覆盖**（只在插件版本变化时才替换） */
      const toggleFollowVersion = React.useCallback((next) => {
        const prev = followVersion
        setFollowVersion(next === true)
        return run('cfg:follow', () => apiPatch(withSid('/api/mc/config'), { rulesFollowVersion: next === true }),
          next ? '已开启：插件升级时用新版本默认提示词替换' : '已关闭：保留你自己改的内容')
          .then((ok) => { if (!ok) setFollowVersion(prev); return ok })
      }, [run, followVersion])

      /* ── 页 4：记忆 ──
       * 用户 2026-10-20：原来这页是「文件分享」（开关 / base / 获取当前 / 清除分享数据），
       * 现在**整页换成「记忆」**，分享那套一律下线 —— 这里只剩一个只读查询 + 一个"打开文件夹"。
       * 打开是服务端动作（浏览器拿不到本地路径），所以走 `POST /api/mc/memory/open`。
       * `name` 给了就在文件夹里**选中**那个文件；不给就打开目录本身。 */
      /* ── 页 5：更新 ──
       * 用户 2026-10-20：加一个更新页 —— 显示新版加了什么 + 更新按钮。
       * 「检查更新」强制刷新（`?force=1` 绕过后端 10 分钟缓存）；「立即更新」只走
       * `POST /api/mc/update/apply`（git pull --ff-only），拉不动就把 git 的原话显示出来。 */
      const updateCheck = React.useCallback(() =>
        run('update:check',
          () => apiGet('/api/mc/update?force=1')
            .then((u) => { setUpd(u ?? null); return updateBadgeRefresh(true) }),
          '检查完了'),
      [run])

      const updateApply = React.useCallback(() => {
        if (!window.confirm('把插件更新到最新版？\n\n会用 git pull --ff-only 拉取，拉完需要重启 DSH 才生效。')) {
          return Promise.resolve(false)
        }
        return run('update:apply',
          () => apiPost('/api/mc/update/apply')
            .then((r) => {
              setUpd(null)
              return updateBadgeRefresh(true).then(() => r)
            }),
          '已更新：重启 DSH 才生效')
      }, [run])

      const openMemoryLocation = React.useCallback((name) =>
        run('memory:open',
          () => apiPost(withSid('/api/mc/memory/open'), name ? { name: String(name) } : {}),
          name ? `已在文件夹里选中 ${name}` : '已打开记忆目录'),
      [run, withSid])

      if (!open) return null

      const busy = busyKey !== null
      const stop = (e) => e.stopPropagation()

      const pane = tab === 'whitelist'
        ? React.createElement(WhitelistPane, {
          catalog: cmdCatalog, extra: cmdExtra, allowAll, busyKey, cfgOk,
          onAllowAll: toggleAllowAll, onToggleCmd: toggleCmd, onDropEntry: dropCmdEntry,
        })
        : (tab === 'prompt'
          ? React.createElement(PromptPane, {
            key: 'prompt:' + mdSource + ':' + wsExists + ':' + (hasWorkspace ? 'ws' : 'nows'),
            mdText, mdSource, mdPath, wsPath, wsExists, rulesExists, injectStatus, injectWc, injectWs, busyKey,
            followVersion, rulesVersion, pluginVersion, hasWorkspace,
            // 「默认提示词」那一块（基根那份 / 新会话的种子）
            dfText, dfInfo, dfReady,
            onMdText: setMdText, onSave: saveAgentsMd, onReset: resetAgentsMd,
            onDfText: setDfText, onDfSave: saveDefaultMd, onDfReset: resetDefaultMd,
            onInjectWc: toggleInjectWc, onInjectWs: toggleInjectWs, onFollowVersion: toggleFollowVersion,
          })
          : (tab === 'memory'
            ? React.createElement(MemoryPane, {
              key: 'memory:' + (memInfo?.dir ?? '') + ':' + (memInfo?.files?.length ?? 0),
              info: memInfo, busyKey, hasWorkspace, onOpen: openMemoryLocation,
            })
            : (tab === 'update'
              ? React.createElement(UpdatePane, {
                key: 'update:' + (upd?.checkedAt ?? 0) + ':' + (upd?.behind ?? 0),
                info: upd, busyKey, onCheck: updateCheck, onApply: updateApply,
              })
            : React.createElement(AccountsPane, {
            accounts, servers, defaultAccount, busyKey,
            onPatch: patchAccount, onDelete: deleteAccount,
            onCreate: createAccount, onAddServer: addServer, onAddCard: addServerCard,
            onRemoveServer: removeServer,
            onMsaStart: msaStart, onMsaPoll: msaPoll, onReload: reloadAccounts,
            onRefreshAll: () => refreshAllAccounts(accounts),
          }))))

      // 头部显示的工作区名（仅"有工作区"时显示）：注册表 title → 回退路径尾段；default-workspace 给中文名
      const wsDisplayName = hasWorkspace
        ? (workspaceName === 'default-workspace'
            ? '默认工作区'
            : workspaceName || (wsCwd ? String(wsCwd).split(/[\\/]/).filter(Boolean).pop() : ''))
        : ''

      return React.createElement(
        'div',
        {
          'data-wc-overlay': '',
          // 叠在「连接到MC」弹窗之上时（「添加/管理」打开）→ 用更高 z-index
          ...(props?.nested ? { 'data-wc-nested': '' } : {}),
          role: 'presentation',
          onClick: close,               // 点遮罩关闭
          onMouseDown: (e) => { if (e.target === e.currentTarget) e.preventDefault() },
        },
        React.createElement(
          'div',
          {
            'data-wc-card': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'MC设置',
            onClick: stop,              // 卡片内部点击不关
            ...(busy ? { 'data-wc-busy': '' } : {}),
          },
          React.createElement(
            'div',
            { 'data-wc-head': '' },
            React.createElement(
              'div',
              { 'data-wc-titlewrap': '' },
              React.createElement(
                'div',
                { 'data-wc-titleline': '' },
                React.createElement('span', { 'data-wc-title': '' }, 'MC设置'),
                hasWorkspace
                  ? React.createElement('span', { 'data-wc-wsname': '', title: wsCwd || '' },
                    IconFolderOpenRegular ? React.createElement(IconFolderOpenRegular, { size: 16 }) : null,
                    React.createElement('span', null, wsDisplayName || '工作区'),
                  )
                  : null,
              ),
            ),
            React.createElement('span', { 'data-wc-grow': '' }),
            busy ? React.createElement('span', { 'data-wc-dim': '', style: { fontSize: '11px' } }, '处理中…') : null,
            React.createElement('button', {
              type: 'button', 'data-wc-xbtn': '', title: '关闭（Esc）', 'aria-label': '关闭',
              onClick: close,
            }, IconCloseOutlineRegular ? React.createElement(IconCloseOutlineRegular, { size: 14 }) : '×'),
          ),
          React.createElement(
            'div',
            { 'data-wc-panes': '' },
            React.createElement(
              'div',
              { 'data-wc-side': '', role: 'tablist' },
              TABS.map((t) => React.createElement('button', {
                key: t.id,
                type: 'button',
                'data-wc-tab': '',
                ...(tab === t.id ? { 'data-wc-tab-on': '' } : {}),
                role: 'tab',
                'aria-selected': tab === t.id ? 'true' : 'false',
                onClick: () => { setSaved(''); setTab(t.id) },   // 切标签页 → 顶部提示立刻消失
              }, t.label)),
            ),
            React.createElement(
              'div',
              { 'data-wc-pane': '' },
              error ? React.createElement('div', { 'data-wc-alert': '', role: 'alert' }, error) : null,
              saved ? React.createElement('div', { 'data-wc-ok': '' }, saved) : null,
              loadError ? React.createElement('div', { 'data-wc-alert': '', role: 'alert' }, `读取失败：${loadError}`) : null,
              loading && !loaded
                ? React.createElement('div', { 'data-wc-dim': '' }, '正在读取…')
                : pane,
            ),
          ),
        ),
      )
    }

    /* ==================================================================
     * apply
     * ================================================================== */
    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-mc-agent')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => { style.remove() }, 'dsh-mc-agent: status bar styles')

        // list/session 插槽：增量安全，不覆盖官方 header
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'dsh-mc-agent-status', order: 50 },
          McStatusBar,
        ))

        // 「连接到MC」入口①：标题条（order 40 → 落在「设置」45 的**左边**）。
        // 门控同「设置」（MC 模式）；**在游戏中时隐藏**（见 McConnectEntry）。
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'dsh-mc-agent-mc-connect', order: 40 },
          McConnectEntry,
        ))

        // 「MC设置」入口①：标题条（**已有会话**时才出现）。
        // 判据 = 会话记录的 agent preset ∈ mcModePresets（本地判定，见 useMcSettingsGate）。
        // order 45 < 50 → 落在状态条**左边**（官方预设标签 -10 更左）。
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'dsh-mc-agent-mc-settings', order: 45 },
          McSettingsEntry,
        ))

        // 「MC设置 / 连接到MC」入口②：**新会话页**。注册在这里的组件只当"驱动器"
        // （它自己 return null，按钮由 mountHeroButtons 按 order 插到模式芯片右边）——
        // 借这个插槽拿一个可靠的挂载时机：hero 与 composer 都渲染它，配合 blank 门控
        // 就只在**新会话页**挂载。与入口①按 blank 互斥，所以页面上任何时候只有一套入口。
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
          { name: 'conversation.input.right', id: 'dsh-mc-agent-mc-settings-hero', order: 20 },
          McSettingsDockEntry,
        ))

        // 「MC设置」入口③：**插件页 → dsh-mc-agent 详情页**头部按钮（演示，暂无功能）。
        // root 作用域、无会话 —— 组件自己按 subject 过滤，只认 dsh-mc-agent 的 bundle 页。
        ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register(
          { name: 'plugins.detail.actions', id: 'dsh-mc-agent-mc-settings-detail', order: 20 },
          McSettingsDetailEntry,
        ))

        // 只做一次性清理：摘掉历史版本用 MutationObserver 注入的按钮。
        // 🔴 不要再挂 observer / 不要再往宿主 DOM 里插任何东西（见文件头事故记录）。
        purgeLegacyInjectedButtons()
      },
    }
  },
})
