class ViewHuntApp {
    constructor() {
        // Auto-detect API base URL for production vs development
        this.apiBase = this.getApiBase();
        this.currentView = 'pending';
        this.channels = [];
        this.currentBatch = [];
        this.hasMoreBatches = true;
        this.isLoadingBatch = false;
        this.authToken = localStorage.getItem('viewhunt_token');
        this.user = null;
        
        this.init();
    }

    async init() {
        // Check if user is authenticated
        if (this.authToken) {
            await this.validateToken();
        }
        
        if (!this.user) {
            this.showAuthModal();
            return;
        }
        
        this.setupEventListeners();
        await this.loadStats();
        await this.loadChannels();
    }

    setupEventListeners() {
        // Navigation
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const view = e.currentTarget.dataset.view;
                this.switchView(view);
            });
        });

        // Filters - now trigger new batch loading for pending view
        document.getElementById('sort-select').addEventListener('change', () => {
            if (this.currentView === 'pending') {
                this.loadNewBatch();
            } else {
                this.applyFilters();
            }
        });

        document.getElementById('min-ratio').addEventListener('input', () => {
            this.debounce(() => {
                if (this.currentView === 'pending') {
                    this.loadNewBatch();
                } else {
                    this.applyFilters();
                }
            }, 500)();
        });

        document.getElementById('min-views').addEventListener('input', () => {
            this.debounce(() => {
                if (this.currentView === 'pending') {
                    this.loadNewBatch();
                } else {
                    this.applyFilters();
                }
            }, 500)();
        });
    }

    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    applyFilters() {
        if (!this.channels || this.channels.length === 0) return;

        const sortBy = document.getElementById('sort-select').value;
        const minRatio = parseFloat(document.getElementById('min-ratio').value) || 0;
        const minViews = parseInt(document.getElementById('min-views').value) || 0;

        // Filter channels
        let filteredChannels = this.channels.filter(channel => {
            const ratio = channel.view_to_sub_ratio || 0;
            const views = channel.view_count || 0;
            
            return ratio >= minRatio && views >= minViews;
        });

        // Sort channels
        filteredChannels.sort((a, b) => {
            switch (sortBy) {
                case 'ratio-desc':
                    return (b.view_to_sub_ratio || 0) - (a.view_to_sub_ratio || 0);
                case 'ratio-asc':
                    return (a.view_to_sub_ratio || 0) - (b.view_to_sub_ratio || 0);
                case 'views-desc':
                    return (b.view_count || 0) - (a.view_count || 0);
                case 'views-asc':
                    return (a.view_count || 0) - (b.view_count || 0);
                case 'subs-desc':
                    return (b.subscriber_count || 0) - (a.subscriber_count || 0);
                case 'subs-asc':
                    return (a.subscriber_count || 0) - (b.subscriber_count || 0);
                default:
                    return (b.view_to_sub_ratio || 0) - (a.view_to_sub_ratio || 0);
            }
        });

        // Update display
        this.renderFilteredChannels(filteredChannels);
    }

    renderFilteredChannels(channels) {
        const channelGrid = document.getElementById('channel-grid');
        const emptyState = document.getElementById('empty-state');

        channelGrid.innerHTML = '';

        if (channels.length === 0) {
            emptyState.style.display = 'block';
            emptyState.querySelector('h2').textContent = 'No Channels Match Filters';
            emptyState.querySelector('p').textContent = 'Try adjusting your filter criteria to see more results.';
        } else {
            emptyState.style.display = 'none';
            channels.forEach(channel => {
                const card = this.createChannelCard(channel);
                channelGrid.appendChild(card);
            });
        }
    }

    async validateToken() {
        try {
            const response = await this.fetchWithAuth(`${this.apiBase}/auth/me`);
            if (response.ok) {
                this.user = await response.json();
                return true;
            } else {
                this.logout();
                return false;
            }
        } catch (error) {
            console.error('Token validation error:', error);
            this.logout();
            return false;
        }
    }

    async fetchWithAuth(url, options = {}) {
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers
        };

        if (this.authToken) {
            headers['Authorization'] = `Bearer ${this.authToken}`;
        }

        return fetch(url, {
            ...options,
            headers
        });
    }

    showAuthModal() {
        const modal = document.createElement('div');
        modal.id = 'auth-modal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        `;

        modal.innerHTML = `
            <div style="background: white; padding: 2rem; border-radius: 12px; width: 90%; max-width: 400px;">
                <h2 style="margin-bottom: 1.5rem; text-align: center; color: #333;">Welcome to ViewHunt</h2>
                
                <div id="login-form">
                    <div style="margin-bottom: 1rem;">
                        <label style="display: block; margin-bottom: 0.5rem; color: #666;">Email:</label>
                        <input type="email" id="login-email" style="width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 6px;">
                    </div>
                    <div style="margin-bottom: 1.5rem;">
                        <label style="display: block; margin-bottom: 0.5rem; color: #666;">Password:</label>
                        <input type="password" id="login-password" style="width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 6px;">
                    </div>
                    <button onclick="app.login()" style="width: 100%; padding: 0.75rem; background: #007bff; color: white; border: none; border-radius: 6px; margin-bottom: 1rem;">
                        Sign In
                    </button>
                    <p style="text-align: center; color: #666; margin-bottom: 1rem;">Don't have an account?</p>
                    <button onclick="app.showRegisterForm()" style="width: 100%; padding: 0.75rem; background: #28a745; color: white; border: none; border-radius: 6px;">
                        Create Account
                    </button>
                </div>

                <div id="register-form" style="display: none;">
                    <div style="margin-bottom: 1rem;">
                        <label style="display: block; margin-bottom: 0.5rem; color: #666;">Display Name:</label>
                        <input type="text" id="register-name" style="width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 6px;">
                    </div>
                    <div style="margin-bottom: 1rem;">
                        <label style="display: block; margin-bottom: 0.5rem; color: #666;">Email:</label>
                        <input type="email" id="register-email" style="width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 6px;">
                    </div>
                    <div style="margin-bottom: 1.5rem;">
                        <label style="display: block; margin-bottom: 0.5rem; color: #666;">Password:</label>
                        <input type="password" id="register-password" style="width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 6px;">
                    </div>
                    <button onclick="app.register()" style="width: 100%; padding: 0.75rem; background: #28a745; color: white; border: none; border-radius: 6px; margin-bottom: 1rem;">
                        Create Account
                    </button>
                    <button onclick="app.showLoginForm()" style="width: 100%; padding: 0.75rem; background: #6c757d; color: white; border: none; border-radius: 6px;">
                        Back to Sign In
                    </button>
                </div>

                <div id="auth-error" style="color: #dc3545; text-align: center; margin-top: 1rem; display: none;"></div>
            </div>
        `;

        document.body.appendChild(modal);
    }

    showLoginForm() {
        document.getElementById('login-form').style.display = 'block';
        document.getElementById('register-form').style.display = 'none';
        document.getElementById('auth-error').style.display = 'none';
    }

    showRegisterForm() {
        document.getElementById('login-form').style.display = 'none';
        document.getElementById('register-form').style.display = 'block';
        document.getElementById('auth-error').style.display = 'none';
    }

    async login() {
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        const errorEl = document.getElementById('auth-error');

        if (!email || !password) {
            errorEl.textContent = 'Please fill in all fields';
            errorEl.style.display = 'block';
            return;
        }

        try {
            const response = await fetch(`${this.apiBase}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });

            const data = await response.json();

            if (response.ok) {
                this.authToken = data.token;
                this.user = data.user;
                localStorage.setItem('viewhunt_token', this.authToken);
                
                document.getElementById('auth-modal').remove();
                this.setupEventListeners();
                await this.loadStats();
                await this.loadChannels();
            } else {
                errorEl.textContent = data.error || 'Login failed';
                errorEl.style.display = 'block';
            }
        } catch (error) {
            console.error('Login error:', error);
            errorEl.textContent = 'Network error. Please try again.';
            errorEl.style.display = 'block';
        }
    }

    async register() {
        const displayName = document.getElementById('register-name').value;
        const email = document.getElementById('register-email').value;
        const password = document.getElementById('register-password').value;
        const errorEl = document.getElementById('auth-error');

        if (!displayName || !email || !password) {
            errorEl.textContent = 'Please fill in all fields';
            errorEl.style.display = 'block';
            return;
        }

        try {
            const response = await fetch(`${this.apiBase}/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    display_name: displayName, 
                    email, 
                    password 
                })
            });

            const data = await response.json();

            if (response.ok) {
                this.authToken = data.token;
                this.user = data.user;
                localStorage.setItem('viewhunt_token', this.authToken);
                
                document.getElementById('auth-modal').remove();
                this.setupEventListeners();
                await this.loadStats();
                await this.loadChannels();
            } else {
                errorEl.textContent = data.error || 'Registration failed';
                errorEl.style.display = 'block';
            }
        } catch (error) {
            console.error('Registration error:', error);
            errorEl.textContent = 'Network error. Please try again.';
            errorEl.style.display = 'block';
        }
    }

    logout() {
        this.authToken = null;
        this.user = null;
        localStorage.removeItem('viewhunt_token');
        location.reload();
    }

    async loadStats() {
        try {
            const response = await fetch(`${this.apiBase}/stats`);
            const stats = await response.json();
            
            document.getElementById('pending-count').textContent = stats.pending || 0;
            document.getElementById('approved-count').textContent = stats.approved || 0;
        } catch (error) {
            console.error('Error loading stats:', error);
        }
    }

    async loadChannels() {
        if (this.currentView === 'pending') {
            // Use optimized batch loading for pending channels
            await this.loadNewBatch();
        } else {
            // Use traditional loading for approved channels
            await this.loadApprovedChannels();
        }
    }

    async loadNewBatch() {
        if (this.isLoadingBatch) return;
        
        this.isLoadingBatch = true;
        const loading = document.getElementById('loading');
        const emptyState = document.getElementById('empty-state');
        const channelGrid = document.getElementById('channel-grid');

        loading.style.display = 'flex';
        emptyState.style.display = 'none';
        channelGrid.innerHTML = '';

        try {
            // Get current filter values
            const sortBy = document.getElementById('sort-select').value;
            const minRatio = parseFloat(document.getElementById('min-ratio').value) || 0;
            const minViews = parseInt(document.getElementById('min-views').value) || 0;

            // Build query parameters for optimized batch
            const params = new URLSearchParams({
                batchSize: '200',      // Server fetches 200 random channels
                displayLimit: '20',    // Display up to 20 channels
                sortBy: sortBy,
                minRatio: minRatio.toString(),
                minViews: minViews.toString()
            });

            const response = await this.fetchWithAuth(`${this.apiBase}/channels/pending?${params}`);
            const data = await response.json();

            this.currentBatch = data.channels || [];
            this.hasMoreBatches = data.hasMore || false;
            
            loading.style.display = 'none';

            if (this.currentBatch.length === 0) {
                emptyState.style.display = 'block';
                emptyState.querySelector('h2').textContent = 'No Channels Match Your Filters';
                emptyState.querySelector('p').textContent = 'Try adjusting your filter criteria or click "Next Batch" for different channels.';
            } else {
                this.renderBatchChannels();
            }

            // Update batch info display
            this.updateBatchInfo(data.batchInfo);

        } catch (error) {
            console.error('Error loading channel batch:', error);
            loading.style.display = 'none';
            emptyState.style.display = 'block';
            emptyState.querySelector('h2').textContent = 'Error Loading Channels';
            emptyState.querySelector('p').textContent = 'Please try again or check your connection.';
        } finally {
            this.isLoadingBatch = false;
        }
    }

    async loadApprovedChannels() {
        const loading = document.getElementById('loading');
        const emptyState = document.getElementById('empty-state');
        const channelGrid = document.getElementById('channel-grid');

        loading.style.display = 'flex';
        emptyState.style.display = 'none';
        channelGrid.innerHTML = '';

        try {
            const response = await this.fetchWithAuth(`${this.apiBase}/channels/approved`);
            this.channels = await response.json();

            loading.style.display = 'none';

            if (this.channels.length === 0) {
                emptyState.style.display = 'block';
                emptyState.querySelector('h2').textContent = 'No Approved Channels';
                emptyState.querySelector('p').textContent = 'Start reviewing channels to build your approved list.';
            } else {
                this.renderChannels();
            }
        } catch (error) {
            console.error('Error loading approved channels:', error);
            loading.style.display = 'none';
            emptyState.style.display = 'block';
        }
    }

    renderBatchChannels() {
        const channelGrid = document.getElementById('channel-grid');
        const emptyState = document.getElementById('empty-state');

        channelGrid.innerHTML = '';
        emptyState.style.display = 'none';

        this.currentBatch.forEach(channel => {
            const card = this.createChannelCard(channel);
            channelGrid.appendChild(card);
        });

        // Add "Next Batch" button if there are more batches available
        if (this.hasMoreBatches) {
            this.addNextBatchButton();
        }
    }

    addNextBatchButton() {
        const channelGrid = document.getElementById('channel-grid');
        
        const nextBatchCard = document.createElement('div');
        nextBatchCard.className = 'channel-card next-batch-card';
        nextBatchCard.innerHTML = `
            <div style="text-align: center; padding: 2rem;">
                <div style="font-size: 3rem; margin-bottom: 1rem;">🔄</div>
                <h3 style="margin-bottom: 1rem;">Want to see different channels?</h3>
                <p style="margin-bottom: 1.5rem; color: #666;">Get a fresh batch of 200 random channels with your current filters applied.</p>
                <button class="btn btn-primary" onclick="app.loadNewBatch()" style="width: 100%;">
                    🎲 Next Batch
                </button>
            </div>
        `;
        
        channelGrid.appendChild(nextBatchCard);
    }

    updateBatchInfo(batchInfo) {
        // Create or update batch info display
        let batchInfoEl = document.getElementById('batch-info');
        if (!batchInfoEl) {
            batchInfoEl = document.createElement('div');
            batchInfoEl.id = 'batch-info';
            batchInfoEl.style.cssText = `
                background: rgba(255, 255, 255, 0.1);
                padding: 0.75rem 1rem;
                border-radius: 8px;
                margin-bottom: 1rem;
                font-size: 0.9rem;
                color: #ccc;
            `;
            
            const filtersEl = document.getElementById('filters');
            filtersEl.parentNode.insertBefore(batchInfoEl, filtersEl.nextSibling);
        }

        if (batchInfo) {
            batchInfoEl.innerHTML = `
                📊 Batch: ${batchInfo.batchReceived} fetched → ${batchInfo.afterFiltering} after filters → ${batchInfo.displayed} displayed
            `;
        }
    }

    renderChannels() {
        // Apply filters by default (which sorts by best ratio first)
        this.applyFilters();
    }

    createChannelCard(channel) {
        const card = document.createElement('div');
        card.className = 'channel-card';
        card.dataset.channelId = channel._id;

        // Get first letter for avatar
        const avatarLetter = channel.channel_name.charAt(0).toUpperCase();
        
        // Format numbers
        const formatNumber = (num) => {
            if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
            if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
            return num.toString();
        };

        const viewCount = formatNumber(channel.view_count || 0);
        const subCount = formatNumber(channel.subscriber_count || 0);
        const ratio = channel.view_to_sub_ratio ? channel.view_to_sub_ratio.toFixed(2) : 'N/A';

        card.innerHTML = `
            <div class="channel-header">
                <div class="channel-avatar">${avatarLetter}</div>
                <div class="channel-info">
                    <h3>${this.escapeHtml(channel.channel_name)}</h3>
                    <p>${this.escapeHtml(channel.video_title || 'No video title')}</p>
                </div>
            </div>
            
            <div class="channel-stats">
                <div class="stat-item">
                    <span class="stat-value">${viewCount}</span>
                    <span class="stat-label">Views</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value">${subCount}</span>
                    <span class="stat-label">Subs</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value ratio-highlight">${ratio}</span>
                    <span class="stat-label">Ratio</span>
                </div>
            </div>
            
            <div class="channel-actions">
                <a href="${channel.channel_url}" target="_blank" class="btn btn-primary">
                    🔗 View Channel
                </a>
                ${this.currentView === 'pending' ? `
                    <button class="btn btn-approve" onclick="app.approveChannel('${channel._id}')">
                        ✅ Approve
                    </button>
                    <button class="btn btn-reject" onclick="app.rejectChannel('${channel._id}')">
                        ❌ Reject
                    </button>
                ` : ''}
            </div>
        `;

        return card;
    }

    async approveChannel(channelId) {
        try {
            const response = await this.fetchWithAuth(`${this.apiBase}/channels/${channelId}/approve`, {
                method: 'PUT'
            });

            if (response.ok) {
                // Remove card from UI
                const card = document.querySelector(`[data-channel-id="${channelId}"]`);
                if (card) {
                    card.style.transform = 'translateX(100%)';
                    card.style.opacity = '0';
                    setTimeout(() => card.remove(), 300);
                }

                // Update stats
                await this.loadStats();

                // Show success feedback
                this.showToast('Channel approved! ✅');
            } else {
                const error = await response.json();
                this.showToast(error.error || 'Error approving channel ❌');
            }
        } catch (error) {
            console.error('Error approving channel:', error);
            this.showToast('Error approving channel ❌');
        }
    }

    async rejectChannel(channelId) {
        try {
            const response = await this.fetchWithAuth(`${this.apiBase}/channels/${channelId}/reject`, {
                method: 'PUT'
            });

            if (response.ok) {
                // Remove card from UI
                const card = document.querySelector(`[data-channel-id="${channelId}"]`);
                if (card) {
                    card.style.transform = 'translateX(-100%)';
                    card.style.opacity = '0';
                    setTimeout(() => card.remove(), 300);
                }

                // Update stats
                await this.loadStats();

                // Show success feedback
                this.showToast('Channel rejected ❌');
            } else {
                const error = await response.json();
                this.showToast(error.error || 'Error rejecting channel ❌');
            }
        } catch (error) {
            console.error('Error rejecting channel:', error);
            this.showToast('Error rejecting channel ❌');
        }
    }

    switchView(view) {
        // Update active nav button
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });

        // Show/hide filters based on view
        const filters = document.getElementById('filters');
        if (view === 'pending') {
            filters.style.display = 'grid';
        } else {
            filters.style.display = 'none';
        }

        this.currentView = view;
        this.loadChannels();
    }

    showToast(message) {
        // Create toast element
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            z-index: 1000;
            transform: translateX(100%);
            transition: transform 0.3s ease;
        `;
        toast.textContent = message;
        
        document.body.appendChild(toast);
        
        // Animate in
        setTimeout(() => {
            toast.style.transform = 'translateX(0)';
        }, 100);
        
        // Remove after 3 seconds
        setTimeout(() => {
            toast.style.transform = 'translateX(100%)';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    getApiBase() {
        // Check if we're in development (localhost) or production
        const hostname = window.location.hostname;
        
        if (hostname === 'localhost' || hostname === '127.0.0.1') {
            // Development - use local server
            return 'http://localhost:3002/api';
        } else {
            // Production - use the same domain (single service)
            return `${window.location.origin}/api`;
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize app
const app = new ViewHuntApp();