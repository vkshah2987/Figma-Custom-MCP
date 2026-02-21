// Figma MCP Selection Bridge — Plugin Code (ES5-safe + figma.mixed-safe)
var MCP_SERVER_URL = 'http://localhost:3050';
var DEBOUNCE_MS = 150;
var MAX_TREE_DEPTH = 15;      // Design tree extraction depth
var MAX_IMAGE_SCAN_DEPTH = 30; // Image asset scanning depth (needs to reach deep into instances)
var MAX_IMAGE_ASSETS = 50;
var MAX_VECTOR_ASSETS = 30;
var MAX_COMPOSITE_ASSETS = 20; // INSTANCE/COMPONENT nodes exported as composed PNG
var COMPOSITE_MAX_PX = 512;   // Cap composite exports at this pixel dimension (1x)
var debounceTimer = null;
var lastNodeId = null;
var selectionSeq = 0;

figma.showUI(__html__, { width: 320, height: 400, visible: true });
figma.ui.postMessage({
  type: 'init',
  serverUrl: MCP_SERVER_URL,
  userId: (figma.currentUser ? figma.currentUser.id : null) || 'anonymous',
  userName: (figma.currentUser ? figma.currentUser.name : null) || 'Unknown User'
});

// Guard against figma.mixed (Symbol) — treat it as undefined/fallback
function safe(val, fallback) {
  if (val === null || val === undefined) return (fallback !== undefined ? fallback : null);
  if (typeof val === 'symbol') return (fallback !== undefined ? fallback : null);
  return val;
}

function safeNum(val, fallback) {
  var v = safe(val);
  return (typeof v === 'number') ? v : (fallback !== undefined ? fallback : 0);
}

function safeStr(val, fallback) {
  var v = safe(val);
  return (typeof v === 'string') ? v : (fallback !== undefined ? fallback : '');
}

function safeBool(val, fallback) {
  var v = safe(val);
  return (typeof v === 'boolean') ? v : (fallback !== undefined ? fallback : false);
}

function safeArr(val) {
  var v = safe(val);
  return Array.isArray(v) ? v : [];
}

function toColor(c) {
  if (!c || typeof c === 'symbol') return { r: 0, g: 0, b: 0, a: 1 };
  return { r: safeNum(c.r, 0), g: safeNum(c.g, 0), b: safeNum(c.b, 0), a: safeNum(c.a, 1) };
}

// ── Base64 encoder (works in Figma sandbox without btoa) ──
function uint8ToBase64(u8) {
  var CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var len = u8.length;
  var parts = [];
  for (var i = 0; i < len; i += 3) {
    parts.push(CHARS[u8[i] >> 2]);
    parts.push(CHARS[((u8[i] & 3) << 4) | ((i + 1 < len ? u8[i + 1] : 0) >> 4)]);
    parts.push((i + 1 < len) ? CHARS[((u8[i + 1] & 15) << 2) | ((i + 2 < len ? u8[i + 2] : 0) >> 6)] : '=');
    parts.push((i + 2 < len) ? CHARS[u8[i + 2] & 63] : '=');
  }
  return parts.join('');
}

// ── Detect image format from magic bytes ──
function detectImageFormat(bytes) {
  if (!bytes || bytes.length < 12) return 'png';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  return 'png';
}

