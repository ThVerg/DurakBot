/* Atelier table — layout + light interactions for the static mock */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  Atelier.hydrate(); // swap [data-card] placeholders for real cards before wiring events

  /* ---- opponent fans (held cards peeking above the avatar) ---- */
  $$('.opp-fan').forEach((fan) => {
    const n = +fan.dataset.count || 0;
    const known = fan.dataset.known;
    const spread = Math.min(9, 44 / Math.max(n, 1));
    let html = '';
    for (let i = 0; i < n; i++) {
      const r = (i - (n - 1) / 2) * spread;
      const st = `transform: rotate(${r}deg); z-index:${i}`;
      if (known && i === n - 1) html += Atelier.card(known, { cls: 'known', style: `transform: rotate(${r + 4}deg) translate(6px, -2px)` });
      else html += Atelier.cardBack({ style: st });
    }
    fan.innerHTML = html;
  });

  /* ---- the hand: a gentle arc, computed from count and available width ---- */
  const hand = $('#hand');
  function layoutHand() {
    const cards = $$('.h-card', hand);
    const n = cards.length;
    const hw = parseFloat(getComputedStyle(hand).getPropertyValue('--hw')) || 128;
    const avail = hand.clientWidth;
    const phone = window.matchMedia('(max-width: 640px)').matches;
    const rotStep = phone ? 2.4 : 2.2;
    const maxR = ((n - 1) / 2) * rotStep * Math.PI / 180;
    const spill = hw * 1.4 * Math.sin(maxR);           // outer top corners lean outwards
    const ideal = hw * (phone ? 0.6 : 0.7);
    const step = Math.max(hw * 0.3, Math.min(ideal, (avail - hw - 2 * spill - 4) / (n - 1)));
    cards.forEach((c, i) => {
      const k = i - (n - 1) / 2;
      c.style.setProperty('--x', `${k * step}px`);
      c.style.setProperty('--r', `${k * rotStep}deg`);
      c.style.setProperty('--y', `${k * k * (phone ? 1.6 : 2.2)}px`);
      c.style.zIndex = i + 1;
    });
  }
  layoutHand();
  window.addEventListener('resize', layoutHand);
  document.fonts && document.fonts.ready.then(layoutHand);

  /* ---- card tracker: 4 suits × 9 ranks ---- */
  const trk = $('#tracker');
  if (trk) {
    const ranks = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const suits = ['S', 'C', 'D', 'H'];
    const st = {};
    'S6 S7 D6 D7 H6 C10 S10 CJ C7 S9 D9 C8'.split(' ').forEach((k) => (st[k.slice(1) + k[0]] = 'gone'));
    ['6C', '9C', 'QD', 'KD', '7H', 'AS', '10H'].forEach((c) => (st[c] = 'hand'));
    ['8S', 'JS', '8D'].forEach((c) => (st[c] = 'table'));
    ['QC', '9H'].forEach((c) => (st[c] = 'known'));
    let h = '<span class="trk-corner"></span>' + ranks.map((r) => `<span class="trk-rank">${r}</span>`).join('');
    suits.forEach((s) => {
      const trump = s === 'H';
      h += `<span class="trk-suit${trump ? ' is-trump' : ''}">${Atelier.glyph(s)}</span>`;
      ranks.forEach((r) => {
        const k = r + s;
        h += `<span class="trk-cell ${st[k] ? 'is-' + st[k] : ''}${trump ? ' in-trump' : ''}" title="${k}">${r}</span>`;
      });
    });
    trk.innerHTML = h;
  }

  /* ---- theme toggle ---- */
  const root = document.documentElement;
  function syncTheme() {
    const t = root.getAttribute('data-theme');
    $$('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === t)));
  }
  $$('[data-theme-set]').forEach((b) => b.addEventListener('click', () => {
    root.setAttribute('data-theme', b.dataset.themeSet);
    syncTheme();
  }));
  syncTheme();

  /* ---- inspector (move log) toggle ---- */
  const app = $('#app');
  const logBtn = $('#logToggle');
  logBtn && logBtn.addEventListener('click', () => {
    const on = !app.classList.toggle('no-inspector');
    logBtn.classList.toggle('is-on', on);
    logBtn.setAttribute('aria-pressed', String(on));
    setTimeout(layoutHand, 20);
  });

  /* ---- demo: hovering any legal card hands the “hover” look over from the default one ---- */
  const demoHover = $('.h-card.is-hover');
  $$('.h-card.is-legal').forEach((c) => {
    c.addEventListener('mouseenter', () => { if (demoHover && demoHover !== c) demoHover.classList.remove('is-hover'); });
  });

  /* ---- demo: play a legal card onto the open attack (FLIP) ---- */
  const slot = $('.slot');
  const prompt = { eyebrow: $('.prompt-eyebrow'), title: $('.prompt-title'), sub: $('.prompt-sub') };
  let played = null;
  $$('.h-card.is-legal').forEach((c) => c.addEventListener('click', () => {
    if (played || !slot) return;
    played = c;
    const from = c.getBoundingClientRect();
    const to = slot.getBoundingClientRect();
    const clone = c.cloneNode(true);
    clone.classList.remove('h-card', 'is-legal', 'is-hover', 'is-trump');
    clone.querySelectorAll('.tip,.trump-tag').forEach((e) => e.remove());
    clone.classList.add('def');
    clone.style.cssText = '';
    slot.parentElement.appendChild(clone);
    const end = clone.getBoundingClientRect();
    const dx = from.left - end.left, dy = from.top - end.top;
    const s = from.width / end.width;
    clone.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(0deg)` },
      { transform: 'translate(0,0) scale(1) rotate(3deg)' }
    ], { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both' });
    c.remove();
    requestAnimationFrame(layoutHand);           // the hand closes the gap
    slot.style.display = 'none';
    $('.target') && $('.target').classList.remove('target');
    $$('.h-card').forEach((h) => { h.classList.remove('is-legal', 'is-hover'); h.classList.add('is-dim'); });
    if (prompt.eyebrow) prompt.eyebrow.lastChild.textContent = 'Defended · Waiting';
    if (prompt.title) prompt.title.textContent = 'Nicely covered';
    if (prompt.sub) prompt.sub.textContent = 'Kostya and Zina may still throw in. Click anywhere to reset.';
    setTimeout(() => document.addEventListener('click', () => location.reload(), { once: true }), 50);
  }));

  /* keyboard: T = take, H = hint (visual press only in the mock) */
  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const b = k === 't' ? $('.btn-take') : k === 'h' ? $('.btn-hint') : null;
    if (!b) return;
    b.classList.add('is-pressed');
    setTimeout(() => b.classList.remove('is-pressed'), 160);
  });
})();
