
export interface ChannelData {
  channelName: string;
  channelUrl: string;
  viewCount: number;
  videoTitle: string;
  subscriberCount?: number; // Now included from channel scraping
  viewToSubRatio?: number; // Calculated ratio
}

// Type for the data coming from content script (video search results)
export interface ScrapedVideoData {
  channelName: string;
  channelUrl: string;
  viewCount: number;
  videoTitle: string;
}

// Type for channel subscriber data from channel-scraper.js
export interface ChannelSubscriberData {
  channelUrl: string;
  subscriberCount: number;
  subscriberText: string;
  error?: string;
}

// Message types for communication between frontend and background script
export interface BackgroundMessage {
  type: 'start-processing' | 'stop-processing' | 'get-status' | 'get-results';
}

export interface StatusUpdateMessage {
  type: 'statusUpdate';
  data: {
    status: string;
    isProcessing: boolean;
    results: ChannelData[];
  };
}
