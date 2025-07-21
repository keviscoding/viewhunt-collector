FROM node:18

WORKDIR /workspace/server

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