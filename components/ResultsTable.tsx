
import React from 'react';
import type { ChannelData } from '../types';
import { DownloadIcon, TableIcon } from './Icons';

interface ResultsTableProps {
  data: ChannelData[];
  onDownload: () => void;
}

const TableHeader: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-white sm:pl-3 sticky top-0 bg-gray-800/80 backdrop-blur-sm">
        {children}
    </th>
);

export const ResultsTable: React.FC<ResultsTableProps> = ({ data, onDownload }) => {
  return (
    <div className="p-4 sm:p-6">
        <div className="sm:flex sm:items-center sm:justify-between">
            <h3 className="text-base font-semibold leading-6 text-white">Discovered Videos (Quota-Optimized Results)</h3>
            <div className="mt-3 sm:ml-4 sm:mt-0">
                <button
                    type="button"
                    onClick={onDownload}
                    disabled={data.length === 0}
                    className="inline-flex items-center gap-2 rounded-md bg-white/10 px-3 py-2 text-sm font-semibold text-white shadow-sm ring-1 ring-inset ring-white/20 hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                    <DownloadIcon className="w-5 h-5" />
                    Download as CSV
                </button>
            </div>
        </div>

        <div className="mt-4 flow-root">
            <div className="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
                <div className="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
                    {data.length > 0 ? (
                        <div className="max-h-[60vh] overflow-y-auto ring-1 ring-white/10 rounded-lg">
                            <table className="min-w-full divide-y divide-white/10">
                                <thead>
                                    <tr>
                                        <TableHeader>Channel Name</TableHeader>
                                        <TableHeader>Subscriber Count</TableHeader>
                                        <TableHeader>Video Views</TableHeader>
                                        <TableHeader>View/Sub Ratio</TableHeader>
                                        <TableHeader>Video Title</TableHeader>
                                        <TableHeader>Channel URL</TableHeader>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-800">
                                    {data.map((item, index) => (
                                        <tr key={`${item.channelUrl}-${index}`} className="hover:bg-gray-700/50 transition-colors">
                                            <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-white sm:pl-3">{item.channelName}</td>
                                            <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-300">
                                                {item.subscriberCount > 0 ? 
                                                    item.subscriberCount.toLocaleString() : 
                                                    <span className="text-yellow-400" title="Subscriber data unavailable - will need manual check">N/A</span>
                                                }
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-4 text-sm text-cyan-400 font-semibold">{item.viewCount.toLocaleString()}</td>
                                            <td className="whitespace-nowrap px-3 py-4 text-sm text-green-400 font-bold">
                                                {item.viewToSubRatio > 0 ? 
                                                    item.viewToSubRatio.toFixed(2) : 
                                                    <span className="text-gray-500">N/A</span>
                                                }
                                            </td>
                                            <td className="px-3 py-4 text-sm text-gray-300 max-w-xs truncate" title={item.videoTitle}>{item.videoTitle}</td>
                                            <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-300">
                                                <a href={item.channelUrl} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300">
                                                    Visit Channel
                                                </a>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className="text-center py-16 px-6 border-2 border-dashed border-gray-700 rounded-lg">
                            <TableIcon className="mx-auto h-12 w-12 text-gray-500" />
                            <h3 className="mt-2 text-sm font-semibold text-white">No data yet</h3>
                            <p className="mt-1 text-sm text-gray-400">Start the process to discover YouTube Shorts videos. Uses quota-efficient API calls for subscriber data.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    </div>
  );
};
