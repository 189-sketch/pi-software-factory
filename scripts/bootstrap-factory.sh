#!/usr/bin/env bash
# bootstrap-factory.sh — single-command factory setup + start.
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/189-sketch/pi-software-factory/main/scripts/bootstrap-factory.sh)
#   bash <(curl -fsSL ... ) /path/to/target --repo owner/name [--mode cloud|local|both] [--start]
#
# What this does:
#   1. Downloads scripts/install-factory.mjs from the factory repo
#   2. Asks the user which mode (cloud / local / both) if --mode not given
#   3. Copies skills + factory/ + (cloud-only) workflows into <target>
#   4. For local mode: writes .env template, optionally starts the daemon
#   5. For cloud mode: prints the `gh secret set` commands and a test issue
#
# Exit codes:
#   0 success
#   1 prerequisite missing (curl/wget, node, git)
#   2 user aborted
set -euo pipefail

FACTORY_REPO="189-sketch/pi-software-factory"
FACTORY_BRANCH="${FACTORY_BRANCH:-main}"
INSTALL_URL="https://raw.githubusercontent.com/${FACTORY_REPO}/${FACTORY_BRANCH}/scripts/install-factory.mjs"

MODE=""
TARGET=""
REPO=""
START=0
YES=0

usage() {
  cat <<EOF
Usage: $0 [target-path] [options]

Options:
  --mode MODE       cloud | local | both (default: ask)
  --repo OWNER/NAME GitHub repo the factory should drive (default: ask)
  --start           After install, start the daemon (local mode only)
  -y, --non-interactive  Don't prompt; use --mode + --repo (required)
  -h, --help        Show this help

Examples:
  # Interactive
  bash <(curl -fsSL https://.../bootstrap-factory.sh) ~/my-app

  # Non-interactive (CI / scripts)
  bash <(curl -fsSL https://.../bootstrap-factory.sh) . --mode local --repo me/my-app --start

  # Cloud-only install (sets up workflows, prints gh secret set commands)
  bash <(curl -fsSL https://.../bootstrap-factory.sh) . --mode cloud --repo me/my-app
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --start) START=1; shift ;;
    -y|--non-interactive) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1"; usage; exit 1 ;;
    *) TARGET="$1"; shift ;;
  esac
done

# 1. Prereqs.
for cmd in curl git node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "❌ Missing required command: $cmd"
    echo "   Install $cmd and re-run."
    exit 1
  fi
done

# 2. Pick target.
if [[ -z "$TARGET" ]]; then
  read -rp "Target repo path (current dir if empty): " TARGET
  TARGET="${TARGET:-.}"
fi
TARGET="$(cd "$TARGET" 2>/dev/null && pwd || { echo "❌ $TARGET does not exist"; exit 1; })"

# 3. Pick mode.
if [[ -z "$MODE" ]]; then
  if [[ "$YES" -eq 1 ]]; then
    echo "❌ --mode required in non-interactive mode"
    usage; exit 1
  fi
  echo ""
  echo "Which mode do you want to enable?"
  echo "  1. cloud  — GitHub Actions runs the factory in ephemeral VMs (keys as repo secrets)"
  echo "  2. local  — Local daemon polls GitHub + processes on this machine (keys stay local)"
  echo "  3. both   — Install both; switch at runtime"
  echo ""
  while true; do
    read -rp "Choose [1-3] (default 2): " choice
    case "${choice:-2}" in
      1) MODE=cloud; break ;;
      2) MODE=local; break ;;
      3) MODE=both; break ;;
      *) echo "  Please enter 1, 2, or 3." ;;
    esac
  done
fi

# 4. Pick repo.
if [[ -z "$REPO" ]]; then
  if [[ "$YES" -eq 1 ]]; then
    echo "❌ --repo required in non-interactive mode"
    usage; exit 1
  fi
  read -rp "GitHub repo the factory should drive (owner/name): " REPO
  if [[ -z "$REPO" ]]; then
    echo "❌ repo required"
    exit 1
  fi
fi

echo ""
echo "================================================================"
echo " Software Factory — bootstrap"
echo "================================================================"
echo " Target:        $TARGET"
echo " Mode:          $MODE"
echo " Driven repo:   $REPO"
echo "================================================================"
echo ""

