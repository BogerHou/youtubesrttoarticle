import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export function extractRequestedImagePath(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--image") {
      const next = args[index + 1];
      return next && !next.startsWith("-") ? next : "generated.png";
    }
    if (arg.startsWith("--image=")) {
      return arg.slice("--image=".length) || "generated.png";
    }
  }
  return null;
}

export function ensureJsonMode(args) {
  return args.includes("--json") ? [...args] : [...args, "--json"];
}

export function resolveNpxCommand(platform = process.platform) {
  return platform === "win32" ? "npx.cmd" : "npx";
}

export function shouldUseShellForCommand(command, platform = process.platform) {
  return platform === "win32" && command.toLowerCase().endsWith(".cmd");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: shouldUseShellForCommand(command),
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

async function defaultRunGemini(args) {
  const commandArgs = [
    "-y",
    "bun",
    ".baoyu-upstream\\skills\\baoyu-danger-gemini-web\\scripts\\main.ts",
    ...ensureJsonMode(args),
  ];
  const { stdout } = await runCommand(resolveNpxCommand(), commandArgs);
  return JSON.parse(stdout);
}

async function defaultRunCleanup(imagePath) {
  const scriptPath = path.resolve("scripts", "remove_gemini_watermark.py");
  const { stdout } = await runCommand("python", [scriptPath, imagePath]);
  return {
    outputPath: stdout.trim() || imagePath,
  };
}

export async function runGeminiGenerationWithCleanup({
  args,
  runGemini = defaultRunGemini,
  runCleanup = defaultRunCleanup,
}) {
  const jsonArgs = ensureJsonMode(args);
  const result = await runGemini(jsonArgs);

  if (!result?.savedImage) {
    return {
      ...result,
      watermarkRemoved: false,
    };
  }

  const cleanupResult = await runCleanup(result.savedImage);
  return {
    ...result,
    savedImage: cleanupResult.outputPath || result.savedImage,
    watermarkRemoved: true,
  };
}

async function main(argv = process.argv) {
  const args = argv.slice(2);
  const result = await runGeminiGenerationWithCleanup({ args });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
