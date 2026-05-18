# 末世模拟器

一个参考 `moshimoniqi.pages.dev` 玩法结构重构的网页文字 Roguelike。当前版本已经移除原 LifeRestart/Laya 引擎，改为 Vite + Vue + Pinia + Vue Router。

## 当前玩法

- 首页选择末日场景，目前开放“丧尸围城”。
- 创建幸存者：起名、选择出生点、自由选择职业。
- 默认出生点参考 Build 41：穆德劳、河畔镇、罗斯伍德、西点。
- 职业和特性按 Project Zomboid Build 41 风格整理。
- 特殊姓名可触发隐藏职业，例如“黑哥 / 刘太荣”和“师一钒 / 师哥”。
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

`public/pz-traits/` 支持本地私有特性图标，PNG 文件已被 `.gitignore` 忽略，不会上传到 GitHub。