// ── Walk Figma node tree and collect image assets to export ──
function collectImageAssets(node, depth, collected) {
  if (depth > MAX_IMAGE_SCAN_DEPTH) return;
  if (collected.totalCount >= MAX_IMAGE_ASSETS + MAX_VECTOR_ASSETS + MAX_COMPOSITE_ASSETS) return;
  // Skip invisible nodes — they can't be exported and produce errors
  if (safeBool(node.visible, true) === false) return;

  // Check fills for IMAGE type (these have imageHash)
  var fills = safeArr(safe(node.fills));
  for (var i = 0; i < fills.length; i++) {
    var f = fills[i];
    if (f && f.type === 'IMAGE' && f.imageHash) {
      var hash = safeStr(f.imageHash, '');
      if (hash && !collected.imageHashes[hash]) {
        collected.imageHashes[hash] = {
          nodeId: safeStr(node.id, ''),
          nodeName: safeStr(node.name, ''),
          width: safeNum(node.width, 0),
          height: safeNum(node.height, 0)
        };
        collected.totalCount++;
      }
    }
  }

  // Check for vector-like nodes (icons, shapes) — skip invisible or zero-size
  var nt = safeStr(node.type, '');
  var isVector = (nt === 'VECTOR' || nt === 'STAR' || nt === 'LINE' ||
                  nt === 'POLYGON' || nt === 'BOOLEAN_OPERATION');
  var nodeVisible = safeBool(node.visible, true);
  var nodeW = safeNum(node.width, 0);
  var nodeH = safeNum(node.height, 0);
  if (isVector && nodeVisible && (nodeW > 0 || nodeH > 0) && collected.vectorNodes.length < MAX_VECTOR_ASSETS) {
    collected.vectorNodes.push({
      node: node,
      nodeId: safeStr(node.id, ''),
      nodeName: safeStr(node.name, '')
    });
    collected.totalCount++;
  }

  // Check for INSTANCE/COMPONENT/FRAME nodes that contain IMAGE fills in their
  // subtree — these should be exported as composed PNGs (e.g. clipped avatars).
  // We detect this by looking at whether this node's subtree has image fills
  // but the node itself is a container (INSTANCE, COMPONENT, FRAME with clipping).
  var isContainer = (nt === 'INSTANCE' || nt === 'COMPONENT' || nt === 'COMPONENT_SET');
  var isClippedFrame = (nt === 'FRAME' && safeBool(node.clipsContent, false));
  if ((isContainer || isClippedFrame) && depth > 0 && collected.compositeNodes.length < MAX_COMPOSITE_ASSETS) {
    // Check if this container has IMAGE fills within (quick peek at fills and immediate children)
    var hasImageDescendant = subtreeHasImage(node, 0);
    if (hasImageDescendant && !collected.compositeIds[safeStr(node.id, '')]) {
      collected.compositeNodes.push({
        node: node,
        nodeId: safeStr(node.id, ''),
        nodeName: safeStr(node.name, '')
      });
      collected.compositeIds[safeStr(node.id, '')] = true;
      collected.totalCount++;
    }
  }

  // Recurse into children
  if (node.children) {
    for (var c = 0; c < node.children.length; c++) {
      try { collectImageAssets(node.children[c], depth + 1, collected); } catch(e) {}
    }
  }
}

// Quick check: does any node in the subtree have an IMAGE fill? (capped at 4 levels)
function subtreeHasImage(node, d) {
  if (d > 4) return false;
  var fills = safeArr(safe(node.fills));
  for (var i = 0; i < fills.length; i++) {
    if (fills[i] && fills[i].type === 'IMAGE' && fills[i].imageHash) return true;
  }
  if (node.children) {
    for (var c = 0; c < node.children.length; c++) {
      if (subtreeHasImage(node.children[c], d + 1)) return true;
    }
  }
  return false;
}

