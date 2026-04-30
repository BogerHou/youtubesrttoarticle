param(
  [string]$Channel = "starterstory",
  [int]$StartIndex = 1,
  [int]$EndIndex = 0,
  [int]$BatchSize = 3,
  [int]$Parallel = 2,
  [switch]$Overwrite
)

$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
$ChannelDir = Join-Path $Root "data\channels\$Channel"
$SourceDir = Join-Path $ChannelDir "srt"
$OutputDir = Join-Path $ChannelDir "articles"
$IndexPath = Join-Path $ChannelDir "videos.json"
$PromptFile = Join-Path $Root "提示词.md"
$LogsDir = Join-Path $OutputDir "_logs"
$PromptsDir = Join-Path $OutputDir "_prompts"
$ScriptsDir = Join-Path $OutputDir "_scripts"
$PowerShellExe = (Get-Command "pwsh" -ErrorAction SilentlyContinue).Source
if (-not $PowerShellExe) {
  $PowerShellExe = (Get-Command "powershell" -ErrorAction Stop).Source
}

if (-not (Test-Path -LiteralPath $PromptFile)) {
  throw "提示词文件不存在：$PromptFile"
}

if (-not (Test-Path -LiteralPath $SourceDir)) {
  throw "SRT目录不存在：$SourceDir。请先运行：python .\youtube_channel_srt.py sync $Channel --limit 5"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
New-Item -ItemType Directory -Force -Path $PromptsDir | Out-Null
New-Item -ItemType Directory -Force -Path $ScriptsDir | Out-Null

function Get-SafeOutputName {
  param([string]$BaseName)
  $base = $BaseName
  $base = $base -replace '[<>:"/\\|?*]', ''
  $base = $base -replace '\s+', ' '
  $base = $base.Trim().TrimEnd(".")
  if ($base.Length -gt 140) {
    $base = $base.Substring(0, 140).TrimEnd([char[]]@(" ", "-", "."))
  }
  return "$base.md"
}

function Get-PublishedDate {
  param([string]$BaseName)
  if ($BaseName -match '^(\d{4}-\d{2}-\d{2})') {
    return $Matches[1]
  }
  return "unknown-date"
}

function Get-ArticleTitleSource {
  param([string]$BaseName)
  return (($BaseName -replace '^\d{4}-\d{2}-\d{2}\s+-\s+', '') -replace '\s+\[[^\]]+\]$', '')
}

function New-BatchPrompt {
  param([array]$Batch)
  $items = ($Batch | ForEach-Object {
    "- 发布时间：$($_.PublishedAt)`n  原标题：$($_.Title)`n  输入 srt：$($_.Srt)`n  输出 md：$($_.Out)"
  }) -join "`n"

  return @"
你是公众号文章改写助手。请严格读取并遵守提示词文件：$PromptFile

任务：把下面每一个 srt 重写成一篇完整的中文公众号文章，并写入对应 md 文件。输出文件名已经带发布时间前缀。

$items

硬性要求：
- 每个输入文件输出一篇独立文章，不要写成摘要、提纲、模板稿或分析报告。
- 每篇文章第一行必须是 Markdown 一级标题，格式为：# 发布时间-中文标题。例如：# 2025-04-25-如果2025年从零重做Starter Story
- 文章必须是通俗流畅、引人入胜的简体中文第一人称分享文，面向对 AI 感兴趣的普通读者。
- 核心事实、数据、项目名、人物关系、收入、时间线、产品逻辑必须忠实于原字幕，不要编造。
- 专注项目和经验，少写个人感受。
- 英文长句要拆成自然中文短句。
- 专业术语使用标准翻译；第一次出现时可括英文原文。英文缩写可以解释，但不要堆砌普通英文短语括注。
- 难懂概念用（**……**）补充解释。
- 不要输出 YAML front matter，不要输出处理说明，不要输出除文件之外的多余内容。
- 输出目录不存在就创建。
"@
}

$files = @()
if (Test-Path -LiteralPath $IndexPath) {
  $index = Get-Content -LiteralPath $IndexPath -Raw | ConvertFrom-Json
  $videos = @($index.videos | Where-Object {
    $_.srt_path -and (Test-Path -LiteralPath $_.srt_path)
  } | Sort-Object published_at, title)
  $position = 1
  foreach ($video in $videos) {
    $srtFile = Get-Item -LiteralPath $video.srt_path
    $articlePath = $video.article_path
    if (-not $articlePath) {
      $articlePath = Join-Path $OutputDir ((Get-SafeOutputName $srtFile.BaseName))
    }
    $files += [pscustomobject]@{
      Index = $position
      Srt = $srtFile.FullName
      BaseName = $srtFile.BaseName
      Out = $articlePath
      PublishedAt = if ($video.published_at) { $video.published_at } else { Get-PublishedDate $srtFile.BaseName }
      Title = if ($video.title) { $video.title } else { Get-ArticleTitleSource $srtFile.BaseName }
    }
    $position += 1
  }
} else {
  $position = 1
  foreach ($file in @(Get-ChildItem -LiteralPath $SourceDir -Filter "*.srt" | Sort-Object Name)) {
    $files += [pscustomobject]@{
      Index = $position
      Srt = $file.FullName
      BaseName = $file.BaseName
      Out = Join-Path $OutputDir (Get-SafeOutputName $file.BaseName)
      PublishedAt = Get-PublishedDate $file.BaseName
      Title = Get-ArticleTitleSource $file.BaseName
    }
    $position += 1
  }
}

if ($files.Count -eq 0) {
  throw "没有找到SRT文件：$SourceDir"
}

if ($EndIndex -le 0 -or $EndIndex -gt $files.Count) {
  $EndIndex = $files.Count
}

$batches = @()
$i = $StartIndex
while ($i -le $EndIndex) {
  $batch = @()
  $last = [Math]::Min($i + $BatchSize - 1, $EndIndex)
  for ($n = $i; $n -le $last; $n++) {
    $item = $files[$n - 1]
    $outPath = $item.Out
    if ((Test-Path -LiteralPath $outPath) -and -not $Overwrite) {
      continue
    }
    $batch += [pscustomobject]@{
      Index = $item.Index
      Srt = $item.Srt
      Out = $outPath
      PublishedAt = $item.PublishedAt
      Title = $item.Title
    }
  }
  if ($batch.Count -gt 0) {
    $batches += ,$batch
  }
  $i = $last + 1
}

if ($batches.Count -eq 0) {
  Write-Host "没有需要生成的文章。已有md会被跳过；如需重跑请加 -Overwrite。"
  exit 0
}

$running = @()
$completed = 0

foreach ($batch in $batches) {
  while (@($running | Where-Object { -not $_.Process.HasExited }).Count -ge $Parallel) {
    Start-Sleep -Seconds 10
    $running = @($running | Where-Object { -not $_.Process.HasExited })
    $mdCount = @(Get-ChildItem -LiteralPath $OutputDir -Filter "*.md" -ErrorAction SilentlyContinue).Count
    Write-Host ("{0} running={1} completed_batches={2}/{3} md={4}" -f (Get-Date -Format "HH:mm:ss"), $running.Count, $completed, $batches.Count, $mdCount)
  }

  $first = $batch[0].Index
  $last = $batch[-1].Index
  $name = "prompted_batch_{0:D3}_{1:D3}" -f $first, $last
  $promptPath = Join-Path $PromptsDir "$name.txt"
  $scriptPath = Join-Path $ScriptsDir "$name.ps1"
  $logPath = Join-Path $LogsDir "$name.log"

  Set-Content -LiteralPath $promptPath -Value (New-BatchPrompt $batch) -Encoding UTF8
  $script = @"
`$ErrorActionPreference = "Continue"
Get-Content -LiteralPath "$promptPath" -Raw | codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C "$Root" - *> "$logPath"
"@
  Set-Content -LiteralPath $scriptPath -Value $script -Encoding UTF8

  $process = Start-Process -FilePath $PowerShellExe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath) -WindowStyle Hidden -PassThru
  $running += [pscustomobject]@{
    Name = $name
    Process = $process
    Log = $logPath
  }
  Write-Host ("started {0} pid={1}" -f $name, $process.Id)
}

while (@($running | Where-Object { -not $_.Process.HasExited }).Count -gt 0) {
  Start-Sleep -Seconds 10
  $still = @($running | Where-Object { -not $_.Process.HasExited })
  $completed = $batches.Count - $still.Count
  $mdCount = @(Get-ChildItem -LiteralPath $OutputDir -Filter "*.md" -ErrorAction SilentlyContinue).Count
  Write-Host ("{0} running={1} completed_estimate={2}/{3} md={4}" -f (Get-Date -Format "HH:mm:ss"), $still.Count, $completed, $batches.Count, $mdCount)
  $running = $still
}

$mdCount = @(Get-ChildItem -LiteralPath $OutputDir -Filter "*.md" -ErrorAction SilentlyContinue).Count
Write-Host ("done md={0}" -f $mdCount)
