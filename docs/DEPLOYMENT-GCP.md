# FinalCut Deployment Guide to Google Cloud Platform (GCP)

This guide provides comprehensive instructions for deploying the FinalCut application to Google Cloud Platform Compute Engine with DNS configuration on Cloud DNS or other DNS providers.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [GCP Account Setup](#gcp-account-setup)
3. [Compute Engine Instance Setup](#compute-engine-instance-setup)
4. [Server Configuration](#server-configuration)
5. [Application Deployment](#application-deployment)
6. [DNS Configuration](#dns-configuration)
7. [SSL Certificate Setup](#ssl-certificate-setup)
8. [Firewall and IAM](#firewall-and-iam)
9. [Automated Deployment](#automated-deployment)
10. [Monitoring and Maintenance](#monitoring-and-maintenance)
11. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before starting the deployment process, ensure you have:

- **Google Cloud Account**: Sign up at https://cloud.google.com/
- **Domain Name**: Registered domain (Cloud DNS or external provider)
- **xAI API Token**: Obtain from https://console.x.ai/
- **SSH Key Pair**: For secure VM instance access
- **Google Cloud SDK**: Installed on your local machine (optional but recommended)
- **Basic Linux Knowledge**: Familiarity with command-line operations
- **Credit Card**: Required for GCP account (includes $300 free credit for new users)

---

## GCP Account Setup

### Step 1: Initial GCP Configuration

1. **Create GCP Account**:
   - Visit https://cloud.google.com/
   - Click "Get started for free"
   - Complete registration (includes $300 free credit for 90 days)
   - Enter payment information

2. **Create a New Project**:
   ```bash
   # Via GCP Console:
   # Console → Select a project → New Project
   # Project name: finalcut-production
   # Project ID: finalcut-prod-xxxx (note this ID)
   # Location: No organization
   ```

3. **Enable Billing**:
   - Ensure billing is enabled for your project
   - Navigation Menu → Billing → Link a billing account

4. **Install Google Cloud SDK** (gcloud CLI):
   ```bash
   # On macOS
   brew install --cask google-cloud-sdk
   
   # On Linux
   curl https://sdk.cloud.google.com | bash
   exec -l $SHELL
   
   # On Windows
   # Download from https://cloud.google.com/sdk/docs/install
   
   # Initialize gcloud
   gcloud init
   gcloud auth login
   gcloud config set project finalcut-prod-xxxx
   ```

---

## Compute Engine Instance Setup

### Step 2: Enable Compute Engine API

```bash
# Via gcloud CLI
gcloud services enable compute.googleapis.com

# Or via GCP Console:
# Navigation Menu → APIs & Services → Enable APIs and Services
# Search for "Compute Engine API" → Enable
```

### Step 3: Create SSH Key Pair

```bash
# Generate SSH key pair
ssh-keygen -t rsa -b 4096 -C "your_email@example.com" -f ~/.ssh/gcp-finalcut-key

# Set permissions
chmod 400 ~/.ssh/gcp-finalcut-key

# View public key (you'll need this)
cat ~/.ssh/gcp-finalcut-key.pub
```

### Step 4: Create Compute Engine Instance

#### Using GCP Console

1. **Navigate to Compute Engine**:
   - Navigation Menu → Compute Engine → VM instances
   - Click "Create Instance"

2. **Configure Instance**:

   **Name**: `finalcut-production`

   **Region and Zone**:
   - Region: Choose closest to your users (e.g., us-central1, europe-west1, asia-southeast1)
   - Zone: Any available zone (e.g., us-central1-a)

   **Machine Configuration**:
   - Series: E2 (cost-optimized)
   - Machine type:
     - **e2-small** (2 vCPU, 2 GB RAM) - Recommended starting point (~$15-20/month)
     - **e2-micro** (2 vCPU, 1 GB RAM) - Development only (~$7-8/month)
     - **e2-medium** (2 vCPU, 4 GB RAM) - High traffic (~$25-30/month)

   **Boot Disk**:
   - Operating System: Ubuntu
   - Version: Ubuntu 22.04 LTS
   - Boot disk type: Balanced persistent disk (or SSD for better performance)
   - Size: 20 GB minimum (30 GB recommended)

   **Identity and API Access**:
   - Service account: Compute Engine default service account
   - Access scopes: Allow default access (or customize as needed)

   **Firewall**:
   - ✓ Allow HTTP traffic
   - ✓ Allow HTTPS traffic

3. **Add SSH Key**:
   - Expand "Advanced options"
   - Under "Security" → "Manage access"
   - Click "Add manually generated SSH keys"
   - Paste your public key from `~/.ssh/gcp-finalcut-key.pub`

4. **Create Instance**:
   - Click "Create"
   - Wait for instance to start (green checkmark)
   - Note the **External IP address**

#### Using gcloud CLI

```bash
# Create instance
gcloud compute instances create finalcut-production \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB \
  --boot-disk-type=pd-balanced \
  --tags=http-server,https-server \
  --metadata-from-file ssh-keys=~/.ssh/gcp-finalcut-key.pub

# Get instance details
gcloud compute instances describe finalcut-production --zone=us-central1-a

# Get external IP
gcloud compute instances describe finalcut-production \
  --zone=us-central1-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
```

### Step 5: Reserve Static External IP

```bash
# Reserve static IP address
gcloud compute addresses create finalcut-static-ip \
  --region=us-central1

# Get the reserved IP address
gcloud compute addresses describe finalcut-static-ip \
  --region=us-central1 \
  --format='get(address)'

# Attach to instance
gcloud compute instances delete-access-config finalcut-production \
  --zone=us-central1-a \
  --access-config-name="External NAT"

gcloud compute instances add-access-config finalcut-production \
  --zone=us-central1-a \
  --access-config-name="External NAT" \
  --address=$(gcloud compute addresses describe finalcut-static-ip \
    --region=us-central1 --format='get(address)')
```

---

## Server Configuration

### Step 6: Connect to Compute Engine Instance

```bash
# SSH into instance using gcloud
gcloud compute ssh finalcut-production --zone=us-central1-a

# Or using SSH directly
ssh -i ~/.ssh/gcp-finalcut-key YOUR_USERNAME@YOUR_EXTERNAL_IP

# Verify connection
whoami
hostname
```

### Step 7: Initial Server Setup

#### Update System Packages

```bash
sudo apt update && sudo apt upgrade -y
```

#### Create Application User

```bash
# Create new user
sudo adduser finalcut

# Add user to sudo group
sudo usermod -aG sudo finalcut

# Copy SSH keys to new user (if using SSH key authentication)
sudo mkdir -p /home/finalcut/.ssh
sudo cp ~/.ssh/authorized_keys /home/finalcut/.ssh/
sudo chown -R finalcut:finalcut /home/finalcut/.ssh
sudo chmod 700 /home/finalcut/.ssh
sudo chmod 600 /home/finalcut/.ssh/authorized_keys
```

#### Configure Firewall (UFW)

```bash
# Enable firewall
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

### Step 8: Install Node.js

```bash
# Install Node.js 18.x (LTS)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version  # Should show v18.x.x
npm --version   # Should show 9.x.x or higher
```

### Step 9: Install Nginx

```bash
# Install Nginx
sudo apt install nginx -y

# Start and enable Nginx
sudo systemctl start nginx
sudo systemctl enable nginx
sudo systemctl status nginx
```

### Step 10: Install PM2 (Process Manager)

```bash
# Install PM2 globally
sudo npm install -g pm2

# Configure PM2 to start on boot
pm2 startup systemd
# Copy and run the command it outputs

# Verify PM2 installation
pm2 --version
```

### Step 11: Install Git

```bash
sudo apt install git -y
git --version
```

---

## Application Deployment

### Step 12: Deploy the Application

#### Clone the Repository

```bash
# Switch to finalcut user
sudo su - finalcut

# Create app directory
mkdir -p ~/apps
cd ~/apps

# Clone the repository
git clone https://github.com/yishengjiang99/pages.git
cd pages/finalcut
```

#### Install Dependencies

```bash
# Install Node.js dependencies
npm install

# Verify installation
npm list --depth=0
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

**Important**: 
- Ensure the `.env` file is not tracked by Git (it's already in `.gitignore`)
- Set secure permissions: `chmod 600 .env`

#### Build the Frontend

```bash
# Build the React application
npm run build

# Verify build
ls -la dist/
```

This creates optimized production files in the `dist/` directory.

#### Start the Application with PM2

```bash
# Start the Node.js server
pm2 start server.js --name finalcut-server

# Save PM2 process list
pm2 save

# View logs
pm2 logs finalcut-server --lines 20

# Check status
pm2 status
```

### Step 13: Configure Nginx as Reverse Proxy

Create an Nginx configuration file:

```bash
# Exit to your user account (or use sudo)
exit

# Create Nginx configuration
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
    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Increase timeouts for large video processing
        proxy_connect_timeout 600;
        proxy_send_timeout 600;
        proxy_read_timeout 600;
        send_timeout 600;
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

# Remove default site if exists
sudo rm /etc/nginx/sites-enabled/default

# Test Nginx configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

---

## DNS Configuration

### Option A: Using Google Cloud DNS

#### Step 14a: Configure Cloud DNS

1. **Enable Cloud DNS API**:
   ```bash
   gcloud services enable dns.googleapis.com
   ```

2. **Create Managed Zone**:
   ```bash
   # Via gcloud CLI
   gcloud dns managed-zones create finalcut-zone \
     --dns-name="yourdomain.com." \
     --description="DNS zone for FinalCut application"
   
   # Get nameservers
   gcloud dns managed-zones describe finalcut-zone \
     --format="value(nameServers)"
   ```

   Via GCP Console:
   - Navigation Menu → Network Services → Cloud DNS
   - Click "Create Zone"
   - Zone type: Public
   - Zone name: finalcut-zone
   - DNS name: yourdomain.com
   - Note the nameservers

3. **Update Domain Registrar**:
   - If domain is registered elsewhere (GoDaddy, Namecheap, etc.)
   - Update nameservers to point to Cloud DNS nameservers
   - This can take 1-48 hours to propagate

4. **Create DNS Records**:
   ```bash
   # Start a transaction
   gcloud dns record-sets transaction start --zone=finalcut-zone
   
   # Add A record for root domain
   gcloud dns record-sets transaction add YOUR_STATIC_IP \
     --name=yourdomain.com. \
     --ttl=300 \
     --type=A \
     --zone=finalcut-zone
   
   # Add A record for www subdomain
   gcloud dns record-sets transaction add YOUR_STATIC_IP \
     --name=www.yourdomain.com. \
     --ttl=300 \
     --type=A \
     --zone=finalcut-zone
   
   # Execute the transaction
   gcloud dns record-sets transaction execute --zone=finalcut-zone
   
   # List all records
   gcloud dns record-sets list --zone=finalcut-zone
   ```

   Via GCP Console:
   - Navigate to your zone in Cloud DNS
   - Click "Add record set"
   - For root domain: DNS name: (leave empty), Resource record type: A, IPv4 Address: YOUR_STATIC_IP
   - For www: DNS name: www, Resource record type: A, IPv4 Address: YOUR_STATIC_IP

### Option B: Using External DNS Provider

#### Step 14b: Configure External DNS (GoDaddy, Namecheap, etc.)

1. **Log in to your DNS provider**

2. **Add/Update A Records**:

   **For Root Domain** (example.com):
   - Type: `A`
   - Name: `@`
   - Value: `YOUR_STATIC_IP`
   - TTL: `600` (10 minutes) or default

   **For WWW Subdomain** (www.example.com):
   - Type: `A`
   - Name: `www`
   - Value: `YOUR_STATIC_IP`
   - TTL: `600` (10 minutes) or default

3. **Save Changes**

4. **Wait for DNS Propagation**:
   - DNS changes can take 1-48 hours to propagate globally
   - Typically propagates within 1-2 hours
   - Check propagation: https://www.whatsmydns.net/

---

## SSL Certificate Setup

### Step 15: Install SSL Certificate with Let's Encrypt

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx -y

# Obtain and install SSL certificate
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

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

# Check certificate status
sudo certbot certificates
```

The certificate will automatically renew before expiration.

#### Verify HTTPS Configuration

```bash
# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

Visit `https://yourdomain.com` to verify SSL is working.

---

## Firewall and IAM

### Step 16: Configure GCP Firewall

#### Create Firewall Rules

```bash
# List existing firewall rules
gcloud compute firewall-rules list

# Default rules for HTTP and HTTPS should exist from instance creation
# If not, create them:

# Allow HTTP
gcloud compute firewall-rules create allow-http \
  --allow tcp:80 \
  --source-ranges 0.0.0.0/0 \
  --target-tags http-server \
  --description="Allow HTTP traffic"

# Allow HTTPS
gcloud compute firewall-rules create allow-https \
  --allow tcp:443 \
  --source-ranges 0.0.0.0/0 \
  --target-tags https-server \
  --description="Allow HTTPS traffic"

# Restrict SSH access (optional, recommended for production)
gcloud compute firewall-rules create allow-ssh-restricted \
  --allow tcp:22 \
  --source-ranges YOUR_IP_ADDRESS/32 \
  --description="Allow SSH from specific IP"
```

Via GCP Console:
- Navigation Menu → VPC network → Firewall
- Review existing rules
- Ensure http-server and https-server rules exist

#### Service Account Configuration

1. **Create Service Account** (if needed):
   ```bash
   gcloud iam service-accounts create finalcut-sa \
     --description="Service account for FinalCut application" \
     --display-name="FinalCut Service Account"
   ```

2. **Grant Roles** (as needed):
   ```bash
   # For Cloud Logging
   gcloud projects add-iam-policy-binding PROJECT_ID \
     --member="serviceAccount:finalcut-sa@PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/logging.logWriter"
   
   # For Cloud Monitoring
   gcloud projects add-iam-policy-binding PROJECT_ID \
     --member="serviceAccount:finalcut-sa@PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/monitoring.metricWriter"
   
   # For Cloud Storage (if storing videos in GCS)
   gcloud projects add-iam-policy-binding PROJECT_ID \
     --member="serviceAccount:finalcut-sa@PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/storage.objectAdmin"
   ```

3. **Attach Service Account to Instance**:
   ```bash
   gcloud compute instances set-service-account finalcut-production \
     --zone=us-central1-a \
     --service-account=finalcut-sa@PROJECT_ID.iam.gserviceaccount.com \
     --scopes=https://www.googleapis.com/auth/cloud-platform
   ```

---

## Automated Deployment

### Step 17: Create Deployment Script

Create a deployment script for easy updates:

```bash
cd /home/finalcut/apps/pages/finalcut
nano deploy-gcp.sh
```

Add the following content:

```bash
#!/bin/bash

# FinalCut GCP Deployment Script
echo "Starting FinalCut deployment on Google Cloud Platform..."

# Change to project directory
cd /home/finalcut/apps/pages/finalcut || exit 1

# Pull latest changes from Git
echo "Pulling latest changes from Git..."
git pull origin main

# Install dependencies
echo "Installing dependencies..."
npm install

# Build the frontend
echo "Building frontend..."
npm run build

# Restart the application with PM2
echo "Restarting application..."
pm2 restart finalcut-server

# Check application status
echo "Checking application status..."
pm2 status

echo "Deployment complete!"
echo "Application logs:"
pm2 logs finalcut-server --lines 10 --nostream
```

Make it executable:

```bash
chmod +x deploy-gcp.sh
```

### Step 18: Update the Application

When you need to deploy updates:

```bash
cd /home/finalcut/apps/pages/finalcut
./deploy-gcp.sh
```

---

## Monitoring and Maintenance

### Google Cloud Operations (formerly Stackdriver)

#### Install Ops Agent

```bash
# Add the agent repo
curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
sudo bash add-google-cloud-ops-agent-repo.sh --also-install

# Start the agent
sudo systemctl start google-cloud-ops-agent

# Enable on boot
sudo systemctl enable google-cloud-ops-agent

# Check status
sudo systemctl status google-cloud-ops-agent
```

#### View Logs

```bash
# Via gcloud CLI
gcloud logging read "resource.type=gce_instance AND resource.labels.instance_id=INSTANCE_ID" \
  --limit 50 \
  --format json

# Via GCP Console:
# Navigation Menu → Logging → Logs Explorer
# Filter by resource: GCE VM Instance → finalcut-production
```

### Monitor Application

```bash
# View PM2 status
pm2 status

# View real-time logs
pm2 logs finalcut-server

# View last 100 lines of logs
pm2 logs finalcut-server --lines 100

# Monitor CPU and memory
pm2 monit
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
pm2 restart finalcut-server

# Restart Nginx
sudo systemctl restart nginx

# Restart Ops Agent
sudo systemctl restart google-cloud-ops-agent
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

# Check instance metadata
curl -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/
```

---

## Troubleshooting

### Application Won't Start

1. **Check PM2 logs**:
   ```bash
   pm2 logs finalcut-server --lines 50
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
   pm2 restart finalcut-server
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

2. **Verify Cloud DNS records** (if using Cloud DNS):
   ```bash
   gcloud dns record-sets list --zone=finalcut-zone
   ```

3. **Test DNS resolution**:
   ```bash
   nslookup yourdomain.com
   dig yourdomain.com
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

### Firewall Issues

1. **Verify firewall rules**:
   ```bash
   gcloud compute firewall-rules list
   ```

2. **Test connectivity**:
   ```bash
   # From local machine
   telnet YOUR_INSTANCE_IP 80
   telnet YOUR_INSTANCE_IP 443
   ```

3. **Check instance tags**:
   ```bash
   gcloud compute instances describe finalcut-production \
     --zone=us-central1-a \
     --format='get(tags.items)'
   ```

### 502 Bad Gateway Error

This usually means Nginx can't connect to the Node.js server:

1. **Check if Node.js server is running**:
   ```bash
   pm2 status
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
   pm2 logs finalcut-server
   ```

---

## GCP-Specific Best Practices

### Cost Optimization

1. **Use Committed Use Discounts**:
   - Save up to 57% with 1-year commitment
   - Save up to 70% with 3-year commitment
   - Good for stable, predictable workloads

2. **Use Preemptible VMs** (for non-critical workloads):
   - Up to 80% cheaper
   - Can be terminated by GCP at any time
   - Not recommended for production

3. **Use Sustained Use Discounts**:
   - Automatic discounts for running VMs
   - Up to 30% discount for VMs running all month
   - No commitment required

4. **Right-size Your Instances**:
   - Use Recommender to get sizing suggestions
   - Monitor actual resource usage
   - Adjust machine type as needed

5. **Use Cloud Storage for Static Assets**:
   - Store videos and large files in Cloud Storage
   - Use Cloud CDN for faster delivery

### Backup Strategy

1. **Create Snapshots**:
   ```bash
   # Create snapshot
   gcloud compute disks snapshot finalcut-production \
     --zone=us-central1-a \
     --snapshot-names=finalcut-backup-$(date +%Y%m%d)
   
   # List snapshots
   gcloud compute snapshots list
   
   # Restore from snapshot
   gcloud compute disks create finalcut-restored \
     --zone=us-central1-a \
     --source-snapshot=finalcut-backup-20260115
   ```

2. **Automate Backups**:
   ```bash
   # Create snapshot schedule
   gcloud compute resource-policies create snapshot-schedule finalcut-daily \
     --region=us-central1 \
     --max-retention-days=7 \
     --start-time=02:00 \
     --daily-schedule
   
   # Attach schedule to disk
   gcloud compute disks add-resource-policies finalcut-production \
     --zone=us-central1-a \
     --resource-policies=finalcut-daily
   ```

3. **Use Cloud Storage for Application Data**:
   - Export important data to Cloud Storage
   - Enable versioning for data protection

### High Availability

1. **Use Managed Instance Groups**:
   - Automatically create/delete instances
   - Distribute across multiple zones
   - Integrate with Load Balancer

2. **Use Cloud Load Balancing**:
   - Global load balancing
   - SSL termination
   - Automatic health checks

3. **Multi-Region Deployment**:
   - Deploy instances in multiple regions
   - Use Cloud CDN for static content
   - Reduces latency for global users

---

## Security Best Practices

1. **Keep System Updated**:
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```

2. **Enable Automatic Security Updates**:
   ```bash
   sudo apt install unattended-upgrades -y
   sudo dpkg-reconfigure --priority=low unattended-upgrades
   ```

3. **Use OS Login** (recommended over SSH keys):
   ```bash
   # Enable OS Login on instance
   gcloud compute instances add-metadata finalcut-production \
     --zone=us-central1-a \
     --metadata enable-oslogin=TRUE
   
   # Grant OS Login role to users
   gcloud compute instances add-iam-policy-binding finalcut-production \
     --zone=us-central1-a \
     --member=user:your-email@example.com \
     --role=roles/compute.osLogin
   ```

4. **Enable VPC Flow Logs**:
   - Monitor network traffic
   - Detect anomalies
   - Troubleshoot connectivity issues

5. **Use Cloud Armor** (Web Application Firewall):
   - Protect against DDoS attacks
   - IP allow/deny lists
   - Rate limiting

6. **Regular Security Audits**:
   - Use Security Command Center
   - Review IAM permissions regularly
   - Monitor Cloud Audit Logs

7. **Enable 2FA for All Users**:
   - Required for Google accounts accessing GCP
   - Use authenticator apps

---

## Performance Optimization

### Use Cloud CDN

1. **Enable Cloud CDN**:
   ```bash
   # Create backend bucket
   gcloud compute backend-buckets create finalcut-backend \
     --gcs-bucket-name=your-bucket-name \
     --enable-cdn
   
   # Or integrate with Load Balancer
   # Cloud Load Balancing → Backend services → Enable Cloud CDN
   ```

2. **Configure Caching**:
   - Set appropriate Cache-Control headers
   - Use signed URLs for private content
   - Invalidate cache when needed

### Enable Compression

Add to Nginx configuration:

```nginx
gzip on;
gzip_vary on;
gzip_min_length 1024;
gzip_types text/plain text/css text/xml text/javascript application/x-javascript application/javascript application/xml+rss application/json;
```

### Use Cloud Memorystore (Redis)

For session storage and caching:
```bash
# Create Redis instance
gcloud redis instances create finalcut-cache \
  --size=1 \
  --region=us-central1 \
  --redis-version=redis_6_x
```

---

## Scaling Considerations

### Vertical Scaling

Upgrade to larger machine type:
```bash
# Stop instance
gcloud compute instances stop finalcut-production --zone=us-central1-a

# Change machine type
gcloud compute instances set-machine-type finalcut-production \
  --zone=us-central1-a \
  --machine-type=e2-medium

# Start instance
gcloud compute instances start finalcut-production --zone=us-central1-a
```

### Horizontal Scaling

Create instance template and managed instance group:
```bash
# Create instance template
gcloud compute instance-templates create finalcut-template \
  --machine-type=e2-small \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --tags=http-server,https-server

# Create managed instance group
gcloud compute instance-groups managed create finalcut-group \
  --base-instance-name=finalcut \
  --size=2 \
  --template=finalcut-template \
  --zone=us-central1-a

# Configure autoscaling
gcloud compute instance-groups managed set-autoscaling finalcut-group \
  --zone=us-central1-a \
  --max-num-replicas=10 \
  --min-num-replicas=2 \
  --target-cpu-utilization=0.75
```

---

## Additional Resources

- **GCP Documentation**: https://cloud.google.com/docs
- **Compute Engine Documentation**: https://cloud.google.com/compute/docs
- **Cloud DNS Documentation**: https://cloud.google.com/dns/docs
- **Cloud Operations Documentation**: https://cloud.google.com/stackdriver/docs
- **Nginx Documentation**: https://nginx.org/en/docs/
- **PM2 Documentation**: https://pm2.keymetrics.io/docs/
- **Let's Encrypt**: https://letsencrypt.org/docs/

---

## Cost Estimates

### Compute Engine Instance Costs (us-central1 Region)

- **e2-micro** (1 GB RAM): ~$6-7/month
- **e2-small** (2 GB RAM): ~$13-15/month (Recommended)
- **e2-medium** (4 GB RAM): ~$27-30/month

### Additional Costs

- **Static External IP**: $0.004/hour (~$3/month) when attached
- **Persistent Disk**: $0.040/GB/month (20 GB = ~$0.80/month)
- **Data Transfer (Egress)**: First 1 GB/month free, then $0.12/GB (Americas)
- **Cloud DNS**: $0.20/zone/month + $0.40/million queries
- **Cloud Operations**: Free tier includes most basic monitoring and logging
- **Snapshots**: $0.026/GB/month

**Total Estimated Monthly Cost**: $17-35/month depending on usage and instance size

**Note**: New GCP users get $300 in free credits for 90 days

---

## Support

For issues specific to the FinalCut application:
- GitHub Issues: https://github.com/yishengjiang99/pages/issues

For GCP support:
- GCP Documentation: https://cloud.google.com/docs
- Google Cloud Community: https://www.googlecloudcommunity.com/
- GCP Support (if you have a support plan): https://cloud.google.com/support

---

## Changelog

- **v1.0.0** (2026-01-15): Initial GCP deployment guide created
