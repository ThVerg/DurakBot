/* Fit a fixed design space to any viewport.
   Desktop design: 1440x900 (landscape), phone design: 390x844 (portrait).
   The stage keeps its scale but grows in width/height to fill the viewport,
   so edge-anchored HUD stays at the edges and the table stays centred. */
/* Absolute asset URL (used by JS-built cards/avatars; url()s set through
   custom properties would otherwise resolve against the stylesheet). */
window.asset = function (p) { return new URL("../assets/" + p, location.href).href; };
(function () {
  const stage = document.querySelector(".stage");
  const root = document.documentElement;
  function fit() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const phone = vw < 760 || vw / vh < 0.82;
    const BW = phone ? 390 : 1440, BH = phone ? 844 : 900;
    const s = Math.min(vw / BW, vh / BH);
    stage.style.width = vw / s + "px";
    stage.style.height = vh / s + "px";
    stage.style.transform = "scale(" + s + ")";
    const layout = phone ? "m" : "d";
    if (root.dataset.layout !== layout) {
      root.dataset.layout = layout;
      window.dispatchEvent(new CustomEvent("layoutchange", { detail: layout }));
    }
    root.style.setProperty("--s", s);
  }
  window.addEventListener("resize", fit);
  fit();
})();
