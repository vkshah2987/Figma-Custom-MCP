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
import { startBridge, stopBridge } from './bridge/server';

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
  'Returns the full design tree and metadata for the node currently selected in the Figma desktop plugin. The plugin must be running and a node must be selected.',
  {
    // No required input — the tool reads from the in-memory store
  },
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
  'The current Figma selection as a JSON design tree',
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
  stopBridge();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopBridge();
  process.exit(0);
});
