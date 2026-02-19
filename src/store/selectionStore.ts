import { SelectionState } from '../types/selection';

/**
 * In-memory store for the latest Figma selection.
 *
 * Rules (per architecture):
 * - Singleton
 * - Memory-only (no disk, no DB)
 * - Overwrites on every new selection
 * - Data is lost when VS Code / the extension reloads
 */
class SelectionStore {
  private current: SelectionState | undefined;

  /** Overwrite the current selection (new push from Figma plugin). */
  set(selection: SelectionState): void {
    this.current = selection;
  }

  /** Return the latest selection, or undefined if nothing has been pushed yet. */
  get(): SelectionState | undefined {
    return this.current;
  }

  /** Clear the stored selection. */
  clear(): void {
    this.current = undefined;
  }
}

export const selectionStore = new SelectionStore();
