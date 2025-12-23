<script>
(function () {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");

      // si update déjà en attente
      if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });

      // si une nouvelle version arrive
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            nw.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });

      // check update régulier
      setInterval(() => reg.update().catch(()=>{}), 30000);
    } catch(e) {}
  });

  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
})();
</script>
