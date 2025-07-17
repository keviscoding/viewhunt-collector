FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy server source code
COPY . .

# Create directory for database
RUN mkdir -p /app/data

# Expose port
EXPOSE 8080

# Start the application
CMD ["npm", "start"]