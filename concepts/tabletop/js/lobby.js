/* Lobby: the preview table fills its seats as you change the player count. */
(function () {
  const $ = (s) => document.querySelector(s);
  const table = $("#ptable");
  const ROSTER = [
    ["Kostya", "kostya"], ["Zina", "zina"], ["Misha", "misha"], ["Sveta", "sveta"], ["Lev", "lev"],
  ];
  const TIER_NAMES = { novice: "Novice", intermediate: "Intermediate", expert: "Expert", grandmaster: "Grandmaster" };
  // seat positions on the rail, as fractions of the table's half width/height
  const SEATS = {
    2: [[0, -0.95]],
    3: [[-0.4, -0.95], [0.4, -0.95]],
    4: [[-0.97, 0], [0, -0.95], [0.97, 0]],
    5: [[-0.96, 0.12], [-0.4, -0.95], [0.4, -0.95], [0.96, 0.12]],
    6: [[-0.96, 0.12], [-0.55, -0.95], [0, -0.95], [0.55, -0.95], [0.96, 0.12]],
  };
  let n = 5, tier = "expert";

  function render(animate) {
    const w = table.offsetWidth / 2, h = table.offsetHeight / 2;
    table.querySelectorAll(".pseat").forEach((s) => s.remove());
    const mk = (x, y, name, img, you) => {
      const s = document.createElement("div");
      s.className = "pseat" + (you ? " you" : "") + (animate ? " enter" : "");
      s.style.setProperty("--x", x);
      s.style.setProperty("--y", y);
      s.innerHTML = '<div class="avatar" style="--img:url(' + window.asset("avatars/" + img + ".webp") + ')"></div><span class="nm">' + name + "</span>";
      table.appendChild(s);
      return s;
    };
    mk(0, h * 0.95, "You", "you", true);
    SEATS[n].forEach(([fx, fy], i) => {
      const s = mk(fx * w, fy * h, ROSTER[i][0], ROSTER[i][1], false);
      if (animate) s.style.animationDelay = i * 0.05 + "s";
    });
    const bots = n - 1;
    $("#sum").textContent = n + " players · " + TIER_NAMES[tier];
    $("#countNote").textContent = "You + " + bots + (bots === 1 ? " bot" : " bots");
    $("#dealSub").textContent = "You vs " + bots + " " + TIER_NAMES[tier] + (bots === 1 ? " bot" : " bots");
  }

  $("#count").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    document.querySelectorAll("#count button").forEach((x) => x.classList.toggle("on", x === b));
    n = +b.dataset.n; render(true);
  });
  $("#tiers").addEventListener("click", (e) => {
    const b = e.target.closest(".tier"); if (!b) return;
    document.querySelectorAll(".tier").forEach((x) => x.classList.toggle("on", x === b));
    tier = b.dataset.tier; render(false);
  });
  window.addEventListener("layoutchange", () => render(false));
  render(false);
})();
