class ViewHuntApp {
    constructor() {
        // Auto-detect API base URL for production vs development
        this.apiBase = this.getApiBase();
        this.currentView = 'pending';
        this.channels = [];
        this.collections = [];
        this.currentCollection = null;
        this.user = null;
        this.token = localStorage.getItem('viewhunt_token');
        
        // Pagination state
        this.currentPage = 1;
        this.pagination = null;
        this.isLoadingPage = false;
        
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

        // Create collection form
        document.getElementById('create-collection-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleCreateCollection();
        });

        // Close create collection modal when clicking overlay
        document.getElementById('create-collection-overlay').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                this.closeCreateCollection();
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
            
            // Both endpoints now require authentication
            if (!this.token) {
                this.channels = [];
                loading.style.display = 'none';
                emptyState.style.display = 'block';
                emptyState.querySelector('h2').textContent = 'Sign In Required';
                emptyState.querySelector('p').textContent = 'Please sign in to view channels.';
                return;
            }
            
            // Add pagination parameters for pending channels
            const url = this.currentView === 'pending' ? 
                `${this.apiBase}${endpoint}?page=1&limit=20` : 
                `${this.apiBase}${endpoint}`;
            
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });
            
            if (!response.ok) {
                if (response.status === 401) {
                    // Token expired or invalid
                    localStorage.removeItem('viewhunt_token');
                    this.token = null;
                    this.updateUIForLoggedOutUser();
                    this.channels = [];
                    loading.style.display = 'none';
                    emptyState.style.display = 'block';
                    emptyState.querySelector('h2').textContent = 'Sign In Required';
                    emptyState.querySelector('p').textContent = 'Please sign in to view channels.';
                    return;
                }
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            // Handle paginated response for pending channels
            if (this.currentView === 'pending' && data.channels) {
                this.channels = data.channels;
                this.pagination = data.pagination;
                console.log(`Loaded ${this.channels.length} channels (Page ${data.pagination.page}/${data.pagination.pages})`);
            } else {
                // Handle direct array response for approved channels
                this.channels = Array.isArray(data) ? data : [];
            }

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
                    <button class="btn btn-approve" onclick="window.app.approveChannel('${channel._id}')">
                        ✅ Approve
                    </button>
                    <button class="btn btn-reject" onclick="window.app.rejectChannel('${channel._id}')">
                        ❌ Reject
                    </button>
                ` : ''}
                ${this.currentView === 'approved' && this.token ? `
                    <button class="save-to-collection-btn" onclick="window.app.showSaveToCollection('${channel._id}')">
                        📚 Save
                    </button>
                ` : ''}
            </div>
        `;

        return card;
    }

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

                // IMPORTANT: Remove channel from data array to prevent it from reappearing in filters
                this.channels = this.channels.filter(channel => channel._id !== channelId);

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

                // IMPORTANT: Remove channel from data array to prevent it from reappearing in filters
                this.channels = this.channels.filter(channel => channel._id !== channelId);

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

    switchView(view) {
        // Update active nav button
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });

        // Show/hide different views
        const filters = document.getElementById('filters');
        const channelGrid = document.getElementById('channel-grid');
        const collectionsView = document.getElementById('collections-view');
        const socialView = document.getElementById('social-view');
        const emptyState = document.getElementById('empty-state');
        const loading = document.getElementById('loading');

        // Hide all views first
        filters.style.display = 'none';
        channelGrid.style.display = 'none';
        collectionsView.style.display = 'none';
        socialView.style.display = 'none';
        emptyState.style.display = 'none';
        loading.style.display = 'none';

        this.currentView = view;

        if (view === 'collections') {
            // Show collections view
            collectionsView.style.display = 'block';
            this.loadCollections();
        } else if (view === 'social') {
            // Show social view
            socialView.style.display = 'block';
            this.loadSocialData();
        } else {
            // Show channels view (pending/approved)
            channelGrid.style.display = 'grid';
            
            if (view === 'pending') {
                filters.style.display = 'grid';
            }

            this.loadChannels();
        }
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

    // Collections Methods
    async loadCollections() {
        if (!this.token) {
            this.showCollectionsLoginPrompt();
            return;
        }

        try {
            const response = await fetch(`${this.apiBase}/collections`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                this.collections = await response.json();
                this.renderCollections();
            } else if (response.status === 401) {
                this.showCollectionsLoginPrompt();
            } else {
                this.showCollectionsError();
            }
        } catch (error) {
            console.error('Error loading collections:', error);
            this.showCollectionsError();
        }
    }

    renderCollections() {
        const collectionsGrid = document.getElementById('collections-grid');
        const collectionDetails = document.getElementById('collection-details');
        
        // Show collections list, hide details
        collectionsGrid.style.display = 'grid';
        collectionDetails.style.display = 'none';
        
        collectionsGrid.innerHTML = '';

        if (this.collections.length === 0) {
            collectionsGrid.innerHTML = `
                <div class="collection-empty">
                    <div class="collection-empty-icon">📚</div>
                    <h3>No Collections Yet</h3>
                    <p>Create your first collection to organize your favorite channels!</p>
                </div>
            `;
            return;
        }

        this.collections.forEach(collection => {
            const card = this.createCollectionCard(collection);
            collectionsGrid.appendChild(card);
        });
    }

    createCollectionCard(collection) {
        const card = document.createElement('div');
        card.className = 'collection-card';

        const timeAgo = this.getTimeAgo(new Date(collection.updated_at));
        const channelCount = collection.channel_count || 0;

        card.innerHTML = `
            <div class="collection-card-header">
                <div class="collection-icon">📚</div>
                <div class="collection-info">
                    <h3>${this.escapeHtml(collection.name)}</h3>
                    <p>${this.escapeHtml(collection.description || 'No description')}</p>
                </div>
                <div class="collection-actions">
                    <button class="collection-share-btn" onclick="event.stopPropagation(); window.app.shareCollection('${collection._id}', '${this.escapeHtml(collection.name)}')" title="Share Collection">
                        🔗
                    </button>
                </div>
            </div>
            <div class="collection-stats">
                <span class="collection-count">${channelCount} channel${channelCount !== 1 ? 's' : ''}</span>
                <span class="collection-updated">${timeAgo}</span>
            </div>
        `;

        // Add click handler for the main card (excluding the share button)
        card.addEventListener('click', (e) => {
            if (!e.target.classList.contains('collection-share-btn')) {
                this.viewCollection(collection._id);
            }
        });

        return card;
    }

    async viewCollection(collectionId) {
        if (!this.token) {
            this.showLogin();
            return;
        }

        try {
            const response = await fetch(`${this.apiBase}/collections/${collectionId}/channels`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                const data = await response.json();
                this.currentCollection = data.collection;
                this.renderCollectionDetails(data.collection, data.channels);
            } else {
                this.showToast('Error loading collection ❌');
            }
        } catch (error) {
            console.error('Error loading collection:', error);
            this.showToast('Error loading collection ❌');
        }
    }

    renderCollectionDetails(collection, channels) {
        const collectionsGrid = document.getElementById('collections-grid');
        const collectionDetails = document.getElementById('collection-details');
        const collectionTitle = document.getElementById('collection-title');
        const collectionDescription = document.getElementById('collection-description');
        const collectionChannels = document.getElementById('collection-channels');

        // Hide collections list, show details
        collectionsGrid.style.display = 'none';
        collectionDetails.style.display = 'block';

        // Update collection info
        collectionTitle.textContent = collection.name;
        collectionDescription.textContent = collection.description || 'No description';

        // Render channels
        collectionChannels.innerHTML = '';

        if (channels.length === 0) {
            collectionChannels.innerHTML = `
                <div class="collection-empty">
                    <div class="collection-empty-icon">📺</div>
                    <h3>No Channels Yet</h3>
                    <p>Start adding channels to this collection from the Review tab!</p>
                </div>
            `;
            return;
        }

        channels.forEach(channel => {
            const card = this.createCollectionChannelCard(channel);
            collectionChannels.appendChild(card);
        });
    }

    createCollectionChannelCard(channel) {
        const card = document.createElement('div');
        card.className = 'channel-card';

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
        const addedDate = this.getTimeAgo(new Date(channel.added_at));

        // Create avatar HTML
        const avatarHtml = channel.avatar_url ? 
            `<img src="${channel.avatar_url}" alt="${this.escapeHtml(channel.channel_name)}" class="channel-avatar-img">` :
            `<div class="channel-avatar-letter">${avatarLetter}</div>`;

        card.innerHTML = `
            <div class="channel-header">
                <div class="channel-avatar">${avatarHtml}</div>
                <div class="channel-info">
                    <h3>${this.escapeHtml(channel.channel_name)}</h3>
                    <p>${this.escapeHtml(channel.video_title || 'No video title')}</p>
                    <small style="color: #9ca3af;">Added ${addedDate}</small>
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
                <button class="btn btn-reject" onclick="window.app.removeFromCollection('${this.currentCollection._id}', '${channel._id}')">
                    🗑️ Remove
                </button>
            </div>
        `;

        return card;
    }

    showCollectionsList() {
        this.renderCollections();
    }

    showCreateCollection() {
        if (!this.token) {
            this.showLogin();
            this.showToast('Please sign in to create collections 🔐');
            return;
        }

        document.getElementById('create-collection-overlay').style.display = 'flex';
        
        // Clear form fields safely
        const nameInput = document.getElementById('collection-name');
        const descInput = document.getElementById('collection-description');
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
    }

    closeCreateCollection() {
        document.getElementById('create-collection-overlay').style.display = 'none';
    }

    async handleCreateCollection() {
        const nameInput = document.getElementById('collection-name');
        const descInput = document.getElementById('collection-description');
        const submitBtn = document.querySelector('#create-collection-form button[type="submit"]');

        if (!nameInput || !descInput) {
            this.showToast('Form elements not found ❌');
            return;
        }

        const name = nameInput.value ? nameInput.value.trim() : '';
        const description = descInput.value ? descInput.value.trim() : '';

        if (!name) {
            this.showToast('Please enter a collection name ❌');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating...';

        try {
            const response = await fetch(`${this.apiBase}/collections`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ name, description })
            });

            const data = await response.json();

            if (response.ok) {
                this.closeCreateCollection();
                this.showToast(`Collection "${name}" created! 🎉`);
                await this.loadCollections();
            } else {
                this.showToast(data.error || 'Error creating collection ❌');
            }
        } catch (error) {
            console.error('Error creating collection:', error);
            this.showToast('Network error. Please try again ❌');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Collection';
        }
    }

    async removeFromCollection(collectionId, channelId) {
        if (!confirm('Remove this channel from the collection?')) {
            return;
        }

        try {
            const response = await fetch(`${this.apiBase}/collections/${collectionId}/channels/${channelId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                this.showToast('Channel removed from collection ✅');
                // Reload collection details
                await this.viewCollection(collectionId);
            } else {
                this.showToast('Error removing channel ❌');
            }
        } catch (error) {
            console.error('Error removing channel:', error);
            this.showToast('Error removing channel ❌');
        }
    }

    showCollectionsLoginPrompt() {
        const collectionsGrid = document.getElementById('collections-grid');
        collectionsGrid.innerHTML = `
            <div class="collection-empty">
                <div class="collection-empty-icon">🔐</div>
                <h3>Sign In Required</h3>
                <p>Please sign in to view and create your personal collections.</p>
                <button class="btn btn-primary" onclick="window.app.showLogin()" style="margin-top: 1rem;">Sign In</button>
            </div>
        `;
    }

    showCollectionsError() {
        const collectionsGrid = document.getElementById('collections-grid');
        collectionsGrid.innerHTML = `
            <div class="collection-empty">
                <div class="collection-empty-icon">❌</div>
                <h3>Error Loading Collections</h3>
                <p>Please try again later.</p>
                <button class="btn btn-primary" onclick="window.app.loadCollections()" style="margin-top: 1rem;">Retry</button>
            </div>
        `;
    }

    getTimeAgo(date) {
        const now = new Date();
        const diffInSeconds = Math.floor((now - date) / 1000);
        
        if (diffInSeconds < 60) return 'Just now';
        if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
        if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
        if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)}d ago`;
        return `${Math.floor(diffInSeconds / 2592000)}mo ago`;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    // Save to Collection functionality
    async showSaveToCollection(channelId) {
        if (!this.token) {
            this.showLogin();
            this.showToast('Please sign in to save channels 🔐');
            return;
        }

        // Load collections if not already loaded
        if (this.collections.length === 0) {
            await this.loadCollections();
        }

        if (this.collections.length === 0) {
            this.showToast('Create a collection first! 📚');
            this.showCreateCollection();
            return;
        }

        // Show collection selector modal
        this.showCollectionSelector(channelId);
    }

    showCollectionSelector(channelId) {
        // Create collection selector modal
        const overlay = document.createElement('div');
        overlay.className = 'auth-overlay';
        overlay.style.display = 'flex';
        overlay.id = 'collection-selector-overlay';

        overlay.innerHTML = `
            <div class="auth-modal">
                <div class="auth-form">
                    <h2>Save to Collection</h2>
                    <p class="auth-subtitle">Choose a collection for this channel</p>
                    
                    <div class="collection-selector">
                        ${this.collections.map(collection => `
                            <div class="collection-option" data-collection-id="${collection._id}">
                                <div class="collection-option-icon">📚</div>
                                <div class="collection-option-info">
                                    <h4>${this.escapeHtml(collection.name)}</h4>
                                    <p>${collection.channel_count || 0} channels</p>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                    
                    <div style="display: flex; gap: 1rem; margin-top: 1rem;">
                        <button class="auth-btn" onclick="this.closest('.auth-overlay').remove()" style="background: #6b7280;">Cancel</button>
                        <button class="auth-btn auth-btn-primary" id="save-to-collection-btn" disabled>Save to Collection</button>
                    </div>
                </div>
                <button class="auth-close" onclick="this.closest('.auth-overlay').remove()">×</button>
            </div>
        `;

        document.body.appendChild(overlay);

        // Add click handlers for collection options
        let selectedCollectionId = null;
        const saveBtn = overlay.querySelector('#save-to-collection-btn');

        overlay.querySelectorAll('.collection-option').forEach(option => {
            option.addEventListener('click', () => {
                // Remove previous selection
                overlay.querySelectorAll('.collection-option').forEach(opt => 
                    opt.classList.remove('selected')
                );
                
                // Select this option
                option.classList.add('selected');
                selectedCollectionId = option.dataset.collectionId;
                saveBtn.disabled = false;
            });
        });

        // Save button handler
        saveBtn.addEventListener('click', async () => {
            if (!selectedCollectionId) return;

            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';

            try {
                const response = await fetch(`${this.apiBase}/collections/${selectedCollectionId}/channels`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.token}`
                    },
                    body: JSON.stringify({ channel_id: channelId })
                });

                if (response.ok) {
                    overlay.remove();
                    this.showToast('Channel saved to collection! 📚✅');
                } else {
                    const data = await response.json();
                    this.showToast(data.error || 'Error saving channel ❌');
                }
            } catch (error) {
                console.error('Error saving to collection:', error);
                this.showToast('Error saving channel ❌');
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save to Collection';
            }
        });

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        });
    }
    // Social Methods
    async loadSocialData() {
        console.log('Loading social data...');
        
        // Check if user is Kevis (admin) to show management controls
        this.checkKevisAdmin();
        
        // Load social sections
        await Promise.all([
            this.loadKevisPicks(),
            this.loadTrendingChannels()
        ]);
    }

    checkKevisAdmin() {
        // Check if current user is Kevis
        const isKevis = this.user && (
            this.user.email === 'nwalikelv@gmail.com' || 
            this.user.email === 'kevis@viewhunt.com'
        );
        
        const adminControls = document.getElementById('kevis-admin-controls');
        if (adminControls) {
            adminControls.style.display = isKevis ? 'block' : 'none';
        }
    }

    async loadKevisPicks() {
        const content = document.getElementById('kevis-picks-content');
        content.innerHTML = '<div class="social-loading">Loading Kevis\'s picks...</div>';
        
        try {
            // Require authentication to see Kevis's Picks (engagement strategy!)
            if (!this.token) {
                content.innerHTML = '<div class="social-empty">Sign in to see Kevis\'s exclusive picks! 🔐✨</div>';
                return;
            }

            // Use the public endpoint but with better error handling
            const response = await fetch(`${this.apiBase}/kevis-picks`);
            
            if (!response.ok) {
                console.error('Kevis picks API error:', response.status);
                content.innerHTML = '<div class="social-empty">No picks yet! 🎯</div>';
                return;
            }

            const channels = await response.json();
            console.log('Kevis picks loaded:', channels.length, 'channels');
            
            if (!Array.isArray(channels) || channels.length === 0) {
                content.innerHTML = '<div class="social-empty">No picks yet! 🎯<br><small>Kevis is curating amazing channels...</small></div>';
                return;
            }
            
            // Show top 6 channels from Kevis's Picks
            const topChannels = channels.slice(0, 6);
            
            content.innerHTML = topChannels.map(channel => `
                <div class="social-channel-item">
                    <div class="social-channel-avatar">
                        ${channel.avatar_url ? 
                            `<img src="${channel.avatar_url}" alt="${this.escapeHtml(channel.channel_name)}">` :
                            `<div class="avatar-letter">${channel.channel_name.charAt(0).toUpperCase()}</div>`
                        }
                    </div>
                    <div class="social-channel-info">
                        <h4>${this.escapeHtml(channel.channel_name)}</h4>
                        <p>Ratio: ${channel.view_to_sub_ratio ? channel.view_to_sub_ratio.toFixed(2) : 'N/A'}</p>
                        <small>✨ Exclusive Kevis Pick</small>
                    </div>
                    <a href="${channel.channel_url}" target="_blank" class="social-channel-link">View</a>
                </div>
            `).join('');
            
        } catch (error) {
            console.error('Error loading Kevis picks:', error);
            content.innerHTML = '<div class="social-error">Error loading picks 😞</div>';
        }
    }

    async loadTrendingChannels() {
        const content = document.getElementById('trending-content');
        const lastUpdated = document.getElementById('trending-last-updated');
        content.innerHTML = '<div class="social-loading">Loading trending channels...</div>';
        
        try {
            // Get channels approved in the last 24 hours
            const response = await fetch(`${this.apiBase}/channels/trending`);
            let channels;
            
            if (response.ok) {
                channels = await response.json();
            } else {
                // Fallback to recent approved channels if trending endpoint doesn't exist yet
                const fallbackResponse = await fetch(`${this.apiBase}/channels/approved`);
                const allChannels = await fallbackResponse.json();
                
                // Filter channels approved in last 24 hours
                const yesterday = new Date();
                yesterday.setDate(yesterday.getDate() - 1);
                
                channels = allChannels
                    .filter(channel => new Date(channel.updated_at) > yesterday)
                    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
                    .slice(0, 8);
            }
            
            // Update last updated time
            if (lastUpdated) {
                lastUpdated.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
            }
            
            if (channels.length === 0) {
                content.innerHTML = '<div class="social-empty">No trending channels in the last 24 hours! 🔥</div>';
                return;
            }
            
            content.innerHTML = channels.map(channel => `
                <div class="social-channel-item">
                    <div class="social-channel-avatar">
                        ${channel.avatar_url ? 
                            `<img src="${channel.avatar_url}" alt="${this.escapeHtml(channel.channel_name)}">` :
                            `<div class="avatar-letter">${channel.channel_name.charAt(0).toUpperCase()}</div>`
                        }
                    </div>
                    <div class="social-channel-info">
                        <h4>${this.escapeHtml(channel.channel_name)}</h4>
                        <p>Ratio: ${channel.view_to_sub_ratio ? channel.view_to_sub_ratio.toFixed(2) : 'N/A'}</p>
                        <small>Approved ${this.getTimeAgo(new Date(channel.updated_at))}</small>
                    </div>
                    <a href="${channel.channel_url}" target="_blank" class="social-channel-link">View</a>
                </div>
            `).join('');
            
        } catch (error) {
            console.error('Error loading trending channels:', error);
            content.innerHTML = '<div class="social-error">Error loading trending 😞</div>';
        }
    }

    // Kevis Admin Methods
    showKevisManager() {
        if (!this.user || (this.user.email !== 'nwalikelv@gmail.com' && this.user.email !== 'kevis@viewhunt.com')) {
            this.showToast('Access denied - Admin only 🔐');
            return;
        }

        // Create Kevis manager modal
        const overlay = document.createElement('div');
        overlay.className = 'auth-overlay';
        overlay.style.display = 'flex';
        overlay.id = 'kevis-manager-overlay';

        overlay.innerHTML = `
            <div class="auth-modal kevis-manager-modal">
                <div class="auth-form">
                    <h2>⭐ Manage Kevis's Picks</h2>
                    <p class="auth-subtitle">Add or remove channels from your curated list</p>
                    
                    <div class="kevis-manager-content">
                        <div class="kevis-current-picks" id="kevis-current-picks">
                            <h3>Current Picks</h3>
                            <div class="social-loading">Loading current picks...</div>
                        </div>
                        
                        <div class="kevis-add-section">
                            <h3>Add New Pick</h3>
                            <p>Search from approved channels:</p>
                            <input type="text" id="kevis-search" placeholder="Search channel name..." class="filter-input">
                            <div class="kevis-search-results" id="kevis-search-results">
                                <div class="social-note">Type to search approved channels</div>
                            </div>
                        </div>
                    </div>
                    
                    <div style="display: flex; gap: 1rem; margin-top: 1rem;">
                        <button class="auth-btn" onclick="this.closest('.auth-overlay').remove()" style="background: #6b7280;">Close</button>
                    </div>
                </div>
                <button class="auth-close" onclick="this.closest('.auth-overlay').remove()">×</button>
            </div>
        `;

        document.body.appendChild(overlay);
        
        // Load current picks and setup search
        this.loadKevisManagerData();
        this.setupKevisSearch();
    }

    async loadKevisManagerData() {
        // This will load the current Kevis picks for management
        // For now, we'll use a simple approach - later we can add a dedicated API endpoint
        try {
            const response = await fetch(`${this.apiBase}/collections`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            
            if (response.ok) {
                const collections = await response.json();
                const kevisCollection = collections.find(c => c.name === "Kevis's Picks");
                
                if (kevisCollection) {
                    // Load channels in Kevis's collection
                    const channelsResponse = await fetch(`${this.apiBase}/collections/${kevisCollection._id}/channels`, {
                        headers: { 'Authorization': `Bearer ${this.token}` }
                    });
                    
                    if (channelsResponse.ok) {
                        const data = await channelsResponse.json();
                        this.renderKevisCurrentPicks(data.channels);
                    }
                } else {
                    // Create Kevis's Picks collection if it doesn't exist
                    await this.createKevisCollection();
                }
            }
        } catch (error) {
            console.error('Error loading Kevis manager data:', error);
        }
    }

    async createKevisCollection() {
        try {
            const response = await fetch(`${this.apiBase}/collections`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({
                    name: "Kevis's Picks",
                    description: "Personally curated channels by Kevis"
                })
            });
            
            if (response.ok) {
                console.log("Kevis's Picks collection created");
                document.getElementById('kevis-current-picks').innerHTML = `
                    <h3>Current Picks</h3>
                    <div class="social-empty">No picks yet - start adding channels! ⭐</div>
                `;
            }
        } catch (error) {
            console.error('Error creating Kevis collection:', error);
        }
    }

    renderKevisCurrentPicks(channels) {
        const container = document.getElementById('kevis-current-picks');
        if (!container) return;
        
        if (channels.length === 0) {
            container.innerHTML = `
                <h3>Current Picks</h3>
                <div class="social-empty">No picks yet - start adding channels! ⭐</div>
            `;
            return;
        }
        
        container.innerHTML = `
            <h3>Current Picks (${channels.length})</h3>
            ${channels.map(channel => `
                <div class="kevis-pick-item">
                    <div class="social-channel-avatar">
                        ${channel.avatar_url ? 
                            `<img src="${channel.avatar_url}" alt="${this.escapeHtml(channel.channel_name)}">` :
                            `<div class="avatar-letter">${channel.channel_name.charAt(0).toUpperCase()}</div>`
                        }
                    </div>
                    <div class="social-channel-info">
                        <h4>${this.escapeHtml(channel.channel_name)}</h4>
                        <p>Ratio: ${channel.view_to_sub_ratio ? channel.view_to_sub_ratio.toFixed(2) : 'N/A'}</p>
                    </div>
                    <button class="btn btn-small btn-danger" onclick="window.app.removeFromKevisPicks('${channel._id}')">Remove</button>
                </div>
            `).join('')}
        `;
    }

    setupKevisSearch() {
        const searchInput = document.getElementById('kevis-search');
        if (!searchInput) return;
        
        searchInput.addEventListener('input', this.debounce(async (e) => {
            const query = e.target.value.trim();
            if (query.length < 2) {
                document.getElementById('kevis-search-results').innerHTML = 
                    '<div class="social-note">Type to search approved channels</div>';
                return;
            }
            
            await this.searchApprovedChannels(query);
        }, 300));
    }

    async searchApprovedChannels(query) {
        const resultsContainer = document.getElementById('kevis-search-results');
        resultsContainer.innerHTML = '<div class="social-loading">Searching...</div>';
        
        try {
            const response = await fetch(`${this.apiBase}/channels/approved`);
            const channels = await response.json();
            
            const filtered = channels.filter(channel => 
                channel.channel_name.toLowerCase().includes(query.toLowerCase())
            ).slice(0, 5);
            
            if (filtered.length === 0) {
                resultsContainer.innerHTML = '<div class="social-empty">No channels found</div>';
                return;
            }
            
            resultsContainer.innerHTML = filtered.map(channel => `
                <div class="kevis-search-item">
                    <div class="social-channel-avatar">
                        ${channel.avatar_url ? 
                            `<img src="${channel.avatar_url}" alt="${this.escapeHtml(channel.channel_name)}">` :
                            `<div class="avatar-letter">${channel.channel_name.charAt(0).toUpperCase()}</div>`
                        }
                    </div>
                    <div class="social-channel-info">
                        <h4>${this.escapeHtml(channel.channel_name)}</h4>
                        <p>Ratio: ${channel.view_to_sub_ratio ? channel.view_to_sub_ratio.toFixed(2) : 'N/A'}</p>
                    </div>
                    <button class="btn btn-small btn-primary" onclick="window.app.addToKevisPicks('${channel._id}')">Add</button>
                </div>
            `).join('');
            
        } catch (error) {
            console.error('Error searching channels:', error);
            resultsContainer.innerHTML = '<div class="social-error">Search error</div>';
        }
    }

    async addToKevisPicks(channelId) {
        // Implementation for adding to Kevis's picks collection
        this.showToast('Adding to Kevis\'s Picks... ⭐');
        // This would use the existing collection system
    }

    async removeFromKevisPicks(channelId) {
        if (!this.user || (this.user.email !== 'nwalikelv@gmail.com' && this.user.email !== 'kevis@viewhunt.com')) {
            this.showToast('Access denied - Admin only 🔐');
            return;
        }

        try {
            this.showToast('Removing from Kevis\'s Picks... 🗑️');

            // First, find the Kevis's Picks collection
            const response = await fetch(`${this.apiBase}/collections`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (!response.ok) {
                this.showToast('Error accessing collections ❌');
                return;
            }

            const collections = await response.json();
            const kevisCollection = collections.find(c => c.name === "Kevis's Picks");

            if (!kevisCollection) {
                this.showToast('Kevis\'s Picks collection not found ❌');
                return;
            }

            // Remove the channel from the collection
            const removeResponse = await fetch(`${this.apiBase}/collections/${kevisCollection._id}/channels/${channelId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (removeResponse.ok) {
                this.showToast('Removed from Kevis\'s Picks! 🗑️✅');
                
                // Reload the Kevis manager data and social data
                await this.loadKevisManagerData();
                await this.loadKevisPicks();
            } else {
                const errorData = await removeResponse.json();
                this.showToast(errorData.error || 'Error removing channel ❌');
            }

        } catch (error) {
            console.error('Error removing from Kevis picks:', error);
            this.showToast('Error removing channel ❌');
        }
    }

    formatNumber(num) {
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toString();
    }

    // Collection Sharing Methods
    async shareCollection(collectionId, collectionName) {
        const shareUrl = `${window.location.origin}/shared/${collectionId}`;
        
        try {
            // Copy to clipboard
            await navigator.clipboard.writeText(shareUrl);
            this.showToast(`Collection link copied! 🔗✅`);
        } catch (error) {
            // Fallback for older browsers
            this.showShareModal(shareUrl, collectionName);
        }
    }

    showShareModal(shareUrl, collectionName) {
        const overlay = document.createElement('div');
        overlay.className = 'auth-overlay';
        overlay.style.display = 'flex';
        overlay.id = 'share-modal-overlay';

        overlay.innerHTML = `
            <div class="auth-modal">
                <div class="auth-form">
                    <h2>🔗 Share Collection</h2>
                    <p class="auth-subtitle">Share "${this.escapeHtml(collectionName)}" with others</p>
                    
                    <div class="share-url-container">
                        <input type="text" id="share-url-input" value="${shareUrl}" readonly class="filter-input">
                        <button class="btn btn-primary" onclick="window.app.copyShareUrl()">Copy Link</button>
                    </div>
                    
                    <div class="share-info">
                        <p>📱 Anyone with this link can view your collection</p>
                        <p>🔓 No account required to view</p>
                    </div>
                    
                    <div style="display: flex; gap: 1rem; margin-top: 1rem;">
                        <button class="auth-btn" onclick="this.closest('.auth-overlay').remove()" style="background: #6b7280;">Close</button>
                    </div>
                </div>
                <button class="auth-close" onclick="this.closest('.auth-overlay').remove()">×</button>
            </div>
        `;

        document.body.appendChild(overlay);

        // Auto-select the URL for easy copying
        const urlInput = document.getElementById('share-url-input');
        urlInput.select();
        urlInput.focus();
    }

    copyShareUrl() {
        const urlInput = document.getElementById('share-url-input');
        urlInput.select();
        document.execCommand('copy');
        this.showToast('Link copied to clipboard! 🔗✅');
        
        // Close the modal
        document.getElementById('share-modal-overlay').remove();
    }
}

    // Pagination Methods
    async loadNextPage() {
        if (this.isLoadingPage || !this.pagination || !this.pagination.hasNext) {
            return;
        }

        await this.loadPage(this.currentPage + 1);
    }

    async loadPreviousPage() {
        if (this.isLoadingPage || !this.pagination || !this.pagination.hasPrev) {
            return;
        }

        await this.loadPage(this.currentPage - 1);
    }

    async loadPage(pageNumber) {
        if (this.isLoadingPage) return;

        this.isLoadingPage = true;
        this.currentPage = pageNumber;

        // Show loading state
        const channelGrid = document.getElementById('channel-grid');
        const paginationControls = document.getElementById('pagination-controls');
        const nextBtn = document.getElementById('next-page-btn');
        const prevBtn = document.getElementById('prev-page-btn');

        channelGrid.classList.add('loading');
        nextBtn.disabled = true;
        prevBtn.disabled = true;
        nextBtn.innerHTML = '<div class="pagination-loading"><div class="spinner"></div>Loading...</div>';

        try {
            const endpoint = this.currentView === 'pending' ? '/channels/pending' : '/channels/approved';
            const url = this.currentView === 'pending' ? 
                `${this.apiBase}${endpoint}?page=${pageNumber}&limit=20` : 
                `${this.apiBase}${endpoint}`;

            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();

            // Handle paginated response for pending channels
            if (this.currentView === 'pending' && data.channels) {
                this.channels = data.channels;
                this.pagination = data.pagination;
                console.log(`Loaded page ${pageNumber}: ${this.channels.length} channels`);
            } else {
                // Handle direct array response for approved channels
                this.channels = Array.isArray(data) ? data : [];
            }

            // Smooth page transition
            channelGrid.style.opacity = '0';
            setTimeout(() => {
                this.renderChannels();
                this.updatePaginationControls();
                channelGrid.style.opacity = '1';
                channelGrid.classList.remove('loading');
            }, 200);

        } catch (error) {
            console.error('Error loading page:', error);
            this.showToast('Error loading channels ❌');
            channelGrid.classList.remove('loading');
        } finally {
            this.isLoadingPage = false;
            nextBtn.innerHTML = 'Next →';
        }
    }

    updatePaginationControls() {
        const paginationControls = document.getElementById('pagination-controls');
        const paginationText = document.getElementById('pagination-text');
        const channelsCount = document.getElementById('channels-count');
        const nextBtn = document.getElementById('next-page-btn');
        const prevBtn = document.getElementById('prev-page-btn');

        // Only show pagination for pending channels (which have pagination data)
        if (this.currentView === 'pending' && this.pagination) {
            paginationControls.style.display = 'flex';
            
            // Update pagination info
            paginationText.textContent = `Page ${this.pagination.page} of ${this.pagination.pages}`;
            channelsCount.textContent = `${this.channels.length} of ${this.pagination.total} channels`;
            
            // Update button states
            prevBtn.disabled = !this.pagination.hasPrev || this.isLoadingPage;
            nextBtn.disabled = !this.pagination.hasNext || this.isLoadingPage;
            
            // Add visual feedback for button states
            if (this.pagination.hasNext) {
                nextBtn.classList.remove('btn-secondary');
                nextBtn.classList.add('btn-primary');
            } else {
                nextBtn.classList.remove('btn-primary');
                nextBtn.classList.add('btn-secondary');
            }
        } else {
            paginationControls.style.display = 'none';
        }
    }

    // Update the existing loadChannels method to include pagination controls
    async loadChannels() {
        const loading = document.getElementById('loading');
        const emptyState = document.getElementById('empty-state');
        const channelGrid = document.getElementById('channel-grid');

        // Reset pagination state when switching views
        this.currentPage = 1;
        this.pagination = null;

        loading.style.display = 'flex';
        emptyState.style.display = 'none';
        channelGrid.innerHTML = '';

        try {
            const endpoint = this.currentView === 'pending' ? '/channels/pending' : '/channels/approved';
            
            // Both endpoints now require authentication
            if (!this.token) {
                this.channels = [];
                loading.style.display = 'none';
                emptyState.style.display = 'block';
                emptyState.querySelector('h2').textContent = 'Sign In Required';
                emptyState.querySelector('p').textContent = 'Please sign in to view channels.';
                this.updatePaginationControls();
                return;
            }
            
            // Add pagination parameters for pending channels
            const url = this.currentView === 'pending' ? 
                `${this.apiBase}${endpoint}?page=1&limit=20` : 
                `${this.apiBase}${endpoint}`;
            
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });
            
            if (!response.ok) {
                if (response.status === 401) {
                    // Token expired or invalid
                    localStorage.removeItem('viewhunt_token');
                    this.token = null;
                    this.updateUIForLoggedOutUser();
                    this.channels = [];
                    loading.style.display = 'none';
                    emptyState.style.display = 'block';
                    emptyState.querySelector('h2').textContent = 'Sign In Required';
                    emptyState.querySelector('p').textContent = 'Please sign in to view channels.';
                    this.updatePaginationControls();
                    return;
                }
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            // Handle paginated response for pending channels
            if (this.currentView === 'pending' && data.channels) {
                this.channels = data.channels;
                this.pagination = data.pagination;
                console.log(`Loaded ${this.channels.length} channels (Page ${data.pagination.page}/${data.pagination.pages})`);
            } else {
                // Handle direct array response for approved channels
                this.channels = Array.isArray(data) ? data : [];
            }

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

            // Update pagination controls
            this.updatePaginationControls();

        } catch (error) {
            console.error('Error loading channels:', error);
            loading.style.display = 'none';
            emptyState.style.display = 'block';
            this.updatePaginationControls();
        }
    }}

// Ini
tialize app
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new ViewHuntApp();
    window.app = app; // Make it globally available
});