/**
 * The sketch contract given to the model when it writes a diagram. It mirrors
 * resources/diagram-sandbox/README.md (the runtime's source of truth).
 */
export const DIAGRAM_CONTRACT = `## Output
Return a DiagramSpec: { engine: "p5" | "three", title, code, elements: [{id, label, description}], params: [{id, label, min, max, step, value}], caption }.
- Choose "p5" (p5.js 1.11, 2D) by default. Choose "three" (three.js r187) only when the idea is genuinely 3D/spatial.
- elements: every meaningful part the learner might click and ask about (3 to 8), ids short kebab-case. The tutor will later point at them by id.
- params: the quantities worth exploring (0 to 3 sliders) with sensible ranges; value is the start value.
- caption: one sentence telling the learner what to try (e.g. "Increase λ past 1 and watch the arrow").
- Ground the content in the learner's materials; label axes and parts in the diagram itself.

## Code rules (plain browser JavaScript, ES2022, runs in a locked sandbox)
1. No network or assets: no fetch, loadImage(url), loadFont, loadJSON, import, external scripts. Draw procedurally.
2. Draw into mint.stage, sized mint.width x mint.height (CSS px). Use a light background and clear, legible labels (textSize 13 to 16).
3. Register EVERY element id every frame where it is drawn so it is clickable and can be highlighted:
   - p5: mint.region(id, shape) in canvas coordinates. Shapes: {circle:[x,y,r]}, {rect:[x,y,w,h]}, {segment:[x1,y1,x2,y2], width:w}, {polygon:[[x,y],...]}.
   - three: mint.object(id, object3D) and call mint.useCamera(camera, renderer) once.
4. Read sliders with mint.param(id). Never create DOM sliders or buttons; the host renders them. mint.onParam((id, v) => ...) is optional.
5. Never draw highlight effects yourself; the runtime does. (mint.isHighlighted(id) is optional extra emphasis.)
6. p5: use GLOBAL mode (function setup(){ createCanvas(mint.width, mint.height) } and function draw(){...}); never call new p5(). Add function windowResized(){ resizeCanvas(mint.width, mint.height) }.
7. three: the global THREE (with THREE.OrbitControls). Append renderer.domElement to mint.stage. Animate with renderer.setAnimationLoop.
8. Code must run without errors on first load. Keep it under ~150 lines.

## p5 example
function setup() { createCanvas(mint.width, mint.height) }
function draw() {
  background(250)
  const px = width / 2, py = 40, a = radians(mint.param('angle'))
  const bx = px + mint.param('length') * sin(a), by = py + mint.param('length') * cos(a)
  stroke(60); strokeWeight(3); line(px, py, bx, by); mint.region('rod', { segment: [px, py, bx, by], width: 3 })
  noStroke(); fill(60); circle(px, py, 10); mint.region('pivot', { circle: [px, py, 5] })
  fill('#3a6ea5'); circle(bx, by, 36); mint.region('bob', { circle: [bx, by, 18] })
}
function windowResized() { resizeCanvas(mint.width, mint.height) }

## three example
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(45, mint.width / mint.height, 0.1, 100); camera.position.set(0, 1.5, 5)
const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(devicePixelRatio); renderer.setSize(mint.width, mint.height)
mint.stage.appendChild(renderer.domElement); mint.useCamera(camera, renderer)
const controls = new THREE.OrbitControls(camera, renderer.domElement)
scene.add(new THREE.AmbientLight(0xffffff, 0.6)); const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(5, 3, 5); scene.add(sun)
const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), new THREE.MeshStandardMaterial({ color: 0x3a6ea5 })); scene.add(globe)
mint.object('planet', globe)
renderer.setAnimationLoop(() => { globe.rotation.z = THREE.MathUtils.degToRad(mint.param('tilt')); controls.update(); renderer.render(scene, camera) })`
