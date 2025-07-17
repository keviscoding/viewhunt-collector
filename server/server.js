const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Serve mobile app static files
app.use('/mobile', express.static(path.join(__dirname, 'mobile')));
app.use(express.static(path.join(__dirname, 'mobile')));

// Serve mobile app at root for convenience
app.get('/', (req, res) => {
    const mobilePath = path.join(__dirname, 'mobile/index.html');
    console.log('Trying to serve mobile app from:', mobilePath);
    
    // Check if file exists
    if (require('fs').existsSync(mobilePath)) {
        res.sendFile(mobilePath);
    } else {
        console.error('Mobile app not found at:', mobilePath);
        res.status(404).send(`
            <h1>ViewHunt Backend is Running!</h1>
            <p>Server is working on port 8080</p>
            <p>Database: ${process.env.DATABASE_PATH || 'viewhunt.db'}</p>
            <p>Looking for mobile app at: ${mobilePath}</p>
            <p>File exists: ${require('fs').existsSync(mobilePath)}</p>
            <p><a href="/api/health">Test API Health</a></p>
        `);
    }
});

// Database setup
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'viewhunt.db');

// Ensure database directory exists
const dbDir = path.dirname(dbPath);
if (!require('fs').existsSync(dbDir)) {
    require('fs').mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

// Initialize database tables
db.serialize(() => {
    // Channels table - stores scraped channel data
    db.run(`CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_name TEXT NOT NULL,
        channel_url TEXT UNIQUE NOT NULL,
        video_title TEXT,
        view_count INTEGER,
        subscriber_count INTEGER,
        view_to_sub_ratio REAL,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Create index for faster queries
    db.run(`CREATE INDEX IF NOT EXISTS idx_status ON channels(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ratio ON channels(view_to_sub_ratio DESC)`);
});

// API Routes

// Get pending channels (ordered by view-to-sub ratio)
app.get('/api/channels/pending', (req, res) => {
    const query = `
        SELECT * FROM channels 
        WHERE status = 'pending' 
        ORDER BY view_to_sub_ratio DESC 
        LIMIT 50
    `;
    
    db.all(query, [], (err, rows) => {
        if (err) {
            console.error('Error fetching pending channels:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(rows);
    });
});

// Add new channels from scraper
app.post('/api/channels/bulk', (req, res) => {
    const channels = req.body.channels;
    
    if (!Array.isArray(channels)) {
        return res.status(400).json({ error: 'Channels must be an array' });
    }

    const stmt = db.prepare(`
        INSERT OR REPLACE INTO channels 
        (channel_name, channel_url, video_title, view_count, subscriber_count, view_to_sub_ratio, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    let insertedCount = 0;
    let errorCount = 0;

    channels.forEach(channel => {
        stmt.run([
            channel.channelName,
            channel.channelUrl,
            channel.videoTitle,
            channel.viewCount,
            channel.subscriberCount || 0,
            channel.viewToSubRatio || 0
        ], function(err) {
            if (err) {
                console.error('Error inserting channel:', err);
                errorCount++;
            } else {
                insertedCount++;
            }
        });
    });

    stmt.finalize((err) => {
        if (err) {
            console.error('Error finalizing statement:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        res.json({ 
            message: 'Channels processed',
            inserted: insertedCount,
            errors: errorCount
        });
    });
});

// Approve a channel
app.put('/api/channels/:id/approve', (req, res) => {
    const channelId = req.params.id;
    
    db.run(
        'UPDATE channels SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['approved', channelId],
        function(err) {
            if (err) {
                console.error('Error approving channel:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Channel not found' });
            }
            
            res.json({ message: 'Channel approved' });
        }
    );
});

// Reject a channel
app.put('/api/channels/:id/reject', (req, res) => {
    const channelId = req.params.id;
    
    db.run(
        'UPDATE channels SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['rejected', channelId],
        function(err) {
            if (err) {
                console.error('Error rejecting channel:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Channel not found' });
            }
            
            res.json({ message: 'Channel rejected' });
        }
    );
});

// Get approved channels
app.get('/api/channels/approved', (req, res) => {
    const query = `
        SELECT * FROM channels 
        WHERE status = 'approved' 
        ORDER BY updated_at DESC 
        LIMIT 100
    `;
    
    db.all(query, [], (err, rows) => {
        if (err) {
            console.error('Error fetching approved channels:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(rows);
    });
});

// Get stats
app.get('/api/stats', (req, res) => {
    const queries = {
        pending: 'SELECT COUNT(*) as count FROM channels WHERE status = "pending"',
        approved: 'SELECT COUNT(*) as count FROM channels WHERE status = "approved"',
        rejected: 'SELECT COUNT(*) as count FROM channels WHERE status = "rejected"'
    };

    const stats = {};
    let completed = 0;

    Object.keys(queries).forEach(key => {
        db.get(queries[key], [], (err, row) => {
            if (err) {
                console.error(`Error getting ${key} count:`, err);
                stats[key] = 0;
            } else {
                stats[key] = row.count;
            }
            
            completed++;
            if (completed === Object.keys(queries).length) {
                res.json(stats);
            }
        });
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
    console.log(`ViewHunt server running on port ${PORT}`);
    console.log(`Database: ${dbPath}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err);
        } else {
            console.log('Database connection closed.');
        }
        process.exit(0);
    });
});