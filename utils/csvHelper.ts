
import type { ChannelData } from '../types';

export const downloadCSV = (data: ChannelData[], filename: string): void => {
  if (data.length === 0) {
    console.warn("No data provided to downloadCSV.");
    return;
  }

  const headers = ['Channel Name', 'Video Title', 'Video Views', 'Channel URL'];
  const csvRows = [headers.join(',')];

  // Sort by view count (highest first) since we don't have subscriber data
  const sortedData = [...data].sort((a, b) => b.viewCount - a.viewCount);

  for (const row of sortedData) {
    const values = [
      `"${row.channelName.replace(/"/g, '""')}"`,
      `"${row.videoTitle.replace(/"/g, '""')}"`,
      row.viewCount,
      row.channelUrl
    ];
    csvRows.push(values.join(','));
  }

  const csvString = csvRows.join('\n');
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });

  const link = document.createElement('a');
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
};
