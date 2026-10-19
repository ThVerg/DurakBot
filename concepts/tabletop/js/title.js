/* Title screen: props on the felt + EN/RU toggle. */
(function () {
  const $ = (s) => document.querySelector(s);
  const back = "url(" + window.asset("backs/navy.webp") + ")";
  const face = (c) => "url(" + window.asset("cards/" + c + ".webp") + ")";

  // squared deck on top of the trump
  const stack = $("#stack");
  for (let i = 0; i < 6; i++) {
    const c = document.createElement("div");
    c.className = "card back";
    c.style.setProperty("--face", back);
    const o = (5 - i) * 0.75;
    c.style.transform = "translate(-50%,-50%) translate(" + o + "px," + o + "px)";
    if (i < 5) c.style.boxShadow = "0 0 0 .5px rgba(60,50,30,.3), .5px 1px 0 #cfc5ae, 1px 1.5px 1.5px rgba(10,30,15,.25)";
    stack.appendChild(c);
  }

  // four aces fanned, ace of spades (with the DURAK ornament) on top
  const aces = $("#aces");
  ["AC", "AD", "AH", "AS"].forEach((code, i) => {
    const c = document.createElement("div");
    c.className = "card";
    c.style.setProperty("--face", face(code));
    const t = i - 1.5;
    c.style.transform = "translate(-50%,-50%) rotate(" + t * 11 + "deg)";
    aces.appendChild(c);
  });

  // language toggle (swaps every [data-en]/[data-ru] text)
  function setLang(l) {
    document.documentElement.lang = l;
    document.querySelectorAll("[data-" + l + "]").forEach((el) => { el.textContent = el.dataset[l]; });
    document.querySelectorAll(".lang button").forEach((b) => b.classList.toggle("on", b.dataset.lang === l));
  }
  document.querySelectorAll(".lang button").forEach((b) => b.addEventListener("click", () => setLang(b.dataset.lang)));
  const q = new URLSearchParams(location.search);
  if (q.get("lang") === "ru") setLang("ru");
})();
