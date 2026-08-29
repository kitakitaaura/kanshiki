#!/usr/bin/env bash
# Kanshiki self-host setup. Safe to re-run.
set -euo pipefail

MODEL="${OLLAMA_MODEL:-llama3.1:8b}"
PORT="${PORT:-8788}"

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
warn() { printf '  \033[33mnote\033[0m %s\n' "$1"; }
die()  { printf '\n  \033[31mstopped\033[0m %s\n\n' "$1"; exit 1; }

say "Kanshiki self-host setup"

# --- node ---------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js is not installed. Get it from https://nodejs.org (version 18 or newer)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18 or newer is required. You have $(node -v)."
ok "Node.js $(node -v)"

# --- ollama -------------------------------------------------------------
if ! command -v ollama >/dev/null 2>&1; then
  echo
  echo "  Ollama is not installed. It runs the language model on your own machine."
  echo "  Install it, then run this script again:"
  echo
  case "$(uname -s)" in
    Darwin) echo "    brew install ollama        (or download from https://ollama.com/download)" ;;
    Linux)  echo "    curl -fsSL https://ollama.com/install.sh | sh" ;;
    *)      echo "    https://ollama.com/download" ;;
  esac
  echo
  echo "  Kanshiki also runs without any model at all, with reduced features."
  echo "  To try that instead, skip Ollama and use the AI toggle in the header."
  die "Ollama missing."
fi
ok "Ollama installed"

if ! curl -fsS --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
  warn "Ollama is not responding. Starting it in the background."
  (ollama serve >/dev/null 2>&1 &)
  for _ in $(seq 1 20); do
    curl -fsS --max-time 1 http://localhost:11434/api/tags >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1 \
    || die "Could not start Ollama. Run 'ollama serve' in another terminal, then re-run this script."
fi
ok "Ollama running"

if curl -fsS --max-time 5 http://localhost:11434/api/tags | grep -q "\"$MODEL"; then
  ok "Model $MODEL already pulled"
else
  say "Pulling $MODEL. This is a one-time download of a few gigabytes."
  ollama pull "$MODEL"
  ok "Model $MODEL ready"
fi

# --- dependencies -------------------------------------------------------
if [ -d node_modules ]; then
  ok "Dependencies installed"
else
  say "Installing dependencies"
  npm install --silent
  ok "Dependencies installed"
fi

# --- local config -------------------------------------------------------
if [ -f .dev.vars ]; then
  ok ".dev.vars already exists, leaving it alone"
else
  cp .dev.vars.example .dev.vars
  # Self-host defaults: local model, no rate limit.
  sed -i.bak "s|^OLLAMA_MODEL=.*|OLLAMA_MODEL=$MODEL|" .dev.vars && rm -f .dev.vars.bak
  ok "Wrote .dev.vars with self-host defaults"
fi

# --- tests --------------------------------------------------------------
if npm test --silent >/dev/null 2>&1; then
  ok "Test suite passes"
else
  warn "Some tests failed. The app will still start; run 'npm test' to see details."
fi

say "Starting Kanshiki on http://localhost:$PORT"
echo "  First claim takes 20 to 45 seconds depending on your machine and model."
echo "  Press Ctrl+C to stop."
echo
exec npx wrangler pages dev --port "$PORT"
