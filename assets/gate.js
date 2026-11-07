/*
 * Password gate. Same scheme as the old Nicepage gate, so the existing password keeps working:
 *   sha256(password + salt) must equal data-salted-password,
 *   then redirect to index_<sha256(password)>.html and remember the password in localStorage('auth_key').
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var SALT = root.getAttribute('data-salt');
  var SALTED = root.getAttribute('data-salted-password');
  var HOME = root.getAttribute('data-home-page') || 'index.html';
  var KEY = 'auth_key';

  // Compact SHA-256 over the string's char codes as bytes (matches forge's "raw" encoding used by Nicepage).
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function sha256(str) {
    var len = str.length, total = ((len + 9 + 63) >> 6) << 6;
    var bytes = new Uint8Array(total), i;
    for (i = 0; i < len; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    bytes[len] = 0x80;
    var view = new DataView(bytes.buffer);
    view.setUint32(total - 4, (len * 8) >>> 0);
    view.setUint32(total - 8, Math.floor(len / 0x20000000));
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var W = new Uint32Array(64);
    for (var o = 0; o < total; o += 64) {
      for (i = 0; i < 16; i++) W[i] = view.getUint32(o + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        var s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        var t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(function (x) { return ('0000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }
  window.gateSha256 = sha256;

  function target(pw) {
    if (!pw || sha256(pw + SALT) !== SALTED) return null;
    return HOME.replace(/\.html$/, '_' + sha256(pw) + '.html');
  }

  // Returning visitor: skip the gate.
  try {
    var saved = target(localStorage.getItem(KEY));
    if (saved) { root.classList.add('redirecting'); location.replace(saved); return; }
  } catch (err) { /* storage blocked — just show the gate */ }

  document.addEventListener('DOMContentLoaded', function () {
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var panel = document.getElementById('panel');
    var form = document.getElementById('gate-form');
    var input = document.getElementById('pw');
    var msg = document.getElementById('msg');
    var status = document.getElementById('status');
    var hrEl = document.getElementById('gate-hr');
    var cv = document.getElementById('gate-canvas');
    var ctx, W = 0, H = 0, buf, head = 0, carry = 0, last = 0;
    var mode = 'locked', beatT = 0, blip = 0, blipAmp = 0, rFired = false;
    var GREEN = '#3df59a', RED = '#ff5a6e', SPEED = 120, GAP = 18;
    var color = GREEN;

    function gauss(x, a, mu, s) { return a * Math.exp(-((x - mu) * (x - mu)) / (2 * s * s)); }
    function ecg(x) {
      return gauss(x, 0.1, 0.1, 0.022) + gauss(x, -0.12, 0.205, 0.008) + gauss(x, 1, 0.225, 0.009) +
        gauss(x, -0.25, 0.245, 0.01) + gauss(x, 0.27, 0.45, 0.045);
    }

    function sample(dt) {
      var v = (Math.random() - 0.5) * 0.025;
      if (blip > 0) { v += Math.sin((1 - blip) * Math.PI) * blipAmp; blip -= dt / 0.1; }
      if (mode === 'alive') {
        beatT += dt;
        if (beatT > 0.83) { beatT = 0; rFired = false; }
        if (!rFired && beatT > 0.225) { rFired = true; hrEl.textContent = '72'; }
        v += ecg(beatT);
      }
      return v;
    }

    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var r = cv.getBoundingClientRect();
      W = Math.round(r.width); H = Math.round(r.height);
      cv.width = W * dpr; cv.height = H * dpr;
      ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buf = new Float32Array(W);
      for (var x = 0; x < W; x++) buf[x] = sample(1 / SPEED);
      head = 0;
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      var mid = H * 0.62, amp = H * 0.5;
      ctx.beginPath();
      var pen = false;
      for (var x = 0; x < W; x++) {
        if ((x - head + W) % W < GAP) { pen = false; continue; }
        var y = mid - buf[x] * amp;
        if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.lineJoin = 'round';
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.18; ctx.lineWidth = 6; ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = 1.8; ctx.stroke();
      var hx = (head - 1 + W) % W;
      ctx.beginPath(); ctx.arc(hx, mid - buf[hx] * amp, 3, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0;
    }

    function frame(t) {
      var dt = last ? Math.min(0.05, (t - last) / 1000) : 1 / 60;
      last = t;
      carry += dt * SPEED;
      while (carry >= 1) { carry -= 1; buf[head] = sample(1 / SPEED); head = (head + 1) % W; }
      draw();
      requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener('resize', resize);
    if (reduce) draw(); else requestAnimationFrame(frame);

    input.addEventListener('input', function () {
      if (mode !== 'locked') return;
      color = GREEN;
      blip = 1; blipAmp = 0.2 + Math.random() * 0.25;
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var pw = input.value;
      var url = target(pw);
      if (!url) {
        color = RED;
        panel.classList.remove('shake'); void panel.offsetWidth; panel.classList.add('shake');
        panel.classList.add('denied');
        status.textContent = 'DENIED';
        msg.textContent = 'Flatline. That key didn’t match — try again.';
        input.select();
        if (reduce) draw();
        return;
      }
      try { localStorage.setItem(KEY, pw); } catch (err) { /* ignore */ }
      mode = 'alive'; color = GREEN;
      panel.classList.remove('denied'); panel.classList.add('granted');
      status.textContent = 'ACCESS GRANTED';
      msg.textContent = 'Signal acquired — loading portfolio…';
      input.disabled = true;
      form.querySelector('button').disabled = true;
      setTimeout(function () { location.replace(url); }, reduce ? 200 : 1700);
    });
  });
})();
