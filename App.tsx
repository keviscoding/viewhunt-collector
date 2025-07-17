
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Header } from './components/Header';
import { ControlPanel } from './components/ControlPanel';
import { ResultsTable } from './components/ResultsTable';
import { downloadCSV } from './utils/csvHelper';
import type { ChannelData, ScrapedVideoData } from './types';

const App: React.FC = () => {
  const [status, setStatus] = useState<string>('Idle. Press "Start Processing" to begin.');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [results, setResults] = useState<ChannelData[]>([]);
  
  const stopProcessingRef = useRef<boolean>(false);

  // Listen for messages from background script
  useEffect(() => {
    const messageListener = (message: any) => {
      if (message.type === 'statusUpdate' && message.data) {
        setStatus(message.data.status);
        setIsProcessing(message.data.isProcessing);
        
        if (message.data.results && message.data.results.length > 0) {
          // Convert scraped data to ChannelData format
          const formattedResults: ChannelData[] = message.data.results.map((item: ScrapedVideoData) => ({
            channelName: item.channelName,
            channelUrl: item.channelUrl,
            viewCount: item.viewCount,
            videoTitle: item.videoTitle,
            viewToSubRatio: undefined // We can't calculate this without subscriber data
          }));
          
          // Sort by view count since we don't have subscriber data
          const sortedResults = formattedResults.sort((a, b) => b.viewCount - a.viewCount);
          setResults(sortedResults);
        }
      }
    };

    // Add listener for Chrome extension messages
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.onMessage.addListener(messageListener);
      
      // Clean up listener on unmount
      return () => {
        chrome.runtime.onMessage.removeListener(messageListener);
      };
    }
  }, []);

  const handleStart = useCallback(async () => {
    if (typeof chrome === 'undefined' || !chrome.runtime) {
      setStatus('Error: Chrome extension API not available.');
      return;
    }

    setIsProcessing(true);
    setResults([]);
    stopProcessingRef.current = false;
    setStatus('Starting automated YouTube search and scroll process...');
    
    try {
      // Send message to background script to start processing
      chrome.runtime.sendMessage({ command: 'start' });
    } catch (error) {
      console.error('Error starting processing:', error);
      setStatus('Error: Failed to start processing. Check if extension is properly loaded.');
      setIsProcessing(false);
    }
  }, []);

  const handleStop = useCallback(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime) {
      setStatus('Error: Chrome extension API not available.');
      return;
    }

    stopProcessingRef.current = true;
    setStatus('Stopping process...');
    
    try {
      // Send message to background script to stop processing
      chrome.runtime.sendMessage({ command: 'stop' });
    } catch (error) {
      console.error('Error stopping processing:', error);
      setStatus('Error: Failed to stop processing.');
    }
  }, []);

  const handleDownload = useCallback(() => {
    if (results.length === 0) {
      setStatus('No data to download.');
      return;
    }
    setStatus('Preparing download...');
    downloadCSV(results, 'viewhunt_results.csv');
    setStatus(`Downloaded ${results.length} videos. Process is complete.`);
  }, [results]);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex flex-col items-center p-4 sm:p-6 lg:p-8">
      <div className="w-full max-w-7xl mx-auto">
        <Header />
        <main className="mt-8 bg-gray-800/50 backdrop-blur-sm rounded-2xl shadow-2xl shadow-black/20 ring-1 ring-white/10">
          <div className="p-6 border-b border-white/10">
            <ControlPanel
              status={status}
              isProcessing={isProcessing}
              onStart={handleStart}
              onStop={handleStop}
            />
          </div>
          <ResultsTable data={results} onDownload={handleDownload} />
        </main>
      </div>
    </div>
  );
};

export default App;
