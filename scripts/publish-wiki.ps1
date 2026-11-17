<#
.SYNOPSIS
  Publishes all pages under wiki\ to https://github.com/dcluomax/browser-bridge.wiki.git.
  Note: GitHub requires clicking "Wiki -> Create the first page -> Save Page" once in the
  repository web UI to provision the backing .wiki.git repository before git push is accepted.
#>
[CmdletBinding()]
param(
    [string]$WikiRemote = 'https://github.com/dcluomax/browser-bridge.wiki.git'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$wikiSrc = Join-Path $repo 'wiki'
$tmpWiki = Join-Path ([System.IO.Path]::GetTempPath()) "bb-wiki-publish-$PID"

git ls-remote $WikiRemote | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "GitHub Wiki git endpoint is not provisioned yet. Visit https://github.com/dcluomax/browser-bridge/wiki, click 'Create the first page' -> 'Save Page' once, then re-run this script (or trigger the 'Sync Wiki' GitHub Action)."
}

New-Item -ItemType Directory -Path $tmpWiki -Force | Out-Null
try {
    Copy-Item -Path (Join-Path $wikiSrc '*') -Destination $tmpWiki -Recurse -Force
    Push-Location $tmpWiki
    try {
        git init -b master | Out-Null
        git config user.name 'dcluomax'
        git config user.email '1477354+dcluomax@users.noreply.github.com'
        git config commit.gpgsign false
        git add -A
        $env:GIT_AUTHOR_NAME = 'dcluomax'
        $env:GIT_AUTHOR_EMAIL = '1477354+dcluomax@users.noreply.github.com'
        $env:GIT_COMMITTER_NAME = 'dcluomax'
        $env:GIT_COMMITTER_EMAIL = '1477354+dcluomax@users.noreply.github.com'
        git commit -m 'Publish Browser Bridge v0.7.0 Wiki documentation' | Out-Host
        git remote add origin $WikiRemote
        git push --force origin master | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'Wiki push failed.' }
    } finally {
        Pop-Location
    }
    Write-Host 'Published all Wiki pages to https://github.com/dcluomax/browser-bridge/wiki' -ForegroundColor Green
} finally {
    Remove-Item -LiteralPath $tmpWiki -Recurse -Force -ErrorAction SilentlyContinue
}
