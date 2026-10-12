// Filter blog cards by the active category chip AND the text entered in the
// search bar above the list, and keep the feedback line + clear button in sync.
function filterBlogs() {
  const searchInput = document.getElementById('blogSearch');
  if (!searchInput) return;

  const query = searchInput.value.toLowerCase().trim();
  const blogMain = document.querySelector('.blog-page');
  if (!blogMain) return;

  const activeChip = blogMain.querySelector('.blog-filter-btn.active');
  const cat = (activeChip && activeChip.dataset.cat) || 'all';
  // Chip text is "Anime 1" (name + count span); strip the trailing count.
  const catName = activeChip && cat !== 'all'
    ? activeChip.textContent.replace(/\s*\d+\s*$/, '').trim()
    : '';

  const blogCards = blogMain.querySelectorAll('.blog-card');
  let visible = 0;

  blogCards.forEach(card => {
    const inCat = cat === 'all' || card.dataset.category === cat;
    const show = inCat && card.textContent.toLowerCase().includes(query);
    card.style.display = show ? "" : "none";
    if (show) visible++;
  });

  const clearButton = document.getElementById('blogSearchClear');
  if (clearButton) clearButton.hidden = query === '';

  // Feedback line: hidden normally; otherwise a match count (or an
  // empty-state message) covering the category filter, the search, or both.
  const meta = document.getElementById('blogSearchMeta');
  if (!meta) return;

  if (query === '' && cat === 'all') {
    meta.hidden = true;
  } else {
    meta.hidden = false;
    const q = searchInput.value.trim();
    const scope = cat === 'all' ? '' : ` in ${catName}`;
    const matchClause = query ? ` matching “${q}”` : '';
    if (visible === 0) {
      meta.textContent = cat === 'all'
        ? `No posts match “${q}”.`
        : `No posts${scope}${matchClause}.`;
    } else if (query === '') {
      meta.textContent = `${visible} ${visible === 1 ? 'post' : 'posts'}${scope}.`;
    } else {
      meta.textContent = cat === 'all'
        ? `Found ${visible} ${visible === 1 ? 'post' : 'posts'} matching “${q}”.`
        : `Found ${visible} ${visible === 1 ? 'post' : 'posts'}${scope}${matchClause}.`;
    }
  }
}

// Bind the blog search bar (listeners live here instead of inline handlers).
function initBlogSearch() {
  const searchInput = document.getElementById('blogSearch');
  if (!searchInput) return;

  searchInput.addEventListener('input', filterBlogs);

  const clearButton = document.getElementById('blogSearchClear');
  if (clearButton) {
    clearButton.addEventListener('click', () => {
      searchInput.value = '';
      filterBlogs();
      searchInput.focus();
    });
  }
}

// Category chip toolbar on the blog list: single-select filtering combined
// with the text search, mirrored into the ?cat= query param (replaceState, so
// a filtered state survives a reload; Back simply leaves the page).
function initBlogFilters() {
  const bar = document.querySelector('.blog-filters');
  if (!bar) return;

  const setActive = (chip) => {
    bar.querySelectorAll('.blog-filter-btn').forEach(btn => {
      const on = btn === chip;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const url = new URL(location.href);
    const cat = chip ? chip.dataset.cat : 'all';
    if (!chip || cat === 'all') url.searchParams.delete('cat');
    else url.searchParams.set('cat', cat);
    history.replaceState(null, '', url);
    filterBlogs();
  };

  bar.addEventListener('click', (event) => {
    const chip = event.target.closest('.blog-filter-btn');
    if (chip) setActive(chip);
  });

  // Deep link: /blog?cat=anime preselects that chip; invalid values fall
  // through to All without touching the URL.
  const requested = new URLSearchParams(location.search).get('cat');
  if (requested) {
    const match = Array.from(bar.querySelectorAll('.blog-filter-btn'))
      .find(btn => btn.dataset.cat === requested);
    if (match) {
      setActive(match);
      return;
    }
  }
  filterBlogs();
}

// Publish the sticky nav's height as a CSS custom property so style.css can
// set scroll-padding-top with it: TOC anchors are plain links and the browser
// does the scrolling natively, no click interception needed.
function initNavScrollPadding() {
  const nav = document.querySelector('nav');
  if (!nav) return;

  const update = () => {
    document.documentElement.style.setProperty('--nav-height', nav.offsetHeight + 'px');
  };
  window.addEventListener('resize', update, { passive: true });
  update();

  // Frosted-nav scrolled state: a hairline border shows once the page moves.
  // style.css keeps the border slot transparent at rest, so the nav height —
  // and --nav-height above — never changes.
  const onScroll = () => {
    nav.classList.toggle('nav-scrolled', window.scrollY > 4);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

// Full-screen mobile menu (Apple style). The overlay is a native <dialog>
// built once from this page's own .nav-list, so its links can never drift
// from the nav markup; showModal() supplies focus trap, Esc and focus
// restore, same as the lightbox and QR modal.
function initMobileMenu() {
  const nav = document.querySelector('nav');
  const toggle = document.getElementById('menuToggle');
  const list = document.querySelector('.nav-list');
  if (!nav || !toggle || !list) return;

  // From here on, small screens hide the inline links and show the hamburger.
  document.documentElement.classList.add('menu-ready');

  const menu = document.createElement('dialog');
  menu.id = 'mobileMenu';
  menu.className = 'mobile-menu';
  menu.setAttribute('aria-label', 'Site menu');
  const menuList = list.cloneNode(true);
  menuList.className = 'mobile-menu-list';
  menuList.querySelectorAll('li').forEach((li, i) => li.style.setProperty('--i', i));
  menu.appendChild(menuList);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'menu-toggle mobile-menu-close';
  closeBtn.setAttribute('aria-label', 'Close menu');
  closeBtn.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
  menu.appendChild(closeBtn);
  document.body.appendChild(menu);

  // The real theme toggle is moved (not cloned) into the menu while open so
  // its id and click listener stay unique, then returned to its original
  // spot next to the hamburger on close.
  const themeToggle = document.getElementById('themeToggle');
  const themeToggleHome = themeToggle ? themeToggle.nextSibling : null;

  const openMenu = () => {
    if (themeToggle) menu.appendChild(themeToggle);
    menu.showModal();
    document.body.style.overflow = 'hidden';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close menu');
    toggle.querySelector('i').className = 'fa-solid fa-xmark';
  };

  const closeMenu = () => {
    if (menu.open) menu.close();
  };

  toggle.addEventListener('click', () => (menu.open ? closeMenu() : openMenu()));
  closeBtn.addEventListener('click', closeMenu);
  // Tapping the frosted backdrop or any link dismisses the menu; link
  // navigation proceeds after close.
  menu.addEventListener('click', (e) => {
    if (e.target === menu || e.target.closest('a')) closeMenu();
  });

  // One restore path for every way the menu closes (X, backdrop, link, Esc).
  menu.addEventListener('close', () => {
    document.body.style.overflow = '';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
    toggle.querySelector('i').className = 'fa-solid fa-bars';
    if (themeToggle && themeToggle.parentElement === menu) {
      nav.querySelector('.nav-container').insertBefore(themeToggle, themeToggleHome);
    }
  });

  // Rotating the phone / growing past the breakpoint closes the overlay.
  matchMedia('(min-width: 821px)').addEventListener('change', closeMenu);
}

// Load Google Analytics 4 tracking script only after the page has fully
// loaded and the browser is idle. googletagmanager.com is unreachable in
// some regions (e.g. mainland China); loading that late keeps a hanging
// request off the critical path there, while visits that can reach Google
// are still measured normally. (Cloudflare Web Analytics stays instant.)
(function() {
  const GA_ID = 'G-5X78JT0JSQ';

  // Safari lacks requestIdleCallback; a short timeout is an adequate stand-in.
  const whenIdle = window.requestIdleCallback
    ? function(cb) { window.requestIdleCallback(cb, { timeout: 3000 }); }
    : function(cb) { window.setTimeout(cb, 1500); };

  function loadGa() {
    window.dataLayer = window.dataLayer || [];
    function gtag() {
      window.dataLayer.push(arguments);
    }
    gtag('js', new Date());
    gtag('config', GA_ID);

    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
    document.head.appendChild(script);
  }

  if (document.readyState === 'complete') {
    whenIdle(loadGa);
  } else {
    window.addEventListener('load', function() { whenIdle(loadGa); }, { once: true });
  }
})();

// Cloudflare Worker endpoint that handles comment submissions.
const API_URL = 'https://workers.nathanpenny.fun';

// ============================================================================
// FIRST-PARTY ANALYTICS (a pageview beacon to our own Worker; no cookies, no
// third parties — see the Privacy page). One pageview fires immediately; a
// second beacon reports how long the page stayed visible when it is hidden.
// The Worker derives a pseudonymous visitor id from a salted IP+UA hash
// (the IP itself is never stored), drops bots and rate-limits, so this stays
// quiet and cheap on every page including 404s.
// ============================================================================

// The owner sets localStorage.npSelf = '1' once to mark their own browser,
// and the dashboard can exclude those visits from every number.
function analyticsIsSelf() {
  try { return localStorage.getItem('npSelf') === '1' ? 1 : 0; } catch (e) { return 0; }
}

function initAnalytics() {
  if (navigator.webdriver) return; // headless test browsers — the Worker drops them anyway
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;

  // Session id + per-tab pageview counter live in sessionStorage: they die
  // with the tab, which is exactly the lifetime of a "visit".
  let sid = 'sid-fallback-' + Date.now().toString(36);
  let depth = 1;
  try {
    sid = sessionStorage.getItem('npSid') || crypto.randomUUID();
    sessionStorage.setItem('npSid', sid);
    depth = parseInt(sessionStorage.getItem('npDepth') || '0', 10) + 1;
    sessionStorage.setItem('npDepth', String(depth));
  } catch (e) { /* storage blocked — this pageview still counts */ }

  const payload = {
    v: 1,
    sid: sid,
    depth: depth,
    path: location.pathname,
    ref: document.referrer || '',
    lang: navigator.language || '',
    tz: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '',
    self: analyticsIsSelf()
  };

  const send = (data) => {
    try {
      // sendBeacon survives page unloads and needs no CORS response handling.
      navigator.sendBeacon(API_URL + '/api/analytics/hit',
        new Blob([JSON.stringify(data)], { type: 'text/plain' }));
    } catch (e) { /* analytics must never disturb the page */ }
  };
  send(payload);

  // Time on page: reported once, when the tab (or the page) goes away.
  const startedAt = Date.now();
  let durationSent = false;
  const sendDuration = () => {
    if (durationSent) return;
    durationSent = true;
    send({ v: 1, t: 'd', sid: sid, path: payload.path, d: Math.round((Date.now() - startedAt) / 1000) });
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) sendDuration(); });
  window.addEventListener('pagehide', sendDuration);
}


// Site avatar image for the AI chat launcher. Resolved against this script's
// own URL at execution time (document.currentScript is null by the time
// DOMContentLoaded fires), so it is correct at any page depth.
const AVATAR_URL = new URL('../images/NathanPenny.webp', document.currentScript.src).href;

// Penny mascot: the toast avatar. Script-relative
// like AVATAR_URL, so it resolves at any page depth.
const PENNY_ICON_URL = new URL('../images/assets/mascot/web/core-penny-512.webp', document.currentScript.src).href;

// Site root, resolved at script-eval time (document.currentScript is gone by
// DOMContentLoaded). main.js lives at <root>/scripts/, so one level up from
// its own URL is the site root — correct at every page depth and on the
// GitHub Pages subpath too, where root-absolute paths would break.
const SITE_ROOT_URL = new URL('../', (document.currentScript && document.currentScript.src) || location.href);

// Convert special HTML characters to entities so user content cannot inject markup.
function escapeHtml(text) {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// Update the small status text next to the submit button.
function showStatus(element, message, type) {
  if (!element) return;
  element.textContent = message;
  element.className = 'form-status' + (type ? ' ' + type : '');
}

// ============================================================================
// GALLERY PAGE
// ============================================================================

let galleryImages = [];
let filteredImages = [];
let currentLightboxIndex = -1;

async function loadGallery() {
  const grid = document.getElementById('galleryGrid');
  if (!grid) return;

  try {
    const response = await fetch('../data/gallery.json');
    if (!response.ok) throw new Error('Failed to load gallery data');

    galleryImages = await response.json();
    renderFilters(galleryImages);
    filterGallery();
    initLightbox();
  } catch (error) {
    grid.innerHTML = `<p class="gallery-empty">Failed to load gallery: ${escapeHtml(error.message)}</p>`;
  }
}

function renderFilters(images) {
  const container = document.getElementById('galleryFilters');
  if (!container) return;

  const categories = new Set(images.map(img => img.category).filter(Boolean));
  const sorted = Array.from(categories).sort();

  sorted.forEach(category => {
    const button = document.createElement('button');
    button.className = 'filter-btn';
    button.type = 'button';
    button.dataset.category = category;
    button.textContent = capitalize(category);
    container.appendChild(button);
  });

  container.addEventListener('click', (event) => {
    if (!event.target.classList.contains('filter-btn')) return;

    container.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');
    filterGallery();
  });
}

function filterGallery() {
  const searchInput = document.getElementById('gallerySearch');
  const activeFilter = document.querySelector('.filter-btn.active');
  const category = activeFilter ? activeFilter.dataset.category : 'all';
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

  filteredImages = galleryImages.filter(image => {
    const matchesCategory = category === 'all' || image.category === category;
    const matchesSearch = !query ||
      (image.title && image.title.toLowerCase().includes(query)) ||
      (image.description && image.description.toLowerCase().includes(query));
    return matchesCategory && matchesSearch;
  });

  renderGallery(filteredImages);
  updateEmptyState(filteredImages.length === 0);
}

function renderGallery(images) {
  const grid = document.getElementById('galleryGrid');
  if (!grid) return;

  grid.innerHTML = '';

  images.forEach((image, index) => {
    const item = document.createElement('article');
    item.className = 'gallery-item';
    item.setAttribute('role', 'listitem');
    item.setAttribute('tabindex', '0');
    item.dataset.index = index;
    item.setAttribute('data-reveal', '');

    item.innerHTML = `
      <img class="gallery-img" src="${escapeHtml(image.src)}" alt="${escapeHtml(image.title || 'Gallery image')}" loading="lazy">
      <div class="gallery-info">
        <h3>${escapeHtml(image.title || 'Untitled')}</h3>
        <p>${escapeHtml(image.description || '')}</p>
      </div>
    `;

    item.addEventListener('click', () => openLightbox(index));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openLightbox(index);
      }
    });

    grid.appendChild(item);
  });

  observeReveals(grid);
}

