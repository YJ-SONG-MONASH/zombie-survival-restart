# 重构记录

## 已删除

- LifeRestart xlsx 数据表。
- LayaAir 运行库、UI 资源、设计稿和旧 `src` 引擎。
- Docker/repl 等旧项目入口。

## 新结构

- `src/data/zombie.js`：场景、默认出生点、职业、Project Zomboid 风格特性、避难所、物资、事件池。
- `src/stores/game.js`：姓名、出生点、职业、生命、理智、特性点数、背包、隐藏标签、生存日志、结局档案。
- `src/services/engine.js`：本地判定和结局生成规则。
- `src/views/*`：首页、角色创建、特性、市场、生存、结局页面。
- `public/pz-traits/`：本地私有特性图标目录；PNG 已被 `.gitignore` 忽略，不会上传到 GitHub。

## 下一阶段

- 接入真正的 OpenAI-compatible 流式叙事。
- 增加特殊剧情模式。
- 加入公开档案馆后端，可选 Cloudflare Workers + D1/KV。
