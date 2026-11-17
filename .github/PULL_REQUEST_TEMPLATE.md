## Summary

<!-- Briefly describe what this PR changes and why. -->

## Related Issue

<!-- e.g. Fixes #123 -->

## Components Touched

- [ ] Browser Extension (`extension/`)
- [ ] Rust Core / Native Host / MCP Server (`rust/`)
- [ ] Python SDK (`python/`)
- [ ] Installers / CI (`scripts/`, `.github/`)
- [ ] Documentation / Wiki (`README*`, `docs/`, `wiki/`)

## Verification & Security Checklist

- [ ] `npm test` passes (sanitization check, TypeScript check, extension unit tests, Rust workspace tests)
- [ ] `python -m unittest discover -s python/tests -v` passes
- [ ] Zero localhost TCP/WebSocket listeners introduced
- [ ] Read-Only ACL gates (`--read-only`, Global Read-Only Lock, per-tab `read` mode) preserved for any new command
- [ ] Documentation updated if user-facing tools, CLI flags, or protocol messages changed
