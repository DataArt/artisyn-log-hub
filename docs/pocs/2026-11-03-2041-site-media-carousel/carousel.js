// PoC: Steam-style media carousel, vanilla JS, no dependencies.
// Items come from a JSON <script id="mc-items"> block:
//   { src, thumb?, still?, clip?, duration?, caption, where }
// Only the current item's full media is requested; thumbnails are lazy <img>.
// Autoplay: a still stays STILL_MS, a clip stays for its own `duration`; the pause button stops it.
// Under prefers-reduced-motion the carousel starts paused and clips show their still frame.
(() => {
  const root = document.querySelector('[data-mc]');
  if (!root) return;
  const STILL_MS = 5000;
  const items = JSON.parse(document.getElementById('mc-items').textContent);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stage = root.querySelector('.mc-stage');
  const caption = root.querySelector('.mc-caption');
  const where = root.querySelector('.mc-where');
  const counter = root.querySelector('.mc-counter');
  const strip = root.querySelector('.mc-strip');
  const pauseBtn = root.querySelector('.mc-pause');
  let cur = 0;
  let paused = reduced;
  let timer = null;

  const pad = (n) => String(n).padStart(2, '0');

  items.forEach((it, i) => {
    const b = document.createElement('button');
    b.className = 'mc-thumb';
    b.type = 'button';
    b.setAttribute('aria-label', `${i + 1}: ${it.caption}`);
    b.innerHTML = `<img loading="lazy" decoding="async" alt="" src="${it.thumb ?? it.src}">` +
      (it.clip ? '<span class="mc-play">▶ CLIP</span>' : '');
    b.addEventListener('click', () => show(i));
    strip.append(b);
  });

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (paused || document.hidden) return;
    timer = setTimeout(() => show(cur + 1), items[cur].duration ?? STILL_MS);
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
    const it = items[cur];
    clearTimeout(timer);
    stage.querySelectorAll('.mc-media, .mc-loading').forEach((n) => n.remove());
    const loading = document.createElement('div');
    loading.className = 'mc-loading';
    loading.textContent = 'loading…';
    stage.prepend(loading);
    const img = document.createElement('img');
    img.className = 'mc-media';
    img.alt = it.caption;
    img.decoding = 'async';
    img.src = reduced && it.still ? it.still : it.src;
    // The timer starts when the media is on screen, so a slow GIF still plays to its end.
    img.addEventListener('load', () => { loading.remove(); schedule(); }, { once: true });
    stage.append(img);
    caption.innerHTML = (it.clip ? '<span class="mc-badge">CLIP</span>' : '') + it.caption;
    where.textContent = it.where ?? '';
    counter.textContent = `${pad(cur + 1)} / ${pad(items.length)}`;
    strip.querySelectorAll('.mc-thumb').forEach((t, k) => t.setAttribute('aria-current', String(k === cur)));
    const active = strip.children[cur];
    if (active) strip.scrollTo({ left: active.offsetLeft - strip.clientWidth / 2 + active.clientWidth / 2, behavior: reduced ? 'auto' : 'smooth' });
  }

  root.querySelector('.mc-prev').addEventListener('click', () => show(cur - 1));
  root.querySelector('.mc-next').addEventListener('click', () => show(cur + 1));
  pauseBtn.addEventListener('click', () => setPaused(!paused));
  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { show(cur - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { show(cur + 1); e.preventDefault(); }
  });
  document.addEventListener('visibilitychange', schedule);

  // Swipe: horizontal pointer drag over the stage (vertical scroll stays with the page: touch-action: pan-y).
  let x0 = null;
  stage.addEventListener('pointerdown', (e) => { x0 = e.target.closest('button') ? null : e.clientX; });
  stage.addEventListener('pointerup', (e) => {
    if (x0 === null) return;
    const dx = e.clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 40) show(cur + (dx < 0 ? 1 : -1));
  });

  setPaused(paused);
  show(0);
})();
