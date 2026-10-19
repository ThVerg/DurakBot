/* Dacha concept — table mockup behaviour: fans, hand layout, demo states. */
(function () {
  const stage = document.querySelector('.stage--ui');
  const mq = matchMedia('(max-width: 640px)');

  /* opponents' face-down fans */
  document.querySelectorAll('.fan').forEach(f => {
    const n = +f.dataset.n, known = f.dataset.known, mid = (n - 1) / 2;
    for (let i = 0; i < n; i++) {
      const img = document.createElement('img');
      const face = known && i === 0;
      img.className = 'card' + (face ? ' face' : '');
      img.src = face ? `../assets/cards/${known}.webp` : 'art/back.svg';
      img.alt = '';
      img.style.setProperty('--i', i - mid);
      img.style.zIndex = i + 1;
      f.appendChild(img);
    }
  });

  /* your hand: a soft arc */
  const cards = [...document.querySelectorAll('.hcard')];
  function layoutHand() {
    const mobile = mq.matches;
    const n = cards.length, mid = (n - 1) / 2;
    const cw = mobile ? 92 : 146;
    const step = mobile ? Math.min(42, (innerWidth - 56 - cw) / (n - 1)) : 86;
    const rot = mobile ? 3.4 : 3.6;
    cards.forEach((c, i) => {
      const d = i - mid;
      const arc = d * d * (mobile ? 2 : 3.4);
      let lift = 0;
      if (c.classList.contains('is-legal')) lift = mobile ? -18 : -28;
      if (c.classList.contains('is-dim')) lift = mobile ? 4 : 10;
      if (c.classList.contains('is-hover')) lift -= mobile ? 12 : 16;
      const baseY = mobile ? -26 : -36;
      c.style.transform = `translateX(${d * step}px) translateY(${baseY + arc + lift}px) rotate(${d * rot}deg)`;
      c.style.zIndex = c.classList.contains('is-hover') ? 20 : i + 1;
    });
  }
  const slot = document.querySelector('.dropslot span');
  const slotText = c => (document.documentElement.lang === 'ru' ? 'побить<br>' : 'beat with<br>') + '<b>' + NAMES[c.dataset.c] + '</b>';
  const NAMES = { QD: 'Q<i class="suit d"></i>', KD: 'K<i class="suit d"></i>', '7H': '7<i class="suit h"></i>', '10H': '10<i class="suit h"></i>' };
  cards.forEach(c => {
    if (!c.classList.contains('is-legal')) return;
    const tip = document.createElement('span');
    tip.className = 'play-tip';
    tip.innerHTML = (document.documentElement.lang === 'ru' ? 'Побить ' : 'Beat with ') + NAMES[c.dataset.c];
    c.appendChild(tip);
    c.addEventListener('mouseenter', () => { c.classList.add('is-hover'); stage.classList.add('is-dragging'); slot.innerHTML = slotText(c); layoutHand(); });
    c.addEventListener('mouseleave', () => { c.classList.remove('is-hover'); stage.classList.remove('is-dragging'); layoutHand(); });
  });
  layoutHand();
  addEventListener('resize', layoutHand);
  mq.addEventListener('change', layoutHand);

  /* buttons */
  const log = document.querySelector('.log');
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act;
    if (act === 'log') log.classList.toggle('is-open');
    if (act === 'hint') {
      const on = stage.classList.toggle('show-hint');
      document.querySelector('.hcard[data-c="QD"]').classList.toggle('is-hint', on);
    }
  });

  /* demo states for review: ?state=hover|hint|log|press */
  const st = new URLSearchParams(location.search).get('state') || '';
  if (st.includes('hover')) {
    const k = document.querySelector('.hcard[data-c="KD"]');
    k.classList.add('is-hover'); stage.classList.add('demo-hover'); slot.innerHTML = slotText(k); layoutHand();
    document.querySelector('.take').classList.add('is-hover');
  }
  if (st.includes('hint')) document.querySelector('[data-act="hint"]').click();
  if (st.includes('log')) log.classList.add('is-open');
  if (st.includes('press')) document.querySelector('.take').classList.add('is-press');
})();
