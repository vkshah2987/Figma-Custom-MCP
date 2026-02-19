import express, { Request, Response, NextFunction } from 'express';
import * as http from 'http';
import { selectionStore } from '../store/selectionStore';
import { SelectionPayload } from '../types/selection';

const PORT = 3050;
const HOST = 'localhost'; // match what the Figma plugin fetches

let httpServer: http.Server | undefined;
let bridgeStatus: 'stopped' | 'running' | 'error' = 'stopped';
let onStatusChange: ((s: typeof bridgeStatus) => void) | undefined;

export function getBridgeStatus(): typeof bridgeStatus { return bridgeStatus; }
export function onBridgeStatusChange(cb: (s: typeof bridgeStatus) => void): void { onStatusChange = cb; }

function createApp(): express.Application {
  const app = express();

  // Parse JSON bodies
  app.use(express.json());

  // CORS — Figma plugin UI iframe needs these headers to make fetch() calls
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  // Handle CORS pre-flight
  app.options('*', (_req: Request, res: Response) => {
    res.sendStatus(204);
  });

  // ── POST /selection ─────────────────────────────────────────────────────────
  // Figma plugin pushes the selected node here.
  app.post('/selection', (req: Request, res: Response): void => {
    const { fileId, nodeId, pageId, userId, metadata, designTree } = req.body as Partial<SelectionPayload>;

    if (!fileId || !nodeId || !metadata) {
      res.status(400).json({
        error: 'Invalid payload. Required fields: fileId, nodeId, metadata',
        received: Object.keys(req.body || {}),
      });
      return;
    }

    selectionStore.set({
      fileId,
      nodeId,
      pageId: pageId || 'unknown',
      userId: userId || 'anonymous',
      metadata,
      designTree,
      timestamp: Date.now(),
    });
    res.json({ ok: true });
  });

  // ── GET /selection ───────────────────────────────────────────────────────────
  // MCP tool (or anyone) reads the latest stored selection from here.
  app.get('/selection', (_req: Request, res: Response): void => {
    const current = selectionStore.get();
    if (!current) {
      res.status(404).json({ error: 'No active selection' });
      return;
    }
    res.json({ status: 'ok', selection: current });
  });

  // ── GET /health ──────────────────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response): void => {
    res.json({ status: 'healthy', timestamp: Date.now() });
  });

  // ── DELETE /selection ────────────────────────────────────────────────────────
  // Allow the plugin or developer to clear the stored selection.
  app.delete('/selection', (_req: Request, res: Response): void => {
    selectionStore.clear();
    res.json({ ok: true });
  });

  // ── Unhandled routes ─────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response): void => {
    res.status(404).json({ error: 'Not found' });
  });

  // ── Error handler ────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
    console.error('[Figma Bridge] Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

/**
 * Start the HTTP bridge.
 * Called from extension.ts activate().
 */
export function startBridge(): void {
  if (httpServer) {
    console.warn('[Figma Bridge] Already running');
    return;
  }

  const app = createApp();

  httpServer = app.listen(PORT, HOST, () => {
    bridgeStatus = 'running';
    onStatusChange?.(bridgeStatus);
    console.log(`[Figma Bridge] Listening on ${HOST}:${PORT}`);
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    bridgeStatus = 'error';
    onStatusChange?.(bridgeStatus);
    httpServer = undefined;
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Figma Bridge] Port ${PORT} already in use — bridge unavailable`);
    } else {
      console.error('[Figma Bridge] Server error:', err.message);
    }
  });
}

/**
 * Stop the HTTP bridge.
 * Called from extension.ts deactivate().
 */
export function stopBridge(): void {
  httpServer?.close(() => {
    console.log('[Figma Bridge] Stopped');
  });
  httpServer = undefined;
  bridgeStatus = 'stopped';
  onStatusChange?.(bridgeStatus);
}
