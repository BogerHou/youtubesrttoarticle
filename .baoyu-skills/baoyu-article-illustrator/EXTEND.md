---
version: 1
watermark:
  enabled: false
  content: ""
  position: bottom-right
  opacity: 0.7
preferred_style:
  name: null
  description: ""
preferred_palette: null
default_output_dir: independent
language: zh
preferred_image_backend: auto
custom_styles: []
---

## 项目发布流程：生成公网版 Markdown

当用户明确要求“生成公网版”“上传图片并替换 Markdown 链接”“确认终稿”时，按下面流程执行。该流程适用于 `data\channels\<channel>` 下的频道文章，并以 `starterstory` 的文件结构为准。

### 硬性约束

- 不要直接处理或覆盖 `data\channels\<channel>\articles` 里的原始文章。
- 不要修改 `data\channels\<channel>\srt`、`data\channels\<channel>\videos.json` 等原始数据。
- 必须在当前文章所属频道目录下创建或复用 `posted` 目录。
- `posted` 目录里必须同时保留两份 Markdown：
  - 同名本地图片路径版：`data\channels\<channel>\posted\<article>.md`
  - 同名公网图片链接版：`data\channels\<channel>\posted\<article>-公网版.md`
- 只替换公网版里的本地图片路径；本地版继续保留 `../illustrations/...` 等本地相对路径。
- 上传多篇文章时按文章顺序执行，不要并发批量上传。

### 默认命令模板

```powershell
New-Item -ItemType Directory -Force -Path "data\channels\<channel>\posted"
Copy-Item "data\channels\<channel>\articles\<article>.md" "data\channels\<channel>\posted\<article>.md"
node .\scripts\publish-markdown-images.mjs "data\channels\<channel>\posted\<article>.md" --confirm-final
```

如果用户提供的是已经完成配图的 `posted` 本地版，则直接对该 `posted` 文件运行发布脚本，不再从 `articles` 复制。

### 校验

```powershell
rg -n "\.\./illustrations/.*png" "data\channels\<channel>\posted\<article>.md"
rg -n "https://img\." "data\channels\<channel>\posted\<article>-公网版.md"
rg -n "\.\./illustrations/|!\[[^\]]*\]\((?!https?://)" --pcre2 "data\channels\<channel>\posted\<article>-公网版.md"
```

最后一条命令应无输出；如果有输出，说明公网版仍残留本地图片路径或非公网图片链接。