// ── Export collected image assets (IMAGE fills via getImageByHash + vectors as SVG) ──
function exportImageAssets(collected) {
  var assets = [];
  var promises = [];

  // Export IMAGE fills via figma.getImageByHash
  var hashes = Object.keys(collected.imageHashes);
  for (var i = 0; i < Math.min(hashes.length, MAX_IMAGE_ASSETS); i++) {
    (function(hash) {
      var info = collected.imageHashes[hash];
      try {
        var img = figma.getImageByHash(hash);
        if (img) {
          promises.push(
            img.getBytesAsync().then(function(bytes) {
              assets.push({
                id: hash,
                format: detectImageFormat(bytes),
                data: uint8ToBase64(bytes),
                nodeId: info.nodeId,
                nodeName: info.nodeName,
                width: info.width,
                height: info.height,
                assetType: 'image-fill'
              });
            }).catch(function(e) {
              console.error('[Figma Plugin] Image fill export failed (' + hash.substring(0, 8) + '): ' + e);
            })
          );
        }
      } catch(e) {
        console.error('[Figma Plugin] getImageByHash failed: ' + e);
      }
    })(hashes[i]);
  }

  // Export vector nodes as SVG
  for (var j = 0; j < Math.min(collected.vectorNodes.length, MAX_VECTOR_ASSETS); j++) {
    (function(vec) {
      if (vec.node.exportAsync) {
        promises.push(
          vec.node.exportAsync({ format: 'SVG' }).then(function(bytes) {
            assets.push({
              id: vec.nodeId,
              format: 'svg',
              data: uint8ToBase64(bytes),
              nodeId: vec.nodeId,
              nodeName: vec.nodeName,
              width: safeNum(vec.node.width, 0),
              height: safeNum(vec.node.height, 0),
              assetType: 'vector'
            });
          }).catch(function(e) {
            console.error('[Figma Plugin] Vector export failed (' + vec.nodeId + '): ' + e);
          })
        );
      }
    })(collected.vectorNodes[j]);
  }

  // Export INSTANCE/COMPONENT/FRAME composites as PNG (renders the full composed visual)
  for (var k = 0; k < Math.min(collected.compositeNodes.length, MAX_COMPOSITE_ASSETS); k++) {
    (function(comp) {
      if (comp.node.exportAsync) {
        // Scale down to fit within COMPOSITE_MAX_PX while keeping 1x minimum
        var w = safeNum(comp.node.width, 1);
        var h = safeNum(comp.node.height, 1);
        var maxDim = Math.max(w, h);
        var scale = maxDim > COMPOSITE_MAX_PX ? COMPOSITE_MAX_PX / maxDim : 1;
        promises.push(
          comp.node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } }).then(function(bytes) {
            assets.push({
              id: 'composite_' + comp.nodeId,
              format: detectImageFormat(bytes),
              data: uint8ToBase64(bytes),
              nodeId: comp.nodeId,
              nodeName: comp.nodeName,
              width: Math.round(w * scale),
              height: Math.round(h * scale),
              assetType: 'image-fill'
            });
          }).catch(function(e) {
            console.error('[Figma Plugin] Composite export failed (' + comp.nodeId + '): ' + e);
          })
        );
      }
    })(collected.compositeNodes[k]);
  }

  return Promise.all(promises).then(function() { return assets; });
}

function extractPaint(p) {
  if (!p || typeof p === 'symbol') return null;
  var base = {
    type: safeStr(p.type, 'SOLID'),
    visible: safeBool(p.visible, true),
    opacity: safeNum(p.opacity, 1)
  };
  if (p.type === 'SOLID') {
    return Object.assign({}, base, { color: toColor(p.color) });
  }
  if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL' ||
      p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND') {
    var stops = safeArr(p.gradientStops).map(function(s) {
      return { color: toColor(s.color), position: safeNum(s.position, 0) };
    });
    return Object.assign({}, base, { gradientStops: stops });
  }
  if (p.type === 'IMAGE') {
    return Object.assign({}, base, {
      imageRef: safeStr(p.imageHash, ''),
      scaleMode: safeStr(p.scaleMode, 'FILL')
    });
  }
  return base;
}

function extractEffect(e) {
  if (!e || typeof e === 'symbol') return null;
  var base = { type: safeStr(e.type, ''), visible: safeBool(e.visible, true), radius: safeNum(e.radius, 0) };
  if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
    var offset = e.offset ? { x: safeNum(e.offset.x, 0), y: safeNum(e.offset.y, 0) } : { x: 0, y: 0 };
    return Object.assign({}, base, { color: toColor(e.color), offset: offset, spread: safeNum(e.spread, 0) });
  }
  return base;
}

