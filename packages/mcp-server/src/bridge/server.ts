import express, { Request, Response, NextFunction } from 'express';
import * as http from 'http';
import { selectionStore } from '../store/selectionStore';
import { SelectionPayload } from '../types/selection';

const PORT = parseInt(process.env.BRIDGE_PORT || '3050', 10);
const HOST = '0.0.0.0'; // bind all interfaces — handles both 127.0.0.1 and ::1 (IPv6 localhost)

let httpServer: http.Server | undefined;
let bridgeStatus: 'stopped' | 'running' | 'error' = 'stopped';

export function getBridgeStatus(): typeof bridgeStatus { return bridgeStatus; }

function createApp(): express.Application {
  const app = express();

  // Parse JSON bodies — 10 MB limit to handle large Figma design trees
  app.use(express.json({ limit: '10mb' }));

  // CORS — Figma plugin UI iframe sends Origin: null (sandboxed context).
  // Reflecting the origin header back (instead of using '*') is the only way
  // to satisfy browsers when origin is 'null'.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const origin = _req.headers.origin ?? '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (origin !== '*') {
      res.setHeader('Vary', 'Origin');
    }
    next();
  });

  // Handle CORS pre-flight
  app.options('*', (_req: Request, res: Response) => {
    res.sendStatus(204);
  });

  // ── POST /selection ─────────────────────────────────────────────────────────
  // Figma plugin pushes the selected node here.
  app.post('/selection', (req: Request, res: Response): void => {
    // req.body is undefined when Content-Type is missing or body parsing failed
    const body = (req.body || {}) as Partial<SelectionPayload>;
    const { fileId, nodeId, pageId, userId, metadata, designTree } = body;

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
  app.use((err: any, _req: Request, res: Response, _next: NextFunction): void => {
    console.error('[Figma Bridge] Unhandled error:', err.message);
    // Propagate the correct status code:
    //   PayloadTooLargeError (body > limit) → 413
    //   SyntaxError (malformed JSON)        → 400
    //   everything else                     → 500
    const status: number =
      err.status ?? err.statusCode ??
      (err.type === 'entity.too.large' ? 413 :
       err instanceof SyntaxError     ? 400 : 500);
    res.status(status).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

/**
 * Start the HTTP bridge.
 * Called from index.ts at startup.
 */
export function startBridge(): void {
  if (httpServer) {
    console.error('[Figma Bridge] Already running');
    return;
  }

  const app = createApp();

  httpServer = app.listen(PORT, HOST, () => {
    bridgeStatus = 'running';
    console.error(`[Figma Bridge] Listening on ${HOST}:${PORT}`);
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    bridgeStatus = 'error';
    httpServer = undefined;
    if (err.code === 'EADDRINUSE') {
      console.error(`[Figma Bridge] Port ${PORT} already in use — bridge unavailable`);
    } else {
      console.error('[Figma Bridge] Server error:', err.message);
    }
  });
}

/**
 * Stop the HTTP bridge.
 */
export function stopBridge(): void {
  httpServer?.close(() => {
    console.error('[Figma Bridge] Stopped');
  });
  httpServer = undefined;
  bridgeStatus = 'stopped';
}
