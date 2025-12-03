# Node.js Backend Starter

## Overview
A minimal Node.js backend using Express.js with a basic health check endpoint.

## Project Structure
- `index.js` - Main entry point with Express server configuration
- `package.json` - Node.js dependencies and project metadata

## Running the Server
The server runs on port 3000. Start it with:
```bash
node index.js
```

## API Endpoints

### GET /ping
Health check endpoint.

**Response:**
```json
{
  "status": "ok"
}
```

## Recent Changes
- December 2, 2025: Initial project setup with Express server and /ping endpoint
