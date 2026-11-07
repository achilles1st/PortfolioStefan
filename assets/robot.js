/*
 * Procedural 5-axis robot arm (three.js). Replaces the Spline scene in the About section:
 * a few dozen primitives instead of a 2+ MB viewer bundle, and it only renders while on screen.
 *
 * The tool tip follows the cursor via two-link inverse kinematics; clicking toggles the gripper.
 * When nobody is driving it, the arm runs a slow idle routine.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const GREEN = 0x3df59a;
const L1 = 2.0;           // upper arm
const L2 = 1.7;           // forearm
const TOOL = 0.95;        // wrist axis → finger tips
const SHOULDER_Y = 1.48;  // shoulder axis height
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function mountRobot(slot, { reduceMotion = false } = {}) {
  const canvas = slot.querySelector('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
  camera.position.set(5.4, 3.7, 7.0);
  camera.lookAt(0.15, 1.75, 0.4);

  scene.add(new THREE.HemisphereLight(0xd8f5e8, 0x0a0f10, 0.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(5, 8, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(GREEN, 1.6);
  rim.position.set(-6, 3, -5);
  scene.add(rim);

  // ── materials ──
  const shell = new THREE.MeshStandardMaterial({ color: 0x2b3536, metalness: 0.55, roughness: 0.3, envMapIntensity: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0d1213, metalness: 0.75, roughness: 0.32, envMapIntensity: 0.7 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xa9b6b1, metalness: 1, roughness: 0.25 });
  const glow = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: GREEN, emissiveIntensity: 2 });
  const halo = new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false });

  const add = (geo, mat, parent, pos = [0, 0, 0], rot = [0, 0, 0]) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos);
    m.rotation.set(...rot);
    parent.add(m);
    return m;
  };
  const group = (parent, pos = [0, 0, 0]) => {
    const g = new THREE.Group();
    g.position.set(...pos);
    parent.add(g);
    return g;
  };
  const axisZ = [Math.PI / 2, 0, 0];  // cylinder lying along Z (joint axis)
  const axisX = [0, 0, -Math.PI / 2]; // cylinder lying along X

  // ── floor: fading grid + contact shadow, baked into one texture ──
  add(new THREE.CircleGeometry(4.6, 64),
    new THREE.MeshBasicMaterial({ map: floorTexture(), transparent: true, depthWrite: false }),
    scene, [0, 0, 0], [-Math.PI / 2, 0, 0]);

  // ── base + J1 (yaw) ──
  const robot = group(scene);
  add(new THREE.CylinderGeometry(1.12, 1.28, 0.3, 56), dark, robot, [0, 0.15, 0]);
  add(new THREE.TorusGeometry(1.17, 0.025, 8, 96), glow, robot, [0, 0.31, 0], axisZ);
  add(new THREE.TorusGeometry(1.17, 0.09, 8, 96), halo, robot, [0, 0.31, 0], axisZ);

  const j1 = group(robot, [0, 0.31, 0]);
  add(new THREE.CylinderGeometry(0.76, 0.88, 0.5, 48), shell, j1, [0, 0.25, 0]);
  add(new THREE.CylinderGeometry(0.5, 0.6, 0.2, 40), dark, j1, [0, 0.58, 0]);
  const plate = new RoundedBoxGeometry(0.95, 1.05, 0.14, 3, 0.06);
  add(plate, shell, j1, [0, 1.0, 0.44]);
  add(plate, shell, j1, [0, 1.0, -0.44]);

  // ── J2 shoulder (pitch) + upper arm ──
  const j2 = group(j1, [0, SHOULDER_Y - 0.31, 0]);
  add(new THREE.CylinderGeometry(0.36, 0.36, 0.74, 40), dark, j2, [0, 0, 0], axisZ);
  for (const z of [0.52, -0.52]) {
    add(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 32), steel, j2, [0, 0, z], axisZ);
    add(new THREE.TorusGeometry(0.27, 0.022, 8, 48), glow, j2, [0, 0, z]);
  }
  add(new RoundedBoxGeometry(L1 + 0.25, 0.48, 0.52, 4, 0.15), shell, j2, [L1 / 2, 0, 0]);
  for (const z of [0.262, -0.262]) add(new THREE.BoxGeometry(L1 * 0.55, 0.05, 0.01), glow, j2, [L1 * 0.52, 0.06, z]);

  // ── J3 elbow (pitch) + forearm ──
  const j3 = group(j2, [L1, 0, 0]);
  add(new THREE.CylinderGeometry(0.3, 0.3, 0.64, 36), dark, j3, [0, 0, 0], axisZ);
  for (const z of [0.33, -0.33]) add(new THREE.TorusGeometry(0.2, 0.02, 8, 40), glow, j3, [0, 0, z]);
  add(new RoundedBoxGeometry(L2 + 0.12, 0.36, 0.4, 4, 0.12), shell, j3, [L2 / 2, 0, 0]);
  for (const z of [0.202, -0.202]) add(new THREE.BoxGeometry(L2 * 0.5, 0.04, 0.01), glow, j3, [L2 * 0.5, 0.04, z]);

  // ── J4 wrist (pitch) + J5 roll + gripper ──
  const j4 = group(j3, [L2, 0, 0]);
  add(new THREE.CylinderGeometry(0.21, 0.21, 0.48, 32), dark, j4, [0, 0, 0], axisZ);
  add(new THREE.CylinderGeometry(0.17, 0.2, 0.26, 32), steel, j4, [0.24, 0, 0], axisX);
  const j5 = group(j4, [0.38, 0, 0]);
  add(new RoundedBoxGeometry(0.2, 0.56, 0.36, 3, 0.06), dark, j5, [0.1, 0, 0]);
  add(new THREE.BoxGeometry(0.02, 0.3, 0.1), glow, j5, [0.205, 0, 0]);
  const fingerGeo = new RoundedBoxGeometry(0.44, 0.07, 0.2, 2, 0.03);
  const fingers = [1, -1].map((s) => {
    const f = group(j5, [0.2, 0.18 * s, 0]);
    add(fingerGeo, steel, f, [0.22, 0, 0]);
    add(new THREE.BoxGeometry(0.1, 0.02, 0.16), glow, f, [0.38, -0.045 * s, 0]);
    return f;
  });
  const tipLed = add(new THREE.SphereGeometry(0.05, 16, 12), glow, j5, [0.24, 0, 0]);
  add(new THREE.SphereGeometry(0.13, 16, 12), halo, tipLed);

  // ── kinematics ──
  const joints = [j1, j2, j3, j4];
  const q = [-0.9, 0.9, -1.6, 0.2];  // current angles: yaw, shoulder, elbow, wrist
  const v = [0, 0, 0, 0];
  const qt = q.slice();
  const stiff = [5, 6.5, 7, 9];
  let grip = 0, gripT = 0, roll = 0, rollT = 0;

  const target = new THREE.Vector3(1.4, 2.0, 1.6);
  function solve(p) {
    // keep the tool tip inside the part of the workspace the camera can see
    const x = clamp(p.x, -1.1, 2.6), y = clamp(p.y, 1.2, 3.9), z = clamp(p.z, 0.6, 3.0);
    let r = Math.hypot(x, z);
    if (r < 2.1) r = 2.1; // don't fold back into the base
    const h = y - SHOULDER_Y;
    const phi = Math.atan2(h, r) - 0.25;   // tool direction: towards the target, tilted down a bit
    let wx = r - TOOL * Math.cos(phi), wy = h - TOOL * Math.sin(phi);
    const d = Math.hypot(wx, wy), dc = clamp(d, Math.abs(L1 - L2) + 0.05, L1 + L2 - 0.03);
    wx *= dc / d; wy *= dc / d;
    const c = clamp((dc * dc - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1);
    const e = -Math.acos(c); // elbow up
    const s = Math.atan2(wy, wx) - Math.atan2(L2 * Math.sin(e), L1 + L2 * Math.cos(e));
    qt[0] = Math.atan2(-z, x);
    qt[1] = s;
    qt[2] = e;
    qt[3] = phi - s - e;
  }

  function pose() {
    joints[0].rotation.y = q[0];
    for (let i = 1; i < 4; i++) joints[i].rotation.z = q[i];
    j5.rotation.x = roll;
    fingers.forEach((f, i) => { f.position.y = (i ? -1 : 1) * (0.07 + 0.12 * (1 - grip)); });
  }

  // ── pointer → target (ray through the cursor onto a plane facing the camera) ──
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    camera.getWorldDirection(new THREE.Vector3()).negate(), new THREE.Vector3(0, 2.0, 1.6));
  const hit = new THREE.Vector3();
  let rect = null, pointer = null, lastInput = -1e9, clock = 0, idleT = 0, nextGrip = 2;

  const measure = () => { rect = canvas.getBoundingClientRect(); };
  window.addEventListener('scroll', () => { rect = null; }, { passive: true });
  window.addEventListener('pointermove', (e) => { pointer = [e.clientX, e.clientY]; lastInput = clock; }, { passive: true });
  canvas.addEventListener('pointerdown', (e) => {
    pointer = [e.clientX, e.clientY];
    lastInput = clock;
    gripT = gripT > 0.5 ? 0 : 1;
    rollT += Math.PI / 2;
  });

  function aim() {
    if (!rect) measure();
    ndc.set(((pointer[0] - rect.left) / rect.width) * 2 - 1, -((pointer[1] - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (ray.ray.intersectPlane(plane, hit)) target.copy(hit);
  }

  function update(dt) {
    clock += dt;
    if (clock - lastInput > 4) { // idle routine
      idleT += dt;
      target.set(0.6 + 1.9 * Math.sin(idleT * 0.45), 1.9 + 0.9 * Math.sin(idleT * 0.7 + 1), 1.4 + 0.6 * Math.cos(idleT * 0.45));
      if (idleT > nextGrip) { nextGrip = idleT + 2.5 + Math.random() * 2; gripT = gripT > 0.5 ? 0 : 1; }
    } else if (pointer) aim();
    solve(target);
    for (let i = 0; i < 4; i++) { // critically damped springs → smooth, mechanical motion
      const k = stiff[i];
      v[i] += (k * k * (qt[i] - q[i]) - 2 * k * v[i]) * dt;
      q[i] += v[i] * dt;
    }
    grip += (gripT - grip) * Math.min(1, dt * 10);
    roll += (rollT - roll) * Math.min(1, dt * 6);
    glow.emissiveIntensity = 1.8 + 0.5 * grip + 0.25 * Math.sin(clock * 2.2);
    pose();
  }

  // ── sizing + render loop (only while visible) ──
  function resize() {
    const w = slot.clientWidth, h = slot.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    rect = null;
    renderer.render(scene, camera);
  }
  new ResizeObserver(resize).observe(slot);

  solve(target);
  q.splice(0, 4, ...qt);
  pose();
  resize();
  if (reduceMotion) return;

  let raf = 0, last = 0, onScreen = false;
  const frame = (t) => {
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 1 / 60;
    last = t;
    update(dt);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  };
  const start = () => { if (!raf && onScreen && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; onScreen ? start() : stop(); }).observe(slot);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
}

function floorTexture() {
  const s = 512, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(61,245,154,0.4)';
  g.lineWidth = 1.5;
  g.beginPath();
  for (let i = 0; i <= s; i += 32) { g.moveTo(i, 0); g.lineTo(i, s); g.moveTo(0, i); g.lineTo(s, i); }
  g.stroke();
  g.globalCompositeOperation = 'destination-in'; // fade the grid out towards the rim
  let rg = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  rg.addColorStop(0, 'rgba(0,0,0,0.85)');
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, s, s);
  g.globalCompositeOperation = 'source-over'; // soft contact shadow under the base
  rg = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.34);
  rg.addColorStop(0, 'rgba(0,0,0,0.8)');
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
