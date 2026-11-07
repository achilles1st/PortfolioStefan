(() => {
  'use strict';

  const D = window.PORTFOLIO;
  const ASSETS = new URL('.', document.currentScript.src).href; // for lazily imported modules
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const C = { green: cssVar('--green'), cyan: cssVar('--cyan'), amber: cssVar('--amber'), red: cssVar('--red'), dim: cssVar('--dim'), muted: cssVar('--muted'), grid: 'rgba(150,255,200,0.07)' };
  const MONO = '"JetBrains Mono", ui-monospace, monospace';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad2 = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const vitals = { hr: 64 };

  /* Size a canvas to its CSS box (DPR-aware) and return a ready 2d context. */
  function fitCanvas(cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = cv.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; } // resizing clears the canvas
    const dprX = bw / w, dprY = bh / h;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dprX, 0, 0, dprY, 0, 0);
    return { ctx, w, h };
  }

  /* requestAnimationFrame loop that only runs while `el` is on screen and the tab is visible. */
  function visibleLoop(el, frame) {
    let raf = 0, last = 0, onScreen = false;
    const tick = (t) => {
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 1 / 60;
      last = t;
      frame(dt);
      raf = requestAnimationFrame(tick);
    };
    const start = () => { if (!raf && onScreen && !document.hidden) { last = 0; raf = requestAnimationFrame(tick); } };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; onScreen ? start() : stop(); }).observe(el);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  }

  /* One rAF-batched scroll/resize listener for everything that follows the scroll position. */
  const scrollTasks = [];
  let scrollQueued = false;
  const runScrollTasks = () => { scrollQueued = false; scrollTasks.forEach((f) => f()); };
  const queueScrollTasks = () => { if (!scrollQueued) { scrollQueued = true; requestAnimationFrame(runScrollTasks); } };
  addEventListener('scroll', queueScrollTasks, { passive: true });
  addEventListener('resize', queueScrollTasks);
  function onScrollFrame(fn) { scrollTasks.push(fn); fn(); }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  function setRangeFill(input) {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--fill', pct + '%');
  }

  /* ═════════════════════════ HERO MONITOR ═════════════════════════ */
  // Drawn like a real bedside monitor: each frame only clears and re-strokes the few new columns
  // behind the sweep head instead of repainting the whole canvas.
  function initMonitor() {
    const host = $('#monitor');
    const cv = $('#monitor-canvas');
    const hrEl = $('#hud-hr'), heart = $('#heart'), pulse = $('#brand-pulse');
    const spo2El = $('#hud-spo2'), eegEl = $('#hud-eeg'), eegTxt = $('#hud-eeg-txt');
    const SPEED = 150; // sweep speed in px/s
    const GAP = 24;    // erased gap in front of the sweep head
    const BACK = 4;    // columns re-stroked behind the new ones so the joins stay seamless
    const chans = [
      { label: 'II', color: C.green, lo: -0.4, hi: 1.12, glow: true },
      { label: 'PLETH', color: C.cyan, lo: -0.1, hi: 1.15 },
      { label: 'EEG', color: C.amber, lo: -1.2, hi: 1.2 },
    ];
    chans.forEach((c) => {
      c.el = document.createElement('span');
      c.el.className = 'monitor-label';
      c.el.textContent = c.label;
      c.el.style.color = c.color;
      host.appendChild(c.el);
    });
    const dot = document.createElement('span');
    dot.className = 'monitor-dot';
    host.appendChild(dot);

    let ctx, W = 0, H = 0, traceW = 0, bufs = [], head = 0, carry = 0;
    let t = 0, beatT = 0, rr = 60 / 64, prevRR = 60 / 64, hr = 64, arousal = 0, rFired = false, skip = false, eegNoise = 0;
    let live = false; // false while pre-filling the screen

    const g = (x, a, mu, s) => a * Math.exp(-((x - mu) ** 2) / (2 * s * s));
    const ecgAt = (x, RR) => g(x, 0.11, 0.1, 0.022) + g(x, -0.12, 0.205, 0.008) + g(x, 1, 0.225, 0.009) + g(x, -0.26, 0.245, 0.01) + g(x, 0.28, 0.24 + 0.22 * Math.sqrt(RR), 0.045);
    const plethAt = (x) => (x < 0 ? 0 : g(x, 1, 0.36, 0.07) + g(x, 0.38, 0.6, 0.08));
    const pop = (el, s) => el.animate([{ transform: `scale(${s})` }, { transform: 'scale(1)' }], { duration: 400, easing: 'ease-out' });

    function onR() {
      if (!live) return;
      vitals.hr = Math.round(hr);
      hrEl.textContent = vitals.hr;
      pop(heart, 1.6);
      pop(pulse, 1.8);
    }

    function step(dt) {
      t += dt; beatT += dt;
      hr += (62 + arousal * 62 - hr) * Math.min(1, dt / 1.4);
      arousal = Math.max(0, arousal - dt * 0.16);
      if (beatT >= rr || skip) {
        prevRR = beatT; beatT = 0; rFired = false; skip = false;
        rr = (60 / hr) * (1 + (Math.random() - 0.5) * 0.05);
      }
      if (!rFired && beatT >= 0.225) { rFired = true; onR(); }
      const ecg = ecgAt(beatT, rr) + 0.03 * Math.sin(2 * Math.PI * 0.21 * t) + (Math.random() - 0.5) * 0.014;
      const pleth = plethAt(beatT) + plethAt(beatT + prevRR) * 0.9;
      eegNoise += (gauss() - eegNoise) * 0.25;
      const alpha = Math.sin(2 * Math.PI * 10.2 * t) * (0.55 + 0.35 * Math.sin(2 * Math.PI * 0.23 * t)) * (1 - 0.7 * arousal);
      const theta = 0.25 * Math.sin(2 * Math.PI * 5.8 * t + 1);
      const beta = arousal * 0.5 * Math.sin(2 * Math.PI * 21 * t) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 1.3 * t));
      const eeg = (alpha + theta + beta) * 0.5 + eegNoise * (0.16 + 0.2 * arousal);
      return [ecg, pleth, eeg];
    }

    function writeColumn() {
      const v = step(1 / SPEED);
      for (let i = 0; i < chans.length; i++) bufs[i][head] = v[i];
      head = (head + 1) % traceW;
    }

    const yOf = (c, v) => c.bot - (v - c.lo) * c.k;

    function stroke(a, b) { // columns a..b, no wrap
      for (let i = 0; i < chans.length; i++) {
        const c = chans[i], buf = bufs[i];
        ctx.beginPath();
        ctx.moveTo(a, yOf(c, buf[a]));
        for (let x = a + 1; x <= b; x++) ctx.lineTo(x, yOf(c, buf[x]));
        ctx.strokeStyle = c.color;
        if (c.glow) { ctx.globalAlpha = 0.16; ctx.lineWidth = 6; ctx.stroke(); ctx.globalAlpha = 1; }
        ctx.lineWidth = c.glow ? 1.8 : 1.3;
        ctx.stroke();
      }
    }

    // fn(a, b) over the ring positions start … start+len-1, split where the buffer wraps
    function ring(start, len, fn) {
      const a = ((start % traceW) + traceW) % traceW, b = a + len - 1;
      if (b < traceW) fn(a, b);
      else { fn(a, traceW - 1); fn(0, b - traceW); }
    }

    function repaint(a, b) {
      ctx.save();
      ctx.beginPath(); ctx.rect(a, 0, b - a + 1, H); ctx.clip();
      ctx.clearRect(a, 0, b - a + 1, H);
      stroke(Math.max(0, a - BACK), b);
      ctx.restore();
    }
    const erase = (a, b) => ctx.clearRect(a, 0, b - a + 1, H);

    function moveDot() {
      const x = (head - 1 + traceW) % traceW;
      dot.style.transform = `translate(${x}px, ${yOf(chans[0], bufs[0][x]).toFixed(1)}px)`;
    }

    function fullDraw() {
      ctx.clearRect(0, 0, W, H);
      ring(head + GAP, traceW - GAP, stroke);
      moveDot();
    }

    function layout() {
      const f = fitCanvas(cv);
      ctx = f.ctx; W = f.w; H = f.h;
      ctx.lineJoin = 'round';
      const mobile = f.w <= 640;
      const gutter = Math.max(16, (f.w - 1180) / 2);
      const bands = mobile
        ? [[0.24, 0.62], [0.65, 0.78], [0.81, 0.91]]
        : [[0.08, 0.58], [0.61, 0.76], [0.79, 0.9]];
      chans.forEach((c, i) => {
        c.top = bands[i][0] * H; c.bot = bands[i][1] * H; c.k = (c.bot - c.top) / (c.hi - c.lo);
        c.el.style.transform = `translate(${gutter}px, ${c.top}px)`;
      });
      const newTraceW = mobile ? f.w : Math.max(200, f.w - gutter - 170);
      if (newTraceW !== traceW) {
        traceW = newTraceW;
        bufs = chans.map(() => new Float32Array(traceW));
        head = 0; live = false;
        for (let x = 0; x < traceW; x++) writeColumn(); // pre-fill so the screen is never empty
        live = true;
      }
      fullDraw();
    }

    layout();
    new ResizeObserver(layout).observe(host);
    // incremental drawing relies on the canvas keeping its pixels; repaint fully whenever that may not hold
    cv.addEventListener('contextrestored', fullDraw);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) fullDraw(); });
    if (reduceMotion) return;

    let spo2Timer = 0, eegState = '';
    visibleLoop(host, (dt) => {
      carry += dt * SPEED;
      const n = Math.floor(carry);
      carry -= n;
      if (n > 0) {
        const prev = head;
        for (let i = 0; i < n; i++) writeColumn();
        if (head < prev) fullDraw(); // once per sweep: full repaint keeps the screen self-healing
        else {
          ring(prev - BACK, n + BACK, repaint);
          ring(head, GAP, erase);
          moveDot();
        }
      }
      spo2Timer -= dt;
      if (spo2Timer <= 0) { spo2Timer = 2 + Math.random() * 3; spo2El.textContent = Math.random() < 0.7 ? 98 : Math.random() < 0.5 ? 97 : 99; }
      const st = arousal > 0.35 ? 'b' : 'a';
      if (st !== eegState) { eegState = st; eegEl.textContent = st === 'b' ? 'β' : 'α'; eegTxt.textContent = st === 'b' ? 'focused' : 'relaxed'; }
    });

    let last = null;
    window.addEventListener('pointermove', (e) => {
      if (last && window.scrollY < window.innerHeight) {
        const v = Math.hypot(e.clientX - last.x, e.clientY - last.y) / Math.max(8, e.timeStamp - last.t);
        arousal = Math.min(1, arousal + v * 0.01);
      }
      last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    }, { passive: true });

    let skipped = 0;
    $('#top').addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      skip = true;
      arousal = Math.min(1, arousal + 0.12);
      if (skipped++ === 0) toast('♥ You made my heart skip a beat');
    });
  }

  /* ═════════════════════════ ROLE TYPER ═════════════════════════ */
  function initRoles() {
    const el = $('#role');
    if (reduceMotion || !D.roles.length) return;
    let i = 0, n = el.textContent.length, deleting = false;
    const tick = () => {
      const word = D.roles[i];
      if (!deleting) {
        n++;
        el.textContent = word.slice(0, n);
        if (n >= word.length) { deleting = true; return setTimeout(tick, 2200); }
        return setTimeout(tick, 55 + Math.random() * 50);
      }
      n--;
      el.textContent = word.slice(0, n);
      if (n <= 0) { deleting = false; i = (i + 1) % D.roles.length; return setTimeout(tick, 300); }
      setTimeout(tick, 28);
    };
    n = D.roles[0].length; deleting = true;
    setTimeout(tick, 2600);
  }

  /* ═════════════════════════ NAV ═════════════════════════ */
  function initNav() {
    const bar = $('#progress-bar');
    const menuBtn = $('#menu-btn'), links = $('#nav-links');
    onScrollFrame(() => {
      const max = document.documentElement.scrollHeight - innerHeight;
      bar.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
    });

    menuBtn.addEventListener('click', () => {
      const open = menuBtn.getAttribute('aria-expanded') !== 'true';
      menuBtn.setAttribute('aria-expanded', open);
      links.classList.toggle('is-open', open);
    });
    links.addEventListener('click', (e) => {
      if (e.target.closest('a')) { menuBtn.setAttribute('aria-expanded', 'false'); links.classList.remove('is-open'); }
    });

    const map = new Map($$('a', links).map((a) => [a.getAttribute('href').slice(1), a]));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        map.forEach((a) => a.classList.remove('is-active'));
        map.get(e.target.id)?.classList.add('is-active');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    map.forEach((_, id) => { const s = document.getElementById(id); if (s) io.observe(s); });
  }

  /* ═════════════════════════ REVEAL + COUNTERS ═════════════════════════ */
  function initReveal() {
    const els = $$('.reveal');
    if (reduceMotion || !('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
        e.target.dispatchEvent(new CustomEvent('reveal'));
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    els.forEach((e) => io.observe(e));

    $$('.stats').forEach((s) => s.addEventListener('reveal', () => {
      $$('[data-count]', s).forEach((dd) => {
        const end = +dd.dataset.count, t0 = performance.now();
        const run = (t) => {
          const k = Math.min(1, (t - t0) / 1200);
          dd.textContent = Math.round(end * (1 - (1 - k) ** 3));
          if (k < 1) requestAnimationFrame(run);
        };
        requestAnimationFrame(run);
      });
    }, { once: true }));
  }

  /* ═════════════════════════ ROBOT ARM (three.js, lazy) ═════════════════════════ */
  function initRobot() {
    const slot = $('#robot-slot');
    if (!slot) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      import(ASSETS + 'robot.js')
        .then((m) => { m.mountRobot(slot, { reduceMotion }); slot.classList.add('is-ready'); })
        .catch(() => { $('.spline-loading', slot).textContent = '3D preview unavailable'; });
    }, { rootMargin: '300px' });
    io.observe(slot);
  }

  /* ═════════════════════════ SPLINE (lazy) ═════════════════════════ */
  function initSpline() {
    let scriptAdded = false;
    const mount = (slot) => {
      if (!scriptAdded) {
        const s = document.createElement('script');
        s.type = 'module';
        s.src = 'https://unpkg.com/@splinetool/viewer@1.9.86/build/spline-viewer.js';
        document.head.appendChild(s);
        scriptAdded = true;
      }
      const v = document.createElement('spline-viewer');
      v.setAttribute('url', slot.dataset.spline);
      v.setAttribute('loading-anim-type', 'none');
      // on touch screens a 3D canvas would swallow the scroll gesture
      if (slot.dataset.decorative || !finePointer) v.style.pointerEvents = 'none';
      // Spline keeps rendering at full frame rate even off screen — pause it whenever it isn't visible.
      // (_spline is the viewer's runtime app; stop()/play() toggle its render loop.)
      let loaded = false, inView = true;
      const sync = () => {
        const app = v._spline;
        if (!loaded || !app) return;
        if (inView) app.play?.(); else app.stop?.();
      };
      v.addEventListener('viewport-intersection', (e) => { inView = e.detail.intersection; sync(); });
      v.addEventListener('load-complete', () => setTimeout(() => { loaded = true; sync(); }, 50));
      slot.appendChild(v);
    };
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        idle(() => mount(e.target), { timeout: 1500 });
      });
    }, { rootMargin: '200px' });
    $$('[data-spline]').forEach((s) => io.observe(s));
  }

  /* ═════════════════════════ SKILLS ═════════════════════════ */
  const levelWord = (l) => (l >= 90 ? 'expert' : l >= 80 ? 'advanced' : l >= 65 ? 'strong' : l >= 50 ? 'intermediate' : 'familiar');

  function initSkills() {
    const ul = $('#meters');
    ul.innerHTML = D.skills.map((s) => `
      <li>
        <div class="meter-head"><span>${esc(s.name)}</span><span class="lvl">${levelWord(s.level)}</span></div>
        <div class="leds" data-on="${Math.round(s.level / 5)}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${s.level}" aria-label="${esc(s.name)}">${'<i></i>'.repeat(20)}</div>
      </li>`).join('');

    const light = () => {
      $$('.leds', ul).forEach((m, row) => {
        const on = +m.dataset.on;
        $$('i', m).forEach((led, k) => {
          if (k >= on) return;
          const go = () => led.classList.add('on', ...(k >= 17 ? ['hi'] : []));
          reduceMotion ? go() : setTimeout(go, row * 60 + k * 35);
        });
      });
    };
    ul.addEventListener('reveal', light, { once: true });
    if (reduceMotion) light();

    // a little peak-hold flicker above each level while the list is on screen
    if (!reduceMotion) {
      let timer = 0;
      new IntersectionObserver(([e]) => {
        clearInterval(timer);
        if (!e.isIntersecting) return;
        timer = setInterval(() => {
          const m = $$('.leds', ul)[Math.floor(Math.random() * D.skills.length)];
          const led = $$('i', m)[+m.dataset.on];
          if (!led) return;
          led.classList.add('peak');
          setTimeout(() => led.classList.remove('peak'), 260);
        }, 220);
      }).observe(ul);
    }

    // toolbox chips from the project data
    const counts = new Map();
    D.projects.forEach((p) => p.tech.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
    const tech = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    $('#toolbox').innerHTML = tech.map(([t, n]) => `<button type="button" class="chip" data-tech="${esc(t)}">${esc(t)}${n > 1 ? `<span class="n">×${n}</span>` : ''}</button>`).join('');
    $('#toolbox').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tech]');
      if (!b) return;
      projects.setFilter({ tag: 'All', tech: b.dataset.tech });
      $('#projects').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  }

  /* ═════════════════════════ TIMELINE ═════════════════════════ */
  function initTimeline() {
    const list = $('#timeline-list'), fill = $('#timeline-fill'), knob = $('#timeline-dot'), wrap = $('#timeline');
    list.innerHTML = D.experience.map((e) => `
      <li class="tl-item reveal" data-type="${e.type}">
        <span class="tl-date">${esc(e.from)} — ${esc(e.to)}</span>
        <div class="tl-main"><div class="tl-title">${esc(e.title)}</div><div class="tl-org">${esc(e.org)}</div></div>
        <span class="tl-type ${e.type}">${e.type === 'edu' ? 'Education' : 'Work'}</span>
      </li>`).join('');

    $$('.seg button').forEach((b) => b.addEventListener('click', () => {
      $$('.seg button').forEach((x) => x.classList.toggle('is-on', x === b));
      $$('.tl-item', list).forEach((li) => li.classList.toggle('is-hidden', b.dataset.type !== 'all' && li.dataset.type !== b.dataset.type));
      update();
    }));

    const items = $$('.tl-item', list);
    const update = () => {
      // all reads first, then all writes, so the browser never has to re-layout mid-frame
      const r = wrap.getBoundingClientRect();
      if (r.bottom < -100 || r.top > innerHeight + 100) return;
      const mark = innerHeight * 0.62;
      const railH = fill.parentElement.offsetHeight;
      const lit = items.map((li) => { const b = li.getBoundingClientRect(); return b.height > 0 && b.top + b.height / 2 < mark; });
      const k = clamp((mark - r.top) / r.height, 0, 1);
      fill.style.transform = `scaleY(${k})`;
      knob.style.transform = `translateY(${k * railH}px)`;
      items.forEach((li, j) => li.classList.toggle('lit', lit[j]));
    };
    onScrollFrame(update);
  }

  /* ═════════════════════════ PROJECTS ═════════════════════════ */
  const TAG_ORDER = ['Biosignals', 'Hardware', 'Embedded', 'Machine Learning', 'Software', 'Test Automation'];
  const projects = (() => {
    const grid = $('#project-grid'), filters = $('#filters'), empty = $('#grid-empty');
    const state = { tag: 'All', tech: null };
    let scrollEpoch = 0; // card rects are re-measured after the page scrolls
    addEventListener('scroll', () => { scrollEpoch++; }, { passive: true });

    const mediaHTML = (m, cls = '') => (m.type === 'video'
      ? `<video class="${cls}" src="${m.src}#t=0.6" muted loop playsinline preload="metadata"></video>`
      : `<img class="${cls}" src="${m.src}" alt="" loading="lazy" decoding="async">`);

    const visible = () => D.projects
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => (state.tag === 'All' || p.tags.includes(state.tag)) && (!state.tech || p.tech.includes(state.tech)));

    function renderFilters() {
      const tags = TAG_ORDER.filter((t) => D.projects.some((p) => p.tags.includes(t)));
      filters.innerHTML = ['All', ...tags].map((t) => {
        const n = t === 'All' ? D.projects.length : D.projects.filter((p) => p.tags.includes(t)).length;
        return `<button type="button" class="chip ${state.tag === t ? 'is-on' : ''}" data-tag="${esc(t)}" aria-pressed="${state.tag === t}">${esc(t)}<span class="n">${n}</span></button>`;
      }).join('') + (state.tech ? `<button type="button" class="chip tech-pill" data-clear-tech aria-label="Remove filter ${esc(state.tech)}">uses: ${esc(state.tech)} ✕</button>` : '');
    }

    function renderGrid() {
      const items = visible();
      grid.innerHTML = items.map(({ p, i }, k) => {
        const m = p.media[0];
        return `
        <article class="card" data-i="${i}" style="animation-delay:${reduceMotion ? 0 : k * 50}ms">
          <div class="card-media ${m.light ? 'light' : ''}">
            ${mediaHTML(m)}
            <span class="card-num">${pad2(i + 1)}</span>
            ${p.demo ? '<span class="card-badge">▶ live demo</span>' : ''}
            ${m.type === 'video' ? '<span class="card-play">▶ video</span>' : ''}
          </div>
          <div class="card-body">
            <h3><button type="button" class="card-open">${esc(p.title)}</button></h3>
            <p>${esc(p.summary)}</p>
            <div class="tags">${p.tags.map((t) => `<span class="tag t-accent">${esc(t)}</span>`).join('')}${p.tech.slice(0, 2).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
          </div>
        </article>`;
      }).join('');
      empty.hidden = items.length > 0;
      $$('.card', grid).forEach(bindCard);
    }

    function bindCard(card) {
      const video = $('video', card);
      const tilt = finePointer && !reduceMotion;
      let rect = null, rectEpoch = -1, raf = 0, px = 0, py = 0;
      card.addEventListener('pointerenter', () => {
        if (video && finePointer) video.play().catch(() => {});
        if (tilt) { rect = card.getBoundingClientRect(); rectEpoch = scrollEpoch; } // measured before any tilt
      });
      card.addEventListener('pointerleave', () => {
        cancelAnimationFrame(raf); raf = 0;
        card.style.transform = '';
        if (video) video.pause();
      });
      if (tilt) {
        const apply = () => {
          raf = 0;
          const x = (px - rect.left) / rect.width, y = (py - rect.top) / rect.height;
          card.style.setProperty('--mx', x * 100 + '%');
          card.style.setProperty('--my', y * 100 + '%');
          card.style.transform = `perspective(900px) rotateX(${(0.5 - y) * 5}deg) rotateY(${(x - 0.5) * 7}deg) translateY(-4px)`;
        };
        card.addEventListener('pointermove', (e) => {
          px = e.clientX; py = e.clientY;
          if (rectEpoch !== scrollEpoch) { rect = card.getBoundingClientRect(); rectEpoch = scrollEpoch; }
          if (!raf) raf = requestAnimationFrame(apply);
        });
      }
      card.addEventListener('click', () => modal.open(+card.dataset.i));
    }

    function setFilter(next) {
      Object.assign(state, next);
      renderFilters();
      renderGrid();
    }

    filters.addEventListener('click', (e) => {
      if (e.target.closest('[data-clear-tech]')) return setFilter({ tech: null });
      const b = e.target.closest('[data-tag]');
      if (b) setFilter(b.dataset.tag === 'All' ? { tag: 'All', tech: null } : { tag: b.dataset.tag });
    });

    renderFilters();
    renderGrid();
    return { setFilter, mediaHTML };
  })();

  /* ═════════════════════════ PROJECT MODAL ═════════════════════════ */
  const modal = (() => {
    const dlg = $('#modal'), viewer = $('#viewer'), thumbs = $('#thumbs');
    let cur = 0;

    function show(p, k) {
      const m = p.media[k];
      viewer.classList.toggle('light', !!m.light);
      viewer.innerHTML = m.type === 'video'
        ? `<video src="${m.src}" controls autoplay muted loop playsinline></video>`
        : `<img src="${m.src}" alt="${esc(p.title)} — image ${k + 1}">`;
      $$('button', thumbs).forEach((b, j) => b.classList.toggle('is-on', j === k));
    }

    function open(i) {
      cur = (i + D.projects.length) % D.projects.length;
      const p = D.projects[cur];
      $('#modal-num').textContent = `${pad2(cur + 1)} / ${pad2(D.projects.length)}`;
      $('#modal-title').textContent = p.title;
      $('#modal-tags').innerHTML = p.tags.map((t) => `<span class="tag t-accent">${esc(t)}</span>`).join('') + p.tech.map((t) => `<span class="tag">${esc(t)}</span>`).join('');
      let body = '';
      if (p.stat) body += `<div class="modal-stat"><b>${esc(p.stat.value)}</b><span>${esc(p.stat.label)}</span></div>`;
      body += p.body.map((t) => `<p>${esc(t)}</p>`).join('');
      if (p.list) body += `<p class="muted">${esc(p.list.title)}:</p><ul>${p.list.items.map((t, j) => `<li><span>(${j + 1})</span>${esc(t)}</li>`).join('')}</ul>`;
      if (p.demo) body += `<button type="button" class="btn btn-small btn-primary" data-demo="${p.demo}">▶ Try the live simulation</button>`;
      $('#modal-body').innerHTML = body;
      thumbs.innerHTML = p.media.length > 1
        ? p.media.map((m, j) => `<button type="button" data-k="${j}" aria-label="Show media ${j + 1}">${projects.mediaHTML(m)}</button>`).join('')
        : '';
      show(p, 0);
      if (!dlg.open) dlg.showModal();
      $('.modal-text', dlg).scrollTop = 0;
    }

    thumbs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]');
      if (b) show(D.projects[cur], +b.dataset.k);
    });
    $('#modal-close').addEventListener('click', () => dlg.close());
    $('#modal-prev').addEventListener('click', () => open(cur - 1));
    $('#modal-next').addEventListener('click', () => open(cur + 1));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => { viewer.innerHTML = ''; });
    dlg.addEventListener('keydown', (e) => {
      if (e.target.closest('video, input')) return;
      if (e.key === 'ArrowRight') open(cur + 1);
      if (e.key === 'ArrowLeft') open(cur - 1);
    });
    $('#modal-body').addEventListener('click', (e) => {
      const b = e.target.closest('[data-demo]');
      if (!b) return;
      dlg.close();
      lab.select(b.dataset.demo, true);
    });
    return { open, close: () => dlg.open && dlg.close() };
  })();

  /* ═════════════════════════ LAB TABS ═════════════════════════ */
  const lab = (() => {
    const tabs = $$('[role="tab"]');
    function select(id, scroll) {
      tabs.forEach((t) => {
        const on = t.id === 'tab-' + id;
        t.setAttribute('aria-selected', on);
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      });
      if (scroll) $('#lab').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
    }
    tabs.forEach((t, k) => {
      t.addEventListener('click', () => select(t.id.slice(4)));
      t.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        const n = tabs[(k + d + tabs.length) % tabs.length];
        select(n.id.slice(4)); n.focus();
      });
    });
    return { select };
  })();

  /* ═════════════════════════ LAB · PI CONTROLLER ═════════════════════════ */
  function initPI() {
    const panel = $('#panel-pi'), cv = $('#pi-canvas');
    const sp = $('#pi-sp'), kp = $('#pi-kp'), ki = $('#pi-ki');
    const out = { sp: $('#pi-sp-out'), kp: $('#pi-kp-out'), ki: $('#pi-ki-out') };
    const ui = { ntc: $('#pi-ntc'), adc: $('#pi-adc'), u: $('#pi-u'), pwm: $('#pi-pwm'), rpm: $('#pi-rpm'), fan: $('#pi-fan') };
    // plant: C dT/dt = P_in − (k_loss + k_fan·fan)(T − T_amb); NTC & fan add first-order lags
    const P = { Ta: 22, C: 20, kLoss: 0.1, kFan: 0.9, Pbase: 8, Pspike: 8, tauS: 4, tauF: 2, speed: 10, dt: 0.02, win: 180, R25: 10000, B: 3950 };
    const HIST_DT = 0.25;
    let s, hist, fanAngle = 0, size = null, plotT = 0;

    function reset() {
      s = { t: 0, T: P.Ta + 6, Ts: P.Ta + 6, fan: 0, I: 0, u: 0, spike: 0, ctrl: 0, code: 0, meas: P.Ta + 6, histT: 0 };
      hist = [];
    }

    const ntcR = (T) => P.R25 * Math.exp(P.B * (1 / (T + 273.15) - 1 / 298.15));

    function step(dt) {
      const pin = P.Pbase + (s.spike > 0 ? P.Pspike : 0);
      s.spike = Math.max(0, s.spike - dt);
      s.T += (dt * (pin - (P.kLoss + P.kFan * s.fan) * (s.T - P.Ta))) / P.C;
      s.Ts += (dt * (s.T - s.Ts)) / P.tauS;
      s.ctrl += dt;
      if (s.ctrl >= 0.1) { // firmware loop at 10 Hz
        const h = s.ctrl; s.ctrl = 0;
        // 10 kΩ divider → 12-bit ADC → Beta equation back to °C
        const ratio = P.R25 / (P.R25 + ntcR(s.Ts));
        s.code = clamp(Math.round(4095 * ratio + gauss() * 1.5), 1, 4094);
        const R = P.R25 * (4095 / s.code - 1);
        s.meas = 1 / (1 / 298.15 + Math.log(R / P.R25) / P.B) - 273.15;
        const e = s.meas - +sp.value;
        const kP = +kp.value, kI = +ki.value;
        const trial = kP * e + s.I + kI * e * h;
        if (!((trial > 1 && e > 0) || (trial < 0 && e < 0))) s.I = clamp(s.I + kI * e * h, 0, 1); // anti-windup
        s.u = clamp(kP * e + s.I, 0, 1);
      }
      s.fan += (dt * (s.u - s.fan)) / P.tauF;
      s.t += dt;
      s.histT += dt;
      if (s.histT >= HIST_DT) {
        s.histT = 0;
        hist.push({ t: s.t, T: s.T, m: s.meas, sp: +sp.value, u: s.u });
        if (hist.length > P.win / HIST_DT + 2) hist.shift();
      }
    }

    function draw() {
      const { ctx, w, h } = size || (size = fitCanvas(cv)); // cached: measuring every frame forces a layout
      ctx.clearRect(0, 0, w, h);
      const L = 44, R = 12, T = 44, B = 26;
      const pw = w - L - R, ph = h - T - B;
      const maxT = hist.reduce((m, p) => Math.max(m, p.T, p.sp), 0);
      const yMax = Math.max(60, Math.ceil((maxT + 4) / 10) * 10), yMin = 20;
      const now = s.t, t0 = now - P.win;
      const X = (t) => L + ((t - t0) / P.win) * pw;
      const Y = (v) => T + (1 - (v - yMin) / (yMax - yMin)) * ph;
      const Yu = (u) => T + ph - u * ph * 0.3;

      ctx.font = `500 10px ${MONO}`;
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
      for (let v = yMin; v <= yMax; v += 10) {
        ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(w - R, Y(v)); ctx.stroke();
        ctx.fillStyle = C.dim; ctx.textAlign = 'right'; ctx.fillText(v + '°', L - 8, Y(v));
      }
      ctx.textAlign = 'center';
      for (let k = 0; k <= 6; k++) {
        const x = L + (k / 6) * pw;
        ctx.fillStyle = C.dim;
        ctx.fillText(k === 6 ? 'now' : `−${P.win - (k * P.win) / 6}s`, x, h - B / 2);
      }
      if (hist.length < 2) return;

      // fan duty (area, lower band)
      ctx.beginPath();
      ctx.moveTo(X(hist[0].t), Yu(0));
      hist.forEach((p) => ctx.lineTo(X(p.t), Yu(p.u)));
      ctx.lineTo(X(hist[hist.length - 1].t), Yu(0));
      ctx.closePath();
      ctx.fillStyle = 'rgba(60,200,255,0.12)'; ctx.fill();
      ctx.beginPath(); hist.forEach((p, k) => (k ? ctx.lineTo(X(p.t), Yu(p.u)) : ctx.moveTo(X(p.t), Yu(p.u))));
      ctx.strokeStyle = C.cyan; ctx.lineWidth = 1.2; ctx.stroke();

      // setpoint
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); hist.forEach((p, k) => (k ? ctx.lineTo(X(p.t), Y(p.sp)) : ctx.moveTo(X(p.t), Y(p.sp))));
      ctx.strokeStyle = C.amber; ctx.lineWidth = 1.4; ctx.stroke();
      ctx.setLineDash([]);

      // measured temperature with glow
      const path = new Path2D();
      hist.forEach((p, k) => (k ? path.lineTo(X(p.t), Y(p.m)) : path.moveTo(X(p.t), Y(p.m))));
      ctx.strokeStyle = C.green; ctx.globalAlpha = 0.18; ctx.lineWidth = 6; ctx.stroke(path);
      ctx.globalAlpha = 1; ctx.lineWidth = 2; ctx.stroke(path);
      const lp = hist[hist.length - 1];
      ctx.beginPath(); ctx.arc(X(lp.t), Y(lp.m), 3.5, 0, Math.PI * 2); ctx.fillStyle = C.green; ctx.fill();
      ctx.textAlign = 'right'; ctx.fillStyle = C.green; ctx.font = `700 12px ${MONO}`;
      ctx.fillText(lp.m.toFixed(1) + ' °C', X(lp.t) - 8, Y(lp.m) - 12);
    }

    function updateReadouts() {
      ui.ntc.textContent = (ntcR(s.Ts) / 1000).toFixed(2) + ' kΩ';
      ui.adc.textContent = s.code || '—';
      ui.u.textContent = 'u=' + s.u.toFixed(2);
      ui.pwm.textContent = Math.round(s.u * 100) + ' %';
      ui.rpm.textContent = Math.round(s.fan * 3000) + ' rpm';
    }

    const syncOutputs = () => {
      out.sp.textContent = (+sp.value).toFixed(1) + ' °C';
      out.kp.textContent = (+kp.value).toFixed(2);
      out.ki.textContent = (+ki.value).toFixed(3);
      [sp, kp, ki].forEach(setRangeFill);
    };
    [sp, kp, ki].forEach((i) => i.addEventListener('input', syncOutputs));
    $$('.presets [data-kp]', panel).forEach((b) => b.addEventListener('click', () => {
      kp.value = b.dataset.kp; ki.value = b.dataset.ki; syncOutputs();
      toast(`${b.textContent} tuning: Kp ${b.dataset.kp}, Ki ${b.dataset.ki}`);
    }));
    $('#pi-load').addEventListener('click', () => { s.spike = 30; toast('Heat load +8 W for 30 s — watch the fan react'); });
    $('#pi-reset').addEventListener('click', () => { reset(); draw(); });

    reset(); syncOutputs();
    // warm up a few simulated seconds so the plot isn't empty on first view
    for (let k = 0; k < 40 / P.dt; k++) step(P.dt);
    updateReadouts(); draw();
    new ResizeObserver(() => { size = fitCanvas(cv); draw(); }).observe(cv);

    visibleLoop(panel, (dt) => {
      const steps = Math.round((dt * P.speed) / P.dt);
      for (let k = 0; k < steps; k++) step(P.dt);
      fanAngle = (fanAngle + s.fan * 900 * dt) % 360;
      ui.fan.style.transform = `rotate(${fanAngle}deg)`;
      plotT += dt;
      if (plotT >= 1 / 30) { plotT = 0; updateReadouts(); draw(); } // the plot moves slowly; 30 fps is plenty
    });
  }

  /* ═════════════════════════ LAB · EOG ═════════════════════════ */
  function initEOG() {
    const panel = $('#panel-eog'), stage = $('#eog-stage'), cv = $('#eog-canvas');
    const pupils = [$('#pupil-l'), $('#pupil-r')], lids = [$('#lid-l'), $('#lid-r')];
    const f = [$('#f1'), $('#f2'), $('#f3')], fingerSvg = $('.finger', panel);
    const uvEl = $('#eog-uv'), stEl = $('#eog-state'), thr = $('#eog-thr'), thrOut = $('#eog-thr-out');
    const FS = 100, WIN = 6, N = FS * WIN;
    const buf = new Float32Array(N);
    let size = null, plotT = 0, target = 0, targetY = 0, gaze = 0, gazeY = 0, lastInput = -1e9, nextIdle = 0, clock = 0;
    let blinkT = -1, drift = 0, closed = false, flex = 0, acc = 0, uv = 0;

    const syncThr = () => { thrOut.textContent = `±${thr.value} µV`; setRangeFill(thr); };
    thr.addEventListener('input', syncThr); syncThr();

    stage.addEventListener('pointermove', (e) => {
      const r = stage.getBoundingClientRect();
      target = clamp(((e.clientX - r.left) / r.width - 0.5) * 2.3, -1, 1);
      targetY = clamp(((e.clientY - r.top) / r.height - 0.5) * 2, -1, 1);
      lastInput = clock;
    });
    stage.addEventListener('pointerdown', () => { blinkT = 0; lastInput = clock; });

    function sample(dt) {
      clock += dt;
      if (clock - lastInput > 2.5 && clock > nextIdle) { // wander when nobody is driving
        nextIdle = clock + 0.7 + Math.random() * 1.4;
        target = Math.random() < 0.35 ? (Math.random() < 0.5 ? -0.95 : 0.95) : (Math.random() * 2 - 1) * 0.6;
        targetY = (Math.random() * 2 - 1) * 0.4;
        if (Math.random() < 0.15) blinkT = 0;
      }
      const k = 1 - Math.exp(-dt / 0.03); // saccade-fast eye dynamics
      gaze += (target - gaze) * k; gazeY += (targetY - gazeY) * k;
      drift += (gauss() * 2 - drift * 0.02) * dt * 4;
      let blink = 0;
      if (blinkT >= 0) { blinkT += dt; blink = Math.sin(Math.min(1, blinkT / 0.25) * Math.PI); if (blinkT > 0.25) blinkT = -1; }
      // ~10 µV per degree, ±30° → ±300 µV, plus electrode drift, noise and a blink artefact
      uv = gaze * 300 + drift + gauss() * 6 + blink * 45;
      const th = +thr.value;
      if (uv > th) closed = true; else if (uv < -th) closed = false;
      return blink;
    }

    function draw() {
      const { ctx, w, h } = size || (size = fitCanvas(cv));
      ctx.clearRect(0, 0, w, h);
      const L = 52, R = 10, T = 30, B = 12, ph = h - T - B, pw = w - L - R;
      const Y = (v) => T + (1 - (v + 400) / 800) * ph;
      ctx.font = `500 10px ${MONO}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      [-400, -200, 0, 200, 400].forEach((v) => {
        ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(w - R, Y(v)); ctx.stroke();
        ctx.fillStyle = C.dim; ctx.fillText(v, L - 8, Y(v));
      });
      const th = +thr.value;
      ctx.setLineDash([5, 5]); ctx.strokeStyle = C.red; ctx.globalAlpha = 0.7;
      [th, -th].forEach((v) => { ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(w - R, Y(v)); ctx.stroke(); });
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      const path = new Path2D();
      for (let k = 0; k < N; k++) {
        const x = L + (k / (N - 1)) * pw, y = Y(clamp(buf[(acc + k) % N], -400, 400));
        k ? path.lineTo(x, y) : path.moveTo(x, y);
      }
      ctx.lineWidth = 1.6; ctx.strokeStyle = C.green; ctx.stroke(path);
      // repaint the parts beyond threshold in red
      ctx.save();
      ctx.beginPath(); ctx.rect(L, 0, pw, Y(th)); ctx.rect(L, Y(-th), pw, h - Y(-th)); ctx.clip();
      ctx.strokeStyle = C.red; ctx.stroke(path);
      ctx.restore();
    }

    function render(blink) {
      pupils.forEach((p) => p.setAttribute('transform', `translate(${(gaze * 22).toFixed(2)} ${(gazeY * 9).toFixed(2)})`));
      lids.forEach((l) => l.setAttribute('height', (blink * 56).toFixed(1)));
      const a = [62, 78, 58].map((d) => d * flex);
      f[0].setAttribute('transform', `translate(76 68) rotate(${a[0].toFixed(1)})`);
      f[1].setAttribute('transform', `translate(68 0) rotate(${a[1].toFixed(1)})`);
      f[2].setAttribute('transform', `translate(48 0) rotate(${a[2].toFixed(1)})`);
      fingerSvg.classList.toggle('closed', closed);
      uvEl.textContent = `${Math.round(uv)} µV`;
      stEl.textContent = closed ? 'closed' : 'open';
      stEl.classList.toggle('closed', closed);
    }

    let carry = 0, blink = 0;
    for (let k = 0; k < N; k++) { sample(1 / FS); buf[k] = uv; }
    acc = 0;
    render(0); draw();
    new ResizeObserver(() => { size = fitCanvas(cv); draw(); }).observe(cv);

    visibleLoop(panel, (dt) => {
      carry += dt * FS;
      while (carry >= 1) {
        carry -= 1;
        blink = sample(1 / FS);
        buf[acc] = uv; acc = (acc + 1) % N;
      }
      flex += ((closed ? 1 : 0) - flex) * Math.min(1, dt / 0.12);
      render(blink);
      plotT += dt;
      if (plotT >= 1 / 30) { plotT = 0; draw(); }
    });
  }

  /* ═════════════════════════ TERMINAL ═════════════════════════ */
  function initTerminal() {
    const term = $('#term'), out = $('#term-out'), input = $('#term-in'), form = $('#term-form');
    const history = [];
    let hIdx = 0, greeted = false, returnFocus = null;
    const SECTIONS = ['about', 'skills', 'experience', 'projects', 'lab', 'contact'];

    const print = (html = '') => { const d = document.createElement('div'); d.innerHTML = html; out.appendChild(d); out.scrollTop = out.scrollHeight; };
    const span = (cls, t) => `<span class="${cls}">${esc(t)}</span>`;
    const goTo = (id) => { close(); document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' }); };

    const COMMANDS = {
      help: ['list commands', () => {
        Object.entries(COMMANDS).forEach(([k, [d]]) => d && print(`  ${span('c-g', k.padEnd(12))}${span('c-d', d)}`));
        print(span('c-d', '  tip: Tab completes, ↑/↓ browse history, Esc closes'));
      }],
      whoami: ['who is Stefan?', () => {
        print(`${span('c-g', 'Stefan Tosic')} — biomedical engineer (Dipl.-Ing.)`);
        print('PhD researcher · integrated sensors · Institute of Measurement Technology, Leoben.');
        print('Previously Test Engineer @ Meon Medical Solutions and Infineon.');
        print('Into sensors, biosignals, hardware design, test automation and ML.');
      }],
      projects: ['list all projects', () => {
        D.projects.forEach((p, i) => print(`  ${span('c-g', pad2(i + 1))}  <button data-open="${i}">${esc(p.title)}</button>  ${span('c-d', p.tags.join(', '))}`));
        print(span('c-d', '  → open <n> to see details'));
      }],
      ls: ['', () => COMMANDS.projects[1]()],
      open: ['open <n> — project details', (a) => {
        const n = parseInt(a[0], 10);
        if (!(n >= 1 && n <= D.projects.length)) return print(span('c-r', `usage: open <1-${D.projects.length}>`));
        close(); modal.open(n - 1);
      }],
      skills: ['signal levels', () => D.skills.forEach((s) => {
        const on = Math.round(s.level / 5);
        print(`  ${s.name.padEnd(26)} ${span('c-g', '█'.repeat(on))}${span('c-d', '░'.repeat(20 - on))}`);
      })],
      cv: ['experience timeline', () => D.experience.forEach((e) => print(`  ${span('c-a', `${e.from}–${e.to}`.padEnd(20))}${esc(e.title)} ${span('c-d', '· ' + e.org)}`))],
      lab: ['lab pi | lab eog — open a demo', (a) => {
        const id = (a[0] || 'pi').toLowerCase();
        if (!['pi', 'eog'].includes(id)) return print(span('c-r', 'usage: lab pi | lab eog'));
        close(); lab.select(id, true);
      }],
      goto: ['goto <section>', (a) => {
        const id = (a[0] || '').toLowerCase();
        if (!SECTIONS.includes(id)) return print(span('c-r', `sections: ${SECTIONS.join(', ')}`));
        goTo(id);
      }],
      hr: ['current heart rate', () => print(`♥ ${span('c-g', vitals.hr + ' bpm')} ${span('c-d', vitals.hr > 90 ? '— calm down, it\'s just a portfolio' : '— resting')}`)],
      contact: ['get in touch', () => { print(span('c-g', 'opening contact form…')); setTimeout(() => { location.href = 'Contact.html'; }, 500); }],
      date: ['', () => print(new Date().toString())],
      echo: ['', (a) => print(esc(a.join(' ')))],
      sudo: ['', (a) => {
        if (a.join(' ').toLowerCase() === 'hire stefan') {
          print(span('c-g', '[sudo] permission granted ✔'));
          print('Excellent decision. Redirecting to contact…');
          setTimeout(() => { location.href = 'Contact.html'; }, 1400);
        } else print(span('c-r', 'nice try. (hint: sudo hire stefan)'));
      }],
      clear: ['clear the screen', () => { out.innerHTML = ''; }],
      exit: ['close the terminal', () => close()],
    };

    function run(line) {
      print(`${span('c-g', '$')} ${span('cmd', line)}`);
      const [cmd, ...args] = line.trim().split(/\s+/);
      if (!cmd) return;
      const entry = COMMANDS[cmd.toLowerCase()];
      if (entry) entry[1](args);
      else if (SECTIONS.includes(cmd.toLowerCase())) goTo(cmd.toLowerCase());
      else print(`${span('c-r', 'command not found:')} ${esc(cmd)} — try ${span('c-g', 'help')}`);
    }

    function open() {
      returnFocus = document.activeElement;
      term.hidden = false;
      document.body.style.overflow = 'hidden';
      if (!greeted) {
        greeted = true;
        print(span('c-g', ' ___ _____\n/ __|_   _|\n\\__ \\ | |\n|___/ |_|'));
        print(`ST-OS v2.0 · ${span('c-d', 'type')} ${span('c-g', 'help')} ${span('c-d', 'to get started, or try')} ${span('c-g', 'whoami')}`);
        print('');
      }
      setTimeout(() => input.focus(), 30);
    }
    function close() {
      if (term.hidden) return;
      term.hidden = true;
      document.body.style.overflow = '';
      returnFocus?.focus?.();
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value;
      if (v.trim()) { history.push(v); hIdx = history.length; }
      input.value = '';
      run(v);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' && history.length) { e.preventDefault(); hIdx = Math.max(0, hIdx - 1); input.value = history[hIdx]; }
      if (e.key === 'ArrowDown' && history.length) { e.preventDefault(); hIdx = Math.min(history.length, hIdx + 1); input.value = history[hIdx] || ''; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const parts = input.value.split(' ');
        const pool = parts.length > 1 ? (parts[0] === 'lab' ? ['pi', 'eog'] : SECTIONS) : [...Object.keys(COMMANDS), ...SECTIONS];
        const hits = pool.filter((c) => c.startsWith(parts[parts.length - 1].toLowerCase()));
        if (hits.length === 1) { parts[parts.length - 1] = hits[0]; input.value = parts.join(' ') + ' '; }
        else if (hits.length > 1) print(span('c-d', hits.join('  ')));
      }
    });
    out.addEventListener('click', (e) => {
      const b = e.target.closest('[data-open]');
      if (b) { close(); modal.open(+b.dataset.open); }
      else input.focus();
    });
    term.addEventListener('click', (e) => { if (e.target === term) close(); });
    $('#term-close').addEventListener('click', close);
    $('#term-open').addEventListener('click', open);
    $$('[data-open-term]').forEach((b) => b.addEventListener('click', open));

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); term.hidden ? open() : close(); return; }
      if (e.key === 'Escape' && !term.hidden) { close(); return; }
      const typing = e.target.closest('input, textarea, select, [contenteditable]');
      if (!typing && (e.key === '`' || e.key === '^') && term.hidden && !$('#modal').open) { e.preventDefault(); open(); }
    });
  }

  /* ═════════════════════════ BOOT ═════════════════════════ */
  $('#year').textContent = new Date().getFullYear();
  initNav();
  initSkills();
  initTimeline();
  initReveal();
  initMonitor();
  initRoles();
  initRobot();
  initSpline();
  initPI();
  initEOG();
  initTerminal();
})();
