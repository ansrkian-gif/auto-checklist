(function () {
  var pin = window.DASHBOARD_PIN || "";
  if (!pin) return;
  if (sessionStorage.getItem("shelter-pin") === pin) return;
  var wrap = document.createElement("div");
  wrap.id = "pinGate";
  wrap.style.cssText = "position:fixed;inset:0;z-index:99999;background:#12323c;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#fff;font-family:Segoe UI,system-ui,sans-serif;padding:max(1rem,env(safe-area-inset-top)) 1rem max(1rem,env(safe-area-inset-bottom))";
  wrap.innerHTML = '<div style="font-weight:700;font-size:1.4rem">Shelter Size</div><input id="pinIn" type="password" inputmode="numeric" maxlength="8" placeholder="PIN" autocomplete="off" style="font-size:1.25rem;padding:14px 16px;border-radius:14px;border:0;width:min(220px,80vw);text-align:center"><button id="pinGo" type="button" style="padding:14px 28px;border:0;border-radius:14px;font-weight:700;background:#0b6e4f;color:#fff">Open</button>';
  document.documentElement.appendChild(wrap);
  function go() {
    var entered = document.getElementById("pinIn").value;
    if (entered === pin) {
      sessionStorage.setItem("shelter-pin", entered);
      wrap.remove();
    } else {
      document.getElementById("pinIn").style.outline = "2px solid #fca5a5";
    }
  }
  document.getElementById("pinGo").onclick = go;
  document.getElementById("pinIn").addEventListener("keydown", function (event) {
    if (event.key === "Enter") go();
  });
})();
