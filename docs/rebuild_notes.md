# 重构记录

## 已删除

- LifeRestart xlsx 数据表。
- LayaAir 运行库、UI 资源、设计稿和旧 `src` 引擎。
- Docker/repl 等旧项目入口。

## 新结构

- `src/data/zombie.js`：场景、默认出生点、职业、Project Zomboid 风格特性、避难所品质概率、物资、事件池。
- `src/stores/game.js`：姓名、出生点、职业、生命、理智、特性点数、三次避难所抽样、背包、隐藏标签、生存日志、结局档案。
- `src/services/engine.js`：本地判定和结局生成规则。
- `src/views/*`：首页、角色创建、特性、市场、生存、结局页面。
- `public/pz-traits/`：本地私有特性图标目录；PNG 已被 `.gitignore` 忽略，不会上传到 GitHub。
- `public/pz-occupations/`：本地私有职业图标目录；PNG 已被 `.gitignore` 忽略，不会上传到 GitHub。

## 2026-08 生存系统 v2

- 新增 `src/services/survival.js`，把小时制、天气、水电、噪声、尸群压力、战斗和伤口进展放在可测试的纯规则层。
- `src/stores/game.js` 增加 `saveVersion = 2`、旧档正规化、终局状态机、主动使用/装备、制作、发电机和据点状态。
- 地图行动不再固定推进一天；枪械、近战、潜行、觅食、睡眠和加固拥有不同耗时与后果。
- 地点搜刮采用暂存后原子结算，修复刷新复制物资问题。
- 第 20–25 天必须抵达指定撤离节点；生命归零、Knox 感染或错过窗口都会产生对应结局。
- 新增 Vitest 与 Pages 发布前测试门。详细规则见 `docs/survival_systems_v2.md`。

## 后续阶段

- 接入真正的 OpenAI-compatible 流式叙事。
- 增加技能经验、随身/车辆/据点分仓、武器耐久和食物腐败。
- 增加 NPC 关系、交易、小队和特殊剧情模式。
- 加入公开档案馆后端，可选 Cloudflare Workers + D1/KV。
