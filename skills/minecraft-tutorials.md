---
name: minecraft-tutorials
description: Minecraft 玩法知识库：常见任务该怎么做（起步/矿道/农场/刷怪/附魔/下界/末地），以及**用本插件的工具怎么做**（玩家操作 ↔ mc_* 工具映射）。不知道怎么完成某个 MC 任务、或不确定该用哪个工具时先加载本技能。
whenToUse: 查 MC 原版玩法、规划一条任务线、或者不确定"这件事该用哪个工具"时
---
# Minecraft 玩法知识库（minecraft-tutorials）

本技能把「原版 MC 教程」和「本插件的工具」对起来：**玩家会怎么做 → agent 该调什么**。

## 0. 知识库位置

- 知识库根：`{{KB_ROOT}}`（插件挂载时替换成实际绝对路径，可直接 read/glob/grep）

## 1. 目录

```
kb/
├── agent-mapping.md        ★ 先读这个：玩家操作 ↔ 工具映射（含常见坑）
├── tutorials/               15 篇
│   ├── 起步.md              第一天：木头→工作台→木镐→石镐→铁镐
│   ├── 矿道.md              挖矿路线、矿洞照明、岩浆规避
│   ├── 农场.md              小麦田/动物圈/繁殖/剪羊毛/挤奶
│   ├── 刷怪塔.md            刷怪条件与简单塔
│   ├── 附魔.md              附魔台/书架/青金石/等级
│   ├── 下界.md              传送门、烈焰棒、末影珍珠
│   ├── 末地.md              末地门、末影龙、返回
│   ├── 庇护所.md            选址/类型/尺寸（对应 Tutorial:Shelters）
│   ├── 家具.md              用方块拼家具（Tutorial:Furniture）
│   ├── 屋顶类型.md          平顶/双坡/四坡/尖顶（Tutorial:Roof_types）
│   ├── 屋顶建造指南.md      坡度公式/施工顺序（Tutorial:Roof_construction_guidelines）
│   ├── 建筑美化.md          配色/层次/细节（Tutorial:Adding_beauty_to_constructions）
│   ├── 主线流程.md          完整主线顺序（Tutorial:Complete_main_adventure）
│   ├── 原地长期生存.md      不跑远路的可持续循环（Tutorial:Surviving_in_a_single_area…）
│   └── 无聊时做什么.md      建设/收藏/探索/挑战（Tutorial:Things_to_do_when_bored）
└── meta/
    └── topics.md          按场景的主题导航
```

## 2. 使用流程

1. **先查映射**：读 `kb/agent-mapping.md` —— 大多数"怎么做"在里面能直接找到对应工具。
2. **再看教程**：`kb/tutorials/*.md` 是玩法摘要（不是 wiki 全文），讲"顺序和要点"。
3. **真不确定**：`kb/meta/topics.md` 按场景列了该读哪篇。

## 3. 两条原则

- **工具优先**：能用一个 `mc_*` 工具解决的，别拆成十几个原语（原语是手动方向盘，默认还是折叠的）。
- **长活进队列**：合成链、挖一片、跑一趟 —— 交给 `mc_craft` / `mc_collect` / `mc_navi`，它们在队列里自己排步骤；你只看报告。