# 5. Clone the factory repo (we need the skills/, factory/, scripts/ files
# the installer references — the installer resolves paths relative to its
# own location, so we have to keep them together).
WORK="$(mktemp -d)"
trap 'rm -rf "$TMP_INSTALLER" "$WORK"' EXIT
if ! git clone --depth 1 --branch "$FACTORY_BRANCH" \
    "https://github.com/${FACTORY_REPO}.git" "$WORK/factory" >/dev/null 2>&1; then
  echo "❌ Failed to clone ${FACTORY_REPO}"
  exit 1
fi

# 6. Run installer from inside the cloned repo.
INSTALLER="$WORK/factory/scripts/install-factory.mjs"
INSTALL_FLAGS=(--mode "$MODE" --repo "$REPO")
[[ "$YES" -eq 1 ]] && INSTALL_FLAGS+=(--non-interactive)
node "$INSTALLER" "$TARGET" "${INSTALL_FLAGS[@]}"
INSTALL_RC=$?
if [[ "$INSTALL_RC" -ne 0 ]]; then
  echo "Installer exited $INSTALL_RC"
  exit $INSTALL_RC
fi

# 7. Cloud mode — print secret-set commands and a test trigger.
if [[ "$MODE" == "cloud" || "$MODE" == "both" ]]; then
  cat <<EOF

  ⚠ Cloud mode — set these secrets on the target repo:

    gh secret set ANTHROPIC_AUTH_TOKEN --repo $REPO
    gh secret set ANTHROPIC_BASE_URL   --repo $REPO   # optional
    gh secret set ANTHROPIC_MODEL      --repo $REPO   # optional

  Then open a test issue:
    gh issue create --repo $REPO \\
      --title "Test: factory should triage + implement" \\
      --body "Acceptance criteria: …"

  The workflow \`triage-issues.yml\` will fire automatically.
EOF
fi

# 8. Local mode — prompt for secrets, optionally start daemon.
if [[ "$MODE" == "local" || "$MODE" == "both" ]]; then
  ENV_FILE="$TARGET/.factory-daemon/.env"
  if [[ -f "$ENV_FILE" ]] && grep -q "REPLACE_ME" "$ENV_FILE"; then
    echo ""
    echo "Local mode — fill in credentials:"
    read -rp "  GH_TOKEN (paste, hidden if possible): " GH_TOKEN_VAL
    read -rp "  ANTHROPIC_AUTH_TOKEN: " ANTHROPIC_VAL
    read -rp "  ANTHROPIC_BASE_URL [https://api.minimaxi.com/anthropic]: " BASE_VAL
    read -rp "  ANTHROPIC_MODEL [MiniMax-M3]: " MODEL_VAL
    GH_TOKEN_VAL="${GH_TOKEN_VAL:-REPLACE_ME}"
    ANTHROPIC_VAL="${ANTHROPIC_VAL:-REPLACE_ME}"
    BASE_VAL="${BASE_VAL:-https://api.minimaxi.com/anthropic}"
    MODEL_VAL="${MODEL_VAL:-MiniMax-M3}"
    {
      echo "GH_TOKEN=$GH_TOKEN_VAL"
      echo "ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_VAL"
      echo "ANTHROPIC_BASE_URL=$BASE_VAL"
      echo "ANTHROPIC_MODEL=$MODEL_VAL"
      echo "FACTORY_GH_REPO=$REPO"
      echo "FACTORY_POLL_INTERVAL=30"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "✓ Wrote $ENV_FILE (chmod 600)"
  fi

  if [[ "$START" -eq 1 ]]; then
    echo ""
    echo "Starting daemon in background..."
    (cd "$TARGET" && nohup ./.factory-daemon/start.sh > "$TARGET/.factory-daemon/daemon.out" 2>&1 &)
    sleep 2
    if pgrep -f factory-daemon.mjs >/dev/null; then
      echo "✓ Daemon started (PID $(pgrep -f factory-daemon.mjs | head -1))"
      echo "  Logs: $TARGET/.factory-daemon/daemon.log"
    else
      echo " Daemon failed to start; check $TARGET/.factory-daemon/daemon.out"
      exit 1
    fi
  else
    cat <<EOF

  Next: start the daemon
    cd $TARGET
    ./.factory-daemon/start.sh       # foreground
    # or as a service (Linux)
    sudo systemctl enable --now ./.factory-daemon/factory-daemon.service
EOF
  fi
fi

cat <<EOF

✅ Factory ready in '$MODE' mode.
EOF