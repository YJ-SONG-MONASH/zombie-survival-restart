# 末世模拟器

一个参考 `moshimoniqi.pages.dev` 玩法结构重构的网页文字 Roguelike。当前版本已经移除原 LifeRestart/Laya 引擎，改为 Vite + Vue + Pinia + Vue Router。

## 当前玩法

- 首页选择末日场景，目前开放“丧尸围城”。
- 开场重生剧情。
- 选择前世身份。
- 选择避难所并采购物资。
- 进入每日生存循环，管理生命、理智、背包和隐藏状态。
- 行动可以选择预设方案，也可以自由输入。
- 活过 20 天等待撤离，或因生命/理智归零进入结局。
- 结局可保存到本地末世档案馆。

## 本地运行

```bash
pnpm install
pnpm dev
```

## 构建

```bash
pnpm build
```

构建产物输出到 `template/public`，GitHub Pages 工作流会自动发布。

## 说明

当前版本默认使用本地规则引擎，不需要后端。首页保留了自定义 API 设置入口，后续可以接入 OpenAI-compatible/DeepSeek 等模型，让每日叙事和行动判定改为 LLM 生成。
