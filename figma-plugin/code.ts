/**
 * Figma MCP Selection Bridge — Plugin Code
 *
 * Runs inside the Figma sandbox. Detects selection changes
 * and pushes the selection context to the MCP server via the UI bridge.
 */

// ─── Configuration ───
const MCP_SERVER_URL = 'http://localhost:3050';
const DEBOUNCE_MS = 300;

// ─── State ───
let debounceTimer: number | null = null;
let lastNodeId: string | null = null;

// ─── Plugin Entry ───
figma.showUI(__html__, { width: 320, height: 400, visible: true });

// Send initial state
figma.ui.postMessage({
  type: 'init',
  serverUrl: MCP_SERVER_URL,
  userId: figma.currentUser?.id || 'anonymous',
  userName: figma.currentUser?.name || 'Unknown User',
});

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

  // Single node selected
  const node = selection[0];

  // Skip if same node already sent (unless forced)
  if (!force && node.id === lastNodeId) return;
  lastNodeId = node.id;

  // Gather node metadata
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

  figma.ui.postMessage(payload);
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
