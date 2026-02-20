# Figma MCP Selection Bridge

The **Selection Bridge** is a Figma plugin that makes your canvas selection the live source of truth for GitHub Copilot. Instead of copying node IDs manually, you simply click any element in Figma and Copilot instantly knows what you're looking at.

---

## What is it?

The Selection Bridge connects three pieces together:

```
┌─────────────────────┐     POST /selection      ┌──────────────────────┐
│   Figma Desktop     │ ──────────────────────►  │   MCP Server         │
│   (Plugin running)  │   { fileId, nodeId,      │   (localhost:3000)   │
│                     │     pageId, userId }      │   Redis TTL: 5 min   │
└─────────────────────┘                           └──────────┬───────────┘
                                                             │ reads context
                                                             ▼
                                                  ┌──────────────────────┐
                                                  │   GitHub Copilot     │
                                                  │   (VS Code MCP)      │
                                                  │                      │
                                                  │  get_selected_node_  │
                                                  │  context tool        │
                                                  └──────────┬───────────┘
                                                             │ fetches node
                                                             ▼
                                                  ┌──────────────────────┐
                                                  │   Figma REST API     │
                                                  │   X-Figma-Token auth │
                                                  │   Full node JSON     │
                                                  └──────────────────────┘
```

**What gets sent to the server:** only lightweight identity data — `fileId`, `nodeId`, `pageId`, `userId`, node name and type. No design content is transmitted by the plugin. The server fetches full design data from the Figma API on demand when Copilot requests it.

---

## Prerequisites

| Requirement | Details |
|---|---|
| Figma Desktop | Required — browser Figma does not support Development plugins |
| MCP Server running | `npm run dev` in this project (port 3000) |
| Redis running | `docker compose up redis` or standalone Redis on port 6379 |
| Figma personal access token | Set as `FIGMA_ACCESS_TOKEN` in `.vscode/mcp.json` |

---

## Installation

### Step 1 — Start the MCP server

```bash
# From the project root
npm run dev
```

Verify it's running:

```bash
curl http://localhost:3000/health
# → { "status": "ok", "redis": "connected", ... }
```

### Step 2 — Install the plugin in Figma

1. Open **Figma Desktop**
2. Go to **Main Menu (☰) → Plugins → Development → Import plugin from manifest…**
3. Navigate to this project and select:
   ```
   figma-plugin/manifest.json
   ```
4. The plugin installs as **"Figma MCP Selection Bridge"** under **Plugins → Development**

### Step 3 — Run the plugin

1. Open any Figma file
2. **Main Menu → Plugins → Development → Figma MCP Selection Bridge**
3. The plugin panel opens (320×400px) with a green **Ready** status

### Step 4 — Connect VS Code MCP

Ensure `.vscode/mcp.json` has the server configured. VS Code will show the MCP server as active in the status bar. You can now use `get_selected_node_context` in Copilot Chat.

---

## Using It

### Basic workflow

1. **Click any node** in Figma (frame, component, text layer, icon — anything)
2. The plugin panel shows the node name, type, and ID instantly
3. Switch to **VS Code** and open Copilot Chat
4. Ask anything in natural language — Copilot automatically reads your selection:

```
"Generate a React component for the selected node"
"What are the design tokens used in my selection?"
"Write Tailwind CSS for the selected card"
"Describe the layout structure of this component"
```

Copilot calls the `get_selected_node_context` tool automatically — no node ID needed.

### Plugin panel

```
┌──────────────────────────────┐
│ 🔗 Selection Bridge          │
├──────────────────────────────┤
│ ● Connected (3 syncs)        │  ← green = server reachable
├──────────────────────────────┤
│ Node                         │
│ Product Card                 │  ← selected node name
│ FRAME · 42:1056              │  ← type · node ID
│                              │
│ File / Page                  │
│ abc123 / 0:2                 │  ← fileId / pageId
├──────────────────────────────┤
│ [↻ Refresh]  [Clear]         │
├──────────────────────────────┤
│ 12:03:01 ✓ Product Card → 42:1056  │  ← sync log
│ 12:02:55 ✓ Hero Banner → 10:230    │
├──────────────────────────────┤
│ MCP Server URL               │
│ http://localhost:3000        │  ← configurable
└──────────────────────────────┘
```

| Status colour | Meaning |
|---|---|
| 🟢 Green | Server reachable, last sync succeeded |
| 🔵 Blue (pulsing) | Currently syncing |
| 🔴 Red | Server unreachable — check `npm run dev` |

### Buttons

| Button | Action |
|---|---|
| **↻ Refresh** | Re-sends the current selection immediately (useful after server restart) |
| **Clear** | Erases the stored selection from Redis for your user |

### Changing the server URL

If your MCP server runs on a different port or host, type the new URL in the **MCP Server URL** field at the bottom of the panel. The change takes effect on the next selection sync.

---

## MCP Tool: `get_selected_node_context`

This is the Copilot-facing tool that consumes the bridge data.

### Inputs (all optional)

