/* DurakBot · Concept A "Arcade" — shared sprite + card builder.
   Static mockup helper: no framework, no network. */
(function () {
  'use strict';

  /* ---------- SVG sprite: chunky suits + rounded stroke icons ---------- */
  const SPRITE = `
<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">
  <defs>
    <symbol id="s-H" viewBox="0 0 100 100"><path d="M50 92C47 88 7 62 4 36 2 19 13 6 28 6c10 0 18 6 22 15C54 12 62 6 72 6c15 0 26 13 24 30C93 62 53 88 50 92Z"/></symbol>
    <symbol id="s-D" viewBox="0 0 100 100"><path d="M50 3C59 20 75 38 90 50 75 62 59 80 50 97 41 80 25 62 10 50 25 38 41 20 50 3Z"/></symbol>
    <symbol id="s-S" viewBox="0 0 100 100"><path d="M50 4C56 18 94 36 94 62c0 14-10 23-22 23-8 0-14-3-18-9 1 9 5 15 12 20H34c7-5 11-11 12-20-4 6-10 9-18 9C16 85 6 76 6 62 6 36 44 18 50 4Z"/></symbol>
    <symbol id="s-C" viewBox="0 0 100 100"><path d="M50 6a21 21 0 0 1 17 33c3-1 6-2 9-2a21 21 0 1 1-20 27c1 13 5 21 12 27H32c7-6 11-14 12-27a21 21 0 1 1-20-27c3 0 6 1 9 2A21 21 0 0 1 50 6Z"/></symbol>

    <symbol id="i-gear" viewBox="0 0 24 24"><path fill="currentColor" d="M19.42 10.34 L22.11 10.68 L22.11 13.32 L19.42 13.66 L18.42 16.07 L20.09 18.22 L18.22 20.09 L16.07 18.42 L13.66 19.42 L13.32 22.11 L10.68 22.11 L10.34 19.42 L7.93 18.42 L5.78 20.09 L3.91 18.22 L5.58 16.07 L4.58 13.66 L1.89 13.32 L1.89 10.68 L4.58 10.34 L5.58 7.93 L3.91 5.78 L5.78 3.91 L7.93 5.58 L10.34 4.58 L10.68 1.89 L13.32 1.89 L13.66 4.58 L16.07 5.58 L18.22 3.91 L20.09 5.78 L18.42 7.93Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.4" fill="var(--hole,#fff)"/></symbol>
    <symbol id="i-sound" viewBox="0 0 24 24"><path fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M11 5 6.5 9H3.5v6h3L11 19Z"/><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" d="M15.5 8.8a4.6 4.6 0 0 1 0 6.4M18.6 5.8a9 9 0 0 1 0 12.4"/></symbol>
    <symbol id="i-log" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M9 6.5h11M9 12h11M9 17.5h11"/></g><g fill="currentColor"><circle cx="4.3" cy="6.5" r="1.9"/><circle cx="4.3" cy="12" r="1.9"/><circle cx="4.3" cy="17.5" r="1.9"/></g></symbol>
    <symbol id="i-bulb" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2.5a7 7 0 0 0-4.3 12.5c.9.8 1.3 1.6 1.3 2.6h6c0-1 .4-1.8 1.3-2.6A7 7 0 0 0 12 2.5Z"/><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M9.3 20h5.4M10.5 22.4h3"/><path fill="none" stroke="rgba(255,255,255,.75)" stroke-width="1.7" stroke-linecap="round" d="M9 8.6a3.4 3.4 0 0 1 2.8-2.7"/></symbol>
    <symbol id="i-eye" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4.8C6 4.8 2.4 10 1.6 12c.8 2 4.4 7.2 10.4 7.2S21.6 14 22.4 12C21.6 10 18 4.8 12 4.8Z"/><circle cx="12" cy="12" r="4.2" fill="var(--hole,#fff)"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/></symbol>
    <symbol id="i-chart" viewBox="0 0 24 24"><g fill="currentColor"><rect x="2.5" y="12" width="5" height="9.5" rx="1.8"/><rect x="9.5" y="3" width="5" height="18.5" rx="1.8"/><rect x="16.5" y="8" width="5" height="13.5" rx="1.8"/></g></symbol>
    <symbol id="i-book" viewBox="0 0 24 24"><path fill="currentColor" d="M3 5.2c0-1 .8-1.7 1.8-1.6 2.7.2 5 .9 7.2 2.4v15c-2.2-1.4-4.5-2.1-7.2-2.3-1-.1-1.8-.8-1.8-1.8Zm18 0c0-1-.8-1.7-1.8-1.6-2.7.2-5 .9-7.2 2.4v15c2.2-1.4 4.5-2.1 7.2-2.3 1-.1 1.8-.8 1.8-1.8Z"/><path fill="none" stroke="var(--hole,#fff)" stroke-width="1.4" stroke-linecap="round" opacity=".7" d="M6 8.4c1.4.1 2.6.5 3.6 1M6 11.6c1.4.1 2.6.5 3.6 1M18 8.4c-1.4.1-2.6.5-3.6 1"/></symbol>
    <symbol id="i-users" viewBox="0 0 24 24"><g fill="currentColor"><circle cx="9" cy="7.6" r="4"/><path d="M1.6 20.4c0-4.2 3.3-7.2 7.4-7.2s7.4 3 7.4 7.2c0 .6-.5 1.1-1.1 1.1H2.7c-.6 0-1.1-.5-1.1-1.1Z"/><circle cx="17.4" cy="8.6" r="3" opacity=".75"/><path opacity=".75" d="M17.6 13.4c2.9.1 5 2.4 5 5.4 0 .5-.4.9-.9.9h-3.9c0-2.6-.8-4.6-2.3-6 .7-.2 1.4-.3 2.1-.3Z"/></g></symbol>
    <symbol id="i-globe" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2.3"><circle cx="12" cy="12" r="9.3"/><path d="M2.7 12h18.6M12 2.7c2.6 2.8 3.9 5.9 3.9 9.3s-1.3 6.5-3.9 9.3c-2.6-2.8-3.9-5.9-3.9-9.3S9.4 5.5 12 2.7Z"/></g></symbol>
    <symbol id="i-home" viewBox="0 0 24 24"><path fill="currentColor" d="M10.6 3.4a2.2 2.2 0 0 1 2.8 0l7.4 6.1c.6.5.4 1.5-.4 1.5H19v8.2c0 1-.8 1.8-1.8 1.8h-2.7v-5.2c0-.6-.4-1-1-1h-3c-.6 0-1 .4-1 1V21H6.8c-1 0-1.8-.8-1.8-1.8V11H3.6c-.8 0-1-1-.4-1.5Z"/></symbol>
    <symbol id="i-menu" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M4.5 6.5h15M4.5 12h15M4.5 17.5h15"/></symbol>
    <symbol id="i-swords" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5 3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M14.5 6.5 18 3h3v3l-3.5 3.5M5 14l4 4M7 17l-3 3M3 19l2 2"/></g></symbol>
    <symbol id="i-shield" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2.4 20 5.5v6.1c0 5-3.4 8.8-8 10-4.6-1.2-8-5-8-10V5.5Z"/><path fill="rgba(255,255,255,.35)" d="M12 2.4v19.2c-4.6-1.2-8-5-8-10V5.5Z"/></symbol>
    <symbol id="i-plus" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" d="M12 5v14M5 12h14"/></symbol>
    <symbol id="i-crown" viewBox="0 0 24 24"><path fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M3 8.2 7.6 12 12 5l4.4 7L21 8.2 19.3 18.6H4.7Z"/><rect x="4.6" y="19.6" width="14.8" height="2.2" rx="1.1" fill="currentColor"/></symbol>
    <symbol id="i-trophy" viewBox="0 0 24 24"><path fill="currentColor" d="M7 3h10v6.2a5 5 0 0 1-10 0Z"/><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M7 5.5H4.3a3.2 3.2 0 0 0 3.4 4.4M17 5.5h2.7a3.2 3.2 0 0 1-3.4 4.4"/><path fill="currentColor" d="M10.6 13.6h2.8v3.6h-2.8ZM7.4 18.4c0-.9.7-1.6 1.6-1.6h6c.9 0 1.6.7 1.6 1.6V21H7.4Z"/></symbol>
    <symbol id="i-star" viewBox="0 0 24 24"><path fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" d="m12 2.6 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9Z"/></symbol>
    <symbol id="i-take" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2v11M7.4 9.8l4.6 4.6 4.6-4.6M4 15.5v2.8c0 1.2.9 2.2 2.2 2.2h11.6c1.3 0 2.2-1 2.2-2.2v-2.8"/></g></symbol>
    <symbol id="i-close" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></symbol>
    <symbol id="i-play" viewBox="0 0 24 24"><path fill="currentColor" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" d="M8 4.8v14.4c0 .8.9 1.3 1.6.9l11-7.2a1 1 0 0 0 0-1.8l-11-7.2C8.9 3.5 8 4 8 4.8Z"/></symbol>
    <symbol id="i-back" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" d="M14.5 5 7.5 12l7 7"/></symbol>
    <symbol id="i-check" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" d="m5 12.5 4.5 4.5L19 7.5"/></symbol>
    <symbol id="i-robot" viewBox="0 0 24 24"><g fill="currentColor"><rect x="3.5" y="7" width="17" height="13" rx="4.5"/><rect x="11" y="2.6" width="2" height="4.4" rx="1"/><circle cx="12" cy="2.8" r="1.8"/><rect x="1" y="11.5" width="2" height="5" rx="1"/><rect x="21" y="11.5" width="2" height="5" rx="1"/></g><g fill="var(--hole,#fff)"><circle cx="8.8" cy="12.6" r="2"/><circle cx="15.2" cy="12.6" r="2"/><rect x="8.5" y="16.2" width="7" height="1.8" rx=".9"/></g></symbol>
    <symbol id="i-bolt" viewBox="0 0 24 24"><path fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" d="M13.5 2 4.5 13.5h6.2L9.6 22l9.6-12h-6.4Z"/></symbol>
    <symbol id="i-flame" viewBox="0 0 24 24"><path fill="currentColor" d="M12.5 2.2c.6 3.4 5.9 6 5.9 11.3a6.4 6.4 0 0 1-12.8.1c0-2.6 1.3-4.4 2.9-5.9.2 1.6.9 2.7 2.1 3.3-.5-3.6.4-6.3 1.9-8.8Z"/></symbol>
  </defs>
</svg>`;

  const SUIT_COLOR = { S: 'black', C: 'black', D: 'red', H: 'red' };
  const SUIT_NAME = { S: 'Spades', C: 'Clubs', D: 'Diamonds', H: 'Hearts' };
  const COURT = { J: 1, Q: 1, K: 1 };

  function suit(s, cls) {
    return `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true"><use href="#s-${s}"/></svg>`;
  }

  /* Card face: "jumbo index" — huge rank + suit top-left (legible when fanned),
     a big pip or a framed court portrait bottom-right. */
  function faceHTML(code) {
    const r = code.slice(0, -1), s = code.slice(-1);
    let art;
    if (COURT[r]) {
      art = `<div class="art" style="background-image:url(../assets/cards/${code}.webp)"></div>`;
    } else if (r === 'A') {
      art = `<div class="ace-burst"></div>${suit(s, 'big ace')}`;
    } else {
      art = suit(s, 'big');
    }
    return `<div class="idx"><span class="rk${r === '10' ? ' ten' : ''}">${r}</span>${suit(s, 'pip')}</div>${art}<div class="idx2"><span class="rk${r === '10' ? ' ten' : ''}">${r}</span>${suit(s, 'pip')}</div><i class="gloss"></i>`;
  }

  function hydrateCards(root) {
    (root || document).querySelectorAll('[data-card]:not([data-h])').forEach((el) => {
      el.setAttribute('data-h', '');
      const code = el.getAttribute('data-card');
      el.classList.add('card', SUIT_COLOR[code.slice(-1)]);
      if (COURT[code.slice(0, -1)]) el.classList.add('court');
      if (code.slice(0, -1) === 'A') el.classList.add('is-ace');
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', code.slice(0, -1) + ' of ' + SUIT_NAME[code.slice(-1)]);
      el.innerHTML = faceHTML(code);
    });
    (root || document).querySelectorAll('[data-back]:not([data-h])').forEach((el) => {
      el.setAttribute('data-h', '');
      el.classList.add('card', 'back');
      el.innerHTML = '<i class="emblem"></i><i class="gloss"></i>';
    });
  }

  function boot() {
    document.body.insertAdjacentHTML('afterbegin', SPRITE);
    hydrateCards();
    // Button press "squash" feedback for touch + mouse alike.
    document.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('.btn, .icon-btn, .tile');
      if (!b) return;
      b.classList.add('is-pressed');
      const up = () => { b.classList.remove('is-pressed'); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointerup', up);
    });
  }

  /* Fit a stage to a design size: 1440×900 landscape, 390×844 portrait.
     Portrait keeps the limiting dimension and lets the other one flex. */
  const PHONE_Q = '(max-width: 640px), (orientation: portrait) and (max-width: 900px)';
  const isPhone = () => matchMedia(PHONE_Q).matches;
  function fitStage(el, opts) {
    const o = Object.assign({ phone: true }, opts);
    const run = () => {
      if (isPhone()) {
        if (!o.phone) { el.style.width = el.style.height = ''; el.style.setProperty('--k', 1); return; }
        const k = Math.min(innerWidth / 390, innerHeight / 844);
        el.style.width = innerWidth / k + 'px'; el.style.height = innerHeight / k + 'px'; el.style.setProperty('--k', k);
      } else {
        el.style.width = '1440px'; el.style.height = '900px';
        el.style.setProperty('--k', Math.min(innerWidth / 1440, innerHeight / 900));
      }
      o.after && o.after();
    };
    run(); addEventListener('resize', run);
    return run;
  }

  window.Arcade = { hydrateCards, suit, fitStage, isPhone };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
