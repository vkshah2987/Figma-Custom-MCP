# Figma MCP Bridge

> A VS Code extension that connects the **Figma** design tool directly to **GitHub Copilot** — select any node in Figma and instantly generate a webpage, interrogate design data, or feed real design context into your AI workflow.

## How It Works

```
Figma Desktop Plugin
        │  POST /selection  (node metadata + design tree)
        ▼
Express Bridge  localhost:3050
        │
   SelectionStore  (in-memory)
        │
   LM Tool: get_current_figma_selection
        │
   GitHub Copilot Chat  ◄──  you ask "Build a webpage from my selection"
        │
   buildWebpage command  →  figma-<name>.html
```

## Features

- **Auto-start bridge** — Express server on `localhost:3050` starts when VS Code opens
- **Design tree extraction** — full recursive node tree (fills, strokes, typography, effects, auto-layout)
- **Build Webpage** — one command turns your Figma selection into a ready-to-open `.html` file
- **LM Tool** — `get_current_figma_selection` exposes live design data to any Copilot Chat request
- **Status bar** — shows bridge state and selected node name; click to trigger Build Webpage
- **Zero config** — no API keys, no OAuth, no Docker

## Prerequisites

| Requirement | Version |
|---|---|
| VS Code | ≥ 1.109 |
| GitHub Copilot extension | latest |
| Figma Desktop | any recent |
| Node.js (dev only) | ≥ 20 |

## Installation

### 1 — VS Code Extension

```bash
# Install the packaged extension
code --install-extension figma-mcp-bridge-1.3.0.vsix
```

Or via the Extensions side-bar: **Install from VSIX…** → select the file.

### 2 — Figma Plugin

1. Open **Figma Desktop**.
2. Go to **Menu → Plugins → Development → Import plugin from manifest…**
3. Select `figma-plugin/manifest.json` from this repo.
4. Run the plugin from **Plugins → Development → Figma MCP Bridge**.

## Usage

### Generate a Webpage

1. In Figma, select any frame or component and run the plugin.
2. The plugin displays the selected node name — the bridge is now live.
3. In VS Code, open **GitHub Copilot Chat** and run:

```
@workspace /figmaMcp.buildWebpage
```

Or press the status-bar item at the bottom of VS Code.

A `figma-<NodeName>.html` file will be created and opened. A prompt to preview it in the Simple Browser will appear.

### Use Live Design Data in Copilot Chat

In Copilot Chat, Copilot will automatically call `get_current_figma_selection` when you ask design-related questions:

```
What node do I have selected in Figma right now?
Describe the typography and color scheme of my current Figma selection.
Generate a React component that matches my Figma selection.
```

## Commands

| Command | ID | Description |
|---|---|---|
| Build Webpage from Selection | `figmaMcp.buildWebpage` | Generate HTML from current Figma selection |
| Clear Figma Selection | `figmaMcp.clearSelection` | Remove stored selection from bridge |
| Start Bridge Server | `figmaMcp.startBridge` | Manually (re)start the Express bridge |

## Project Structure

```
.
├── src/
│   ├── extension.ts             # Extension entry point
│   ├── bridge/
│   │   └── server.ts            # Express bridge (port 3050)
│   ├── commands/
│   │   └── buildWebpage.ts      # LM-powered webpage generation
│   ├── tools/
│   │   └── selectionTool.ts     # get_current_figma_selection LM tool
│   └── types/
│       └── selection.ts         # DesignNode + SelectionPayload types
├── figma-plugin/
│   ├── manifest.json            # Figma plugin manifest
│   ├── code.js                  # Plugin sandbox (ES5-safe)
│   └── ui.html                  # Plugin UI + bridge POST
├── dist/                        # Compiled extension (gitignored)
├── package.json
└── README.md
```

## Bridge API

| Method | Path | Body / Response |
|---|---|---|
| `POST` | `/selection` | `SelectionPayload` JSON |
| `GET` | `/selection` | Current `SelectionPayload` or `204` |
| `DELETE` | `/selection` | Clears stored selection |
| `GET` | `/health` | `{ status: "ok" }` |

```bash
# Check what's selected
curl http://localhost:3050/selection

# Health check
curl http://localhost:3050/health

# Clear selection
curl -X DELETE http://localhost:3050/selection
```

## Development

```bash
npm install          # install dependencies
npm run compile      # one-off TypeScript build
npm run watch        # watch mode
npm run package      # produce .vsix (bundles node_modules)
```

Press **F5** in VS Code to launch the Extension Development Host.

## Environment Variables

No required environment variables. Optional:

| Variable | Default | Purpose |
|---|---|---|
| `BRIDGE_PORT` | `3050` | Port for the Express bridge |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Status bar shows "Bridge: stopped" | Run **Start Bridge Server** command or reload VS Code window |
| "No Figma selection" in Copilot | Open the Figma plugin and select a node |
| Plugin shows error on load | Ensure you imported via **manifest.json**, not a zip |
| Generated HTML is unstyled | Selection may lack fill/stroke data — select a fully styled frame |

## License

MIT © figma-mcp
