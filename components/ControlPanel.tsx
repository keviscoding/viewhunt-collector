
import React from 'react';
import { PlayIcon, StopIcon } from './Icons';

interface ControlPanelProps {
  status: string;
  isProcessing: boolean;
  onStart: () => void;
  onStop: () => void;
}

export const ControlPanel: React.FC<ControlPanelProps> = ({ status, isProcessing, onStart, onStop }) => {
  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
      <div className="flex-1">
        <h2 className="text-sm font-medium text-gray-400">STATUS</h2>
        <p className="text-lg text-white mt-1 min-h-[28px]">{status}</p>
      </div>
      <div className="flex items-center gap-3">
        {!isProcessing ? (
          <button
            onClick={onStart}
            disabled={isProcessing}
            className="inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold text-white bg-cyan-500 rounded-lg shadow-sm hover:bg-cyan-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <PlayIcon className="w-5 h-5" />
            Start Processing
          </button>
        ) : (
          <button
            onClick={onStop}
            disabled={!isProcessing}
            className="inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold text-white bg-red-600 rounded-lg shadow-sm hover:bg-red-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <StopIcon className="w-5 h-5" />
            Stop Processing
          </button>
        )}
      </div>
    </div>
  );
};
