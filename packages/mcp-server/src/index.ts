#!/usr/bin/env node
/**
 * Figma MCP Bridge — Standalone MCP Server
 *
 * Runs two things in a single process:
 *   1. An Express HTTP bridge on localhost:3050 that receives design-tree
 *      pushes from the Figma desktop plugin.
 *   2. An MCP (Model Context Protocol) server over stdio that exposes the
 *      stored selection to any MCP-compatible client (VS Code Copilot,
 *      Claude Desktop, Cursor, etc.).
 *
 * Usage:
 *   node dist/index.js          # started automatically by MCP client config
 *   npx ts-node src/index.ts    # dev
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { startBridge, stopBridge } from './bridge/server';
import { selectionStore } from './store/selectionStore';
import { getAssetsDir } from './store/imageStorage';

const BRIDGE_URL = `http://localhost:${process.env.BRIDGE_PORT ?? 3050}`;

// ── Express bridge (HTTP) ──────────────────────────────────────────────────

startBridge();

// ── MCP server (stdio) ────────────────────────────────────────────────────

const mcp = new McpServer({
  name: 'figma-mcp-bridge',
  version: '2.0.0',
});

// ── Tool: get_current_figma_selection ──────────────────────────────────────

mcp.tool(
  'get_current_figma_selection',
  'Returns the full design tree, metadata, and a list of available image assets (with file paths on disk) for the node currently selected in Figma. IMAGE fills in the design tree have an "imageRef" field matching an image asset ID. Vector nodes (VECTOR, STAR, LINE, POLYGON) are exported as SVG with their node ID as the asset ID. Each image asset includes a "filePath" — the absolute path to the real file on disk (.png, .jpg, .svg, etc.) that you can copy into the user\'s project or reference directly. Use get_figma_selection_image with a specific ID for more details.',
  {},
  async () => {
    try {
      const res = await fetch(`${BRIDGE_URL}/selection`);
      const data = await res.json();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'error',
              message: 'Bridge unreachable. Make sure the Figma MCP Bridge server is running on port 3050.',
            }),
          },
        ],
      };
    }
  },
);

// ── Tool: clear_figma_selection ────────────────────────────────────────────

mcp.tool(
  'clear_figma_selection',
  'Clears the currently stored Figma selection from the bridge.',
  {},
  async () => {
    try {
      const res = await fetch(`${BRIDGE_URL}/selection`, { method: 'DELETE' });
      const data = await res.json();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ status: 'error', message: 'Bridge unreachable.' }),
          },
        ],
      };
    }
  },
);

// ── Tool: get_figma_selection_image ───────────────────────────────────────

mcp.tool(
  'get_figma_selection_image',
  'Returns a specific image asset from the current Figma selection by its ID, including the absolute file path on disk. For IMAGE fills, the ID is the imageRef/imageHash from the design tree. For vector nodes (icons/shapes), the ID is the Figma node ID. The filePath field points to the actual image file (.png/.jpg/.svg) on disk — copy or reference it directly in generated HTML/CSS.',
  {
    imageId: z.string().describe('The image asset ID — use imageRef from the design tree fills (for image fills) or the node ID (for vectors). Call get_current_figma_selection first to see all available image IDs.'),
  },
  async ({ imageId }) => {
    const asset = selectionStore.getImage(imageId);
    if (!asset) {
      const available = selectionStore.listImages();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'not_found',
            imageId,
            availableImages: available.map(a => ({ id: a.id, name: a.nodeName, format: a.format, type: a.assetType, filePath: a.filePath })),
            message: available.length
              ? `Image "${imageId}" not found. ${available.length} image(s) available — see availableImages.`
              : 'No images available. Select a node with image fills or vectors in Figma.',
          }, null, 2),
        }],
      };
    }

    if (asset.format === 'svg') {
      const svgText = Buffer.from(asset.data, 'base64').toString('utf-8');
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'ok',
              imageId: asset.id,
              format: 'svg',
              assetType: asset.assetType,
              nodeName: asset.nodeName,
              nodeId: asset.nodeId,
              width: asset.width,
              height: asset.height,
              filePath: asset.filePath,
              usage: `Copy ${asset.filePath} into your project assets, or embed the SVG markup directly.`,
            }),
          },
          { type: 'text' as const, text: svgText },
        ],
      };
    }

    // Raster image (png, jpg, gif, webp)
    const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            status: 'ok',
            imageId: asset.id,
            format: asset.format,
            assetType: asset.assetType,
            nodeName: asset.nodeName,
            nodeId: asset.nodeId,
            width: asset.width,
            height: asset.height,
            filePath: asset.filePath,
            usage: `Copy ${asset.filePath} into your project assets folder and reference: <img src="assets/${asset.id}.${asset.format}" alt="${asset.nodeName}" width="${asset.width}" height="${asset.height}">`,
          }),
        },
        {
          type: 'image' as const,
          data: asset.data,
          mimeType: mimeMap[asset.format] || 'image/png',
        },
      ],
    };
  },
);

// ── Tool: get_bridge_health ────────────────────────────────────────────────

mcp.tool(
  'get_bridge_health',
  'Returns the health status of the Express bridge (port 3050).',
  {},
  async () => {
    try {
      const res = await fetch(`${BRIDGE_URL}/health`);
      const data = await res.json();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ status: 'error', bridge: 'unreachable', port: 3050 }),
          },
        ],
      };
    }
  },
);

// ── Resource: figma://selection ────────────────────────────────────────────

mcp.resource(
  'figma://selection',
  'The current Figma selection as a JSON design tree with image asset references',
  async () => {
    try {
      const res = await fetch(`${BRIDGE_URL}/selection`);
      const data = await res.json();
      return {
        contents: [
          {
            uri: 'figma://selection',
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch {
      return {
        contents: [
          {
            uri: 'figma://selection',
            mimeType: 'application/json',
            text: JSON.stringify({ error: 'Bridge unreachable' }),
          },
        ],
      };
    }
  },
);

// ── Connect stdio transport (skipped in BRIDGE_ONLY mode) ─────────────────

async function main(): Promise<void> {
  if (process.env.BRIDGE_ONLY === '1') {
    // Running as a background bridge daemon — Express is already up, nothing else needed.
    console.error('[Figma MCP] Bridge-only mode: HTTP bridge running on :3050 (no stdio)');
    return; // keep process alive via Express event loop
  }
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error('[Figma MCP] Server running (stdio + bridge on :3050)');
}

main().catch((err) => {
  console.error('[Figma MCP] Fatal:', err);
  process.exit(1);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────

process.on('SIGINT', () => {
  selectionStore.clear(); // clean up disk assets
  stopBridge();
  process.exit(0);
});
process.on('SIGTERM', () => {
  selectionStore.clear(); // clean up disk assets
  stopBridge();
  process.exit(0);
});
