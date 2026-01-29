# FinalCut Deployment Documentation Index

This directory contains comprehensive documentation and scripts for deploying the FinalCut xAI backend proxy application to multiple cloud platforms including DigitalOcean, AWS, and Google Cloud Platform.

## 📚 Documentation Files

### Cloud Platform Deployment Guides

Choose your preferred cloud platform:

1. **[DEPLOYMENT.md](./DEPLOYMENT.md)** 🌊 **DIGITALOCEAN** (Original Guide)
   - Complete DigitalOcean deployment guide (14,000+ words)
   - Detailed instructions for every step
   - DNS configuration with GoDaddy
   - Best for: Simple deployment, cost-effective, beginner-friendly
   - Estimated cost: $12-24/month

2. **[DEPLOYMENT-AWS.md](./DEPLOYMENT-AWS.md)** ☁️ **AMAZON WEB SERVICES**
   - Comprehensive AWS EC2 deployment guide
   - Route 53 DNS configuration or external DNS
   - IAM and Security Groups configuration
   - CloudWatch monitoring integration
   - Best for: Enterprise deployment, AWS ecosystem, scalability
   - Estimated cost: $15-50/month

3. **[DEPLOYMENT-GCP.md](./DEPLOYMENT-GCP.md)** 🔷 **GOOGLE CLOUD PLATFORM**
   - Complete GCP Compute Engine deployment guide
   - Cloud DNS configuration or external DNS
   - Firewall rules and service accounts
   - Cloud Operations monitoring
   - Best for: Google ecosystem, global deployment, machine learning integration
   - Estimated cost: $13-35/month (includes $300 free credit for new users)

### Getting Started

4. **[CLOUD-VENDOR-COMPARISON.md](./CLOUD-VENDOR-COMPARISON.md)** 🏆 **VENDOR COMPARISON**
   - Detailed comparison of all three platforms
   - Decision matrix to help choose the right platform
   - Cost analysis and recommendations
   - Migration paths between platforms
   - **Read this first if unsure which platform to choose**

5. **[DEPLOYMENT-CHECKLIST.md](./DEPLOYMENT-CHECKLIST.md)** ⭐ **DEPLOYMENT CHECKLIST**
   - Step-by-step checklist for your deployment
   - Track your progress through the deployment process
   - Printable format for offline reference
   - Adaptable to any cloud platform

### Reference Guides

6. **[QUICK-REFERENCE.md](./QUICK-REFERENCE.md)** ⚡ **QUICK COMMANDS**
   - Quick reference for common tasks
   - Command cheatsheet
   - Useful for day-to-day operations
   - Bookmark this for regular use

