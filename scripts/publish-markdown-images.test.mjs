import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildObjectKey,
  buildPublishedMarkdownPath,
  publishMarkdownLocalImages,
} from "./publish-markdown-images.mjs";

test("buildObjectKey groups uploads by year month and article slug", () => {
  const result = buildObjectKey({
    articlePath: "D:\\docs\\不辞职，也能做出月入过万美元的App——3个真实案例.md",
    imageFilePath: "D:\\docs\\illustrations\\01-framework-side-hustle-map.png",
    now: new Date("2026-03-29T10:00:00Z"),
  });

  assert.equal(
    result,
    "2026/03/app-3/01-framework-side-hustle-map.png",
  );
});

test("buildPublishedMarkdownPath appends 公网版 before extension", () => {
  assert.equal(
    buildPublishedMarkdownPath("D:\\docs\\文章.md"),
    "D:\\docs\\文章-公网版.md",
  );
});

test("publishMarkdownLocalImages preserves source markdown and writes public-url copy by default", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-article-images-"));
  const articlePath = path.join(tempDir, "文章.md");
  const imagesDir = path.join(tempDir, "illustrations");
  fs.mkdirSync(imagesDir, { recursive: true });

  const firstImagePath = path.join(imagesDir, "one.png");
  const secondImagePath = path.join(imagesDir, "two.webp");
  fs.writeFileSync(firstImagePath, "png-content");
  fs.writeFileSync(secondImagePath, "webp-content");
  fs.writeFileSync(
    articlePath,
    [
      "# 标题",
      "",
      "![图一](illustrations/one.png)",
      "![远程图](https://example.com/existing.png)",
      "![图二](illustrations/two.webp)",
      "",
    ].join("\n"),
  );

  const uploads = [];
  const result = await publishMarkdownLocalImages({
    markdownPath: articlePath,
    confirmedFinal: true,
    now: new Date("2026-03-29T10:00:00Z"),
    uploadFile: async ({ key, contentType, body }) => {
      uploads.push({ key, contentType, body: body.toString("utf8") });
      return {
        ok: true,
        key,
        url: `https://img.example.com/${key}`,
      };
    },
  });

  const sourceMarkdown = fs.readFileSync(articlePath, "utf8");
  const updated = fs.readFileSync(result.outputMarkdownPath, "utf8");
  assert.equal(uploads.length, 2);
  assert.deepEqual(
    uploads.map((item) => item.key),
    [
      "2026/03/article/one.png",
      "2026/03/article/two.webp",
    ],
  );
  assert.deepEqual(
    uploads.map((item) => item.contentType),
    ["image/png", "image/webp"],
  );
  assert.match(updated, /https:\/\/img\.example\.com\/2026\/03\/article\/one\.png/);
  assert.match(updated, /https:\/\/example\.com\/existing\.png/);
  assert.match(updated, /https:\/\/img\.example\.com\/2026\/03\/article\/two\.webp/);
  assert.equal(result.replacements.length, 2);
  assert.equal(result.markdownPath, articlePath);
  assert.equal(result.outputMarkdownPath, path.join(tempDir, "文章-公网版.md"));
  assert.match(sourceMarkdown, /!\[图一\]\(illustrations\/one\.png\)/);
  assert.doesNotMatch(sourceMarkdown, /https:\/\/img\.example\.com/);
});

test("publishMarkdownLocalImages requires explicit final confirmation", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-article-images-"));
  const articlePath = path.join(tempDir, "文章.md");
  fs.writeFileSync(articlePath, "![图](a.png)\n");
  fs.writeFileSync(path.join(tempDir, "a.png"), "png-content");

  await assert.rejects(
    publishMarkdownLocalImages({
      markdownPath: articlePath,
      confirmedFinal: false,
      uploadFile: async () => {
        throw new Error("should not upload");
      },
    }),
    /confirmed final/i,
  );
});

