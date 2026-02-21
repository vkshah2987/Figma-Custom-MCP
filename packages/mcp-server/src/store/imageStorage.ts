/**
 * Disk-based image storage for Figma assets.
 *
 * Images are written as real files (.png, .jpg, .svg, etc.) to a
 * `figma-assets/` directory under the mcp-server package root.
 * When a new Figma node is selected, the old files are deleted
 * and replaced with the new ones.
 *
 * This gives Copilot (and any MCP client) real file paths it can
 * reference in generated HTML/CSS, copy into user projects, etc.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ImageAsset } from '../types/selection';

// Resolve to packages/mcp-server/figma-assets/
// __dirname at runtime = .../packages/mcp-server/dist/store
const ASSETS_DIR = path.resolve(__dirname, '..', '..', 'figma-assets');

/** Return the absolute path to the figma-assets directory. */
export function getAssetsDir(): string {
  return ASSETS_DIR;
}

/**
 * Sanitise a Figma ID for use in a filename.
 * Figma IDs look like "45:67" — replace anything non-alphanumeric with '_'.
 */
function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Delete every file inside the assets directory.
 * Called when a new selection arrives to avoid stale assets.
 */
export function clearAssets(): void {
  if (!fs.existsSync(ASSETS_DIR)) return;
  for (const file of fs.readdirSync(ASSETS_DIR)) {
    const fp = path.join(ASSETS_DIR, file);
    // Only delete files, not sub-directories (safety).
    if (fs.statSync(fp).isFile()) {
      fs.unlinkSync(fp);
    }
  }
}

/**
 * Write a batch of image assets to disk.
 * Returns a map of asset-ID → absolute file path.
 */
export function writeAssets(assets: ImageAsset[]): Record<string, string> {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  const filePaths: Record<string, string> = {};

  for (const asset of assets) {
    const filename = `${sanitize(asset.id)}.${asset.format}`;
    const filePath = path.join(ASSETS_DIR, filename);

    if (asset.format === 'svg') {
      // SVG is text — decode from base64 and write as UTF-8.
      const svgText = Buffer.from(asset.data, 'base64').toString('utf-8');
      fs.writeFileSync(filePath, svgText, 'utf-8');
    } else {
      // Raster formats — write raw bytes.
      const buffer = Buffer.from(asset.data, 'base64');
      fs.writeFileSync(filePath, buffer);
    }

    filePaths[asset.id] = filePath;
  }

  return filePaths;
}

/** Get the absolute file path for an asset. */
export function getAssetPath(id: string, format: string): string {
  return path.join(ASSETS_DIR, `${sanitize(id)}.${format}`);
}

/** Check whether an asset file exists on disk. */
export function assetExists(id: string, format: string): boolean {
  return fs.existsSync(getAssetPath(id, format));
}
