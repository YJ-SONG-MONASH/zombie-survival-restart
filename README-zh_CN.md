# 僵尸毁灭工程模拟器

这是基于 [VickScarlet/lifeRestart](https://github.com/VickScarlet/lifeRestart) 的 MIT 许可证二创项目。原项目的引擎、数据表结构和 LayaAir UI 流程会被保留并逐步改造成丧尸末世文字生存模拟器。

## 当前目标

- 把“人生重开”的天赋、属性、年龄事件改造成“幸存者特质、初始能力、逐日生存事件”。
- 首版先保证离线可玩，不依赖后端或 LLM。
- 后续再加入感染、饥饿、口渴、疲劳、背包、避难所和尸潮压力。

## 开发计划

详细计划见 [docs/zombie_derivative_plan.md](docs/zombie_derivative_plan.md)。

## 使用

```bash
pnpm install
pnpm xlsx2json
pnpm dev
```

启动完成后打开浏览器访问 [http://localhost:5173](http://localhost:5173)。

## 部署

本仓库已配置 GitHub Pages 自动部署。推送到 `main` 后，GitHub Actions 会执行：

```bash
pnpm install --frozen-lockfile
pnpm xlsx2json
pnpm build
```

构建产物位于 `template/public`，随后发布到 GitHub Pages。

## 许可证

本项目保留原仓库的 MIT License。二创发布时必须保留 `LICENSE` 中的原版权和许可声明。
