# FinalCut Deployment Troubleshooting Guide

This guide covers common issues you may encounter when deploying the FinalCut application and how to resolve them.

## Table of Contents

1. [Deployment Issues](#deployment-issues)
2. [Application Issues](#application-issues)
3. [Nginx Issues](#nginx-issues)
4. [DNS and SSL Issues](#dns-and-ssl-issues)
5. [Performance Issues](#performance-issues)
6. [Video Processing Issues](#video-processing-issues)

---

## Deployment Issues

### Issue: Cannot SSH into Droplet

**Symptoms:**
- `Connection refused` or `Connection timed out` errors
- Cannot connect via SSH

**Solutions:**

1. **Verify droplet is running:**
   - Check DigitalOcean dashboard
   - Ensure droplet is powered on

2. **Check SSH key:**
   ```bash
   # Verify SSH key is added to ssh-agent
   ssh-add -l
   
   # If not added, add it
   ssh-add ~/.ssh/id_rsa
   ```

3. **Try password authentication:**
   ```bash
   ssh -o PubkeyAuthentication=no root@YOUR_DROPLET_IP
   ```

4. **Check firewall:**
   - Ensure UFW allows SSH: `sudo ufw status`
   - Check DigitalOcean firewall settings

5. **Use DigitalOcean Console:**
   - Access droplet through DigitalOcean's web console
   - From there, you can fix SSH configuration

### Issue: Git Clone Fails

**Symptoms:**
- `Permission denied` or `Authentication failed`

**Solutions:**

1. **For public repository:**
   ```bash
   git clone https://github.com/yishengjiang99/pages.git
   ```

2. **For private repository:**
   ```bash
   # Generate SSH key on server
   ssh-keygen -t rsa -b 4096 -C "your_email@example.com"
   
   # Display public key
   cat ~/.ssh/id_rsa.pub
   
   # Add to GitHub: Settings → SSH and GPG keys → New SSH key
   
   # Clone with SSH
   git clone git@github.com:yishengjiang99/pages.git
   ```

3. **Use deploy token:**
   - Create a GitHub deploy token
   - Use HTTPS with token: `git clone https://TOKEN@github.com/yishengjiang99/pages.git`

### Issue: npm install Fails

**Symptoms:**
- Package installation errors
- Dependency resolution failures

**Solutions:**

1. **Clear npm cache:**
   ```bash
   npm cache clean --force
   rm -rf node_modules package-lock.json
   npm install
   ```

2. **Check Node.js version:**
   ```bash
   node -v  # Should be 18 or higher
   ```

3. **Install with different flags:**
   ```bash
   npm ci --production=false
   # or
   npm install --legacy-peer-deps
   ```

4. **Check disk space:**
   ```bash
   df -h
   ```

---

## Application Issues

### Issue: Application Won't Start

**Symptoms:**
- PM2 shows app as stopped or errored
- App keeps restarting

**Diagnostic Steps:**

1. **Check PM2 logs:**
   ```bash
   pm2 logs finalcut-server --lines 50
   ```

2. **Check for errors:**
   ```bash
   pm2 describe finalcut-server
   ```

**Common Causes and Solutions:**

#### Missing .env file
```bash
# Verify .env exists
ls -la /home/finalcut/apps/pages/finalcut/.env

# If missing, create it
cp .env.example .env
nano .env
```

#### Missing XAI_API_TOKEN
```bash
# Check .env file
cat .env | grep XAI_API_TOKEN

# Ensure it's set to actual token (not placeholder)
```

#### Port already in use
```bash
# Check what's using port 3001
sudo lsof -i :3001

# Kill the process (replace PID)
sudo kill -9 <PID>

# Or change port in .env
```

#### Build files missing
```bash
cd /home/finalcut/apps/pages/finalcut
npm run build
```

#### Node version incompatible
```bash
node -v  # Must be 18+
nvm use 18  # If using nvm
```

### Issue: API Requests Fail

**Symptoms:**
- "Network Error" in browser console
- API returns 500 errors

**Solutions:**

1. **Check if server is running:**
   ```bash
   pm2 status
   curl http://localhost:3001/api/chat
   ```

2. **Check CORS configuration:**
   - Verify ALLOWED_ORIGINS in .env includes your domain
   - Check browser console for CORS errors

3. **Check xAI API token:**
   ```bash
   # Test token manually
   curl -H "Authorization: Bearer YOUR_TOKEN" \
        https://api.grok.x.ai/v1/models
   ```

4. **Check firewall:**
   ```bash
   sudo ufw status
   # Ensure port 3001 is accessible (or proxied through Nginx)
   ```

### Issue: Environment Variables Not Loading

**Symptoms:**
- "XAI_API_TOKEN environment variable is not set" error
- App uses wrong configuration

**Solutions:**

1. **Verify .env file:**
   ```bash
   cat .env
   ls -l .env  # Check permissions
   ```

2. **Restart with environment:**
   ```bash
   pm2 restart finalcut-server --update-env
   ```

3. **Check environment in PM2:**
   ```bash
   pm2 env finalcut-server
   ```

4. **Load .env manually:**
   ```bash
   source .env
   pm2 restart finalcut-server
   ```

---

## Nginx Issues

### Issue: 502 Bad Gateway

**Symptoms:**
- Browser shows "502 Bad Gateway" error
- Cannot access application

**Diagnostic Steps:**

1. **Check if Node.js app is running:**
   ```bash
   pm2 status
   sudo netstat -tulpn | grep 3001
   ```

2. **Check Nginx error logs:**
   ```bash
   sudo tail -f /var/log/nginx/error.log
   ```

**Solutions:**

1. **Restart Node.js app:**
   ```bash
   pm2 restart finalcut-server
   ```

2. **Verify proxy configuration:**
   ```bash
   sudo cat /etc/nginx/sites-available/finalcut | grep proxy_pass
   # Should be: proxy_pass http://localhost:3001;
   ```

3. **Check if app is listening:**
   ```bash
   curl http://localhost:3001/api/health
   ```

4. **Restart Nginx:**
   ```bash
   sudo systemctl restart nginx
   ```

### Issue: 404 Not Found

**Symptoms:**
- Main page loads but routes return 404
- Static files not found

**Solutions:**

1. **Check dist directory:**
   ```bash
   ls -la /home/finalcut/apps/pages/finalcut/dist/
   ```

2. **Rebuild application:**
   ```bash
   cd /home/finalcut/apps/pages/finalcut
   npm run build
   ```

3. **Verify Nginx root path:**
   ```bash
   sudo cat /etc/nginx/sites-available/finalcut | grep root
   # Should be: root /home/finalcut/apps/pages/finalcut/dist;
   ```

4. **Check file permissions:**
   ```bash
   ls -la /home/finalcut/apps/pages/finalcut/dist/
   # Ensure files are readable by www-data user
   sudo chmod -R 755 /home/finalcut/apps/pages/finalcut/dist/
   ```

### Issue: Static Files Not Loading

**Symptoms:**
- Page loads but no CSS/JS
- Browser console shows 404 for assets

**Solutions:**

1. **Check build output:**
   ```bash
   ls -la /home/finalcut/apps/pages/finalcut/dist/assets/
   ```

2. **Verify Nginx configuration:**
   ```bash
   sudo nginx -t
   ```

3. **Check browser console:**
   - Look for the requested path
   - Verify it matches Nginx configuration

4. **Update vite.config.js base:**
   - If deploying to subdirectory, update `base` in vite.config.js

### Issue: Nginx Configuration Test Fails

**Symptoms:**
- `nginx -t` shows errors
- Cannot reload Nginx

**Solutions:**

1. **Check syntax errors:**
   ```bash
   sudo nginx -t
   # Read error message carefully
   ```

2. **Common syntax issues:**
   - Missing semicolons
   - Unclosed braces
   - Invalid directives

3. **Validate configuration:**
   ```bash
   sudo cat /etc/nginx/sites-available/finalcut
   ```

4. **Use default configuration as reference:**
   ```bash
   cat /etc/nginx/sites-available/default
   ```

---

## DNS and SSL Issues

### Issue: Domain Not Resolving

**Symptoms:**
- Cannot access site via domain
- Works with IP address but not domain

**Diagnostic Steps:**

1. **Check DNS propagation:**
   - Visit: https://www.whatsmydns.net/
   - Enter your domain
   - Check A records globally

2. **Test DNS locally:**
   ```bash
   nslookup yourdomain.com
   dig yourdomain.com
   ```

**Solutions:**

1. **Verify GoDaddy DNS records:**
   - Log in to GoDaddy
   - Check A records point to correct IP
   - Ensure no typos in domain name

2. **Wait for propagation:**
   - Can take 1-48 hours
   - Typical: 1-2 hours

3. **Flush local DNS cache:**
   ```bash
   # macOS
   sudo dscacheutil -flushcache
   
   # Windows
   ipconfig /flushdns
   
   # Linux
   sudo systemd-resolve --flush-caches
   ```

4. **Check nameservers:**
   ```bash
   dig yourdomain.com NS
   # Should show GoDaddy nameservers
   ```

### Issue: SSL Certificate Not Working

**Symptoms:**
- "Not Secure" warning in browser
- HTTPS not working
- Certificate errors

**Diagnostic Steps:**

1. **Check certificate status:**
   ```bash
   sudo certbot certificates
   ```

2. **Test SSL configuration:**
   - Visit: https://www.ssllabs.com/ssltest/
   - Enter your domain

**Solutions:**

1. **Obtain certificate:**
   ```bash
   sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
   ```

2. **Verify Nginx SSL configuration:**
   ```bash
   sudo cat /etc/nginx/sites-available/finalcut | grep ssl
   ```

3. **Check certificate files:**
   ```bash
   sudo ls -la /etc/letsencrypt/live/yourdomain.com/
   ```

4. **Renew certificate:**
   ```bash
   sudo certbot renew
   sudo systemctl reload nginx
   ```

### Issue: Certificate Auto-Renewal Fails

**Symptoms:**
- Certificate expired
- Renewal cron job fails

**Solutions:**

1. **Test renewal:**
   ```bash
   sudo certbot renew --dry-run
   ```

2. **Check certbot logs:**
   ```bash
   sudo tail -f /var/log/letsencrypt/letsencrypt.log
   ```

3. **Manually renew:**
   ```bash
   sudo certbot renew --force-renewal
   ```

4. **Check renewal timer:**
   ```bash
   sudo systemctl status certbot.timer
   sudo systemctl enable certbot.timer
   ```

---

## Performance Issues

### Issue: Slow Page Load

**Solutions:**

1. **Enable Gzip compression:**
   - Already included in nginx.conf

2. **Check server resources:**
   ```bash
   htop
   free -h
   df -h
   ```

3. **Monitor application:**
   ```bash
   pm2 monit
   ```

4. **Upgrade droplet:**
   - Consider larger droplet size
   - Add more RAM/CPU

5. **Use CDN:**
   - Cloudflare (free tier)
   - DigitalOcean Spaces

### Issue: High Memory Usage

**Symptoms:**
- Server becomes unresponsive
- PM2 shows high memory usage

**Solutions:**

1. **Monitor memory:**
   ```bash
   free -h
   pm2 monit
   ```

2. **Restart application:**
   ```bash
   pm2 restart finalcut-server
   ```

3. **Add swap space:**
   ```bash
   sudo fallocate -l 2G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

4. **Upgrade server:**
   - Consider droplet with more RAM

### Issue: High CPU Usage

**Solutions:**

1. **Check processes:**
   ```bash
   top
   htop
   ps aux | sort -nrk 3,3 | head -n 5
   ```

2. **Check PM2:**
   ```bash
   pm2 monit
   ```

3. **Optimize application:**
   - Review code for inefficiencies
   - Add caching where appropriate

---

## Video Processing Issues

### Issue: Video Processing Fails

**Symptoms:**
- Videos fail to process
- Browser console shows FFmpeg errors

**Solutions:**

1. **Check browser compatibility:**
   - Ensure browser supports WebAssembly
   - Try different browser

2. **Check video format:**
   - FFmpeg may not support all codecs
   - Try different video file

3. **Check file size:**
   - Very large files may timeout
   - Check Nginx client_max_body_size (set to 100M)

4. **Check CORS headers:**
   - Verify Cross-Origin headers are set
   - Check browser console for CORS errors

5. **Check browser console:**
   ```javascript
   // Should see FFmpeg loaded successfully
   ```

### Issue: Large Video Upload Fails

**Symptoms:**
- Upload times out
- 413 Request Entity Too Large

**Solutions:**

1. **Increase Nginx client_max_body_size:**
   ```nginx
   # Already set to 100M in nginx.conf
   # To increase further:
   client_max_body_size 500M;
   ```

2. **Increase timeouts:**
   ```nginx
   # Already set in nginx.conf
   proxy_connect_timeout 600s;
   proxy_send_timeout 600s;
   proxy_read_timeout 600s;
   ```

3. **Increase Node.js body limit:**
   ```javascript
   // In server.js - already set to 50mb
   app.use(express.json({ limit: '50mb' }));
   ```

4. **Check disk space:**
   ```bash
   df -h
   ```

---

## Still Need Help?

If you're still experiencing issues:

1. **Check logs:**
   - PM2: `pm2 logs finalcut-server --lines 100`
   - Nginx: `sudo tail -100 /var/log/nginx/error.log`
   - System: `sudo journalctl -xe`

2. **Create GitHub issue:**
   - https://github.com/yishengjiang99/pages/issues
   - Include error logs
   - Describe steps to reproduce

3. **Community support:**
   - DigitalOcean Community
   - Stack Overflow
   - GitHub Discussions

4. **Professional support:**
   - Consider DigitalOcean managed services
   - Hire a DevOps consultant
