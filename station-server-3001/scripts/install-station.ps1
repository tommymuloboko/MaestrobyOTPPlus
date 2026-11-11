# Quick Install Script for MAESTRO-LITE
# Run this in PowerShell as Administrator

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "MAESTRO-LITE Quick Installation" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if running as admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")
if (-not $isAdmin) {
    Write-Host "WARNING: Run this script as Administrator for full functionality" -ForegroundColor Yellow
    Write-Host ""
}

# Check Node.js
Write-Host "Checking Node.js..." -ForegroundColor Yellow
$nodeVersion = node --version 2>$null
if ($nodeVersion) {
    Write-Host "  Node.js installed: $nodeVersion" -ForegroundColor Green
} else {
    Write-Host "  Node.js NOT found! Please install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# Check npm
Write-Host "Checking npm..." -ForegroundColor Yellow
$npmVersion = npm --version 2>$null
Write-Host "  npm installed: $npmVersion" -ForegroundColor Green

# Install dependencies
Write-Host ""
Write-Host "Installing project dependencies..." -ForegroundColor Yellow
npm install
Write-Host "  Dependencies installed" -ForegroundColor Green

# Install PM2 globally
Write-Host ""
Write-Host "Installing PM2 (Process Manager)..." -ForegroundColor Yellow
npm install -g pm2 2>$null
Write-Host "  PM2 installed" -ForegroundColor Green

# Install PM2 Windows startup
Write-Host ""
Write-Host "Installing PM2 Windows startup service..." -ForegroundColor Yellow
npm install -g pm2-windows-startup 2>$null
pm2-startup install 2>$null
Write-Host "  PM2 startup configured" -ForegroundColor Green

# Check .env file
Write-Host ""
Write-Host "Checking configuration..." -ForegroundColor Yellow
if (Test-Path ".env") {
    Write-Host "  .env file found" -ForegroundColor Green
} else {
    Write-Host "  WARNING: .env file not found! Please create it from .env.example" -ForegroundColor Yellow
}

# Start the server
Write-Host ""
Write-Host "Starting MAESTRO-LITE..." -ForegroundColor Yellow
pm2 start ecosystem.config.js
Write-Host "  Server started" -ForegroundColor Green

# Save PM2 process list
Write-Host ""
Write-Host "Saving PM2 configuration for auto-start..." -ForegroundColor Yellow
pm2 save
Write-Host "  Configuration saved" -ForegroundColor Green

# Show status
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Installation Complete!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Server Status:" -ForegroundColor Yellow
pm2 status

Write-Host ""
Write-Host "Useful Commands:" -ForegroundColor Yellow
Write-Host "  pm2 status          - Check server status"
Write-Host "  pm2 logs            - View live logs"
Write-Host "  pm2 restart all     - Restart server"
Write-Host "  pm2 monit           - Real-time monitoring"
Write-Host ""
Write-Host "API available at: http://localhost:3000" -ForegroundColor Green
Write-Host "Swagger docs at:  http://localhost:3000/api-docs" -ForegroundColor Green
Write-Host ""
