import express, { Request, Response, NextFunction } from 'express';
import * as http from 'http';
import * as path from 'path';
import { selectionStore } from '../store/selectionStore';
import { getAssetsDir } from '../store/imageStorage';
import { SelectionPayload, ImageBatchPayload, ImageAsset } from '../types/selection';

const PORT = parseInt(process.env.BRIDGE_PORT || '3050', 10);
const HOST = '0.0.0.0'; // bind all interfaces — handles both 127.0.0.1 and ::1 (IPv6 localhost)

let httpServer: http.Server | undefined;
let bridgeStatus: 'stopped' | 'running' | 'error' = 'stopped';

export function getBridgeStatus(): typeof bridgeStatus { return bridgeStatus; }

/** Serve an image asset from the in-memory base64 data (fallback when file is missing). */
function serveFromMemory(asset: ImageAsset, res: Response): void {
  if (asset.format === 'svg') {
    const svgText = Buffer.from(asset.data, 'base64').toString('utf-8');
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svgText);
  } else {
    const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    const buffer = Buffer.from(asset.data, 'base64');
    res.setHeader('Content-Type', mimeMap[asset.format] || 'image/png');
    res.setHeader('Content-Length', buffer.length.toString());
    res.send(buffer);
  }
}

function setCorsHeaders(req: Request, res: Response): void {
  const origin = req.headers.origin ?? '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (origin !== '*') {
    res.setHeader('Vary', 'Origin');
  }
}

function createApp(): express.Application {
  const app = express();

  // CORS MUST run before body parsing — otherwise a 413/400 from the JSON
  // parser will lack CORS headers and the browser will hide the real error.
  app.use((req: Request, res: Response, next: NextFunction) => {
    setCorsHeaders(req, res);
    next();
  });

  // Handle CORS pre-flight (before body parser touches the stream)
  app.options('*', (_req: Request, res: Response) => {
    res.sendStatus(204);
  });

  // Parse JSON bodies — 50 MB limit to handle base64 image batches
  app.use(express.json({ limit: '50mb' }));

  // ── Static serving of figma-assets/ ─────────────────────────────────────────
  // Exposes stored image files at /figma-assets/<filename>
  app.use('/figma-assets', express.static(getAssetsDir()));

  // ── POST /selection ─────────────────────────────────────────────────────────
  // Figma plugin pushes the selected node here (design tree, no image data).
  app.post('/selection', (req: Request, res: Response): void => {
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
      images: {},
      timestamp: Date.now(),
    });
    res.json({ ok: true });
  });

  // ── POST /selection/images ────────────────────────────────────────────────
  // Figma plugin pushes individual image assets (IMAGE fills + vector SVGs).
  app.post('/selection/images', (req: Request, res: Response): void => {
    const body = (req.body || {}) as Partial<ImageBatchPayload>;
    const { nodeId, assets } = body;

    if (!nodeId || !assets || !Array.isArray(assets)) {
      res.status(400).json({ error: 'Invalid payload. Required: nodeId, assets[]' });
      return;
    }

    const ok = selectionStore.setImages(nodeId, assets);
    if (!ok) {
      res.status(409).json({ error: 'Selection changed; images discarded' });
      return;
    }

    console.error(`[Figma Bridge] ${assets.length} image asset(s) saved to disk for node ${nodeId}`);
    console.error(`[Figma Bridge] Assets dir: ${getAssetsDir()}`);
    res.json({ ok: true, count: assets.length, assetsDir: getAssetsDir() });
  });

  // ── GET /selection/images ─────────────────────────────────────────────────
  // List all image assets (metadata only, no raw data).
  app.get('/selection/images', (_req: Request, res: Response): void => {
    const list = selectionStore.listImages();
    res.json({ status: 'ok', count: list.length, assets: list });
  });

  // ── GET /selection/images/:id ─────────────────────────────────────────────
  // Return a specific image asset by ID. Serves the file from disk if available.
  app.get('/selection/images/:id', (req: Request, res: Response): void => {
    const imageId = typeof req.params.id === 'string' ? req.params.id : String(req.params.id);
    const asset = selectionStore.getImage(imageId);
    if (!asset) {
      res.status(404).json({ error: 'Image not found', id: imageId });
      return;
    }

    // Prefer serving the file from disk.
    if (asset.filePath) {
      res.sendFile(asset.filePath, (err) => {
        if (err) {
          // Fallback to in-memory data if file is missing.
          serveFromMemory(asset, res);
        }
      });
      return;
    }

    serveFromMemory(asset, res);
  });

  // ── GET /selection ───────────────────────────────────────────────────────────
  // MCP tool reads the latest stored selection (image raw data is stripped).
  app.get('/selection', (_req: Request, res: Response): void => {
    const current = selectionStore.get();
    if (!current) {
      res.status(404).json({ error: 'No active selection' });
      return;
    }
    // Return selection with image metadata (no raw data)
    const { images, ...rest } = current;
    const imageSummary = selectionStore.listImages();
    res.json({
      status: 'ok',
      selection: rest,
      images: { count: imageSummary.length, assets: imageSummary },
      assetsDir: getAssetsDir(),
    });
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
  app.use((err: any, req: Request, res: Response, _next: NextFunction): void => {
    console.error('[Figma Bridge] Unhandled error:', err.message);
    // Ensure CORS headers are present even on error responses.
    setCorsHeaders(req, res);
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
