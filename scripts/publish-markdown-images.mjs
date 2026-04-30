import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { uploadBuffer } from "./upload-client.mjs";

const DEFAULT_CONFIG_PATH = "D:\\vibecodingprojects\\我的图床\\image-bed.config.json";

const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

const MARKDOWN_IMAGE_PATTERN = /!\[(?<alt>[^\]]*)\]\((?<target><[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;

export function detectContentType(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

export function slugifyArticleName(markdownPath) {
  const stem = path.basename(markdownPath, path.extname(markdownPath));
  const parts = stem
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  return parts.length > 0 ? parts.join("-") : "article";
}

export function buildObjectKey({ articlePath, imageFilePath, now = new Date() }) {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const articleSlug = slugifyArticleName(articlePath);
  const filename = path.basename(imageFilePath);
  return `${year}/${month}/${articleSlug}/${filename}`;
}

export function buildPublishedMarkdownPath(markdownPath) {
  const extension = path.extname(markdownPath);
  const stem = path.basename(markdownPath, extension);
  return path.join(path.dirname(markdownPath), `${stem}-公网版${extension}`);
}

export function isRemoteImageTarget(target) {
  return /^(?:https?:)?\/\//i.test(target) || /^data:/i.test(target);
}

export function extractMarkdownImageTargets(markdown) {
  const matches = [];
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const rawTarget = match.groups?.target ?? "";
    const target = rawTarget.startsWith("<") && rawTarget.endsWith(">")
      ? rawTarget.slice(1, -1)
      : rawTarget;

    matches.push({
      original: match[0],
      target,
      index: match.index ?? -1,
    });
  }
  return matches;
}

export function loadImageBedConfig(configPath = DEFAULT_CONFIG_PATH) {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

export function findWatermarkCleanupScript(markdownPath) {
  let currentDir = path.dirname(path.resolve(markdownPath));
  const { root } = path.parse(currentDir);

  while (true) {
    const candidate = path.join(currentDir, "scripts", "remove_gemini_watermark.py");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    if (currentDir === root) {
      return null;
    }
    currentDir = path.dirname(currentDir);
  }
}

function createDefaultUploader(configPath) {
  const config = loadImageBedConfig(configPath);
  return async ({ key, contentType, body }) =>
    uploadBuffer({
      apiDomain: config.apiDomain,
      token: config.uploadToken,
      key,
      contentType,
      body,
    });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error((stderr || stdout || `Command failed: ${command}`).trim()));
    });
  });
}

