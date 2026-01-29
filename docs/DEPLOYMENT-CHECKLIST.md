# FinalCut Deployment Checklist

Use this checklist to track your deployment progress. Check off each item as you complete it.

## Pre-Deployment Preparation

### DigitalOcean Account Setup
- [ ] Create DigitalOcean account
- [ ] Add payment method
- [ ] Generate SSH key pair on your local machine
- [ ] Add SSH key to DigitalOcean account

### Domain and DNS Preparation
- [ ] Have existing GoDaddy domain ready
- [ ] Know your domain name (e.g., yourdomain.com)
- [ ] Have GoDaddy account login credentials

### Application Requirements
- [ ] Obtain xAI API token from https://console.x.ai/
- [ ] Save API token securely (you'll need it later)
- [ ] Review application requirements in README.md

---

## DigitalOcean Droplet Setup

### Create Droplet
- [ ] Log in to DigitalOcean
- [ ] Click "Create" → "Droplets"
- [ ] Select Ubuntu 22.04 LTS
- [ ] Choose droplet size (recommended: 2GB RAM / $12/month)
- [ ] Select datacenter region (closest to your users)
- [ ] Add your SSH key
- [ ] Set hostname (e.g., finalcut-prod)
- [ ] Create droplet
- [ ] Note droplet IP address: `___________________`

### Initial Server Access
- [ ] SSH into droplet as root: `ssh root@YOUR_DROPLET_IP`
- [ ] Verify you can connect successfully

---

## Server Configuration

### Option A: Automated Setup (Recommended)

- [ ] Download setup script:
  ```bash
  wget https://raw.githubusercontent.com/yishengjiang99/pages/main/finalcut/setup-server.sh
  ```
- [ ] Make script executable: `chmod +x setup-server.sh`
- [ ] Run setup script: `sudo ./setup-server.sh`
- [ ] Verify setup completed successfully
- [ ] Switch to finalcut user: `sudo su - finalcut`

### Option B: Manual Setup (Skip if you used Option A)

- [ ] Update system packages: `apt update && apt upgrade -y`
- [ ] Install Node.js 18
- [ ] Install Nginx
- [ ] Install PM2: `npm install -g pm2`
- [ ] Install Git
- [ ] Create finalcut user: `adduser finalcut`
- [ ] Add user to sudo group: `usermod -aG sudo finalcut`
- [ ] Configure firewall (UFW)
- [ ] Configure PM2 startup

---

## Application Deployment

### Clone and Setup
- [ ] Switch to finalcut user: `sudo su - finalcut`
- [ ] Create apps directory: `mkdir -p ~/apps && cd ~/apps`
- [ ] Clone repository: `git clone https://github.com/yishengjiang99/pages.git`
- [ ] Navigate to finalcut: `cd pages/finalcut`

### Install Dependencies
- [ ] Run: `npm install`
- [ ] Verify no errors in installation

### Configure Environment
- [ ] Copy environment template: `cp .env.example .env`
- [ ] Edit .env file: `nano .env`
- [ ] Set XAI_API_TOKEN to your actual token
- [ ] Set NODE_ENV=production
- [ ] Set ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
  - Replace `yourdomain.com` with your actual domain
- [ ] Save and exit (Ctrl+X, Y, Enter)
- [ ] Verify .env file: `cat .env` (check values are correct)

### Build Application
- [ ] Run build: `npm run build`
- [ ] Verify build completed successfully
- [ ] Check dist directory exists: `ls -la dist/`

### Start Application with PM2
- [ ] Start server: `pm2 start server.js --name finalcut-server`
- [ ] Save PM2 process list: `pm2 save`
- [ ] Verify app is running: `pm2 status`
- [ ] Check logs: `pm2 logs finalcut-server --lines 20`
- [ ] Test locally: `curl http://localhost:3001/api/health`

---

## Nginx Configuration

### Configure Nginx
- [ ] Exit to root/sudo user: `exit`
- [ ] Copy Nginx config:
  ```bash
  sudo cp /home/finalcut/apps/pages/finalcut/nginx.conf /etc/nginx/sites-available/finalcut
  ```
- [ ] Edit config: `sudo nano /etc/nginx/sites-available/finalcut`
- [ ] Replace ALL instances of `yourdomain.com` with your actual domain
- [ ] Save and exit
- [ ] Create symbolic link:
  ```bash
  sudo ln -s /etc/nginx/sites-available/finalcut /etc/nginx/sites-enabled/
  ```
- [ ] Test Nginx config: `sudo nginx -t`
- [ ] If test passes, reload Nginx: `sudo systemctl reload nginx`

---

## DNS Configuration

### Configure GoDaddy DNS
- [ ] Log in to GoDaddy: https://www.godaddy.com/
- [ ] Navigate to "My Products" → Your Domain → "DNS"
- [ ] Add/Update A record for root domain:
  - Type: `A`
  - Name: `@`
  - Value: Your droplet IP
  - TTL: `600` seconds
- [ ] Add/Update A record for www subdomain:
  - Type: `A`
  - Name: `www`
  - Value: Your droplet IP
  - TTL: `600` seconds
- [ ] Save changes
- [ ] Note time DNS was updated: `___________________`

### Wait for DNS Propagation
- [ ] Wait at least 10-15 minutes
- [ ] Check DNS propagation: https://www.whatsmydns.net/
- [ ] Enter your domain and verify A records point to your droplet IP
- [ ] Test domain resolution: `nslookup yourdomain.com`

---

## SSL Certificate Setup

### Install Certbot
- [ ] Install Certbot: `sudo apt install certbot python3-certbot-nginx -y`

### Obtain SSL Certificate
- [ ] Run Certbot:
  ```bash
  sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
  ```
  (Replace with your actual domain)
- [ ] Enter email address for renewal notifications
- [ ] Agree to terms of service (Y)
- [ ] Choose whether to redirect HTTP to HTTPS (recommended: Yes)
- [ ] Verify certificate obtained successfully

### Verify SSL
- [ ] Visit https://yourdomain.com in browser
- [ ] Verify HTTPS works and certificate is valid
- [ ] Check for padlock icon in browser
- [ ] Test SSL: https://www.ssllabs.com/ssltest/

### Configure Auto-Renewal
- [ ] Test renewal: `sudo certbot renew --dry-run`
- [ ] Verify test passes

---

## Final Verification

### Test Application
- [ ] Visit https://yourdomain.com
- [ ] Verify page loads correctly
- [ ] Upload a test video
- [ ] Try AI chat functionality
- [ ] Test video editing features
- [ ] Check browser console for errors (F12)

### Verify Server Status
- [ ] Check PM2: `pm2 status`
- [ ] Check Nginx: `sudo systemctl status nginx`
- [ ] Check disk space: `df -h`
- [ ] Check memory: `free -h`

### Configure Monitoring
- [ ] Set up PM2 monitoring: `pm2 monit`
- [ ] Consider setting up uptime monitoring (e.g., UptimeRobot)
- [ ] Set up email alerts for server issues

---

## Post-Deployment Tasks

### Documentation
- [ ] Save deployment details in secure location:
  - Droplet IP: `___________________`
  - Domain: `___________________`
  - SSH key location: `___________________`
  - xAI API token location: `___________________`
- [ ] Bookmark DigitalOcean dashboard
- [ ] Bookmark GoDaddy DNS management

### Security
- [ ] Verify .env file is not in Git: `git status`
- [ ] Set secure .env permissions: `chmod 600 .env`
- [ ] Review firewall rules: `sudo ufw status`
- [ ] Consider setting up automatic security updates
- [ ] Set up regular backups

### Deployment Script
- [ ] Test deployment script: `./deploy.sh`
- [ ] Verify script works for updates
- [ ] Bookmark deployment documentation

---

## Optional Enhancements

### Performance Optimization
- [ ] Set up Cloudflare CDN
- [ ] Enable additional caching
- [ ] Configure database (if adding later)
- [ ] Set up Redis for sessions (if needed)

### Monitoring and Analytics
- [ ] Set up application monitoring (e.g., New Relic, DataDog)
- [ ] Set up error tracking (e.g., Sentry)
- [ ] Configure analytics (e.g., Google Analytics)
- [ ] Set up log aggregation

### CI/CD
- [ ] Set up GitHub Actions for automated deployment
- [ ] Configure GitHub secrets:
  - DROPLET_IP
  - DROPLET_USER
  - DROPLET_SSH_KEY
- [ ] Test automated deployment workflow

### Backup Strategy
- [ ] Enable DigitalOcean automated backups ($1-2/month)
- [ ] Set up manual backup script
- [ ] Test restore procedure
- [ ] Document backup locations

---

## Troubleshooting

If you encounter issues:

1. **Check the guides:**
   - [ ] Review DEPLOYMENT.md
   - [ ] Check TROUBLESHOOTING.md
   - [ ] Reference QUICK-REFERENCE.md

2. **Check logs:**
   - [ ] PM2 logs: `pm2 logs finalcut-server`
   - [ ] Nginx logs: `sudo tail -f /var/log/nginx/error.log`
   - [ ] System logs: `sudo journalctl -xe`

3. **Get help:**
   - [ ] Search GitHub issues
   - [ ] Ask in DigitalOcean community
   - [ ] Create new GitHub issue

---

## Maintenance Schedule

Set up regular maintenance:

- [ ] **Weekly**: Check application logs
- [ ] **Weekly**: Monitor resource usage
- [ ] **Monthly**: Update system packages: `sudo apt update && sudo apt upgrade`
- [ ] **Monthly**: Review security logs
- [ ] **Quarterly**: Review and update dependencies
- [ ] **Quarterly**: Test backup restoration

---

## Success! 🎉

Congratulations! Your FinalCut application is now deployed and running on DigitalOcean with a custom domain and SSL certificate.

**Your application URL:** https://yourdomain.com

### Next Steps:
- Share your application with users
- Monitor performance and usage
- Consider scaling as needed
- Keep application and server updated

### Keep These Commands Handy:
```bash
# Check application status
pm2 status

# View logs
pm2 logs finalcut-server

# Deploy updates
cd /home/finalcut/apps/pages/finalcut && ./deploy.sh

# Restart application
pm2 restart finalcut-server

# Check server resources
htop
```

---

**Deployment Date:** ___________________

**Deployed By:** ___________________

**Notes:** 
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________
