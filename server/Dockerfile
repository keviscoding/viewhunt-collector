FROM node:18

WORKDIR /workspace/server

# Install FFmpeg for video assembly
RUN apt-get update && apt-get install -y ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy server source code
COPY . .

# Verify public files exist
RUN ls -la public/ || echo "No public directory"
RUN ls -la public/index.html || echo "No index.html"

# Expose port
EXPOSE 8080

# Start the application
CMD ["npm", "start"]