function extractAutoLayout(node) {
  var mode = safe(node.layoutMode);
  if (!mode || mode === 'NONE') return null;
  return {
    mode: mode,
    spacing: safeNum(node.itemSpacing, 0),
    paddingTop: safeNum(node.paddingTop, 0),
    paddingRight: safeNum(node.paddingRight, 0),
    paddingBottom: safeNum(node.paddingBottom, 0),
    paddingLeft: safeNum(node.paddingLeft, 0),
    primaryAxisAlignItems: safeStr(node.primaryAxisAlignItems, 'MIN'),
    counterAxisAlignItems: safeStr(node.counterAxisAlignItems, 'MIN'),
    layoutWrap: safeStr(node.layoutWrap, 'NO_WRAP')
  };
}

function extractTextStyle(node) {
  var fs = safe(node.fontName);
  if (!fs || typeof fs === 'symbol') return null;
  var lh = safe(node.lineHeight);
  var ls = safe(node.letterSpacing);
  return {
    fontFamily: safeStr(fs.family, ''),
    fontStyle: safeStr(fs.style, ''),
    fontSize: safeNum(node.fontSize, 0),
    fontWeight: parseInt((safeStr(fs.style, '').replace(/[^0-9]/g, '') || '400'), 10),
    letterSpacing: (ls && ls.unit === 'PIXELS') ? safeNum(ls.value, 0) : 0,
    lineHeight: (lh && lh.unit === 'AUTO') ? 'AUTO' : (lh ? safeNum(lh.value, 0) : 0),
    textAlignHorizontal: safeStr(node.textAlignHorizontal, 'LEFT'),
    textAlignVertical: safeStr(node.textAlignVertical, 'TOP'),
    textDecoration: safeStr(node.textDecoration, 'NONE'),
    textCase: safeStr(node.textCase, 'ORIGINAL')
  };
}

function extractDesignNode(node, depth) {
  var fills = safeArr(safe(node.fills)).map(extractPaint).filter(function(p) { return p !== null; });
  var strokes = safeArr(safe(node.strokes)).map(extractPaint).filter(function(p) { return p !== null; });
  var effects = safeArr(safe(node.effects)).map(extractEffect).filter(function(e) { return e !== null; });
  var constraints = safe(node.constraints);

  var base = {
    id: safeStr(node.id, ''),
    name: safeStr(node.name, ''),
    type: safeStr(node.type, ''),
    visible: safeBool(node.visible, true),
    opacity: safeNum(node.opacity, 1),
    blendMode: safeStr(node.blendMode, 'NORMAL'),
    locked: safeBool(node.locked, false),
    x: safeNum(node.x, 0),
    y: safeNum(node.y, 0),
    width: safeNum(node.width, 0),
    height: safeNum(node.height, 0),
    constraintHorizontal: constraints ? safeStr(constraints.horizontal, '') : undefined,
    constraintVertical: constraints ? safeStr(constraints.vertical, '') : undefined,
    fills: fills,
    strokes: strokes,
    strokeWeight: safeNum(node.strokeWeight, 0),
    strokeAlign: safeStr(node.strokeAlign, 'INSIDE'),
    dashPattern: safeArr(safe(node.dashPattern)).filter(function(v) { return typeof v === 'number'; }),
    effects: effects,
    isMask: safeBool(node.isMask, false)
  };

  // Corner radius — can be figma.mixed
  var cr = safe(node.cornerRadius);
  if (cr !== null) {
    if (typeof cr === 'number') {
      base.cornerRadius = cr;
    } else {
      base.topLeftRadius = safeNum(node.topLeftRadius, 0);
      base.topRightRadius = safeNum(node.topRightRadius, 0);
      base.bottomRightRadius = safeNum(node.bottomRightRadius, 0);
      base.bottomLeftRadius = safeNum(node.bottomLeftRadius, 0);
    }
  }

  // Auto-layout
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    var al = extractAutoLayout(node);
    if (al) base.autoLayout = al;
  }

  // Text — every property can be figma.mixed on multi-style text
  if (node.type === 'TEXT') {
    var chars = safe(node.characters);
    base.characters = (typeof chars === 'string') ? chars : '';
    try {
      var ts = extractTextStyle(node);
      if (ts) base.textStyle = ts;
    } catch(e) {}
  }

  // Component
  if (node.type === 'INSTANCE') {
    var mc = safe(node.mainComponent);
    base.componentId = mc ? safeStr(mc.id, '') : undefined;
  }

  // Children
  if (depth < MAX_TREE_DEPTH && node.children) {
    base.children = [];
    for (var i = 0; i < node.children.length; i++) {
      try {
        base.children.push(extractDesignNode(node.children[i], depth + 1));
      } catch(e) {}
    }
  }

  return base;
}

