/**
 * Figma MCP Selection Bridge — Plugin Code
 *
 * Runs inside the Figma sandbox. Detects selection changes
 * and pushes the selection context to the MCP server via the UI bridge.
 * Extracts individual image assets (IMAGE fills + vector SVGs) for code generation.
 */

// ─── Configuration ───
const MCP_SERVER_URL = 'http://localhost:3050';
const DEBOUNCE_MS = 150;
const MAX_TREE_DEPTH = 15;       // Design tree extraction depth
const MAX_IMAGE_SCAN_DEPTH = 30; // Image asset scanning depth (deep into instances)
const MAX_IMAGE_ASSETS = 50;
const MAX_VECTOR_ASSETS = 30;
const MAX_COMPOSITE_ASSETS = 20; // INSTANCE/COMPONENT nodes exported as composed PNG
const COMPOSITE_MAX_PX = 512;    // Cap composite exports at this pixel dimension

// ─── State ───
let debounceTimer: number | null = null;
let lastNodeId: string | null = null;
let selectionSeq = 0;

// ─── Plugin Entry ───
figma.showUI(__html__, { width: 320, height: 400, visible: true });

// Send initial state
figma.ui.postMessage({
  type: 'init',
  serverUrl: MCP_SERVER_URL,
  userId: figma.currentUser?.id || 'anonymous',
  userName: figma.currentUser?.name || 'Unknown User',
});

// ─── Base64 encoder (works in Figma sandbox without btoa) ───
function uint8ToBase64(u8: Uint8Array): string {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const len = u8.length;
  const parts: string[] = [];
  for (let i = 0; i < len; i += 3) {
    parts.push(CHARS[u8[i] >> 2]);
    parts.push(CHARS[((u8[i] & 3) << 4) | ((i + 1 < len ? u8[i + 1] : 0) >> 4)]);
    parts.push((i + 1 < len) ? CHARS[((u8[i + 1] & 15) << 2) | ((i + 2 < len ? u8[i + 2] : 0) >> 6)] : '=');
    parts.push((i + 2 < len) ? CHARS[u8[i + 2] & 63] : '=');
  }
  return parts.join('');
}

// ─── Detect image format from magic bytes ───
function detectImageFormat(bytes: Uint8Array): string {
  if (!bytes || bytes.length < 12) return 'png';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  return 'png';
}

// ─── Collected image assets type ───
interface CollectedAssets {
  imageHashes: Record<string, { nodeId: string; nodeName: string; width: number; height: number }>;
  vectorNodes: Array<{ node: SceneNode; nodeId: string; nodeName: string }>;
  compositeNodes: Array<{ node: SceneNode; nodeId: string; nodeName: string }>;
  compositeIds: Record<string, boolean>;
  totalCount: number;
}

// Quick check: does any node in the subtree have an IMAGE fill? (capped at 4 levels)
function subtreeHasImage(node: SceneNode, d: number): boolean {
  if (d > 4) return false;
  const fills = 'fills' in node ? (node as any).fills : [];
  if (Array.isArray(fills)) {
    for (const f of fills) {
      if (f && f.type === 'IMAGE' && f.imageHash) return true;
    }
  }
  if ('children' in node) {
    for (const child of (node as any).children) {
      if (subtreeHasImage(child, d + 1)) return true;
    }
  }
  return false;
}

