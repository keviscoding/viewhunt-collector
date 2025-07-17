class ViewHuntApp {
    constructor() {
        // Auto-detect API base URL for production vs development
        this.apiBase = this.getApiBase();
        this.currentView = 'pending';
        this.channels = [];
        
        this.init();
    }

    async init() {
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
        card.dataset.channelId = channel.id;

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
                    <button class="btn btn-approve" onclick="app.approveChannel(${channel.id})">
                        ✅ Approve
                    </button>
                    <button class="btn btn-reject" onclick="app.rejectChannel(${channel.id})">
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

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize app
const app = new ViewHuntApp();