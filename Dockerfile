# Use Node base image
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

# Create app directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package.json ./
RUN npm install

# Copy the rest of your files
COPY . .

# Make port available
EXPOSE 3000

# Default command
CMD ["node", "index.js"]
