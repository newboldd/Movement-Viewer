#!/usr/bin/env bash
# One-command setup + launch for Movement Viewer.
#
# What it does:
#   1. Finds Python 3.9+ (offers to install via brew/apt/dnf if missing).
#   2. Creates a virtualenv (.venv) if needed.
#   3. Installs requirements.txt if needed.
#   4. Starts the FastAPI app on http://localhost:8090 and opens a browser.

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$PROJECT_DIR/.venv"
REQUIREMENTS="$PROJECT_DIR/requirements.txt"
PORT=8090

OS="$(uname -s)"

print_header() { echo ""; echo "── $1 ─────────────────────────"; }

# ── Python ────────────────────────────────────────────────────────────────

find_python() {
    for cmd in python3.12 python3.11 python3.10 python3.9 python3 python; do
        if command -v "$cmd" &>/dev/null; then
            ver=$("$cmd" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null)
            major=$(echo "$ver" | cut -d. -f1)
            minor=$(echo "$ver" | cut -d. -f2)
            if [ "$major" -eq 3 ] && [ "$minor" -ge 9 ]; then
                echo "$cmd"; return 0
            fi
        fi
    done
    return 1
}

install_python() {
    print_header "Installing Python"
    if [ "$OS" = "Darwin" ]; then
        if command -v brew &>/dev/null; then
            brew install python@3.11
        else
            echo "Install Homebrew (https://brew.sh) or Python from https://www.python.org/downloads/"
            exit 1
        fi
    elif [ "$OS" = "Linux" ]; then
        if command -v apt-get &>/dev/null; then
            sudo apt-get update -q && sudo apt-get install -y python3.11 python3.11-venv python3-pip
        elif command -v dnf &>/dev/null; then
            sudo dnf install -y python3.11
        elif command -v yum &>/dev/null; then
            sudo yum install -y python3
        else
            echo "No package manager found. Install Python 3.9+ from https://www.python.org/downloads/"
            exit 1
        fi
    else
        echo "Unsupported OS for automatic install. Install Python 3.9+ manually."
        exit 1
    fi
}

PYTHON=$(find_python) || { install_python; PYTHON=$(find_python) || { echo "Python install failed"; exit 1; }; }
echo "Using Python: $PYTHON ($($PYTHON --version))"

# ── Virtual environment ───────────────────────────────────────────────────

if [ ! -d "$VENV_DIR" ]; then
    print_header "Creating virtualenv"
    "$PYTHON" -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

# ── Dependencies ──────────────────────────────────────────────────────────

if [ ! -f "$VENV_DIR/.installed" ] || [ "$REQUIREMENTS" -nt "$VENV_DIR/.installed" ]; then
    print_header "Installing Python dependencies"
    "$VENV_DIR/bin/pip" install --upgrade pip -q
    "$VENV_DIR/bin/pip" install -r "$REQUIREMENTS"
    touch "$VENV_DIR/.installed"
fi

# ── Kill any existing server on the port ─────────────────────────────────

existing=$(lsof -ti :$PORT 2>/dev/null || true)
if [ -n "$existing" ]; then
    echo "Stopping existing server on port $PORT..."
    echo "$existing" | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# ── Launch ────────────────────────────────────────────────────────────────

echo ""
echo "Starting Movement Viewer at http://localhost:$PORT"
echo "Press Ctrl+C to stop."
echo ""

cd "$PROJECT_DIR"

(sleep 2 && (open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null)) &

exec "$VENV_DIR/bin/python" -m uvicorn viewer.app:app --host 127.0.0.1 --port "$PORT" --timeout-graceful-shutdown 3