function createDefaultImageCleaner(markdownPath) {
  const cleanupScript = findWatermarkCleanupScript(markdownPath);
  if (!cleanupScript) {
    return null;
  }

  return async (absoluteImagePath) => {
    await runCommand("python", [cleanupScript, absoluteImagePath]);
    return absoluteImagePath;
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadWithRetry({
  uploadFile,
  uploadArgs,
  target,
  maxUploadAttempts,
  retryDelayMs,
}) {
  let lastError;

  for (let attempt = 1; attempt <= maxUploadAttempts; attempt += 1) {
    try {
      return await uploadFile(uploadArgs);
    } catch (error) {
      lastError = error;
      if (attempt >= maxUploadAttempts) {
        break;
      }
      await sleep(retryDelayMs * attempt);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Upload failed for ${target} after ${maxUploadAttempts} attempts: ${detail}`,
  );
}

export async function publishMarkdownLocalImages({
  markdownPath,
  confirmedFinal,
  configPath = DEFAULT_CONFIG_PATH,
  now = new Date(),
  uploadFile = createDefaultUploader(configPath),
  cleanLocalImage = createDefaultImageCleaner(markdownPath),
  outputPath,
  maxUploadAttempts = 3,
  retryDelayMs = 1000,
}) {
  if (!confirmedFinal) {
    throw new Error("Publishing requires confirmed final approval.");
  }

  const absoluteMarkdownPath = path.resolve(markdownPath);
  const resolvedOutputPath = outputPath
    ? path.resolve(outputPath)
    : buildPublishedMarkdownPath(absoluteMarkdownPath);
  const markdownDir = path.dirname(absoluteMarkdownPath);
  const originalMarkdown = fs.readFileSync(absoluteMarkdownPath, "utf8");
  const imageTargets = extractMarkdownImageTargets(originalMarkdown);
  const localTargets = imageTargets.filter((item) => !isRemoteImageTarget(item.target));

  if (localTargets.length === 0) {
    fs.writeFileSync(resolvedOutputPath, originalMarkdown);
    return {
      markdownPath: absoluteMarkdownPath,
      outputMarkdownPath: resolvedOutputPath,
      replacements: [],
      updatedMarkdown: originalMarkdown,
    };
  }

  const uploadedByTarget = new Map();
  for (const item of localTargets) {
    if (uploadedByTarget.has(item.target)) continue;

    const sourceImagePath = path.resolve(markdownDir, item.target);
    if (!fs.existsSync(sourceImagePath)) {
      throw new Error(`Local image not found: ${sourceImagePath}`);
    }

    const absoluteImagePath = cleanLocalImage
      ? path.resolve(await cleanLocalImage(sourceImagePath))
      : sourceImagePath;
    if (!fs.existsSync(absoluteImagePath)) {
      throw new Error(`Cleaned image not found: ${absoluteImagePath}`);
    }

    const key = buildObjectKey({
      articlePath: absoluteMarkdownPath,
      imageFilePath: absoluteImagePath,
      now,
    });

    const result = await uploadWithRetry({
      uploadFile,
      uploadArgs: {
        key,
        contentType: detectContentType(absoluteImagePath),
        body: fs.readFileSync(absoluteImagePath),
        absoluteImagePath,
      },
      target: item.target,
      maxUploadAttempts,
      retryDelayMs,
    });

    if (!result?.url) {
      throw new Error(`Upload did not return a public URL for ${item.target}`);
    }

    uploadedByTarget.set(item.target, {
      originalTarget: item.target,
      absoluteImagePath,
      key,
      url: result.url,
    });
  }

  let updatedMarkdown = originalMarkdown;
  for (const [originalTarget, uploaded] of uploadedByTarget.entries()) {
    const escapedTarget = originalTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    updatedMarkdown = updatedMarkdown.replace(
      new RegExp(`(!\\[[^\\]]*\\]\\()${escapedTarget}(\\))`, "g"),
      `$1${uploaded.url}$2`,
    );
  }

  fs.writeFileSync(resolvedOutputPath, updatedMarkdown);

  return {
    markdownPath: absoluteMarkdownPath,
    outputMarkdownPath: resolvedOutputPath,
    replacements: Array.from(uploadedByTarget.values()),
    updatedMarkdown,
  };
}

function parseCliArgs(argv) {
  const args = {
    markdownPath: "",
    confirmedFinal: false,
    configPath: DEFAULT_CONFIG_PATH,
    outputPath: "",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!args.markdownPath && !arg.startsWith("--")) {
      args.markdownPath = arg;
      continue;
    }
    if (arg === "--confirm-final") {
      args.confirmedFinal = true;
      continue;
    }
    if (arg === "--config") {
      const next = argv[index + 1];
      if (!next) throw new Error("Missing value for --config");
      args.configPath = next;
      index += 1;
      continue;
    }
    if (arg === "--output") {
      const next = argv[index + 1];
      if (!next) throw new Error("Missing value for --output");
      args.outputPath = next;
      index += 1;
      continue;
    }
    if (arg === "--in-place") {
      args.outputPath = args.markdownPath;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.markdownPath) {
    throw new Error(
      "Usage: node publish-markdown-images.mjs <markdown-path> --confirm-final [--output <output-path>] [--in-place] [--config <config-path>]",
    );
  }

  if (args.outputPath === args.markdownPath) {
    args.outputPath = path.resolve(args.markdownPath);
  }

  return args;
}

async function main(argv = process.argv) {
  const args = parseCliArgs(argv);
  const result = await publishMarkdownLocalImages(args);
  console.log(
    JSON.stringify(
      {
        markdownPath: result.markdownPath,
        outputMarkdownPath: result.outputMarkdownPath,
        replacements: result.replacements.map((item) => ({
          originalTarget: item.originalTarget,
          key: item.key,
          url: item.url,
        })),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