function updateEmptyState(isEmpty) {
  const emptyMessage = document.getElementById('galleryEmpty');
  if (emptyMessage) emptyMessage.hidden = !isEmpty;
}

function initLightbox() {
  const lightbox = document.getElementById('lightbox');
  if (!lightbox) return;

  document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
  document.getElementById('lightboxPrev').addEventListener('click', () => navigateLightbox(-1));
  document.getElementById('lightboxNext').addEventListener('click', () => navigateLightbox(1));

  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) closeLightbox();
  });

  // Esc and focus restore are native to <dialog>; reset state on close.
  lightbox.addEventListener('close', () => {
    document.body.style.overflow = '';
    currentLightboxIndex = -1;
  });

  document.addEventListener('keydown', (event) => {
    if (!lightbox.open) return;
    if (event.key === 'ArrowLeft') navigateLightbox(-1);
    if (event.key === 'ArrowRight') navigateLightbox(1);
  });
}

function openLightbox(index) {
  const lightbox = document.getElementById('lightbox');
  if (!lightbox || filteredImages.length === 0) return;

  currentLightboxIndex = index;
  showLightboxImage(index);
  if (!lightbox.open) {
    lightbox.showModal();
    document.body.style.overflow = 'hidden';
  }
}

function closeLightbox() {
  const lightbox = document.getElementById('lightbox');
  if (!lightbox || !lightbox.open) return;

  lightbox.close();
}

function navigateLightbox(direction) {
  if (filteredImages.length === 0) return;
  currentLightboxIndex = (currentLightboxIndex + direction + filteredImages.length) % filteredImages.length;
  showLightboxImage(currentLightboxIndex);
}

function showLightboxImage(index) {
  const image = filteredImages[index];
  if (!image) return;

  document.getElementById('lightboxImg').src = image.src;
  document.getElementById('lightboxImg').alt = image.title || 'Gallery image';
  document.getElementById('lightboxTitle').textContent = image.title || '';
  document.getElementById('lightboxDescription').textContent = image.description || '';
}

function capitalize(text) {
  return String(text).charAt(0).toUpperCase() + String(text).slice(1);
}

// Bind the gallery search box.
function initGallerySearch() {
  const searchInput = document.getElementById('gallerySearch');
  if (!searchInput) return;

  searchInput.addEventListener('input', filterGallery);
}

// ============================================================================
// CREATIONS (featured songs/videos + music library, with a bottom audio player)
// ============================================================================

// Song queue shared by featured songs and the library: [featured..., library...],
// built once at load. Play controls index THIS array (never the DOM), so
// filtering/searching only toggles visibility and can never desync playback.
let creationSongs = [];
let creationAudio = null;
let currentSongIndex = -1;
let creationSeeking = false;
let musicLibrary = [];
let musicVisible = [];
let musicSentinelObserver = null;
const MUSIC_CHUNK = 30;

function creationFormatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function creationCoverHtml(song) {
  if (song.cover) {
    return `<img src="${escapeHtml(song.cover)}" alt="" loading="lazy" decoding="async">`;
  }
  return '<span class="creation-cover-empty"><i class="fa-solid fa-music" aria-hidden="true"></i></span>';
}

function markActiveRow() {
  document.querySelectorAll('.music-row').forEach(row => {
    row.classList.toggle('active', Number(row.dataset.songIndex) === currentSongIndex);
  });
}

// Off-site video embeds: a creations.json video entry with platform
// "bilibili" or "youtube" carries the normal watch-page URL in src; the
// player embed URL is derived here. YouTube goes through the official
// no-cookie domain (privacy-enhanced mode).
function videoEmbedUrl(item) {
  const src = String(item.src || '');
  if (item.platform === 'bilibili') {
    const m = src.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/i);
    if (!m) return '';
    const p = src.match(/[?&]p=(\d+)/);
    return 'https://player.bilibili.com/player.html?bvid=' + m[1]
      + (p ? '&page=' + p[1] : '') + '&autoplay=0&danmaku=0&high_quality=1';
  }
  if (item.platform === 'youtube') {
    const m = src.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (!m) return '';
    return 'https://www.youtube-nocookie.com/embed/' + m[1] + '?rel=0';
  }
  return '';
}

function renderCreations(grid, featured) {
  // Deliberately no links back into the blog: the creations section stands
  // on its own. data-reveal + observeReveals() extend the scroll-in entrance
  // to dynamically rendered content.
  grid.innerHTML = featured.map((item) => {
    if (item.type === 'video') {
      const embed = videoEmbedUrl(item);
      let player;
      if (embed) {
        // Bilibili: mirror the platform's own share/embed snippet exactly —
        // extra policies (an allow= feature list, referrerpolicy, lazy
        // loading) broke playback in the embedded player. YouTube keeps the
        // richer (and standard) attribute set.
        const attrs = item.platform === 'bilibili'
          ? 'scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"'
          : 'loading="lazy" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen referrerpolicy="no-referrer-when-downgrade"';
        player =
          '<div class="creation-embed">' +
          `<iframe src="${escapeHtml(embed)}" title="${escapeHtml(item.title)}" ${attrs}></iframe>` +
          '</div>';
      } else {
        const poster = item.poster ? ` poster="${escapeHtml(item.poster)}"` : '';
        player = `<video class="creation-video" controls playsinline preload="metadata" src="${escapeHtml(item.src)}"${poster}></video>`;
      }
      return (
        '<article class="creation-item" role="listitem" data-type="video" data-reveal>' +
        player +
        `<div class="creation-body"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p></div>` +
        '</article>'
      );
    }
    const songIndex = creationSongs.indexOf(item);
    return (
      '<article class="creation-item" role="listitem" data-type="song" data-reveal>' +
      `<div class="creation-cover">${creationCoverHtml(item)}` +
      `<button class="creation-play" type="button" data-song-index="${songIndex}" aria-label="Play"><i class="fa-solid fa-play" aria-hidden="true"></i></button>` +
      '</div>' +
      `<div class="creation-body"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p></div>` +
      '</article>'
    );
  }).join('');

  observeReveals(grid);
}

