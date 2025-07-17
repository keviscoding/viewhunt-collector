# ViewHunt - YouTube Shorts Channel Discovery System

A comprehensive system for discovering and analyzing high-performing YouTube Shorts channels through automated scraping, review workflows, and personal collections.

## 🎯 Overview

ViewHunt consists of three main components:
1. **Chrome Extension** - Scrapes YouTube Shorts channel data
2. **Backend Server** - Manages data, authentication, and collections
3. **Web Interface** - Review channels and organize collections

## 🚀 Quick Start

### Chrome Extension Setup

1. Load the extension in Chrome:
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select this directory

2. Configure the extension:
   - Click the ViewHunt extension icon
   - Set your YouTube API key (optional - default provided)
   - Configure keywords for scraping
   - Click "Start Processing"

### Backend Server Setup

1. Navigate to the server directory:
   ```bash
   cd server
   npm install
   ```

2. Set up environment variables in `server/.env`:
   ```
   MONGODB_URI=your_mongodb_connection_string
   JWT_SECRET=your_jwt_secret_key
   PORT=3001
   ```

3. Start the server:
   ```bash
   npm start
   ```

### Web Interface

- Access the web app at: `http://localhost:3001`
- Create an account to start reviewing channels
- Approve/reject channels and organize them into collections

## 📋 Features

### Chrome Extension
- ✅ Automated YouTube Shorts scraping
- ✅ Configurable keyword processing
- ✅ Channel avatar extraction
- ✅ YouTube API integration for subscriber data
- ✅ CSV export functionality
- ✅ Automatic backend synchronization

### Backend API
- ✅ MongoDB database with collections
- ✅ User authentication (JWT)
- ✅ Channel review system
- ✅ Personal collections management
- ✅ RESTful API endpoints
- ✅ Rate limiting and security

### Web Interface
- ✅ Mobile-responsive design
- ✅ Real-time channel review
- ✅ Advanced filtering and sorting
- ✅ Collections management
- ✅ User profiles and statistics
- ✅ Authentication system

## 🛠 Technical Stack

- **Frontend**: Vanilla JavaScript, CSS3, HTML5
- **Backend**: Node.js, Express.js, MongoDB
- **Extension**: Chrome Extension APIs, YouTube Data API v3
- **Authentication**: JWT tokens, bcrypt
- **Database**: MongoDB with indexes for performance

## 📊 Data Flow

1. Extension scrapes YouTube Shorts data
2. Data is processed and enriched with subscriber counts
3. Results are sent to the backend server
4. Users review channels in the web interface
5. Approved channels can be organized into collections

## 🔧 Configuration

### Keywords
Configure search keywords in the extension popup. Default keywords focus on high-engagement terms.

### API Limits
Set channel limits per keyword to manage API quota usage and processing time.

### Collections
Create custom collections to organize channels by niche, performance, or any criteria.

## 📈 Usage Tips

1. **Start with broad keywords** like "how", "why", "best" for maximum discovery
2. **Use the ratio filter** to find channels with high view-to-subscriber ratios
3. **Create themed collections** to organize channels by niche or content type
4. **Export data regularly** to maintain backups of your discoveries

## 🚀 Deployment

The system is designed for easy deployment:
- Backend can be deployed to any Node.js hosting service
- MongoDB can be hosted on MongoDB Atlas
- Extension can be published to Chrome Web Store
- Web interface is served directly by the backend

## 📝 License

This project is for educational and research purposes.
