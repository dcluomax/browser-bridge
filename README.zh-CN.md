<div align="center">

<img src="docs/assets/hero-banner.svg" alt="Browser Bridge — 面向本地 AI Agent 与 Python 脚本的零端口浏览器桥接器" width="100%" />

<br />

[![CI](https://github.com/dcluomax/browser-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/dcluomax/browser-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-2563eb.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/Rust-1.85%2B-0f172a?logo=rust)](rust/Cargo.toml)
[![Python](https://img.shields.io/badge/Python-3.10%2B%20(零依赖)-0f172a?logo=python)](python/README.md)

**[English](README.md)** · **简体中文** · **[完整使用指南](docs/USAGE.md)** · **[核心特性详解](docs/FEATURES.md)** · **[MCP 客户端配置](docs/MCP_CLIENTS.md)** · **[Python SDK](python/README.md)** · **[GitHub Wiki](https://github.com/dcluomax/browser-bridge/wiki)**

</div>

---

**Browser Bridge** 让本地 AI 编程助手（GitHub Copilot、Claude Desktop / Claude Code、Cursor、Windsurf、Cline 等任意 MCP 客户端）以及本地 Python 脚本，能够安全地在你**自己已经打开并登录的 Edge、Chrome、Brave 或 Firefox 标签页**中读取与操作页面。

与 Playwright / Selenium 等无头浏览器驱动或云端容器浏览器不同，Browser Bridge **不会启动隔离的空白浏览器、不会导出任何 Cookie、不开放任何 TCP 或 WebSocket 端口**。你只需一键分享目标标签页，即可直接复用现有的企业 SSO、登录态与浏览器插件，其余私人标签页对 AI 完全不可见。

---

## 60 秒开箱即用（快速上手）

<p align="center">
  <img src="docs/assets/onboarding-flow.svg" alt="Browser Bridge 四步快速上手流程：一键安装、加载扩展、分享标签页、调用 AI Agent" width="100%" />
</p>

### 环境要求

- **Rust** `1.85+`（`rustup`）
- **Node.js** `20+`（`npm`）
- *（可选）* **Python** `3.10+`（用于本地零依赖 Python SDK）

### 第一步：一行命令编译、安装并自动注册 MCP

**Windows (PowerShell)：**

```powershell
git clone https://github.com/dcluomax/browser-bridge.git
cd browser-bridge
.\scripts\install.ps1 -RegisterAllMcp -InstallPythonSdk
```

**macOS / Linux：**

```bash
git clone https://github.com/dcluomax/browser-bridge.git
cd browser-bridge
./scripts/install.sh --register-all --install-python
```

> 只需注册单个客户端时，可传入 `-RegisterCopilotMcp`、`-RegisterClaudeMcp` 或 `-RegisterCursorMcp`（macOS/Linux 对应 `--register-copilot`、`--register-claude`、`--register-cursor`）。附加 `-ReadOnlyMcp` / `--read-only` 可开启主机级强制只读模式。

### 第二步：在浏览器加载扩展（每个浏览器配置仅需一次）

安装脚本会将构建产物复制到稳定的用户级目录，后续更新代码或重新编译不会影响正在运行的浏览器：

| 浏览器 | 加载路径 | 选择目录 / 文件 |
| --- | --- | --- |
| **Microsoft Edge** | 打开 `edge://extensions` → 开启**开发人员模式** → **加载解压缩的扩展** | Windows: `%LOCALAPPDATA%\BrowserBridge\extension\chromium`<br>macOS/Linux: `~/.browser-bridge/extension/chromium` |
| **Chrome / Brave** | 打开 `chrome://extensions` → 开启**开发者模式** → **加载已解压的扩展程序** | Windows: `%LOCALAPPDATA%\BrowserBridge\extension\chromium`<br>macOS/Linux: `~/.browser-bridge/extension/chromium` |
| **Mozilla Firefox** | 打开 `about:debugging#/runtime/this-firefox` → **临时载入附加组件** | Windows: `%LOCALAPPDATA%\BrowserBridge\extension\firefox\manifest.json`<br>macOS/Linux: `~/.browser-bridge/extension/firefox/manifest.json` |

运行状态自检命令确认连接：

```bash
# Windows
"%LOCALAPPDATA%\BrowserBridge\app\BrowserBridge.exe" status

# macOS / Linux
~/.browser-bridge/app/BrowserBridge status
```

连接成功后，浏览器工具栏中的 Browser Bridge 图标会亮起**绿色圆点**。

### 第三步：一键分享标签页并交给 AI

1. 在目标网页点击工具栏 **Browser Bridge** 图标（或在网页空白处**右键 → Browser Bridge**）。
2. 选择 **`只读分享 (Read-Only)`**（仅允许读取快照与后台截图）或 **`读写分享 (Read-Write)`**（允许点击、填表与交互）。
3. 点击 **复制提示词 (Copy Prompt)** 粘贴给任意 AI 助手，或直接在对话中让 MCP Agent 读取当前已分享的标签页。

---

## 零端口本地架构与安全边界

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Browser Bridge 零端口本地 IPC 架构与四层安全边界图" width="100%" />
</p>

- **零网络暴露**：仅通过当前系统用户专属的 Windows Named Pipe（`CurrentUserOnly` DACL）或 `0700`/`0600` Unix Domain Socket 通信，网页脚本与局域网无法探测或连接。
- **三层读写权限锁**：支持 MCP 启动级 `--read-only`、扩展弹窗全局只读总开关、以及单标签页 `Read-Only` / `Read-Write` 细粒度授权。
- **会话独占租约**：同一时刻每个标签页最多由一个 Agent 会话控制，断开即自动释放；密码框值、Bearer Token、JWT 与 Cookie 请求头自动脱敏为 `[REDACTED]`。
- **人机协同交接**：遇到登录、MFA 双重验证或 CAPTCHA 时不绕过、不伪造指纹，直接交还用户在原标签页完成验证。

---

## 扩展弹窗界面与自适应站点记忆

<p align="center">
  <img src="docs/assets/popup-showcase.svg" alt="Browser Bridge 扩展弹窗主界面与安全权限设置面板示意图" width="100%" />
</p>

<p align="center">
  <img src="docs/assets/site-memory-flow.svg" alt="自适应错误驱动学习引擎 SiteLearner、可复用多步 Routine 与原生 WebMCP 流程图" width="100%" />
</p>

- **错误驱动站点学习 (`SiteLearner`)**：首次访问遇到长连接统计脚本阻塞 `onload`、SPA 水合重渲染、遮罩弹窗阻挡点击或 `403` WAF 拦截时，自动学习最优等待策略（`domcontentloaded`）、水合等待时间、弹窗恢复动作三元组及浏览器会话 `smart_fetch`，二次访问毫秒级直达。
- **可执行站点例程 (`Site Memory Routines`)**：内置 `app.diagrams.net` 图表读写例程，支持通过 `browser_routine_save` 沉淀任意网站的高频多步工作流，一次调用完成复杂交互。
- **原生 W3C WebMCP 支持**：跨浏览器自动发现并调用网页通过 `document.modelContext` 注册的工具与声明式 `<form toolname="...">` 表单工具。
- **零依赖 Python SDK**：直接连接本地管道（中位延迟 `~1.1 ms`），提供类 Playwright 链式定位器、后台无焦点全页截图与双上下文 HTTP 请求。

---

## 文档导航

- **[完整使用手册 (docs/USAGE.md)](docs/USAGE.md)**
- **[功能与 26 个 MCP 工具详解 (docs/FEATURES.md)](docs/FEATURES.md)**
- **[MCP 客户端一键配置大全 (docs/MCP_CLIENTS.md)](docs/MCP_CLIENTS.md)**
- **[安全与隐私白皮书 (docs/SECURITY_MODEL.md)](docs/SECURITY_MODEL.md)**
- **[跨语言 IPC 协议规范 (docs/IPC_PROTOCOL.md)](docs/IPC_PROTOCOL.md)**
- **[Python SDK 指南 (python/README.md)](python/README.md)**
- **[贡献指南 (CONTRIBUTING.md)](CONTRIBUTING.md)** · **[安全策略 (SECURITY.md)](SECURITY.md)**

---

## 开源许可

本项目基于 **[MIT License](LICENSE)** 开源 · Copyright © [dcluomax](https://github.com/dcluomax)。