function sendCurrentSelection(force) {
  var selection = figma.currentPage.selection;

  if (selection.length === 0) {
    figma.ui.postMessage({ type: 'selection-cleared' });
    lastNodeId = null;
    return;
  }

  if (selection.length > 1) {
    var multiNodes = [];
    for (var i = 0; i < Math.min(5, selection.length); i++) {
      multiNodes.push({ id: selection[i].id, name: selection[i].name, type: selection[i].type });
    }
    figma.ui.postMessage({ type: 'multi-selection', count: selection.length, nodes: multiNodes });
    return;
  }

  var node = selection[0];
  if (!force && node.id === lastNodeId) return;
  lastNodeId = node.id;

  var metadata = {
    nodeName: safeStr(node.name, ''),
    nodeType: safeStr(node.type, ''),
    parentId: (node.parent ? safeStr(node.parent.id, '') : null),
    width: safeNum(node.width, 0),
    height: safeNum(node.height, 0),
    visible: safeBool(node.visible, true)
  };

  var designTree = null;
  try {
    designTree = extractDesignNode(node, 0);
  } catch (err) {
    console.error('[Figma Plugin] extractDesignNode failed: ' + err);
  }

  // Send design tree immediately
  figma.ui.postMessage({
    type: 'selection-changed',
    fileId: (figma.fileKey || 'unknown'),
    nodeId: node.id,
    pageId: figma.currentPage.id,
    userId: (figma.currentUser ? figma.currentUser.id : null) || 'anonymous',
    metadata: metadata,
    designTree: designTree
  });

  // Collect and export individual image assets asynchronously
  var capturedNodeId = node.id;
  var mySeq = ++selectionSeq;
  var collected = { imageHashes: {}, vectorNodes: [], compositeNodes: [], compositeIds: {}, totalCount: 0 };
  try {
    collectImageAssets(node, 0, collected);
  } catch(e) {
    console.error('[Figma Plugin] collectImageAssets failed: ' + e);
  }

  var assetCount = Object.keys(collected.imageHashes).length + collected.vectorNodes.length + collected.compositeNodes.length;
  if (assetCount > 0) {
    exportImageAssets(collected).then(function(assets) {
      if (assets.length > 0 && mySeq === selectionSeq) {
        figma.ui.postMessage({
          type: 'images-extracted',
          nodeId: capturedNodeId,
          assets: assets
        });
      }
    });
  }
}

figma.on('selectionchange', function() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(function() { sendCurrentSelection(false); }, DEBOUNCE_MS);
});

figma.ui.onmessage = function(msg) {
  if (msg.type === 'close') {
    figma.closePlugin();
  } else if (msg.type === 'refresh') {
    sendCurrentSelection(true);
  } else if (msg.type === 'set-server-url') {
    figma.ui.postMessage({ type: 'server-url-updated', serverUrl: msg.url });
  }
};
