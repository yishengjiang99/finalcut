# FinalCut Deployment Guide to AWS

This guide provides comprehensive instructions for deploying the FinalCut application to Amazon Web Services (AWS) EC2 with DNS configuration on Route 53 or other DNS providers.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [AWS Account Setup](#aws-account-setup)
3. [EC2 Instance Setup](#ec2-instance-setup)
4. [Server Configuration](#server-configuration)
5. [Application Deployment](#application-deployment)
6. [DNS Configuration](#dns-configuration)
7. [SSL Certificate Setup](#ssl-certificate-setup)
8. [Security Groups and IAM](#security-groups-and-iam)
9. [Automated Deployment](#automated-deployment)
10. [Monitoring and Maintenance](#monitoring-and-maintenance)
11. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before starting the deployment process, ensure you have:

- **AWS Account**: Sign up at https://aws.amazon.com/
- **Domain Name**: Registered domain (Route 53 or external provider)
- **xAI API Token**: Obtain from https://console.x.ai/
- **SSH Key Pair**: For secure EC2 instance access
- **AWS CLI**: Installed on your local machine (optional but recommended)
- **Basic Linux Knowledge**: Familiarity with command-line operations

---

## AWS Account Setup

### Step 1: Initial AWS Configuration

1. **Create AWS Account**:
   - Visit https://aws.amazon.com/
   - Click "Create an AWS Account"
   - Complete registration with payment method

2. **Enable MFA (Multi-Factor Authentication)**:
   - Go to IAM → Users → Your User
   - Security credentials → MFA → Activate MFA
   - Recommended for security

3. **Install AWS CLI** (Optional):
   ```bash
   # On macOS
   brew install awscli
   
   # On Linux
   curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
   unzip awscliv2.zip
   sudo ./aws/install
   
   # Configure AWS CLI
   aws configure
   ```

---

## EC2 Instance Setup

### Step 2: Create EC2 Key Pair

1. **In AWS Console**:
   - Navigate to EC2 → Key Pairs
   - Click "Create key pair"
   - Name: `finalcut-prod-key`
   - Type: RSA
   - Format: .pem (for Linux/Mac) or .ppk (for PuTTY)
   - Click "Create key pair"
   - Save the file securely

2. **Set Permissions** (Linux/Mac):
   ```bash
   chmod 400 ~/Downloads/finalcut-prod-key.pem
   mv ~/Downloads/finalcut-prod-key.pem ~/.ssh/
   ```

### Step 3: Launch EC2 Instance

1. **Navigate to EC2 Dashboard**:
   - Go to EC2 → Instances → Launch Instance

2. **Configure Instance**:

   **Name and Tags**:
   - Name: `finalcut-production`
   - Tags: `Environment=production`, `Application=finalcut`

   **Application and OS Images (AMI)**:
   - Select **Ubuntu Server 22.04 LTS**
   - Architecture: 64-bit (x86)
   - AMI: Ubuntu Server 22.04 LTS (HVM), SSD Volume Type

   **Instance Type**:
   - **t3.small** (2 vCPU, 2 GiB RAM) - Recommended starting point ($15-20/month)
   - **t3.micro** (2 vCPU, 1 GiB RAM) - Development/testing only ($8-10/month)
   - **t3.medium** (2 vCPU, 4 GiB RAM) - High traffic ($30-35/month)

   **Key Pair**:
   - Select your created key pair: `finalcut-prod-key`

   **Network Settings**:
   - Create new security group or use existing
   - Security group name: `finalcut-sg`
   - Description: "Security group for FinalCut application"

   **Configure Security Group Rules**:
   - SSH (22): Your IP or 0.0.0.0/0 (be cautious with 0.0.0.0/0)
   - HTTP (80): 0.0.0.0/0
   - HTTPS (443): 0.0.0.0/0

   **Configure Storage**:
   - Size: 20 GB minimum (30 GB recommended)
   - Volume Type: gp3 (General Purpose SSD)
   - Delete on Termination: Yes

   **Advanced Details** (Optional but recommended):
   - Enable detailed monitoring (additional cost)
   - User data: Leave blank for now

3. **Launch Instance**:
   - Review configuration
   - Click "Launch instance"
   - Wait for instance to reach "running" state
   - Note the **Public IPv4 address** and **Public IPv4 DNS**

4. **Allocate Elastic IP** (Recommended for production):
   ```bash
   # Using AWS Console:
   # EC2 → Elastic IPs → Allocate Elastic IP address
   # Actions → Associate Elastic IP address
   # Select your instance
   
   # Using AWS CLI:
   aws ec2 allocate-address
   aws ec2 associate-address --instance-id i-xxxxxxxxx --allocation-id eipalloc-xxxxxxxxx
   ```

---

## Server Configuration

### Step 4: Connect to EC2 Instance

```bash
# SSH into instance
ssh -i ~/.ssh/finalcut-prod-key.pem ubuntu@YOUR_INSTANCE_IP

# Verify connection
whoami
```

### Step 5: Initial Server Setup

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

# Copy SSH keys to new user
sudo rsync --archive --chown=finalcut:finalcut ~/.ssh /home/finalcut
```

#### Configure Firewall (UFW)

```bash
# Enable firewall
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

### Step 6: Install Node.js

```bash
# Install Node.js 18.x (LTS)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version  # Should show v18.x.x
npm --version   # Should show 9.x.x or higher
```

### Step 7: Install Nginx

```bash
# Install Nginx
sudo apt install nginx -y

# Start and enable Nginx
sudo systemctl start nginx
sudo systemctl enable nginx
sudo systemctl status nginx
```

### Step 8: Install PM2 (Process Manager)

```bash
# Install PM2 globally
sudo npm install -g pm2

# Configure PM2 to start on boot
pm2 startup systemd
# Copy and run the command it outputs

# Verify PM2 installation
pm2 --version
```

### Step 9: Install Git

```bash
sudo apt install git -y
git --version
```

---

## Application Deployment

### Step 10: Deploy the Application

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

### Step 11: Configure Nginx as Reverse Proxy

Create an Nginx configuration file:

```bash
# Exit to ubuntu user (or use sudo)
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

### Option A: Using AWS Route 53

#### Step 12a: Configure Route 53

1. **Create Hosted Zone** (if using Route 53 for DNS):
   ```bash
   # Via AWS Console:
   # Route 53 → Hosted zones → Create hosted zone
   # Domain name: yourdomain.com
   # Type: Public hosted zone
   
   # Note the nameservers (e.g., ns-123.awsdns-12.com)
   ```

2. **Update Domain Registrar**:
   - If domain is registered elsewhere (GoDaddy, Namecheap, etc.)
   - Update nameservers to point to Route 53 nameservers
   - This can take 1-48 hours to propagate

3. **Create A Records**:
   ```bash
   # Via AWS Console:
   # Route 53 → Hosted zones → Your domain → Create record
   
   # Record 1: Root domain
   # Record name: (leave empty)
   # Record type: A
   # Value: Your Elastic IP or EC2 public IP
   # TTL: 300
   
   # Record 2: WWW subdomain
   # Record name: www
   # Record type: A
   # Value: Your Elastic IP or EC2 public IP
   # TTL: 300
   ```

4. **Using AWS CLI** (alternative):
   ```bash
   # Create hosted zone
   aws route53 create-hosted-zone --name yourdomain.com --caller-reference $(date +%s)
   
   # Get hosted zone ID
   aws route53 list-hosted-zones
   
   # Create A record (save this to a file: change-batch.json)
   {
     "Changes": [{
       "Action": "CREATE",
       "ResourceRecordSet": {
         "Name": "yourdomain.com",
         "Type": "A",
         "TTL": 300,
         "ResourceRecords": [{"Value": "YOUR_ELASTIC_IP"}]
       }
     }]
   }
   
   # Apply changes
   aws route53 change-resource-record-sets --hosted-zone-id YOUR_ZONE_ID --change-batch file://change-batch.json
   ```

### Option B: Using External DNS Provider

#### Step 12b: Configure External DNS (GoDaddy, Namecheap, etc.)

1. **Log in to your DNS provider**

2. **Add/Update A Records**:

   **For Root Domain** (example.com):
   - Type: `A`
   - Name: `@`
   - Value: `YOUR_ELASTIC_IP`
   - TTL: `600` (10 minutes) or default

   **For WWW Subdomain** (www.example.com):
   - Type: `A`
   - Name: `www`
   - Value: `YOUR_ELASTIC_IP`
   - TTL: `600` (10 minutes) or default

3. **Save Changes**

4. **Wait for DNS Propagation**:
   - DNS changes can take 1-48 hours to propagate globally
   - Typically propagates within 1-2 hours
   - Check propagation: https://www.whatsmydns.net/

---

## SSL Certificate Setup

### Step 13: Install SSL Certificate with Let's Encrypt

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

## Security Groups and IAM

### Step 14: Configure AWS Security

#### Security Group Configuration

1. **Review Security Group Rules**:
   ```bash
   # Via AWS Console:
   # EC2 → Security Groups → finalcut-sg
   
   # Inbound Rules (minimum):
   # - SSH (22): Your IP only (not 0.0.0.0/0 in production)
   # - HTTP (80): 0.0.0.0/0
   # - HTTPS (443): 0.0.0.0/0
   
   # Outbound Rules:
   # - All traffic: 0.0.0.0/0 (default)
   ```

2. **Restrict SSH Access**:
   ```bash
   # Edit inbound rule for SSH
   # Change source from 0.0.0.0/0 to:
   # - Your specific IP address
   # - Or your company's IP range
   # - Or use AWS Systems Manager Session Manager (no SSH needed)
   ```

#### IAM Role Configuration (Optional but Recommended)

1. **Create IAM Role for EC2**:
   ```bash
   # Via AWS Console:
   # IAM → Roles → Create role
   # Trusted entity: AWS service → EC2
   # Use case: EC2
   
   # Attach policies:
   # - AmazonSSMManagedInstanceCore (for Systems Manager)
   # - CloudWatchAgentServerPolicy (for monitoring)
   # - Custom policy for S3 access (if storing videos)
   
   # Role name: finalcut-ec2-role
   ```

2. **Attach Role to Instance**:
   ```bash
   # Via AWS Console:
   # EC2 → Instances → Select instance
   # Actions → Security → Modify IAM role
   # Select: finalcut-ec2-role
   ```

---

## Automated Deployment

### Step 15: Create Deployment Script

Create a deployment script for easy updates:

```bash
cd /home/finalcut/apps/pages/finalcut
nano deploy-aws.sh
```

Add the following content:

```bash
#!/bin/bash

# FinalCut AWS Deployment Script
echo "Starting FinalCut deployment on AWS..."

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
chmod +x deploy-aws.sh
```

### Step 16: Update the Application

When you need to deploy updates:

```bash
cd /home/finalcut/apps/pages/finalcut
./deploy-aws.sh
```

---

## Monitoring and Maintenance

### AWS CloudWatch Monitoring

#### Enable CloudWatch

1. **Install CloudWatch Agent**:
   ```bash
   # Download agent
   wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
   
   # Install agent
   sudo dpkg -i amazon-cloudwatch-agent.deb
   
   # Configure agent
   sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-config-wizard
   ```

2. **Start CloudWatch Agent**:
   ```bash
   sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
     -a fetch-config \
     -m ec2 \
     -s \
     -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
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

# Restart CloudWatch agent
sudo systemctl restart amazon-cloudwatch-agent
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

# Check EC2 instance metadata
curl http://169.254.169.254/latest/meta-data/
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

2. **Verify Route 53 records** (if using Route 53):
   ```bash
   aws route53 list-resource-record-sets --hosted-zone-id YOUR_ZONE_ID
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

### Security Group Issues

1. **Verify security group rules**:
   ```bash
   aws ec2 describe-security-groups --group-ids sg-xxxxxxxxx
   ```

2. **Test connectivity**:
   ```bash
   # From local machine
   telnet YOUR_EC2_IP 80
   telnet YOUR_EC2_IP 443
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

## AWS-Specific Best Practices

### Cost Optimization

1. **Use Reserved Instances**:
   - Save up to 72% with 1-year or 3-year commitment
   - Good for stable, predictable workloads

2. **Use Savings Plans**:
   - More flexible than Reserved Instances
   - Can apply to different instance types

3. **Enable Auto Scaling** (for high traffic):
   - Automatically adjust capacity
   - Pay only for what you use

4. **Use S3 for Static Assets**:
   - Store videos and large files in S3
   - Use CloudFront CDN for faster delivery

### Backup Strategy

1. **Enable EBS Snapshots**:
   ```bash
   # Via AWS Console:
   # EC2 → Volumes → Select volume → Actions → Create snapshot
   
   # Via AWS CLI:
   aws ec2 create-snapshot --volume-id vol-xxxxxxxxx --description "FinalCut backup"
   ```

2. **Automate Backups**:
   - Use AWS Backup service
   - Schedule daily snapshots
   - Set retention policies

### High Availability

1. **Use Elastic Load Balancer**:
   - Distribute traffic across multiple instances
   - Automatic health checks

2. **Multi-AZ Deployment**:
   - Deploy instances in multiple Availability Zones
   - Increases reliability

3. **Use Auto Scaling**:
   - Automatically replace unhealthy instances
   - Scale based on demand

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

3. **Use AWS Systems Manager Session Manager**:
   - Access instances without SSH keys
   - All sessions logged in CloudTrail
   - No need to open port 22

4. **Enable AWS CloudTrail**:
   - Log all API calls
   - Monitor for suspicious activity

5. **Use AWS WAF** (Web Application Firewall):
   - Protect against common web exploits
   - Can integrate with CloudFront

6. **Regular Security Audits**:
   - Use AWS Trusted Advisor
   - Review security group rules regularly
   - Monitor CloudWatch Logs

---

## Performance Optimization

### Use CloudFront CDN

1. **Create CloudFront Distribution**:
   - Origin: Your EC2 instance or S3 bucket
   - Enable caching for static assets
   - Lower latency for global users

2. **Configure Caching**:
   - Set appropriate TTL values
   - Use cache invalidation when updating

### Enable Compression

Add to Nginx configuration:

```nginx
gzip on;
gzip_vary on;
gzip_min_length 1024;
gzip_types text/plain text/css text/xml text/javascript application/x-javascript application/javascript application/xml+rss application/json;
```

### Use ElastiCache (Redis)

For session storage and caching:
- Faster than database queries
- Reduces load on application server

---

## Scaling Considerations

### Vertical Scaling

Upgrade to larger instance type:
1. Stop instance
2. Change instance type (e.g., t3.small → t3.medium)
3. Start instance

### Horizontal Scaling

Add more instances:
1. Create AMI from existing instance
2. Launch new instances from AMI
3. Add to load balancer
4. Configure auto scaling

---

## Additional Resources

- **AWS Documentation**: https://docs.aws.amazon.com/
- **AWS EC2 User Guide**: https://docs.aws.amazon.com/ec2/
- **AWS Route 53 Documentation**: https://docs.aws.amazon.com/route53/
- **AWS CloudWatch Documentation**: https://docs.aws.amazon.com/cloudwatch/
- **Nginx Documentation**: https://nginx.org/en/docs/
- **PM2 Documentation**: https://pm2.keymetrics.io/docs/
- **Let's Encrypt**: https://letsencrypt.org/docs/

---

## Cost Estimates

### EC2 Instance Costs (US East Region)

- **t3.micro** (1 GB RAM): ~$7-8/month
- **t3.small** (2 GB RAM): ~$15-17/month (Recommended)
- **t3.medium** (4 GB RAM): ~$30-35/month

### Additional Costs

- **Elastic IP**: Free when attached, $0.005/hour when not attached
- **EBS Storage**: $0.10/GB/month (20 GB = ~$2/month)
- **Data Transfer**: First 100 GB/month free, then $0.09/GB
- **Route 53**: $0.50/hosted zone/month + $0.40/million queries
- **CloudWatch**: Free tier includes 10 metrics, basic monitoring
- **Backups (EBS Snapshots)**: $0.05/GB/month

**Total Estimated Monthly Cost**: $20-50/month depending on usage and instance size

---

## Support

For issues specific to the FinalCut application:
- GitHub Issues: https://github.com/yishengjiang99/pages/issues

For AWS support:
- AWS Documentation: https://docs.aws.amazon.com/
- AWS Support Center (if you have a support plan)
- AWS Community Forums: https://forums.aws.amazon.com/

---

## Changelog

- **v1.0.0** (2026-01-15): Initial AWS deployment guide created
