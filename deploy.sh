#!/bin/bash

###############################################################################
# FinalCut Deployment Script
# 
# This script automates the deployment process for the FinalCut application
# on DigitalOcean or any Linux server with Node.js and Nginx installed.
#
# Usage: ./deploy.sh
#
# Prerequisites:
# - Node.js 18+ installed
# - systemd service configured (finalcut.service)
# - Nginx configured
# - Git repository cloned
# - .env file configured
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
APP_NAME="finalcut-server"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="/tmp/finalcut-backups"

###############################################################################
# Helper Functions
###############################################################################

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check if Node.js is installed
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed. Please install Node.js 18 or higher."
        exit 1
    fi
    
    # Check Node.js version
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        log_error "Node.js version must be 18 or higher. Current version: $(node -v)"
        exit 1
    fi
    
    # Check if npm is installed
    if ! command -v npm &> /dev/null; then
        log_error "npm is not installed."
        exit 1
    fi
    
    # Check if systemd service exists
    if [ ! -f "/etc/systemd/system/finalcut.service" ]; then
        log_error "systemd service not found at /etc/systemd/system/finalcut.service"
        if [ -f "$APP_DIR/finalcut.service" ]; then
            log_error "Please install the service first:"
            log_error "  sudo cp finalcut.service /etc/systemd/system/finalcut.service"
            log_error "  sudo systemctl daemon-reload"
            log_error "  sudo systemctl enable finalcut"
        else
            log_error "Source service file not found at $APP_DIR/finalcut.service"
            log_error "Please ensure you have the correct repository and service file exists"
        fi
        exit 1
    fi
    
    # Check if .env file exists
    if [ ! -f "$APP_DIR/.env" ]; then
        log_error ".env file not found. Please create it from .env.example"
        exit 1
    fi
    
    log_info "All prerequisites met!"
}

create_backup() {
    log_info "Creating backup of current deployment..."
    
    # Create backup directory if it doesn't exist
    mkdir -p "$BACKUP_DIR"
    
    # Create backup with timestamp
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_FILE="$BACKUP_DIR/finalcut_backup_$TIMESTAMP.tar.gz"
    
    # Backup dist directory if it exists
    if [ -d "$APP_DIR/dist" ]; then
        tar -czf "$BACKUP_FILE" -C "$APP_DIR" dist node_modules package-lock.json 2>/dev/null || true
        log_info "Backup created: $BACKUP_FILE"
    else
        log_warn "No dist directory found, skipping backup"
    fi
    
    # Keep only last 5 backups
    ls -t "$BACKUP_DIR"/finalcut_backup_*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm
}

pull_latest_code() {
    log_info "Pulling latest code from Git..."
    
    cd "$APP_DIR"
    
    # Check if we're in a git repository
    if [ ! -d ".git" ]; then
        log_error "Not a git repository. Please clone the repository first."
        exit 1
    fi
    
    # Stash any local changes
    if [[ -n $(git status -s) ]]; then
        log_warn "Local changes detected. Stashing..."
        git stash
    fi
    
    # Pull latest changes
    git pull origin main || git pull origin master || {
        log_error "Failed to pull latest code"
        exit 1
    }
    
    log_info "Code updated successfully!"
}

install_dependencies() {
    log_info "Installing dependencies..."
    
    cd "$APP_DIR"
    
    # Install Node.js dependencies
    npm ci --production=false || npm install || {
        log_error "Failed to install dependencies"
        exit 1
    }
    
    log_info "Dependencies installed successfully!"
}

build_application() {
    log_info "Building application..."
    
    cd "$APP_DIR"
    
    # Build the frontend
    npm run build || {
        log_error "Build failed"
        exit 1
    }
    
    log_info "Build completed successfully!"
}

restart_application() {
    log_info "Restarting application with systemd..."
    
    cd "$APP_DIR"
    
    # Service existence is already validated in check_prerequisites
    log_info "Reloading systemd daemon..."
    sudo systemctl daemon-reload
    
    log_info "Restarting finalcut service..."
    sudo systemctl restart finalcut || {
        log_error "Failed to restart application"
        sudo systemctl status finalcut --no-pager
        exit 1
    }
    
    # Check if service is running
    if sudo systemctl is-active --quiet finalcut; then
        log_info "Application restarted successfully!"
    else
        log_error "Application failed to start"
        sudo systemctl status finalcut --no-pager
        exit 1
    fi
}

reload_nginx() {
    log_info "Reloading Nginx..."
    
    # Test Nginx configuration
    if sudo nginx -t &> /dev/null; then
        sudo systemctl reload nginx || {
            log_warn "Failed to reload Nginx, but continuing..."
        }
        log_info "Nginx reloaded successfully!"
    else
        log_warn "Nginx configuration test failed. Skipping reload."
    fi
}

show_status() {
    log_info "Deployment status:"
    echo ""
    
    # Show systemd service status
    sudo systemctl status finalcut --no-pager || log_warn "Application service not found"
    
    echo ""
    log_info "Recent logs:"
    sudo journalctl -u finalcut -n 10 --no-pager || true
}

cleanup() {
    log_info "Cleaning up..."
    
    # Remove old node_modules if needed
    # Uncomment if you want to clean up during deployment
    # rm -rf "$APP_DIR/node_modules/.cache"
    
    log_info "Cleanup completed!"
}

###############################################################################
# Main Deployment Process
###############################################################################

main() {
    echo ""
    echo "========================================"
    echo "   FinalCut Deployment Script"
    echo "========================================"
    echo ""
    
    # Run deployment steps
    check_prerequisites
    create_backup
    pull_latest_code
    install_dependencies
    build_application
    restart_application
    reload_nginx
    cleanup
    
    echo ""
    echo "========================================"
    log_info "Deployment completed successfully! 🚀"
    echo "========================================"
    echo ""
    
    show_status
    
    echo ""
    log_info "Next steps:"
    echo "  - Visit your application: https://yourdomain.com"
    echo "  - Check logs: sudo journalctl -u finalcut -f"
    echo "  - Monitor status: sudo systemctl status finalcut"
    echo ""
}

# Run main function
main "$@"
