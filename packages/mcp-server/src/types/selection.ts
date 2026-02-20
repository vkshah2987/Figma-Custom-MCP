/**
 * Core types for the Figma Selection Bridge.
 * Shared between the HTTP bridge and the MCP tool layer.
 */

// ─── Basic metadata (lightweight, always present) ──────────────────────────

export interface NodeMetadata {
  nodeName: string;
  nodeType: string;
  parentId: string | null;
  width?: number;
  height?: number;
  visible: boolean;
}

// ─── Rich design tree (sent alongside selection for webpage generation) ─────

export interface DesignColor {
  r: number; // 0–1
  g: number;
  b: number;
  a: number; // opacity 0–1
}

export interface DesignPaint {
  type: string;          // SOLID | GRADIENT_LINEAR | GRADIENT_RADIAL | IMAGE …
  visible: boolean;
  opacity: number;       // 0–1
  color?: DesignColor;   // For SOLID fills
  gradientStops?: Array<{ color: DesignColor; position: number }>;
}

export interface DesignEffect {
  type: string;          // DROP_SHADOW | INNER_SHADOW | LAYER_BLUR | BACKGROUND_BLUR
  visible: boolean;
  radius: number;
  color?: DesignColor;
  offset?: { x: number; y: number };
  spread?: number;
}

export interface DesignTextStyle {
  fontFamily: string;
  fontStyle: string;     // Regular | Bold | Italic …
  fontSize: number;
  fontWeight: number;
  letterSpacing: number; // px
  lineHeight: number | string; // px or 'AUTO'
  textAlignHorizontal: string; // LEFT | CENTER | RIGHT | JUSTIFIED
  textAlignVertical: string;   // TOP | CENTER | BOTTOM
  textDecoration: string;      // NONE | UNDERLINE | STRIKETHROUGH
  textCase: string;            // ORIGINAL | UPPER | LOWER | TITLE
}

export interface DesignAutoLayout {
  mode: 'HORIZONTAL' | 'VERTICAL' | 'NONE';
  spacing: number;            // gap between children
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  primaryAxisAlignItems: string;   // MIN | CENTER | MAX | SPACE_BETWEEN
  counterAxisAlignItems: string;   // MIN | CENTER | MAX | BASELINE
  layoutWrap: string;              // NO_WRAP | WRAP
}

export interface DesignNode {
  id: string;
  name: string;
  type: string;       // FRAME | GROUP | TEXT | RECTANGLE | ELLIPSE | VECTOR | COMPONENT | INSTANCE …
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;    // 0–1
  blendMode: string;  // NORMAL | MULTIPLY | SCREEN …
  locked: boolean;

  // ── Geometry / corners ──────────────────────────────────────────────────────
  cornerRadius?: number;
  topLeftRadius?: number;
  topRightRadius?: number;
  bottomRightRadius?: number;
  bottomLeftRadius?: number;

  // ── Stroke ──────────────────────────────────────────────────────────────────
  fills: DesignPaint[];
  strokes: DesignPaint[];
  strokeWeight?: number;
  strokeAlign?: string;      // INSIDE | OUTSIDE | CENTER
  dashPattern?: number[];

  // ── Effects ─────────────────────────────────────────────────────────────────
  effects: DesignEffect[];
  isMask: boolean;

  // ── Auto-layout (FRAME with layoutMode set) ─────────────────────────────────
  autoLayout?: DesignAutoLayout;

  // ── Text-specific ────────────────────────────────────────────────────────────
  characters?: string;        // full text content (TEXT nodes only)
  textStyle?: DesignTextStyle;

  // ── Constraints ─────────────────────────────────────────────────────────────
  constraintHorizontal?: string;   // MIN | CENTER | MAX | STRETCH | SCALE
  constraintVertical?: string;

  // ── Image / component ────────────────────────────────────────────────────────
  componentId?: string;       // INSTANCE nodes — the master component ID

  // ── Children ────────────────────────────────────────────────────────────────
  children?: DesignNode[];
}

// ─── State / payload ───────────────────────────────────────────────────────

export interface SelectionState {
  /** Figma file key (from the file URL) */
  fileId: string;
  /** Figma node ID (e.g. "45:67") */
  nodeId: string;
  /** Page ID of the selected node */
  pageId: string;
  /** ID of the user who made the selection */
  userId: string;
  /** Node metadata snapshot extracted by the Figma plugin */
  metadata: NodeMetadata;
  /** Full design tree for webpage generation (optional — requires enhanced plugin) */
  designTree?: DesignNode;
  /** Unix timestamp (ms) when this selection was stored */
  timestamp: number;
}

/** Payload received from the Figma plugin via POST /selection */
export interface SelectionPayload {
  fileId: string;
  nodeId: string;
  pageId: string;
  userId: string;
  metadata: NodeMetadata;
  designTree?: DesignNode;
}