// ─── Walk Figma node tree and collect image assets ───
function collectImageAssets(node: SceneNode, depth: number, collected: CollectedAssets): void {
  if (depth > MAX_IMAGE_SCAN_DEPTH) return;
  if (collected.totalCount >= MAX_IMAGE_ASSETS + MAX_VECTOR_ASSETS + MAX_COMPOSITE_ASSETS) return;
  // Skip invisible nodes — they can't be exported and produce errors
  if (node.visible === false) return;

  // Check fills for IMAGE type
  const fills = 'fills' in node ? (node as any).fills : [];
  if (Array.isArray(fills)) {
    for (const f of fills) {
      if (f && f.type === 'IMAGE' && f.imageHash) {
        const hash = String(f.imageHash);
        if (hash && !collected.imageHashes[hash]) {
          collected.imageHashes[hash] = {
            nodeId: node.id,
            nodeName: node.name,
            width: 'width' in node ? (node as any).width : 0,
            height: 'height' in node ? (node as any).height : 0,
          };
          collected.totalCount++;
        }
      }
    }
  }

  // Check for vector-like nodes — skip invisible or zero-size
  const vectorTypes = new Set(['VECTOR', 'STAR', 'LINE', 'POLYGON', 'BOOLEAN_OPERATION']);
  const nodeVisible = node.visible !== false;
  const nodeW = 'width' in node ? (node as any).width : 0;
  const nodeH = 'height' in node ? (node as any).height : 0;
  if (vectorTypes.has(node.type) && nodeVisible && (nodeW > 0 || nodeH > 0) && collected.vectorNodes.length < MAX_VECTOR_ASSETS) {
    collected.vectorNodes.push({ node, nodeId: node.id, nodeName: node.name });
    collected.totalCount++;
  }

  // Check for INSTANCE/COMPONENT/FRAME nodes that contain IMAGE fills in their
  // subtree — export as composed PNG (e.g. clipped avatars, image cards).
  const containerTypes = new Set(['INSTANCE', 'COMPONENT', 'COMPONENT_SET']);
  const isClippedFrame = node.type === 'FRAME' && ('clipsContent' in node) && (node as FrameNode).clipsContent;
  if ((containerTypes.has(node.type) || isClippedFrame) && depth > 0 && collected.compositeNodes.length < MAX_COMPOSITE_ASSETS) {
    if (subtreeHasImage(node, 0) && !collected.compositeIds[node.id]) {
      collected.compositeNodes.push({ node, nodeId: node.id, nodeName: node.name });
      collected.compositeIds[node.id] = true;
      collected.totalCount++;
    }
  }

  // Recurse
  if ('children' in node) {
    for (const child of (node as any).children) {
      try { collectImageAssets(child, depth + 1, collected); } catch (e) { /* skip */ }
    }
  }
}

// ─── Export collected image assets ───
function exportImageAssets(collected: CollectedAssets): Promise<any[]> {
  const assets: any[] = [];
  const promises: Promise<void>[] = [];

  // Export IMAGE fills via figma.getImageByHash
  const hashes = Object.keys(collected.imageHashes);
  for (let i = 0; i < Math.min(hashes.length, MAX_IMAGE_ASSETS); i++) {
    const hash = hashes[i];
    const info = collected.imageHashes[hash];
    try {
      const img = figma.getImageByHash(hash);
      if (img) {
        promises.push(
          img.getBytesAsync().then((bytes) => {
            assets.push({
              id: hash,
              format: detectImageFormat(bytes),
              data: uint8ToBase64(bytes),
              nodeId: info.nodeId,
              nodeName: info.nodeName,
              width: info.width,
              height: info.height,
              assetType: 'image-fill',
            });
          }).catch((e) => {
            console.error(`[Figma Plugin] Image fill export failed (${hash.substring(0, 8)}):`, e);
          })
        );
      }
    } catch (e) {
      console.error('[Figma Plugin] getImageByHash failed:', e);
    }
  }

  // Export vector nodes as SVG
  for (let j = 0; j < Math.min(collected.vectorNodes.length, MAX_VECTOR_ASSETS); j++) {
    const vec = collected.vectorNodes[j];
    if ('exportAsync' in vec.node) {
      promises.push(
        (vec.node as any).exportAsync({ format: 'SVG' }).then((bytes: Uint8Array) => {
          assets.push({
            id: vec.nodeId,
            format: 'svg',
            data: uint8ToBase64(bytes),
            nodeId: vec.nodeId,
            nodeName: vec.nodeName,
            width: 'width' in vec.node ? (vec.node as any).width : 0,
            height: 'height' in vec.node ? (vec.node as any).height : 0,
            assetType: 'vector',
          });
        }).catch((e: any) => {
          console.error(`[Figma Plugin] Vector export failed (${vec.nodeId}):`, e);
        })
      );
    }
  }

  // Export INSTANCE/COMPONENT/FRAME composites as PNG (renders the full composed visual)
  for (let k = 0; k < Math.min(collected.compositeNodes.length, MAX_COMPOSITE_ASSETS); k++) {
    const comp = collected.compositeNodes[k];
    if ('exportAsync' in comp.node) {
      const w = 'width' in comp.node ? (comp.node as any).width : 1;
      const h = 'height' in comp.node ? (comp.node as any).height : 1;
      const maxDim = Math.max(w, h);
      const scale = maxDim > COMPOSITE_MAX_PX ? COMPOSITE_MAX_PX / maxDim : 1;
      promises.push(
        (comp.node as any).exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } }).then((bytes: Uint8Array) => {
          assets.push({
            id: `composite_${comp.nodeId}`,
            format: detectImageFormat(bytes),
            data: uint8ToBase64(bytes),
            nodeId: comp.nodeId,
            nodeName: comp.nodeName,
            width: Math.round(w * scale),
            height: Math.round(h * scale),
            assetType: 'image-fill',
          });
        }).catch((e: any) => {
          console.error(`[Figma Plugin] Composite export failed (${comp.nodeId}):`, e);
        })
      );
    }
  }

  return Promise.all(promises).then(() => assets);
}

