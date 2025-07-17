# ViewHunt Web App Setup Instructions

## 🚀 Quick Start

### 1. Install Server Dependencies
```bash
cd server
npm install
```

### 2. Start the Backend Server
```bash
npm start
```
The server will run on `http://localhost:3001`

### 3. Open Mobile Web App
Open `mobile/index.html` in your browser or serve it locally:
```bash
# Option 1: Direct file access
open mobile/index.html

# Option 2: Simple HTTP server (if you have Python)
cd mobile
python -m http.server 8080
# Then visit http://localhost:8080
```

### 4. Run Your Chrome Extension
Your existing Chrome extension will now automatically send scraped data to the backend server.

## 📱 How It Works

### Desktop (Chrome Extension)
1. **Run the scraper** as usual on your laptop
2. **Data flows automatically** to the backend database
3. **No manual export needed** - everything syncs automatically

### Mobile (Web App)
1. **Open the web app** on your phone: `http://localhost:8080` (or wherever you host it)
2. **Review channels** with beautiful card-based UI
3. **Approve/Reject** channels with one tap
4. **Click "View Channel"** to instantly go to YouTube
5. **Real-time stats** show your progress

## 🎯 Mobile Features

### Channel Cards Show:
- ✅ **Channel name** and **video title**
- ✅ **View count**, **subscriber count**, and **view-to-sub ratio**
- ✅ **Profile avatar** (first letter of channel name)
- ✅ **Direct YouTube link** button
- ✅ **Approve/Reject** buttons

### Navigation:
- 📋 **Review Tab**: Pending channels (sorted by best ratio)
- ✅ **Approved Tab**: Your saved channels
- 📊 **Live stats** in header

### Mobile Optimized:
- 📱 **Responsive design** works on all screen sizes
- 🎨 **Beautiful gradient UI** with smooth animations
- ⚡ **Fast loading** and smooth interactions
- 🔄 **Real-time updates** when you approve/reject

## 🔧 Configuration

### Backend Server (server/.env)
```
PORT=3001
NODE_ENV=development
```

### Chrome Extension
The extension automatically sends data to `http://localhost:3001/api/channels/bulk`

## 📊 Database

The SQLite database (`server/viewhunt.db`) stores:
- Channel name, URL, video title
- View count, subscriber count, view-to-sub ratio  
- Status: `pending`, `approved`, `rejected`
- Timestamps for tracking

## 🌐 Next Steps (Future)

### For Production Deployment:
1. **Host backend** on services like Railway, Render, or Heroku
2. **Host mobile app** on Netlify, Vercel, or GitHub Pages
3. **Update API URLs** in both extension and mobile app
4. **Add user authentication** for team collaboration

### Multi-User Features (Later):
- User accounts and login
- Team collaboration
- Individual approval lists
- Role-based permissions

## 🎉 You're Ready!

1. Start the server: `cd server && npm start`
2. Open mobile app: `mobile/index.html`
3. Run your Chrome extension scraper
4. Review channels on your phone! 📱✨