function musicRowHtml(song, index) {
  return (
    `<button class="music-row" type="button" data-song-index="${index}" data-reveal>` +
    `<span class="music-row-cover">${creationCoverHtml(song)}</span>` +
    '<span class="music-row-text">' +
    `<span class="music-row-title">${escapeHtml(song.title)}</span>` +
    `<span class="music-row-sub">${escapeHtml(song.artist)} · ${escapeHtml(song.album)}</span>` +
    '</span>' +
    '<i class="fa-solid fa-play music-row-icon" aria-hidden="true"></i>' +
    '</button>'
  );
}

// The library renders in chunks instead of all rows at once: a sentinel below
// the list pulls in the next MUSIC_CHUNK rows as it scrolls into view. Search
// resets and re-chunks rather than hiding rows, so a query only ever renders
// what can actually be seen.
function renderMusicChunk(reset) {
  const list = document.getElementById('musicList');
  if (!list) return;
  const sentinel = document.getElementById('musicSentinel');
  const start = reset ? 0 : list.querySelectorAll('.music-row').length;
  if (reset) list.innerHTML = '';

  const slice = musicVisible.slice(start, start + MUSIC_CHUNK);
  list.insertAdjacentHTML('beforeend', slice.map(song =>
    musicRowHtml(song, creationSongs.indexOf(song))
  ).join(''));

  markActiveRow();
  observeReveals(list);

  const done = start + slice.length >= musicVisible.length;
  if (sentinel) sentinel.hidden = done;
  if (sentinel && !done && !musicSentinelObserver) {
    musicSentinelObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) renderMusicChunk(false);
      });
    }, { rootMargin: '320px' });
    musicSentinelObserver.observe(sentinel);
  }

  const empty = document.getElementById('musicEmpty');
  if (empty) empty.hidden = musicVisible.length > 0;
}

function filterCreations(type) {
  document.querySelectorAll('.creation-item').forEach(card => {
    card.classList.toggle('hidden', type !== 'all' && card.dataset.type !== type);
  });
  // The library is all songs: keep it for All/Songs, hide it under Videos.
  const musicSection = document.querySelector('.music-section');
  if (musicSection) musicSection.classList.toggle('hidden', type === 'video');

  const empty = document.getElementById('creationsEmpty');
  if (empty) empty.hidden = document.querySelectorAll('.creation-item:not(.hidden)').length > 0;
}

function initCreationFilters() {
  const filters = document.querySelector('.creations-filters');
  if (!filters) return;

  filters.addEventListener('click', (event) => {
    const chip = event.target.closest('.filter-btn');
    if (!chip) return;
    filters.querySelectorAll('.filter-btn').forEach(btn => {
      const on = btn === chip;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    filterCreations(chip.dataset.type);
  });
}

function initMusicSearch() {
  const searchInput = document.getElementById('musicSearch');
  if (!searchInput) return;

  searchInput.addEventListener('input', () => {
    const query = searchInput.value.toLowerCase().trim();
    musicVisible = !query
      ? musicLibrary
      : musicLibrary.filter(song =>
          `${song.title} ${song.artist} ${song.album}`.toLowerCase().includes(query));
    renderMusicChunk(true);
  });
}

function initCreationPlayer() {
  const player = document.getElementById('creationPlayer');
  if (!player) return;
  const seek = document.getElementById('creationPlayerSeek');
  const timeEl = document.getElementById('creationPlayerTime');
  const titleEl = document.getElementById('creationPlayerTitle');
  const thumbEl = document.getElementById('creationPlayerThumb');
  const playBtn = document.getElementById('creationPlayerPlay');

  const setPlayIcon = () => {
    if (!creationAudio) return;
    const playing = !creationAudio.paused;
    playBtn.innerHTML = `<i class="fa-solid ${playing ? 'fa-pause' : 'fa-play'}" aria-hidden="true"></i>`;
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  };

  // One Audio element, created lazily inside the first click gesture — that
  // gesture unlocks audio on iOS, and every later track reuses the element.
  const ensureAudio = () => {
    if (creationAudio) return creationAudio;
    creationAudio = new Audio();
    creationAudio.addEventListener('loadedmetadata', () => {
      seek.max = creationAudio.duration || 0;
    });
    creationAudio.addEventListener('timeupdate', () => {
      if (!creationSeeking) seek.value = creationAudio.currentTime;
      timeEl.textContent = `${creationFormatTime(creationAudio.currentTime)} / ${creationFormatTime(creationAudio.duration)}`;
    });
    creationAudio.addEventListener('ended', () => playSongAt(currentSongIndex + 1)); // wraps
    creationAudio.addEventListener('play', () => { setPlayIcon(); markActiveRow(); });
    creationAudio.addEventListener('pause', setPlayIcon);
    creationAudio.addEventListener('error', setPlayIcon);
    return creationAudio;
  };

  const playSongAt = (index) => {
    if (!creationSongs.length) return;
    const count = creationSongs.length;
    currentSongIndex = ((index % count) + count) % count;
    const song = creationSongs[currentSongIndex];
    const audio = ensureAudio();
    audio.src = song.src;
    titleEl.textContent = song.title;
    thumbEl.innerHTML = song.cover
      ? `<img src="${escapeHtml(song.cover)}" alt="">`
      : '<i class="fa-solid fa-music" aria-hidden="true"></i>';
    player.hidden = false;
    document.body.classList.add('creation-player-open');
    markActiveRow();
    audio.play().catch(setPlayIcon); // e.g. a failed src must not throw
  };

  // Card overlay buttons + library rows (delegated; toggles on the current song).
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('.creation-play, .music-row');
    if (!trigger) return;
    const index = Number(trigger.dataset.songIndex);
    if (Number.isNaN(index)) return;
    if (index === currentSongIndex && creationAudio) {
      if (creationAudio.paused) creationAudio.play().catch(setPlayIcon);
      else creationAudio.pause();
      return;
    }
    playSongAt(index);
  });

  playBtn.addEventListener('click', () => {
    if (!creationAudio) { playSongAt(0); return; }
    if (creationAudio.paused) creationAudio.play().catch(setPlayIcon);
    else creationAudio.pause();
  });
  document.getElementById('creationPlayerPrev').addEventListener('click', () => playSongAt(currentSongIndex - 1));
  document.getElementById('creationPlayerNext').addEventListener('click', () => playSongAt(currentSongIndex + 1));

  // Drag must win over timeupdate while seeking.
  seek.addEventListener('pointerdown', () => { creationSeeking = true; });
  window.addEventListener('pointerup', () => { creationSeeking = false; });
  seek.addEventListener('input', () => {
    if (creationAudio && creationAudio.duration) creationAudio.currentTime = Number(seek.value);
  });

  // Inline videos and the audio bar must not play over each other; media
  // events don't bubble, so listen in the capture phase.
  document.addEventListener('play', (event) => {
    if (event.target.tagName === 'VIDEO' && creationAudio && !creationAudio.paused) creationAudio.pause();
  }, true);

  // bfcache restore may have left audio paused/frozen; re-sync the icon.
  window.addEventListener('pageshow', setPlayIcon);
}

async function loadCreations() {
  const grid = document.getElementById('creationsGrid');
  if (!grid) return;

  try {
    const featuredRes = await fetch('../data/creations.json');
    if (!featuredRes.ok) throw new Error('failed to load creations data');
    const featured = await featuredRes.json();

    // The catalog is generated by the Worker's Music tab (audio lives on R2,
    // not in the repo); a failed library fetch must not take the featured
    // cards down with it.
    let librarySongs = [];
    const libraryRes = await fetch('../data/music-library.json');
    if (libraryRes.ok) librarySongs = await libraryRes.json();

    creationSongs = [...featured.filter(item => item.type === 'song'), ...librarySongs];
    musicLibrary = librarySongs;
    musicVisible = librarySongs;
    renderCreations(grid, featured);
    renderMusicChunk(true);
    initCreationFilters();
    initMusicSearch();
    initCreationPlayer();
  } catch (error) {
    grid.innerHTML = `<p class="gallery-empty">Failed to load creations: ${escapeHtml(error.message)}</p>`;
  }
}

// ============================================================================
// COMMENTS (public discussion area on the Contact page)
// ============================================================================

const COMMENTS_API_URL = `${API_URL}/comments`;

// Reply target for the comment form: { id, name } while replying to a
// comment, null for a fresh top-level comment.
let replyTarget = null;

function buildCommentCard(item, isReply) {
  const card = document.createElement('article');
  card.className = isReply ? 'comment-card comment-reply' : 'comment-card';
  card.innerHTML = `
    <div class="comment-header">
      <span class="comment-author">${escapeHtml(item.name)}</span>
      <time class="comment-time">${new Date(item.created_at).toLocaleString()}</time>
    </div>
    <p class="comment-content">${escapeHtml(item.content)}</p>
  `;
  if (!isReply) {
    const replies = document.createElement('div');
    replies.className = 'comment-replies';
    card.appendChild(replies);
    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'comment-reply-btn';
    replyBtn.textContent = 'Reply';
    replyBtn.addEventListener('click', () => startReply(item));
    card.appendChild(replyBtn);
  }
  return card;
}

