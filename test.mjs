// End-to-end test harness for mov-transcriber MCP server
// Sends JSON-RPC requests over stdio and validates responses

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const SERVER = resolve("dist/index.js");
const TEST_FILE = resolve("IMG_7336.MOV");

let requestId = 0;
const pending = new Map();
let buffer = "";

function startServer() {
  const proc = spawn("node", [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    // MCP uses newline-delimited JSON
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const cb = pending.get(msg.id);
        if (cb) {
          pending.delete(msg.id);
          cb(msg);
        }
      } catch (e) {
        // not JSON, skip
      }
    }
  });

  return proc;
}

function send(proc, method, params) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const msg = { jsonrpc: "2.0", id, method, params };
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify(msg) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }
    }, 300_000); // 5 min timeout for transcription
  });
}

function assert(condition, msg) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

async function runTests() {
  console.log("Starting MCP server...\n");
  const proc = startServer();

  try {
    // ---- 1. Initialize ----
    console.log("=== Test 1: Initialize ===");
    const initResp = await send(proc, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    assert(initResp.result, "Server initialized");
    assert(initResp.result.serverInfo?.name === "mov-transcriber", `Server name: ${initResp.result.serverInfo?.name}`);
    console.log();

    // Send initialized notification
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    // ---- 2. List tools ----
    console.log("=== Test 2: List Tools ===");
    const toolsResp = await send(proc, "tools/list", {});
    const tools = toolsResp.result?.tools || [];
    const toolNames = tools.map((t) => t.name);
    console.log(`  Found ${tools.length} tools: ${toolNames.join(", ")}`);
    assert(toolNames.includes("transcribe_video"), "Has transcribe_video");
    assert(toolNames.includes("get_video_metadata"), "Has get_video_metadata");
    assert(toolNames.includes("extract_video_frames"), "Has extract_video_frames");
    assert(toolNames.includes("analyze_video"), "Has analyze_video");
    assert(toolNames.includes("check_setup"), "Has check_setup");
    console.log();

    // ---- 3. check_setup ----
    console.log("=== Test 3: check_setup ===");
    const setupResp = await send(proc, "tools/call", {
      name: "check_setup",
      arguments: {},
    });
    const setupData = JSON.parse(setupResp.result.content[0].text);
    console.log(`  Status: ${setupData.status}`);
    assert(setupData.ffmpeg === true, "ffmpeg found");
    assert(setupData.ffprobe === true, "ffprobe found");
    assert(setupData.whisper === true, `whisper found (${setupData.whisperBinary})`);
    assert(setupData.model === true, "model found");
    assert(setupData.errors.length === 0, `No errors: ${JSON.stringify(setupData.errors)}`);
    console.log();

    // ---- 4. get_video_metadata ----
    console.log("=== Test 4: get_video_metadata ===");
    const metaResp = await send(proc, "tools/call", {
      name: "get_video_metadata",
      arguments: { file_path: TEST_FILE },
    });
    const meta = JSON.parse(metaResp.result.content[0].text);
    console.log(`  Duration: ${meta.duration} (${meta.durationSeconds}s)`);
    console.log(`  Format: ${meta.format}`);
    console.log(`  Size: ${meta.size}`);
    console.log(`  Bitrate: ${meta.bitRate}`);
    console.log(`  Streams: ${meta.streams.length}`);
    assert(meta.durationSeconds > 0, `Duration > 0: ${meta.durationSeconds}s`);
    assert(meta.streams.length >= 2, `Has video+audio streams: ${meta.streams.length}`);
    const videoStream = meta.streams.find((s) => s.codecType === "video");
    const audioStream = meta.streams.find((s) => s.codecType === "audio");
    assert(videoStream, "Has video stream");
    assert(audioStream, "Has audio stream");
    assert(videoStream?.width === 1920, `Resolution: ${videoStream?.width}x${videoStream?.height}`);
    console.log();

    // ---- 5. get_video_metadata with bad path ----
    console.log("=== Test 5: Error handling (bad file path) ===");
    const badResp = await send(proc, "tools/call", {
      name: "get_video_metadata",
      arguments: { file_path: "/nonexistent/file.mov" },
    });
    assert(badResp.result.isError === true, "Returns error for missing file");
    console.log();

    // ---- 6. transcribe_video ----
    console.log("=== Test 6: transcribe_video ===");
    console.log("  (this may take a few seconds...)");
    const txResp = await send(proc, "tools/call", {
      name: "transcribe_video",
      arguments: { file_path: TEST_FILE },
    });
    const txData = JSON.parse(txResp.result.content[0].text);
    console.log(`  Segments: ${txData.segments.length}`);
    console.log(`  Language: ${txData.language}`);
    console.log(`  First segment: [${txData.segments[0]?.start} → ${txData.segments[0]?.end}] ${txData.segments[0]?.text?.substring(0, 60)}...`);
    console.log(`  Full text length: ${txData.transcription.length} chars`);
    assert(txData.segments.length > 0, `Has segments: ${txData.segments.length}`);
    assert(txData.transcription.length > 100, `Has substantial text: ${txData.transcription.length} chars`);
    assert(txData.segments[0].start !== undefined, "Segments have start timestamps");
    assert(txData.segments[0].end !== undefined, "Segments have end timestamps");
    assert(typeof txData.segments[0].startSeconds === "number", "Segments have startSeconds");
    assert(typeof txData.segments[0].endSeconds === "number", "Segments have endSeconds");
    assert(txData.transcription.toLowerCase().includes("christine"), "Transcript contains expected content");
    assert(txData.video.duration, `Video duration included: ${txData.video.duration}`);
    console.log();

    // ---- 7. extract_video_frames (evenly spaced) ----
    console.log("=== Test 7: extract_video_frames (evenly spaced) ===");
    const framesResp = await send(proc, "tools/call", {
      name: "extract_video_frames",
      arguments: { file_path: TEST_FILE, count: 3 },
    });
    const framesContent = framesResp.result.content;
    const imageBlocks = framesContent.filter((c) => c.type === "image");
    const textBlocks = framesContent.filter((c) => c.type === "text");
    console.log(`  Content blocks: ${framesContent.length} (${imageBlocks.length} images, ${textBlocks.length} text)`);
    assert(imageBlocks.length === 3, `Got 3 frames: ${imageBlocks.length}`);
    assert(imageBlocks[0].mimeType === "image/jpeg", "Frames are JPEG");
    assert(imageBlocks[0].data.length > 1000, `Frame has data: ${imageBlocks[0].data.length} chars base64`);
    // Check timestamp labels
    const frameLabelTexts = textBlocks.filter((t) => t.text.includes("Frame at"));
    assert(frameLabelTexts.length === 3, `Each frame has timestamp label: ${frameLabelTexts.length}`);
    console.log(`  Frame labels: ${frameLabelTexts.map((t) => t.text.trim()).join(" | ")}`);
    console.log();

    // ---- 8. extract_video_frames (specific timestamps) ----
    console.log("=== Test 8: extract_video_frames (specific timestamps) ===");
    const tsFramesResp = await send(proc, "tools/call", {
      name: "extract_video_frames",
      arguments: { file_path: TEST_FILE, timestamps: [10, 60, 120] },
    });
    const tsImages = tsFramesResp.result.content.filter((c) => c.type === "image");
    const tsLabels = tsFramesResp.result.content.filter((c) => c.text?.includes("Frame at"));
    assert(tsImages.length === 3, `Got 3 frames at specific times: ${tsImages.length}`);
    assert(tsLabels.some((t) => t.text.includes("10.0s")), "Has frame at 10s");
    assert(tsLabels.some((t) => t.text.includes("60.0s")), "Has frame at 60s");
    assert(tsLabels.some((t) => t.text.includes("120.0s")), "Has frame at 120s");
    console.log(`  Timestamp labels: ${tsLabels.map((t) => t.text.trim()).join(" | ")}`);
    console.log();

    // ---- 9. analyze_video (full analysis) ----
    console.log("=== Test 9: analyze_video (full analysis) ===");
    console.log("  (this runs transcription + audio analysis + frame extraction...)");
    const analyzeResp = await send(proc, "tools/call", {
      name: "analyze_video",
      arguments: { file_path: TEST_FILE, frame_count: 4 },
    });
    const analyzeContent = analyzeResp.result.content;
    const analyzeImages = analyzeContent.filter((c) => c.type === "image");
    const analyzeTexts = analyzeContent.filter((c) => c.type === "text");
    const headerText = analyzeTexts[0]?.text || "";
    console.log(`  Content blocks: ${analyzeContent.length} (${analyzeImages.length} images, ${analyzeTexts.length} text)`);
    assert(analyzeImages.length === 4, `Got 4 analysis frames: ${analyzeImages.length}`);
    assert(headerText.includes("# Video Analysis"), "Has analysis header");
    assert(headerText.includes("## Timestamped Transcript"), "Has transcript section");
    assert(headerText.includes("## Audio Activity"), "Has audio activity section");
    assert(headerText.includes("## Visual Frames"), "Has visual frames section");
    // Check transcript has timestamps
    const timestampMatches = headerText.match(/\*\*\[\d{2}:\d{2}:\d{2}\.\d{3} → \d{2}:\d{2}:\d{2}\.\d{3}\]\*\*/g);
    assert(timestampMatches && timestampMatches.length > 5, `Transcript has timestamped segments: ${timestampMatches?.length}`);
    // Check audio levels
    const audioMatches = headerText.match(/dB/g);
    assert(audioMatches && audioMatches.length > 5, `Audio levels present: ${audioMatches?.length} entries`);
    // Check frame cross-references
    const speakingRefs = analyzeTexts.filter((t) => t.text?.includes("Speaking:"));
    assert(speakingRefs.length > 0, `Frames cross-reference transcript: ${speakingRefs.length} refs`);
    console.log(`  Transcript segments: ${timestampMatches?.length}`);
    console.log(`  Audio level readings: ${audioMatches?.length}`);
    console.log(`  Frame-transcript cross-refs: ${speakingRefs.length}`);
    console.log();

    // ---- Summary ----
    console.log("=== ALL TESTS COMPLETE ===");

  } catch (err) {
    console.error(`\nTEST ERROR: ${err.message}`);
    process.exitCode = 1;
  } finally {
    proc.kill();
  }
}

runTests();