| Parameter | Type | Description |
|---|---|---|
| `userId` | string | Figma user ID. Defaults to `"default"` |
| `fileKey` | string | Override: skip the stored selection and use this Figma file key directly |
| `nodeId` | string | Override: use this node ID directly (e.g. `"42:1056"`) |
| `pageId` | string | Optional page hint when using manual overrides |

### Output

Returns a fully expanded semantic model of the node:

```json
{
  "componentName": "Product Card",
  "role": "card",
  "layout": {
    "type": "FRAME",
    "width": 320,
    "height": 480,
    "flexDirection": "column",
    "gap": 16,
    "padding": { "top": 20, "right": 20, "bottom": 20, "left": 20 }
  },
  "tokens": {
    "colors": ["#FFFFFF", "#1A1A2E"],
    "typography": ["Inter/16/600", "Inter/14/400"],
    "spacing": [16, 20],
    "radii": [12]
  },
  "structuralContext": {
    "parentChain": ["Page", "Section", "Grid"],
    "siblings": ["Product Card", "Product Card", "Product Card"]
  },
  "children": [ ... ],
  "responsiveness": { "behavior": "fluid", "minWidth": 280 },
  "states": ["default", "hover"]
}
```

### Manual override (no plugin needed)

You can bypass the plugin entirely by passing `fileKey` and `nodeId` directly:

```
In Copilot Chat:
"Use get_selected_node_context with fileKey KH9noaqmX3A0NpEd4VslKo and nodeId 59:71"
```

---

## REST API

The MCP server exposes selection endpoints directly:

```bash
# Push a selection (what the plugin does automatically)
curl -X POST http://localhost:3000/selection \
  -H "Content-Type: application/json" \
  -d '{ "fileId": "abc123", "nodeId": "42:1056", "pageId": "0:1", "userId": "user123" }'

# Read current selection for a user
curl http://localhost:3000/selection/user123

# Refresh TTL (keep selection alive)
curl -X POST http://localhost:3000/selection/user123/refresh

# Clear a selection
curl -X DELETE http://localhost:3000/selection/user123
```

---

## How the context expansion works

When `get_selected_node_context` is called, the server does this in sequence:

1. **Read Redis** — get `fileId` + `nodeId` for the user (or use manual override)
2. **Fetch Figma API** — `GET /v1/files/{fileId}/nodes?ids={nodeId}` with `X-Figma-Token`
3. **Expand contexts** — The `DesignContextExpansionEngine` derives:
   - **Structural** — parent chain (page → section → frame), sibling count and names
   - **Visual** — colours, border radii, shadows, opacity, blend modes
   - **Typography** — font family, size, weight, line height for all text nodes
   - **Component** — variant properties, slot names if it's a Figma component
   - **Behavioural** — infers role (`button`, `card`, `input`, `navigation`) from name/type heuristics
   - **Responsiveness** — constraints (`SCALE`, `FIXED`), min/max width
   - **States** — detects `hover`, `pressed`, `disabled` variants
4. **Cache result** — 2-minute Redis cache to avoid redundant API calls
5. **Return semantic model** — JSON optimised for LLM code generation

---

## Security & Privacy

- **Only node IDs are transmitted** by the plugin — no vector data, fills, or images
- **Per-user isolation** — each Figma user's selection is stored under their own Redis key
- **Auto-expiry** — selections expire after **5 minutes** of inactivity (Redis TTL)
- **No external calls** — the plugin only contacts your local MCP server (`localhost:3000`)
- The server-side Figma API calls use your personal access token, which never leaves the server

---

## Troubleshooting

### Plugin shows 🔴 "Server unreachable"

```bash
# Check the server is running
curl http://localhost:3000/health

# If not, start it
npm run dev
```

### `get_selected_node_context` returns "No active selection"

- Confirm the plugin panel shows green status and a node name
- Click **↻ Refresh** in the plugin panel to force a re-sync
- Check your `userId` — pass `userId: "default"` explicitly in Copilot if needed

### 403 from Figma API

Verify `FIGMA_ACCESS_TOKEN` in `.vscode/mcp.json` starts with `figd_`. The server uses `X-Figma-Token` header (not `Authorization: Bearer`).

### Selection expired

Selections have a 5-minute TTL. If Copilot calls the tool after 5 minutes of inactivity, re-select the node in Figma and the plugin auto-syncs.

---

## File Reference

| File | Purpose |
|---|---|
| `figma-plugin/manifest.json` | Plugin manifest — points Figma to `code.js` and `ui.html` |
| `figma-plugin/code.js` | Plugin sandbox code — detects selection, messages the UI |
| `figma-plugin/code.ts` | TypeScript source for `code.js` |
| `figma-plugin/ui.html` | Plugin panel UI — sends HTTP requests to the MCP server |
| `src/selection/context-store.ts` | Redis-backed store (TTL 5 min, per-user) |
| `src/selection/expansion-engine.ts` | Context expansion engine (structural/visual/component/behavioural) |
| `src/mcp/tools.ts` | `get_selected_node_context` tool definition |
| `src/server/http-server.ts` | `/selection` REST endpoints |