// "Reply" on a top-level comment: aim the comment form at it until cancelled
// or submitted. Threading is one level deep — the server rejects anything else.
function startReply(item) {
  replyTarget = { id: item.id, name: item.name };
  const bar = document.getElementById('commentReplyBar');
  const label = document.getElementById('commentReplyLabel');
  if (bar && label) {
    label.textContent = `Replying to ${item.name}`;
    bar.hidden = false;
  }
  document.getElementById('commentForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('commentContent')?.focus();
}

function cancelReply() {
  replyTarget = null;
  const bar = document.getElementById('commentReplyBar');
  if (bar) bar.hidden = true;
}

async function loadComments() {
  const list = document.getElementById('commentList');
  if (!list) return;

  try {
    const response = await fetch(COMMENTS_API_URL);
    if (!response.ok) throw new Error('Network response was not ok');

    const data = await response.json();
    list.innerHTML = '';

    if (!Array.isArray(data) || data.length === 0) {
      // Static mascot markup — nothing user-supplied, so innerHTML is safe here.
      list.innerHTML =
        '<div class="comment-empty">' +
        '<img class="penny-mini" src="../images/assets/mascot/web/act-hugging.webp" alt="" width="359" height="390">' +
        '<p>No comments yet. Be the first!</p>' +
        '</div>';
      return;
    }

    data.forEach(item => {
      const card = buildCommentCard(item, false);
      const repliesBox = card.querySelector('.comment-replies');
      (item.replies || []).forEach(reply => {
        repliesBox.appendChild(buildCommentCard(reply, true));
      });
      list.appendChild(card);
    });
  } catch (error) {
    list.innerHTML = `<p class="comment-error">Failed to load comments: ${escapeHtml(error.message)}</p>`;
  }
}

function initCommentForm() {
  const form = document.getElementById('commentForm');
  const status = document.getElementById('commentStatus');
  if (!form) return;

  document.getElementById('commentReplyCancel')?.addEventListener('click', cancelReply);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const name = document.getElementById('commentName').value.trim();
    const email = document.getElementById('commentEmail').value.trim();
    const content = document.getElementById('commentContent').value.trim();
    const turnstileToken = form.querySelector('[name="cf-turnstile-response"]')?.value.trim() || '';

    if (!name || !email || !content) {
      showStatus(status, 'Please fill in all fields.', 'error');
      return;
    }

    if (!turnstileToken) {
      showStatus(status, 'Please complete the human check first.', 'error');
      return;
    }

    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = 'Posting...';
    showStatus(status, '', '');

    try {
      const response = await fetch(COMMENTS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          content,
          'cf-turnstile-response': turnstileToken,
          ...(replyTarget ? { parent: replyTarget.id } : {})
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Submission failed');
      }

      const wasReply = Boolean(replyTarget);
      cancelReply();
      form.reset();
      showStatus(status, wasReply ? 'Reply posted!' : 'Posted successfully!', 'success');
      loadComments();
    } catch (error) {
      showStatus(status, 'Error: ' + error.message, 'error');
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Post Comment';
      // Turnstile tokens are single-use: get a fresh one for the next attempt.
      if (window.turnstile) window.turnstile.reset();
    }
  });
}

// QR code modal on the Contact page; each .qr-trigger carries the QR data
// (WeChat, WeChat Channels).
function initQrModal() {
  const triggers = document.querySelectorAll('.qr-trigger');
  const modal = document.getElementById('qrModal');
  const closeBtn = document.getElementById('qrModalClose');
  const titleEl = document.getElementById('qrModalTitle');
  const imgEl = document.getElementById('qrModalImg');
  if (!triggers.length || !modal || !closeBtn || !titleEl || !imgEl) return;

  function openModal(trigger) {
    titleEl.textContent = trigger.dataset.qrTitle || '';
    imgEl.src = trigger.dataset.qrImg || '';
    imgEl.alt = trigger.dataset.qrAlt || titleEl.textContent;
    modal.setAttribute('aria-label', titleEl.textContent);
    if (!modal.open) {
      modal.showModal();
      document.body.style.overflow = 'hidden';
    }
  }

  function closeModal() {
    modal.close();
  }

  triggers.forEach((trigger) => trigger.addEventListener('click', () => openModal(trigger)));
  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });
  // Esc and focus restore are native to <dialog>.
  modal.addEventListener('close', () => {
    document.body.style.overflow = '';
  });
}

// ============================================================================
// HOME: LATEST POSTS (the three newest entries from feed.xml)
// ============================================================================

// The homepage "Latest posts" cards are rendered client-side from feed.xml,
// which tools/gen_post_pages.py keeps in sync with pages/blog.html. The
// section stays hidden until cards are ready, so a failed fetch just means
// the homepage keeps its original three cards.
function initLatestPosts() {
  const list = document.getElementById('latestPosts');
  const section = document.getElementById('latestPostsSection');
  if (!list || !section) return;

  fetch('./feed.xml')
    .then(response => {
      if (!response.ok) throw new Error('feed unavailable');
      return response.text();
    })
    .then(text => {
      const feed = new DOMParser().parseFromString(text, 'application/xml');
      const items = Array.from(feed.getElementsByTagName('item')).slice(0, 3);
      if (!items.length) throw new Error('empty feed');

      items.forEach(item => {
        const title = item.getElementsByTagName('title')[0]?.textContent || 'Untitled';
        const link = item.getElementsByTagName('link')[0]?.textContent || './pages/blog.html';
        const pub = item.getElementsByTagName('pubDate')[0]?.textContent || '';
        const description = item.getElementsByTagName('description')[0]?.textContent || '';
        const date = pub ? new Date(pub) : null;

        // Feed content is authored in this repo, but everything still goes
        // through textContent — nothing from the feed is ever interpreted.
        const card = document.createElement('a');
        card.className = 'page-card';
        card.href = link;

        const heading = document.createElement('h3');
        heading.textContent = title;

        const body = document.createElement('p');
        if (date && !isNaN(date)) {
          const time = document.createElement('time');
          time.dateTime = date.toISOString().slice(0, 10);
          time.textContent = time.dateTime;
          body.appendChild(time);
          body.appendChild(document.createTextNode(' — '));
        }
        body.appendChild(document.createTextNode(description));

        card.appendChild(heading);
        card.appendChild(body);
        list.appendChild(card);
      });

      section.hidden = false;
    })
    .catch(() => { /* the homepage works fine without the section */ });
}

// ============================================================================
// THEME TOGGLE (light <-> dark; first visit follows the system preference)
// ============================================================================

const THEME_KEY = 'theme';

// The theme currently on screen: an explicit choice, or the system default.
function effectiveTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'light' || explicit === 'dark') return explicit;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Apply an explicit theme, or clear it to follow the system preference.
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  updateThemeToggle();
}

// The button shows what clicking will switch to: moon in light mode, sun in dark.
function updateThemeToggle() {
  const button = document.getElementById('themeToggle');
  if (!button) return;

  const icon = button.querySelector('i');
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';

  button.className = 'theme-toggle';
  icon.className = next === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
  button.title = `Switch to ${next} mode`;
  button.setAttribute('aria-label', button.title);
}

function initThemeToggle() {
  const button = document.getElementById('themeToggle');
  if (!button) return;

  updateThemeToggle();
  button.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (error) {
      // Private browsing may block storage; the toggle still works until reload.
    }
  });
}

// ============================================================================
// BLOG READING EXPERIENCE (progress bar, scrollspy, reading time, back to top)
// ============================================================================

// Thin progress bar at the top of the viewport tracking blog scroll depth.
// Only on real reading pages (single posts carry a .post-nav); the card list
// page is short and needs no progress bar.
function initReadingProgress() {
  const blogMain = document.querySelector('.blog-main');
  if (!blogMain || !document.querySelector('.post-nav')) return;

  const bar = document.createElement('div');
  bar.id = 'readingProgress';
  document.body.appendChild(bar);

  const update = () => {
    const rect = blogMain.getBoundingClientRect();
    const total = rect.height - window.innerHeight;
    const scrolled = Math.min(Math.max(-rect.top, 0), Math.max(total, 1));
    bar.style.transform = `scaleX(${total > 0 ? scrolled / total : 0})`;
  };

  document.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
}

// Append an estimated reading time to each post's date line.
// CJK characters and Latin words are counted with separate speeds.
function initReadingTime() {
  const cards = document.querySelectorAll('.blog-card');
  if (!cards.length) return;

  cards.forEach(card => {
    const date = card.querySelector('.blog-date');
    if (!date || date.querySelector('.reading-time')) return;

    const text = card.textContent || '';
    const cjkChars = (text.match(/[一-鿿぀-ヿ]/g) || []).length;
    const latinWords = text.replace(/[一-鿿぀-ヿ]/g, ' ').split(/\s+/).filter(Boolean).length;
    const minutes = Math.max(1, Math.round(cjkChars / 400 + latinWords / 200));

    const span = document.createElement('span');
    span.className = 'reading-time';
    span.textContent = ` · ~${minutes} min read`;
    date.appendChild(span);
  });
}

// Floating back-to-top button on every page.
function initBackToTop() {
  const button = document.createElement('button');
  button.id = 'backToTop';
  button.type = 'button';
  button.setAttribute('aria-label', 'Back to top');
  button.innerHTML = '<i class="fa-solid fa-arrow-up" aria-hidden="true"></i>';
  document.body.appendChild(button);

  const update = () => button.classList.toggle('visible', window.scrollY > 600);
  document.addEventListener('scroll', update, { passive: true });
  update();

  button.addEventListener('click', () => {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
  });
}

// ============================================================================
// SITE AI AVATAR CHAT (the About-page portrait is the entry point: it gets
// an "AI" badge and opens a <dialog> chat panel). Talks to the Worker's
// public /api/site-chat — per-IP limited server-side, so no key lives in
// the browser. The avatar path resolves relative to this script, which
// works at any page depth (same trick as registerServiceWorker below).
// ============================================================================

