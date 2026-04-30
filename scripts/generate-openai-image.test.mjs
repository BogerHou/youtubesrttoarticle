import test from "node:test";
import assert from "node:assert/strict";

import {
  buildImageRequestBody,
  generateOpenAIImage,
  parseCliArgs,
  readPrompt,
} from "./generate-openai-image.mjs";

test("parseCliArgs reads prompt files and image options", () => {
  const args = parseCliArgs([
    "node",
    "script",
    "--promptfiles",
    "one.md",
    "two.md",
    "--image",
    "out.png",
    "--model",
    "gpt-image-2",
    "--size",
    "1536x1024",
    "--quality",
    "low",
    "--format",
    "webp",
    "--json",
  ]);

  assert.deepEqual(args.promptFiles, ["one.md", "two.md"]);
  assert.equal(args.imagePath, "out.png");
  assert.equal(args.model, "gpt-image-2");
  assert.equal(args.size, "1536x1024");
  assert.equal(args.quality, "low");
  assert.equal(args.outputFormat, "webp");
  assert.equal(args.json, true);
});

test("readPrompt joins prompt text and prompt files", async () => {
  const prompt = await readPrompt(
    { prompt: "base", promptFiles: ["a.md", "b.md"] },
    async (file) => `content:${file}`,
  );

  assert.equal(prompt, "base\n\n---\n\ncontent:a.md\n\n---\n\ncontent:b.md");
});

test("buildImageRequestBody maps API parameters", () => {
  assert.deepEqual(
    buildImageRequestBody({
      model: "gpt-image-2",
      prompt: "draw",
      size: "1536x1024",
      quality: "medium",
      outputFormat: "png",
      background: "auto",
      moderation: "auto",
    }),
    {
      model: "gpt-image-2",
      prompt: "draw",
      n: 1,
      size: "1536x1024",
      quality: "medium",
      output_format: "png",
      background: "auto",
      moderation: "auto",
    },
  );
});

test("generateOpenAIImage posts request and writes decoded image", async () => {
  const writes = [];
  const mkdirs = [];
  const calls = [];
  const result = await generateOpenAIImage({
    args: parseCliArgs([
      "node",
      "script",
      "--prompt",
      "draw",
      "--image",
      "out.png",
    ]),
    env: { OPENAI_API_KEY: "test-key" },
    mkdir: async (dir, options) => {
      mkdirs.push({ dir, options });
    },
    writeFile: async (file, data) => {
      writes.push({ file, text: data.toString("utf8") });
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        headers: { get: () => "req_123" },
        text: async () =>
          JSON.stringify({
            data: [{ b64_json: Buffer.from("image-bytes").toString("base64") }],
          }),
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/generations");
  assert.equal(calls[0].options.headers.authorization, "Bearer test-key");
  assert.equal(JSON.parse(calls[0].options.body).model, "gpt-image-2");
  assert.equal(writes[0].text, "image-bytes");
  assert.equal(mkdirs.length, 1);
  assert.equal(result.requestId, "req_123");
  assert.match(result.savedImage, /out\.png$/);
});