7. **[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** 🔧 **PROBLEM SOLVING**
   - Common issues and solutions
   - Diagnostic steps for problems
   - Error message explanations
   - Performance optimization tips

## 🛠 Scripts and Configuration Files

### Deployment Scripts

5. **[setup-server.sh](./setup-server.sh)** 🚀 **INITIAL SETUP**
   - Automated server setup script
   - Installs Node.js, Nginx, PM2
   - Configures firewall and user accounts
   - Run once on new droplet
   ```bash
   chmod +x setup-server.sh
   sudo ./setup-server.sh
   ```

6. **[deploy.sh](./deploy.sh)** 🔄 **UPDATE DEPLOYMENT**
   - Automated deployment script
   - Updates application code
   - Builds and restarts application
   - Use for subsequent deployments
   ```bash
   chmod +x deploy.sh
   ./deploy.sh
   ```

### Configuration Files

7. **[nginx.conf](./nginx.conf)** 🌐 **WEB SERVER CONFIG**
   - Nginx reverse proxy configuration
   - Serves static files and proxies API
   - CORS headers for FFmpeg WebAssembly
   - SSL-ready configuration

8. **[finalcut.service](./finalcut.service)** ⚙️ **SYSTEMD SERVICE**
   - SystemD service file (alternative to PM2)
   - Process management at OS level
   - Auto-restart on failure

9. **[.env.production](./.env.production)** 🔐 **ENVIRONMENT TEMPLATE**
   - Production environment variables template
   - Security guidelines
   - Configuration checklist

10. **[.github/workflows/deploy-finalcut.yml](../.github/workflows/deploy-finalcut.yml)** 🤖 **CI/CD WORKFLOW**
    - GitHub Actions workflow for automated deployment
    - Optional continuous deployment
    - Triggers on push to main branch

## 🏆 Cloud Platform Comparison

Choose the best platform for your needs:

| Feature | DigitalOcean | AWS | Google Cloud Platform |
|---------|--------------|-----|----------------------|
| **Ease of Use** | ⭐⭐⭐⭐⭐ Excellent | ⭐⭐⭐ Good | ⭐⭐⭐⭐ Very Good |
| **Cost (Monthly)** | $12-24 | $15-50 | $13-35 |
| **Free Tier** | ❌ No | ✅ 12 months | ✅ $300 credit (90 days) |
| **Setup Time** | ~30 minutes | ~45 minutes | ~40 minutes |
| **Documentation** | ⭐⭐⭐⭐⭐ Excellent | ⭐⭐⭐⭐ Very Good | ⭐⭐⭐⭐ Very Good |
| **Scalability** | ⭐⭐⭐ Good | ⭐⭐⭐⭐⭐ Excellent | ⭐⭐⭐⭐⭐ Excellent |
| **Global Reach** | ⭐⭐⭐⭐ Very Good | ⭐⭐⭐⭐⭐ Excellent | ⭐⭐⭐⭐⭐ Excellent |
| **Monitoring** | ⭐⭐⭐ Built-in basics | ⭐⭐⭐⭐⭐ CloudWatch | ⭐⭐⭐⭐⭐ Cloud Operations |
| **Best For** | Startups, Simple apps | Enterprise, AWS ecosystem | Google services, ML/AI |

### Platform Recommendations

**Choose DigitalOcean if:**
- You're new to cloud deployments
- You want the simplest setup process
- You have a small to medium-sized application
- You prefer transparent, predictable pricing
- You don't need advanced cloud services

**Choose AWS if:**
- You need enterprise-grade infrastructure
- You're already using AWS services
- You need maximum scalability options
- You want the most mature cloud ecosystem
- You need comprehensive compliance certifications

**Choose Google Cloud Platform if:**
- You want generous free credits to start
- You're using Google services (Workspace, etc.)
- You need strong machine learning capabilities
- You prefer Google's developer experience
- You want cutting-edge technology

## 💰 Cost Comparison Details

### DigitalOcean Pricing
- **Basic Droplet** (2GB RAM): $12/month
- **Premium Droplet** (4GB RAM): $24/month
- **Static IP**: Free
- **Bandwidth**: 2-4TB included
- **Snapshots**: $0.05/GB/month
- **Load Balancer**: $12/month (if needed)
- **Total Est.**: $12-40/month

### AWS Pricing (us-east-1)
- **t3.small** (2GB RAM): ~$15/month
- **t3.medium** (4GB RAM): ~$30/month
- **Elastic IP**: Free when attached
- **Storage (20GB)**: ~$2/month
- **Data Transfer**: First 100GB free
- **Route 53**: $0.50/zone/month
- **Total Est.**: $15-50/month

### GCP Pricing (us-central1)
- **e2-small** (2GB RAM): ~$13/month
- **e2-medium** (4GB RAM): ~$27/month
- **Static IP**: ~$3/month
- **Storage (20GB)**: ~$1/month
- **Data Transfer**: First 1GB free
- **Cloud DNS**: $0.20/zone/month
- **Free Credit**: $300 for new users (90 days)
- **Total Est.**: $13-35/month

## 🎯 Quick Start Guide

### For First-Time Deployment

1. **Choose Your Platform**
   - Review the [Cloud Platform Comparison](#-cloud-platform-comparison) above
   - Select: DigitalOcean, AWS, or GCP based on your needs
   
2. **Review Prerequisites**
   ```bash
   - Cloud platform account (DigitalOcean/AWS/GCP)
   - Domain name (optional but recommended)
   - xAI API token from https://console.x.ai/
   - SSH keys configured
   ```

3. **Follow the Appropriate Guide**
   - **DigitalOcean**: Open [DEPLOYMENT.md](./DEPLOYMENT.md)
   - **AWS**: Open [DEPLOYMENT-AWS.md](./DEPLOYMENT-AWS.md)
   - **GCP**: Open [DEPLOYMENT-GCP.md](./DEPLOYMENT-GCP.md)
   - Use [DEPLOYMENT-CHECKLIST.md](./DEPLOYMENT-CHECKLIST.md) to track progress

4. **Use Automated Setup** (works on all platforms)
   ```bash
   # On your server instance
   wget https://raw.githubusercontent.com/yishengjiang99/pages/main/finalcut/setup-server.sh
   chmod +x setup-server.sh
   sudo ./setup-server.sh
   ```

5. **Configure and Deploy**
   - Follow the post-setup instructions in your chosen guide
   - Configure environment variables (.env file)
   - Build and start the application

### For Updates

```bash
# SSH into your server (any platform)
ssh user@your-server-ip

# Navigate to app directory
cd /home/finalcut/apps/pages/finalcut

# Run deployment script
./deploy.sh
```

## 📋 xAI Backend Proxy Architecture

The FinalCut application uses a Node.js/Express backend as a secure proxy for xAI API requests:

```
┌─────────────────────────────────────────────────────┐
│                    Internet                          │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│              DNS Provider                            │
│   (Route 53 / Cloud DNS / GoDaddy)                  │
│   yourdomain.com → SERVER_IP                        │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│  Cloud Instance (EC2 / Compute Engine / Droplet)   │
│  ┌───────────────────────────────────────────────┐ │
│  │            Nginx (Port 80/443)                │ │
│  │  - SSL/TLS Termination (Let's Encrypt)       │ │
│  │  - Static File Serving (/dist)               │ │
│  │  - Reverse Proxy (/api/*)                    │ │
│  └───────────────────────────────────────────────┘ │
│                      │                               │
│                      ├─── /dist/* → Static Files     │
│                      │                               │
│                      └─── /api/* → Proxy to:         │
│                                                       │
│  ┌───────────────────────────────────────────────┐ │
│  │   Node.js + Express (Port 3001)               │ │
│  │  - PM2 Process Manager                        │ │
│  │  - xAI API Proxy Endpoint                     │ │
│  │  - CORS Security                              │ │
│  │  - API Key Protection                         │ │
│  └───────────────────────────────────────────────┘ │
│                      │                               │
│                      ▼                               │
│         https://api.grok.x.ai/v1/chat/completions   │
└─────────────────────────────────────────────────────┘

Frontend:
- React 18 + Vite
- FFmpeg WebAssembly for video processing
- Built to /dist directory
- Served by Nginx as static files

Backend (xAI Proxy):
- Node.js 18+ + Express
- Managed by PM2 for reliability
- Proxies requests to xAI Grok API
- Securely stores XAI_API_TOKEN
- Handles CORS and request validation
```

### Why Use a Backend Proxy?

1. **Security**: API tokens never exposed to client-side code
2. **CORS Management**: Properly handles cross-origin requests
3. **Request Validation**: Validates requests before forwarding
4. **Rate Limiting**: Can implement rate limiting if needed
5. **Error Handling**: Provides consistent error responses
6. **Monitoring**: Easier to log and monitor API usage

## 🔑 Key Components

### Technology Stack

- **Frontend**: React 18, Vite, FFmpeg.wasm
- **Backend**: Node.js 18+, Express (xAI API Proxy)
- **Web Server**: Nginx (Reverse Proxy & Static Files)
- **Process Manager**: PM2 (or SystemD)
- **SSL**: Let's Encrypt (Certbot)
- **DNS**: Route 53, Cloud DNS, or GoDaddy
- **Hosting**: AWS EC2, GCP Compute Engine, or DigitalOcean Droplets

### xAI Backend Proxy Features

The Express.js backend (`server.js`) provides:
- **Secure Token Storage**: xAI API token stored server-side in .env
- **API Endpoint**: POST /api/chat proxies to xAI Grok API
- **Request Validation**: Validates message format before forwarding
- **CORS Configuration**: Configurable allowed origins
- **Error Handling**: Consistent error responses
- **Environment Support**: Production and development modes

### File Structure

```
finalcut/
├── DEPLOYMENT.md              # Main deployment guide
├── DEPLOYMENT-CHECKLIST.md    # Step-by-step checklist
├── QUICK-REFERENCE.md         # Command reference
├── TROUBLESHOOTING.md         # Problem solving guide
├── deploy.sh                  # Deployment script
├── setup-server.sh            # Server setup script
├── nginx.conf                 # Nginx configuration
├── finalcut.service           # SystemD service file
├── .env.production            # Environment template
├── README.md                  # Project documentation
├── package.json               # Dependencies
├── server.js                  # Express server
├── src/                       # React source code
└── dist/                      # Built files (generated)
```

## 💡 Usage Scenarios

### Scenario 1: New Deployment
1. Choose your platform (DigitalOcean, AWS, or GCP)
2. Review the appropriate deployment guide
3. Start with [DEPLOYMENT-CHECKLIST.md](./DEPLOYMENT-CHECKLIST.md)
4. Run `setup-server.sh` on new instance
5. Follow platform-specific checklist to complete deployment

### Scenario 2: Code Update
1. Push code to GitHub
2. SSH into server
3. Run `./deploy.sh`
4. Verify application is running

### Scenario 3: Troubleshooting
1. Check [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
2. Review logs with commands in [QUICK-REFERENCE.md](./QUICK-REFERENCE.md)
3. Use platform-specific diagnostic tools:
   - DigitalOcean: Droplet console, monitoring graphs
   - AWS: CloudWatch logs and metrics
   - GCP: Cloud Operations logs and monitoring

### Scenario 4: DNS/SSL Issues
1. Refer to DNS section in your platform's deployment guide
2. Check DNS propagation tools (whatsmydns.net)
3. Verify SSL certificate status with certbot
4. Follow SSL setup steps if renewal needed

### Scenario 5: Platform Migration
1. Set up new instance on target platform
2. Follow target platform's deployment guide
3. Copy .env file and application data
4. Update DNS to point to new server
5. Test thoroughly before decommissioning old server

## 🔒 Security Checklist

Before going live on any platform, ensure:

- [ ] `.env` file is not committed to Git
- [ ] XAI_API_TOKEN is stored securely in .env
- [ ] Firewall is enabled and configured (UFW or cloud firewall)
- [ ] SSH key authentication is set up (disable password auth)
- [ ] SSL certificate is installed and valid
- [ ] ALLOWED_ORIGINS is set to your domain only (not *)
- [ ] File permissions are correct (`.env` should be 600)
- [ ] Server packages are up to date
- [ ] Regular backups are configured (snapshots/AMIs/disk snapshots)
- [ ] Platform-specific security features enabled:
  - AWS: Security Groups, IAM roles
  - GCP: Firewall rules, Service accounts
  - DigitalOcean: Cloud Firewalls

## 📊 Monitoring

After deployment, monitor using platform-specific tools:

### All Platforms
- **Application**: `pm2 monit`
- **Logs**: `pm2 logs finalcut-server`
- **Server Resources**: `htop`
- **Disk Space**: `df -h`
- **SSL Certificate**: `sudo certbot certificates`

### Platform-Specific Monitoring

**DigitalOcean:**
- Droplet monitoring graphs (CPU, bandwidth, disk)
- DigitalOcean Dashboard metrics

**AWS:**
- CloudWatch metrics and alarms
- CloudWatch Logs for application logs
- AWS Systems Manager for server management
- `aws cloudwatch get-metric-statistics`

**Google Cloud Platform:**
- Cloud Operations (formerly Stackdriver)
- Cloud Monitoring dashboards
- Cloud Logging for centralized logs
- `gcloud logging read` for log queries

## 🆘 Getting Help

### Documentation Order

1. **Quick issue?** → [QUICK-REFERENCE.md](./QUICK-REFERENCE.md)
2. **Problem?** → [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
3. **New deployment?** → [DEPLOYMENT-CHECKLIST.md](./DEPLOYMENT-CHECKLIST.md)
4. **Detailed platform info?**
   - DigitalOcean: [DEPLOYMENT.md](./DEPLOYMENT.md)
   - AWS: [DEPLOYMENT-AWS.md](./DEPLOYMENT-AWS.md)
   - GCP: [DEPLOYMENT-GCP.md](./DEPLOYMENT-GCP.md)

### External Resources

**Application Support:**
- **GitHub Issues**: https://github.com/yishengjiang99/pages/issues

**Platform Documentation:**
- **DigitalOcean Docs**: https://docs.digitalocean.com/
- **AWS Documentation**: https://docs.aws.amazon.com/
- **GCP Documentation**: https://cloud.google.com/docs

**Tool Documentation:**
- **Nginx Docs**: https://nginx.org/en/docs/
- **PM2 Docs**: https://pm2.keymetrics.io/docs/
- **xAI API**: https://console.x.ai/

**Community Support:**
- **DigitalOcean Community**: https://www.digitalocean.com/community
- **AWS Forums**: https://forums.aws.amazon.com/
- **GCP Community**: https://www.googlecloudcommunity.com/

## 🎓 Learning Path

### Beginner
1. Read [DEPLOYMENT-CHECKLIST.md](./DEPLOYMENT-CHECKLIST.md)
2. Follow checklist step-by-step
3. Use automated scripts
4. Bookmark [QUICK-REFERENCE.md](./QUICK-REFERENCE.md)

### Intermediate
1. Study [DEPLOYMENT.md](./DEPLOYMENT.md) in detail
2. Understand Nginx configuration
3. Learn PM2 commands
4. Set up monitoring

### Advanced
1. Customize Nginx configuration
2. Set up CI/CD with GitHub Actions
3. Implement load balancing
4. Add caching layers
5. Optimize performance

## 📝 Notes

- All scripts tested on Ubuntu 22.04 LTS
- Node.js 18+ required for xAI proxy backend
- Minimum 1GB RAM recommended (2GB preferred)
- DNS propagation can take 1-48 hours
- SSL certificate renews automatically (Let's Encrypt)
- Compatible with DigitalOcean, AWS EC2, and GCP Compute Engine
- xAI API token required from https://console.x.ai/

## 🚀 Deployment Status

Track your deployment:

- [ ] Platform selected (DigitalOcean / AWS / GCP)
- [ ] Documentation reviewed
- [ ] Cloud instance set up
- [ ] xAI API token obtained
- [ ] Application deployed
- [ ] DNS configured
- [ ] SSL installed
- [ ] Backend proxy tested
- [ ] Testing completed
- [ ] Production ready

---

**Ready to deploy?** 
1. Choose your platform from the [Cloud Platform Comparison](#-cloud-platform-comparison)
2. Start with [DEPLOYMENT-CHECKLIST.md](./DEPLOYMENT-CHECKLIST.md)! 🎉
