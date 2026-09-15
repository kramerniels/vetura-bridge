(function () {
    setInterval(async () => {
        try {
            const res = await fetch("/api/status");
            const data = await res.json();
            if (data.state === "paired") location.reload();
            const cloudErrorEl = document.getElementById("cloud-error");
            if (!cloudErrorEl) return;
            const userError = data.cloud && data.cloud.userError;
            if (userError) {
                cloudErrorEl.textContent = userError;
                cloudErrorEl.hidden = false;
            } else {
                cloudErrorEl.textContent = "";
                cloudErrorEl.hidden = true;
            }
        } catch (_) {
            /* ignore transient network errors */
        }
    }, 3000);
})();
