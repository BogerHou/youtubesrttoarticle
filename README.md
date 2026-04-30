# YouTube 频道 SRT 到中文文章流程

这个项目现在支持从配置的 YouTube 频道同步最新视频英文 SRT，再用 `提示词.md` 批量生成中文公众号文章。

## 目录结构

```text
config/channels/<频道>.json
data/channels/<频道>/videos.json
data/channels/<频道>/srt/
data/channels/<频道>/articles/
data/channels/<频道>/posted/
```

SRT 和文章分开放；不同频道会放在不同的 `data/channels/<频道>` 目录下。SRT 和文章文件名都会以视频发布时间开头，后面带视频 ID，方便排序和去重。

## 配置频道

当前已配置两个频道：

```text
starterstory      https://www.youtube.com/@starterstory/videos
starterstorybuild https://www.youtube.com/@StarterStoryBuild/videos
```

复制 `config/channels/starterstory.json`，改成新的频道 slug、名称和链接即可：

```json
{
  "channel_slug": "starterstory",
  "channel_name": "Starter Story",
  "channel_url": "https://www.youtube.com/@starterstory/videos",
  "max_videos": 5
}
```

## 同步最新 SRT

先安装依赖：

```powershell
python -m pip install -r requirements.txt
```

同步单个频道最新 5 个视频：

```powershell
python .\youtube_channel_srt.py sync starterstory --limit 5
python .\youtube_channel_srt.py sync starterstorybuild --limit 5
```

同步所有配置频道：

```powershell
python .\youtube_channel_srt.py sync-all --limit 5
```

脚本会读取 `data/channels/<频道>/videos.json` 做增量判断：已经下载过的同一视频 ID 不会重复下载 SRT。

## 生成中文文章

同步 SRT 后运行：

```powershell
.\run_prompted_srt_batches.ps1 -Channel starterstory -BatchSize 3 -Parallel 2
.\run_prompted_srt_batches.ps1 -Channel starterstorybuild -BatchSize 3 -Parallel 2
```

文章会生成到：

```text
data/channels/starterstory/articles
```

文章文件名和文章标题都会带发布时间前缀，按文件名排序就是按发布时间排序。

## 给文章配图

项目已经复制了配图项目里的核心流程：

```text
.baoyu-upstream/
.baoyu-skills/
scripts/generate-gemini-image-and-clean.mjs
scripts/remove_gemini_watermark.py
scripts/publish-markdown-images.mjs
illustrations/
cover-image/
public/
```

`.baoyu-upstream` 来自 GitHub 最新版 `JimLiu/baoyu-skills`。当前用法要点：

- `baoyu-article-illustrator` 使用 Type × Style × Palette 三维方案。
- `baoyu-cover-image` 使用 Type × Palette × Rendering × Text × Mood 五维方案。
- 图片生成前必须先保存完整 prompt 文件。
- 当前项目默认使用 Gemini Web 生成图片，并在保存后自动去除 Gemini 水印。

更新 baoyu skills：

```powershell
git -C .\.baoyu-upstream pull --ff-only
```

首次使用前安装 Python 依赖：

```powershell
python -m pip install -r requirements.txt
```

刷新 Gemini Web 登录态：

```powershell
$env:GEMINI_WEB_CHROME_PROFILE_DIR='D:\Program Files\Google\Chrome1'
$env:BAOYU_CHROME_PROFILE_DIR='D:\Program Files\Google\Chrome1'
npx -y bun '.baoyu-upstream\skills\baoyu-danger-gemini-web\scripts\main.ts' --login --json
```

生成单张图片并自动去水印：

```powershell
node .\scripts\generate-gemini-image-and-clean.mjs --model gemini-3-pro --promptfiles <prompt.md> --image <out.png> --json
```

使用 OpenAI Image 2.0 / GPT Image 2 生成同一张图：

```powershell
$env:OPENAI_API_KEY='你的 OpenAI API Key'
node .\scripts\generate-openai-image.mjs --model gpt-image-2 --size 1536x1024 --quality medium --promptfiles <prompt.md> --image <out.png> --json
```

推荐对比同一批 `prompts/*.md`，分别输出到 `gemini` 和 `image2` 子目录，避免覆盖。

批量生成一个 prompt 目录：

```powershell
.\scripts\generate-illustration-variants.ps1 -Provider gemini -PromptDir "data\channels\starterstory\illustrations\saas-tentpole-strategy\prompts" -OutputDir "data\channels\starterstory\illustrations\saas-tentpole-strategy\gemini"
.\scripts\generate-illustration-variants.ps1 -Provider image2 -PromptDir "data\channels\starterstory\illustrations\saas-tentpole-strategy\prompts" -OutputDir "data\channels\starterstory\illustrations\saas-tentpole-strategy\image2"
```

频道文章的正文配图按频道存放：

```text
data/channels/<频道>/illustrations/<topic-slug>/
```

频道文章的封面图按频道存放：

```text
data/channels/<频道>/cover-image/<topic-slug>/cover.png
```

文章里插入正文图时，使用相对文章文件的路径：

```markdown
![说明](../illustrations/<topic-slug>/01-framework-example.png)
```

生成公网图片链接版 Markdown 时，不直接处理 `articles` 里的原始文章。先把最终图文版复制到对应频道的 `posted` 目录，再基于 `posted` 副本生成公网版：

```powershell
New-Item -ItemType Directory -Force -Path "data\channels\starterstory\posted"
Copy-Item "data\channels\starterstory\articles\<article>.md" "data\channels\starterstory\posted\<article>.md"
node .\scripts\publish-markdown-images.mjs "data\channels\starterstory\posted\<article>.md" --confirm-final
```

默认会在 `posted` 目录生成同名本地版和 `*-公网版.md`。`srt`、`articles`、`videos.json` 等原始数据不应在发布步骤里修改。
