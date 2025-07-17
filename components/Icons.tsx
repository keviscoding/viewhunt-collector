
import React from 'react';

type IconProps = {
  className?: string;
};

export const PlayIcon: React.FC<IconProps> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
    <path fillRule="evenodd" d="M2 10a8 8 0 1 1 16 0 8 8 0 0 1-16 0Zm6.39-2.908a.75.75 0 0 1 .98 0l4.25 3.5a.75.75 0 0 1 0 1.316l-4.25 3.5a.75.75 0 0 1-.98-1.316L12.492 10 8.39 7.092Z" clipRule="evenodd" />
  </svg>
);

export const StopIcon: React.FC<IconProps> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
    <path fillRule="evenodd" d="M2 10a8 8 0 1 1 16 0 8 8 0 0 1-16 0Zm5-2.25A.75.75 0 0 1 7.75 7h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-.75.75h-4.5a.75.75 0 0 1-.75-.75v-4.5Z" clipRule="evenodd" />
  </svg>
);

export const DownloadIcon: React.FC<IconProps> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
        <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
        <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
    </svg>
);

export const LogoIcon: React.FC<IconProps> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
        <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 15.75-2.489-2.489m0 0a3.375 3.375 0 1 0-4.773-4.773 3.375 3.375 0 0 0 4.774 4.774ZM21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
);

export const TableIcon: React.FC<IconProps> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className={className}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.375 .5-1.037 1.037 0 0 0-.993 1.253H5.25c-.495 0-.934-.44-1.125-1.007A3 3 0 0 1 3.75 16.5V6.75a3 3 0 0 1 .375-.5c.348-.868.993-1.253 1.125-1.253h1.5a3 3 0 0 1 .375.5c.348.868.993 1.253 1.125 1.253h1.5c.495 0 .934.44 1.125 1.007.348.868.375 1.5.375 1.5v1.007M9 17.25v-1.5" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 17.25v1.007a3 3 0 0 1-.375.5-1.037 1.037 0 0 0-.993 1.253H9.75c-.495 0-.934-.44-1.125-1.007A3 3 0 0 1 8.25 16.5V6.75a3 3 0 0 1 .375-.5c.348-.868.993-1.253 1.125-1.253h1.5a3 3 0 0 1 .375.5c.348.868.993 1.253 1.125 1.253h1.5c.495 0 .934.44 1.125 1.007.348.868.375 1.5.375 1.5v1.007m-5.25-2.25v-1.5" />
    </svg>
);
