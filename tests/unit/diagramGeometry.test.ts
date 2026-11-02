/**
 * Exercises resources/diagram-sandbox/geometry.js — the exact file the sandbox
 * page loads — by evaluating it in a fresh vm context (it is a classic script
 * that defines globalThis.MintGeometry).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

type Shape =
  | { kind: 'circle'; x: number; y: number; r: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'segment'; x1: number; y1: number; x2: number; y2: number; width: number }
  | { kind: 'polygon'; points: [number, number][] }
interface Rect {
  left: number
  top: number
  width: number
  height: number
}
interface Region {
  id: string
  shape: Shape
  order: number
}
interface Geometry {
  normalizeShape(shape: unknown): Shape | null
  distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number
  pointInPolygon(px: number, py: number, points: [number, number][]): boolean
  hitShape(shape: Shape, x: number, y: number, tolerance: number): boolean
  pickRegion(regions: Iterable<Region>, x: number, y: number, tolerance: number): string | null
  clientToCanvas(cx: number, cy: number, rect: Rect, w: number, h: number): { x: number; y: number }
  canvasToLayerTransform(
    canvasRect: Rect,
    layerRect: Rect,
    w: number,
    h: number,
    dpr: number
  ): { sx: number; sy: number; tx: number; ty: number }
  applyTransform(t: { sx: number; sy: number; tx: number; ty: number }, x: number, y: number): { x: number; y: number }
  cssToCanvasDistance(css: number, rect: Rect, w: number, h: number): number
  fitScale(cw: number, ch: number, bw: number, bh: number): number
}

function loadGeometry(): Geometry {
  const source = readFileSync(resolve(__dirname, '../../resources/diagram-sandbox/geometry.js'), 'utf8')
  const context: { MintGeometry?: Geometry } = {}
  runInNewContext(source, context, { filename: 'geometry.js' })
  if (!context.MintGeometry) throw new Error('geometry.js did not define MintGeometry')
  return context.MintGeometry
}

const G = loadGeometry()

function shape(input: unknown): Shape {
  const s = G.normalizeShape(input)
  if (!s) throw new Error(`invalid shape ${JSON.stringify(input)}`)
  return s
}

describe('normalizeShape', () => {
  it('accepts each supported shape', () => {
    expect(G.normalizeShape({ circle: [1, 2, 3] })).toMatchObject({ kind: 'circle', x: 1, y: 2, r: 3 })
    expect(G.normalizeShape({ rect: [0, 0, 10, 5] })).toMatchObject({ kind: 'rect', w: 10, h: 5 })
    expect(G.normalizeShape({ segment: [0, 0, 1, 1] })).toMatchObject({ kind: 'segment', width: 0 })
    expect(G.normalizeShape({ segment: [0, 0, 1, 1], width: 6 })).toMatchObject({ width: 6 })
    expect(G.normalizeShape({ polygon: [[0, 0], [1, 0], [0, 1]] })).toMatchObject({ kind: 'polygon' })
  })

  it('normalises negative rect sizes', () => {
    expect(G.normalizeShape({ rect: [10, 10, -4, -6] })).toMatchObject({ x: 6, y: 4, w: 4, h: 6 })
  })

  it('rejects malformed shapes', () => {
    for (const bad of [
      null,
      42,
      {},
      { circle: [1, 2] },
      { circle: [1, 2, -1] },
      { circle: [1, Number.NaN, 3] },
      { rect: [0, 0, Infinity, 1] },
      { segment: [0, 0, 1, 1], width: -2 },
      { segment: [0, 0, 1, 1], width: '3' },
      { polygon: [[0, 0], [1, 1]] },
      { polygon: [[0, 0], [1, 1], [2]] },
      { polygon: 'nope' }
    ]) {
      expect(G.normalizeShape(bad)).toBeNull()
    }
  })
})

describe('hitShape', () => {
  it('circle: inside, boundary, outside, tolerance', () => {
    const c = shape({ circle: [50, 50, 10] })
    expect(G.hitShape(c, 50, 50, 0)).toBe(true)
    expect(G.hitShape(c, 60, 50, 0)).toBe(true)
    expect(G.hitShape(c, 63, 50, 0)).toBe(false)
    expect(G.hitShape(c, 63, 50, 4)).toBe(true)
  })

  it('rect: inside, outside, tolerance', () => {
    const r = shape({ rect: [10, 20, 30, 40] })
    expect(G.hitShape(r, 10, 20, 0)).toBe(true)
    expect(G.hitShape(r, 40, 60, 0)).toBe(true)
    expect(G.hitShape(r, 41, 60, 0)).toBe(false)
    expect(G.hitShape(r, 43, 60, 4)).toBe(true)
    expect(G.hitShape(r, 25, 15, 0)).toBe(false)
  })

  it('segment: distance <= width / 2 + tolerance, clamped to the endpoints', () => {
    const s = shape({ segment: [0, 0, 100, 0], width: 10 })
    expect(G.hitShape(s, 50, 5, 0)).toBe(true)
    expect(G.hitShape(s, 50, 9, 0)).toBe(false)
    expect(G.hitShape(s, 50, 9, 4)).toBe(true)
    expect(G.hitShape(s, 50, 9.1, 4)).toBe(false)
    // Beyond the end: distance is to the endpoint, not to the infinite line.
    expect(G.hitShape(s, 108, 0, 4)).toBe(true)
    expect(G.hitShape(s, 110, 0, 4)).toBe(false)
  })

  it('segment: zero-length segment behaves like a point', () => {
    const s = shape({ segment: [5, 5, 5, 5] })
    expect(G.hitShape(s, 8, 5, 4)).toBe(true)
    expect(G.hitShape(s, 10, 5, 4)).toBe(false)
  })

  it('polygon: point-in-polygon for a concave outline', () => {
    // A "C"/U shape open at the top: notch between x=4..6 above y=2.
    const u = shape({ polygon: [[0, 0], [10, 0], [10, 10], [6, 10], [6, 2], [4, 2], [4, 10], [0, 10]] })
    expect(G.hitShape(u, 2, 5, 0)).toBe(true)
    expect(G.hitShape(u, 8, 5, 0)).toBe(true)
    expect(G.hitShape(u, 5, 1, 0)).toBe(true)
    expect(G.hitShape(u, 5, 6, 0)).toBe(false) // inside the notch
    expect(G.hitShape(u, 12, 5, 0)).toBe(false)
  })

  it('polygon: tolerance measured from the nearest edge', () => {
    const tri = shape({ polygon: [[0, 0], [10, 0], [0, 10]] })
    expect(G.hitShape(tri, 5, -3, 0)).toBe(false)
    expect(G.hitShape(tri, 5, -3, 4)).toBe(true)
    expect(G.hitShape(tri, 5, -5, 4)).toBe(false)
  })
})

describe('pickRegion', () => {
  const regions: Region[] = [
    { id: 'big', shape: shape({ rect: [0, 0, 100, 100] }), order: 1 },
    { id: 'ball', shape: shape({ circle: [50, 50, 10] }), order: 2 },
    { id: 'rod', shape: shape({ segment: [0, 90, 100, 90], width: 2 }), order: 3 }
  ]

  it('topmost (highest order) wins where regions overlap', () => {
    expect(G.pickRegion(regions, 50, 50, 0)).toBe('ball')
    expect(G.pickRegion(regions, 50, 90, 0)).toBe('rod')
    expect(G.pickRegion(regions, 10, 10, 0)).toBe('big')
  })

  it('order, not iteration position, decides', () => {
    const reregistered = [...regions, { ...regions[0], order: 10 }]
    expect(G.pickRegion(reregistered, 50, 50, 0)).toBe('big')
  })

  it('returns null on a miss', () => {
    expect(G.pickRegion(regions, 150, 150, 4)).toBeNull()
    expect(G.pickRegion([], 0, 0, 4)).toBeNull()
  })
})

describe('coordinate mapping', () => {
  // A 600x400 p5 canvas shown at 300x200 CSS px, offset by (20, 10) in the page.
  const canvasRect: Rect = { left: 20, top: 10, width: 300, height: 200 }

  it('clientToCanvas undoes CSS scaling and offset', () => {
    expect(G.clientToCanvas(20, 10, canvasRect, 600, 400)).toEqual({ x: 0, y: 0 })
    expect(G.clientToCanvas(170, 110, canvasRect, 600, 400)).toEqual({ x: 300, y: 200 })
    expect(G.clientToCanvas(320, 210, canvasRect, 600, 400)).toEqual({ x: 600, y: 400 })
  })

  it('clientToCanvas is independent of devicePixelRatio (canvas units are logical)', () => {
    // Unscaled canvas: CSS px == canvas units regardless of the backing-store density.
    const unscaled: Rect = { left: 0, top: 0, width: 600, height: 400 }
    expect(G.clientToCanvas(123, 45, unscaled, 600, 400)).toEqual({ x: 123, y: 45 })
  })

  it('canvasToLayerTransform maps canvas units to overlay device pixels (scale + dpr + offset)', () => {
    const layerRect: Rect = { left: 0, top: 0, width: 400, height: 300 }
    const t = G.canvasToLayerTransform(canvasRect, layerRect, 600, 400, 2)
    expect(t).toEqual({ sx: 1, sy: 1, tx: 40, ty: 20 })
    expect(G.applyTransform(t, 600, 400)).toEqual({ x: 640, y: 420 })
  })

  it('canvasToLayerTransform round-trips with clientToCanvas', () => {
    const layerRect: Rect = { left: 5, top: 7, width: 500, height: 400 }
    const dpr = 1.5
    const t = G.canvasToLayerTransform(canvasRect, layerRect, 600, 400, dpr)
    const p = { x: 123, y: 321 }
    const device = G.applyTransform(t, p.x, p.y)
    const client = { x: device.x / dpr + layerRect.left, y: device.y / dpr + layerRect.top }
    const back = G.clientToCanvas(client.x, client.y, canvasRect, 600, 400)
    expect(back.x).toBeCloseTo(p.x, 9)
    expect(back.y).toBeCloseTo(p.y, 9)
  })

  it('cssToCanvasDistance scales hit tolerance with the canvas', () => {
    expect(G.cssToCanvasDistance(4, canvasRect, 600, 400)).toBe(8)
    expect(G.cssToCanvasDistance(4, { left: 0, top: 0, width: 600, height: 400 }, 600, 400)).toBe(4)
  })

  it('fitScale only ever shrinks', () => {
    expect(G.fitScale(600, 400, 300, 400)).toBe(0.5)
    expect(G.fitScale(600, 400, 1200, 100)).toBe(0.25)
    expect(G.fitScale(200, 100, 800, 600)).toBe(1)
    expect(G.fitScale(0, 100, 800, 600)).toBe(1)
  })
})
