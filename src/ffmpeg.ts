import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export interface VideoMetadata {
  format: string;
  duration: string;
  durationSeconds: number;
  size: string;
  bitRate: string;
  streams: StreamInfo[];
}

export interface StreamInfo {
  index: number;
  codecType: string;
  codecName: string;
  width?: number;
  height?: number;
  frameRate?: string;
  sampleRate?: string;
  channels?: number;
}

export interface TimestampedFrame {
  timestamp: string;      // "00:01:23"
  timestampSeconds: number;
  data: Buffer;
}

export async function getVideoMetadata(filePath: string): Promise<VideoMetadata> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  const data = JSON.parse(stdout);
  const format = data.format;
  const streams: StreamInfo[] = (data.streams || []).map((s: any) => {
    const info: StreamInfo = {
      index: s.index,
      codecType: s.codec_type,
      codecName: s.codec_name,
    };
    if (s.codec_type === "video") {
      info.width = s.width;
      info.height = s.height;
      info.frameRate = s.r_frame_rate;
    }
    if (s.codec_type === "audio") {
      info.sampleRate = s.sample_rate;
      info.channels = s.channels;
    }
    return info;
  });

  return {
    format: format.format_long_name || format.format_name,
    duration: formatDuration(parseFloat(format.duration || "0")),
    durationSeconds: parseFloat(format.duration || "0"),
    size: formatBytes(parseInt(format.size || "0", 10)),
    bitRate: format.bit_rate
      ? `${Math.round(parseInt(format.bit_rate, 10) / 1000)} kbps`
      : "unknown",
    streams,
  };
}

export async function extractAudio(
  filePath: string,
  outputFormat: "wav" | "mp3" = "wav"
): Promise<{ audioPath: string; tempDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), "mov-transcriber-"));
  const audioPath = join(tempDir, `audio.${outputFormat}`);

  await execFileAsync("ffmpeg", [
    "-i", filePath,
    "-vn",
    "-acodec", outputFormat === "wav" ? "pcm_s16le" : "libmp3lame",
    "-ar", "16000",
    "-ac", "1",
    "-y",
    audioPath,
  ]);

  return { audioPath, tempDir };
}

/**
 * Extract frames at specific timestamps (in seconds).
 * Returns each frame with its timestamp for time-correlated analysis.
 */
export async function extractFramesAtTimestamps(
  filePath: string,
  timestamps: number[]
): Promise<{ frames: TimestampedFrame[]; tempDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), "mov-frames-"));
  const frames: TimestampedFrame[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const framePath = join(tempDir, `frame_${i}.jpg`);

    await execFileAsync("ffmpeg", [
      "-ss", ts.toFixed(2),
      "-i", filePath,
      "-vframes", "1",
      "-q:v", "2",
      "-y",
      framePath,
    ]);

    frames.push({
      timestamp: formatDuration(ts),
      timestampSeconds: ts,
      data: await readFile(framePath),
    });
  }

  return { frames, tempDir };
}

/**
 * Extract evenly-spaced frames across the video duration.
 * Each frame includes its timestamp.
 */
export async function extractFrames(
  filePath: string,
  count: number = 4
): Promise<{ frames: TimestampedFrame[]; tempDir: string }> {
  const metadata = await getVideoMetadata(filePath);
  const duration = metadata.durationSeconds;

  if (duration <= 0) {
    throw new Error("Could not determine video duration");
  }

  const interval = duration / (count + 1);
  const timestamps = Array.from({ length: count }, (_, i) => interval * (i + 1));

  return extractFramesAtTimestamps(filePath, timestamps);
}

/**
 * Detect scene changes in the video.
 * Returns timestamps where significant visual changes occur.
 */
export async function detectSceneChanges(
  filePath: string,
  threshold: number = 0.3
): Promise<number[]> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-show_entries", "frame=pts_time",
    "-of", "csv=p=0",
    "-f", "lavfi",
    `movie=${filePath},select='gt(scene\\,${threshold})'`,
  ], { timeout: 300_000, maxBuffer: 50 * 1024 * 1024 });

  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => parseFloat(line.trim()))
    .filter((n) => !isNaN(n));
}

/**
 * Analyze audio levels over time to detect speech vs silence.
 * Returns segments with their average volume in dB.
 */
export async function analyzeAudioLevels(
  filePath: string,
  segmentDuration: number = 5
): Promise<Array<{ startSeconds: number; endSeconds: number; start: string; end: string; volumeDb: number; isSilent: boolean }>> {
  const metadata = await getVideoMetadata(filePath);
  const duration = metadata.durationSeconds;
  const segments: Array<{ startSeconds: number; endSeconds: number; start: string; end: string; volumeDb: number; isSilent: boolean }> = [];

  for (let t = 0; t < duration; t += segmentDuration) {
    const segEnd = Math.min(t + segmentDuration, duration);

    try {
      const { stderr } = await execFileAsync("ffmpeg", [
        "-ss", t.toFixed(2),
        "-i", filePath,
        "-t", (segEnd - t).toFixed(2),
        "-af", "volumedetect",
        "-f", "null",
        "-",
      ]);

      const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
      const volumeDb = meanMatch ? parseFloat(meanMatch[1]) : -91;

      segments.push({
        startSeconds: t,
        endSeconds: segEnd,
        start: formatDuration(t),
        end: formatDuration(segEnd),
        volumeDb,
        isSilent: volumeDb < -40,
      });
    } catch {
      segments.push({
        startSeconds: t,
        endSeconds: segEnd,
        start: formatDuration(t),
        end: formatDuration(segEnd),
        volumeDb: -91,
        isSilent: true,
      });
    }
  }

  return segments;
}

export async function cleanupTemp(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true });
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}
