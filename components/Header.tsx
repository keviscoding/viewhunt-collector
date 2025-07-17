
import React from 'react';
import { LogoIcon } from './Icons';

export const Header: React.FC = () => {
  return (
    <header className="text-center">
      <div className="inline-flex items-center gap-4 bg-gray-800/50 px-6 py-3 rounded-full ring-1 ring-white/10">
        <LogoIcon className="w-10 h-10 text-cyan-400" />
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white">
          ViewHunt Collector
        </h1>
      </div>
      <p className="mt-4 max-w-2xl mx-auto text-lg text-gray-400">
        This tool uses AI to discover untapped YouTube Shorts niches by finding channels with high view-to-subscriber ratios across various keywords.
      </p>
    </header>
  );
};
