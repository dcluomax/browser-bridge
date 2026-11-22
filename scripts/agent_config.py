"""Surgical, opt-in Browser Bridge MCP configuration updates."""

from __future__ import annotations

import copy
import json
import re
import tomllib
from pathlib import Path


class ConfigError(ValueError):
    pass


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ConfigError(f"The MCP configuration contains a duplicate JSON field: {key}")
        value[key] = item
    return value


def mcp_arguments(
    existing: list[str] | None, read_only: bool | None, allow_evaluate: bool | None
) -> list[str]:
    if existing is None:
        args = ["mcp", "--read-only"]
    else:
        if not isinstance(existing, list) or not all(isinstance(arg, str) for arg in existing):
            raise ConfigError("The existing Browser Bridge MCP args must be an array of strings.")
        if not existing or existing[0] != "mcp":
            raise ConfigError("The existing browser-bridge entry does not run the MCP server.")
        args = existing.copy()
    for flag, value in (("--read-only", read_only), ("--allow-evaluate", allow_evaluate)):
        if value is not None:
            args = [arg for arg in args if arg != flag]
            if value:
                args.append(flag)
    return args


def _check_existing(entry: dict) -> None:
    if not isinstance(entry, dict):
        raise ConfigError("The existing browser-bridge entry must be an object.")
    if "url" in entry or entry.get("type") not in (None, "local", "stdio"):
        raise ConfigError("Refusing to replace an existing remote browser-bridge server.")
    command = entry.get("command")
    if command is not None:
        if not isinstance(command, str):
            raise ConfigError("The existing Browser Bridge command must be a string.")
        basename = command.replace("\\", "/").rsplit("/", 1)[-1].lower()
        if basename not in ("browserbridge", "browserbridge.exe"):
            raise ConfigError("Refusing to replace a browser-bridge entry owned by another command.")


def merge_json_config(
    original: bytes | None,
    target: str,
    executable: Path,
    read_only: bool | None = None,
    allow_evaluate: bool | None = None,
) -> bytes:
    try:
        value = json.loads(original.decode("utf-8-sig"), object_pairs_hook=_unique_object) if original is not None else {}
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ConfigError(f"The {target} MCP configuration is not valid JSON.") from error
    if not isinstance(value, dict):
        raise ConfigError(f"The {target} MCP configuration must be an object.")
    result = copy.deepcopy(value)
    servers = result.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        raise ConfigError("mcpServers must be an object.")
    old = servers.get("browser-bridge")
    if old is not None:
        _check_existing(old)
    entry = copy.deepcopy(old) if old is not None else {}
    entry["command"] = str(executable)
    entry["args"] = mcp_arguments(old.get("args") if old is not None else None, read_only, allow_evaluate)
    if old is None:
        entry["type"] = "local" if target == "copilot" else "stdio"
        if target == "copilot":
            entry["tools"] = ["*"]
    servers["browser-bridge"] = entry
    return (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


_TABLE = re.compile(
    r"""^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:browser-bridge|"browser-bridge"|'browser-bridge')[ \t]*\][ \t]*(?:#.*)?(?:\r?\n)?$"""
)
_HEADER = re.compile(r"^[ \t]*\[[^\r\n]*\][ \t]*(?:#.*)?(?:\r?\n)?$")


def _replace_assignment(block: list[str], key: str, replacement: str) -> list[str]:
    pattern = re.compile(rf"""^[ \t]*(?:{key}|"{key}"|'{key}')[ \t]*=""")
    matches = [index for index, line in enumerate(block) if pattern.match(line)]
    if len(matches) > 1:
        raise ConfigError(f"The Browser Bridge TOML table contains duplicate {key} fields.")
    if not matches:
        return [*block, replacement + "\n"]
    start = matches[0]
    # Parse the complete assignment so a multiline array/string cannot leave stale fragments.
    for end in range(start + 1, len(block) + 1):
        try:
            statement = tomllib.loads("".join(block[start:end]))
        except tomllib.TOMLDecodeError:
            continue
        if set(statement) == {key}:
            return [*block[:start], replacement + "\n", *block[end:]]
    raise ConfigError(f"Cannot safely edit the Browser Bridge TOML {key} assignment.")


def merge_codex_config(
    original: bytes | None,
    executable: Path,
    read_only: bool | None = None,
    allow_evaluate: bool | None = None,
) -> bytes:
    try:
        text = original.decode("utf-8") if original is not None else ""
        value = tomllib.loads(text)
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise ConfigError("The Codex configuration is not valid TOML.") from error
    servers = value.get("mcp_servers", {})
    if not isinstance(servers, dict):
        raise ConfigError("mcp_servers must be a table.")
    old = servers.get("browser-bridge")
    if old is not None:
        _check_existing(old)
    args = mcp_arguments(old.get("args") if old is not None else None, read_only, allow_evaluate)
    command_line = "command = " + json.dumps(str(executable), ensure_ascii=False)
    args_line = "args = " + json.dumps(args, ensure_ascii=False)
    lines = text.splitlines(keepends=True)
    matches = [index for index, line in enumerate(lines) if _TABLE.match(line)]
    if len(matches) > 1:
        raise ConfigError("The Codex configuration repeats the Browser Bridge table.")
    if old is not None and not matches:
        raise ConfigError("Use a [mcp_servers.browser-bridge] table before updating an inline/dotted entry.")
    if not matches:
        prefix = text + ("\n" if text and not text.endswith("\n") else "")
        updated = prefix + "\n[mcp_servers.browser-bridge]\n" + command_line + "\n" + args_line + "\n"
    else:
        start = matches[0]
        end = next((index for index in range(start + 1, len(lines)) if _HEADER.match(lines[index])), len(lines))
        block = lines[start + 1:end]
        if block and not block[-1].endswith("\n"):
            block[-1] += "\n"
        block = _replace_assignment(block, "command", command_line)
        block = _replace_assignment(block, "args", args_line)
        updated = "".join([*lines[:start + 1], *block, *lines[end:]])
    try:
        parsed = tomllib.loads(updated)
    except tomllib.TOMLDecodeError as error:
        raise ConfigError("The proposed Codex configuration is not valid TOML.") from error
    expected = copy.deepcopy(value)
    target = expected.setdefault("mcp_servers", {}).setdefault("browser-bridge", {})
    target["command"], target["args"] = str(executable), args
    if parsed != expected:
        raise ConfigError("The Codex edit would change fields outside the managed command and args.")
    return updated.encode("utf-8")
