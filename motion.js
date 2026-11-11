/* BITA motion layer. Works with the router in index.html:
   it runs once at load and again every time a page is drawn (event "bita:route"). */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = matchMedia('(hover: hover) and (pointer: fine)').matches;

  var io = null, pending = [];
  var px = [], hero = null, hc = null, hs = null, raf = 0;

  /* ---------- text reveal ---------- */
  function splitWords(el) {
    var i = 0;
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (n) {
        if (n.nodeType === 3) {
          var frag = document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach(function (part) {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(' ')); return; }
            var w = document.createElement('span'); w.className = 'w';
            var s = document.createElement('span'); s.className = 'wi';
            s.style.setProperty('--i', i++); s.textContent = part;
            w.appendChild(s); frag.appendChild(w);
          });
          node.replaceChild(frag, n);
        } else if (n.nodeType === 1 && n.tagName !== 'BR') { walk(n); }
      });
    })(el);
    el.classList.add('rv');
  }

  function reveal(el) {
    if (root.classList.contains('intro-on')) pending.push(el); else el.classList.add('in');
  }
  new MutationObserver(function () {
    if (!root.classList.contains('intro-on') && pending.length) {
      pending.splice(0).forEach(function (el) { el.classList.add('in'); });
      update();
    }
  }).observe(root, { attributes: true, attributeFilter: ['class'] });

  /* ---------- hero ---------- */
  function setupHero() {
    hero = document.querySelector('#view .hero');
    hc = hero && hero.querySelector('.hc');
    if (!hero || hero.dataset.m) return;
    hero.dataset.m = '1';
    ['t', 'b'].forEach(function (k) { var d = document.createElement('div'); d.className = 'cine ' + k; d.setAttribute('aria-hidden', 'true'); hero.appendChild(d); });
    var sp = document.createElement('div'); sp.className = 'spot'; sp.setAttribute('aria-hidden', 'true'); hero.appendChild(sp);
    var gr = document.createElement('div'); gr.className = 'grain'; gr.setAttribute('aria-hidden', 'true'); hero.appendChild(gr);

    var h1 = hero.querySelector('h1'), big = h1 && h1.querySelector('span');
    if (big) {
      var t = big.textContent;
      h1.setAttribute('aria-label', t + ' ' + (h1.querySelector('small') ? h1.querySelector('small').textContent : ''));
      big.textContent = '';
      big.setAttribute('aria-hidden', 'true');
      Array.prototype.forEach.call(t, function (ch, i) {
        var c = document.createElement('span'); c.className = 'c';
        var ci = document.createElement('span'); ci.className = 'ci'; ci.style.setProperty('--i', i); ci.textContent = ch;
        c.appendChild(ci); big.appendChild(c);
      });
      var sm = h1.querySelector('small'); if (sm) sm.setAttribute('aria-hidden', 'true');
    }
  }

  /* ---------- page setup after every route ---------- */
  function setup(keep) {
    if (io) io.disconnect();
    pending = [];
    setupHero();
    if (!document.querySelector('#view .hero')) { hero = null; hc = null; }

    /* text reveal on headings */
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { reveal(e.target); io.unobserve(e.target); } });
    }, { threshold: 0.25, rootMargin: '0px 0px -6% 0px' });

    document.querySelectorAll('#view h1, #view h2, #view .vals h3').forEach(function (el) {
      if (el.closest('.hero') || el.classList.contains('rv')) return;
      splitWords(el);
      if (keep) el.classList.add('in'); else io.observe(el);
    });

    /* parallax photos */
    px = [];
    var n = 0;
    document.querySelectorAll('#view .hero .photo.bg, #view .pagehead .photo.bg, #view .split > .photo, #view .about > .photo, #view .lb .photo').forEach(function (box) {
      var kids = Array.prototype.filter.call(box.children, function (k) { return k.matches('img.real, img.wm'); });
      if (!kids.length) return;
      var sp = box.closest('.hero') ? 0.3 : box.closest('.pagehead') ? 0.18 : box.closest('.lb') ? 0.07 + (n++ % 3) * 0.05 : 0.14;
      if (reduce) sp = 0;
      box.classList.add('px');
      px.push({ box: box, kids: kids, sp: sp });
    });

    /* horizontal gallery */
    var sec = document.querySelector('#view .hs');
    hs = sec ? { sec: sec, stick: sec.querySelector('.hs-stick'), track: sec.querySelector('.hs-track'), bar: sec.querySelector('.hs-bar i'), dist: 0, pinned: false } : null;
    measure();
    update();
  }

  function measure() {
    if (!hs) return;
    hs.pinned = !reduce && innerWidth > 720;
    hs.sec.classList.toggle('hs-native', !hs.pinned);
    if (!hs.pinned) { hs.sec.style.height = ''; hs.track.style.transform = ''; return; }
    hs.sec.style.height = '';
    hs.dist = Math.max(0, hs.track.scrollWidth - innerWidth);
    hs.sec.style.height = (hs.stick.offsetHeight + hs.dist) + 'px';
  }

  /* ---------- scroll loop ---------- */
  function update() {
    raf = 0;
    var vh = innerHeight;

    px.forEach(function (o) {
      var r = o.box.getBoundingClientRect();
      if (r.bottom < -120 || r.top > vh + 120) return;
      var d = r.top + r.height / 2 - vh / 2, lim = r.height * 0.11;
      var ty = Math.max(-lim, Math.min(lim, -d * o.sp));
      o.kids.forEach(function (k) { k.style.translate = '0 ' + ty.toFixed(1) + 'px'; });
    });

    if (hero && hc && !reduce) {
      var hr = hero.getBoundingClientRect();
      var p = Math.min(1, Math.max(0, -(hr.top - 72) / hr.height));
      hc.style.translate = '0 ' + (p * 80).toFixed(1) + 'px';
      hc.style.opacity = Math.max(0, 1 - p * 1.2).toFixed(3);
    }

    if (hs && hs.pinned && hs.dist > 0) {
      var sr = hs.sec.getBoundingClientRect();
      var q = Math.min(1, Math.max(0, (72 - sr.top) / hs.dist));
      hs.track.style.transform = 'translate3d(' + (-q * hs.dist).toFixed(1) + 'px,0,0)';
      if (hs.bar) hs.bar.style.transform = 'scaleX(' + q.toFixed(3) + ')';
    }
  }
  function queue() { if (!raf) raf = requestAnimationFrame(update); }
  addEventListener('scroll', queue, { passive: true });
  var rz;
  addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { measure(); update(); }, 120); });
  if (window.ResizeObserver) new ResizeObserver(function () { clearTimeout(rz); rz = setTimeout(function () { measure(); update(); }, 120); }).observe(document.body);

  document.addEventListener('bita:route', function (e) { setup(!!(e.detail && e.detail.keep)); });
  setup(false);

  /* ---------- custom cursor ---------- */
  if (fine && !reduce) {
    var cur = document.createElement('div');
    cur.className = 'cur'; cur.setAttribute('aria-hidden', 'true');
    cur.innerHTML = '<i class="dot"></i><i class="ring"><span>View</span></i>';
    document.body.appendChild(cur);
    var dot = cur.querySelector('.dot'), ring = cur.querySelector('.ring');
    root.classList.add('has-cursor');

    var mx = -100, my = -100, rx = -100, ry = -100, loop = 0;
    function tick() {
      rx += (mx - rx) * 0.2; ry += (my - ry) * 0.2;
      ring.style.transform = 'translate3d(' + rx.toFixed(1) + 'px,' + ry.toFixed(1) + 'px,0)';
      if (Math.abs(mx - rx) > 0.1 || Math.abs(my - ry) > 0.1) loop = requestAnimationFrame(tick); else loop = 0;
    }
    addEventListener('mousemove', function (e) {
      mx = e.clientX; my = e.clientY;
      dot.style.transform = 'translate3d(' + mx + 'px,' + my + 'px,0)';
      if (!cur.classList.contains('on')) { rx = mx; ry = my; cur.classList.add('on'); }
      if (!loop) loop = requestAnimationFrame(tick);
    }, { passive: true });
    document.documentElement.addEventListener('mouseleave', function () { cur.classList.remove('on'); });
    document.documentElement.addEventListener('mouseenter', function () { cur.classList.add('on'); });

    function state(t) {
      if (!t || !t.closest) return '';
      if (t.closest('input, textarea')) return 'hide';
      if (t.closest('.pcard, .hs-end, .lb .photo')) return 'view';
      if (t.closest('a, button, summary, label, select, [role="button"]')) return 'link';
      return '';
    }
    document.addEventListener('mouseover', function (e) {
      var s = state(e.target);
      if (s === 'hide') { cur.classList.remove('on'); return; }
      if (mx > -50) cur.classList.add('on');
      if (s) cur.dataset.s = s; else delete cur.dataset.s;
    });
    document.addEventListener('mousedown', function () { if (!cur.dataset.s) cur.dataset.s = 'down'; });
    document.addEventListener('mouseup', function () { if (cur.dataset.s === 'down') delete cur.dataset.s; });
  }
})();