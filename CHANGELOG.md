# Changelog

All notable changes to **Browser Bridge** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-11-16

### Added
- **Adaptive Error-Driven Site Learning (`SiteLearner` & `SiteAccessProfile`):** Automatically learns per-domain `preferredWaitUntil="domcontentloaded"` from stalled `onload` beacons, SPA `hydrationSettleMs`, overlay blocker recovery triads (`Error -> Recovery -> Retry Success`), CDP fallback preferences, and `directHttpBlocked` (`403` WAF) routing.
- **Executable Site Memory & Multi-Step Routines Engine:** Local domain playbooks (`browser_routine_list`, `browser_routine_run`, `browser_routine_save`) with built-in `app.diagrams.net` XML read/write/shape routines and CLI inspection (`BrowserBridge routines`).
- **Native W3C WebMCP Integration (`browser_webmcp_list` & `browser_webmcp_call`):** Discovers and invokes page-registered `document.modelContext` / `navigator.modelContext` imperative tools and declarative `<form toolname="...">` tools across Edge, Chrome, and Firefox.
- **Three-Layer Read-Only / Read-Write ACLs:** Enforces read-only safety via `BrowserBridge mcp --read-only` (`BROWSER_BRIDGE_READ_ONLY=1`), Popup Global Read-Only Lock, and per-tab `[read-only]` / `[read-write]` mode toggles.
- **Rich Snapshot & Interaction Additions:** Interactive SVG diagram canvas shapes (`role="shape"`), native pointer/HTML5 drag-and-drop (`browser_drag`), chunked file uploads (`browser_upload_file`), JavaScript dialog handling (`browser_handle_dialog`), right-click context menu tab sharing, 1-line `Copy Agent Prompt`, and 4-locale UI (`en`, `zh_CN`, `zh_TW`, `ja`).
- **Standalone Rust Architecture & Direct IPC Python SDK:** ~1.5 MB zero-dependency Rust host/MCP binary communicating over `CurrentUserOnly` Windows Named Pipes and `0700`/`0600` Unix Domain Sockets (`~1.1 ms` median Python SDK RTT, `browser.smart_fetch` adaptive WAF fallback, background full-page/element screenshots).
