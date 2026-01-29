# FinalCut Deployment Guide to DigitalOcean

This guide provides comprehensive instructions for deploying the FinalCut application to a DigitalOcean Node.js droplet with DNS configuration on GoDaddy.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [DigitalOcean Droplet Setup](#digitalocean-droplet-setup)
3. [Server Configuration](#server-configuration)
4. [Application Deployment](#application-deployment)
5. [DNS Configuration on GoDaddy](#dns-configuration-on-godaddy)
6. [SSL Certificate Setup](#ssl-certificate-setup)
7. [Automated Deployment](#automated-deployment)
8. [Monitoring and Maintenance](#monitoring-and-maintenance)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before starting the deployment process, ensure you have:

- **DigitalOcean Account**: Sign up at https://www.digitalocean.com/
- **GoDaddy Domain**: An existing domain registered with GoDaddy
- **xAI API Token**: Obtain from https://console.x.ai/
- **SSH Key**: Generated on your local machine for secure server access
- **Git**: Installed on your local machine
- **Basic Linux Knowledge**: Familiarity with command-line operations

---

## DigitalOcean Droplet Setup

### Step 1: Create a New Droplet

1. **Log in to DigitalOcean** and click "Create" → "Droplets"

2. **Choose an Image**:
   - Select **Ubuntu 22.04 LTS** (recommended)

3. **Choose Droplet Size**:
   - **Basic Plan**: Starting at $6/month (1GB RAM, 1 vCPU)
   - **Recommended**: $12/month (2GB RAM, 2 vCPU) for better performance
   - For production with high traffic: $24/month or higher

4. **Choose a Datacenter Region**:
   - Select the region closest to your primary user base
   - Example: New York, San Francisco, London, etc.

5. **Authentication**:
   - **Recommended**: Use SSH keys for secure access
   - Upload your existing SSH public key or create a new one:
     ```bash
     ssh-keygen -t rsa -b 4096 -C "your_email@example.com"
     cat ~/.ssh/id_rsa.pub
     ```
   - Copy the output and add it to DigitalOcean

6. **Finalize and Create**:
   - Choose a hostname (e.g., `finalcut-prod`)
   - Add tags if needed (e.g., `production`, `finalcut`)
   - Click "Create Droplet"

7. **Note Your Droplet IP**:
   - Once created, note the IP address (e.g., `123.456.789.012`)
   - 64.23.239.208

---

## Server Configuration

### Step 2: Initial Server Setup

SSH into your new droplet:

```bash
ssh root@YOUR_DROPLET_IP
```

#### Update System Packages

```bash
apt update && apt upgrade -y
```

#### Create a Non-Root User

```bash
# Create new user
adduser finalcut

# Add user to sudo group
usermod -aG sudo finalcut

# Copy SSH keys to new user
rsync --archive --chown=finalcut:finalcut ~/.ssh /home/finalcut
```

### install nginx
#### Install Nginx on Ubuntu 22.04

1. **Update Package List**:
   ```bash
   sudo apt update
   ```

2. **Install Nginx**:
   ```bash
   sudo apt install nginx -y
   ```

3. **Start and Enable Nginx**:
   ```bash
   sudo systemctl start nginx
   sudo systemctl enable nginx
   ```

4. **Verify Installation**:
   - Open your browser and visit your server's IP address (e.g., `http://YOUR_DROPLET_IP`).
   - You should see the default Nginx welcome page.

5. **Check Nginx Status**:
   ```bash
   sudo systemctl status nginx
   ```

#### Configure Firewall

```bash
# Enable firewall
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

### Step 3: Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
apt-get install -y nodejs

# Verify installation


npm --version

```

### Step 4: Install Nginx

```bash
# Install Nginx
apt install nginx -y

# Start and enable Nginx
systemctl start nginx
systemctl enable nginx
```

### Step 5: Install Git

```bash
apt install git -y
```

---

## Application Deployment

### Step 6: Deploy the Application

#### Clone the Repository

```bash
# Switch to finalcut user
su - finalcut

# Create app directory
mkdir -p /home/finalcut/apps
cd /home/finalcut/apps

# Clone the repository
git clone https://github.com/yishengjiang99/pages.git
cd pages/finalcut
```

#### Install Dependencies

```bash
# Install Node.js dependencies
npm install
```

#### Configure Environment Variables

```bash
# Copy environment template
cp .env.example .env

# Edit environment file
nano .env
```

Add the following to `.env`:

```bash
# xAI API Token
XAI_API_TOKEN=your_actual_xai_api_token_here

# Server Port
PORT=3001

# Node Environment
NODE_ENV=production

# Allowed CORS Origins
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

Replace:
- `your_actual_xai_api_token_here` with your actual xAI API token
- `yourdomain.com` with your actual domain name

**Important**: Ensure the `.env` file is not tracked by Git (it's already in `.gitignore`)

#### Build the Frontend

```bash
# Build the React application
npm run build
```

This creates optimized production files in the `dist/` directory.

#### Set Permissions for `dist` Folder

```bash
# Set ownership to www-data
sudo chown -R www-data:www-data /home/finalcut/apps/pages/finalcut/dist

# Set permissions
sudo chmod -R 755 /home/finalcut/apps/pages/finalcut/dist
```

This ensures the folder is readable by Nginx while maintaining security.

#### Set up the Application as a systemd Service

```bash
# Copy the systemd service file
sudo cp finalcut.service /etc/systemd/system/finalcut.service

# Reload systemd to recognize the new service
sudo systemctl daemon-reload

# Enable the service to start on boot
sudo systemctl enable finalcut

# Start the service
sudo systemctl start finalcut

# Check status
sudo systemctl status finalcut

# View logs
sudo journalctl -u finalcut -f
```

### Step 7: Configure Nginx as Reverse Proxy

### Remove Default Nginx Page

After installing Nginx, the default welcome page is served. To remove it:

1. **Delete the Default Configuration**:
   ```bash
   sudo rm /etc/nginx/sites-enabled/default
   ```

2. **Reload Nginx**:
   ```bash
   sudo systemctl reload nginx
   ```

This ensures only your custom configuration is active.

Create an Nginx configuration file:

```bash
sudo nano /etc/nginx/sites-available/finalcut
```

Add the following configuration:

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    # Root directory for built frontend files
    root /home/finalcut/apps/pages/finalcut/dist;
    index index.html;

    # Add security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # CORS headers for FFmpeg WebAssembly
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;

    # Serve static files
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API requests to Node.js server
   location /api {
         proxy_pass http://localhost:3001;
         proxy_http_version 1.1;
         proxy_set_header Upgrade $http_upgrade;
         proxy_set_header Connection 'upgrade';
         proxy_set_header Host $host;
         proxy_set_header X-Real-IP $remote_addr;
         proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      }

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Increase client body size for video uploads
    client_max_body_size 100M;
}
```

Replace `yourdomain.com` with your actual domain.

Enable the site:

```bash
# Create symbolic link
sudo ln -s /etc/nginx/sites-available/finalcut /etc/nginx/sites-enabled/

# Test Nginx configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

---

## DNS Configuration on GoDaddy

### Step 8: Configure DNS Records

1. **Log in to GoDaddy** at https://www.godaddy.com/

2. **Navigate to DNS Management**:
   - Go to "My Products"
   - Find your domain and click "DNS"

3. **Add/Update A Records**:

   **For Root Domain** (example.com):
   - Type: `A`
   - Name: `@`
   - Value: `YOUR_DROPLET_IP`
   - TTL: `600` (10 minutes) or default

   **For WWW Subdomain** (www.example.com):
   - Type: `A`
   - Name: `www`
   - Value: `YOUR_DROPLET_IP`
   - TTL: `600` (10 minutes) or default

4. **Optional: Add CNAME Record**:
   - Type: `CNAME`
   - Name: `www`
   - Value: `@` (points to root domain)
   - TTL: `1 Hour`

5. **Save Changes**

6. **Wait for DNS Propagation**:
   - DNS changes can take 1-48 hours to propagate globally
   - Typically propagates within 1-2 hours
   - Check propagation: https://www.whatsmydns.net/

---

## SSL Certificate Setup

### Step 9: Install SSL Certificate with Let's Encrypt

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx -y

# Obtain and install SSL certificate
sudo certbot --nginx -d grepawk.com -d www.grepawk.com

# Follow the prompts:
# - Enter your email address
# - Agree to terms of service
# - Choose whether to redirect HTTP to HTTPS (recommended: Yes)
```

Certbot will automatically:
- Obtain the SSL certificate
- Configure Nginx to use HTTPS
- Set up automatic renewal

#### Verify Auto-Renewal

```bash
# Test renewal process
sudo certbot renew --dry-run
```

The certificate will automatically renew before expiration.

#### Verify HTTPS Configuration

After SSL setup, your Nginx config will be automatically updated. Verify it works:

```bash
# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

Visit `https://yourdomain.com` to verify SSL is working.

---

## Automated Deployment

### Step 10: Create Deployment Script

Create a deployment script for easy updates:

```bash
cd /home/finalcut/apps/pages/finalcut
nano deploy.sh
```

Add the deployment script content (see `deploy.sh` file in the repository).

Make it executable:

```bash
chmod +x deploy.sh
```

### Step 11: Update the Application

When you need to deploy updates:

```bash
cd /home/finalcut/apps/pages/finalcut
./deploy.sh
```

---

## Monitoring and Maintenance

### Monitor Application

```bash
# View service status
sudo systemctl status finalcut

# View real-time logs
sudo journalctl -u finalcut -f

# View last 100 lines of logs
sudo journalctl -u finalcut -n 100

# Monitor system resources
htop
```

### Monitor Nginx

```bash
# Check Nginx status
sudo systemctl status nginx

# View Nginx error logs
sudo tail -f /var/log/nginx/error.log

# View Nginx access logs
sudo tail -f /var/log/nginx/access.log
```

### Restart Services

```bash
# Restart Node.js app
sudo systemctl restart finalcut

# Restart Nginx
sudo systemctl restart nginx
```

### Server Maintenance

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# View disk usage
df -h

# View memory usage
free -h

# View running processes
htop
```

---

## Troubleshooting

### Application Won't Start

1. **Check service logs**:
   ```bash
   sudo journalctl -u finalcut -n 50
   ```

2. **Verify environment variables**:
   ```bash
   cat /home/finalcut/apps/pages/finalcut/.env
   ```

3. **Check if port is already in use**:
   ```bash
   sudo lsof -i :3001
   ```

4. **Restart the application**:
   ```bash
   sudo systemctl restart finalcut
   ```

### Nginx Errors

1. **Test Nginx configuration**:
   ```bash
   sudo nginx -t
   ```

2. **Check error logs**:
   ```bash
   sudo tail -f /var/log/nginx/error.log
   ```

3. **Verify file permissions**:
   ```bash
   ls -la /home/finalcut/apps/pages/finalcut/dist/
   ```

### DNS Not Resolving

1. **Check DNS propagation**:
   - Use https://www.whatsmydns.net/
   - Enter your domain and check A records

2. **Verify DNS records in GoDaddy**:
   - Ensure A records point to correct IP

3. **Flush local DNS cache**:
   ```bash
   # On macOS
   sudo dscacheutil -flushcache

   # On Windows
   ipconfig /flushdns

   # On Linux
   sudo systemd-resolve --flush-caches
   ```

### SSL Certificate Issues

1. **Check certificate status**:
   ```bash
   sudo certbot certificates
   ```

2. **Renew certificate manually**:
   ```bash
   sudo certbot renew
   ```

3. **Check Nginx SSL configuration**:
   ```bash
   sudo cat /etc/nginx/sites-available/finalcut
   ```

### 502 Bad Gateway Error

This usually means Nginx can't connect to the Node.js server:

1. **Check if Node.js server is running**:
   ```bash
   sudo systemctl status finalcut
   ```

2. **Verify the server is listening on correct port**:
   ```bash
   sudo netstat -tulpn | grep 3001
   ```

3. **Check firewall rules**:
   ```bash
   sudo ufw status
   ```

4. **Review Node.js logs**:
   ```bash
   sudo journalctl -u finalcut -f
   ```

### Large File Upload Issues

If video uploads fail:

1. **Increase Nginx client_max_body_size** (already set to 100M in config)

2. **Increase Node.js payload limit** (already set to 50mb in server.js)

3. **Check disk space**:
   ```bash
   df -h
   ```

---

## Security Best Practices

1. **Keep System Updated**:
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```

2. **Use Strong Passwords**: For all user accounts

3. **Enable Automatic Security Updates**:
   ```bash
   sudo apt install unattended-upgrades -y
   sudo dpkg-reconfigure --priority=low unattended-upgrades
   ```

4. **Regular Backups**:
   - Use DigitalOcean's automated backup feature
   - Or set up manual backups with cron jobs

5. **Monitor Logs Regularly**: Check for suspicious activity

6. **Limit SSH Access**: 
   - Use SSH keys instead of passwords
   - Consider changing default SSH port

7. **Keep Secrets Secure**: Never commit `.env` file to Git

---

## Performance Optimization

### Enable Gzip Compression

Add to Nginx configuration:

```nginx
gzip on;
gzip_vary on;
gzip_min_length 1024;
gzip_types text/plain text/css text/xml text/javascript application/x-javascript application/javascript application/xml+rss application/json;
```

### Use CDN (Optional)

For better global performance, consider using a CDN like:
- Cloudflare (free tier available)
- DigitalOcean Spaces CDN
- AWS CloudFront

### Database Optimization (If Added Later)

If you add a database:
- Use connection pooling
- Add proper indexes
- Regular database maintenance

---

## Scaling Considerations

As your application grows:

1. **Vertical Scaling**: Upgrade to a larger droplet
2. **Horizontal Scaling**: Use load balancers and multiple droplets
3. **Database Separation**: Move database to a separate droplet
4. **Caching**: Implement Redis for session storage
5. **Static Assets**: Use DigitalOcean Spaces or CDN

---

## Additional Resources

- **DigitalOcean Documentation**: https://docs.digitalocean.com/
- **Nginx Documentation**: https://nginx.org/en/docs/
- **systemd Documentation**: https://www.freedesktop.org/software/systemd/man/
- **Let's Encrypt**: https://letsencrypt.org/docs/
- **Node.js Best Practices**: https://github.com/goldbergyoni/nodebestpractices

---

## Support

For issues specific to the FinalCut application:
- GitHub Issues: https://github.com/yishengjiang99/pages/issues

For DigitalOcean support:
- Community: https://www.digitalocean.com/community
- Support tickets (for paying customers)

---

## Changelog

- **v1.0.0** (2026-01-14): Initial deployment guide created
