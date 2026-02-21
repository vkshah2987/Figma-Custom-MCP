import { SelectionState, ImageAsset } from '../types/selection';
import { writeAssets, clearAssets } from './imageStorage';

/**
 * In-memory store for the latest Figma selection.
 *
 * Rules (per architecture):
 * - Singleton
 * - Overwrites on every new selection
 * - Image assets are persisted to disk (figma-assets/) in their native format
 * - Old asset files are deleted when a new selection arrives
 */
class SelectionStore {
  private current: SelectionState | undefined;

  /** Overwrite the current selection (new push from Figma plugin). */
  set(selection: SelectionState): void {
    // Delete old image files from disk before replacing the selection.
    clearAssets();
    this.current = selection;
  }

  /** Return the latest selection, or undefined if nothing has been pushed yet. */
  get(): SelectionState | undefined {
    return this.current;
  }

  /** Clear the stored selection and delete asset files from disk. */
  clear(): void {
    clearAssets();
    this.current = undefined;
  }

  /** Attach image assets to the current selection and write them to disk. Returns false if selection has changed. */
  setImages(nodeId: string, assets: ImageAsset[]): boolean {
    if (!this.current || this.current.nodeId !== nodeId) return false;

    // Write image files to disk and get their absolute paths.
    const filePaths = writeAssets(assets);

    // Enrich each asset with its filePath before storing.
    const map: Record<string, ImageAsset> = { ...(this.current.images || {}) };
    for (const a of assets) {
      map[a.id] = { ...a, filePath: filePaths[a.id] };
    }
    this.current = { ...this.current, images: map };
    return true;
  }

  /** Get a specific image asset by ID. */
  getImage(id: string): ImageAsset | undefined {
    return this.current?.images?.[id];
  }

  /** List all image asset metadata (without the raw data field). */
  listImages(): Array<Omit<ImageAsset, 'data'>> {
    if (!this.current?.images) return [];
    return Object.values(this.current.images).map(({ data, ...rest }) => rest);
  }
}

export const selectionStore = new SelectionStore();
