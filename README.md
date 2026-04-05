# mov-transcriber-mcp

MCP server that transcribes and analyzes .MOV (and other video) files with timestamped output. Uses **whisper.cpp** for free, local speech-to-text and **ffmpeg** for video processing — no API keys or paid services.

## Tools

| Tool | Description |
|------|-------------|
| `transcribe_video` | Speech-to-text with **timestamped segments** (`[00:01:23 → 00:01:27] text`). |
| `get_video_metadata` | Duration, resolution, codecs, bitrate, stream info. |
| `extract_video_frames` | Pulls keyframes as JPEGs, each labeled with its timestamp. Supports specific timestamps. |
| `analyze_video` | **Full analysis**: timestamped transcript + audio levels + visual frames, cross-referenced so AI can say *"at 1:23 the lighting is poor while you discuss X"*. |
| `check_setup` | Diagnose missing dependencies. |

## Install & Deploy

### Option 1: npm (for CLI + Cowork via npx)

```bash
npm install -g mov-transcriber-mcp
```

Or run without installing:

```bash
npx mov-transcriber-mcp
```

### Option 2: Clone from GitHub

```bash
git clone https://github.com/YOUR_USER/mov-transcriber-mcp.git
cd mov-transcriber-mcp
npm install && npm run build
```

### Prerequisites (all free)

```bash
brew install ffmpeg whisper-cpp
```

The Whisper model (~141MB) auto-downloads on first transcription.

## Use in Claude Code (CLI)

**Auto-detect** — just open Claude Code in this directory. The `.mcp.json` file registers the server automatically.

**Global install** — add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "mov-transcriber": {
      "command": "npx",
      "args": ["mov-transcriber-mcp"]
    }
  }
}
```

Or with a local clone:

```json
{
  "mcpServers": {
    "mov-transcriber": {
      "command": "node",
      "args": ["/path/to/mov-transcriber-mcp/dist/index.js"]
    }
  }
}
```

## Use in Cowork

Cowork connects to MCP servers over HTTP. Run the server in HTTP mode:

```bash
npx mov-transcriber-mcp --http --port=3100
```

Then in Cowork project settings, add as an MCP server:

```
URL: http://localhost:3100/mcp
```

If hosting remotely (e.g. on a VPS), replace `localhost` with your server's address.

### Keep it running

Use a process manager to keep it alive:

```bash
# With pm2
pm2 start "npx mov-transcriber-mcp --http" --name mov-transcriber

# With systemd (Linux)
# See systemd example below
```

<details>
<summary>systemd service file</summary>

```ini
[Unit]
Description=MOV Transcriber MCP Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/npx mov-transcriber-mcp --http --port=3100
Restart=always
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
```

</details>

## Whisper Models

Default: `base` (~141MB). Auto-downloads on first use.

| Model | Size | Speed | Accuracy |
|-------|------|-------|----------|
| tiny | ~75MB | Fastest | Lower |
| base | ~141MB | Fast | Good |
| small | ~461MB | Medium | Better |
| medium | ~1.5GB | Slow | Great |
| large | ~2.9GB | Slowest | Best |

To pre-download a different model:

```bash
mkdir -p models
curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin -o models/ggml-small.bin
```

Set `WHISPER_MODELS_DIR` env var to use models from a custom location.

## CLI flags

```
npx mov-transcriber-mcp              # stdio mode (for Claude Code CLI)
npx mov-transcriber-mcp --http       # HTTP mode on port 3100 (for Cowork)
npx mov-transcriber-mcp --http --port=8080  # Custom port
```

## Health check

When running in HTTP mode:

```bash
curl http://localhost:3100/health
# {"status":"healthy","errors":[]}
```

## License

MIT
