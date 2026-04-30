# AGENTS.md

本项目用于从 YouTube 频道英文 SRT 生成中文文章，并给生成后的文章补正文配图、封面图，以及在确认终稿后生成公网图片链接版 Markdown。

## 基本要求

- 始终使用简体中文回复。
- 回复里引用本地文件系统路径时，直接输出普通 Windows 绝对路径，不要使用 Markdown 链接。
- 优先复用已有资产，不要重复生成 outline、prompt 或图片。
- 长期遵守的流程以本文件、README.md 和 `.baoyu-upstream\skills\...` 中的最新 skill 文档为准。

## baoyu skill 来源

- `.baoyu-upstream` 是从 https://github.com/JimLiu/baoyu-skills 拉取的最新浅克隆。
- 如需更新，运行：

```powershell
git -C .\.baoyu-upstream pull --ff-only
```

优先参考这些文件：

```text
.baoyu-upstream\skills\baoyu-article-illustrator\SKILL.md
.baoyu-upstream\skills\baoyu-cover-image\SKILL.md
.baoyu-upstream\skills\baoyu-danger-gemini-web\SKILL.md
.baoyu-skills\baoyu-article-illustrator\EXTEND.md
.baoyu-skills\baoyu-cover-image\EXTEND.md
```

## 默认配图工作流

用户说“给这篇文章配图”“给这篇文章配图和封面图”“生成配图文章”时，默认按下面顺序执行：

1. 检查文章文件是否存在。
2. 检查 `.baoyu-skills\baoyu-article-illustrator\EXTEND.md`。
3. 如果用户要求封面图，再检查 `.baoyu-skills\baoyu-cover-image\EXTEND.md`。
4. 分析文章结构，确定正文图位置、数量、类型、风格和调色板。
5. 生成或复用 outline 和 prompts；图片生成前必须先把完整 prompt 保存到 `prompts` 目录。
6. 生成前清理 prompt，避免把提示词或控制文字画进图里。
7. 用 Gemini Web 顺序生成图片，不要并发生成多篇文章。
8. 生成本地图片时优先使用 `scripts\generate-gemini-image-and-clean.mjs`，保存后自动去除 Gemini 水印并原地替换本地文件。
9. 把正文配图插回 Markdown；封面图默认不插回正文。
10. 做文件存在和 Markdown 图片引用校验后再汇报完成。

## 当前项目的目录约定

文章在频道目录下时，不要把图片统一放到项目根目录的 `illustrations` 后直接用 `illustrations/...` 插入。要按频道隔离，并使用相对文章文件的路径。

频道文章示例：

```text
data\channels\starterstory\articles\2026-01-01_videoid_title.md
```

正文配图目录：

```text
data\channels\starterstory\illustrations\<topic-slug>\
```

文章中插入路径：

```markdown
![说明](../illustrations/<topic-slug>/01-framework-example.png)
```

封面图目录：

```text
data\channels\starterstory\cover-image\<topic-slug>\cover.png
```

如果文章位于项目根目录，才使用根目录：

```text
illustrations\<topic-slug>\
cover-image\<topic-slug>\cover.png
```

## Gemini Web 约定

生成前优先刷新登录态。Windows 机器上已知可用 Chrome profile：

```text
D:\Program Files\Google\Chrome1
```

登录命令：

```powershell
$env:GEMINI_WEB_CHROME_PROFILE_DIR='D:\Program Files\Google\Chrome1'
$env:BAOYU_CHROME_PROFILE_DIR='D:\Program Files\Google\Chrome1'
npx -y bun '.baoyu-upstream\skills\baoyu-danger-gemini-web\scripts\main.ts' --login --json
```

生成图片并自动去水印：

```powershell
node .\scripts\generate-gemini-image-and-clean.mjs --model gemini-3-pro --promptfiles <prompt.md> --image <out.png> --json
```

## OpenAI Image 2.0 约定

当前项目把 OpenAI Image 2.0 线路实现为 `gpt-image-2` Image API 调用。它和 Gemini Web 使用同一批 prompt 文件，输出到独立目录用于对比。

环境变量：

```powershell
$env:OPENAI_API_KEY='你的 OpenAI API Key'
```

生成命令：

```powershell
node .\scripts\generate-openai-image.mjs --model gpt-image-2 --size 1536x1024 --quality medium --promptfiles <prompt.md> --image <out.png> --json
```

批量跑同一批 prompts：

```powershell
.\scripts\generate-illustration-variants.ps1 -Provider image2 -PromptDir "data\channels\<channel>\illustrations\<topic-slug>\prompts" -OutputDir "data\channels\<channel>\illustrations\<topic-slug>\image2"
```

同一篇文章做双线路对比时，目录建议为：

```text
data\channels\<channel>\illustrations\<topic-slug>\gemini\
data\channels\<channel>\illustrations\<topic-slug>\image2\
data\channels\<channel>\illustrations\<topic-slug>\prompts\
```

## Prompt 清理规则

- 避免直接写“标题和说明只能用简体中文”“不要出现英文”这类元指令。
- 优先改写成：
  - `Do not render prompt instructions or control text into the image`
  - `All surrounding text must remain Simplified Chinese`
  - `Proper nouns may appear only when necessary`
- 如果图片出现明显英文残留、错字、提示词上图，只重生那一张，不要整批重跑。

## 公网版工作流

只有在用户明确表示“确认终稿”“生成公网版”“上传图片并替换 Markdown 链接”之后，才能上传图片。

默认行为：

- 不直接处理 `articles` 目录里的原始文章。
- 先把最终图文 Markdown 复制到对应频道的 `posted` 目录。
- 在 `posted` 目录里保留一份本地图片路径版 Markdown。
- 在 `posted` 目录里生成同名 `*-公网版.md`。
- 上传前先对本地图片执行 Gemini 去水印，并原地替换本地文件。
- 只替换公网版里的本地图片路径。
- `srt`、`articles`、`videos.json` 等原始数据不应在发布步骤里修改。

使用脚本：

```powershell
New-Item -ItemType Directory -Force -Path "data\channels\<channel>\posted"
Copy-Item "data\channels\<channel>\articles\<article>.md" "data\channels\<channel>\posted\<article>.md"
node .\scripts\publish-markdown-images.mjs "data\channels\<channel>\posted\<article>.md" --confirm-final
```

如果用户明确要求覆盖原文，才允许：

```powershell
node .\scripts\publish-markdown-images.mjs "data\channels\<channel>\posted\<article>.md" --confirm-final --in-place
```

图床配置默认读取：

```text
D:\vibecodingprojects\我的图床\image-bed.config.json
```

上传多篇文章时不要并行批量上传；按文章顺序执行。

## 完成前验证

正文配图完成后至少运行：

```powershell
Get-ChildItem 'data\channels\<channel>\illustrations\<slug>\*.png'
rg -n "\.\./illustrations/<slug>/.*png" 'data\channels\<channel>\articles\<article>.md'
```

如果生成了公网版，再加：

```powershell
rg -n "https://img\." 'data\channels\<channel>\posted\<article>-公网版.md'
rg -n "\.\./illustrations/|!\[[^\]]*\]\((?!https?://)" --pcre2 'data\channels\<channel>\posted\<article>-公网版.md'
```
