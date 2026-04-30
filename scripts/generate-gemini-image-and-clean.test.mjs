import test from "node:test";
import assert from "node:assert/strict";

import {
  ensureJsonMode,
  extractRequestedImagePath,
  resolveNpxCommand,
  shouldUseShellForCommand,
  runGeminiGenerationWithCleanup,
} from "./generate-gemini-image-and-clean.mjs";

test("extractRequestedImagePath reads --image value", () => {
  assert.equal(
    extractRequestedImagePath(["--prompt", "x", "--image", "out.png"]),
    "out.png",
  );
  assert.equal(
    extractRequestedImagePath(["--prompt", "x", "--image=out.png"]),
    "out.png",
  );
  assert.equal(
    extractRequestedImagePath(["--prompt", "x"]),
    null,
  );
});

test("ensureJsonMode appends --json when missing", () => {
  assert.deepEqual(
    ensureJsonMode(["--prompt", "x"]),
    ["--prompt", "x", "--json"],
  );
});

test("ensureJsonMode preserves existing --json", () => {
  assert.deepEqual(
    ensureJsonMode(["--prompt", "x", "--json"]),
    ["--prompt", "x", "--json"],
  );
});

test("resolveNpxCommand uses npx.cmd on Windows", () => {
  assert.equal(resolveNpxCommand("win32"), "npx.cmd");
  assert.equal(resolveNpxCommand("linux"), "npx");
});

test("shouldUseShellForCommand enables shell for Windows cmd shims", () => {
  assert.equal(shouldUseShellForCommand("npx.cmd", "win32"), true);
  assert.equal(shouldUseShellForCommand("npx", "linux"), false);
});

test("runGeminiGenerationWithCleanup runs cleanup for saved image", async () => {
  const calls = [];
  const result = await runGeminiGenerationWithCleanup({
    args: ["--prompt", "x", "--image", "out.png", "--json"],
    runGemini: async (args) => {
      calls.push({ kind: "gemini", args });
      return {
        savedImage: "D:\\docs\\out.png",
        model: "gemini-3.0-pro",
      };
    },
    runCleanup: async (imagePath) => {
      calls.push({ kind: "cleanup", imagePath });
      return {
        outputPath: imagePath,
      };
    },
  });

  assert.equal(result.savedImage, "D:\\docs\\out.png");
  assert.equal(result.watermarkRemoved, true);
  assert.deepEqual(calls, [
    { kind: "gemini", args: ["--prompt", "x", "--image", "out.png", "--json"] },
    { kind: "cleanup", imagePath: "D:\\docs\\out.png" },
  ]);
});

test("runGeminiGenerationWithCleanup skips cleanup when no image output exists", async () => {
  let cleanupCalled = false;
  const result = await runGeminiGenerationWithCleanup({
    args: ["--prompt", "x", "--json"],
    runGemini: async () => ({ text: "ok" }),
    runCleanup: async () => {
      cleanupCalled = true;
      return { outputPath: "" };
    },
  });

  assert.equal(result.watermarkRemoved, false);
  assert.equal(cleanupCalled, false);
});
