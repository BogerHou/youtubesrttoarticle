import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_SIZE = "1536x1024";
const DEFAULT_QUALITY = "medium";
const DEFAULT_OUTPUT_FORMAT = "png";
const DEFAULT_BACKGROUND = "auto";
const DEFAULT_MODERATION = "auto";
const DEFAULT_ENDPOINT = "https://api.openai.com/v1/images/generations";

function takeMany(argv, index) {
  const items = [];
  let cursor = index + 1;
  while (cursor < argv.length && !argv[cursor].startsWith("-")) {
    items.push(argv[cursor]);
    cursor += 1;
  }
  return { items, next: cursor - 1 };
}

export function parseCliArgs(argv = process.argv) {
  const args = {
    prompt: "",
    promptFiles: [],
    imagePath: "generated.png",
    model: process.env.OPENAI_IMAGE_MODEL || DEFAULT_MODEL,
    size: DEFAULT_SIZE,
    quality: DEFAULT_QUALITY,
    outputFormat: DEFAULT_OUTPUT_FORMAT,
    background: DEFAULT_BACKGROUND,
    moderation: DEFAULT_MODERATION,
    json: false,
    endpoint: process.env.OPENAI_IMAGE_ENDPOINT || DEFAULT_ENDPOINT,
    apiKeyEnv: "OPENAI_API_KEY",
  };

  const input = argv.slice(2);
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];

    if (arg === "--json") {
      args.json = true;
      continue;
    }

    if (arg === "--prompt" || arg === "-p") {
      const next = input[index + 1];
      if (!next) throw new Error(`Missing value for ${arg}`);
      args.prompt = next;
      index += 1;
      continue;
    }

    if (arg === "--promptfiles") {
      const { items, next } = takeMany(input, index);
      if (items.length === 0) throw new Error("Missing files for --promptfiles");
      args.promptFiles.push(...items);
      index = next;
      continue;
    }

    if (arg === "--image") {
      const next = input[index + 1];
      if (next && !next.startsWith("-")) {
        args.imagePath = next;
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--image=")) {
      args.imagePath = arg.slice("--image=".length) || "generated.png";
      continue;
    }

    const valueOptions = {
      "--model": "model",
      "-m": "model",
      "--size": "size",
      "--quality": "quality",
      "--format": "outputFormat",
      "--output-format": "outputFormat",
      "--background": "background",
      "--moderation": "moderation",
      "--endpoint": "endpoint",
      "--api-key-env": "apiKeyEnv",
    };

    if (Object.hasOwn(valueOptions, arg)) {
      const next = input[index + 1];
      if (!next) throw new Error(`Missing value for ${arg}`);
      args[valueOptions[arg]] = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

export async function readPrompt({ prompt, promptFiles }, readFile = fs.readFile) {
  const chunks = [];
  if (prompt) chunks.push(prompt);

  for (const file of promptFiles) {
    const content = await readFile(file, "utf8");
    chunks.push(content.trim());
  }

  const finalPrompt = chunks.filter(Boolean).join("\n\n---\n\n").trim();
  if (!finalPrompt) {
    throw new Error("Provide --prompt or --promptfiles.");
  }
  return finalPrompt;
}

export function buildImageRequestBody({
  model,
  prompt,
  size,
  quality,
  outputFormat,
  background,
  moderation,
}) {
  const body = {
    model,
    prompt,
    n: 1,
  };

  if (size) body.size = size;
  if (quality) body.quality = quality;
  if (outputFormat) body.output_format = outputFormat;
  if (background) body.background = background;
  if (moderation) body.moderation = moderation;

  return body;
}

async function parseOpenAIResponse(response) {
  const requestId = response.headers?.get?.("x-request-id") || null;
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const message = payload?.error?.message || text || `OpenAI request failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.requestId = requestId;
    throw error;
  }

  const imageBase64 = payload?.data?.[0]?.b64_json;
  if (!imageBase64) {
    throw new Error("OpenAI response did not include data[0].b64_json.");
  }

  return { payload, imageBase64, requestId };
}

export async function generateOpenAIImage({
  args,
  fetchImpl = fetch,
  writeFile = fs.writeFile,
  mkdir = fs.mkdir,
  readFile = fs.readFile,
  env = process.env,
}) {
  const apiKey = env[args.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${args.apiKeyEnv}. Set it before generating Image 2.0 images.`);
  }

  const prompt = await readPrompt(args, readFile);
  const body = buildImageRequestBody({ ...args, prompt });
  const response = await fetchImpl(args.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const { imageBase64, requestId, payload } = await parseOpenAIResponse(response);
  const outputPath = path.resolve(args.imagePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(imageBase64, "base64"));

  return {
    savedImage: outputPath,
    model: args.model,
    size: args.size,
    quality: args.quality,
    outputFormat: args.outputFormat,
    requestId,
    revisedPrompt: payload?.data?.[0]?.revised_prompt || null,
  };
}

async function main(argv = process.argv) {
  const args = parseCliArgs(argv);
  const result = await generateOpenAIImage({ args });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.savedImage}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    if (error.requestId) console.error(`OpenAI request id: ${error.requestId}`);
    process.exitCode = 1;
  });
}

