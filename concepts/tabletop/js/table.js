/* Concept D "Tabletop" — static mid-game scene with a few live interactions.
   State (fixed for comparison across concepts):
   5 players · trump ♥ (9♥ under talon, 11 left) · bito 12
   Kostya attacks (4) · Zina throws (6) · Misha (5, shows Q♣) · Sveta out 1st
   Table: 8♠/J♠, 8♦ open · You defend: 6♣ 9♣ Q♦ K♦ 7♥ A♠ 10♥ */
(function () {
  const A = "../assets/";
  let BACK = "navy";
  let DECK = "cards";
  const HAND = [
    { c: "6C", legal: false },
    { c: "9C", legal: false },
    { c: "QD", legal: true, why: "Q♦ beats 8♦" },
    { c: "KD", legal: true, why: "K♦ beats 8♦" },
    { c: "7H", legal: true, why: "7♥ trump beats 8♦" },
    { c: "AS", legal: false },
    { c: "10H", legal: true, why: "10♥ trump beats 8♦" },
  ];

  const LAYOUT = {
    d: {
      seats: { kostya: [-590, 30], zina: [-286, -292], misha: [286, -292], sveta: [590, 30] },
      // fan: offset from the avatar centre (dx,dy), spread angle, overall tilt
      fans: { kostya: [70, -22, 8, 8], zina: [74, 2, 8, 6], misha: [-74, 2, 8, -6] },
      fanW: 46,
      talon: [-330, -52], discard: [370, -56],
      pair1: [-92, -44], pair2: [104, -44],
      status: [0, 176],
      hand: { gap: 84, rot: 3.2, arc: 2.6, base: 10 },
      pileSpread: 26,
    },
    m: {
      seats: { kostya: [-150, -86], zina: [-92, -222], misha: [92, -222], sveta: [150, -86] },
      fans: { kostya: [10, -32, 10, -10], zina: [42, -2, 9, 6], misha: [-42, -2, 9, -6] },
      fanW: 26,
      talon: [-62, 128], discard: [78, 126],
      pair1: [-52, -4], pair2: [48, -4],
      status: [0, 246],
      hand: { gap: 42, rot: 3.6, arc: 1.2, base: 4 },
      pileSpread: 14,
    },
  };

  const $ = (s) => document.querySelector(s);
  const root = document.documentElement;
  const stage = $("#stage");

  function face(code) { return "url(" + window.asset(DECK + "/" + code + ".webp") + ")"; }
  function back() { return "url(" + window.asset("backs/" + BACK + ".webp") + ")"; }
  function setXY(el, x, y, r) {
    el.style.setProperty("--x", x);
    el.style.setProperty("--y", y);
    if (r != null) el.style.setProperty("--r", r);
  }

  // deterministic pseudo random
  let seed = 11;
  function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

  /* ------------------------------------------------ build static pieces */
  function buildDeck() {
    const deck = $("#deck");
    deck.innerHTML = "";
    // 11 cards: show the stack edge with a few offset layers
    for (let i = 0; i < 5; i++) {
      const c = document.createElement("div");
      c.className = "card back";
      c.style.setProperty("--face", back());
      const o = (4 - i) * 0.7;
      c.style.transform = "translate(-50%,-50%) translate(" + o + "px," + o + "px) rotate(3deg)";
      if (i < 4) c.style.boxShadow = "0 0 0 .5px rgba(60,50,30,.3), .5px 1px 0 #cfc5ae, 1px 1.5px 1.5px rgba(10,30,15,.25)";
      deck.appendChild(c);
    }
    const dot = document.createElement("div");
    dot.className = "count-dot";
    dot.textContent = "11";
    deck.appendChild(dot);
  }

  function buildPile(spread) {
    const pile = $("#pile");
    pile.innerHTML = "";
    seed = 23;
    const n = 9; // visible layers of the 12 discarded cards
    for (let i = 0; i < n; i++) {
      const c = document.createElement("div");
      c.className = "card back";
      c.style.setProperty("--face", back());
      const x = (rnd() - 0.5) * spread, y = (rnd() - 0.5) * spread * 0.9;
      const r = (rnd() - 0.5) * 70 + (i % 2 ? 90 : 0);
      c.style.transform = "translate(-50%,-50%) translate(" + x + "px," + y + "px) rotate(" + r + "deg)";
      if (i < n - 2) c.style.boxShadow = "0 0 0 .5px rgba(60,50,30,.3), .5px 1px 0 #cfc5ae, 1px 2px 3px rgba(10,30,15,.3)";
      pile.appendChild(c);
    }
  }

  function buildFans(L) {
    document.querySelectorAll(".fan").forEach((fan) => {
      const seat = fan.closest(".seat").dataset.seat;
      const [fx, fy, spread, tilt] = L.fans[seat];
      const n = +fan.dataset.n;
      const known = fan.dataset.known;
      const kIdx = known ? (fx < 0 ? 1 : n - 2) : -1;
      fan.style.transform = "translate(" + fx + "px," + fy + "px) rotate(" + tilt + "deg)";
      fan.innerHTML = "";
      for (let i = 0; i < n; i++) {
        const c = document.createElement("div");
        const isKnown = i === kIdx;
        c.className = "card " + (isKnown ? "known" : "back");
        c.style.setProperty("--face", isKnown ? face(known) : back());
        const t = i - (n - 1) / 2;
        c.style.transform = "translate(-50%,-50%) translate(" + t * L.fanW * 0.30 + "px," + Math.abs(t) * 1.4 + "px) rotate(" + t * spread + "deg)" + (isKnown ? " translateY(-7px)" : "");
        fan.appendChild(c);
      }
    });
  }

  function buildHand(cfg) {
    const hand = $("#hand");
    hand.innerHTML = "";
    const n = HAND.length;
    HAND.forEach((h, i) => {
      const t = i - (n - 1) / 2;
      const c = document.createElement("div");
      c.className = "card " + (h.legal ? "legal" : "dim");
      c.dataset.code = h.c;
      c.style.setProperty("--face", face(h.c));
      c.style.setProperty("--hx", t * cfg.gap + "px");
      c.style.setProperty("--hy", cfg.base + t * t * cfg.arc + "px");
      c.style.setProperty("--hr", t * cfg.rot + "deg");
      c.style.zIndex = 10 + i;
      if (h.legal) {
        c.innerHTML = '<span class="why">' + h.why + '</span><span class="hint-badge">HINT</span>';
        c.tabIndex = 0;
      }
      hand.appendChild(c);
    });
  }

  function place() {
    const L = LAYOUT[root.dataset.layout || "d"];
    Object.entries(L.seats).forEach(([k, [x, y]]) => setXY($("#seat-" + k), x, y));
    setXY($("#talon"), L.talon[0], L.talon[1]);
    setXY($("#discard"), L.discard[0], L.discard[1]);
    setXY($("#pair1"), L.pair1[0], L.pair1[1]);
    setXY($("#pair2"), L.pair2[0], L.pair2[1]);
    setXY($("#status"), L.status[0], L.status[1]);
    buildFans(L);
    buildPile(L.pileSpread);
    buildHand(L.hand);
    applyQuery();
  }

  function rebuildBacks() {
    document.querySelectorAll(".card.back").forEach((c) => c.style.setProperty("--face", back()));
  }

  /* ------------------------------------------------ interactions */
  function toggle(cls, on) { stage.classList.toggle(cls, on); }
  $("#logBtn").addEventListener("click", () => { toggle("show-settings", false); toggle("show-log", !stage.classList.contains("show-log")); });
  $("#drawerClose").addEventListener("click", () => toggle("show-log", false));
  $("#setBtn").addEventListener("click", (e) => { e.stopPropagation(); toggle("show-log", false); toggle("show-settings", !stage.classList.contains("show-settings")); });
  $("#settings").addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => toggle("show-settings", false));
  $("#soundBtn").addEventListener("click", (e) => {
    const b = e.currentTarget; b.classList.toggle("muted");
    b.innerHTML = window.icon(b.classList.contains("muted") ? "close" : "sound");
  });
  $("#backPick").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    document.querySelectorAll("#backPick button").forEach((x) => x.classList.toggle("on", x === b));
    BACK = b.dataset.back; rebuildBacks();
  });
  $("#feltPick").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    document.querySelectorAll("#feltPick button").forEach((x) => x.classList.toggle("on", x === b));
    $("#table").classList.toggle("royal", b.dataset.felt === "royal");
  });
  $("#fourColour").addEventListener("change", (e) => {
    DECK = e.target.checked ? "cards4" : "cards";
    document.querySelectorAll(".hand .card").forEach((c) => c.style.setProperty("--face", face(c.dataset.code)));
  });

  function showHint(on) {
    toggle("show-hint", on);
    document.querySelectorAll(".hand .card").forEach((c) => c.classList.toggle("hinted", on && c.dataset.code === "QD"));
  }
  $("#hintBtn").addEventListener("click", () => showHint(!stage.classList.contains("show-hint")));

  const take = $("#takeBtn");
  take.addEventListener("click", () => {
    take.classList.add("is-pressed");
    setTimeout(() => take.classList.remove("is-pressed"), 160);
  });

  // play a legal card onto the open 8♦ (FLIP animation), click the table to reset
  $("#hand").addEventListener("click", (e) => {
    const c = e.target.closest(".card.legal"); if (!c) return;
    showHint(false);
    const slot = $("#slot");
    const from = c.getBoundingClientRect();
    const to = slot.getBoundingClientRect();
    const s = parseFloat(getComputedStyle(root).getPropertyValue("--s")) || 1;
    const card = document.createElement("div");
    card.className = "card def played";
    card.style.setProperty("--face", face(c.dataset.code));
    $("#pair2").appendChild(card);
    slot.style.display = "none";
    c.style.visibility = "hidden";
    const end = card.getBoundingClientRect();
    const dx = (from.left + from.width / 2 - (end.left + end.width / 2)) / s;
    const dy = (from.top + from.height / 2 - (end.top + end.height / 2)) / s;
    card.animate([
      { transform: "translate(-50%,-50%) translate(" + dx + "px," + dy + "px) scale(1.25) rotate(-6deg)" },
      { transform: getComputedStyle(card).transform },
    ], { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
    $("#targetCard").parentElement.classList.remove("target");
    document.querySelectorAll(".hand .card").forEach((x) => { x.classList.remove("legal"); x.classList.add("dim"); });
    $(".st-kicker").textContent = "Defended";
    $(".st-main").innerHTML = "Waiting for throw-ins…";
    take.disabled = true; take.style.opacity = .5;
    $("#stage").classList.add("defended");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "h" || e.key === "H") showHint(!stage.classList.contains("show-hint"));
    if (e.key === "l" || e.key === "L") toggle("show-log", !stage.classList.contains("show-log"));
    if (e.key === "t" || e.key === "T") take.click();
    if (e.key === "Escape") { toggle("show-log", false); toggle("show-settings", false); showHint(false); }
    if (e.key === "r" || e.key === "R") location.reload();
  });

  /* ------------------------------------------------ ?query states for screenshots */
  function applyQuery() {
    const q = new URLSearchParams(location.search);
    if (q.get("hover")) document.querySelectorAll(".hand .card").forEach((c) => c.classList.toggle("is-hover", c.dataset.code === q.get("hover")));
    if (q.has("hint")) showHint(true);
    if (q.has("log")) toggle("show-log", true);
    if (q.has("settings")) toggle("show-settings", true);
    if (q.has("press")) take.classList.add("is-pressed");
    if (q.get("felt") === "royal") {
      $("#table").classList.add("royal");
      document.querySelectorAll("#feltPick button").forEach((x) => x.classList.toggle("on", x.dataset.felt === "royal"));
    }
  }

  buildDeck();
  place();
  window.addEventListener("layoutchange", place);
})();