function initSiteChat() {
  const aboutAvatar = document.getElementById('aboutAvatar');
  if (!aboutAvatar) return; // no portrait on this page — no chat entry

  const avatarUrl = AVATAR_URL;

  const dialog = document.createElement('dialog');
  dialog.id = 'aiChatDialog';
  dialog.className = 'ai-chat-dialog';
  dialog.setAttribute('aria-label', 'AI avatar chat');
  dialog.innerHTML = `
    <div class="ai-chat-head">
      <img src="${avatarUrl}" alt="">
      <div>
        <strong>AI · Nathan's Avatar</strong>
        <span class="ai-chat-sub">Free model · 3 messages / minute</span>
      </div>
      <button type="button" id="aiChatClose" class="ai-chat-close" aria-label="Close chat">×</button>
    </div>
    <div class="ai-chat-messages" id="aiChatMessages"></div>
    <form id="aiChatForm" class="ai-chat-form">
      <input id="aiChatInput" type="text" maxlength="500" placeholder="Ask me anything…" autocomplete="off">
      <button type="submit" id="aiChatSend">Send</button>
    </form>
    <p class="ai-chat-status" id="aiChatStatus" aria-live="polite"></p>
  `;
  document.body.appendChild(dialog);

  const list = dialog.querySelector('#aiChatMessages');
  const form = dialog.querySelector('#aiChatForm');
  const input = dialog.querySelector('#aiChatInput');
  const statusEl = dialog.querySelector('#aiChatStatus');
  const history = [];
  let busy = false;

  const scrollDown = () => { list.scrollTop = list.scrollHeight; };

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = 'ai-chat-msg ' + role;
    const bubble = document.createElement('div');
    bubble.className = 'ai-chat-bubble';
    bubble.textContent = text;
    div.appendChild(bubble);
    list.appendChild(div);
    scrollDown();
    return bubble;
  }

  function openChat() {
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    if (!list.children.length) {
      addMessage('assistant', "Hi! I'm Nathan's AI avatar 🤖 Ask me about him, this site, or anything else.");
    }
    input.focus();
  }

  aboutAvatar.classList.add('ai-chat-trigger');
  aboutAvatar.addEventListener('click', openChat);
  aboutAvatar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openChat();
    }
  });

  dialog.querySelector('#aiChatClose').addEventListener('click', () => dialog.close());

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message || busy) return;
    if (message.length > 500) {
      statusEl.textContent = 'Messages are limited to 500 characters.';
      return;
    }
    statusEl.textContent = '';
    input.value = '';
    addMessage('user', message);
    busy = true;
    const thinking = addMessage('assistant', '…');
    scrollDown();

    fetch(`${API_URL}/api/site-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: history.slice(-8) })
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (ok && data.reply) {
          thinking.textContent = data.reply;
          history.push({ role: 'user', content: message }, { role: 'assistant', content: data.reply });
        } else {
          thinking.textContent = (data && data.error) || 'The AI is not responding right now — try again later.';
        }
      })
      .catch(() => { thinking.textContent = 'Network hiccup — please try again.'; })
      .finally(() => {
        busy = false;
        scrollDown();
        input.focus();
      });
  });
}

// ============================================================================
// STARFIELD (a fixed full-page canvas behind the content: stars, meteors, and
// the occasional rock that comes down and hits the page. The aurora drift in
// the hero is pure CSS on top of it.)
// ============================================================================

// Layered depth: per-layer scroll and mouse factors, far → near. The nebulae
// barely answer the scroll, the star layers drift apart, and near meteors
// visibly outrun the page — three speeds are what read as "depth".
const SCROLL_NEBULA = 0.02;
const STAR_SCROLL = [0.04, 0.09];   // [far stars, mid stars]
const STAR_MOUSE = [0.6, 1.1];      // mouse-parallax strength per star layer
const SCROLL_NEAR = 0.16;           // meteors, the nearest layer

// Pre-render the far-layer nebulae to offscreen canvases: however soft their
// edges, each one costs a single drawImage per frame. Colors are the hero
// aurora family so the sky and the hero read as one system.
function skyBuildNebulae(canvas) {
  const colors = ['26, 188, 156', '122, 102, 255', '106, 176, 243'];
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  return colors.map((rgb, i) => {
    const size = 340 + i * 70;
    const img = document.createElement('canvas');
    img.width = size;
    img.height = size;
    const ctx = img.getContext('2d');
    const half = size / 2;

    let grad = ctx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, `rgba(${rgb}, 0.5)`);
    grad.addColorStop(0.55, `rgba(${rgb}, 0.2)`);
    grad.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // An off-center second lobe so the blob never reads as a perfect circle.
    grad = ctx.createRadialGradient(half * 0.6, half * 1.3, 0, half * 0.6, half * 1.3, half * 0.7);
    grad.addColorStop(0, `rgba(${rgb}, 0.28)`);
    grad.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    return {
      img,
      x: w * (0.14 + 0.34 * i),
      y: h * (0.16 + 0.22 * ((i * 1.6) % 1)),
      size,
      alpha: 0.10 + i * 0.025,
      phase: i * 2.1
    };
  });
}

// Rebuild the starfield to fill the current viewport. Stars split into a dim
// far layer and a brighter mid layer (STAR_SCROLL/STAR_MOUSE) so scrolling
// pulls them apart.
function skyBuildStars(canvas) {
  const area = canvas.clientWidth * canvas.clientHeight;
  const count = Math.min(200, Math.max(70, Math.round(area / 5500)));
  const stars = [];

  for (let i = 0; i < count; i++) {
    const mid = Math.random() < 0.4;
    stars.push({
      x: Math.random() * canvas.clientWidth,
      y: Math.random() * canvas.clientHeight,
      r: mid ? 0.8 + Math.random() * 0.8 : 0.3 + Math.random() * 0.6,
      alpha: mid ? 0.4 + Math.random() * 0.5 : 0.15 + Math.random() * 0.35,
      speed: 0.3 + Math.random() * 0.9,   // twinkle speed
      phase: Math.random() * Math.PI * 2,
      layer: mid ? 1 : 0
    });
  }
  return stars;
}

// A burst of short-lived sparks flying out of a point (orange for rock
// impacts, teal for the UFO).
function skySpawnSparks(state, x, y, palette) {
  const colors = palette || ['#ffe8b0', '#ffc46b', '#ff9f43', '#ff7b54'];

  for (let i = 0; i < 26; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.5 + Math.random() * 3.5;
    state.sparks.push({
      x: x,
      y: y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 1.5,  // bias upward
      life: 1,
      color: colors[Math.floor(Math.random() * colors.length)]
    });
  }
}

// Flash, shockwave ring, sparks, and a brief shake of the page content.
function skyImpact(state, x, y) {
  skySpawnSparks(state, x, y);

  const main = document.querySelector('main');
  if (main) {
    main.classList.remove('impact-shake');
    void main.offsetWidth;  // restart the animation if one just finished
    main.classList.add('impact-shake');
    setTimeout(() => main.classList.remove('impact-shake'), 600);
  }

  [['impact-flash', 600], ['impact-wave', 850]].forEach(([cls, ttl]) => {
    const el = document.createElement('div');
    el.className = cls;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.addEventListener('animationend', () => el.remove());
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ttl);  // safety net if animationend is missed
  });
}

// Spawn a saucer crossing the upper sky (the starfield easter egg).
function skySpawnUfo(state, now) {
  const w = state.canvas.clientWidth;
  const ltr = Math.random() < 0.5;
  const baseY = state.canvas.clientHeight * (0.10 + Math.random() * 0.22);

  return {
    mode: 'fly',                       // 'fly' | 'caught'
    x: ltr ? -70 : w + 70,
    vx: (ltr ? 1 : -1) * (0.9 + Math.random() * 0.5),  // px per frame
    baseY: baseY,
    y: baseY,
    dir: ltr ? 1 : -1,
    lightsPhase: Math.random() * Math.PI * 2,
    nextBeamAt: now + 4000 + Math.random() * 6000,
    beam: null,                        // {starIndex, sx, sy, t, phase}
    caughtT: 0
  };
}

// One frame of the starfield saucer: cruise the sky, now and then dip a
// tractor beam to steal a star, and fly off dramatically when clicked.
// Pure canvas — nothing is overlaid on the page content.
function skyUpdateUfo(state, now) {
  const w = state.canvas.clientWidth;
  const h = state.canvas.clientHeight;
  const ctx = state.ctx;
  const t = now / 1000;

  if (!state.ufo && now > state.nextUfoAt) {
    if (now - state.nextUfoAt > 30000) {
      state.nextUfoAt = now + 30000;  // the tab slept; don't spawn a burst
    } else {
      state.ufo = skySpawnUfo(state, now);
    }
  }
  const ufo = state.ufo;
  if (!ufo) return;

  if (ufo.mode === 'caught') {
    ufo.caughtT += 1;
    const p = ufo.caughtT;

    if (p < 14) {
      // The failed escape: a wide beam blast plus a panicked jitter.
      const blast = (1 - p / 14) * 0.55;
      const blastH = Math.min(h - ufo.y, 190);
      const flare = 34 + p * 3;
      const grad = ctx.createLinearGradient(ufo.x, ufo.y, ufo.x, ufo.y + blastH);
      grad.addColorStop(0, `rgba(126, 244, 214, ${blast})`);
      grad.addColorStop(1, 'rgba(126, 244, 214, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(ufo.x - 9, ufo.y + 6);
      ctx.lineTo(ufo.x + 9, ufo.y + 6);
      ctx.lineTo(ufo.x + flare, ufo.y + blastH);
      ctx.lineTo(ufo.x - flare, ufo.y + blastH);
      ctx.closePath();
      ctx.fill();
      ufo.x += (Math.random() - 0.5) * 3;
    } else if (p === 15) {
      skySpawnSparks(state, ufo.x, ufo.y, ['#7ef4d6', '#1abc9c', '#d9fff5']);
    } else {
      // Zoom away off the top with acceleration and a short streak.
      ufo.vy = (ufo.vy || 2) + 0.55;
      ufo.y -= ufo.vy;
      ufo.x += Math.sin(p * 0.4) * 1.2;
      const streak = ctx.createLinearGradient(ufo.x, ufo.y, ufo.x, ufo.y + ufo.vy * 8);
      streak.addColorStop(0, 'rgba(126, 244, 214, 0.5)');
      streak.addColorStop(1, 'rgba(126, 244, 214, 0)');
      ctx.strokeStyle = streak;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ufo.x, ufo.y);
      ctx.lineTo(ufo.x, ufo.y + ufo.vy * 8);
      ctx.stroke();
    }

    drawSaucer(ctx, ufo.x, ufo.y, t, p < 14 ? 1 - p / 28 : 1.15);

    if (ufo.y < -90) {
      state.ufo = null;
      state.nextUfoAt = now + 100000 + Math.random() * 80000;
    }
    return;
  }

  // Cruise: drift sideways with a gentle sine bob; leave once past an edge.
  ufo.x += ufo.vx;
  ufo.y = ufo.baseY + Math.sin(t * 1.4 + ufo.lightsPhase) * 9;
  if ((ufo.vx > 0 && ufo.x > w + 90) || (ufo.vx < 0 && ufo.x < -90)) {
    state.ufo = null;
    state.nextUfoAt = now + 100000 + Math.random() * 80000;
    return;
  }

  // Tractor beam: lock onto a random star, dissolve it, and reel it in.
  // A beam only starts with enough runway left before the exit edge.
  const runway = ufo.vx > 0 ? w + 90 - ufo.x : ufo.x + 90;
  if (!ufo.beam && now > ufo.nextBeamAt && runway > 260 && state.stars.length) {
    const starIndex = Math.floor(Math.random() * state.stars.length);
    const star = state.stars[starIndex];
    // Freeze the star's wrapped position (parallax drift over ~2s is negligible).
    ufo.beam = {
      starIndex,
      sx: ((star.x + state.parallaxX * STAR_MOUSE[star.layer]) % w + w) % w,
      sy: ((star.y + state.parallaxY * STAR_MOUSE[star.layer] - state.scrollY * STAR_SCROLL[star.layer]) % h + h) % h,
      t: 0,
      phase: 'down'                    // 'down' → 'lift'
    };
  }

  if (ufo.beam && !state.stars[ufo.beam.starIndex]) {
    ufo.beam = null;  // a resize rebuilt the star array mid-abduction
    ufo.nextBeamAt = now + 12000 + Math.random() * 15000;
  }

  if (ufo.beam) {
    const beam = ufo.beam;
    beam.t += 1;
    const flicker = 0.8 + 0.2 * Math.sin(t * 24);

    if (beam.phase === 'down') {
      const p = Math.min(beam.t / 22, 1);
      const bottomY = ufo.y + 8 + (beam.sy - ufo.y - 8) * p;
      const halfTop = 7 * p;
      const halfBottom = 13 * p;
      const grad = ctx.createLinearGradient(ufo.x, ufo.y + 8, ufo.x, bottomY);
      grad.addColorStop(0, `rgba(126, 244, 214, ${0.4 * flicker})`);
      grad.addColorStop(1, 'rgba(126, 244, 214, 0.05)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(ufo.x - halfTop, ufo.y + 8);
      ctx.lineTo(ufo.x + halfTop, ufo.y + 8);
      ctx.lineTo(ufo.x + (beam.sx - ufo.x) * p + halfBottom, bottomY);
      ctx.lineTo(ufo.x + (beam.sx - ufo.x) * p - halfBottom, bottomY);
      ctx.closePath();
      ctx.fill();

      if (p >= 1) {
        beam.phase = 'lift';
        beam.t = 0;
        // The target star is "gone" the lift starts — respawn it elsewhere.
        const star = state.stars[beam.starIndex];
        star.x = Math.random() * w;
        star.y = Math.random() * h;
        star.r = 0.3 + Math.random() * 1.1;
        star.alpha = 0.2 + Math.random() * 0.6;
        star.speed = 0.3 + Math.random() * 0.9;
        star.phase = Math.random() * Math.PI * 2;
      }
    } else {
      const p = Math.min(beam.t / 42, 1);
      const ease = p * p;
      const px = beam.sx + (ufo.x - beam.sx) * ease;
      const py = beam.sy + (ufo.y + 8 - beam.sy) * ease;

      const grad = ctx.createLinearGradient(ufo.x, ufo.y + 8, beam.sx, beam.sy);
      grad.addColorStop(0, `rgba(126, 244, 214, ${0.35 * flicker})`);
      grad.addColorStop(1, 'rgba(126, 244, 214, 0.07)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(ufo.x - 7, ufo.y + 8);
      ctx.lineTo(ufo.x + 7, ufo.y + 8);
      ctx.lineTo(beam.sx + 13, beam.sy);
      ctx.lineTo(beam.sx - 13, beam.sy);
      ctx.closePath();
      ctx.fill();

      // The reeled-in star: a bright dot with a small trail.
      ctx.strokeStyle = `rgba(126, 244, 214, ${0.6 * (1 - ease * 0.5)})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + (beam.sx - px) * 0.12, py + (beam.sy - py) * 0.12);
      ctx.stroke();
      ctx.fillStyle = `rgba(217, 255, 245, ${0.95 - ease * 0.3})`;
      ctx.beginPath();
      ctx.arc(px, py, 2.2, 0, Math.PI * 2);
      ctx.fill();

      if (p >= 1) {
        ufo.beam = null;
        ufo.nextBeamAt = now + 12000 + Math.random() * 15000;
      }
    }
  }

  drawSaucer(ctx, ufo.x, ufo.y, t, 1);
}

