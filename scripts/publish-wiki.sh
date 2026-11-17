#!/usr/bin/env bash
set -euo pipefail

# Publishes all pages under wiki/ to https://github.com/dcluomax/browser-bridge.wiki.git.
# Note: Click "Wiki -> Create the first page -> Save Page" once on GitHub Web UI first
# so GitHub provisions the backing .wiki.git repository.

WIKI_REMOTE="${1:-https://github.com/dcluomax/browser-bridge.wiki.git}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP_WIKI="$(mktemp -d)"
trap 'rm -rf "${TMP_WIKI}"' EXIT

if ! git ls-remote "${WIKI_REMOTE}" >/dev/null 2>&1; then
  echo "GitHub Wiki git endpoint is not provisioned yet." >&2
  echo "Visit https://github.com/dcluomax/browser-bridge/wiki, click 'Create the first page' -> 'Save Page' once, then re-run this script." >&2
  exit 1
fi

cp -R "${REPO}/wiki/." "${TMP_WIKI}/"
cd "${TMP_WIKI}"
git init -b master >/dev/null
git config user.name "dcluomax"
git config user.email "1477354+dcluomax@users.noreply.github.com"
git config commit.gpgsign false
git add -A
GIT_AUTHOR_NAME="dcluomax" \
GIT_AUTHOR_EMAIL="1477354+dcluomax@users.noreply.github.com" \
GIT_COMMITTER_NAME="dcluomax" \
GIT_COMMITTER_EMAIL="1477354+dcluomax@users.noreply.github.com" \
  git commit -m "Publish Browser Bridge v0.7.0 Wiki documentation"
git remote add origin "${WIKI_REMOTE}"
git push --force origin master
echo "Published all Wiki pages to https://github.com/dcluomax/browser-bridge/wiki"
