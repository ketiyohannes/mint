/**
 * mint diagram sandbox runtime.
 *
 * Runs inside <iframe sandbox="allow-scripts"> (opaque origin, strict CSP, no
 * network) and hosts ONE untrusted, model-generated sketch at a time:
 *
 *   - speaks the postMessage protocol in src/shared/diagramProtocol.ts
 *   - exposes the global `mint` API to sketch code (see README.md "Sketch contract")
 *   - hit-tests clicks/hover against registered p5 regions and three objects
 *   - draws the tutor's highlight on top of the sketch (sketches need no code for it)
 *   - tears a sketch down completely before the next one loads
 *
 * Loaded after vendor/p5.min.js (global `p5`), vendor/three.iife.js (global
 * `THREE`) and geometry.js (global `MintGeometry`).
 */
;(function () {
  'use strict'

  const G = window.MintGeometry
  const NativeP5 = window.p5
  const PristineTHREE = window.THREE

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  /** Extra hit slop around every shape, in CSS pixels. */
  const HIT_TOLERANCE_CSS = 4
  /** Pointer travel (CSS px) above which a press counts as a drag, not a click. */
  const CLICK_MAX_TRAVEL = 6
  /** How long a sketch may take to put a canvas on the stage. */
  const WATCHDOG_MS = 3000
  /** First `loaded` report: late enough for the first draw() frames to register regions. */
  const LOADED_FIRST_MS = 200
  /** Second `loaded` report, after slower per-frame registrations. */
  const LOADED_RESEND_MS = 1000
  /** While the pointer rests, re-hit-test this often so moving parts update hover. */
  const HOVER_RECHECK_MS = 120
  /** A three scene not rendered for this long is considered static; the runtime re-renders it. */
  const STATIC_SCENE_MS = 120
  /** Per-load cap on distinct error reports (a broken draw loop must not flood the host). */
  const MAX_ERRORS_PER_LOAD = 8
  const MAX_ID_LENGTH = 200
  const MAX_MESSAGE_LENGTH = 4000
  const MAX_STACK_LENGTH = 16000
  const MAX_REGISTERED = 500

  const HIGHLIGHT_COLOR = '#f5a524'
  const HIGHLIGHT_SHADOW = 'rgba(17, 17, 17, 0.45)'
  const HOVER_COLOR = 'rgba(70, 110, 255, 0.85)'

  /** p5 global-mode hooks that sketch code may define as top-level functions. */
  const P5_HOOKS = [
    'preload', 'setup', 'draw', 'windowResized',
    'mousePressed', 'mouseReleased', 'mouseClicked', 'doubleClicked',
    'mouseMoved', 'mouseDragged', 'mouseWheel',
    'keyPressed', 'keyReleased', 'keyTyped',
    'touchStarted', 'touchMoved', 'touchEnded',
    'deviceMoved', 'deviceTurned', 'deviceShaken'
  ]

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  const root = document.getElementById('mint-root')
  const stage = document.getElementById('mint-stage')
  const overlay = document.getElementById('mint-overlay')
  const overlayCtx = overlay.getContext('2d')
  const errorBox = document.getElementById('mint-error')

  /** Nodes owned by the page itself; anything else in <head>/<body> came from a sketch. */
  const pageNodes = new Set([...document.head.children, ...document.body.children])

  // -------------------------------------------------------------------------
  // Native APIs, captured before sketch-facing wrappers are installed
  // -------------------------------------------------------------------------

  const native = {
    raf: window.requestAnimationFrame.bind(window),
    caf: window.cancelAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    addEventListener: EventTarget.prototype.addEventListener,
    removeEventListener: EventTarget.prototype.removeEventListener,
    postMessage: window.parent.postMessage.bind(window.parent)
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const state = {
    /** Incremented on every load; async work from older sketches checks it and bails. */
    generation: 0,
    spec: null,
    /** id -> {def, value} */
    params: new Map(),
    paramListeners: new Set(),
    highlightListeners: new Set(),
    resizeListeners: new Set(),
    /** id -> {id, shape (normalised), order} */
    regions: new Map(),
    regionCounter: 0,
    /** id -> Object3D, plus reverse lookup for raycast hits */
    objects: new Map(),
    objectIds: new WeakMap(),
    /** ids in registration order, for `loaded` reports */
    registered: new Set(),
    highlight: new Set(),
    hoverId: null,
    // Resources created by the sketch (all torn down on reset)
    p5Instances: new Set(),
    renderers: new Set(),
    controls: new Set(),
    rafIds: new Set(),
    timeouts: new Set(),
    intervals: new Set(),
    listeners: [],
    // three integration
    three: null, // {camera, renderer, render (unwrapped), lastScene, lastCamera, lastRenderAt}
    boxHelpers: new Map(), // id -> BoxHelper
    threeDirty: false,
    // errors
    evaluating: false,
    evalFailed: false,
    errorCount: 0,
    errorKeys: new Set(),
    warned: new Set(),
    stageSize: { width: 0, height: 0 }
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  function post(message) {
    // The host has an unpredictable origin (dev server or file://) and we are
    // opaque; the host verifies `event.source` instead of the origin.
    native.postMessage(message, '*')
  }

  function isValidId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH
  }

  function warnOnce(message) {
    if (state.warned.has(message)) return
    state.warned.add(message)
    console.warn('[mint] ' + message)
  }

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  function describeError(error) {
    if (error instanceof Error) {
      const message = error.name && !String(error.message).startsWith(error.name)
        ? error.name + ': ' + error.message
        : String(error.message)
      return { message, stack: error.stack ? String(error.stack) : undefined }
    }
    return { message: String(error), stack: undefined }
  }

  function reportError(message, stack) {
    if (state.evaluating) state.evalFailed = true
    const text = String(message || 'Unknown error').replace(/^Uncaught\s+/, '').slice(0, MAX_MESSAGE_LENGTH)
    if (state.errorKeys.has(text) || state.errorCount >= MAX_ERRORS_PER_LOAD) return
    state.errorKeys.add(text)
    state.errorCount++
    showInlineError(text)
    const payload = { type: 'error', message: text }
    if (stack) payload.stack = String(stack).slice(0, MAX_STACK_LENGTH)
    post(payload)
  }

  function reportException(error, context) {
    const { message, stack } = describeError(error)
    reportError(context ? context + ': ' + message : message, stack)
  }

  function showInlineError(text) {
    errorBox.textContent = text.split('\n')[0]
    errorBox.hidden = false
  }

  native.addEventListener.call(window, 'error', (event) => {
    // Resource load failures also dispatch `error` (non-ErrorEvent); ignore them.
    if (!(event instanceof ErrorEvent)) return
    let message = event.message || describeError(event.error).message
    let stack = event.error && event.error.stack
    // Chromium reports syntax errors in the injected sketch as thrown from our appendChild call.
    if (/Failed to execute 'appendChild' on 'Node': /.test(message)) {
      message = message.replace(/Failed to execute 'appendChild' on 'Node': /, '')
      stack = undefined // points into runtime.js, not the sketch
    }
    // Sketch code is the only inline script, so its errors carry the page URL or its sourceURL.
    const filename = event.filename || ''
    if (event.lineno && (filename === location.href || /mint-sketch\.js$/.test(filename))) {
      message += ' (sketch line ' + event.lineno + ')'
    }
    reportError(message, stack)
  })

  native.addEventListener.call(window, 'unhandledrejection', (event) => {
    const { message, stack } = describeError(event.reason)
    reportError('Unhandled promise rejection: ' + message, stack)
  })

  // -------------------------------------------------------------------------
  // Resource tracking: wrappers sketch code sees instead of the native APIs
  // -------------------------------------------------------------------------

  /** Wraps a sketch callback so it silently no-ops once its sketch was unloaded. */
  function guarded(callback) {
    const generation = state.generation
    return function () {
      if (generation !== state.generation) return
      return callback.apply(this, arguments)
    }
  }

  function trackedRequestAnimationFrame(callback) {
    const run = guarded(callback)
    const id = native.raf((time) => {
      state.rafIds.delete(id)
      run(time)
    })
    state.rafIds.add(id)
    return id
  }

  function trackedCancelAnimationFrame(id) {
    state.rafIds.delete(id)
    native.caf(id)
  }

  function trackedSetTimeout(callback, delay, ...args) {
    if (typeof callback !== 'function') {
      warnOnce('setTimeout with a string is not supported')
      return 0
    }
    const run = guarded(callback)
    const id = native.setTimeout(() => {
      state.timeouts.delete(id)
      run(...args)
    }, delay)
    state.timeouts.add(id)
    return id
  }

  function trackedClearTimeout(id) {
    state.timeouts.delete(id)
    native.clearTimeout(id)
  }

  function trackedSetInterval(callback, delay, ...args) {
    if (typeof callback !== 'function') {
      warnOnce('setInterval with a string is not supported')
      return 0
    }
    const run = guarded(callback)
    const id = native.setInterval(() => run(...args), delay)
    state.intervals.add(id)
    return id
  }

  function trackedClearInterval(id) {
    state.intervals.delete(id)
    native.clearInterval(id)
  }

  function makeTrackedAddEventListener(target) {
    return function addEventListener(type, listener, options) {
      state.listeners.push([target, type, listener, options])
      return native.addEventListener.call(target, type, listener, options)
    }
  }

  /** p5 constructor that defaults the parent to the stage and records instances. */
  function TrackedP5(sketch, node) {
    const instance = new NativeP5(sketch, node || stage)
    state.p5Instances.add(instance)
    return instance
  }
  TrackedP5.prototype = NativeP5.prototype
  Object.setPrototypeOf(TrackedP5, NativeP5) // static members (p5.Vector, p5.Color, ...)

  /** A fresh THREE namespace per sketch, with renderers/controls tracked for disposal. */
  function makeSketchTHREE() {
    class WebGLRenderer extends PristineTHREE.WebGLRenderer {
      constructor(...args) {
        super(...args)
        state.renderers.add(this)
      }
    }
    class OrbitControls extends PristineTHREE.OrbitControls {
      constructor(...args) {
        super(...args)
        state.controls.add(this)
      }
    }
    return Object.freeze({ ...PristineTHREE, WebGLRenderer, OrbitControls })
  }

  function installSketchGlobals() {
    window.requestAnimationFrame = trackedRequestAnimationFrame
    window.cancelAnimationFrame = trackedCancelAnimationFrame
    window.setTimeout = trackedSetTimeout
    window.clearTimeout = trackedClearTimeout
    window.setInterval = trackedSetInterval
    window.clearInterval = trackedClearInterval
    window.addEventListener = makeTrackedAddEventListener(window)
    document.addEventListener = makeTrackedAddEventListener(document)
    window.p5 = TrackedP5
    window.THREE = makeSketchTHREE()
    window.mint = mint
  }

  // -------------------------------------------------------------------------
  // Params
  // -------------------------------------------------------------------------

  function clampParam(def, value) {
    return Math.min(def.max, Math.max(def.min, value))
  }

  /** Sets a parameter; returns true when the value actually changed. */
  function applyParam(id, value) {
    const entry = state.params.get(id)
    if (!entry || typeof value !== 'number' || !Number.isFinite(value)) return false
    const next = clampParam(entry.def, value)
    if (next === entry.value) return false
    entry.value = next
    for (const listener of [...state.paramListeners]) {
      try {
        listener(id, next)
      } catch (error) {
        reportException(error, 'mint.onParam callback')
      }
    }
    return true
  }

  // -------------------------------------------------------------------------
  // The `mint` API exposed to sketch code
  // -------------------------------------------------------------------------

  const mint = Object.freeze({
    /** Current value of a parameter declared in spec.params. */
    param(id) {
      const entry = state.params.get(id)
      if (!entry) {
        warnOnce('mint.param: unknown parameter "' + id + '"')
        return 0
      }
      return entry.value
    },

    /** Subscribe to parameter changes (host slider or mint.setParam). Returns an unsubscribe function. */
    onParam(callback) {
      if (typeof callback !== 'function') return () => {}
      const run = guarded(callback)
      state.paramListeners.add(run)
      return () => state.paramListeners.delete(run)
    },

    /** Change a parameter from sketch code (e.g. dragging a handle); the host's slider follows. */
    setParam(id, value) {
      if (!state.params.has(id)) {
        warnOnce('mint.setParam: unknown parameter "' + id + '"')
        return
      }
      if (applyParam(id, value)) {
        post({ type: 'param-changed', id, value: state.params.get(id).value })
      }
    },

    /**
     * Register or update the clickable area of an element, in p5 canvas
     * coordinates. Call it every frame for moving parts; the latest call wins
     * and later-registered regions are on top.
     */
    region(id, shape) {
      if (!isValidId(id)) {
        warnOnce('mint.region: id must be a non-empty string')
        return
      }
      const normalized = G.normalizeShape(shape)
      if (!normalized) {
        warnOnce('mint.region: invalid shape for "' + id + '"')
        return
      }
      state.regions.set(id, { id, shape: normalized, order: ++state.regionCounter })
      noteRegistered(id)
    },

    /** Register a three.js Object3D (mesh, group, line, ...) as a clickable element. */
    object(id, object3D) {
      if (!isValidId(id)) {
        warnOnce('mint.object: id must be a non-empty string')
        return
      }
      if (!object3D || object3D.isObject3D !== true) {
        warnOnce('mint.object: "' + id + '" is not a THREE.Object3D')
        return
      }
      const previous = state.objects.get(id)
      if (previous && previous !== object3D) {
        state.objectIds.delete(previous)
        removeBoxHelper(id)
      }
      state.objects.set(id, object3D)
      state.objectIds.set(object3D, id)
      noteRegistered(id)
      if (state.highlight.has(id)) syncBoxHelpers()
    },

    /** Tell the runtime which camera/renderer to raycast with (and keep sized to the stage). */
    useCamera(camera, renderer) {
      if (!camera || camera.isCamera !== true || !renderer || !renderer.domElement) {
        warnOnce('mint.useCamera expects (THREE.Camera, THREE.WebGLRenderer)')
        return
      }
      if (state.three && state.three.renderer === renderer) {
        state.three.camera = camera
        return
      }
      const render = renderer.render.bind(renderer)
      const three = { camera, renderer, render, lastScene: null, lastCamera: null, lastRenderAt: 0 }
      // Observe renders so static scenes can be re-rendered when the highlight changes.
      renderer.render = function (scene, renderCamera) {
        three.lastScene = scene
        three.lastCamera = renderCamera
        three.lastRenderAt = performance.now()
        return render(scene, renderCamera)
      }
      state.three = three
    },

    /** True while the tutor highlights this element (for custom emphasis). */
    isHighlighted(id) {
      return state.highlight.has(id)
    },

    /** Subscribe to highlight changes: callback(ids: string[]). Returns an unsubscribe function. */
    onHighlight(callback) {
      if (typeof callback !== 'function') return () => {}
      const run = guarded(callback)
      state.highlightListeners.add(run)
      return () => state.highlightListeners.delete(run)
    },

    /** Subscribe to stage size changes: callback(width, height). Returns an unsubscribe function. */
    onResize(callback) {
      if (typeof callback !== 'function') return () => {}
      const run = guarded(callback)
      state.resizeListeners.add(run)
      return () => state.resizeListeners.delete(run)
    },

    get width() {
      return stage.clientWidth
    },
    get height() {
      return stage.clientHeight
    },
    get stage() {
      return stage
    }
  })

  function noteRegistered(id) {
    if (state.registered.size < MAX_REGISTERED) state.registered.add(id)
  }

  // -------------------------------------------------------------------------
  // Loading and teardown
  // -------------------------------------------------------------------------

  /** Window properties present before any sketch ran; everything else is sketch garbage. */
  let baselineGlobals = null

  function resetSketch() {
    state.generation++

    for (const instance of state.p5Instances) {
      try {
        instance.remove()
      } catch (error) {
        console.warn('[mint] p5 remove failed', error)
      }
    }
    state.p5Instances.clear()
    NativeP5.instance = null

    for (const helperId of [...state.boxHelpers.keys()]) removeBoxHelper(helperId)
    for (const controls of state.controls) {
      try {
        controls.dispose()
      } catch {
        /* already disposed */
      }
    }
    state.controls.clear()
    for (const renderer of state.renderers) {
      try {
        renderer.setAnimationLoop(null)
        renderer.dispose()
        renderer.forceContextLoss()
      } catch {
        /* already disposed */
      }
    }
    state.renderers.clear()
    state.three = null

    for (const id of state.rafIds) native.caf(id)
    for (const id of state.timeouts) native.clearTimeout(id)
    for (const id of state.intervals) native.clearInterval(id)
    state.rafIds.clear()
    state.timeouts.clear()
    state.intervals.clear()
    for (const [target, type, listener, options] of state.listeners) {
      native.removeEventListener.call(target, type, listener, options)
    }
    state.listeners = []

    stage.replaceChildren()
    for (const node of [...document.body.children, ...document.head.children]) {
      if (!pageNodes.has(node)) node.remove()
    }

    if (baselineGlobals) {
      for (const key of Object.getOwnPropertyNames(window)) {
        if (baselineGlobals.has(key)) continue
        try {
          delete window[key]
        } catch {
          /* non-configurable; harmless */
        }
      }
    }
    for (const hook of P5_HOOKS) {
      try {
        delete window[hook]
      } catch {
        /* ignore */
      }
    }
    // p5's remove() deletes every window key that matches p5.prototype; restore ours.
    installSketchGlobals()

    state.spec = null
    state.params.clear()
    state.paramListeners.clear()
    state.highlightListeners.clear()
    state.resizeListeners.clear()
    state.regions.clear()
    state.regionCounter = 0
    state.objects.clear()
    state.objectIds = new WeakMap()
    state.registered.clear()
    state.highlight.clear()
    setHover(null, true)
    state.errorCount = 0
    state.errorKeys.clear()
    state.warned.clear()
    errorBox.hidden = true
    errorBox.textContent = ''
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0)
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
  }

  function isValidSpec(spec) {
    return (
      spec !== null &&
      typeof spec === 'object' &&
      (spec.engine === 'p5' || spec.engine === 'three') &&
      typeof spec.code === 'string'
    )
  }

  function loadSpec(spec) {
    resetSketch()
    if (!isValidSpec(spec)) {
      reportError('Invalid diagram spec')
      return
    }
    state.spec = spec
    for (const def of Array.isArray(spec.params) ? spec.params : []) {
      if (!def || !isValidId(def.id)) continue
      const min = Number.isFinite(def.min) ? def.min : 0
      const max = Number.isFinite(def.max) && def.max >= min ? def.max : min
      const value = Number.isFinite(def.value) ? Math.min(max, Math.max(min, def.value)) : min
      state.params.set(def.id, { def: { ...def, min, max }, value })
    }

    const generation = state.generation
    if (!evaluateSketch(spec.code, spec.engine)) return
    if (spec.engine === 'p5' && !startGlobalP5()) return

    // setup() has run synchronously; report after the first frames, then again
    // once per-frame regions have had time to register.
    native.setTimeout(() => reportLoaded(generation), LOADED_FIRST_MS)
    native.setTimeout(() => reportLoaded(generation), LOADED_RESEND_MS)
    native.setTimeout(() => {
      if (generation === state.generation && !hasVisibleCanvas()) {
        reportError('The diagram did not draw anything')
      }
    }, WATCHDOG_MS)
  }

  /**
   * Runs sketch code as a classic inline script so p5 global mode works. The
   * body is wrapped in a function so top-level let/const do not leak into the
   * global lexical scope (which would make a second load throw "already
   * declared"); p5 hooks are then exported to window explicitly.
   * Line numbers in errors match the sketch source because the wrapper opens
   * on the same line as the first line of code.
   */
  function evaluateSketch(code, engine) {
    const exportHooks = engine === 'p5'
      ? P5_HOOKS.map((h) => 'if (typeof ' + h + " === 'function') window." + h + ' = ' + h + ';').join(' ')
      : ''
    const script = document.createElement('script')
    script.textContent = '(function () {' + code + '\n;' + exportHooks + '\n}).call(window)\n//# sourceURL=mint-sketch.js'
    state.evaluating = true
    state.evalFailed = false
    try {
      document.head.appendChild(script) // executes synchronously; errors go to the window 'error' handler
    } finally {
      script.remove()
      state.evaluating = false
    }
    return !state.evalFailed
  }

  /** Starts p5 in global mode unless the sketch already created an instance itself. */
  function startGlobalP5() {
    if (state.p5Instances.size > 0) return true
    if (typeof window.setup !== 'function' && typeof window.draw !== 'function') {
      reportError('p5 sketch defines neither setup() nor draw()')
      return false
    }
    state.evaluating = true
    state.evalFailed = false
    try {
      new TrackedP5() // setup() runs synchronously here because the document is loaded
    } catch (error) {
      reportException(error)
    } finally {
      state.evaluating = false
    }
    return !state.evalFailed
  }

  /** `loaded` means "running without errors so far"; a failing sketch only ever reports `error`. */
  function reportLoaded(generation) {
    if (generation !== state.generation || state.errorCount > 0) return
    post({ type: 'loaded', registered: [...state.registered] })
  }

  function hasVisibleCanvas() {
    for (const canvas of stage.querySelectorAll('canvas')) {
      if (canvas.style.display !== 'none' && canvas.offsetWidth > 0 && canvas.offsetHeight > 0) return true
    }
    return false
  }

  // Sketches sometimes append their canvas to <body>; move it onto the stage.
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLCanvasElement && node.style.display !== 'none') stage.appendChild(node)
      }
    }
  }).observe(document.body, { childList: true })

  // -------------------------------------------------------------------------
  // Geometry targets
  // -------------------------------------------------------------------------

  /**
   * The canvas p5 regions refer to: the first p5 instance's main canvas
   * (logical size = p5 width/height), else the first visible stage canvas.
   */
  function regionTarget() {
    for (const instance of state.p5Instances) {
      const canvas = instance._renderer && instance._renderer.elt
      if (canvas && canvas.isConnected && instance.width > 0 && instance.height > 0) {
        return { canvas, width: instance.width, height: instance.height }
      }
    }
    const canvas = stage.querySelector('canvas')
    if (canvas && canvas.offsetWidth > 0) {
      return { canvas, width: canvas.offsetWidth, height: canvas.offsetHeight }
    }
    return null
  }

  /** Shrinks p5 canvases that are larger than the stage (CSS only; p5's mouse mapping stays correct). */
  function fitP5Canvases() {
    const boxWidth = stage.clientWidth
    const boxHeight = stage.clientHeight
    for (const instance of state.p5Instances) {
      const canvas = instance._renderer && instance._renderer.elt
      if (!canvas || !canvas.isConnected || !(instance.width > 0)) continue
      const scale = G.fitScale(instance.width, instance.height, boxWidth, boxHeight)
      const width = instance.width * scale + 'px'
      const height = instance.height * scale + 'px'
      if (canvas.style.width !== width) canvas.style.width = width
      if (canvas.style.height !== height) canvas.style.height = height
    }
  }

  function isVisibleInScene(object) {
    for (let o = object; o; o = o.parent) if (o.visible === false) return false
    return true
  }

  const raycaster = new PristineTHREE.Raycaster()
  const pointerNdc = new PristineTHREE.Vector2()

  /** Raycasts registered three objects; the nearest registered ancestor of the closest hit wins. */
  function pickObject(clientX, clientY) {
    const three = state.three
    if (!three || state.objects.size === 0) return null
    const rect = three.renderer.domElement.getBoundingClientRect()
    if (!insideRect(rect, clientX, clientY, 0)) return null
    pointerNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointerNdc, three.camera)
    let hits
    try {
      hits = raycaster.intersectObjects([...state.objects.values()], true)
    } catch (error) {
      reportException(error, 'Raycast failed')
      return null
    }
    for (const hit of hits) {
      if (hit.object.userData && hit.object.userData.mintHelper) continue
      if (!isVisibleInScene(hit.object)) continue
      for (let o = hit.object; o; o = o.parent) {
        const id = state.objectIds.get(o)
        if (id !== undefined && state.objects.get(id) === o) return id
      }
    }
    return null
  }

  function insideRect(rect, x, y, margin) {
    return x >= rect.left - margin && x <= rect.right + margin && y >= rect.top - margin && y <= rect.bottom + margin
  }

  /** Element id under a client position, or null. 2D regions take precedence over 3D objects. */
  function hitTest(clientX, clientY) {
    if (state.regions.size > 0) {
      const target = regionTarget()
      if (target) {
        const rect = target.canvas.getBoundingClientRect()
        if (insideRect(rect, clientX, clientY, HIT_TOLERANCE_CSS)) {
          const p = G.clientToCanvas(clientX, clientY, rect, target.width, target.height)
          const tolerance = G.cssToCanvasDistance(HIT_TOLERANCE_CSS, rect, target.width, target.height)
          const id = G.pickRegion(state.regions.values(), p.x, p.y, tolerance)
          if (id !== null) return id
        }
      }
    }
    return pickObject(clientX, clientY)
  }

  function labelFor(id) {
    const elements = state.spec && Array.isArray(state.spec.elements) ? state.spec.elements : []
    const element = elements.find((e) => e && e.id === id)
    return element && typeof element.label === 'string' && element.label ? element.label : id
  }

  // -------------------------------------------------------------------------
  // Pointer: click + hover
  // -------------------------------------------------------------------------

  const pointer = { inside: false, x: 0, y: 0, down: null, hoverQueued: false, lastHoverCheck: 0 }

  function setHover(id, notify) {
    if (id === state.hoverId) return
    state.hoverId = id
    document.body.classList.toggle('mint-hover', id !== null)
    if (notify) post({ type: 'hover', id })
  }

  function updateHover() {
    pointer.hoverQueued = false
    pointer.lastHoverCheck = performance.now()
    if (!state.spec) return
    setHover(pointer.inside ? hitTest(pointer.x, pointer.y) : null, true)
  }

  function queueHover() {
    if (pointer.hoverQueued) return
    pointer.hoverQueued = true
    native.raf(updateHover) // at most one hit-test (and message) per frame
  }

  native.addEventListener.call(stage, 'pointermove', (event) => {
    pointer.inside = true
    pointer.x = event.clientX
    pointer.y = event.clientY
    queueHover()
  })

  native.addEventListener.call(stage, 'pointerleave', () => {
    pointer.inside = false
    queueHover()
  })

  native.addEventListener.call(stage, 'pointerdown', (event) => {
    if (event.button !== 0) return
    pointer.down = { id: event.pointerId, x: event.clientX, y: event.clientY }
  }, true)

  native.addEventListener.call(stage, 'pointerup', (event) => {
    const down = pointer.down
    pointer.down = null
    if (!down || down.id !== event.pointerId || !state.spec) return
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_MAX_TRAVEL) return // a drag
    const id = hitTest(event.clientX, event.clientY)
    if (id !== null) post({ type: 'element-click', id, label: labelFor(id) })
  }, true)

  // -------------------------------------------------------------------------
  // Highlight rendering
  // -------------------------------------------------------------------------

  function setHighlight(ids) {
    const next = new Set(ids.filter(isValidId))
    state.highlight = next
    syncBoxHelpers()
    const list = [...next]
    for (const listener of [...state.highlightListeners]) {
      try {
        listener(list)
      } catch (error) {
        reportException(error, 'mint.onHighlight callback')
      }
    }
  }

  function syncBoxHelpers() {
    for (const id of [...state.boxHelpers.keys()]) {
      if (!state.highlight.has(id) || !state.objects.has(id)) removeBoxHelper(id)
    }
    for (const id of state.highlight) {
      const object = state.objects.get(id)
      if (!object || state.boxHelpers.has(id)) continue
      const helper = new PristineTHREE.BoxHelper(object, HIGHLIGHT_COLOR)
      helper.userData.mintHelper = true
      helper.raycast = () => {} // never a click target
      helper.renderOrder = 999
      helper.material.depthTest = false
      helper.material.transparent = true
      state.boxHelpers.set(id, helper)
    }
    state.threeDirty = true
  }

  function removeBoxHelper(id) {
    const helper = state.boxHelpers.get(id)
    if (!helper) return
    helper.removeFromParent()
    helper.geometry.dispose()
    helper.material.dispose()
    state.boxHelpers.delete(id)
    state.threeDirty = true
  }

  /** Keeps box helpers attached to the object's scene root and fitted to the object. */
  function updateBoxHelpers(pulse) {
    for (const [id, helper] of state.boxHelpers) {
      const object = state.objects.get(id)
      let sceneRoot = object
      while (sceneRoot && sceneRoot.parent) sceneRoot = sceneRoot.parent
      if (!sceneRoot || sceneRoot === object) continue // not in a scene yet
      if (helper.parent !== sceneRoot) sceneRoot.add(helper)
      helper.update()
      helper.visible = isVisibleInScene(object)
      helper.material.opacity = 0.55 + 0.45 * pulse
    }
    const needsRender = state.boxHelpers.size > 0 || state.threeDirty
    state.threeDirty = false
    const three = state.three
    if (!needsRender || !three || !three.lastScene) return
    // Animated scenes pick the helpers up on their next render; static scenes need a nudge.
    if (performance.now() - three.lastRenderAt > STATIC_SCENE_MS) {
      try {
        three.render(three.lastScene, three.lastCamera || three.camera)
      } catch (error) {
        reportException(error, 'Render failed')
      }
    }
  }

  /** Traces the outline of a region (already mapped to overlay device pixels), grown by `pad`. */
  function traceShape(ctx, shape, t, pad) {
    ctx.beginPath()
    switch (shape.kind) {
      case 'circle': {
        const c = G.applyTransform(t, shape.x, shape.y)
        ctx.ellipse(c.x, c.y, shape.r * t.sx + pad, shape.r * t.sy + pad, 0, 0, Math.PI * 2)
        break
      }
      case 'rect': {
        const a = G.applyTransform(t, shape.x, shape.y)
        ctx.roundRect(a.x - pad, a.y - pad, shape.w * t.sx + pad * 2, shape.h * t.sy + pad * 2, pad)
        break
      }
      case 'segment': {
        const a = G.applyTransform(t, shape.x1, shape.y1)
        const b = G.applyTransform(t, shape.x2, shape.y2)
        const half = (shape.width * (t.sx + t.sy)) / 4 + pad
        const angle = Math.atan2(b.y - a.y, b.x - a.x)
        ctx.arc(b.x, b.y, half, angle - Math.PI / 2, angle + Math.PI / 2)
        ctx.arc(a.x, a.y, half, angle + Math.PI / 2, angle + (Math.PI * 3) / 2)
        ctx.closePath()
        break
      }
      case 'polygon': {
        shape.points.forEach(([x, y], i) => {
          const p = G.applyTransform(t, x, y)
          if (i === 0) ctx.moveTo(p.x, p.y)
          else ctx.lineTo(p.x, p.y)
        })
        ctx.closePath()
        break
      }
    }
  }

  function drawOverlay(now, pulse) {
    const dpr = window.devicePixelRatio || 1
    const layerRect = root.getBoundingClientRect()
    const width = Math.max(1, Math.round(layerRect.width * dpr))
    const height = Math.max(1, Math.round(layerRect.height * dpr))
    if (overlay.width !== width || overlay.height !== height) {
      overlay.width = width
      overlay.height = height
    }
    const ctx = overlayCtx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const hoverRegion = state.hoverId !== null && !state.highlight.has(state.hoverId)
      ? state.regions.get(state.hoverId)
      : undefined
    let anyHighlight = false
    for (const id of state.highlight) if (state.regions.has(id)) anyHighlight = true
    if (!anyHighlight && !hoverRegion) return

    const target = regionTarget()
    if (!target) return
    const t = G.canvasToLayerTransform(target.canvas.getBoundingClientRect(), layerRect, target.width, target.height, dpr)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'

    if (hoverRegion) {
      traceShape(ctx, hoverRegion.shape, t, 3 * dpr)
      ctx.setLineDash([4 * dpr, 3 * dpr])
      ctx.lineWidth = 1.5 * dpr
      ctx.strokeStyle = HOVER_COLOR
      ctx.stroke()
      ctx.setLineDash([])
    }

    const pad = (4 + 3 * pulse) * dpr
    for (const id of state.highlight) {
      const region = state.regions.get(id)
      if (!region) continue
      traceShape(ctx, region.shape, t, pad)
      // Soft halo, dark contrast line, then the bright ring: readable on any background.
      ctx.globalAlpha = 0.18 + 0.17 * pulse
      ctx.lineWidth = (8 + 4 * pulse) * dpr
      ctx.strokeStyle = HIGHLIGHT_COLOR
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.lineWidth = 4 * dpr
      ctx.strokeStyle = HIGHLIGHT_SHADOW
      ctx.stroke()
      ctx.lineWidth = 2.5 * dpr
      ctx.strokeStyle = HIGHLIGHT_COLOR
      ctx.stroke()
    }
  }

  // -------------------------------------------------------------------------
  // Frame loop (runtime-owned, survives sketch reloads)
  // -------------------------------------------------------------------------

  function frame(now) {
    native.raf(frame)
    if (!state.spec) return
    try {
      const pulse = (Math.sin((now / 1000) * Math.PI * 2 * 0.8) + 1) / 2
      fitP5Canvases()
      drawOverlay(now, pulse)
      if (state.boxHelpers.size > 0 || state.threeDirty) updateBoxHelpers(pulse)
      if (pointer.inside && now - pointer.lastHoverCheck > HOVER_RECHECK_MS) queueHover()
    } catch (error) {
      // A runtime bug must not kill the loop; report once (deduplicated) and carry on.
      reportException(error, 'Diagram runtime')
    }
  }

  // -------------------------------------------------------------------------
  // Resize
  // -------------------------------------------------------------------------

  function handleResize() {
    const width = stage.clientWidth
    const height = stage.clientHeight
    if (width === state.stageSize.width && height === state.stageSize.height) return
    state.stageSize = { width, height }
    if (!state.spec || width === 0 || height === 0) return
    const three = state.three
    if (three) {
      try {
        three.renderer.setSize(width, height)
        if (three.camera.isPerspectiveCamera) {
          three.camera.aspect = width / height
          three.camera.updateProjectionMatrix()
        }
        state.threeDirty = true
        if (three.lastScene) three.render(three.lastScene, three.lastCamera || three.camera)
      } catch (error) {
        reportException(error, 'Resize failed')
      }
    }
    for (const listener of [...state.resizeListeners]) {
      try {
        listener(width, height)
      } catch (error) {
        reportException(error, 'mint.onResize callback')
      }
    }
  }

  new ResizeObserver(handleResize).observe(stage)

  // -------------------------------------------------------------------------
  // Host messages
  // -------------------------------------------------------------------------

  native.addEventListener.call(window, 'message', (event) => {
    if (event.source !== window.parent) return
    const message = event.data
    if (!message || typeof message !== 'object') return
    switch (message.type) {
      case 'load':
        loadSpec(message.spec)
        break
      case 'param':
        if (isValidId(message.id)) applyParam(message.id, message.value)
        break
      case 'highlight':
        if (Array.isArray(message.ids)) setHighlight(message.ids)
        break
      case 'resize':
        handleResize()
        break
    }
  })

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  // Strip WebRTC: CSP does not govern it, and it is the one remaining way to reach the network.
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) {
    try {
      delete window[name]
    } catch {
      /* ignore */
    }
  }

  installSketchGlobals()
  baselineGlobals = new Set(Object.getOwnPropertyNames(window))
  native.raf(frame)

  function announceReady() {
    state.stageSize = { width: stage.clientWidth, height: stage.clientHeight }
    post({ type: 'ready' })
  }

  // Wait for `load` so p5 never defers its start and its own auto-init has already run.
  if (document.readyState === 'complete') announceReady()
  else native.addEventListener.call(window, 'load', announceReady, { once: true })
})()