// ─── Send current selection to UI ───
function sendCurrentSelection(force = false): void {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    figma.ui.postMessage({ type: 'selection-cleared' });
    lastNodeId = null;
    return;
  }

  if (selection.length > 1) {
    figma.ui.postMessage({
      type: 'multi-selection',
      count: selection.length,
      nodes: selection.slice(0, 5).map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
      })),
    });
    return;
  }

  const node = selection[0];
  if (!force && node.id === lastNodeId) return;
  lastNodeId = node.id;

  const payload = {
    type: 'selection-changed',
    fileId: figma.fileKey || 'unknown',
    nodeId: node.id,
    pageId: figma.currentPage.id,
    userId: figma.currentUser?.id || 'anonymous',
    metadata: {
      nodeName: node.name,
      nodeType: node.type,
      parentId: node.parent?.id || null,
      width: 'width' in node ? (node as any).width : undefined,
      height: 'height' in node ? (node as any).height : undefined,
      visible: node.visible,
    },
  };

  // Send design tree immediately
  figma.ui.postMessage(payload);

  // Collect and export individual image assets asynchronously
  const capturedNodeId = node.id;
  const mySeq = ++selectionSeq;
  const collected: CollectedAssets = { imageHashes: {}, vectorNodes: [], compositeNodes: [], compositeIds: {}, totalCount: 0 };
  try {
    collectImageAssets(node, 0, collected);
  } catch (e) {
    console.error('[Figma Plugin] collectImageAssets failed:', e);
  }

  const assetCount = Object.keys(collected.imageHashes).length + collected.vectorNodes.length + collected.compositeNodes.length;
  if (assetCount > 0) {
    exportImageAssets(collected).then((assets) => {
      if (assets.length > 0 && mySeq === selectionSeq) {
        figma.ui.postMessage({
          type: 'images-extracted',
          nodeId: capturedNodeId,
          assets,
        });
      }
    });
  }
}

// ─── Selection Change Handler ───
figma.on('selectionchange', () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { sendCurrentSelection(false); }, DEBOUNCE_MS) as unknown as number;
});

// ─── Handle messages from the UI ───
figma.ui.onmessage = (msg: any) => {
  switch (msg.type) {
    case 'close':
      figma.closePlugin();
      break;

    case 'refresh':
      // Force re-send current selection
      sendCurrentSelection(true);
      break;

    case 'set-server-url':
      // Allow runtime URL override
      figma.ui.postMessage({
        type: 'server-url-updated',
        serverUrl: msg.url,
      });
      break;
  }
};
