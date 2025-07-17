class ViewHuntApp {
    constructor() {
        // Auto-detect API base URL for production vs development
        this.apiBase = this.getApiBase();
        this.currentView = 'pending';
        this.channels = [];
        this.user = null;
        this.token = localStorage.getItem('viewhunt_token');
        
        this.init();
    }

    async init() {
        this.setupEventListeners();
        await this.checkAuthStatus();
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

        // Filters
        document.getElementById('sort-select').addEventListener('change', () => {
            this.applyFilters();
        });

        document.getElementById('min-ratio').addEventListener('input', () => {
            this.debounce(() => this.applyFilters(), 500)();
        });

        document.getElementById('min-views').addEventListener('input', () => {
            this.debounce(() => this.applyFilters(), 500)();
        });

        // Authentication forms
        document.getElementById('login-form-element').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleLogin();
        });

        document.getElementById('register-form-element').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleRegister();
        });

        // Close auth modal when clicking overlay
        document.getElementById('auth-overlay').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                this.closeAuth();
            }
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
        const loading = document.getElementById('loading');
        const emptyState = document.getElementById('empty-state');
        const channelGrid = document.getElementById('channel-grid');

        loading.style.display = 'flex';
        emptyState.style.display = 'none';
        channelGrid.innerHTML = '';

        try {
            const endpoint = this.currentView === 'pending' ? '/channels/pending' : '/channels/approved';
            const response = await fetch(`${this.apiBase}${endpoint}`);
            this.channels = await response.json();

            loading.style.display = 'none';

            if (this.channels.length === 0) {
                emptyState.style.display = 'block';
                // Reset empty state message based on current view
                if (this.currentView === 'pending') {
                    emptyState.querySelector('h2').textContent = 'No Channels to Review';
                    emptyState.querySelector('p').textContent = 'All caught up! Check back later for new channels to review.';
                } else {
                    emptyState.querySelector('h2').textContent = 'No Approved Channels';
                    emptyState.querySelector('p').textContent = 'Start reviewing channels to build your approved list.';
                }
            } else {
                this.renderChannels();
            }
        } catch (error) {
            console.error('Error loading channels:', error);
            loading.style.display = 'none';
            emptyState.style.display = 'block';
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

        // Get first letter for avatar fallback
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

        // Create avatar HTML - use real avatar if available, fallback to letter
        const avatarHtml = channel.avatar_url ? 
            `<img src="${channel.avatar_url}" alt="${this.escapeHtml(channel.channel_name)}" class="channel-avatar-img">` :
            `<div class="channel-avatar-letter">${avatarLetter}</div>`;

        card.innerHTML = `
            <div class="channel-header">
                <div class="channel-avatar">${avatarHtml}</div>
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
            const response = await fetch(`${this.apiBase}/channels/${channelId}/approve`, {
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
            }
        } catch (error) {
            console.error('Error approving channel:', error);
            this.showToast('Error approving channel ❌');
        }
    }

    async rejectChannel(channelId) {
        try {
            const response = await fetch(`${this.apiBase}/channels/${channelId}/reject`, {
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

    // Authentication Methods
    async checkAuthStatus() {
        if (this.token) {
            try {
                const response = await fetch(`${this.apiBase}/auth/me`, {
                    headers: {
                        'Authorization': `Bearer ${this.token}`
                    }
                });

                if (response.ok) {
                    this.user = await response.json();
                    this.updateUIForLoggedInUser();
                } else {
                    // Token is invalid, remove it
                    localStorage.removeItem('viewhunt_token');
                    this.token = null;
                    this.updateUIForLoggedOutUser();
                }
            } catch (error) {
                console.error('Error checking auth status:', error);
                this.updateUIForLoggedOutUser();
            }
        } else {
            this.updateUIForLoggedOutUser();
        }
    }

    updateUIForLoggedInUser() {
        document.getElementById('auth-buttons').style.display = 'none';
        document.getElementById('user-info').style.display = 'flex';
        
        // Update user info
        document.getElementById('user-name').textContent = this.user.display_name;
        document.getElementById('user-display-name').textContent = this.user.display_name;
        document.getElementById('user-approved-count').textContent = this.user.stats.channels_approved;
        document.getElementById('user-rejected-count').textContent = this.user.stats.channels_rejected;
    }

    updateUIForLoggedOutUser() {
        document.getElementById('auth-buttons').style.display = 'flex';
        document.getElementById('user-info').style.display = 'none';
    }

    showLogin() {
        document.getElementById('login-form').style.display = 'block';
        document.getElementById('register-form').style.display = 'none';
        document.getElementById('auth-overlay').style.display = 'flex';
        
        // Clear forms
        document.getElementById('login-form-element').reset();
    }

    showRegister() {
        document.getElementById('login-form').style.display = 'none';
        document.getElementById('register-form').style.display = 'block';
        document.getElementById('auth-overlay').style.display = 'flex';
        
        // Clear forms
        document.getElementById('register-form-element').reset();
    }

    closeAuth() {
        document.getElementById('auth-overlay').style.display = 'none';
    }

    async handleLogin() {
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        const submitBtn = document.querySelector('#login-form button[type="submit"]');

        if (!email || !password) {
            this.showToast('Please fill in all fields ❌');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Signing In...';

        try {
            const response = await fetch(`${this.apiBase}/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ email, password })
            });

            const data = await response.json();

            if (response.ok) {
                this.token = data.token;
                this.user = data.user;
                localStorage.setItem('viewhunt_token', this.token);
                
                this.updateUIForLoggedInUser();
                this.closeAuth();
                this.showToast(`Welcome back, ${this.user.display_name}! 🎉`);
                
                // Reload channels to show approve/reject buttons
                await this.loadChannels();
            } else {
                this.showToast(data.error || 'Login failed ❌');
            }
        } catch (error) {
            console.error('Login error:', error);
            this.showToast('Network error. Please try again ❌');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Sign In';
        }
    }

    async handleRegister() {
        const displayName = document.getElementById('register-display-name').value;
        const email = document.getElementById('register-email').value;
        const password = document.getElementById('register-password').value;
        const submitBtn = document.querySelector('#register-form button[type="submit"]');

        if (!displayName || !email || !password) {
            this.showToast('Please fill in all fields ❌');
            return;
        }

        if (password.length < 8) {
            this.showToast('Password must be at least 8 characters ❌');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating Account...';

        try {
            const response = await fetch(`${this.apiBase}/auth/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    display_name: displayName,
                    email,
                    password
                })
            });

            const data = await response.json();

            if (response.ok) {
                this.token = data.token;
                this.user = data.user;
                localStorage.setItem('viewhunt_token', this.token);
                
                this.updateUIForLoggedInUser();
                this.closeAuth();
                this.showToast(`Welcome to ViewHunt, ${this.user.display_name}! 🎉`);
                
                // Reload channels to show approve/reject buttons
                await this.loadChannels();
            } else {
                this.showToast(data.error || 'Registration failed ❌');
            }
        } catch (error) {
            console.error('Registration error:', error);
            this.showToast('Network error. Please try again ❌');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Account';
        }
    }

    toggleUserMenu() {
        const menu = document.getElementById('user-menu');
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        
        // Close menu when clicking outside
        if (menu.style.display === 'block') {
            setTimeout(() => {
                document.addEventListener('click', this.closeUserMenuOnClickOutside.bind(this), { once: true });
            }, 100);
        }
    }

    closeUserMenuOnClickOutside(event) {
        const menu = document.getElementById('user-menu');
        const menuBtn = document.querySelector('.user-menu-btn');
        
        if (!menu.contains(event.target) && !menuBtn.contains(event.target)) {
            menu.style.display = 'none';
        }
    }

    logout() {
        localStorage.removeItem('viewhunt_token');
        this.token = null;
        this.user = null;
        
        this.updateUIForLoggedOutUser();
        this.showToast('Signed out successfully 👋');
        
        // Reload channels to hide approve/reject buttons
        this.loadChannels();
    }

    // Update approve/reject methods to include authentication
    async approveChannel(channelId) {
        if (!this.token) {
            this.showLogin();
            this.showToast('Please sign in to approve channels 🔐');
            return;
        }

        try {
            const response = await fetch(`${this.apiBase}/channels/${channelId}/approve`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
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
                await this.checkAuthStatus(); // Update user stats

                // Show success feedback
                this.showToast('Channel approved! ✅');
            } else if (response.status === 401) {
                this.showLogin();
                this.showToast('Please sign in to approve channels 🔐');
            } else {
                this.showToast('Error approving channel ❌');
            }
        } catch (error) {
            console.error('Error approving channel:', error);
            this.showToast('Error approving channel ❌');
        }
    }

    async rejectChannel(channelId) {
        if (!this.token) {
            this.showLogin();
            this.showToast('Please sign in to reject channels 🔐');
            return;
        }

        try {
            const response = await fetch(`${this.apiBase}/channels/${channelId}/reject`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
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
                await this.checkAuthStatus(); // Update user stats

                // Show success feedback
                this.showToast('Channel rejected ❌');
            } else if (response.status === 401) {
                this.showLogin();
                this.showToast('Please sign in to reject channels 🔐');
            } else {
                this.showToast('Error rejecting channel ❌');
            }
        } catch (error) {
            console.error('Error rejecting channel:', error);
            this.showToast('Error rejecting channel ❌');
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize app
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new ViewHuntApp();
    window.app = app; // Make it globally available
});