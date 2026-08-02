# mjloop

> 面向 Claude Code 的可验证开发循环。

[![Claude Code 插件](https://img.shields.io/badge/Claude_Code-plugin-6B5CE7?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](README.md) · [العربية](README.ar.md) · **简体中文** · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md)

**让编程代理证明它们真的完成了工作。**

`mjloop` 是一个 Claude Code 插件，它把代理工作变成有边界、由证据支持的循环。
负责人为任务选择合适的代理，让它们在隔离上下文中运行，并且只有在引擎记录了
项目自身验证命令的结果后才接受成功。

`请求 → 工作轨道 → 隔离代理 → 引擎验证 → 有证据的结果`

> [!IMPORTANT]
> `mjloop` 目前支持 Claude Code。其他编程代理的适配器尚未包含在已发布插件中。

## 为什么选择 mjloop？

- **证据，而非自信** — 成功声明无法覆盖失败或缺失的引擎凭据。
- **代理无法改写的状态** — 运行状态和派生清单由 MCP 服务器管理。
- **有边界的自主运行** — 循环上限、停滞和重复错误防护会停止无进展的工作。
- **每类任务都有合适流程** — 短编辑、多循环构建、先复现再修复，或经审查的规划。

## 快速开始

你需要 Claude Code、Node.js 20 或更高版本，以及 Git。

```bash
git clone https://github.com/MohdAljahdali/mjloop.git
cd mjloop/engine
npm install
npm run build
cd ..
claude plugin marketplace add "$PWD"
claude plugin install mjloop@mjloop
```

然后在一个项目中打开 Claude Code 并运行：

```text
/mjloop:init
/mjloop:edit 为注册表单添加输入验证
```

> [!NOTE]
> 新克隆的仓库必须先构建一次，因为 MCP 服务器和钩子 CLI 从 `engine/dist/`
> 运行。验证、更新和故障排除请参阅[完整安装指南](docs/install.md)。

## 选择合适的工作轨道

| 命令 | 最适合 | 内置规则 |
|---|---|---|
| `/mjloop:edit <请求>` | 小而明确的更改 | 只运行一轮；范围扩大时升级处理 |
| `/mjloop:build <目标>` | 功能和较大实现 | 重复验证循环，直到完成或停止 |
| `/mjloop:fix <问题>` | 缺陷和回归 | 接受修复前必须先复现故障 |
| `/mjloop:plan <想法>` | 把想法变成可构建故事 | 创建故事前进行适配检查和批准 |

使用 `/mjloop:status` 查看当前运行，`/mjloop:resume` 继续中断的运行，
`/mjloop:stop` 停止运行，`/mjloop:web` 打开浏览器控制台。

## 一个循环中会发生什么？

1. 负责人从所选轨道组建代理名单，并记录每个可选专家被纳入或省略的原因。
2. 受契约约束的代理在隔离上下文中承担明确职责。
3. 引擎运行启动时固定的验证命令，并将完整日志保存在代理叙述之外。
4. 失败的验证会成为下一循环的输入；通过凭据可以结束运行。
5. 达到上限、停滞或重复同一失败时，安全防护会停止循环。

## 不只是执行

- **功能发现** — `mjloop-feature-discovery` 技能每次只询问一个决策，并停在可由
  人员批准的简报处。
- **项目感知路由** — 已接受的组件映射和技能指导固定角色，而不会改写进行中的运行。
- **浏览器控制台** — 通过 `/mjloop:web` 查看运行、计划、故事、证据、配置和记忆。
- **可扩展轨道** — 使用 `/mjloop:add` 添加代理、技能或轨道。

> [!TIP]
> 从一个真实且范围明确的 `/mjloop:edit` 开始。这是体验验证契约最快的方式，
> 无需承担多循环运行的成本。

## 继续阅读

- [mjloop 为何存在](docs/about.md)
- [安装与故障排除](docs/install.md)
- [命令、配置与工作流](docs/usage.md)
- [阿拉伯语文档](docs/about.ar.md)

如果 `mjloop` 解决了你熟悉的问题，欢迎为仓库加星，让更多开发者找到它。
