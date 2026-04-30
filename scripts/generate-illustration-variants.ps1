param(
  [Parameter(Mandatory = $true)]
  [string]$PromptDir,

  [ValidateSet("gemini", "image2")]
  [string]$Provider = "image2",

  [string]$OutputDir = "",

  [string]$Model = "",

  [string]$Size = "1536x1024",

  [string]$Quality = "medium",

  [switch]$Force
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$resolvedPromptDir = (Resolve-Path -LiteralPath $PromptDir).Path

if (-not $OutputDir) {
  $parent = Split-Path -Parent $resolvedPromptDir
  $OutputDir = Join-Path $parent $Provider
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$resolvedOutputDir = (Resolve-Path -LiteralPath $OutputDir).Path

if ($Provider -eq "image2" -and -not $env:OPENAI_API_KEY) {
  throw "Missing OPENAI_API_KEY. Set it before generating Image 2.0 images."
}

if (-not $Model) {
  $Model = if ($Provider -eq "gemini") { "gemini-3-pro" } else { "gpt-image-2" }
}

$prompts = Get-ChildItem -LiteralPath $resolvedPromptDir -Filter "*.md" | Sort-Object Name
if ($prompts.Count -eq 0) {
  throw "No prompt files found in $resolvedPromptDir"
}

foreach ($prompt in $prompts) {
  $imageName = [System.IO.Path]::ChangeExtension($prompt.Name, ".png")
  $imagePath = Join-Path $resolvedOutputDir $imageName

  if ((Test-Path -LiteralPath $imagePath) -and -not $Force) {
    Write-Output "SKIP $imagePath"
    continue
  }

  Write-Output "GENERATE $imagePath"
  if ($Provider -eq "gemini") {
    & node (Join-Path $repoRoot "scripts\generate-gemini-image-and-clean.mjs") `
      --model $Model `
      --promptfiles $prompt.FullName `
      --image $imagePath `
      --json
  } else {
    & node (Join-Path $repoRoot "scripts\generate-openai-image.mjs") `
      --model $Model `
      --size $Size `
      --quality $Quality `
      --promptfiles $prompt.FullName `
      --image $imagePath `
      --json
  }

  if ($LASTEXITCODE -ne 0) {
    throw "Generation failed for $($prompt.FullName)"
  }
}

