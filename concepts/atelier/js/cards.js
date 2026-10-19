/* Atelier card system: vector faces drawn at runtime (crisp at every DPR).
   Faces: 250×350 viewBox. Suit pips: CC0 English-pattern pip outlines (D. Fomin),
   flat-filled. Courts: typographic monograms set in Playfair Display. */
(function () {
  const SUIT_PATHS = {
    S: 'm 185,793.36218 c 1,4 5,14 12,14 9,0 13,-8 13,-18 0,-7 -2.57895,-11.61229 -5,-17 -2.57788,-5.73673 -6.37932,-10.85741 -10,-16 -4.6453,-6.5979 -15,-19 -15,-19 0,0 -10.3547,12.4021 -15,19 -3.62068,5.14259 -7.42212,10.26327 -10,16 -2.42105,5.38771 -5,10 -5,17 0,10 4,18 13,18 7,0 11,-10 12,-14 1,-1 1,0 1,1 -1,8 -1,10 -2,16 -1,6 -4,17 -4,17 5,-2 15,-2 20,0 0,0 -3,-11 -4,-17 -1,-6 -1,-8 -2,-16 0,-1 0,-2 1,-1 z',
    C: 'm 185,793.36218 c 2,4 7,10 12,10 9,0 13,-8 13,-18 0,-10 -4,-19 -13,-19 -5,0 -8,5 -11,8 -1,1 -2,0 -1,-1 3,-3 8,-11 8,-18 0,-8 -5,-18 -13,-18 -8,0 -13,10 -13,18 0,7 5,15 8,18 1,1 0,2 -1,1 -3,-3 -6,-8 -11,-8 -9,0 -13,9 -13,19 0,10 4,18 13,18 5,0 10,-6 12,-10 1,-1 1,0 1,1 -1,8 -1,10 -2,16 -1,6 -4,17 -4,17 5,-2 15,-2 20,0 0,0 -3,-11 -4,-17 -1,-6 -1,-8 -2,-16 0,-1 0,-2 1,-1 z',
    D: 'm 180,737.36218 c 0,0 6,15 13,25 7,10 17,20 17,20 0,0 -10,10 -17,20 -7,10 -13,25 -13,25 0,0 -6,-15 -13,-25 -7,-10 -17,-20 -17,-20 0,0 10,-10 17,-20 7,-10 13,-25 13,-25 z',
    H: 'm 179,755.36218 c 0,-11.04569 -5.71573,-18 -14,-18 -8.28427,0 -15,8.95431 -15,20 0.0349,0.95559 0.0182,1.89119 0,2.8125 0,7.29848 2.67685,14.37684 5,21 2.38903,6.81096 5.83357,12.78067 9.0625,18.875 5.00123,9.4394 15.9375,27.3125 15.9375,27.3125 0,0 10.93627,-17.8731 15.9375,-27.3125 3.22893,-6.09433 6.67347,-12.06404 9.0625,-18.875 2.32315,-6.62316 5,-13.70152 5,-21 -0.0284,-0.9744 -0.0186,-1.91462 0,-2.8125 0,-11.04569 -6.71573,-20 -15,-20 -8.28427,0 -14,6.95431 -14,18 0,2 -2,2 -2,0 z'
  };
  // pip symbols occupy x 150..210, y 225..315 (after the -512.36 shift): 60 × 90
  const VB = '149 224 62 92';
  const PIP_AR = 92 / 62;

  function injectSprite() {
    if (document.getElementById('atelier-suits')) return;
    const syms = Object.entries(SUIT_PATHS).map(([s, d]) =>
      `<symbol id="suit-${s}" viewBox="${VB}"><path transform="translate(0 -512.36218)" d="${d}"/></symbol>`).join('') +
      '<pattern id="lat" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45 125 175)">' +
      '<path d="M0 0H20M0 0V20" stroke="#fff" stroke-opacity=".22" stroke-width="1.1" fill="none"/></pattern>';
    const holder = document.createElement('div');
    holder.innerHTML = `<svg id="atelier-suits" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${syms}</defs></svg>`;
    document.body.prepend(holder.firstChild);
  }

  const RED = { D: 1, H: 1 };
  const NAMES = { S: 'spades', C: 'clubs', D: 'diamonds', H: 'hearts' };
  const COURT = { J: 'Jack', Q: 'Queen', K: 'King' };
  const RANKNAME = { 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };

  function pip(s, cx, cy, w, flip) {
    const h = w * PIP_AR;
    const t = flip ? ` transform="rotate(180 ${cx} ${cy})"` : '';
    return `<use href="#suit-${s}" x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}"${t}/>`;
  }

  // column x / row y in a 250×350 face
  const L = 82, M = 125, R = 168;
  const T = 82, B = 268;
  const r4 = [T, T + (B - T) / 3, T + 2 * (B - T) / 3, B];
  const LAYOUT = {
    6: [[L, T], [R, T], [L, 175], [R, 175], [L, B], [R, B]],
    7: [[L, T], [R, T], [M, 129.5], [L, 175], [R, 175], [L, B], [R, B]],
    8: [[L, T], [R, T], [M, 129.5], [L, 175], [R, 175], [M, 220.5], [L, B], [R, B]],
    9: [[L, r4[0]], [R, r4[0]], [L, r4[1]], [R, r4[1]], [M, 175], [L, r4[2]], [R, r4[2]], [L, r4[3]], [R, r4[3]]],
    10: [[L, r4[0]], [R, r4[0]], [M, (r4[0] + r4[1]) / 2], [L, r4[1]], [R, r4[1]], [L, r4[2]], [R, r4[2]], [M, (r4[2] + r4[3]) / 2], [L, r4[3]], [R, r4[3]]]
  };

  function index(rank, s) {
    const ten = rank === '10';
    const fs = ten ? 42 : 48;
    const ls = ten ? -4 : 0;
    const one = `<text class="cf-rank" x="${ten ? 33 : 32}" y="60" font-size="${fs}" letter-spacing="${ls}" text-anchor="middle">${rank}</text>` +
      pip(s, 32, 89, 23, false);
    return `<g>${one}</g><g transform="rotate(180 125 175)">${one}</g>`;
  }

  function face(code) {
    const rank = code.slice(0, -1), s = code.slice(-1);
    let body = '';
    if (LAYOUT[rank]) {
      const pw = (rank === '9' || rank === '10') ? 30 : 33;
      body = LAYOUT[rank].map(([x, y]) => pip(s, x, y, pw, y > 176)).join('');
    } else if (rank === 'A') {
      body = `<circle cx="125" cy="175" r="62" fill="none" stroke="currentColor" stroke-opacity=".16" stroke-width="1.2"/>` + pip(s, 125, 175, 70, false);
    } else {
      const letter = rank;
      body =
        `<rect x="60" y="64" width="130" height="222" rx="12" class="cf-panel"/>` +
        `<rect x="66" y="70" width="118" height="210" rx="8" class="cf-panel2"/>` +
        `<text class="cf-courtname" x="125" y="98" text-anchor="middle">${COURT[rank].toUpperCase()}</text>` +
        `<text class="cf-court" x="125" y="212" text-anchor="middle" font-size="132">${letter}</text>` +
        pip(s, 125, 250, 18, false);
    }
    return `<svg class="cf" viewBox="0 0 250 350" aria-hidden="true">${index(rank, s)}${body}</svg>`;
  }

  // Gzhel-inspired back: porcelain-white margin, cobalt field, hairline lattice,
  // a fine guilloche rosette (banknote / stationery craft) and an italic Д monogram.
  let ROSETTE = '';
  for (let i = 0; i < 36; i++) {
    ROSETTE += `<ellipse cx="125" cy="175" rx="74" ry="26" transform="rotate(${i * 10} 125 175)"/>`;
  }
  function back() {
    return `<svg class="cb" viewBox="0 0 250 350" aria-hidden="true">
      <rect x="13" y="13" width="224" height="324" rx="11" class="cb-field"/>
      <rect x="13" y="13" width="224" height="324" rx="11" fill="url(#lat)"/>
      <rect x="22" y="22" width="206" height="306" rx="7" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.2"/>
      <circle cx="125" cy="175" r="82" class="cb-field"/>
      <g class="cb-rosette">${ROSETTE}</g>
      <circle cx="125" cy="175" r="30" class="cb-field" stroke="#fff" stroke-width="1.3"/>
      <text x="125" y="191" text-anchor="middle" class="cb-mono">Д</text>
    </svg>`;
  }

  function card(code, opts = {}) {
    const s = code.slice(-1), rank = code.slice(0, -1);
    const cls = ['card', RED[s] ? 'is-red' : 'is-black', opts.cls || ''].join(' ').trim();
    const label = `${RANKNAME[rank]} of ${NAMES[s]}`;
    const st = opts.style ? ` style="${opts.style}"` : '';
    const extra = opts.extra || '';
    return `<div class="${cls}" data-code="${code}" role="img" aria-label="${label}"${st}>${face(code)}${extra}</div>`;
  }

  function cardBack(opts = {}) {
    const st = opts.style ? ` style="${opts.style}"` : '';
    return `<div class="card card--back ${opts.cls || ''}"${st} aria-hidden="true">${back()}</div>`;
  }

  // Inline suit glyph for running text: <span class="suit suit--D">…</span>
  function glyph(s) {
    return `<svg class="glyph ${RED[s] ? 'is-red' : 'is-black'}" viewBox="0 0 62 92" aria-label="${NAMES[s]}"><use href="#suit-${s}" width="62" height="92"/></svg>`;
  }

  window.Atelier = { card, cardBack, glyph, injectSprite, isRed: (s) => !!RED[s] };

  // auto-hydrate [data-card], [data-back], [data-glyph]
  function hydrate(root = document) {
    injectSprite();
    root.querySelectorAll('[data-card]').forEach((el) => {
      el.outerHTML = card(el.dataset.card, { cls: el.className, style: el.getAttribute('style') || '', extra: el.innerHTML });
    });
    root.querySelectorAll('[data-back]').forEach((el) => {
      el.outerHTML = cardBack({ cls: el.className, style: el.getAttribute('style') || '' });
    });
    root.querySelectorAll('[data-glyph]').forEach((el) => {
      el.outerHTML = glyph(el.dataset.glyph);
    });
  }
  window.Atelier.hydrate = hydrate;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => hydrate());
  else hydrate();
})();
