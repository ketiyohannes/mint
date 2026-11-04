/*
 * mint code runner. Runs learner code in workers inside this opaque-origin,
 * network-less sandbox frame, and reports output and test results to the host.
 *
 *   host -> runner: { type: 'run', id, language: 'javascript' | 'python', code, tests, timeoutMs }
 *   runner -> host: { type: 'result', id, ok, output: string[], tests: [{ name, pass, message? }], error? }
 *                   { type: 'runner-ready' }
 *
 * JavaScript: a fresh worker per run, terminated on timeout. Tests use
 *   test(name, fn), assert(cond, msg), assertEqual(actual, expected, msg).
 * Python: one Pyodide worker (loaded once from ./pyodide/), replaced on timeout.
 *   Tests are functions named test_* using assert.
 */
;(function () {
  'use strict'

  var PYODIDE_URL = new URL('pyodide/', location.href).href
  var MAX_LINES = 400

  var JS_WORKER = [
    "'use strict';",
    'var out = [];',
    'var MAX = ' + MAX_LINES + ';',
    'function fmt(v) { if (typeof v === "string") return v; try { return JSON.stringify(v); } catch (e) { return String(v); } }',
    'function log() { if (out.length < MAX) out.push(Array.prototype.map.call(arguments, fmt).join(" ")); }',
    'console.log = console.info = console.warn = console.error = console.debug = log;',
    'self.onmessage = async function (e) {',
    '  var job = e.data; var registered = [];',
    '  function test(name, fn) { registered.push({ name: String(name), fn: fn }); }',
    '  function assert(cond, msg) { if (!cond) throw new Error(msg || "Assertion failed"); }',
    '  function assertEqual(a, b, msg) { var A = fmt(a), B = fmt(b); if (A !== B) throw new Error(msg || ("Expected " + B + ", got " + A)); }',
    '  try {',
    '    var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;',
    '    var fn = new AsyncFunction("test", "assert", "assertEqual", job.code + "\\n;\\n" + (job.tests || ""));',
    '    await fn(test, assert, assertEqual);',
    '  } catch (err) {',
    '    self.postMessage({ ok: false, output: out, tests: [], error: String((err && err.stack) || err) }); return;',
    '  }',
    '  var results = [];',
    '  for (var i = 0; i < registered.length; i++) {',
    '    var t = registered[i];',
    '    try { await t.fn(); results.push({ name: t.name, pass: true }); }',
    '    catch (err) { results.push({ name: t.name, pass: false, message: String((err && err.message) || err) }); }',
    '  }',
    '  self.postMessage({ ok: true, output: out, tests: results });',
    '};'
  ].join('\n')

  // A classic worker: module workers created from blob: URLs cannot load in an opaque-origin frame.
  var PY_WORKER = [
    'importScripts(' + JSON.stringify(PYODIDE_URL + 'pyodide.js') + ');',
    'var MAX = ' + MAX_LINES + ';',
    'function lastLine(m) { var lines = String(m || "").trim().split("\\n").filter(Boolean); return lines.length ? lines[lines.length - 1] : "Error"; }',
    'var ready = loadPyodide({ indexURL: ' + JSON.stringify(PYODIDE_URL) + ' }).then(function (py) { self.postMessage({ type: "ready" }); return py; });',
    'ready.catch(function (err) { setTimeout(function () { throw err; }); });',
    'self.onmessage = async function (e) {',
    '  var py = await ready; var job = e.data; var out = [];',
    '  var push = function (s) { if (out.length < MAX) out.push(String(s)); };',
    '  py.setStdout({ batched: push }); py.setStderr({ batched: push });',
    '  var ns = py.globals.get("dict")();',
    '  try {',
    '    await py.runPythonAsync(job.code, { globals: ns });',
    '  } catch (err) {',
    '    self.postMessage({ type: "result", ok: false, output: out, tests: [], error: lastLine(err.message) }); ns.destroy(); return;',
    '  }',
    '  var tests = [];',
    '  try {',
    '    if (job.tests) await py.runPythonAsync(job.tests, { globals: ns });',
    '    var names = py.runPython("[k for k, v in list(globals().items()) if k.startswith(\'test\') and callable(v)]", { globals: ns }).toJs();',
    '    for (var i = 0; i < names.length; i++) {',
    '      try { py.runPython(names[i] + "()", { globals: ns }); tests.push({ name: names[i], pass: true }); }',
    '      catch (err) { tests.push({ name: names[i], pass: false, message: lastLine(err.message) }); }',
    '    }',
    '  } catch (err) {',
    '    self.postMessage({ type: "result", ok: false, output: out, tests: tests, error: lastLine(err.message) }); ns.destroy(); return;',
    '  }',
    '  ns.destroy();',
    '  self.postMessage({ type: "result", ok: true, output: out, tests: tests });',
    '};'
  ].join('\n')

  function blobUrl(src) {
    return URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
  }

  function reply(msg) {
    parent.postMessage(msg, '*')
  }

  function clip(s, n) {
    s = String(s == null ? '' : s)
    return s.length > n ? s.slice(0, n) : s
  }

  function finish(id, r) {
    reply({
      type: 'result',
      id: id,
      ok: Boolean(r.ok),
      output: (r.output || []).slice(0, MAX_LINES).map(function (l) { return clip(l, 2000) }),
      tests: (r.tests || []).slice(0, 50).map(function (t) {
        return { name: clip(t.name, 200), pass: Boolean(t.pass), message: t.message === undefined ? undefined : clip(t.message, 1000) }
      }),
      error: r.error === undefined ? undefined : clip(r.error, 8000)
    })
  }

  function runJs(job) {
    var url = blobUrl(JS_WORKER)
    var worker = new Worker(url)
    var done = false
    var timer = setTimeout(function () {
      if (done) return
      done = true
      worker.terminate()
      URL.revokeObjectURL(url)
      finish(job.id, { ok: false, output: [], tests: [], error: 'Stopped after ' + Math.round(job.timeoutMs / 1000) + ' s. Is there an infinite loop?' })
    }, job.timeoutMs)
    worker.onmessage = function (e) {
      if (done) return
      done = true
      clearTimeout(timer)
      worker.terminate()
      URL.revokeObjectURL(url)
      finish(job.id, e.data)
    }
    worker.onerror = function (e) {
      if (done) return
      done = true
      clearTimeout(timer)
      worker.terminate()
      URL.revokeObjectURL(url)
      finish(job.id, { ok: false, output: [], tests: [], error: String(e.message || 'The code could not run.') })
    }
    worker.postMessage({ code: job.code, tests: job.tests })
  }

  // Python: one long-lived worker (Pyodide takes a moment to load), jobs run one at a time.
  var py = null
  var pyQueue = []
  var pyBusy = false

  function pyWorker() {
    if (py) return py
    var url = blobUrl(PY_WORKER)
    var w = new Worker(url)
    var state = { worker: w, ready: false, url: url, current: null, loadTimer: 0 }
    // Loading Pyodide can fail without an error event; do not leave jobs waiting forever.
    state.loadTimer = setTimeout(function () {
      if (!state.ready && py === state) w.onerror({ message: 'timed out loading the Python runtime' })
    }, 60000)
    w.onmessage = function (e) {
      var m = e.data || {}
      if (m.type === 'ready') {
        clearTimeout(state.loadTimer)
        state.ready = true
        pumpPy()
        return
      }
      if (m.type === 'result' && state.current) {
        var job = state.current
        state.current = null
        clearTimeout(job.timer)
        finish(job.id, m)
        pyBusy = false
        pumpPy()
      }
    }
    w.onerror = function (e) {
      if (py !== state) return
      clearTimeout(state.loadTimer)
      var job = state.current
      resetPy()
      var err = 'Python could not start: ' + String((e && e.message) || 'unknown error')
      if (job) {
        clearTimeout(job.timer)
        finish(job.id, { ok: false, output: [], tests: [], error: err })
      }
      // Fail everything queued too; the next run starts a fresh worker.
      var queued = pyQueue.splice(0)
      queued.forEach(function (j) { finish(j.id, { ok: false, output: [], tests: [], error: err }) })
      pyBusy = false
    }
    py = state
    return py
  }

  function resetPy() {
    if (!py) return
    py.worker.terminate()
    URL.revokeObjectURL(py.url)
    py = null
  }

  function pumpPy() {
    var state = pyWorker()
    if (!state.ready || pyBusy || !pyQueue.length) return
    var job = pyQueue.shift()
    pyBusy = true
    state.current = job
    job.timer = setTimeout(function () {
      if (state.current !== job) return
      resetPy()
      pyBusy = false
      finish(job.id, { ok: false, output: [], tests: [], error: 'Stopped after ' + Math.round(job.timeoutMs / 1000) + ' s. Is there an infinite loop?' })
      if (pyQueue.length) pumpPy()
    }, job.timeoutMs)
    state.worker.postMessage({ code: job.code, tests: job.tests })
  }

  window.addEventListener('message', function (e) {
    if (e.source !== parent) return
    var m = e.data
    if (!m || m.type !== 'run' || typeof m.id !== 'string' || typeof m.code !== 'string') return
    var job = {
      id: m.id,
      code: m.code.slice(0, 100000),
      tests: typeof m.tests === 'string' ? m.tests.slice(0, 100000) : '',
      timeoutMs: Math.min(60000, Math.max(1000, Number(m.timeoutMs) || 5000))
    }
    try {
      if (m.language === 'python') {
        pyQueue.push(job)
        pumpPy()
      } else runJs(job)
    } catch (err) {
      finish(job.id, { ok: false, output: [], tests: [], error: String((err && err.message) || err) })
    }
  })

  reply({ type: 'runner-ready' })
})()