test("publishMarkdownLocalImages retries transient upload failures and still writes 公网版", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-article-images-"));
  const articlePath = path.join(tempDir, "文章.md");
  const imagePath = path.join(tempDir, "a.png");
  fs.writeFileSync(articlePath, "![图](a.png)\n");
  fs.writeFileSync(imagePath, "png-content");

  let attempts = 0;
  const result = await publishMarkdownLocalImages({
    markdownPath: articlePath,
    confirmedFinal: true,
    now: new Date("2026-03-31T10:00:00Z"),
    retryDelayMs: 1,
    uploadFile: async ({ key }) => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("fetch failed");
      }
      return {
        ok: true,
        key,
        url: `https://img.example.com/${key}`,
      };
    },
  });

  const updated = fs.readFileSync(result.outputMarkdownPath, "utf8");
  assert.equal(attempts, 3);
  assert.match(updated, /https:\/\/img\.example\.com\/2026\/03\/article\/a\.png/);
});

test("publishMarkdownLocalImages surfaces target after retry exhaustion", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-article-images-"));
  const articlePath = path.join(tempDir, "文章.md");
  const imagePath = path.join(tempDir, "a.png");
  fs.writeFileSync(articlePath, "![图](a.png)\n");
  fs.writeFileSync(imagePath, "png-content");

  await assert.rejects(
    publishMarkdownLocalImages({
      markdownPath: articlePath,
      confirmedFinal: true,
      retryDelayMs: 1,
      maxUploadAttempts: 2,
      uploadFile: async () => {
        throw new Error("fetch failed");
      },
    }),
    /a\.png[\s\S]*2 attempts/i,
  );
});

test("publishMarkdownLocalImages cleans local image before upload when cleaner is available", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-article-images-"));
  const articlePath = path.join(tempDir, "文章.md");
  const imagePath = path.join(tempDir, "a.png");
  fs.writeFileSync(articlePath, "![图](a.png)\n");
  fs.writeFileSync(imagePath, "watermarked-content");

  const cleanedPaths = [];
  const uploads = [];
  await publishMarkdownLocalImages({
    markdownPath: articlePath,
    confirmedFinal: true,
    now: new Date("2026-04-01T10:00:00Z"),
    cleanLocalImage: async (absoluteImagePath) => {
      cleanedPaths.push(absoluteImagePath);
      fs.writeFileSync(absoluteImagePath, "clean-content");
      return absoluteImagePath;
    },
    uploadFile: async ({ key, body }) => {
      uploads.push({ key, body: body.toString("utf8") });
      return {
        ok: true,
        key,
        url: `https://img.example.com/${key}`,
      };
    },
  });

  assert.deepEqual(cleanedPaths, [imagePath]);
  assert.deepEqual(uploads, [
    {
      key: "2026/04/article/a.png",
      body: "clean-content",
    },
  ]);
});

test("publishMarkdownLocalImages auto-detects cleaner and handles Chinese paths", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-article-images-"));
  const repoDir = path.join(tempDir, "公众号配图");
  const scriptsDir = path.join(repoDir, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });

  const cleanupScriptPath = path.join(scriptsDir, "remove_gemini_watermark.py");
  fs.writeFileSync(
    cleanupScriptPath,
    [
      "from pathlib import Path",
      "import sys",
      "",
      "image_path = Path(sys.argv[1])",
      "image_path.write_text('clean-content', encoding='utf-8')",
      "print(image_path)",
      "",
    ].join("\n"),
  );

  const articlePath = path.join(repoDir, "文章.md");
  const imagePath = path.join(repoDir, "a.png");
  fs.writeFileSync(articlePath, "![图](a.png)\n");
  fs.writeFileSync(imagePath, "watermarked-content");

  const uploads = [];
  await publishMarkdownLocalImages({
    markdownPath: articlePath,
    confirmedFinal: true,
    now: new Date("2026-04-01T10:00:00Z"),
    uploadFile: async ({ key, body }) => {
      uploads.push({ key, body: body.toString("utf8") });
      return {
        ok: true,
        key,
        url: `https://img.example.com/${key}`,
      };
    },
  });

  assert.deepEqual(uploads, [
    {
      key: "2026/04/article/a.png",
      body: "clean-content",
    },
  ]);
});