// The saucer itself: teal glow, metal hull, glass dome, five blinking rim
// lights. scale dips for the caught shake and swells for the zoom-away.
function drawSaucer(ctx, x, y, t, scale) {
  const glow = ctx.createRadialGradient(x, y + 4, 2, x, y + 4, 36 * scale);
  glow.addColorStop(0, 'rgba(26, 188, 156, 0.20)');
  glow.addColorStop(1, 'rgba(26, 188, 156, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y + 4, 36 * scale, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  const hull = ctx.createLinearGradient(-26, 0, 26, 0);
  hull.addColorStop(0, '#8ba0b6');
  hull.addColorStop(0.5, '#dbe6f2');
  hull.addColorStop(1, '#7a8ea4');
  ctx.fillStyle = hull;
  ctx.beginPath();
  ctx.ellipse(0, 0, 26, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  const dome = ctx.createLinearGradient(0, -15, 0, 0);
  dome.addColorStop(0, 'rgba(160, 245, 225, 0.95)');
  dome.addColorStop(1, 'rgba(26, 188, 156, 0.30)');
  ctx.fillStyle = dome;
  ctx.beginPath();
  ctx.arc(0, -2, 11, Math.PI, 0);
  ctx.closePath();
  ctx.fill();

  for (let i = 0; i < 5; i++) {
    const on = 0.5 + 0.5 * Math.sin(t * 5 - i * 1.1);
    ctx.fillStyle = `rgba(126, 244, 214, ${0.35 + on * 0.6})`;
    ctx.beginPath();
    ctx.arc(-20 + i * 10, 3, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// One animation frame: twinkle the stars, ease the parallax, throw the odd
// meteor, and every so often drop a rock that hits the page.
function skyDrawFrame(state, now) {
  const ctx = state.ctx;
  const w = state.canvas.clientWidth;
  const h = state.canvas.clientHeight;

  ctx.clearRect(0, 0, w, h);

  // Ease the mouse parallax toward where the mouse points; scrolling shifts
  // the sky slightly too, which adds depth as the content moves over it.
  state.parallaxX += (state.targetX - state.parallaxX) * 0.05;
  state.parallaxY += (state.targetY - state.parallaxY) * 0.05;

  const rgb = state.effectiveTheme() === 'dark' ? '255, 255, 255' : '44, 62, 80';
  const t = now / 1000;

  // Far layer first: pre-rendered nebulae, drifting on their own slow clock
  // and barely answering scroll and mouse.
  for (const neb of state.nebulae) {
    const nx = neb.x + Math.sin(t * 0.05 + neb.phase) * 18 + state.parallaxX * 0.3;
    const ny = neb.y + Math.cos(t * 0.04 + neb.phase) * 12 + state.parallaxY * 0.3 - state.scrollY * SCROLL_NEBULA;
    ctx.globalAlpha = neb.alpha;
    ctx.drawImage(neb.img, nx - neb.size / 2, ny - neb.size / 2);
  }
  ctx.globalAlpha = 1;

  for (const star of state.stars) {
    const twinkle = 0.55 + 0.45 * Math.sin(t * star.speed + star.phase);
    // Wrap coordinates so parallax and scroll shifts never bare an edge.
    const x = ((star.x + state.parallaxX * STAR_MOUSE[star.layer]) % w + w) % w;
    const y = ((star.y + state.parallaxY * STAR_MOUSE[star.layer] - state.scrollY * STAR_SCROLL[star.layer]) % h + h) % h;

    ctx.fillStyle = `rgba(${rgb}, ${star.alpha * twinkle})`;
    ctx.beginPath();
    ctx.arc(x, y, star.r, 0, Math.PI * 2);
    ctx.fill();

    if (star.r > 1.2) {
      // The few biggest stars get a faint halo so the sky has depth.
      ctx.fillStyle = `rgba(${rgb}, ${star.alpha * twinkle * 0.15})`;
      ctx.beginPath();
      ctx.arc(x, y, star.r * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // The easter-egg saucer: cruises, beams stars up, flees when caught.
  skyUpdateUfo(state, now);

  // Occasional meteor streaking across the sky.
  if (!state.meteor && now > state.nextShootAt) {
    state.meteor = {
      x: w * (0.15 + Math.random() * 0.7),
      y: h * (0.08 + Math.random() * 0.3),
      vx: -(4 + Math.random() * 3),
      vy: 1.6 + Math.random() * 1.2,
      life: 1
    };
  }

  if (state.meteor) {
    const meteor = state.meteor;
    meteor.x += meteor.vx;
    meteor.y += meteor.vy;
    meteor.life -= 0.016;

    if (meteor.life <= 0) {
      state.meteor = null;
      state.nextShootAt = now + 9000 + Math.random() * 11000;
    } else {
      // The near layer: meteors shift with scroll faster than the page does.
      const mx = meteor.x + state.parallaxX * 1.4;
      const my = meteor.y + state.parallaxY * 1.4 - state.scrollY * SCROLL_NEAR;
      const alpha = Math.min(meteor.life * 3, (1 - meteor.life) * 5, 1);
      const grad = ctx.createLinearGradient(
        mx, my,
        mx - meteor.vx * 14, my - meteor.vy * 14
      );
      grad.addColorStop(0, `rgba(${rgb}, ${alpha})`);
      grad.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx - meteor.vx * 14, my - meteor.vy * 14);
      ctx.stroke();
    }
  }

  // Every so often: a bigger rock, accelerating down toward a random point.
  if (!state.rock && now > state.nextImpactAt) {
    if (now - state.nextImpactAt > 20000) {
      state.nextImpactAt = now + 20000;  // the tab slept; don't slam on return
    } else {
      const x0 = w * (0.2 + Math.random() * 0.6);
      const y0 = -60;
      const tx = w * (0.15 + Math.random() * 0.7);
      const ty = h * (0.45 + Math.random() * 0.4);
      const len = Math.hypot(tx - x0, ty - y0) || 1;
      state.rock = {
        x0: x0,
        y0: y0,
        tx: tx,
        ty: ty,
        ux: (tx - x0) / len,
        uy: (ty - y0) / len,
        t: 0,
        dur: 55 + Math.random() * 25  // frames
      };
    }
  }

  if (state.rock) {
    const rock = state.rock;
    rock.t += 1;
    const p = Math.min(rock.t / rock.dur, 1);
    const ease = p * p;  // gravity: the rock accelerates on the way down
    const x = rock.x0 + (rock.tx - rock.x0) * ease;
    const y = rock.y0 + (rock.ty - rock.y0) * ease;
    const trail = 60 + p * 60;  // the tail stretches as it speeds up

    const grad = ctx.createLinearGradient(x, y, x - rock.ux * trail, y - rock.uy * trail);
    grad.addColorStop(0, 'rgba(255, 214, 140, 0.95)');
    grad.addColorStop(1, 'rgba(255, 120, 60, 0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - rock.ux * trail, y - rock.uy * trail);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 190, 110, 0.35)';  // glow around the head
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff2d0';  // the hot head itself
    ctx.beginPath();
    ctx.arc(x, y, 2.6, 0, Math.PI * 2);
    ctx.fill();

    if (p >= 1) {
      skyImpact(state, rock.tx, rock.ty);
      state.rock = null;
      state.nextImpactAt = now + 35000 + Math.random() * 30000;
    }
  }

  // Impact sparks: short-lived, with a bit of gravity.
  for (let i = state.sparks.length - 1; i >= 0; i--) {
    const spark = state.sparks[i];
    spark.x += spark.vx;
    spark.y += spark.vy;
    spark.vy += 0.12;
    spark.life -= 0.02;

    if (spark.life <= 0) {
      state.sparks.splice(i, 1);
      continue;
    }

    ctx.globalAlpha = Math.min(spark.life * 1.4, 1);
    ctx.fillStyle = spark.color;
    ctx.beginPath();
    ctx.arc(spark.x, spark.y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// Wire up the full-page sky: it only animates in dark mode, and only while
// the tab is visible. Reduced motion gets a still sky with no events.
function initStarField() {
  const canvas = document.getElementById('starField');
  if (!canvas || !canvas.getContext) return;

  const ctx = canvas.getContext('2d');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    canvas,
    ctx,
    stars: [],
    nebulae: [],
    meteor: null,
    rock: null,
    sparks: [],
    nextShootAt: performance.now() + 5000 + Math.random() * 7000,
    nextImpactAt: performance.now() + 8000 + Math.random() * 6000,  // an early showpiece, then rare
    ufo: null,
    nextUfoAt: performance.now() + 18000 + Math.random() * 15000,  // first fly-by inside half a minute
    parallaxX: 0,
    parallaxY: 0,
    targetX: 0,
    targetY: 0,
    scrollY: 0,
    effectiveTheme,  // shared with the theme-toggle feature below
    rafId: 0,
    running: false
  };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.stars = skyBuildStars(canvas);
    state.nebulae = skyBuildNebulae(canvas);
    // Keep still-sky modes (reduced motion) painted after a rebuild.
    if (!state.running) skyDrawFrame(state, performance.now());
  }

  function start() {
    if (state.running) return;
    if (effectiveTheme() !== 'dark') return;  // stars belong to the night sky only
    state.running = true;
    state.rafId = requestAnimationFrame(skyLoop);
  }

  function stop() {
    state.running = false;
    cancelAnimationFrame(state.rafId);
  }

  function skyLoop(now) {
    if (!state.running) return;
    skyDrawFrame(state, now);
    state.rafId = requestAnimationFrame(skyLoop);
  }

  // Light mode shows only the pastel sky (CSS hides the canvas there too,
  // this just stops the wasted animation frames).
  function syncTheme() {
    if (effectiveTheme() === 'dark') {
      start();
    } else {
      stop();
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    }
  }

  // Rebuild the starfield once the page has fully loaded and laid out: at
  // DOMContentLoaded time the canvas dimensions can still be 0 (web font and
  // layout pending), which would leave an empty sky until the next resize.
  let layoutTimer = 0;
  function scheduleResize() {
    if (layoutTimer) cancelAnimationFrame(layoutTimer);
    layoutTimer = requestAnimationFrame(resize);
  }

  resize();
  window.addEventListener('resize', scheduleResize);
  window.addEventListener('load', scheduleResize);
  window.addEventListener('scroll', () => { state.scrollY = window.scrollY; }, { passive: true });

  if (reducedMotion) return;  // a still sky, drawn once by resize() above

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stop();
    } else {
      start();
      layoutTimer = requestAnimationFrame(resize);  // stars may need rebuilding after the tab slept
    }
  });

  document.addEventListener('mousemove', (event) => {
    state.targetX = (event.clientX / window.innerWidth - 0.5) * 26;
    state.targetY = (event.clientY / window.innerHeight - 0.5) * 26;
  }, { passive: true });

  // The saucer is drawn on the pointer-events:none canvas behind the content,
  // so catching works by document-level hit testing — clicks still reach
  // whatever element they were aimed at. The canvas only renders in dark
  // mode, so the saucer simply never exists in light mode.
  document.addEventListener('click', (event) => {
    const ufo = state.ufo;
    if (!ufo || ufo.mode !== 'fly') return;
    if (Math.hypot(event.clientX - ufo.x, event.clientY - ufo.y) > 36) return;

    ufo.mode = 'caught';
    ufo.caughtT = 0;
    ufo.beam = null;

    let catches = 1;
    try {
      catches = parseInt(localStorage.getItem('ufoCatches') || '0', 10) + 1;
      localStorage.setItem('ufoCatches', String(catches));
    } catch (error) {
      catches = 1;
    }

    if (UFO_ACHIEVEMENTS[catches]) showToast(UFO_ACHIEVEMENTS[catches]);
    else showToast(UFO_MESSAGES[Math.floor(Math.random() * UFO_MESSAGES.length)]);
  });

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  if (darkQuery.addEventListener) darkQuery.addEventListener('change', syncTheme);
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  });

  start();
}

// ============================================================================
// SPOTLIGHT & CARD GLOW (dark mode only): a cursor-following soft light over
// the page, and a local sheen inside the home cards where the cursor sweeps.
// Both are inert on touch devices and under reduced motion.
// ============================================================================

// A fixed screen-blend layer trailing the cursor with a soft teal light. It
// sits above the content (titles and cards catch the light as it passes) but
// below the nav and the lightbox. CSS hides it entirely in light mode.
function initSpotlight() {
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const el = document.createElement('div');
  el.id = 'spotlight';
  document.body.appendChild(el);

  let targetX = window.innerWidth / 2;
  let targetY = window.innerHeight * 0.35;
  let x = targetX;
  let y = targetY;
  let rafId = 0;
  let running = false;

  function frame() {
    x += (targetX - x) * 0.12;  // easing gives the light its heavy, trailing feel
    y += (targetY - y) * 0.12;
    el.style.setProperty('--sx', x + 'px');
    el.style.setProperty('--sy', y + 'px');
    rafId = requestAnimationFrame(frame);
  }
  function wake() {
    if (running) return;
    running = true;
    el.classList.add('on');
    rafId = requestAnimationFrame(frame);
  }
  function sleep() {
    if (!running) return;
    running = false;
    el.classList.remove('on');
    cancelAnimationFrame(rafId);
  }

  document.addEventListener('mousemove', (event) => {
    wake();
    targetX = event.clientX;
    targetY = event.clientY;
  }, { passive: true });
  document.addEventListener('mouseleave', sleep);

  const syncTheme = () => {
    el.style.opacity = effectiveTheme() === 'dark' ? '' : '0';
  };
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  if (darkQuery.addEventListener) darkQuery.addEventListener('change', syncTheme);
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  });
  syncTheme();
}

// Per-card coordinates for the cursor sheen (.page-card::after reads --mx/--my
// in dark mode). One delegated listener per grid keeps it cheap.
function initCardGlow() {
  document.querySelectorAll('.page-cards').forEach((grid) => {
    grid.addEventListener('mousemove', (event) => {
      const card = event.target.closest('.page-card');
      if (!card || !grid.contains(card)) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', (event.clientX - rect.left) + 'px');
      card.style.setProperty('--my', (event.clientY - rect.top) + 'px');
    }, { passive: true });
  });
}

// Reveal-on-scroll for elements tagged with data-reveal. Elements stay visible
// without JS; with reduced motion they simply never get hidden.
let revealObserver = null;

// Register data-reveal elements with the shared observer. Called at init AND
// after async content renders (gallery, creations, chunked library), since
// elements added after DOMContentLoaded need observing too.
function observeReveals(root) {
  const targets = (root || document).querySelectorAll('[data-reveal]:not(.will-reveal)');
  if (!targets.length) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  if (!revealObserver) {
    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        el.classList.add('is-visible');
        revealObserver.unobserve(el);
        // Drop the helper classes once revealed so card hover transitions
        // don't inherit the slower reveal transition and its delay.
        setTimeout(() => el.classList.remove('will-reveal', 'is-visible'), 1200);
      });
    }, { threshold: 0.15 });
  }

  targets.forEach(el => {
    el.classList.add('will-reveal');
    revealObserver.observe(el);
  });
}

