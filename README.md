# Zombie Survival Restart

This is a derivative project based on [VickScarlet/lifeRestart](https://github.com/VickScarlet/lifeRestart), licensed under MIT.

The goal is to turn the original life-simulation loop into an offline zombie-apocalypse survival simulator with survivor traits, daily events, resource pressure, infection risk, and survival endings.

## Development Plan

See [docs/zombie_derivative_plan.md](docs/zombie_derivative_plan.md).

## Usage

```bash
pnpm install
pnpm xlsx2json
pnpm dev
```

Then open [http://localhost:5173](http://localhost:5173).

## Deployment

This repository is configured for GitHub Pages. Each push to `main` runs:

```bash
pnpm install --frozen-lockfile
pnpm xlsx2json
pnpm build
```

The built site is published from `template/public`.

## License

This project keeps the original MIT license and copyright notice.
