// Loaded before p5 and the runtime. The sandbox iframe has no motion-sensor
// permission, and p5 subscribes to device motion/orientation events on
// startup, which makes Chromium log permissions-policy violations. Diagrams
// never need sensors, so those subscriptions are dropped at the prototype
// level (the runtime captures this method as its "native" one).
;(function () {
  'use strict'
  var blocked = { devicemotion: true, deviceorientation: true, deviceorientationabsolute: true }
  var proto = EventTarget.prototype
  var add = proto.addEventListener
  proto.addEventListener = function addEventListener(type, listener, options) {
    if (blocked[type]) return
    return add.call(this == null ? window : this, type, listener, options)
  }
  try {
    Object.defineProperty(window, 'ondevicemotion', { value: null, writable: false })
    Object.defineProperty(window, 'ondeviceorientation', { value: null, writable: false })
  } catch (e) {
    /* not configurable in this engine; the listener filter still applies */
  }
})()