function initScrollReveal() {
  observeReveals(document);
}

// ============================================================================
// UFO EASTER EGG (the saucer itself lives in the starfield canvas — see
// skySpawnUfo/skyUpdateUfo above; this part is its copy and feedback)
// ============================================================================

const UFO_MESSAGES = [
  '🛸 Abduction successful! You are visitor #42 in the ship.',
  '👽 "We came for the FIFA world cup too."',
  '🛸 The UFO society of Tsinghua greets you.',
  '👽 "Nice website. Take us to your blogger."',
  '🛸 You caught it! Fuel refilled: +1 curiosity.',
  '👽 "WanZai song on repeat until further notice."',
  '🛸 Beam me another blog post!',
  '👽 "Violet Evergarden is intergalactic cinema."'
];

const UFO_ACHIEVEMENTS = {
  3: '🏅 Achievement unlocked: UFO Hunter (3 catches)!',
  10: '🏆 Legendary: 10 UFOs caught. They know your name now.'
};

// Small feedback toast at the bottom of the screen. An optional second
// argument puts an avatar in a leading icon slot (defaults to Penny; pass
// null explicitly for a text-only toast).
function showToast(message, iconUrl) {
  const toast = document.createElement('div');
  toast.className = 'toast' + (iconUrl === null ? '' : ' has-icon');
  if (iconUrl !== null) {
    const icon = document.createElement('img');
    icon.className = 'toast-icon';
    icon.src = iconUrl || PENNY_ICON_URL;
    icon.alt = '';
    toast.appendChild(icon);
  }
  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);

  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 350);
  }, 4000);
}

