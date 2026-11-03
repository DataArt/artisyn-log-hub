// Home "See it in action" media carousel (task 2026-11-03-app-demo-gif, impl-plan DD-15..19, 23).
// Vanilla, no dependencies. Items come from assets/demo/items.json, written by
// scripts/site/record-demo.mjs: [{ id, kind: "tour"|"still"|"clip", src, still?, thumb, duration?,
// caption, where, alt }]. Only the current item's full media is requested; thumbnails are lazy.
// Autoplay: a still stays STILL_MS, a GIF stays for its own `duration`; the timer starts when the
// media has loaded. The pause button stops it. Under prefers-reduced-motion the carousel starts
// paused and GIFs show their still first frame. The stage media links to the full-size file.
(function () {
  'use strict';

  var STILL_MS = 5000;
  var SWIPE_PX = 40;

  function isGif(it) {
    return it.kind === 'tour' || it.kind === 'clip';
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function unavailable(root) {
    var p = document.createElement('p');
    p.className = 'mc-unavailable';
    p.textContent = 'Media unavailable';
    root.replaceWith(p);
  }

  function start(root, items) {
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var single = items.length < 2;
    var stage = root.querySelector('.mc-stage');
    var caption = root.querySelector('.mc-caption');
    var where = root.querySelector('.mc-where');
    var counter = root.querySelector('.mc-counter');
    var strip = root.querySelector('.mc-strip');
    var pauseBtn = root.querySelector('.mc-pause');
    var cur = 0;
    var paused = reduced || single;
    var timer = null;
    var shown = 0; // bumps on every show(), so a late `load` of a replaced image is ignored

    if (single) root.classList.add('mc-single');

    if (!single) {
      items.forEach(function (it, i) {
        var b = document.createElement('button');
        b.className = 'mc-thumb';
        b.type = 'button';
        b.setAttribute('aria-label', (i + 1) + ': ' + it.caption);
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        img.src = it.thumb || it.still || it.src;
        b.append(img);
        if (isGif(it)) {
          var play = document.createElement('span');
          play.className = 'mc-play';
          play.textContent = '▶ GIF';
          b.append(play);
        }
        b.addEventListener('click', function () { show(i); });
        strip.append(b);
      });
    }

    function schedule() {
      clearTimeout(timer);
      timer = null;
      if (paused || single || document.hidden) return;
      var it = items[cur];
      var ms = isGif(it) && !reduced && it.duration > 0 ? it.duration : STILL_MS;
      timer = setTimeout(function () { show(cur + 1); }, ms);
    }

    function setPaused(next) {
      paused = next;
      pauseBtn.setAttribute('aria-pressed', String(paused));
      pauseBtn.setAttribute('aria-label', paused ? 'Play slideshow' : 'Pause slideshow');
      pauseBtn.textContent = paused ? '▶' : '❚❚';
      schedule();
    }

    function show(i) {
      cur = (i + items.length) % items.length;
      var it = items[cur];
      var token = ++shown;
      clearTimeout(timer);
      timer = null;
      stage.querySelectorAll('.mc-open, .mc-loading').forEach(function (n) { n.remove(); });

      var loading = document.createElement('div');
      loading.className = 'mc-loading';
      loading.textContent = 'loading…';
      stage.prepend(loading);

      var media = reduced && it.still ? it.still : it.src;
      var link = document.createElement('a');
      link.className = 'mc-open';
      link.href = media;
      link.target = '_blank';
      link.rel = 'noopener';
      var img = document.createElement('img');
      img.className = 'mc-media';
      img.alt = it.alt || it.caption;
      img.decoding = 'async';
      // The timer starts when the media is on screen, so a slow GIF still plays to its end.
      function ready() {
        if (token !== shown) return;
        loading.remove();
        schedule();
      }
      img.addEventListener('load', ready, { once: true });
      img.addEventListener('error', ready, { once: true });
      img.src = media;
      link.append(img);
      stage.prepend(link);

      caption.textContent = '';
      if (isGif(it)) {
        var badge = document.createElement('span');
        badge.className = 'mc-badge';
        badge.textContent = 'GIF';
        caption.append(badge);
      }
      caption.append(document.createTextNode(it.caption));
      where.textContent = it.where || '';
      counter.textContent = pad(cur + 1) + ' / ' + pad(items.length);

      if (single) return;
      Array.prototype.forEach.call(strip.children, function (t, k) {
        if (k === cur) t.setAttribute('aria-current', 'true');
        else t.removeAttribute('aria-current');
      });
      var active = strip.children[cur];
      if (active && strip.clientWidth > 0) {
        strip.scrollTo({
          left: active.offsetLeft - strip.offsetLeft - strip.clientWidth / 2 + active.clientWidth / 2,
          behavior: reduced ? 'auto' : 'smooth',
        });
      }
    }

    if (!single) {
      root.querySelector('.mc-prev').addEventListener('click', function () { show(cur - 1); });
      root.querySelector('.mc-next').addEventListener('click', function () { show(cur + 1); });
      pauseBtn.addEventListener('click', function () { setPaused(!paused); });
      root.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') { show(cur - 1); e.preventDefault(); }
        if (e.key === 'ArrowRight') { show(cur + 1); e.preventDefault(); }
      });
      document.addEventListener('visibilitychange', schedule);

      // Swipe: horizontal pointer drag over the stage (vertical scroll stays with the page via
      // touch-action: pan-y). A click that ends a swipe must not open the full-size media.
      var x0 = null;
      var swiped = false;
      stage.addEventListener('pointerdown', function (e) {
        x0 = e.target.closest('button') ? null : e.clientX;
        swiped = false;
      });
      stage.addEventListener('pointerup', function (e) {
        if (x0 === null) return;
        var dx = e.clientX - x0;
        x0 = null;
        if (Math.abs(dx) > SWIPE_PX) {
          swiped = true;
          show(cur + (dx < 0 ? 1 : -1));
        }
      });
      stage.addEventListener('pointercancel', function () { x0 = null; });
      stage.addEventListener('click', function (e) {
        if (swiped && e.target.closest('.mc-open')) e.preventDefault();
        swiped = false;
      }, true);
      // Native image drag would swallow the pointer gesture on desktop.
      stage.addEventListener('dragstart', function (e) { e.preventDefault(); });
    }

    setPaused(paused);
    show(0);
  }

  function init() {
    var root = document.querySelector('[data-mc]');
    if (!root) return;
    fetch('assets/demo/items.json')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (items) {
        if (!Array.isArray(items) || items.length === 0) throw new Error('no items');
        start(root, items);
      })
      .catch(function () { unavailable(root); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
