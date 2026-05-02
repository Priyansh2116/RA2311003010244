import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as dotenv from 'dotenv';
import { Log, setAuthToken } from '../../logging_middleware/src/index';
import notificationRoutes from './routes/notifications';

dotenv.config();

const MODULE_ID = 'notification_app_be';
const SERVER_PORT = parseInt(process.env.PORT ?? '3000', 10);

// wire the auth tken into the logging middleware at startup 
//
const authToken = process.env.AUTH_TOKEN ?? '';
if (authToken) setAuthToken(authToken);


// Express application

const app = express();

app.use(cors());
app.use(express.json());
app.use('/api/v1/notifications', notificationRoutes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});


// WebSocket 


// sharing the HTTP server so tht WebSocket and REST are  on a single port

const httpServer = http.createServer(app);
const socketServer = new WebSocketServer({ server: httpServer, path: '/ws/notifications' });

const activeConnections = new Set<WebSocket>();

function handleSocketConnection(socket: WebSocket): void {
  activeConnections.add(socket);

  // confirm subscription as soon as it has succeeded
  socket.send(JSON.stringify({ event: 'connected', message: 'Subscribed to campus notifications' }));

  socket.on('close', async () => {
    activeConnections.delete(socket);
    await Log('WebSocketServer.close', 'INFO', MODULE_ID, `Client disconnected. Active connections: ${activeConnections.size}`);
  });

  socket.on('error', async (err) => {
    await Log('WebSocketServer.error', 'ERROR', MODULE_ID, `Socket error: ${err.message}`);
  });
}

socketServer.on('connection', async (socket) => {
  await Log('WebSocketServer.connection', 'INFO', MODULE_ID, `New WebSocket client. Total active: ${activeConnections.size + 1}`);
  handleSocketConnection(socket);
});

export function broadcastNotification(notification: object): void {
  const payload = JSON.stringify({ event: 'new_notification', data: notification });

  activeConnections.forEach((socket) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  });
}

// Boot


httpServer.listen(SERVER_PORT, async () => {
  await Log('server.boot', 'INFO', MODULE_ID, `Campus Notification service ready — HTTP on port ${SERVER_PORT}`);
  await Log('server.boot', 'INFO', MODULE_ID, `WebSocket endpoint: ws://localhost:${SERVER_PORT}/ws/notifications`);
  await Log('server.boot', 'INFO', MODULE_ID, `Health endpoint: http://localhost:${SERVER_PORT}/health`);
});
