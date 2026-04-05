import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "node:https";

const execFileAsync = promisify(execFile);

const MODELS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "models");
const MODEL_BASE_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

interface PreflightResult {
  ffmpeg: boolean;
  ffprobe: boolean;
  whisper: boolean;
  whisperBinary: string | null;
  model: boolean;
  modelPath: string;
  errors: string[];
}

export async function preflight(modelSize: string = "base"): Promise<PreflightResult> {
  const errors: string[] = [];
  const modelFile = `ggml-${modelSize}.bin`;
  const modelPath = join(MODELS_DIR, modelFile);

  const ffmpeg = await binaryExists("ffmpeg");
  if (!ffmpeg) errors.push("ffmpeg not found. Install: brew install ffmpeg");

  const ffprobe = await binaryExists("ffprobe");
  if (!ffprobe) errors.push("ffprobe not found. Install: brew install ffmpeg");

  let whisper = false;
  let whisperBinary: string | null = null;
  for (const bin of ["whisper-cli", "whisper", "whisper-cpp"]) {
    if (await binaryExists(bin)) {
      whisper = true;
      whisperBinary = bin;
      break;
    }
  }
  if (!whisper) errors.push("whisper-cli not found. Install: brew install whisper-cpp");

  const model = existsSync(modelPath);
  if (!model) errors.push(`Whisper model not found at ${modelPath}`);

  return { ffmpeg, ffprobe, whisper, whisperBinary, model, modelPath, errors };
}

/**
 * Download the whisper model if not present.
 * Returns the path to the model file.
 */
export async function ensureModel(modelSize: string = "base"): Promise<string> {
  const modelFile = `ggml-${modelSize}.bin`;
  const modelPath = join(MODELS_DIR, modelFile);

  if (existsSync(modelPath)) return modelPath;

  console.error(`[mov-transcriber] Downloading Whisper ${modelSize} model...`);
  mkdirSync(MODELS_DIR, { recursive: true });

  const url = `${MODEL_BASE_URL}/${modelFile}`;
  await downloadFile(url, modelPath);

  console.error(`[mov-transcriber] Model downloaded to ${modelPath}`);
  return modelPath;
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);

    const request = (reqUrl: string) => {
      get(reqUrl, (response) => {
        // Follow redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          const location = response.headers.location;
          if (location) {
            request(location);
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }

        const totalBytes = parseInt(response.headers["content-length"] || "0", 10);
        let downloaded = 0;

        response.on("data", (chunk: Buffer) => {
          downloaded += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.round((downloaded / totalBytes) * 100);
            process.stderr.write(`\r[mov-transcriber] Downloading... ${pct}%`);
          }
        });

        response.pipe(file);
        file.on("finish", () => {
          process.stderr.write("\n");
          file.close();
          resolve();
        });
      }).on("error", (err) => {
        reject(err);
      });
    };

    request(url);
  });
}

async function binaryExists(name: string): Promise<boolean> {
  try {
    await execFileAsync("which", [name]);
    return true;
  } catch {
    return false;
  }
}
