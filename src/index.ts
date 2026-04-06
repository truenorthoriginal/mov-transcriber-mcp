#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer } from "node:http";
import { access, writeFile, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  getVideoMetadata,
  extractAudio,
  extractFrames,
  extractFramesAtTimestamps,
  analyzeAudioLevels,
  cleanupTemp,
  formatDuration,
} from "./ffmpeg.js";
import { transcribe } from "./transcribe.js";
import { preflight, ensureModel } from "./setup.js";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const useHttp = args.includes("--http") || args.includes("--sse") || !!process.env.PORT;
const portArg = args.find((a) => a.startsWith("--port="));
const HTTP_PORT = parseInt(process.env.PORT || "", 10) || (portArg ? parseInt(portArg.split("=")[1], 10) : 3100);

// ---------------------------------------------------------------------------
// Build the MCP server with all tools
// ---------------------------------------------------------------------------
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "mov-transcriber",
    version: "1.0.0",
  });

  // ---- Tool: transcribe_video ----
  server.tool(
    "transcribe_video",
    "Transcribe speech from a video file to timestamped text segments. " +
      "Each segment includes start/end times so you can reference specific moments. " +
      "Uses whisper.cpp locally — free, no API keys needed.",
    {
      file_path: z
        .string()
        .describe("Absolute path to the .MOV or video file to transcribe"),
      language: z
        .string()
        .optional()
        .describe(
          "ISO 639-1 language code (e.g. 'en', 'es', 'fr'). Auto-detected if omitted."
        ),
      model_size: z
        .enum(["tiny", "base", "small", "medium", "large"])
        .optional()
        .describe(
          "Whisper model size (default: base). Larger = more accurate but slower."
        ),
    },
    async ({ file_path, language, model_size }) => {
      const resolvedPath = resolve(file_path);
      await assertFileExists(resolvedPath);
      await ensureModel(model_size || "base");

      let tempDir: string | undefined;
      try {
        const extraction = await extractAudio(resolvedPath);
        tempDir = extraction.tempDir;

        const result = await transcribe(
          extraction.audioPath,
          model_size || "base",
          language
        );
        const metadata = await getVideoMetadata(resolvedPath);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  transcription: result.text,
                  segments: result.segments,
                  language: result.language || "auto-detected",
                  video: {
                    duration: metadata.duration,
                    durationSeconds: metadata.durationSeconds,
                    format: metadata.format,
                    size: metadata.size,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      } finally {
        if (tempDir) await cleanupTemp(tempDir);
      }
    }
  );

  // ---- Tool: get_video_metadata ----
  server.tool(
    "get_video_metadata",
    "Get detailed metadata from a video file including duration, " +
      "resolution, codecs, bitrate, and stream information.",
    {
      file_path: z
        .string()
        .describe("Absolute path to the .MOV or video file"),
    },
    async ({ file_path }) => {
      const resolvedPath = resolve(file_path);
      await assertFileExists(resolvedPath);
      const metadata = await getVideoMetadata(resolvedPath);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(metadata, null, 2) },
        ],
      };
    }
  );

  // ---- Tool: extract_video_frames ----
  server.tool(
    "extract_video_frames",
    "Extract keyframes from a video as JPEG images, each labeled with its timestamp. " +
      "Can extract evenly-spaced frames or frames at specific times.",
    {
      file_path: z
        .string()
        .describe("Absolute path to the .MOV or video file"),
      count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(
          "Number of evenly-spaced frames (default: 4, max: 20). Ignored if timestamps provided."
        ),
      timestamps: z
        .array(z.number())
        .optional()
        .describe(
          "Specific timestamps (in seconds) to extract frames at. Overrides count."
        ),
    },
    async ({ file_path, count, timestamps }) => {
      const resolvedPath = resolve(file_path);
      await assertFileExists(resolvedPath);

      const { frames, tempDir } = timestamps
        ? await extractFramesAtTimestamps(resolvedPath, timestamps)
        : await extractFrames(resolvedPath, count || 4);

      try {
        const metadata = await getVideoMetadata(resolvedPath);
        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [];

        const videoStream = metadata.streams.find(
          (s) => s.codecType === "video"
        );
        content.push({
          type: "text" as const,
          text: `Extracted ${frames.length} frames from ${metadata.duration} video (${metadata.size}, ${videoStream?.width}x${videoStream?.height})`,
        });

        for (const frame of frames) {
          content.push({
            type: "text" as const,
            text: `--- Frame at ${frame.timestamp} (${frame.timestampSeconds.toFixed(1)}s) ---`,
          });
          content.push({
            type: "image" as const,
            data: frame.data.toString("base64"),
            mimeType: "image/jpeg",
          });
        }

        return { content };
      } finally {
        await cleanupTemp(tempDir);
      }
    }
  );

  // ---- Tool: analyze_video ----
  server.tool(
    "analyze_video",
    "Full video analysis: transcribes speech with timestamps, extracts frames at key moments, " +
      "and analyzes audio levels. Returns a time-correlated timeline combining what was said, " +
      "what was shown, and audio activity — so you can give time-specific recommendations.",
    {
      file_path: z
        .string()
        .describe("Absolute path to the .MOV or video file"),
      frame_count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Number of frames for visual analysis (default: 6)"),
      language: z
        .string()
        .optional()
        .describe("ISO 639-1 language code. Auto-detected if omitted."),
      model_size: z
        .enum(["tiny", "base", "small", "medium", "large"])
        .optional()
        .describe("Whisper model size (default: base)."),
    },
    async ({ file_path, frame_count, language, model_size }) => {
      const resolvedPath = resolve(file_path);
      await assertFileExists(resolvedPath);
      await ensureModel(model_size || "base");

      let audioTempDir: string | undefined;
      let frameTempDir: string | undefined;

      try {
        const metadata = await getVideoMetadata(resolvedPath);

        const extraction = await extractAudio(resolvedPath);
        audioTempDir = extraction.tempDir;

        const transcription = await transcribe(
          extraction.audioPath,
          model_size || "base",
          language
        );

        const audioLevels = await analyzeAudioLevels(resolvedPath);

        const numFrames = frame_count || 6;
        let frameTimestamps: number[];

        if (transcription.segments.length >= numFrames) {
          const step = Math.floor(
            transcription.segments.length / numFrames
          );
          frameTimestamps = Array.from(
            { length: numFrames },
            (_, i) =>
              transcription.segments[
                Math.min(i * step, transcription.segments.length - 1)
              ].startSeconds
          );
        } else {
          const interval = metadata.durationSeconds / (numFrames + 1);
          frameTimestamps = Array.from(
            { length: numFrames },
            (_, i) => interval * (i + 1)
          );
        }

        const { frames, tempDir } = await extractFramesAtTimestamps(
          resolvedPath,
          frameTimestamps
        );
        frameTempDir = tempDir;

        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [];

        const videoStream = metadata.streams.find(
          (s) => s.codecType === "video"
        );
        content.push({
          type: "text" as const,
          text: [
            `# Video Analysis: ${resolvedPath.split("/").pop()}`,
            ``,
            `**Duration:** ${metadata.duration} | **Resolution:** ${videoStream?.width}x${videoStream?.height} | **Size:** ${metadata.size}`,
            `**Format:** ${metadata.format} | **Bitrate:** ${metadata.bitRate}`,
            `**Language:** ${transcription.language || "auto-detected"}`,
            ``,
            `## Timestamped Transcript`,
            ``,
            ...transcription.segments.map(
              (seg) => `**[${seg.start} → ${seg.end}]** ${seg.text}`
            ),
            ``,
            `## Audio Activity`,
            ``,
            ...audioLevels.map((seg) => {
              const bar = seg.isSilent
                ? "silent"
                : "speech".repeat(
                    Math.min(
                      3,
                      Math.max(1, Math.round((seg.volumeDb + 50) / 10))
                    )
                  );
              return `**${seg.start} → ${seg.end}** [${bar}] ${seg.volumeDb.toFixed(1)} dB${seg.isSilent ? " (silent)" : ""}`;
            }),
            ``,
            `## Visual Frames`,
            ``,
            `Each frame is labeled with its timestamp. Cross-reference with the transcript above.`,
          ].join("\n"),
        });

        for (const frame of frames) {
          const matchingSeg = transcription.segments.find(
            (seg) =>
              frame.timestampSeconds >= seg.startSeconds &&
              frame.timestampSeconds <= seg.endSeconds
          );
          const spokenAt = matchingSeg
            ? `Speaking: "${matchingSeg.text}"`
            : "(no speech at this moment)";

          content.push({
            type: "text" as const,
            text: `\n### Frame at ${frame.timestamp} (${frame.timestampSeconds.toFixed(1)}s)\n${spokenAt}`,
          });
          content.push({
            type: "image" as const,
            data: frame.data.toString("base64"),
            mimeType: "image/jpeg",
          });
        }

        return { content };
      } finally {
        if (audioTempDir) await cleanupTemp(audioTempDir);
        if (frameTempDir) await cleanupTemp(frameTempDir);
      }
    }
  );

  // ---- Tool: check_setup ----
  server.tool(
    "check_setup",
    "Check that all dependencies (ffmpeg, whisper-cli, model files) are installed. " +
      "Run this if transcription fails to diagnose missing dependencies.",
    {},
    async () => {
      const result = await preflight();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: result.errors.length === 0 ? "ready" : "missing_deps",
                ffmpeg: result.ffmpeg,
                ffprobe: result.ffprobe,
                whisper: result.whisper,
                whisperBinary: result.whisperBinary,
                model: result.model,
                modelPath: result.modelPath,
                errors: result.errors,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ---- Tool: transcribe_video_url ----
  server.tool(
    "transcribe_video_url",
    "Transcribe speech from a video at a URL. Downloads the video server-side, then transcribes. " +
      "Use this in Cowork when a video has been uploaded and you have its URL.",
    {
      url: z
        .string()
        .describe("URL to the video file (http or https)"),
      language: z
        .string()
        .optional()
        .describe("ISO 639-1 language code. Auto-detected if omitted."),
      model_size: z
        .enum(["tiny", "base", "small", "medium", "large"])
        .optional()
        .describe("Whisper model size (default: base)."),
    },
    async ({ url, language, model_size }) => {
      await ensureModel(model_size || "base");
      const { videoPath, tempDir } = await downloadVideo(url);
      let audioTempDir: string | undefined;

      try {
        const extraction = await extractAudio(videoPath);
        audioTempDir = extraction.tempDir;

        const result = await transcribe(extraction.audioPath, model_size || "base", language);
        const metadata = await getVideoMetadata(videoPath);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  transcription: result.text,
                  segments: result.segments,
                  language: result.language || "auto-detected",
                  video: {
                    duration: metadata.duration,
                    durationSeconds: metadata.durationSeconds,
                    format: metadata.format,
                    size: metadata.size,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      } finally {
        await cleanupTemp(tempDir);
        if (audioTempDir) await cleanupTemp(audioTempDir);
      }
    }
  );

  // ---- Tool: analyze_video_url ----
  server.tool(
    "analyze_video_url",
    "Full video analysis from a URL: downloads the video, transcribes speech with timestamps, " +
      "extracts frames at key moments, and analyzes audio levels. " +
      "Use this in Cowork when a video has been uploaded and you have its URL.",
    {
      url: z
        .string()
        .describe("URL to the video file (http or https)"),
      frame_count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Number of frames for visual analysis (default: 6)"),
      language: z
        .string()
        .optional()
        .describe("ISO 639-1 language code. Auto-detected if omitted."),
      model_size: z
        .enum(["tiny", "base", "small", "medium", "large"])
        .optional()
        .describe("Whisper model size (default: base)."),
    },
    async ({ url, frame_count, language, model_size }) => {
      await ensureModel(model_size || "base");
      const { videoPath, tempDir: uploadDir } = await downloadVideo(url);

      let audioTempDir: string | undefined;
      let frameTempDir: string | undefined;

      try {
        const metadata = await getVideoMetadata(videoPath);
        const extraction = await extractAudio(videoPath);
        audioTempDir = extraction.tempDir;

        const transcription = await transcribe(extraction.audioPath, model_size || "base", language);
        const audioLevels = await analyzeAudioLevels(videoPath);

        const numFrames = frame_count || 6;
        let frameTimestamps: number[];

        if (transcription.segments.length >= numFrames) {
          const step = Math.floor(transcription.segments.length / numFrames);
          frameTimestamps = Array.from(
            { length: numFrames },
            (_, i) =>
              transcription.segments[
                Math.min(i * step, transcription.segments.length - 1)
              ].startSeconds
          );
        } else {
          const interval = metadata.durationSeconds / (numFrames + 1);
          frameTimestamps = Array.from(
            { length: numFrames },
            (_, i) => interval * (i + 1)
          );
        }

        const { frames, tempDir } = await extractFramesAtTimestamps(videoPath, frameTimestamps);
        frameTempDir = tempDir;

        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [];

        const videoStream = metadata.streams.find((s) => s.codecType === "video");
        content.push({
          type: "text" as const,
          text: [
            `# Video Analysis: ${url.split("/").pop() || "video"}`,
            ``,
            `**Duration:** ${metadata.duration} | **Resolution:** ${videoStream?.width}x${videoStream?.height} | **Size:** ${metadata.size}`,
            `**Format:** ${metadata.format} | **Bitrate:** ${metadata.bitRate}`,
            `**Language:** ${transcription.language || "auto-detected"}`,
            ``,
            `## Timestamped Transcript`,
            ``,
            ...transcription.segments.map(
              (seg) => `**[${seg.start} → ${seg.end}]** ${seg.text}`
            ),
            ``,
            `## Audio Activity`,
            ``,
            ...audioLevels.map((seg) => {
              const bar = seg.isSilent
                ? "silent"
                : "speech".repeat(Math.min(3, Math.max(1, Math.round((seg.volumeDb + 50) / 10))));
              return `**${seg.start} → ${seg.end}** [${bar}] ${seg.volumeDb.toFixed(1)} dB${seg.isSilent ? " (silent)" : ""}`;
            }),
            ``,
            `## Visual Frames`,
            ``,
            `Each frame is labeled with its timestamp. Cross-reference with the transcript above.`,
          ].join("\n"),
        });

        for (const frame of frames) {
          const matchingSeg = transcription.segments.find(
            (seg) =>
              frame.timestampSeconds >= seg.startSeconds &&
              frame.timestampSeconds <= seg.endSeconds
          );
          const spokenAt = matchingSeg
            ? `Speaking: "${matchingSeg.text}"`
            : "(no speech at this moment)";

          content.push({
            type: "text" as const,
            text: `\n### Frame at ${frame.timestamp} (${frame.timestampSeconds.toFixed(1)}s)\n${spokenAt}`,
          });
          content.push({
            type: "image" as const,
            data: frame.data.toString("base64"),
            mimeType: "image/jpeg",
          });
        }

        return { content };
      } finally {
        await cleanupTemp(uploadDir);
        if (audioTempDir) await cleanupTemp(audioTempDir);
        if (frameTempDir) await cleanupTemp(frameTempDir);
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function downloadVideo(url: string): Promise<{ videoPath: string; tempDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), "mov-download-"));
  // Extract filename from URL or default to video.mov
  const urlPath = new URL(url).pathname;
  const filename = urlPath.split("/").pop() || "video.mov";
  const videoPath = join(tempDir, filename);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download video: HTTP ${response.status} from ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(videoPath, buffer);

  return { videoPath, tempDir };
}

async function assertFileExists(filePath: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
}

// ---------------------------------------------------------------------------
// Start: stdio or HTTP
// ---------------------------------------------------------------------------
async function main() {
  const mcpServer = createMcpServer();

  if (useHttp) {
    await startHttpServer(mcpServer, HTTP_PORT);
  } else {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error("[mov-transcriber] MCP server running on stdio");
  }
}

async function startHttpServer(_unused: McpServer, port: number) {
  // Session-based: Cowork maintains a session across init → tools/list → tool calls
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  const httpServer = createServer(async (req, res) => {
    // CORS headers for Cowork
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (req.url === "/health" && req.method === "GET") {
      const check = await preflight();
      res.writeHead(check.errors.length === 0 ? 200 : 503, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          status: check.errors.length === 0 ? "healthy" : "degraded",
          errors: check.errors,
          activeSessions: sessions.size,
        })
      );
      return;
    }

    // Upload endpoint — accepts raw video POST, saves to temp, returns server path
    // Cowork or any client can POST a video here, then use the returned path with the MCP tools
    if (req.url === "/upload" && req.method === "POST") {
      const uploadDir = await mkdtemp(join(tmpdir(), "mov-upload-"));
      const filename = (req.headers["x-filename"] as string) || "video.mov";
      const videoPath = join(uploadDir, filename);

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      await writeFile(videoPath, Buffer.concat(chunks));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        file_path: videoPath,
        size: Buffer.concat(chunks).length,
        message: "File uploaded. Use this file_path with transcribe_video or analyze_video tools.",
      }));
      return;
    }

    // MCP endpoint
    if (req.url === "/mcp" || req.url === "/") {
      // Read request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const body = Buffer.concat(chunks).toString();
      let parsedBody: unknown;
      try {
        parsedBody = body ? JSON.parse(body) : undefined;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      // Check for existing session
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        // Existing session — route to its transport
        const session = sessions.get(sessionId)!;
        await session.transport.handleRequest(req, res, parsedBody);
        return;
      }

      // Check if this is an initialize request (new session)
      if (isInitializeRequest(parsedBody)) {
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        });

        await server.connect(transport);

        // Store session when transport assigns an ID
        const onSessionId = (id: string) => {
          sessions.set(id, { server, transport });
          console.error(`[mov-transcriber] Session created: ${id} (${sessions.size} active)`);
        };

        // The session ID is set during handleRequest for initialize
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
            console.error(`[mov-transcriber] Session closed: ${transport.sessionId} (${sessions.size} active)`);
          }
        };

        await transport.handleRequest(req, res, parsedBody);

        // After handling, the transport should have a session ID
        if (transport.sessionId) {
          onSessionId(transport.sessionId);
        }
        return;
      }

      // Non-initialize request without valid session
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No valid session. Send initialize first." }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use /mcp or /health" }));
  });

  // Clean up stale sessions every 10 minutes
  setInterval(() => {
    if (sessions.size > 100) {
      const oldest = [...sessions.entries()].slice(0, sessions.size - 50);
      for (const [id, session] of oldest) {
        session.transport.close().catch(() => {});
        session.server.close().catch(() => {});
        sessions.delete(id);
      }
      console.error(`[mov-transcriber] Cleaned ${oldest.length} stale sessions`);
    }
  }, 600_000);

  httpServer.listen(port, "0.0.0.0", () => {
    console.error(`[mov-transcriber] MCP server running on http://0.0.0.0:${port}/mcp`);
    console.error(`[mov-transcriber] Health check: http://0.0.0.0:${port}/health`);
  });
}

function isInitializeRequest(body: unknown): boolean {
  if (typeof body === "object" && body !== null && "method" in body) {
    return (body as any).method === "initialize";
  }
  if (Array.isArray(body)) {
    return body.some((msg) => msg.method === "initialize");
  }
  return false;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
