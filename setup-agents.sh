#!/usr/bin/env bash
# ==============================================================================
# One-time Multi-Agent Environment Setup Script
#
# Creates ~/agents/{alpha,bravo,charlie}, clones pitcairn-portal into each,
# creates agent.conf, AGENTS.md, .env files, copies the start script, and
# bootstraps the GitHub coordinate labels and hub issue.
# ==============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_BASE_DIR="$HOME/agents"
REMOTE_URL="$(git -C "$REPO_ROOT" remote get-url origin)"

AGENTS=("alpha" "bravo" "charlie")
PORTS=("3001" "3002" "3003")

echo "================================================================="
echo "  Setting up Multi-Agent Workspace"
echo "  Base Directory: $AGENTS_BASE_DIR"
echo "  Git Remote:     $REMOTE_URL"
echo "================================================================="

# 1. Initialize GitHub coordinate labels and hub if needed
echo ""
echo "[1/4] Checking GitHub coordination setup..."
if [[ -f "$REPO_ROOT/.agents/skills/coordinate/scripts/coord.sh" ]]; then
  echo "Running coord.sh setup to bootstrap GitHub Issues labels and hub..."
  bash "$REPO_ROOT/.agents/skills/coordinate/scripts/coord.sh" setup || {
    echo "Notice: coord.sh setup returned non-zero. Continuing..."
  }
fi

# 2. Create base directory
mkdir -p "$AGENTS_BASE_DIR"

# 3. Setup each agent folder
for i in "${!AGENTS[@]}"; do
  AGENT_NAME="${AGENTS[$i]}"
  PORT="${PORTS[$i]}"
  AGENT_DIR="$AGENTS_BASE_DIR/$AGENT_NAME"
  TARGET_PROJECT_DIR="$AGENT_DIR/pitcairn-portal"

  echo ""
  echo "-----------------------------------------------------------------"
  echo "  Setting up Agent: $AGENT_NAME (Port: $PORT)"
  echo "  Location: $AGENT_DIR"
  echo "-----------------------------------------------------------------"

  mkdir -p "$AGENT_DIR"

  # Create agent identity AGENTS.md
  cat <<EOF > "$AGENT_DIR/AGENTS.md"
# Agent Identity: $AGENT_NAME

- Your callsign is: **agent-$AGENT_NAME**
- You are a specialized, autonomous software engineering agent working collaboratively on the Pitcairn Portal repository.
- Your dedicated development server port is: **$PORT**
- Always announce yourself in GitHub coordination comments as \`agent-$AGENT_NAME\`.
- Always check the \`coordinate\` skill and claim issues before modifying shared code.
EOF

  # Create agent configuration file
  cat <<EOF > "$AGENT_DIR/agent.conf"
MODEL="mimo/mimo-v2.6-pro"
THINKING="medium"
PORT=$PORT
EOF

  # Copy the start script to the agent folder
  cp "$REPO_ROOT/scripts/agent-start.sh" "$AGENT_DIR/start"
  chmod +x "$AGENT_DIR/start"

  # Clone pitcairn-portal if not already present
  if [[ ! -d "$TARGET_PROJECT_DIR/.git" ]]; then
    echo "Cloning $REMOTE_URL into $TARGET_PROJECT_DIR..."
    git clone "$REMOTE_URL" "$TARGET_PROJECT_DIR"
  else
    echo "Project repo already exists in $TARGET_PROJECT_DIR. Fetching latest..."
    (cd "$TARGET_PROJECT_DIR" && git fetch origin)
  fi

  # Copy .pi directory (with auto-compact extension) into the clone
  mkdir -p "$TARGET_PROJECT_DIR/.pi/extensions"
  cp -r "$REPO_ROOT/.pi" "$TARGET_PROJECT_DIR/"

  # Setup dedicated .env with port
  ENV_FILE="$TARGET_PROJECT_DIR/.env"
  if [[ -f "$REPO_ROOT/.env" ]]; then
    cp "$REPO_ROOT/.env" "$ENV_FILE"
    # Update or append PORT in .env
    if grep -q "^PORT=" "$ENV_FILE"; then
      sed -i "s/^PORT=.*/PORT=$PORT/" "$ENV_FILE"
    else
      echo "PORT=$PORT" >> "$ENV_FILE"
    fi
  else
    cat <<EOF > "$ENV_FILE"
PORT=$PORT
DB_PATH=./pitcairn.db
NODE_ENV=development
EOF
  fi

  # Run yarn install in the agent's clone
  echo "Installing dependencies for $AGENT_NAME..."
  (cd "$TARGET_PROJECT_DIR" && yarn install --frozen-lockfile 2>/dev/null || yarn install)

  echo "Agent $AGENT_NAME setup complete."
done

echo ""
echo "================================================================="
echo "  Multi-Agent Setup Completed Successfully!"
echo "================================================================="
echo ""
echo "To start your agents, open three separate terminal windows and run:"
echo ""
echo "  Terminal 1:  cd ~/agents/alpha && ./start pitcairn-portal"
echo "  Terminal 2:  cd ~/agents/bravo && ./start pitcairn-portal"
echo "  Terminal 3:  cd ~/agents/charlie && ./start pitcairn-portal"
echo ""
echo "You can pass optional steering anytime:"
echo "  ./start pitcairn-portal \"Work on ws:admin-portal issues\""
echo "================================================================="
