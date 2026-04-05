import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export interface TranscriptionSegment {
  start: string;     // "00:01:23.450"
  end: string;       // "00:01:27.890"
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptionSegment[];
  language?: string;
}

const MODEL_SIZES = ["tiny", "base", "small", "medium", "large"] as const;
export type ModelSize = (typeof MODEL_SIZES)[number];

async function findWhisperBinary(): Promise<string> {
  const candidates = ["whisper-cli", "whisper", "whisper-cpp"];
  for (const bin of candidates) {
    try {
      await execFileAsync("which", [bin]);
      return bin;
    } catch {
      // not found
    }
  }
  throw new Error(
    "whisper-cli not found. Install it with: brew install whisper-cpp"
  );
}

function findModelPath(modelSize: ModelSize): string {
  const filename = `ggml-${modelSize}.bin`;

  const searchPaths = [
    join(dirname(fileURLToPath(import.meta.url)), "..", "models", filename),
    join(
      process.env.HOME || "~",
      ".local",
      "share",
      "whisper-cpp",
      "models",
      filename
    ),
    join("/opt/homebrew/share/whisper-cpp/models", filename),
    ...(process.env.WHISPER_MODELS_DIR
      ? [join(process.env.WHISPER_MODELS_DIR, filename)]
      : []),
  ];

  for (const p of searchPaths) {
    if (existsSync(p)) return p;
  }

  throw new Error(
    `Whisper model '${filename}' not found.\n` +
      `Download it:\n` +
      `  curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${filename} -o models/${filename}\n` +
      `Searched: ${searchPaths.join(", ")}`
  );
}

/**
 * Parse whisper-cli timestamped output lines like:
 * [00:00:00.000 --> 00:00:05.000]   Hi, I'm Christine
 */
function parseTimestampedOutput(stdout: string): TranscriptionSegment[] {
  const segments: TranscriptionSegment[] = [];
  const lines = stdout.split("\n");

  for (const line of lines) {
    const match = line.match(
      /\[(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\]\s*(.*)/
    );
    if (match) {
      // Strip ANSI color codes that whisper-cli may emit
      const text = match[3].replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (text) {
        segments.push({
          start: match[1],
          end: match[2],
          startSeconds: timestampToSeconds(match[1]),
          endSeconds: timestampToSeconds(match[2]),
          text,
        });
      }
    }
  }

  return segments;
}

function timestampToSeconds(ts: string): number {
  const parts = ts.split(":");
  const h = parseFloat(parts[0]);
  const m = parseFloat(parts[1]);
  const s = parseFloat(parts[2]);
  return h * 3600 + m * 60 + s;
}

/**
 * Transcribe audio using local whisper-cli (whisper.cpp).
 * Returns timestamped segments so AI can reference specific moments.
 */
export async function transcribe(
  audioPath: string,
  modelSize: ModelSize = "base",
  language?: string
): Promise<TranscriptionResult> {
  const binary = await findWhisperBinary();
  const modelPath = findModelPath(modelSize);

  const args = [
    "-m", modelPath,
    "-f", audioPath,
    "-t", "4",
  ];
  if (language) args.push("-l", language);

  const { stdout, stderr } = await execFileAsync(binary, args, {
    timeout: 600_000,
    maxBuffer: 50 * 1024 * 1024,
  });

  const segments = parseTimestampedOutput(stdout);

  const fullText = segments.map((s) => s.text).join(" ");

  const langMatch = stderr.match(/auto-detected language: (\w+)/);

  return {
    text: fullText || "(no speech detected)",
    segments,
    language: language || langMatch?.[1],
  };
}
