#!/bin/bash
# =============================================================================
#  BuildTrack — Automated Deployment Script
#  New Urban Development Field Operations Platform
#
#  Usage (fresh install):
#    curl -fsSL https://raw.githubusercontent.com/mseifert522/BuildTrack/main/deploy.sh | bash
#
#  Usage (update existing install):
#    cd ~/BuildTrack && bash deploy.sh --update
#
#  Supports: Ubuntu 20.04, 22.04, 24.04 LTS
# =============================================================================

set -e  # Exit immediately on any error

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── Config ────────────────────────────────────────────────────────────────────
REPO_URL="https://github.com/mseifert522/BuildTrack.git"
APP_DIR="$HOME/BuildTrack"
APP_PORT=3001
NODE_VERSION=22
PM2_APP_NAME="buildtrack"

# ── Helpers ───────────────────────────────────────────────────────────────────
info()    { echo -e "${BLUE}[INFO]${NC}  $1"; }
success() { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
section() { echo -e "\n${BOLD}${BLUE}══════════════════════════════════════${NC}"; echo -e "${BOLD} $1${NC}"; echo -e "${BOLD}${BLUE}══════════════════════════════════════${NC}"; }

# ── Detect update mode ────────────────────────────────────────────────────────
UPDATE_MODE=false
if [[ "$1" == "--update" ]]; then
  UPDATE_MODE=true
  info "Running in UPDATE mode — pulling latest code and rebuilding."
fi

# =============================================================================
#  STEP 1 — System update & core packages
# =============================================================================
section "Step 1: System Packages"
info "Updating package lists..."
sudo apt-get update -qq

info "Installing required packages..."
sudo apt-get install -y -qq git curl wget build-essential ufw 2>/dev/null
success "Core packages installed."

# =============================================================================
#  STEP 2 — Node.js
# =============================================================================
section "Step 2: Node.js $NODE_VERSION"
if command -v node &>/dev/null && [[ "$(node -v)" == v${NODE_VERSION}* ]]; then
  success "Node.js $(node -v) already installed."
else
  info "Installing Node.js $NODE_VERSION..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash - 2>/dev/null
  sudo apt-get install -y -qq nodejs
  success "Node.js $(node -v) installed."
fi

# =============================================================================
#  STEP 3 — PM2 Process Manager
# =============================================================================
section "Step 3: PM2 Process Manager"
if command -v pm2 &>/dev/null; then
  success "PM2 already installed ($(pm2 -v))."
else
  info "Installing PM2 globally..."
  sudo npm install -g pm2 --quiet
  success "PM2 $(pm2 -v) installed."
fi

# =============================================================================
#  STEP 4 — Clone or Update Repository
# =============================================================================
section "Step 4: BuildTrack Repository"
if [ "$UPDATE_MODE" = true ]; then
  info "Pulling latest code from GitHub..."
  cd "$APP_DIR"
  git pull origin main
  success "Repository updated."
else
  if [ -d "$APP_DIR/.git" ]; then
    warn "BuildTrack directory already exists. Pulling latest changes..."
    cd "$APP_DIR"
    git pull origin main
  else
    info "Cloning BuildTrack from GitHub..."
    git clone "$REPO_URL" "$APP_DIR"
    success "Repository cloned to $APP_DIR"
  fi
fi

# =============================================================================
#  STEP 5 — Backend Environment Configuration
# =============================================================================
section "Step 5: Environment Configuration"
cd "$APP_DIR/backend"

if [ ! -f ".env" ]; then
  info "Creating .env from template..."
  cp .env.example .env

  # Generate a secure random JWT secret
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")

  # Write values into .env
  sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env
  sed -i "s/^PORT=.*/PORT=$APP_PORT/" .env
  sed -i "s/^NODE_ENV=.*/NODE_ENV=production/" .env

  success ".env created with auto-generated JWT secret."
  warn "IMPORTANT: Edit $APP_DIR/backend/.env to configure SMTP email settings."
else
  success ".env already exists — skipping (not overwriting)."
fi

# =============================================================================
#  STEP 6 — Install Backend Dependencies
# =============================================================================
section "Step 6: Backend Dependencies"
cd "$APP_DIR/backend"
info "Installing backend npm packages..."
npm install --omit=dev --quiet
# Rebuild native modules (better-sqlite3) for current platform
npm rebuild better-sqlite3 --quiet 2>/dev/null || true
success "Backend dependencies installed."

# =============================================================================
#  STEP 7 — Install Frontend Dependencies & Build
# =============================================================================
section "Step 7: Frontend Build"
cd "$APP_DIR/frontend"
info "Installing frontend npm packages..."
npm install --quiet
info "Building production bundle (this may take 1-2 minutes)..."
npm run build
success "Frontend production build complete."

# =============================================================================
#  STEP 8 — Database Initialization
# =============================================================================
section "Step 8: Database"
cd "$APP_DIR/backend"
info "Initializing SQLite database and running seed data..."
node -e "
const { initDb } = require('./src/db/schema');
initDb();
console.log('Database initialized successfully.');
" 2>/dev/null || warn "Database may already be initialized — skipping."
success "Database ready."

# =============================================================================
#  STEP 9 — Start / Restart with PM2
# =============================================================================
section "Step 9: Starting Application"
cd "$APP_DIR/backend"

if pm2 list | grep -q "$PM2_APP_NAME"; then
  info "Restarting existing PM2 process..."
  pm2 restart "$PM2_APP_NAME"
else
  info "Starting BuildTrack with PM2..."
  pm2 start server.js \
    --name "$PM2_APP_NAME" \
    --max-memory-restart 500M \
    --log /var/log/buildtrack.log \
    --time
fi

pm2 save
success "BuildTrack is running under PM2."

# =============================================================================
#  STEP 10 — PM2 Startup (auto-start on reboot)
# =============================================================================
section "Step 10: Auto-Start on Reboot"
STARTUP_CMD=$(pm2 startup 2>&1 | grep "sudo env" | tail -1)
if [ -n "$STARTUP_CMD" ]; then
  info "Configuring PM2 to start on boot..."
  eval "$STARTUP_CMD" 2>/dev/null || warn "Could not auto-configure startup. Run manually: $STARTUP_CMD"
  pm2 save
  success "PM2 startup configured."
else
  success "PM2 startup already configured."
fi

# =============================================================================
#  STEP 11 — Firewall
# =============================================================================
section "Step 11: Firewall"
if command -v ufw &>/dev/null; then
  sudo ufw allow ssh 2>/dev/null || true
  sudo ufw allow $APP_PORT/tcp 2>/dev/null || true
  sudo ufw allow 80/tcp 2>/dev/null || true
  sudo ufw allow 443/tcp 2>/dev/null || true
  sudo ufw --force enable 2>/dev/null || true
  success "Firewall configured (ports 22, 80, 443, $APP_PORT open)."
else
  warn "UFW not available — configure your firewall manually to open port $APP_PORT."
fi

# =============================================================================
#  STEP 12 — Health Check
# =============================================================================
section "Step 12: Health Check"
sleep 3
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$APP_PORT/ 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" = "200" ]; then
  success "Health check passed — server responding with HTTP 200."
else
  warn "Health check returned HTTP $HTTP_STATUS — check logs with: pm2 logs $PM2_APP_NAME"
fi

# =============================================================================
#  DONE
# =============================================================================
EXTERNAL_IP=$(curl -s ifconfig.me 2>/dev/null || echo "YOUR_VM_IP")

echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║         BuildTrack Deployment Complete!              ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}App URL:${NC}        http://$EXTERNAL_IP:$APP_PORT"
echo -e "  ${BOLD}PM2 Status:${NC}     pm2 status"
echo -e "  ${BOLD}View Logs:${NC}      pm2 logs $PM2_APP_NAME"
echo -e "  ${BOLD}Restart App:${NC}    pm2 restart $PM2_APP_NAME"
echo -e "  ${BOLD}Update App:${NC}     cd $APP_DIR && bash deploy.sh --update"
echo ""
echo -e "  ${YELLOW}${BOLD}Default Login Credentials:${NC}"
echo -e "  Email:    mike@seifertcapital.com"
echo -e "  Password: test123456789"
echo ""
echo -e "  ${YELLOW}${BOLD}Next Steps (Optional):${NC}"
echo -e "  1. Set up Nginx reverse proxy for domain + HTTPS"
echo -e "  2. Configure SMTP in $APP_DIR/backend/.env for email invoices"
echo -e "  3. Point your domain DNS to $EXTERNAL_IP"
echo ""
