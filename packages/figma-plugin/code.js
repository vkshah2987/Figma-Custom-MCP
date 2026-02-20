// Figma MCP Selection Bridge — Plugin Code (ES5-safe + figma.mixed-safe)
var MCP_SERVER_URL = 'http://localhost:3050';
var DEBOUNCE_MS = 300;
var MAX_DEPTH = 5;
var debounceTimer = null;
var lastNodeId = null;

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
  if (depth < MAX_DEPTH && node.children) {
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

  figma.ui.postMessage({
    type: 'selection-changed',
    fileId: (figma.fileKey || 'unknown'),
    nodeId: node.id,
    pageId: figma.currentPage.id,
    userId: (figma.currentUser ? figma.currentUser.id : null) || 'anonymous',
    metadata: metadata,
    designTree: designTree
  });
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
