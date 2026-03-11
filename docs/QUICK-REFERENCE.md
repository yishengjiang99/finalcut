# FinalCut Deployment Quick Reference

This is a quick reference guide for common deployment tasks.

## Initial Deployment

```bash
# 1. Setup server (run once on new droplet)
wget https://raw.githubusercontent.com/yishengjiang99/pages/main/finalcut/setup-server.sh
chmod +x setup-server.sh
sudo ./setup-server.sh

# 2. Switch to app user
sudo su - finalcut

# 3. Clone repository
cd /home/finalcut/apps
git clone https://github.com/yishengjiang99/pages.git
cd pages/finalcut

# 4. Configure environment
cp .env.example .env
nano .env  # Add your XAI_API_TOKEN and other settings

# 5. Install and build
npm install
npm run build

# 6. Start with PM2
pm2 start server.js --name finalcut-server
pm2 save

# 7. Configure Nginx
exit  # Back to root/sudo user
sudo cp /home/finalcut/apps/pages/finalcut/nginx.conf /etc/nginx/sites-available/finalcut
sudo nano /etc/nginx/sites-available/finalcut  # Update yourdomain.com
sudo ln -s /etc/nginx/sites-available/finalcut /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# 8. Setup SSL
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

## DNS Configuration on GoDaddy

1. Log in to GoDaddy → My Products → DNS
2. Add/Update A Records:
   - Type: `A`, Name: `@`, Value: `YOUR_DROPLET_IP`
   - Type: `A`, Name: `www`, Value: `YOUR_DROPLET_IP`
3. Save and wait for propagation (1-48 hours)

## Update Deployment

```bash
# Use the deployment script
cd /home/finalcut/apps/pages/finalcut
./deploy.sh
```

Or manually:

```bash
cd /home/finalcut/apps/pages/finalcut
git pull
npm install
npm run build
pm2 restart finalcut-server
sudo systemctl reload nginx
```

## Common Commands

### PM2 Management

```bash
# Check status
pm2 status

# View logs
pm2 logs finalcut-server
pm2 logs finalcut-server --lines 100

# Restart app
pm2 restart finalcut-server

# Stop app
pm2 stop finalcut-server

# Start app
pm2 start finalcut-server

# Monitor resources
pm2 monit

# Save process list
pm2 save

# View detailed info
pm2 describe finalcut-server
```

### Nginx Management

```bash
# Test configuration
sudo nginx -t

# Reload configuration
sudo systemctl reload nginx

# Restart Nginx
sudo systemctl restart nginx

# Check status
sudo systemctl status nginx

# View error logs
sudo tail -f /var/log/nginx/error.log

# View access logs
sudo tail -f /var/log/nginx/access.log

# View FinalCut logs
sudo tail -f /var/log/nginx/finalcut_error.log
```

### SSL Certificate Management

```bash
# Check certificate status
sudo certbot certificates

# Renew certificates manually
sudo certbot renew

# Test renewal process
sudo certbot renew --dry-run

# Revoke certificate
sudo certbot revoke --cert-path /etc/letsencrypt/live/yourdomain.com/cert.pem
```

### System Monitoring

```bash
# Check disk space
df -h

# Check memory usage
free -h

# Check CPU and processes
htop
top

# Check running processes
ps aux | grep node

# Check open ports
sudo netstat -tulpn

# Check firewall status
sudo ufw status

# Check system logs
journalctl -xe
```

### Application Debugging

```bash
# Check if app is running
pm2 status
ps aux | grep node

# Check if port is in use
sudo lsof -i :3001

# Test API endpoint
curl http://localhost:3001/api/health

# Check environment variables (be careful with secrets!)
pm2 env finalcut-server

# Kill process on port (if stuck)
# First find the PID
sudo lsof -i :3001
# Then kill it
sudo kill -9 <PID>
```

### Git Operations

```bash
# Check current branch
git branch

# Pull latest changes
git pull

# Check status
git status

# View recent commits
git log --oneline -10

# Stash local changes
git stash

# Apply stashed changes
git stash pop
```

## Environment Variables

Required in `.env`:

```bash
XAI_API_TOKEN=your_xai_api_token_here
PORT=3001
NODE_ENV=production
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

## File Locations

- **Application**: `/home/finalcut/apps/pages/finalcut`
- **Built files**: `/home/finalcut/apps/pages/finalcut/dist`
- **Nginx config**: `/etc/nginx/sites-available/finalcut`
- **SSL certs**: `/etc/letsencrypt/live/yourdomain.com/`
- **PM2 logs**: `~/.pm2/logs/`
- **Nginx logs**: `/var/log/nginx/`

## Troubleshooting Quick Fixes

### App won't start
```bash
pm2 logs finalcut-server --lines 50
# Check .env file exists
cat .env
```

### 502 Bad Gateway
```bash
pm2 status  # Check if app is running
sudo systemctl status nginx  # Check if Nginx is running
sudo netstat -tulpn | grep 3001  # Check if port is listening
```

### Cannot connect to API
```bash
# Check firewall
sudo ufw status
# Check Nginx proxy configuration
sudo nginx -t
```

### Out of disk space
```bash
df -h
# Clean npm cache
npm cache clean --force
# Clean old PM2 logs
pm2 flush
```

### High memory usage
```bash
pm2 monit
# Restart app
pm2 restart finalcut-server
```

## Security Checklist

- [ ] UFW firewall enabled
- [ ] SSH key authentication configured
- [ ] `.env` file not in Git
- [ ] SSL certificate installed
- [ ] Regular system updates scheduled
- [ ] PM2 or systemd managing process
- [ ] Nginx security headers configured
- [ ] Strong passwords for all accounts
- [ ] Regular backups configured

## Backup Commands

```bash
# Backup application files
tar -czf finalcut-backup-$(date +%Y%m%d).tar.gz /home/finalcut/apps/pages/finalcut

# Backup Nginx config
sudo cp /etc/nginx/sites-available/finalcut ~/finalcut-nginx-backup.conf

# Backup environment file
cp /home/finalcut/apps/pages/finalcut/.env ~/finalcut-env-backup
```

## Performance Optimization

```bash
# Enable Gzip in Nginx (already in nginx.conf)

# Check Nginx worker processes
grep worker_processes /etc/nginx/nginx.conf

# Monitor application performance
pm2 monit

# Check node memory usage
node -e "console.log(process.memoryUsage())"
```

## URLs to Bookmark

- **DigitalOcean Dashboard**: https://cloud.digitalocean.com/
- **GoDaddy DNS**: https://dcc.godaddy.com/manage/dns
- **DNS Propagation Checker**: https://www.whatsmydns.net/
- **SSL Test**: https://www.ssllabs.com/ssltest/
- **xAI Console**: https://console.x.ai/

## Getting Help

- **Deployment Guide**: `DEPLOYMENT.md`
- **GitHub Issues**: https://github.com/yishengjiang99/pages/issues
- **DigitalOcean Community**: https://www.digitalocean.com/community
- **PM2 Docs**: https://pm2.keymetrics.io/docs/
- **Nginx Docs**: https://nginx.org/en/docs/
