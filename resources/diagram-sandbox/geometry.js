/**
 * Pure geometry helpers for the diagram sandbox: shape normalisation,
 * hit-testing and coordinate mapping between CSS pixels and sketch canvas
 * coordinates.
 *
 * Loaded as a classic script by index.html (the sandbox has an opaque origin
 * and the mint-sandbox: scheme is not CORS-enabled, so ES modules cannot be
 * used there). It defines `globalThis.MintGeometry`. Unit tests evaluate this
 * exact file in a Node `vm` context, so keep it dependency-free and DOM-free.
 *
 * Terminology:
 *   canvas units  logical sketch coordinates (p5's `width` x `height`, origin top-left)
 *   CSS pixels    layout pixels as reported by getBoundingClientRect / clientX
 *   device pixels CSS pixels * devicePixelRatio (overlay canvas backing store)
 */
;(function (root) {
  'use strict'

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value)
  }

  function allFinite(values, length) {
    if (!Array.isArray(values) || values.length !== length) return false
    for (let i = 0; i < length; i++) if (!isFiniteNumber(values[i])) return false
    return true
  }

  /**
   * Validates a user-supplied region shape and converts it to an internal form.
   * Accepted inputs (all in canvas units):
   *   {circle: [x, y, r]}
   *   {rect: [x, y, w, h]}                    negative w/h are normalised
   *   {segment: [x1, y1, x2, y2], width?: n}  width defaults to 0 (a hairline)
   *   {polygon: [[x, y], [x, y], [x, y], ...]} at least 3 points
   * Returns null for anything else.
   */
  function normalizeShape(shape) {
    if (!shape || typeof shape !== 'object') return null
    if ('circle' in shape) {
      const c = shape.circle
      if (!allFinite(c, 3) || c[2] < 0) return null
      return { kind: 'circle', x: c[0], y: c[1], r: c[2] }
    }
    if ('rect' in shape) {
      const r = shape.rect
      if (!allFinite(r, 4)) return null
      const x = r[2] < 0 ? r[0] + r[2] : r[0]
      const y = r[3] < 0 ? r[1] + r[3] : r[1]
      return { kind: 'rect', x, y, w: Math.abs(r[2]), h: Math.abs(r[3]) }
    }
    if ('segment' in shape) {
      const s = shape.segment
      if (!allFinite(s, 4)) return null
      const width = shape.width === undefined ? 0 : shape.width
      if (!isFiniteNumber(width) || width < 0) return null
      return { kind: 'segment', x1: s[0], y1: s[1], x2: s[2], y2: s[3], width }
    }
    if ('polygon' in shape) {
      const pts = shape.polygon
      if (!Array.isArray(pts) || pts.length < 3) return null
      const points = []
      for (const p of pts) {
        if (!allFinite(p, 2)) return null
        points.push([p[0], p[1]])
      }
      return { kind: 'polygon', points }
    }
    return null
  }

  /** Shortest distance from point (px, py) to the segment (x1, y1)-(x2, y2). */
  function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1
    const dy = y2 - y1
    const lengthSq = dx * dx + dy * dy
    let t = lengthSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lengthSq
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
  }

  /** Even-odd point-in-polygon test (works for concave and self-intersecting outlines). */
  function pointInPolygon(px, py, points) {
    let inside = false
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i][0]
      const yi = points[i][1]
      const xj = points[j][0]
      const yj = points[j][1]
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }

  /**
   * True when (x, y) hits a normalised shape. `tolerance` (canvas units) grows
   * every shape outward so thin or small parts stay clickable: segments hit
   * within width / 2 + tolerance, polygons within tolerance of an edge.
   */
  function hitShape(shape, x, y, tolerance) {
    const tol = tolerance > 0 ? tolerance : 0
    switch (shape.kind) {
      case 'circle':
        return Math.hypot(x - shape.x, y - shape.y) <= shape.r + tol
      case 'rect':
        return (
          x >= shape.x - tol &&
          x <= shape.x + shape.w + tol &&
          y >= shape.y - tol &&
          y <= shape.y + shape.h + tol
        )
      case 'segment':
        return distanceToSegment(x, y, shape.x1, shape.y1, shape.x2, shape.y2) <= shape.width / 2 + tol
      case 'polygon': {
        if (pointInPolygon(x, y, shape.points)) return true
        if (tol === 0) return false
        const pts = shape.points
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          if (distanceToSegment(x, y, pts[j][0], pts[j][1], pts[i][0], pts[i][1]) <= tol) return true
        }
        return false
      }
      default:
        return false
    }
  }

  /**
   * Picks the topmost region under (x, y). `regions` is any iterable of
   * `{id, shape, order}` where `shape` is normalised and a higher `order` means
   * registered more recently (i.e. drawn later, so visually on top).
   * Returns the winning id or null.
   */
  function pickRegion(regions, x, y, tolerance) {
    let best = null
    for (const region of regions) {
      if (best !== null && region.order <= best.order) continue
      if (hitShape(region.shape, x, y, tolerance)) best = region
    }
    return best === null ? null : best.id
  }

  /**
   * Maps a client (CSS pixel) position to canvas units for a canvas whose
   * bounding rect is `rect` and whose logical size is logicalWidth x logicalHeight.
   * Correct when the canvas is CSS-scaled; independent of devicePixelRatio.
   */
  function clientToCanvas(clientX, clientY, rect, logicalWidth, logicalHeight) {
    const sx = rect.width > 0 ? logicalWidth / rect.width : 1
    const sy = rect.height > 0 ? logicalHeight / rect.height : 1
    return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy }
  }

  /**
   * Builds the affine map from canvas units to device pixels of an overlay
   * canvas that covers `layerRect` (CSS pixels) with a backing store scaled by
   * `dpr`. Returns {sx, sy, tx, ty}: device = canvas * s + t.
   */
  function canvasToLayerTransform(canvasRect, layerRect, logicalWidth, logicalHeight, dpr) {
    const ratio = dpr > 0 ? dpr : 1
    const cssPerUnitX = logicalWidth > 0 ? canvasRect.width / logicalWidth : 1
    const cssPerUnitY = logicalHeight > 0 ? canvasRect.height / logicalHeight : 1
    return {
      sx: cssPerUnitX * ratio,
      sy: cssPerUnitY * ratio,
      tx: (canvasRect.left - layerRect.left) * ratio,
      ty: (canvasRect.top - layerRect.top) * ratio
    }
  }

  /** Applies a transform from canvasToLayerTransform to a point. */
  function applyTransform(t, x, y) {
    return { x: x * t.sx + t.tx, y: y * t.sy + t.ty }
  }

  /** Converts a CSS-pixel distance to canvas units (average of both axes). */
  function cssToCanvasDistance(cssDistance, rect, logicalWidth, logicalHeight) {
    const sx = rect.width > 0 ? logicalWidth / rect.width : 1
    const sy = rect.height > 0 ? logicalHeight / rect.height : 1
    return (cssDistance * (sx + sy)) / 2
  }

  /**
   * Uniform scale (<= 1) that fits a content box into a container box. Content
   * that already fits keeps its natural size; it is never enlarged.
   */
  function fitScale(contentWidth, contentHeight, boxWidth, boxHeight) {
    if (!(contentWidth > 0) || !(contentHeight > 0) || !(boxWidth > 0) || !(boxHeight > 0)) return 1
    return Math.min(1, boxWidth / contentWidth, boxHeight / contentHeight)
  }

  root.MintGeometry = Object.freeze({
    normalizeShape,
    distanceToSegment,
    pointInPolygon,
    hitShape,
    pickRegion,
    clientToCanvas,
    canvasToLayerTransform,
    applyTransform,
    cssToCanvasDistance,
    fitScale
  })
})(globalThis)
