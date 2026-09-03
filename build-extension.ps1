# 从 gemini-img-command.user.js 构建 Chrome/Edge 扩展的 content.js
# 用法：在项目根目录运行  powershell -ExecutionPolicy Bypass -File build-extension.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$utf8 = [System.Text.UTF8Encoding]::new($false)

$userJsPath   = Join-Path $root 'gemini-img-command.user.js'
$shimPath     = Join-Path $root 'extension\gm-shim.js'
$contentPath  = Join-Path $root 'extension\content.js'
$manifestPath = Join-Path $root 'extension\manifest.json'

if (-not (Test-Path $userJsPath)) { Write-Error "找不到 $userJsPath"; exit 1 }

$userJs = [System.IO.File]::ReadAllText($userJsPath, $utf8)
$shim   = [System.IO.File]::ReadAllText($shimPath, $utf8)

# 去掉 ==UserScript== … ==/UserScript== 头部
$body = [System.Text.RegularExpressions.Regex]::Replace(
  $userJs, '(?s)// ==UserScript==.*?// ==/UserScript==\s*', '')

# 从头部提取版本号
$verMatch = [System.Text.RegularExpressions.Regex]::Match($userJs, '// @version\s+(\S+)')
$ver = if ($verMatch.Success) { $verMatch.Groups[1].Value } else { '0.0.0' }

# 同步版本号到 gm-shim.js 的 GM_info（避免诊断面板显示版本读取失败）
$shim = [System.Text.RegularExpressions.Regex]::Replace(
  $shim, "version: '[^']*'", "version: '$ver'")

# 拼接：GM shim + 脚本正文
$content = $shim + "`n" + $body
[System.IO.File]::WriteAllText($contentPath, $content, $utf8)
Write-Host "content.js generated (v$ver)" -ForegroundColor Green

# 同步版本号到 gm-shim.js 文件本身（保持源文件一致）
[System.IO.File]::WriteAllText($shimPath, $shim, $utf8)

# 同步版本号到 manifest.json
$manifest = [System.IO.File]::ReadAllText($manifestPath, $utf8)
$manifest = [System.Text.RegularExpressions.Regex]::Replace($manifest, '"version":\s*"[^"]*"', "`"version`": `"$ver`"")
[System.IO.File]::WriteAllText($manifestPath, $manifest, $utf8)
Write-Host "manifest.json synced (v$ver)" -ForegroundColor Green
