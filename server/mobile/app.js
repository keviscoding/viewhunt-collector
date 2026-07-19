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
        this.isDarkMode = localStorage.getItem('viewhunt_theme') !== 'light';
        
        this.init();
    }

    async init() {
        this.initTheme();
        this.setupEventListeners();
        
        // Check for OAuth callback parameters
        this.handleOAuthCallback();
        
        await this.checkAuthStatus();
        await this.checkSubscriptionStatus();
        
        // Update sorting options based on user permissions
        this.updateSortingOptions(this.currentView);
        
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

        // Enhanced Only filter
        document.getElementById('enhanced-only').addEventListener('change', () => {
            if (this.currentView === 'pending') {
                this.loadPendingChannels(1);
            } else if (this.currentView === 'approved') {
                this.loadApprovedChannels();
            } else {
                this.applyFilters();
            }
        });

        // Active Recently filter
        document.getElementById('active-recently').addEventListener('change', () => {
            if (this.currentView === 'pending') {
                this.loadPendingChannels(1);
            } else if (this.currentView === 'approved') {
                this.loadApprovedChannels();
            } else {
                this.applyFilters();
            }
        });

        // Video Title Search toggle
        document.getElementById('video-title-search-enabled').addEventListener('change', (e) => {
            const searchInput = document.getElementById('video-title-search');
            searchInput.disabled = !e.target.checked;
            if (!e.target.checked) {
                searchInput.value = '';
            }
            // Auto-apply when toggled off
            if (!e.target.checked) {
                if (this.currentView === 'pending') {
                    this.loadPendingChannels(1);
                } else if (this.currentView === 'approved') {
                    this.loadApprovedChannels();
                }
            }
        });

        // Video Title Search input (with debounce)
        let searchTimeout;
        document.getElementById('video-title-search').addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                if (document.getElementById('video-title-search-enabled').checked) {
                    if (this.currentView === 'pending') {
                        this.loadPendingChannels(1);
                    } else if (this.currentView === 'approved') {
                        this.loadApprovedChannels();
                    }
                }
            }, 500); // Wait 500ms after user stops typing
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

        // Registration form with invite codes
        document.getElementById('register-form-element').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleRegister();
        });

        // Email verification form
        document.getElementById('verify-form-element').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleVerify();
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

        // Add mobile scroll protection to prevent crashes
        if (window.innerWidth <= 768) {
            let scrollTimeout;
            window.addEventListener('scroll', () => {
                clearTimeout(scrollTimeout);
                scrollTimeout = setTimeout(() => {
                    // Throttle scroll events on mobile
                    const scrollPercent = (window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100;
                    
                    // If user scrolls past 90%, show pagination hint
                    if (scrollPercent > 90 && this.pagination && this.currentPage < this.pagination.totalPages) {
                        this.showPaginationHint();
                    }
                }, 100);
            });
        }
    }

    showPaginationHint() {
        // Show a subtle hint about pagination instead of infinite scroll
        const hint = document.createElement('div');
        hint.className = 'pagination-hint';
        hint.innerHTML = `
            <div style="
                position: fixed; 
                bottom: 20px; 
                left: 50%; 
                transform: translateX(-50%); 
                background: var(--primary-color); 
                color: white; 
                padding: 10px 20px; 
                border-radius: 25px; 
                font-size: 14px; 
                z-index: 1000;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            ">
                📄 Page ${this.currentPage} of ${this.pagination.totalPages} • Use pagination controls below
            </div>
        `;
        
        document.body.appendChild(hint);
        
        // Remove hint after 3 seconds
        setTimeout(() => {
            if (hint.parentNode) {
                hint.parentNode.removeChild(hint);
            }
        }, 3000);
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

        // Recent Avg range slider
        const recentAvgSliderMin = document.getElementById('recent-avg-slider-min');
        const recentAvgSliderMax = document.getElementById('recent-avg-slider-max');
        const minRecentAvgInput = document.getElementById('min-recent-avg');
        const maxRecentAvgInput = document.getElementById('max-recent-avg');

        if (recentAvgSliderMin && recentAvgSliderMax && minRecentAvgInput && maxRecentAvgInput) {
            // Update input when slider changes
            recentAvgSliderMin.addEventListener('input', () => {
                const value = parseInt(recentAvgSliderMin.value);
                const formattedValue = formatNumber(value);
                minRecentAvgInput.value = formattedValue;
                
                // Ensure min doesn't exceed max
                if (value > parseInt(recentAvgSliderMax.value)) {
                    recentAvgSliderMax.value = value;
                    maxRecentAvgInput.value = formatNumber(value);
                }
            });

            recentAvgSliderMax.addEventListener('input', () => {
                const value = parseInt(recentAvgSliderMax.value);
                const formattedValue = formatNumber(value);
                maxRecentAvgInput.value = formattedValue;
                
                // Ensure max doesn't go below min
                if (value < parseInt(recentAvgSliderMin.value)) {
                    recentAvgSliderMin.value = value;
                    minRecentAvgInput.value = formatNumber(value);
                }
            });

            // Update slider when input changes
            minRecentAvgInput.addEventListener('input', () => {
                const value = this.parseFormattedNumber(minRecentAvgInput.value) || 0;
                recentAvgSliderMin.value = value;
            });

            maxRecentAvgInput.addEventListener('input', () => {
                const value = this.parseFormattedNumber(maxRecentAvgInput.value) || 5000000;
                recentAvgSliderMax.value = value;
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
        const enhancedOnly = document.getElementById('enhanced-only')?.checked || false;
        const activeRecently = document.getElementById('active-recently')?.checked || false;

        // Apply Enhanced filter for approved channels
        let filteredChannels = [...this.channels];
        
        if (enhancedOnly) {
            filteredChannels = filteredChannels.filter(channel => 
                channel.enhanced === true && (channel.recent_average || channel.recentAverage)
            );
        }
        
        if (activeRecently) {
            filteredChannels = filteredChannels.filter(channel => {
                const recentShorts = channel.recent_shorts || [];
                const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
                
                const activeVideos = recentShorts.filter(video => 
                    new Date(video.publishedAt) >= twoWeeksAgo
                );
                
                return activeVideos.length >= 4;
            });
        }

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
                case 'approvals-desc':
                    return (b.approval_count || 0) - (a.approval_count || 0);
                case 'approvals-asc':
                    return (a.approval_count || 0) - (b.approval_count || 0);
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
            const enhancedOnly = document.getElementById('enhanced-only').checked;
            const activeRecently = document.getElementById('active-recently').checked;
            const videoTitleSearchEnabled = document.getElementById('video-title-search-enabled').checked;
            const videoTitleSearch = videoTitleSearchEnabled ? document.getElementById('video-title-search').value.trim() : '';
            const minRecentAvg = this.parseFormattedNumber(document.getElementById('min-recent-avg').value) || 0;
            const maxRecentAvg = document.getElementById('max-recent-avg').value ? this.parseFormattedNumber(document.getElementById('max-recent-avg').value) : null;

            const minSubs = this.parseFormattedNumber(document.getElementById('min-subs').value) || 0;
            const maxSubs = document.getElementById('max-subs').value ? this.parseFormattedNumber(document.getElementById('max-subs').value) : null;
            const minVideos = parseInt(document.getElementById('min-videos').value.replace(/,/g, '')) || 0;
            const maxVideos = document.getElementById('max-videos').value ? parseInt(document.getElementById('max-videos').value.replace(/,/g, '')) : null;

            // Build query parameters - Use smaller page size for mobile
            const isMobile = window.innerWidth <= 768;
            const pageSize = isMobile ? '25' : '50'; // Reduce to 25 for mobile
            
            const params = new URLSearchParams({
                page: page.toString(),
                limit: pageSize,
                primarySort: primarySort,
                secondarySort: secondarySort
            });
            
            // Add filter parameters if they have values
            if (enhancedOnly) params.append('enhancedOnly', 'true');
            if (activeRecently) params.append('activeRecently', 'true');
            if (videoTitleSearch) params.append('videoTitle', videoTitleSearch);
            if (minRecentAvg > 0) params.append('minRecentAvg', minRecentAvg.toString());
            if (maxRecentAvg) params.append('maxRecentAvg', maxRecentAvg.toString());

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

            // Handle free tier limit reached
            if (data.freeTierLimitReached) {
                emptyState.style.display = 'block';
                emptyState.querySelector('h2').textContent = 'Daily Limit Reached';
                emptyState.querySelector('p').innerHTML = 'Free tier allows 10 niche discoveries per day.<br><br><a href="/pricing" style="color:#7c6aef;font-weight:600;text-decoration:none">Upgrade for unlimited access →</a>';
                return;
            }

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
            
            // Check if this is a subscription error
            if (error.message.includes('subscription') || !this.hasSubscriptionAccess()) {
                this.showSubscriptionGate();
            } else {
                emptyState.style.display = 'block';
                emptyState.querySelector('h2').textContent = 'Error Loading Channels';
                emptyState.querySelector('p').textContent = 'Please try again or check your connection.';
            }
        } finally {
            this.isLoadingBatch = false;
        }
    }

    // Alias for backward compatibility
    async loadNewBatch() {
        await this.loadPendingChannels(1);
    }

    async loadApprovedChannels(page = 1, append = false) {
        const loading = document.getElementById('loading');
        const emptyState = document.getElementById('empty-state');
        const channelGrid = document.getElementById('channel-grid');

        if (!append) {
            loading.style.display = 'flex';
            emptyState.style.display = 'none';
            channelGrid.innerHTML = '';
            this.approvedPage = 1;
            this.approvedHasMore = true;
        }

        try {
            if (!this.authToken) {
                this.channels = [];
                loading.style.display = 'none';
                emptyState.style.display = 'block';
                emptyState.querySelector('h2').textContent = 'Sign In Required';
                emptyState.querySelector('p').textContent = 'Please sign in to view saved niches.';
                return;
            }

            // Build query parameters for admin filtering
            let url = `${this.apiBase}/channels/approved`;
            // Admin OR Student account get the full view with filters
            if (this.user && (this.user.email === 'nwalikelv@gmail.com' || this.user.email === 'kevis@viewhunt.com' || this.user.email === 'students@viewhunt.com')) {
                const params = new URLSearchParams();
                
                // Add pagination
                params.append('page', page.toString());
                params.append('limit', '50');
                
                // Get filter values
                const primarySort = document.getElementById('primary-sort')?.value || 'approval-time-desc';
                const enhancedOnly = document.getElementById('enhanced-only')?.checked || false;
                const activeRecently = document.getElementById('active-recently')?.checked || false;
                const videoTitleSearchEnabled = document.getElementById('video-title-search-enabled')?.checked || false;
                const videoTitleSearch = videoTitleSearchEnabled ? document.getElementById('video-title-search')?.value.trim() : '';
                const minRecentAvg = this.parseFormattedNumber(document.getElementById('min-recent-avg')?.value || '0');
                const maxRecentAvg = document.getElementById('max-recent-avg')?.value ? this.parseFormattedNumber(document.getElementById('max-recent-avg').value) : null;
                const minViews = this.parseFormattedNumber(document.getElementById('min-views')?.value || '0');
                const maxViews = document.getElementById('max-views')?.value ? this.parseFormattedNumber(document.getElementById('max-views').value) : null;
                const minSubs = this.parseFormattedNumber(document.getElementById('min-subs')?.value || '0');
                const maxSubs = document.getElementById('max-subs')?.value ? this.parseFormattedNumber(document.getElementById('max-subs').value) : null;
                const minVideos = parseInt(document.getElementById('min-videos')?.value || '0');
                const maxVideos = document.getElementById('max-videos')?.value ? parseInt(document.getElementById('max-videos').value) : null;

                params.append('sortBy', primarySort);
                if (enhancedOnly) params.append('enhancedOnly', 'true');
                if (activeRecently) params.append('activeRecently', 'true');
                if (videoTitleSearch) params.append('videoTitle', videoTitleSearch);
                if (minRecentAvg > 0) params.append('minRecentAvg', minRecentAvg.toString());
                if (maxRecentAvg) params.append('maxRecentAvg', maxRecentAvg.toString());

                if (minSubs > 0) params.append('minSubs', minSubs.toString());
                if (maxSubs) params.append('maxSubs', maxSubs.toString());
                if (minVideos > 0) params.append('minVideos', minVideos.toString());
                if (maxVideos) params.append('maxVideos', maxVideos.toString());

                url += `?${params}`;
            } else {
                // Regular users also get pagination
                const params = new URLSearchParams();
                params.append('page', page.toString());
                params.append('limit', '50');
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

            const data = await response.json();
            const newChannels = data.channels || data; // Handle both paginated and non-paginated responses
            const pagination = data.pagination;

            if (append) {
                this.channels = [...this.channels, ...newChannels];
            } else {
                this.channels = newChannels;
            }

            // Store pagination info
            if (pagination) {
                this.approvedPage = pagination.currentPage;
                this.approvedHasMore = pagination.hasMore;
                this.approvedTotalPages = pagination.totalPages;
                this.approvedTotalChannels = pagination.totalChannels;
            }

            loading.style.display = 'none';

            if (this.channels.length === 0 && !append) {
                emptyState.style.display = 'block';
                emptyState.querySelector('h2').textContent = 'No Saved Niches';
                emptyState.querySelector('p').textContent = 'Start reviewing niches to build your saved list.';
            } else {
                this.renderChannels();
                
                // Show load more button if there are more pages
                if (pagination && pagination.hasMore) {
                    this.showLoadMoreButton();
                }
            }
        } catch (error) {
            console.error('Error loading approved channels:', error);
            loading.style.display = 'none';
            
            // Check if this is a subscription error
            if (error.message.includes('subscription') || !this.hasSubscriptionAccess()) {
                this.showSubscriptionGate();
            } else {
                emptyState.style.display = 'block';
                emptyState.querySelector('h2').textContent = 'Error Loading Channels';
                emptyState.querySelector('p').textContent = 'Please try again or check your connection.';
            }
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

        // Clear existing content and force garbage collection
        channelGrid.innerHTML = '';
        emptyState.style.display = 'none';
        
        // Force garbage collection on mobile to prevent memory crashes
        if (window.innerWidth <= 768 && window.gc) {
            window.gc();
        }

        this.currentBatch.forEach(channel => {
            const card = this.createChannelCard(channel);
            channelGrid.appendChild(card);
        });
        
        // Scroll to top when new page loads to prevent scroll position issues
        window.scrollTo({ top: 0, behavior: 'smooth' });
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

    showLoadMoreButton() {
        const channelGrid = document.getElementById('channel-grid');
        let loadMoreBtn = document.getElementById('load-more-btn');
        
        // Remove existing button if any
        if (loadMoreBtn) {
            loadMoreBtn.remove();
        }
        
        // Create new load more button
        loadMoreBtn = document.createElement('div');
        loadMoreBtn.id = 'load-more-btn';
        loadMoreBtn.className = 'load-more-container';
        loadMoreBtn.innerHTML = `
            <button class="load-more-btn" onclick="app.loadMoreApprovedChannels()">
                <span>Load More Channels</span>
                <span class="load-more-info">(${this.approvedPage} of ${this.approvedTotalPages} pages • ${this.channels.length} of ${this.approvedTotalChannels} total)</span>
            </button>
        `;
        
        channelGrid.parentElement.appendChild(loadMoreBtn);
    }

    async loadMoreApprovedChannels() {
        if (!this.approvedHasMore) return;
        
        const loadMoreBtn = document.querySelector('.load-more-btn');
        if (loadMoreBtn) {
            loadMoreBtn.disabled = true;
            loadMoreBtn.innerHTML = '<span>Loading...</span>';
        }
        
        await this.loadApprovedChannels(this.approvedPage + 1, true);
    }

    createChannelCard(channel) {
        const card = document.createElement('div');
        card.className = 'channel-card';
        card.dataset.channelId = channel._id;

        // Get first letter for avatar fallback
        const channelName = channel.channel_name || channel.channelName || 'Unknown';
        const avatarLetter = channelName.charAt(0).toUpperCase();
        
        // Format numbers
        const formatNumber = (num) => {
            if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
            if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
            return num.toString();
        };

        // Channel Average (historical) vs Recent Average (last 10 videos)
        const channelAverage = formatNumber(channel.average_views || channel.averageViews || channel.view_count || 0);
        const recentAverage = channel.enhanced && (channel.recent_average || channel.recentAverage) ? 
            formatNumber(channel.recent_average || channel.recentAverage) : null;
        
        // Debug enhanced data
        if (channel.enhanced) {
            console.log(`Enhanced channel found: ${channelName}`, {
                enhanced: channel.enhanced,
                recent_average: channel.recent_average,
                recentAverage: channel.recentAverage,
                calculated: recentAverage,
                recent_shorts: channel.recent_shorts ? `${channel.recent_shorts.length} shorts` : 'No shorts data'
            });
        }
        const videoCount = channel.video_count || channel.videoCount || 0;
        
        // Debug: log video count to see what's happening
        if (channel.video_count === undefined && channel.videoCount === undefined) {
            console.log(`Channel ${channel.channel_name} has no video_count field`);
        }
        const subCount = formatNumber(channel.subscriber_count || channel.subscriberCount || 0);
        const ratio = (channel.view_to_sub_ratio || channel.viewToSubRatio) ? 
            (channel.view_to_sub_ratio || channel.viewToSubRatio).toFixed(2) : 'N/A';

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
        const avatarUrl = channel.avatar_url || channel.avatarUrl;
        const avatarHtml = avatarUrl ? 
            `<img src="${avatarUrl}" alt="${this.escapeHtml(channelName)}" class="channel-avatar-img">` :
            `<div class="channel-avatar-letter">${avatarLetter}</div>`;

        // Create thumbnail HTML
        const thumbnailUrl = channel.thumbnail_url || channel.thumbnailUrl;
        const thumbnailHtml = thumbnailUrl ? 
            `<div class="video-thumbnail">
                <img src="${thumbnailUrl}" alt="Video thumbnail" class="thumbnail-img" loading="lazy">
                <div class="thumbnail-overlay">
                    <span class="play-icon">▶</span>
                </div>
            </div>` : '';

        card.innerHTML = `
            ${thumbnailHtml}
            <div class="channel-header">
                <div class="channel-avatar">${avatarHtml}</div>
                <div class="channel-info">
                    <h3>${this.escapeHtml(channelName)} ${communityBadge}</h3>
                    <p>${this.escapeHtml(channel.video_title || channel.videoTitle || 'No video title')}</p>
                    <small class="video-count">${videoCount > 0 ? videoCount.toLocaleString() : 'N/A'} videos</small>
                    ${approvalInfo}
                </div>
            </div>
            
            <div class="channel-stats">
                <div class="stat-item">
                    <span class="stat-value">${recentAverage || channelAverage}</span>
                    <span class="stat-label">
                        ${recentAverage ? 'Recent Avg' : 'Channel Avg'}
                        ${recentAverage ? '<span class="enhanced-badge">✨ Enhanced</span>' : ''}
                    </span>
                    ${recentAverage ? `<small class="stat-note">Last ${channel.videos_analyzed || 10} shorts</small>` : ''}
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
            
            ${channel.recent_shorts && channel.recent_shorts.length > 0 ? `
                <div class="recent-shorts">
                    <h4 class="shorts-title">Recent Shorts:</h4>
                    <div class="shorts-grid">
                        ${channel.recent_shorts.slice(0, 4).map(short => `
                            <a href="${short.shortUrl || short.watchUrl}" target="_blank" class="short-preview" title="${this.escapeHtml(short.title)}">
                                <img src="${short.thumbnailUrl}" alt="Short thumbnail" class="short-thumbnail" loading="lazy">
                                <div class="short-stats">
                                    <span class="short-views">${formatNumber(short.viewCount)}</span>
                                    <span class="short-date">${this.getTimeAgo(new Date(short.publishedAt))}</span>
                                </div>
                            </a>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
            

            
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
        // Studio tab is handled by openStudio() — don't switch view
        if (view === 'studio') {
            this.openStudio();
            return;
        }
        
        // Check subscription access for restricted views (but allow admin, beta, and invite users)
        if ((view === 'approved' || view === 'trending') && !this.hasSubscriptionAccess()) {
            this.showSubscriptionGate();
            // Update active nav button to show locked state but don't switch
            document.querySelectorAll('.nav-btn').forEach(btn => {
                if (btn.dataset.view === view) {
                    btn.classList.add('locked');
                    this.showToast('🔒 Member access required for ' + (view === 'approved' ? "Kevis' Picks" : 'Trending Today'));
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
        const secondarySort = document.getElementById('secondary-sort');
        if (!primarySort) return;

        // Get approval time and approvals count options from primary sort
        const approvalTimeDesc = primarySort.querySelector('option[value="approval-time-desc"]');
        const approvalTimeAsc = primarySort.querySelector('option[value="approval-time-asc"]');
        const approvalsDesc = primarySort.querySelector('option[value="approvals-desc"]');
        const approvalsAsc = primarySort.querySelector('option[value="approvals-asc"]');

        // Get approvals count options from secondary sort
        const secondaryApprovalsDesc = secondarySort ? secondarySort.querySelector('option[value="approvals-desc"]') : null;
        const secondaryApprovalsAsc = secondarySort ? secondarySort.querySelector('option[value="approvals-asc"]') : null;

        // Check if user is admin or student account
        const isAdmin = this.user && (this.user.email === 'nwalikelv@gmail.com' || this.user.email === 'kevis@viewhunt.com' || this.user.email === 'students@viewhunt.com');

        if (view === 'approved' && isAdmin) {
            // Show approval time and approvals count options for approved view (admin only)
            if (approvalTimeDesc) approvalTimeDesc.style.display = 'block';
            if (approvalTimeAsc) approvalTimeAsc.style.display = 'block';
            if (approvalsDesc) approvalsDesc.style.display = 'block';
            if (approvalsAsc) approvalsAsc.style.display = 'block';
            if (secondaryApprovalsDesc) secondaryApprovalsDesc.style.display = 'block';
            if (secondaryApprovalsAsc) secondaryApprovalsAsc.style.display = 'block';
            
            // Set default to recently approved for admin users
            primarySort.value = 'approval-time-desc';
        } else {
            // Hide approval time and approvals count options for non-admin users or other views
            if (approvalTimeDesc) approvalTimeDesc.style.display = 'none';
            if (approvalTimeAsc) approvalTimeAsc.style.display = 'none';
            if (approvalsDesc) approvalsDesc.style.display = 'none';
            if (approvalsAsc) approvalsAsc.style.display = 'none';
            if (secondaryApprovalsDesc) secondaryApprovalsDesc.style.display = 'none';
            if (secondaryApprovalsAsc) secondaryApprovalsAsc.style.display = 'none';
            
            // Reset to default sorting if currently on approval time or approvals count
            if (primarySort.value === 'approval-time-desc' || primarySort.value === 'approval-time-asc' || 
                primarySort.value === 'approvals-desc' || primarySort.value === 'approvals-asc') {
                primarySort.value = 'ratio-desc';
            }
            
            // Reset secondary sort if currently on approvals count
            if (secondarySort && (secondarySort.value === 'approvals-desc' || secondarySort.value === 'approvals-asc')) {
                secondarySort.value = 'none';
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
                    this.updateEmailVerifyBanner();
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
            
            // Check admin status after subscription status is loaded
            this.updateAdminUI();
        } else {
            console.log('No subscription data in user:', this.user);
            // Still check admin status even without subscription data
            this.updateAdminUI();
        }
    }

    updateAdminUI() {
        // Show admin panel button for admin users
        console.log('Updating admin UI:', {
            userEmail: this.user?.email,
            subscriptionType: this.subscriptionStatus?.type
        });
        
        if (this.user && (
            this.user.email === 'kevis@keviscoding.com' || 
            this.user.email?.toLowerCase() === 'kevis@keviscoding.com' ||
            this.subscriptionStatus?.type === 'admin'
        )) {
            const adminBtn = document.getElementById('admin-panel-btn');
            if (adminBtn) {
                adminBtn.style.display = 'block';
                console.log('Admin panel button shown');
            } else {
                console.log('Admin panel button not found in DOM');
            }
        }
    }

    // Helper function to check if user has access (admin, beta, invite, free, or paid users)
    hasSubscriptionAccess() {
        if (!this.subscriptionStatus) return false;
        
        // Student account has niche access
        if (this.user && this.user.email === 'students@viewhunt.com') {
            return true;
        }
        
        return this.subscriptionStatus.hasAccess || 
               this.subscriptionStatus.type === 'admin' || 
               this.subscriptionStatus.type === 'beta' || 
               this.subscriptionStatus.type === 'invite' ||
               this.subscriptionStatus.type === 'free';
    }
    
    // Check if user has a paid plan (for studio access)
    hasPaidAccess() {
        if (!this.subscriptionStatus) return false;
        if (this.subscriptionStatus.type === 'admin') return true;
        if (this.subscriptionStatus.type === 'stripe' && this.subscriptionStatus.hasAccess) return true;
        // Beta, invite, and active trial users get studio access
        if (this.subscriptionStatus.type === 'beta' || this.subscriptionStatus.type === 'invite') return true;
        if (this.subscriptionStatus.type === 'trial' && this.subscriptionStatus.hasAccess) return true;
        return false;
    }
    
    // Open Content Studio — all users go to the format gallery
    openStudio() {
        window.location.href = '/studio/';
    }
    
    updateSubscriptionUI() {
        const tabs = document.querySelectorAll('.nav-btn'); // Changed from .tab-button to .nav-btn
        const subscriptionGate = document.getElementById('subscription-gate');
        
        // Update user menu subscription info
        this.updateUserMenuSubscriptionInfo();
        
        // Check if user needs subscription (exclude admin, beta, and invite users)
        const needsSubscription = !this.hasSubscriptionAccess();
        
        if (needsSubscription) {
            // Show subscription gate for restricted tabs
            tabs.forEach(tab => {
                if (tab.dataset.view === 'approved' || tab.dataset.view === 'trending') {
                    tab.classList.add('locked');
                    tab.title = 'Member access required';
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
                        <h3>Member Access Required</h3>
                        <p>This feature is available to ViewHunt members. Contact support if you need access assistance.</p>
                        <div class="gate-buttons">
                            <button class="btn btn-primary" onclick="window.open('/pricing', '_blank')">
                                Subscribe to Hunt Viral Niches
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
        
        // Show admin panel button for admin users (check multiple conditions)
        console.log('Checking admin status:', {
            userEmail: this.user.email,
            subscriptionType: this.subscriptionStatus?.type,
            adminEmail: 'kevis@keviscoding.com'
        });
        
        if (this.user.email === 'kevis@keviscoding.com' || 
            this.user.email?.toLowerCase() === 'kevis@keviscoding.com' ||
            this.subscriptionStatus?.type === 'admin') {
            const adminBtn = document.getElementById('admin-panel-btn');
            if (adminBtn) {
                adminBtn.style.display = 'block';
                console.log('Admin panel button shown');
            } else {
                console.log('Admin panel button not found in DOM');
            }
        } else {
            console.log('User is not admin');
        }
        
        // Check subscription status and update UI
        this.checkSubscriptionStatus();
    }

    updateUIForLoggedOutUser() {
        document.getElementById('auth-buttons').style.display = 'flex';
        document.getElementById('user-info').style.display = 'none';
    }

    showLogin() {
        document.getElementById('login-form').style.display = 'block';
        // Register form is disabled, so don't try to access it
        const registerForm = document.getElementById('register-form');
        if (registerForm) {
            registerForm.style.display = 'none';
        }
        var verifyForm = document.getElementById('verify-form');
        if (verifyForm) verifyForm.style.display = 'none';
        document.getElementById('auth-overlay').style.display = 'flex';
        
        // Clear forms
        document.getElementById('login-form-element').reset();
    }

    showRegister() {
        document.getElementById('login-form').style.display = 'none';
        const registerForm = document.getElementById('register-form');
        if (registerForm) {
            registerForm.style.display = 'block';
        }
        var verifyForm = document.getElementById('verify-form');
        if (verifyForm) verifyForm.style.display = 'none';
        document.getElementById('auth-overlay').style.display = 'flex';
        
        // Clear forms
        const registerFormElement = document.getElementById('register-form-element');
        if (registerFormElement) {
            registerFormElement.reset();
        }
        var inviteWrap = document.getElementById('invite-code-wrap');
        if (inviteWrap) inviteWrap.style.display = 'none';
        var toggleInvite = document.getElementById('toggle-invite-code');
        if (toggleInvite) toggleInvite.textContent = 'Have an invite?';
    }

    toggleInviteCode() {
        var wrap = document.getElementById('invite-code-wrap');
        var toggle = document.getElementById('toggle-invite-code');
        if (!wrap) return;
        var open = wrap.style.display === 'none' || !wrap.style.display;
        wrap.style.display = open ? 'block' : 'none';
        if (toggle) toggle.textContent = open ? 'Hide invite code' : 'Have an invite?';
        if (open) {
            var input = document.getElementById('register-invite-code');
            if (input) input.focus();
        }
    }

    updateEmailVerifyBanner() {
        var banner = document.getElementById('email-verify-banner');
        if (!banner) return;
        var needs = this.user && this.user.emailVerified === false;
        if (sessionStorage.getItem('viewhunt_dismiss_verify_banner') === '1') {
            needs = false;
        }
        banner.style.display = needs ? 'flex' : 'none';
        if (needs) {
            var text = document.getElementById('email-verify-banner-text');
            if (text) {
                text.textContent = 'Confirm ' + (this.user.email || 'your email') + ' — we sent a code.';
            }
            this._pendingVerifyEmail = this.user.email;
            var openBtn = document.getElementById('email-verify-open-btn');
            var resendBtn = document.getElementById('email-verify-resend-btn');
            var dismissBtn = document.getElementById('email-verify-dismiss-btn');
            var self = this;
            if (openBtn) openBtn.onclick = function() { self.showVerifyForm(self.user.email); };
            if (resendBtn) resendBtn.onclick = function() { self.handleResendCode(); };
            if (dismissBtn) {
                dismissBtn.onclick = function() {
                    try { sessionStorage.setItem('viewhunt_dismiss_verify_banner', '1'); } catch (e) {}
                    banner.style.display = 'none';
                };
            }
        }
    }

    async finishAuthSession(data, welcomeMsg) {
        this.token = data.token;
        this.authToken = data.token;
        this.user = data.user || this.user;
        localStorage.setItem('viewhunt_token', this.token);
        this.closeAuth();
        this.showToast(welcomeMsg);
        await this.checkAuthStatus();
        await this.checkSubscriptionStatus();
        this.updateSubscriptionUI();
        this.updateEmailVerifyBanner();
        await this.loadStats();
        await this.loadChannels();
        if (typeof showOnboarding === 'function') showOnboarding();
        await this.handlePostAuthRedirect();
    }

    async handlePostAuthRedirect() {
        var next = null;
        var plan = null;
        try {
            next = sessionStorage.getItem('viewhunt_post_auth_next');
            plan = sessionStorage.getItem('viewhunt_post_auth_plan');
        } catch (e) {}

        if (plan && ['starter', 'creator', 'studio'].indexOf(plan) !== -1) {
            try { sessionStorage.removeItem('viewhunt_post_auth_plan'); } catch (e) {}
            try { sessionStorage.removeItem('viewhunt_post_auth_next'); } catch (e) {}
            await this.startPlanCheckout(plan);
            return;
        }

        if (next === 'ranking') {
            try { sessionStorage.removeItem('viewhunt_post_auth_next'); } catch (e) {}
            window.location.href = '/studio/ranking';
            return;
        }
    }

    async startPlanCheckout(plan) {
        if (!this.token) {
            try { sessionStorage.setItem('viewhunt_post_auth_plan', plan); } catch (e) {}
            this.showRegister();
            return;
        }
        try {
            this.showToast('Starting checkout…');
            var res = await this.fetchWithAuth(this.apiBase + '/subscription/create-plan-checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plan: plan })
            });
            var data = await res.json();
            if (data.url) {
                window.location.href = data.url;
            } else {
                this.showToast(data.error || 'Could not start checkout ❌');
            }
        } catch (err) {
            console.error('Checkout error:', err);
            this.showToast('Checkout error ❌');
        }
    }

    closeAuth() {
        document.getElementById('auth-overlay').style.display = 'none';
    }

    showVerifyForm(email) {
        document.getElementById('login-form').style.display = 'none';
        var registerForm = document.getElementById('register-form');
        if (registerForm) registerForm.style.display = 'none';
        document.getElementById('verify-form').style.display = 'block';
        document.getElementById('verify-subtitle').textContent = 'We sent a 6-digit code to ' + email + '. Enter it below.';
        document.getElementById('auth-overlay').style.display = 'flex';
        var codeInput = document.getElementById('verify-code');
        codeInput.value = '';
        codeInput.focus();
    }

    async handleVerify() {
        var code = document.getElementById('verify-code').value.trim();
        if (!code || code.length !== 6) {
            this.showToast('Please enter the 6-digit code ❌');
            return;
        }
        var email = this._pendingVerifyEmail;
        if (!email) {
            this.showToast('Something went wrong. Please try signing up again ❌');
            return;
        }
        var submitBtn = document.querySelector('#verify-form button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Verifying...';
        try {
            var response = await fetch(this.apiBase + '/auth/verify-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email, code: code })
            });
            var data = await response.json();
            if (response.ok && data.token) {
                try { sessionStorage.removeItem('viewhunt_dismiss_verify_banner'); } catch (e) {}
                await this.finishAuthSession(data, 'Email verified! Welcome to ViewHunt 🎉');
            } else if (response.ok && data.alreadyVerified && this.token) {
                this.closeAuth();
                await this.checkAuthStatus();
                this.updateEmailVerifyBanner();
                this.showToast('Email already verified ✅');
            } else {
                this.showToast(data.error || 'Verification failed ❌');
            }
        } catch (error) {
            console.error('Verify error:', error);
            this.showToast('Network error. Please try again ❌');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Verify Email';
        }
    }

    async handleResendCode() {
        var email = this._pendingVerifyEmail;
        if (!email) return;
        var btn = document.getElementById('resend-code-btn');
        btn.textContent = 'Sending...';
        btn.disabled = true;
        try {
            var response = await fetch(this.apiBase + '/auth/resend-code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email })
            });
            var data = await response.json();
            if (response.ok) {
                this.showToast('New code sent! Check your email 📧');
            } else {
                this.showToast(data.error || 'Failed to resend ❌');
            }
        } catch (error) {
            this.showToast('Network error ❌');
        } finally {
            btn.textContent = 'Resend Code';
            btn.disabled = false;
        }
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

            if (response.ok && data.token) {
                await this.finishAuthSession(
                    data,
                    'Welcome back, ' + (data.user && data.user.display_name ? data.user.display_name : '') + '! 🎉'
                );
                if (data.needsEmailVerification) {
                    this.showToast('Signed in — confirm your email when you can 📧');
                }
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
        const inviteInput = document.getElementById('register-invite-code');
        const inviteCode = inviteInput ? inviteInput.value.trim() : '';
        const email = document.getElementById('register-email').value.trim();
        const password = document.getElementById('register-password').value;
        const submitBtn = document.querySelector('#register-form button[type="submit"]');

        if (!email || !password) {
            this.showToast('Enter your email and password ❌');
            return;
        }

        if (password.length < 8) {
            this.showToast('Password must be at least 8 characters ❌');
            return;
        }

        // Validate invite code if provided
        if (inviteCode) {
            try {
                const validateResponse = await fetch(`${this.apiBase}/auth/validate-invite`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ invite_code: inviteCode })
                });

                if (validateResponse.ok) {
                    const validateData = await validateResponse.json();
                    if (!validateData.valid) {
                        this.showToast(validateData.error || 'Invalid invite code ❌');
                        return;
                    }
                }
            } catch (error) {
                console.log('Skipping frontend invite validation');
            }
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating Account...';

        try {
            const response = await fetch(`${this.apiBase}/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    invite_code: inviteCode || undefined,
                    email,
                    password
                })
            });

            const data = await response.json();

            if (response.ok && data.token) {
                this._pendingVerifyEmail = data.email || email;
                await this.finishAuthSession(
                    data,
                    'Welcome to ViewHunt! Your 3 free ranking videos are ready 🎉'
                );
                if (data.needsEmailVerification) {
                    this.showToast('We emailed a confirm code — you can keep building now 📧');
                }
            } else {
                this.showToast(data.error || 'Registration failed ❌');
            }
        } catch (error) {
            console.error('Registration error:', error);
            this.showToast('Network error. Please try again ❌');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Start Free — 3 Videos';
        }
    }

    // Admin Panel Functions
    showAdminPanel() {
        document.getElementById('admin-overlay').style.display = 'flex';
        this.loadInviteCodes();
        
        // Set up form handler
        document.getElementById('invite-code-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.generateInviteCode();
        });
    }

    closeAdminPanel() {
        document.getElementById('admin-overlay').style.display = 'none';
    }

    async generateInviteCode() {
        const description = document.getElementById('invite-description').value;
        const maxUses = document.getElementById('invite-max-uses').value;
        const expiresDays = document.getElementById('invite-expires-days').value;
        const submitBtn = document.querySelector('#invite-code-form button[type="submit"]');

        submitBtn.disabled = true;
        submitBtn.textContent = 'Generating...';

        try {
            const response = await this.fetchWithAuth(`${this.apiBase}/admin/invite-codes`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    description: description,
                    max_uses: maxUses ? parseInt(maxUses) : null,
                    expires_in_days: expiresDays ? parseInt(expiresDays) : null
                })
            });

            const data = await response.json();

            if (response.ok) {
                this.showToast(`✅ Generated invite code: ${data.invite_code}`);
                
                // Copy to clipboard
                navigator.clipboard.writeText(data.invite_code).then(() => {
                    this.showToast('📋 Code copied to clipboard!');
                });
                
                // Clear form and reload list
                document.getElementById('invite-code-form').reset();
                this.loadInviteCodes();
            } else {
                this.showToast(data.error || 'Failed to generate invite code ❌');
            }
        } catch (error) {
            console.error('Error generating invite code:', error);
            this.showToast('Error generating invite code ❌');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Generate Code';
        }
    }

    async loadInviteCodes() {
        const listContainer = document.getElementById('invite-codes-list');
        
        try {
            const response = await this.fetchWithAuth(`${this.apiBase}/admin/invite-codes`);
            const data = await response.json();

            if (response.ok) {
                const codes = data.invite_codes;
                
                if (codes.length === 0) {
                    listContainer.innerHTML = '<p style="color: #888;">No invite codes yet.</p>';
                    return;
                }

                listContainer.innerHTML = codes.map(code => `
                    <div style="border: 1px solid #333; padding: 10px; margin: 5px 0; border-radius: 5px; background: #1a1a1a;">
                        <div style="font-weight: bold; color: #4ade80;">${code.code}</div>
                        <div style="font-size: 12px; color: #888;">${code.description}</div>
                        <div style="font-size: 11px; color: #666;">
                            Used: ${code.used_count}${code.max_uses ? `/${code.max_uses}` : ''} | 
                            Created: ${new Date(code.created_at).toLocaleDateString()} |
                            ${code.active ? '<span style="color: #4ade80;">Active</span>' : '<span style="color: #ef4444;">Inactive</span>'}
                        </div>
                        ${code.active ? `<button onclick="window.app.deactivateInviteCode('${code.code}', ${code.used_count})" style="background: #ef4444; color: white; border: none; padding: 2px 8px; border-radius: 3px; font-size: 11px; margin-top: 5px;">Deactivate (${code.used_count} users affected)</button>` : ''}
                    </div>
                `).join('');
            } else {
                listContainer.innerHTML = '<p style="color: #ef4444;">Failed to load invite codes</p>';
            }
        } catch (error) {
            console.error('Error loading invite codes:', error);
            listContainer.innerHTML = '<p style="color: #ef4444;">Error loading invite codes</p>';
        }
    }

    async deactivateInviteCode(code, usedCount) {
        const message = usedCount > 0 
            ? `Deactivate invite code ${code}?\n\nThis will revoke access for ${usedCount} user(s) who registered with this code.`
            : `Deactivate invite code ${code}?`;
            
        if (!confirm(message)) return;

        try {
            const response = await this.fetchWithAuth(`${this.apiBase}/admin/invite-codes/${code}/deactivate`, {
                method: 'PATCH'
            });

            const data = await response.json();

            if (response.ok) {
                this.showToast(`✅ Deactivated invite code: ${code}`);
                this.loadInviteCodes();
            } else {
                this.showToast(data.error || 'Failed to deactivate invite code ❌');
            }
        } catch (error) {
            console.error('Error deactivating invite code:', error);
            this.showToast('Error deactivating invite code ❌');
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
            } else if (type === 'invite') {
                statusText.textContent = 'Invite Access';
            } else if (type === 'free') {
                statusIndicator.style.color = '#fbbf24'; // Amber for free
                statusText.textContent = 'Free Tier (10 niches/day)';
                subscriptionActions.style.display = 'block';
                subscriptionActions.innerHTML = '<button class="user-menu-item" onclick="window.location.href=\'/pricing\'">Upgrade Plan</button>';
            } else if (type === 'stripe') {
                statusText.textContent = 'Pro Subscription';
                subscriptionActions.style.display = 'block';
            }
        } else {
            statusIndicator.style.color = '#ef4444'; // Red
            statusText.textContent = reason || 'Member Access Required';
            subscriptionActions.style.display = 'none';
        }
    }

    manageSubscription() {
        // Open subscription management page
        window.open('/manage-subscription', '_blank');
    }

    handleOAuthCallback() {
        const urlParams = new URLSearchParams(window.location.search);
        const token = urlParams.get('token');
        const success = urlParams.get('success');
        const error = urlParams.get('error');

        if (token) {
            localStorage.setItem('viewhunt_token', token);
            this.token = token;
            this.authToken = token;
            window.history.replaceState({}, document.title, window.location.pathname);

            if (success === 'google_login') {
                this.showToast('Welcome! Signed in with Google 🎉');
            }
            var self = this;
            Promise.resolve()
                .then(function() { return self.checkAuthStatus(); })
                .then(function() { return self.checkSubscriptionStatus(); })
                .then(function() { self.updateEmailVerifyBanner(); })
                .then(function() { return self.handlePostAuthRedirect(); })
                .catch(function(e) { console.warn('OAuth post-auth:', e); });
        } else if (error) {
            window.history.replaceState({}, document.title, window.location.pathname);
            if (error === 'oauth_failed') {
                this.showToast('Google sign-in failed. Please try again. ❌');
            } else {
                this.showToast('Sign-in error: ' + decodeURIComponent(error) + ' ❌');
            }
        }
    }

    async signInWithGoogle() {
        // Redirect to Google OAuth using the correct base URL
        const baseUrl = window.location.origin;
        window.location.href = `${baseUrl}/auth/google`;
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
                <button class="btn btn-secondary" onclick="window.app.showSaveToAnotherCollection('${channel._id}')">
                    📚 Save to Another
                </button>
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

    // Save to Another Collection functionality (for channels already in a collection)
    async showSaveToAnotherCollection(channelId) {
        if (!this.token) {
            this.showLogin();
            this.showToast('Please sign in to save channels 🔐');
            return;
        }

        // Load collections if not already loaded
        if (this.collections.length === 0) {
            await this.loadCollections();
        }

        // Filter out the current collection from the options
        const availableCollections = this.collections.filter(collection => 
            collection._id !== this.currentCollection._id
        );

        if (availableCollections.length === 0) {
            this.showToast('No other collections available. Create a new collection first! 📚');
            return;
        }

        // Show collection selector modal for other collections
        this.showAnotherCollectionSelector(channelId, availableCollections);
    }

    showAnotherCollectionSelector(channelId, availableCollections) {
        // Create collection selector modal
        const overlay = document.createElement('div');
        overlay.className = 'auth-overlay';
        overlay.style.display = 'flex';
        overlay.id = 'another-collection-selector-overlay';

        overlay.innerHTML = `
            <div class="auth-modal">
                <div class="auth-form">
                    <h2>Save to Another Collection</h2>
                    <p class="auth-subtitle">Choose another collection for this channel</p>
                    
                    <div class="collection-selector">
                        ${availableCollections.map(collection => `
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
                        <button class="auth-btn auth-btn-primary" id="save-to-another-collection-btn" disabled>Save to Collection</button>
                    </div>
                </div>
                <button class="auth-close" onclick="this.closest('.auth-overlay').remove()">×</button>
            </div>
        `;

        document.body.appendChild(overlay);

        // Add click handlers for collection options
        let selectedCollectionId = null;
        const saveBtn = overlay.querySelector('#save-to-another-collection-btn');

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
                    this.showToast('Channel saved to another collection! 📚✅');
                } else {
                    const data = await response.json();
                    if (data.error && data.error.includes('already exists')) {
                        this.showToast('Channel is already in that collection! 📚');
                    } else {
                        this.showToast(data.error || 'Error saving channel ❌');
                    }
                }
            } catch (error) {
                console.error('Error saving to another collection:', error);
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
            // Check subscription access first (but allow admin, beta, and invite users)
            if (!this.hasSubscriptionAccess()) {
                content.innerHTML = `
                    <div class="subscription-required">
                        <div class="lock-icon">🔒</div>
                        <h4>Member Access Required</h4>
                        <p>Kevis's exclusive picks are available to ViewHunt members only.</p>
                        <button class="btn btn-secondary" onclick="window.app.showLogin()">
                            Already Have Access?
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
                            <h4>Member Access Required</h4>
                            <p>Kevis's exclusive picks are available to ViewHunt members only.</p>
                            <button class="btn btn-secondary" onclick="window.app.showMessage('Contact support for access assistance', 'info')">
                                Need Access?
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
            // Check subscription access first (but allow admin, beta, and invite users)
            if (!this.hasSubscriptionAccess()) {
                content.innerHTML = `
                    <div class="subscription-required">
                        <div class="lock-icon">🔒</div>
                        <h4>Member Access Required</h4>
                        <p>Trending channels are available to ViewHunt members only.</p>
                        <button class="btn btn-secondary" onclick="window.app.showMessage('Contact support for access assistance', 'info')">
                            Need Access?
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
                // Handle member access required error
                content.innerHTML = `
                    <div class="subscription-required">
                        <div class="lock-icon">🔒</div>
                        <h4>Member Access Required</h4>
                        <p>Trending channels are available to ViewHunt members only.</p>
                        <button class="btn btn-secondary" onclick="window.app.showMessage('Contact support for access assistance', 'info')">
                            Need Access?
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