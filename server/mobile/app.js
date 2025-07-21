class ViewHuntApp {
    constructor() {
        // Auto-detect API base URL for production vs development
        this.apiBase = this.getApiBase();
        this.currentView = 'pending';
        this.channels = [];
        this.currentBatch = [];
        this.pagination = null;
        this.currentPage = 1;
        this.isLoadingBatch = false;
        this.authToken = localStorage.getItem('viewhunt_token');
        this.token = this.authToken; // Alias for compatibility
        this.user = null;
        this.subscriptionStatus = null;
        this.isDarkMode = localStorage.getItem('viewhunt_theme') === 'dark';
        
        this.init();
    }

    async init() {
        this.initTheme();
        this.setupEventListeners();
        await this.checkAuthStatus();
        await this.checkSubscriptionStatus();
        await this.loadStats();
        await this.loadChannels();
    }

    // Dark Mode Methods
    initTheme() {
        // Apply saved theme or default to light
        if (this.isDarkMode) {
            document.documentElement.setAttribute('data-theme', 'dark');
            this.updateThemeIcon('☀️');
        } else {
            document.documentElement.setAttribute('data-theme', 'light');
            this.updateThemeIcon('🌙');
        }
    }

    toggleTheme() {
        this.isDarkMode = !this.isDarkMode;
        
        if (this.isDarkMode) {
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem('viewhunt_theme', 'dark');
            this.updateThemeIcon('☀️');
            this.showToast('Dark mode enabled 🌙');
        } else {
            document.documentElement.setAttribute('data-theme', 'light');
            localStorage.setItem('viewhunt_theme', 'light');
            this.updateThemeIcon('🌙');
            this.showToast('Light mode enabled ☀️');
        }
    }

    updateThemeIcon(icon) {
        const themeIcon = document.querySelector('.theme-icon');
        if (themeIcon) {
            themeIcon.textContent = icon;
        }
    }

    setupEventListeners() {
        // Navigation
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const view = e.currentTarget.dataset.view;
                this.switchView(view);
            });
        });

        // Filters - now trigger full database sorting for pending view
        document.getElementById('primary-sort').addEventListener('change', () => {
            if (this.currentView === 'pending') {
                this.loadPendingChannels(1); // Reset to page 1 when filters change
            } else if (this.currentView === 'approved') {
                this.loadApprovedChannels(); // Reload with new filters
            } else {
                this.applyFilters();
            }
        });

        document.getElementById('secondary-sort').addEventListener('change', () => {
            if (this.currentView === 'pending') {
                this.loadPendingChannels(1); // Reset to page 1 when filters change
            } else if (this.currentView === 'approved') {
                this.loadApprovedChannels(); // Reload with new filters
            } else {
                this.applyFilters();
            }
        });

        // Apply Filters button
        document.getElementById('apply-filters-btn').addEventListener('click', () => {
            if (this.currentView === 'pending') {
                this.loadPendingChannels(1);
            } else if (this.currentView === 'approved') {
                this.loadApprovedChannels(); // Reload with new filters
            } else {
                this.applyFilters();
            }
        });

        // Page select dropdown functionality
        document.getElementById('page-select').addEventListener('change', (e) => {
            const page = parseInt(e.target.value);
            if (page && page >= 1 && this.pagination && page <= this.pagination.totalPages) {
                this.loadPendingChannels(page);
            }
        });

        // Initialize range sliders (without real-time filtering)
        this.initializeRangeSliders();

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

    initializeRangeSliders() {
        // Helper function to format numbers for display - shared by all sliders
        const formatNumber = (num) => {
            if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
            if (num >= 1000) return (num / 1000).toFixed(0) + 'K';
            return num.toString();
        };

        // Views range slider
        const viewsSliderMin = document.getElementById('views-slider-min');
        const viewsSliderMax = document.getElementById('views-slider-max');
        const minViewsInput = document.getElementById('min-views');
        const maxViewsInput = document.getElementById('max-views');

        if (viewsSliderMin && viewsSliderMax && minViewsInput && maxViewsInput) {
            // Update input when slider changes (no real-time filtering)
            viewsSliderMin.addEventListener('input', () => {
                const value = parseInt(viewsSliderMin.value);
                const formattedValue = formatNumber(value);
                console.log('Views min slider changed:', value, 'formatted:', formattedValue);
                minViewsInput.value = formattedValue;
                
                // Ensure min doesn't exceed max
                if (value > parseInt(viewsSliderMax.value)) {
                    viewsSliderMax.value = value;
                    maxViewsInput.value = formatNumber(value);
                }
            });

            viewsSliderMax.addEventListener('input', () => {
                const value = parseInt(viewsSliderMax.value);
                const formattedValue = formatNumber(value);
                console.log('Views max slider changed:', value, 'formatted:', formattedValue);
                maxViewsInput.value = formattedValue;
                
                // Ensure max doesn't go below min
                if (value < parseInt(viewsSliderMin.value)) {
                    viewsSliderMin.value = value;
                    minViewsInput.value = formatNumber(value);
                }
            });

            // Update slider when input changes
            minViewsInput.addEventListener('input', () => {
                const value = this.parseFormattedNumber(minViewsInput.value);
                if (value >= 0 && value <= 10000000) {
                    viewsSliderMin.value = value;
                }
            });

            maxViewsInput.addEventListener('input', () => {
                const value = this.parseFormattedNumber(maxViewsInput.value);
                if (value >= 0 && value <= 10000000) {
                    viewsSliderMax.value = value;
                }
            });
        }

        // Subs range slider
        const subsSliderMin = document.getElementById('subs-slider-min');
        const subsSliderMax = document.getElementById('subs-slider-max');
        const minSubsInput = document.getElementById('min-subs');
        const maxSubsInput = document.getElementById('max-subs');

        if (subsSliderMin && subsSliderMax && minSubsInput && maxSubsInput) {
            // Update input when slider changes (no real-time filtering)
            subsSliderMin.addEventListener('input', () => {
                const value = parseInt(subsSliderMin.value);
                const formattedValue = formatNumber(value);
                console.log('Subs min slider changed:', value, 'formatted:', formattedValue);
                minSubsInput.value = formattedValue;
                
                // Ensure min doesn't exceed max
                if (value > parseInt(subsSliderMax.value)) {
                    subsSliderMax.value = value;
                    maxSubsInput.value = formatNumber(value);
                }
            });

            subsSliderMax.addEventListener('input', () => {
                const value = parseInt(subsSliderMax.value);
                const formattedValue = formatNumber(value);
                console.log('Subs max slider changed:', value, 'formatted:', formattedValue);
                maxSubsInput.value = formattedValue;
                
                // Ensure max doesn't go below min
                if (value < parseInt(subsSliderMin.value)) {
                    subsSliderMin.value = value;
                    minSubsInput.value = formatNumber(value);
                }
            });

            // Update slider when input changes
            minSubsInput.addEventListener('input', () => {
                const value = this.parseFormattedNumber(minSubsInput.value);
                if (value >= 0 && value <= 5000000) {
                    subsSliderMin.value = value;
                }
            });

            maxSubsInput.addEventListener('input', () => {
                const value = this.parseFormattedNumber(maxSubsInput.value);
                if (value >= 0 && value <= 5000000) {
                    subsSliderMax.value = value;
                }
            });
        }

        // Videos range slider
        const videosSliderMin = document.getElementById('videos-slider-min');
        const videosSliderMax = document.getElementById('videos-slider-max');
        const minVideosInput = document.getElementById('min-videos');
        const maxVideosInput = document.getElementById('max-videos');

        if (videosSliderMin && videosSliderMax && minVideosInput && maxVideosInput) {
            // Update input when slider changes (no real-time filtering)
            videosSliderMin.addEventListener('input', () => {
                const value = parseInt(videosSliderMin.value);
                minVideosInput.value = value;
                
                // Ensure min doesn't exceed max
                if (value > parseInt(videosSliderMax.value)) {
                    videosSliderMax.value = value;
                    maxVideosInput.value = value;
                }
            });

            videosSliderMax.addEventListener('input', () => {
                const value = parseInt(videosSliderMax.value);
                maxVideosInput.value = value;
                
                // Ensure max doesn't go below min
                if (value < parseInt(videosSliderMin.value)) {
                    videosSliderMin.value = value;
                    minVideosInput.value = value;
                }
            });

            // Update slider when input changes
            minVideosInput.addEventListener('input', () => {
                const value = parseInt(minVideosInput.value) || 0;
                if (value >= 0 && value <= 1000) {
                    videosSliderMin.value = value;
                }
            });

            maxVideosInput.addEventListener('input', () => {
                const value = parseInt(maxVideosInput.value) || 1000;
                if (value >= 0 && value <= 1000) {
                    videosSliderMax.value = value;
                }
            });
        }
    }



    // Helper function to parse formatted numbers (e.g., "1.5M" -> 1500000)
    parseFormattedNumber(str) {
        if (!str) return 0;
        const cleanStr = str.toString().toLowerCase().replace(/,/g, '');
        const num = parseFloat(cleanStr);
        if (isNaN(num)) return 0;
        
        if (cleanStr.includes('m')) return Math.round(num * 1000000);
        if (cleanStr.includes('k')) return Math.round(num * 1000);
        return Math.round(num);
    }

    // Fisher-Yates shuffle algorithm for randomizing channels
    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    applyFilters() {
        if (!this.channels || this.channels.length === 0) return;

        const primarySort = document.getElementById('primary-sort').value;

        // For approved channels, just sort them (no filtering for now)
        let filteredChannels = [...this.channels];

        // Simple sorting for approved channels
        filteredChannels.sort((a, b) => {
            switch (primarySort) {
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
                case 'videos-desc':
                    return (b.video_count || 0) - (a.video_count || 0);
                case 'videos-asc':
                    return (a.video_count || 0) - (b.video_count || 0);
                case 'newest':
                    return new Date(b.created_at || 0) - new Date(a.created_at || 0);
                case 'oldest':
                    return new Date(a.created_at || 0) - new Date(b.created_at || 0);
                case 'approval-time-desc':
                    return new Date(b.first_approval_time || b.approved_at || 0) - new Date(a.first_approval_time || a.approved_at || 0);
                case 'approval-time-asc':
                    return new Date(a.first_approval_time || a.approved_at || 0) - new Date(b.first_approval_time || b.approved_at || 0);
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
            if (!this.authToken) {
                // If not authenticated, show default stats
                document.getElementById('pending-count').textContent = '0';
                document.getElementById('approved-count').textContent = '0';
                return;
            }

            const response = await this.fetchWithAuth(`${this.apiBase}/stats`);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const stats = await response.json();
            
            document.getElementById('pending-count').textContent = stats.pending || 0;
            document.getElementById('approved-count').textContent = stats.approved || 0;
        } catch (error) {
            console.error('Error loading stats:', error);
            // Show default values on error
            document.getElementById('pending-count').textContent = '0';
            document.getElementById('approved-count').textContent = '0';
        }
    }

    async loadChannels() {
        if (this.currentView === 'pending') {
            // Use optimized full database sorting for pending channels
            await this.loadPendingChannels(1);
        } else {
            // Use traditional loading for approved channels
            await this.loadApprovedChannels();
        }
    }

    async loadPendingChannels(page = 1) {
        if (this.isLoadingBatch) return;
        
        this.isLoadingBatch = true;
        this.currentPage = page;
        
        const loading = document.getElementById('loading');
        const emptyState = document.getElementById('empty-state');
        const channelGrid = document.getElementById('channel-grid');

        loading.style.display = 'flex';
        emptyState.style.display = 'none';
        channelGrid.innerHTML = '';

        try {
            // Check authentication
            if (!this.authToken) {
                this.currentBatch = [];
                this.pagination = null;
                loading.style.display = 'none';
                emptyState.style.display = 'block';
                emptyState.querySelector('h2').textContent = 'Sign In Required';
                emptyState.querySelector('p').textContent = 'Please sign in to view channels.';
                return;
            }

            // Get current filter values
            const primarySort = document.getElementById('primary-sort').value;
            const secondarySort = document.getElementById('secondary-sort').value;
            const minViews = parseInt(document.getElementById('min-views').value.replace(/,/g, '')) || 0;
            const maxViews = document.getElementById('max-views').value ? parseInt(document.getElementById('max-views').value.replace(/,/g, '')) : null;
            const minSubs = parseInt(document.getElementById('min-subs').value.replace(/,/g, '')) || 0;
            const maxSubs = document.getElementById('max-subs').value ? parseInt(document.getElementById('max-subs').value.replace(/,/g, '')) : null;
            const minVideos = parseInt(document.getElementById('min-videos').value.replace(/,/g, '')) || 0;
            const maxVideos = document.getElementById('max-videos').value ? parseInt(document.getElementById('max-videos').value.replace(/,/g, '')) : null;

            // Build query parameters
            const params = new URLSearchParams({
                page: page.toString(),
                limit: '50',
                primarySort: primarySort,
                secondarySort: secondarySort
            });
            
            // Add filter parameters if they have values
            if (minViews > 0) params.append('minViews', minViews.toString());
            if (maxViews) params.append('maxViews', maxViews.toString());
            if (minSubs > 0) params.append('minSubs', minSubs.toString());
            if (maxSubs) params.append('maxSubs', maxSubs.toString());
            if (minVideos > 0) params.append('minVideos', minVideos.toString());
            if (maxVideos) params.append('maxVideos', maxVideos.toString());

            const response = await this.fetchWithAuth(`${this.apiBase}/channels/pending?${params}`);
            
            if (!response.ok) {
                if (response.status === 401) {
                    localStorage.removeItem('viewhunt_token');
                    this.authToken = null;
                    this.updateUIForLoggedOutUser();
                    throw new Error('Authentication required');
                }
                if (response.status === 403) {
                    // Handle subscription required error
                    const errorData = await response.json().catch(() => ({}));
                    if (errorData.error && errorData.error.includes('subscription')) {
                        this.showSubscriptionGate();
                        return;
                    }
                }
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();

            this.currentBatch = data.channels || [];
            this.pagination = data.pagination || null;
            
            loading.style.display = 'none';

            if (this.currentBatch.length === 0) {
                emptyState.style.display = 'block';
                emptyState.querySelector('h2').textContent = 'No Channels Match Your Filters';
                emptyState.querySelector('p').textContent = 'Try adjusting your filter criteria to see more results.';
            } else {
                this.renderPaginatedChannels();
            }

            // Update pagination controls
            this.updatePaginationControls();

        } catch (error) {
            console.error('Error loading channels:', error);
            loading.style.display = 'none';
            emptyState.style.display = 'block';
            emptyState.querySelector('h2').textContent = 'Error Loading Channels';
            emptyState.querySelector('p').textContent = 'Please try again or check your connection.';
        } finally {
            this.isLoadingBatch = false;
        }
    }

    // Alias for backward compatibility
    async loadNewBatch() {
        await this.loadPendingChannels(1);
    }

    async loadApprovedChannels() {
        const loading = document.getElementById('loading');
        const emptyState = document.getElementById('empty-state');
        const channelGrid = document.getElementById('channel-grid');

        loading.style.display = 'flex';
        emptyState.style.display = 'none';
        channelGrid.innerHTML = '';

        try {
            if (!this.authToken) {
                this.channels = [];
                loading.style.display = 'none';
                emptyState.style.display = 'block';
                emptyState.querySelector('h2').textContent = 'Sign In Required';
                emptyState.querySelector('p').textContent = 'Please sign in to view approved channels.';
                return;
            }

            // Build query parameters for admin filtering
            let url = `${this.apiBase}/channels/approved`;
            if (this.user && (this.user.email === 'nwalikelv@gmail.com' || this.user.email === 'kevis@viewhunt.com')) {
                const params = new URLSearchParams();
                
                // Get filter values
                const primarySort = document.getElementById('primary-sort')?.value || 'approval-time-desc';
                const minViews = this.parseFormattedNumber(document.getElementById('min-views')?.value || '0');
                const maxViews = document.getElementById('max-views')?.value ? this.parseFormattedNumber(document.getElementById('max-views').value) : null;
                const minSubs = this.parseFormattedNumber(document.getElementById('min-subs')?.value || '0');
                const maxSubs = document.getElementById('max-subs')?.value ? this.parseFormattedNumber(document.getElementById('max-subs').value) : null;
                const minVideos = parseInt(document.getElementById('min-videos')?.value || '0');
                const maxVideos = document.getElementById('max-videos')?.value ? parseInt(document.getElementById('max-videos').value) : null;

                params.append('sortBy', primarySort);
                if (minViews > 0) params.append('minViews', minViews.toString());
                if (maxViews) params.append('maxViews', maxViews.toString());
                if (minSubs > 0) params.append('minSubs', minSubs.toString());
                if (maxSubs) params.append('maxSubs', maxSubs.toString());
                if (minVideos > 0) params.append('minVideos', minVideos.toString());
                if (maxVideos) params.append('maxVideos', maxVideos.toString());

                url += `?${params}`;
            }

            const response = await this.fetchWithAuth(url);
            
            if (!response.ok) {
                if (response.status === 401) {
                    localStorage.removeItem('viewhunt_token');
                    this.authToken = null;
                    this.updateUIForLoggedOutUser();
                    throw new Error('Authentication required');
                }
                if (response.status === 403) {
                    // Handle subscription required error
                    const errorData = await response.json().catch(() => ({}));
                    if (errorData.error && errorData.error.includes('subscription')) {
                        this.showSubscriptionGate();
                        return;
                    }
                }
                throw new Error(`HTTP ${response.status}`);
            }

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

    renderPaginatedChannels() {
        const channelGrid = document.getElementById('channel-grid');
        const emptyState = document.getElementById('empty-state');

        channelGrid.innerHTML = '';
        emptyState.style.display = 'none';

        this.currentBatch.forEach(channel => {
            const card = this.createChannelCard(channel);
            channelGrid.appendChild(card);
        });
    }

    updatePaginationControls() {
        const paginationControls = document.getElementById('pagination-controls');
        const paginationText = document.getElementById('pagination-text');
        const pageSelect = document.getElementById('page-select');
        const totalPagesSpan = document.getElementById('total-pages');
        
        if (!this.pagination) {
            paginationControls.style.display = 'none';
            return;
        }

        paginationControls.style.display = 'flex';
        
        // Update pagination text
        if (this.pagination.isRandom) {
            paginationText.textContent = `${this.pagination.totalChannels.toLocaleString()} channels (randomized)`;
        } else {
            const start = ((this.pagination.currentPage - 1) * this.pagination.limit) + 1;
            const end = Math.min(this.pagination.currentPage * this.pagination.limit, this.pagination.totalChannels);
            paginationText.textContent = `${start}-${end} of ${this.pagination.totalChannels.toLocaleString()} channels`;
        }
        
        // Populate page select dropdown
        if (pageSelect && totalPagesSpan) {
            totalPagesSpan.textContent = this.pagination.totalPages;
            
            // Clear existing options
            pageSelect.innerHTML = '';
            
            // Add options for each page
            for (let i = 1; i <= this.pagination.totalPages; i++) {
                const option = document.createElement('option');
                option.value = i;
                option.textContent = i;
                if (i === this.pagination.currentPage) {
                    option.selected = true;
                }
                pageSelect.appendChild(option);
            }
        }
        
        // Update button states
        const prevBtn = document.getElementById('prev-page');
        const nextBtn = document.getElementById('next-page');
        
        if (prevBtn) {
            prevBtn.disabled = !this.pagination.hasPrev;
            prevBtn.onclick = () => this.loadPendingChannels(this.pagination.currentPage - 1);
        }
        
        if (nextBtn) {
            nextBtn.disabled = !this.pagination.hasNext;
            nextBtn.onclick = () => this.loadPendingChannels(this.pagination.currentPage + 1);
        }
    }

    updateBatchInfo(batchInfo) {
        // This method is now replaced by updatePaginationControls
        // Keeping for backward compatibility but it's no longer used
    }

    // Get a random batch of channels from the full sorted list
    getRandomBatch() {
        if (!this.allChannels || this.allChannels.length === 0) {
            this.channels = [];
            return;
        }

        // Create a copy of all channels to avoid modifying the original
        const availableChannels = [...this.allChannels];
        
        // Shuffle the available channels
        this.shuffleArray(availableChannels);
        
        // Take the first batchSize channels from the shuffled array
        this.channels = availableChannels.slice(0, this.batchSize);
        
        console.log(`Generated random batch: ${this.channels.length} channels from ${this.allChannels.length} total`);
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

        // Use average views instead of single video views for better niche analysis
        const averageViews = formatNumber(channel.average_views || channel.view_count || 0);
        const videoCount = channel.video_count || 0;
        
        // Debug: log video count to see what's happening
        if (channel.video_count === undefined) {
            console.log(`Channel ${channel.channel_name} has no video_count field`);
        }
        const subCount = formatNumber(channel.subscriber_count || 0);
        const ratio = channel.view_to_sub_ratio ? channel.view_to_sub_ratio.toFixed(2) : 'N/A';

        // Create approval info for approved channels
        let approvalInfo = '';
        let communityBadge = '';
        
        if (this.currentView === 'approved') {
            // Show approval timestamp
            const approvalTime = channel.first_approval_time || channel.approved_at || channel.updated_at;
            if (approvalTime) {
                approvalInfo = `<small class="approval-time">Approved ${this.getTimeAgo(new Date(approvalTime))}</small>`;
            }
            
            // Show community badge if not approved by admin
            if (channel.admin_approved === false) {
                communityBadge = '<span class="community-badge">👥 Community</span>';
            }
            
            // Show approval count if available
            if (channel.approval_count && channel.approval_count > 1) {
                approvalInfo += `<small class="approval-count">${channel.approval_count} approvals</small>`;
            }
        }

        // Create avatar HTML - use real avatar if available, fallback to letter
        const avatarHtml = channel.avatar_url ? 
            `<img src="${channel.avatar_url}" alt="${this.escapeHtml(channel.channel_name)}" class="channel-avatar-img">` :
            `<div class="channel-avatar-letter">${avatarLetter}</div>`;

        card.innerHTML = `
            <div class="channel-header">
                <div class="channel-avatar">${avatarHtml}</div>
                <div class="channel-info">
                    <h3>${this.escapeHtml(channel.channel_name)} ${communityBadge}</h3>
                    <p>${this.escapeHtml(channel.video_title || 'No video title')}</p>
                    <small class="video-count">${videoCount > 0 ? videoCount.toLocaleString() : 'N/A'} videos</small>
                    ${approvalInfo}
                </div>
            </div>
            
            <div class="channel-stats">
                <div class="stat-item">
                    <span class="stat-value">${averageViews}</span>
                    <span class="stat-label">Avg Views</span>
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
                <a href="${channel.channel_url}/shorts" target="_blank" class="btn btn-primary">
                    🔗 View Shorts
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
        if (!this.authToken) {
            this.showLogin();
            this.showToast('Please sign in to approve channels 🔐');
            return;
        }

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

                // Remove channel from current batch to prevent it from reappearing
                this.currentBatch = this.currentBatch.filter(channel => channel._id !== channelId);

                // Update stats
                await this.loadStats();
                await this.checkAuthStatus(); // Update user stats

                // Show success feedback
                this.showToast('Channel approved! ✅');
            } else if (response.status === 401) {
                this.showLogin();
                this.showToast('Please sign in to approve channels 🔐');
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
        if (!this.authToken) {
            this.showLogin();
            this.showToast('Please sign in to reject channels 🔐');
            return;
        }

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

                // Remove channel from current batch to prevent it from reappearing
                this.currentBatch = this.currentBatch.filter(channel => channel._id !== channelId);

                // Update stats
                await this.loadStats();
                await this.checkAuthStatus(); // Update user stats

                // Show success feedback
                this.showToast('Channel rejected ❌');
            } else if (response.status === 401) {
                this.showLogin();
                this.showToast('Please sign in to reject channels 🔐');
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
        // Check subscription access for restricted views
        if ((view === 'approved' || view === 'trending') && this.subscriptionStatus && !this.subscriptionStatus.hasAccess) {
            this.showSubscriptionGate();
            // Update active nav button to show locked state but don't switch
            document.querySelectorAll('.nav-btn').forEach(btn => {
                if (btn.dataset.view === view) {
                    btn.classList.add('locked');
                    this.showToast('🔒 Subscription required for ' + (view === 'approved' ? "Kevis' Picks" : 'Trending Today'));
                }
            });
            return;
        }

        // Update active nav button
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
            btn.classList.remove('locked'); // Remove locked state when switching to allowed view
        });

        // Show/hide different views
        const filters = document.getElementById('filters');
        const channelGrid = document.getElementById('channel-grid');
        const collectionsView = document.getElementById('collections-view');
        const socialView = document.getElementById('social-view');
        const emptyState = document.getElementById('empty-state');
        const loading = document.getElementById('loading');
        const paginationControls = document.getElementById('pagination-controls');
        const subscriptionGate = document.getElementById('subscription-gate');

        // Hide all views first (including pagination and subscription gate)
        if (filters) filters.style.display = 'none';
        if (channelGrid) channelGrid.style.display = 'none';
        if (collectionsView) collectionsView.style.display = 'none';
        if (socialView) socialView.style.display = 'none';
        if (emptyState) emptyState.style.display = 'none';
        if (loading) loading.style.display = 'none';
        if (paginationControls) paginationControls.style.display = 'none';
        if (subscriptionGate) subscriptionGate.style.display = 'none';

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
            if (channelGrid) channelGrid.style.display = 'grid';
            
            if (view === 'pending' || view === 'approved') {
                if (filters) filters.style.display = 'grid';
                
                // Show/hide approval time sorting options based on view
                this.updateSortingOptions(view);
                
                // Pagination will be shown by updatePaginationControls() when data loads for pending
            }

            // Load channels for the selected view
            this.loadChannels();
        }
    }

    updateSortingOptions(view) {
        const primarySort = document.getElementById('primary-sort');
        if (!primarySort) return;

        // Get approval time options
        const approvalTimeDesc = primarySort.querySelector('option[value="approval-time-desc"]');
        const approvalTimeAsc = primarySort.querySelector('option[value="approval-time-asc"]');

        if (view === 'approved') {
            // Show approval time options for approved view
            if (approvalTimeDesc) approvalTimeDesc.style.display = 'block';
            if (approvalTimeAsc) approvalTimeAsc.style.display = 'block';
            
            // Set default to recently approved for admin users
            if (this.user && (this.user.email === 'nwalikelv@gmail.com' || this.user.email === 'kevis@viewhunt.com')) {
                primarySort.value = 'approval-time-desc';
            }
        } else {
            // Hide approval time options for other views
            if (approvalTimeDesc) approvalTimeDesc.style.display = 'none';
            if (approvalTimeAsc) approvalTimeAsc.style.display = 'none';
            
            // Reset to default sorting if currently on approval time
            if (primarySort.value === 'approval-time-desc' || primarySort.value === 'approval-time-asc') {
                primarySort.value = 'ratio-desc';
            }
        }
    }

    showToast(message) {
        // Create toast element
        const toast = document.createElement('div');
        
        // Check if mobile device
        const isMobile = window.innerWidth <= 768;
        
        if (isMobile) {
            // Mobile-optimized toast
            toast.className = 'toast-mobile';
            toast.style.cssText = `
                position: fixed;
                top: 10px;
                left: 10px;
                right: 10px;
                background: #1a1a1a;
                color: white;
                padding: 10px 16px;
                border-radius: 8px;
                font-size: 13px;
                font-weight: 500;
                z-index: 10000;
                transform: translateY(-100%);
                transition: transform 0.3s ease;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
                border: 1px solid rgba(255, 255, 255, 0.2);
                text-align: center;
                word-wrap: break-word;
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
            `;
        } else {
            // Desktop toast
            toast.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                background: #1a1a1a;
                color: white;
                padding: 12px 20px;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 500;
                z-index: 10000;
                transform: translateX(100%);
                transition: transform 0.3s ease;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
                border: 1px solid rgba(255, 255, 255, 0.1);
                max-width: 300px;
                word-wrap: break-word;
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
            `;
        }
        
        toast.textContent = message;
        document.body.appendChild(toast);
        
        // Animate in
        setTimeout(() => {
            if (isMobile) {
                toast.style.transform = 'translateY(0)';
            } else {
                toast.style.transform = 'translateX(0)';
            }
        }, 100);
        
        // Remove after 3 seconds
        setTimeout(() => {
            if (isMobile) {
                toast.style.transform = 'translateY(-100%)';
            } else {
                toast.style.transform = 'translateX(100%)';
            }
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

    async checkSubscriptionStatus() {
        // Subscription status is now included in user data from checkAuthStatus
        if (this.user && this.user.subscription) {
            this.subscriptionStatus = this.user.subscription;
            console.log('Subscription status:', this.subscriptionStatus);
            this.updateSubscriptionUI();
        } else {
            console.log('No subscription data in user:', this.user);
        }
    }

    updateSubscriptionUI() {
        const tabs = document.querySelectorAll('.tab-button');
        const subscriptionGate = document.getElementById('subscription-gate');
        
        // Update user menu subscription info
        this.updateUserMenuSubscriptionInfo();
        
        if (!this.subscriptionStatus || !this.subscriptionStatus.hasAccess) {
            // Show subscription gate for restricted tabs
            tabs.forEach(tab => {
                if (tab.dataset.view === 'approved' || tab.dataset.view === 'trending') {
                    tab.classList.add('locked');
                    tab.title = 'Subscription required';
                }
            });
            
            // Show subscription message if on restricted view
            if (this.currentView === 'approved' || this.currentView === 'trending') {
                this.showSubscriptionGate();
            }
        } else {
            // Remove locks if user has access
            tabs.forEach(tab => {
                tab.classList.remove('locked');
                tab.title = '';
            });
            
            // Hide subscription gate
            if (subscriptionGate) {
                subscriptionGate.style.display = 'none';
            }
        }
    }

    showSubscriptionGate() {
        const channelsContainer = document.getElementById('channels-container');
        const subscriptionGate = document.getElementById('subscription-gate');
        
        if (subscriptionGate) {
            subscriptionGate.style.display = 'block';
            channelsContainer.style.display = 'none';
        } else {
            // Create subscription gate if it doesn't exist
            const gateHTML = `
                <div id="subscription-gate" class="subscription-gate">
                    <div class="gate-content">
                        <div class="gate-icon">🔒</div>
                        <h3>Subscription Required</h3>
                        <p>Access to Kevis' Picks and Trending channels requires an active subscription.</p>
                        <div class="gate-buttons">
                            <button class="btn btn-primary" onclick="window.open('/pricing', '_blank')">
                                Subscribe Now
                            </button>
                            <button class="btn btn-secondary" onclick="app.switchView('pending')">
                                View Pending Channels
                            </button>
                        </div>
                    </div>
                </div>
            `;
            
            channelsContainer.insertAdjacentHTML('beforebegin', gateHTML);
            channelsContainer.style.display = 'none';
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
        
        // Check subscription status and update UI
        this.checkSubscriptionStatus();
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

    updateUserMenuSubscriptionInfo() {
        const statusIndicator = document.getElementById('status-indicator');
        const statusText = document.getElementById('status-text');
        const subscriptionActions = document.getElementById('subscription-actions');
        
        if (!this.subscriptionStatus) {
            statusText.textContent = 'Loading...';
            return;
        }
        
        const { hasAccess, type, status, reason } = this.subscriptionStatus;
        
        if (hasAccess) {
            statusIndicator.style.color = '#10b981'; // Green
            
            if (type === 'admin') {
                statusText.textContent = 'Admin Access';
            } else if (type === 'beta') {
                statusText.textContent = 'Beta Access';
            } else if (type === 'stripe') {
                statusText.textContent = 'Pro Subscription';
                subscriptionActions.style.display = 'block';
            }
        } else {
            statusIndicator.style.color = '#ef4444'; // Red
            statusText.textContent = reason || 'Subscription Required';
            subscriptionActions.style.display = 'none';
        }
    }

    manageSubscription() {
        // Open subscription management
        window.open('/pricing', '_blank');
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
            // Check subscription access first
            if (!this.subscriptionStatus || !this.subscriptionStatus.hasAccess) {
                content.innerHTML = `
                    <div class="subscription-required">
                        <div class="lock-icon">🔒</div>
                        <h4>Subscription Required</h4>
                        <p>Kevis's exclusive picks are available to subscribers only.</p>
                        <button class="btn btn-primary" onclick="window.open('/pricing', '_blank')">
                            Subscribe Now
                        </button>
                    </div>
                `;
                return;
            }

            // Require authentication to see Kevis's Picks
            if (!this.token) {
                content.innerHTML = '<div class="social-empty">Sign in to see Kevis\'s exclusive picks! 🔐✨</div>';
                return;
            }

            // Use the protected endpoint with authentication
            const response = await this.fetchWithAuth(`${this.apiBase}/kevis-picks`);
            
            if (!response.ok) {
                if (response.status === 403) {
                    // Handle subscription required error
                    content.innerHTML = `
                        <div class="subscription-required">
                            <div class="lock-icon">🔒</div>
                            <h4>Subscription Required</h4>
                            <p>Kevis's exclusive picks are available to subscribers only.</p>
                            <button class="btn btn-primary" onclick="window.open('/pricing', '_blank')">
                                Subscribe Now
                            </button>
                        </div>
                    `;
                    return;
                }
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
            // Check subscription access first
            if (!this.subscriptionStatus || !this.subscriptionStatus.hasAccess) {
                content.innerHTML = `
                    <div class="subscription-required">
                        <div class="lock-icon">🔒</div>
                        <h4>Subscription Required</h4>
                        <p>Trending channels are available to subscribers only.</p>
                        <button class="btn btn-primary" onclick="window.open('/pricing', '_blank')">
                            Subscribe Now
                        </button>
                    </div>
                `;
                return;
            }

            // Get channels approved in the last 24 hours with authentication
            const response = await this.fetchWithAuth(`${this.apiBase}/channels/trending`);
            let channels;
            
            if (response.ok) {
                channels = await response.json();
            } else if (response.status === 403) {
                // Handle subscription required error
                content.innerHTML = `
                    <div class="subscription-required">
                        <div class="lock-icon">🔒</div>
                        <h4>Subscription Required</h4>
                        <p>Trending channels are available to subscribers only.</p>
                        <button class="btn btn-primary" onclick="window.open('/pricing', '_blank')">
                            Subscribe Now
                        </button>
                    </div>
                `;
                return;
            } else {
                // Fallback to recent approved channels if trending endpoint doesn't exist yet
                const fallbackResponse = await this.fetchWithAuth(`${this.apiBase}/channels/approved`);
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

    // Pagination Methods
    async loadNextPage() {
        if (this.isLoadingPage || this.currentBatch >= this.totalBatches) {
            return;
        }

        this.currentBatch++;
        await this.loadRandomBatch();
    }

    async loadPreviousPage() {
        if (this.isLoadingPage || this.currentBatch <= 1) {
            return;
        }

        this.currentBatch--;
        await this.loadRandomBatch();
    }

    async loadRandomBatch() {
        if (this.isLoadingPage) return;

        this.isLoadingPage = true;

        // Show loading state
        const channelGrid = document.getElementById('channel-grid');
        const nextBtn = document.getElementById('next-page-btn');
        const prevBtn = document.getElementById('prev-page-btn');

        channelGrid.classList.add('loading');
        nextBtn.disabled = true;
        prevBtn.disabled = true;
        nextBtn.innerHTML = '<div class="pagination-loading"><div class="spinner"></div>Loading...</div>';

        try {
            // Get a new random batch from the full list
            this.getRandomBatch();

            // Simulate loading delay for better UX
            await new Promise(resolve => setTimeout(resolve, 300));

            // Fade in the new content
            channelGrid.style.opacity = '0';
            setTimeout(() => {
                this.renderChannels();
                this.updatePaginationControls();
                channelGrid.style.opacity = '1';
                channelGrid.classList.remove('loading');
            }, 150);

        } catch (error) {
            console.error('Error loading random batch:', error);
        } finally {
            this.isLoadingPage = false;
        }
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
                
                // Randomize the new batch for better discovery
                this.shuffleArray(this.channels);
                
                console.log(`Loaded batch ${pageNumber}: ${this.channels.length} channels - Randomized`);
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
                
                // Scroll to top of page for better UX
                window.scrollTo({ top: 0, behavior: 'smooth' });
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




}

// Initialize app
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new ViewHuntApp();
    window.app = app; // Make it globally available
});