// ============================================================================
// PROGRESSIVE WEB APP (offline support + installable)
// ============================================================================

// Register the service worker so the site works offline and can be installed.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') return;

  // Resolve sw.js relative to this script's own URL, not the document: pages
  // live at several depths (/pages/, /blog/<slug>/) and a document-relative
  // './sw.js' would 404 everywhere but the homepage. Script-relative resolution
  // also survives hosts that serve the site under a subpath.
  const base = (document.currentScript && document.currentScript.src) || window.location.href;
  const swUrl = new URL('../sw.js', base).href;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register(swUrl).catch(() => {
      // Registration is a progressive enhancement; ignore failures silently.
    });
  });
}

// 404 page: the saucer in "4🛸4" is the same canvas-drawn saucer the
// homepage starfield uses (drawSaucer), so the two always match — metal
// hull, glass dome, blinking rim lights and teal glow. Reduced motion gets
// a single static frame.
function initErrorUfo() {
  const canvas = document.getElementById('errorUfo');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');

  const draw = (t) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawSaucer(ctx, canvas.width / 2, canvas.height / 2, t / 1000, 1.4);
  };

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    draw(0);
    return;
  }
  const loop = (t) => {
    draw(t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// Syntax highlighting for blog code blocks: the vendored highlight.js bundle
// (scripts/vendor/, self-hosted like the fonts) is only injected when the page
// actually contains language-tagged fences, so posts without code never pay
// for it. Token colors come from the --hljs-* vars in style.css.
function initCodeHighlight() {  const blocks = document.querySelectorAll('.blog-card pre code[class^="language-"]');
  if (!blocks.length) return;
  // Only single-post pages (blog/<slug>/) can hold language-tagged fences,
  // so the two-level-relative path is safe here.
  const apply = () => {
    blocks.forEach((el) => {
      try { window.hljs.highlightElement(el); } catch (e) {
        // Unknown language class etc. — leave the block unhighlighted.
      }
    });
  };
  if (window.hljs) { apply(); return; }
  const script = document.createElement('script');
  script.src = '../../scripts/vendor/highlight.min.js';
  script.onload = apply;
  document.head.appendChild(script);
}

// ============================================================================
// ACHIEVEMENTS PAGE (rendered from data/achievements.json — edited in the
// admin Content tab). The static .achv-empty block inside #achvRoot is the
// no-JS/no-data fallback: it stays until the first section exists and
// reappears whenever the data file is emptied or unreachable.
// ============================================================================

const ACHV_SECTION_ICONS = {
  publications: 'fa-book',
  projects: 'fa-diagram-project',
  awards: 'fa-trophy',
  certificates: 'fa-certificate',
  talks: 'fa-person-chalkboard',
  research: 'fa-flask'
};

// "2026-09" / "2026-09-04" -> "Sep 2026" (month precision, like the template).
function achvFormatDate(value) {
  const m = /^(\d{4})-(\d{2})/.exec(String(value || ''));
  if (!m) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mi = parseInt(m[2], 10);
  return mi >= 1 && mi <= 12 ? `${months[mi - 1]} ${m[1]}` : '';
}

function initAchievements() {
  const root = document.getElementById('achvRoot');
  if (!root) return;

  fetch('../data/achievements.json')
    .then(response => {
      if (!response.ok) throw new Error('achievements data unavailable');
      return response.json();
    })
    .then(sections => {
      if (!Array.isArray(sections) || !sections.length) return; // keep the empty state
      root.innerHTML = sections.map((section) => {
        const icon = /^fa-[a-z0-9-]+$/.test(section.icon || '')
          ? section.icon
          : (ACHV_SECTION_ICONS[section.id] || 'fa-star');
        const cards = (Array.isArray(section.items) ? section.items : []).map((item) => {
          const date = achvFormatDate(item.date);
          const links = (Array.isArray(item.links) ? item.links : [])
            .filter(link => link && /^https?:\/\//i.test(link.url || ''))
            .map(link => {
              const isGithub = /github\.com/i.test(link.url);
              return `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener">${escapeHtml(link.label || 'Link')} <i class="${isGithub ? 'fa-brands fa-github' : 'fa-solid fa-arrow-up-right-from-square'}" aria-hidden="true"></i></a>`;
            })
            .join(' &middot; ');
          return (
            '<article class="achv-card">' +
            '<div class="achv-head">' +
            `<span class="achv-title">${escapeHtml(item.title)}${item.badge ? ` <span class="achv-badge">${escapeHtml(item.badge)}</span>` : ''}</span>` +
            (date ? `<time datetime="${escapeHtml(item.date)}">${date}</time>` : '') +
            '</div>' +
            (item.description ? `<p class="achv-desc">${escapeHtml(item.description)}</p>` : '') +
            (links ? `<p class="achv-links">${links}</p>` : '') +
            '</article>'
          );
        }).join('\n');
        return (
          `<section class="achv-section" id="${escapeHtml(section.id)}">` +
          `<h2><i class="fa-solid ${escapeHtml(icon)}" aria-hidden="true"></i> ${escapeHtml(section.title)}</h2>` +
          `<div class="achv-list">${cards}</div>` +
          '</section>'
        );
      }).join('\n');
    })
    .catch(() => { /* unreachable or invalid data — keep the empty state */ });
}

// ============================================================================
// FOOTER (single source of truth): every page carries an empty
// <footer></footer> shell and this renders the real content into it — the old
// hand-copied footers had already drifted (the homepage had MDN links, all
// the others didn't). Links resolve against SITE_ROOT_URL, so they are
// correct at any page depth. Sub-sites on their own hostnames go in the
// .footer-subsites row above the copyright line. No JS, no footer.
// ============================================================================

function initFooter() {
  const footer = document.querySelector('footer');
  if (!footer) return;
  const root = SITE_ROOT_URL.href;

  const logo = document.createElement('img');
  logo.className = 'footer-logo';
  logo.src = root + 'NP-logo.svg';
  logo.alt = 'Nathan Penny logo';

  const extLink = (name, href) => {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = name;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  };

  // Sub-site row (own hostnames, not sections of this site), above the
  // copyright line so that line keeps its credits/legal meaning.
  const subsites = document.createElement('p');
  subsites.className = 'footer-subsites';
  subsites.appendChild(extLink('Tsinghua', 'https://thu.whizzzest.com'));

  const line = document.createElement('p');
  line.append(
    '© 2026 Nathan Penny’s personal website | based on ',
    extLink('HTML', 'https://developer.mozilla.org/en-US/docs/Web/HTML'),
    ' + ',
    extLink('CSS', 'https://developer.mozilla.org/en-US/docs/Web/CSS'),
    ' + ',
    extLink('JavaScript', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript'),
    ' · '
  );
  const privacy = document.createElement('a');
  privacy.href = root + 'pages/privacy.html';
  privacy.textContent = 'Privacy';
  line.appendChild(privacy);

  footer.replaceChildren(logo, subsites, line);
}

// Initialize page-specific features once the DOM is ready.
window.addEventListener('DOMContentLoaded', () => {
  initAnalytics();
  initFooter();
  initThemeToggle();
  initLatestPosts();
  initBlogSearch();
  initBlogFilters();
  initNavScrollPadding();
  initMobileMenu();
  loadGallery();
  initGallerySearch();
  loadCreations();
  initCommentForm();
  loadComments();
  initQrModal();
  initReadingProgress();
  initReadingTime();
  initBackToTop();
  initCodeHighlight();
  initAchievements();
  initErrorUfo();
  initSiteChat();
  initStarField();
  initSpotlight();
  initCardGlow();
  initScrollReveal();
});

registerServiceWorker();
