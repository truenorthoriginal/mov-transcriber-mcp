#!/bin/bash
# Setup script for mov-transcriber MCP server
# Installs dependencies and downloads the Whisper model

set -e

echo "=== MOV Transcriber MCP Setup ==="

# Check ffmpeg
if ! command -v ffmpeg &> /dev/null; then
  echo "ffmpeg not found. Installing via Homebrew..."
  brew install ffmpeg
else
  echo "ffmpeg: OK"
fi

# Check whisper-cli
if ! command -v whisper-cli &> /dev/null; then
  echo "whisper-cli not found. Installing via Homebrew..."
  brew install whisper-cpp
else
  echo "whisper-cli: OK"
fi

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js is required. Install it from https://nodejs.org"
  exit 1
else
  echo "node: OK ($(node --version))"
fi

# Install npm deps
echo "Installing npm dependencies..."
npm install

# Build
echo "Building..."
npm run build

# Download model
MODELS_DIR="$(dirname "$0")/models"
MODEL_FILE="$MODELS_DIR/ggml-base.bin"
if [ ! -f "$MODEL_FILE" ]; then
  echo "Downloading Whisper base model (~141MB)..."
  mkdir -p "$MODELS_DIR"
  curl -L "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" -o "$MODEL_FILE"
else
  echo "Whisper model: OK"
fi

echo ""
echo "=== Setup complete! ==="
echo ""
echo "To use in Claude Code, add to your ~/.claude/settings.json:"
echo ""
echo '  "mcpServers": {'
echo '    "mov-transcriber": {'
echo "      \"command\": \"node\","
echo "      \"args\": [\"$(cd "$(dirname "$0")" && pwd)/dist/index.js\"]"
echo '    }'
echo '  }'
echo ""
echo "Or start a new Claude Code session in this directory (it will auto-detect .mcp.json)."
