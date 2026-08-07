(function () {
    const statusEl = document.getElementById("worker-status");
    const detailEl = document.getElementById("worker-detail");
    if (!statusEl) return;

    function render(worker) {
        if (!worker || !worker.desired) {
            statusEl.className = "status warn";
            statusEl.textContent = "Worker gestopt";
            detailEl.textContent = "Worker wordt niet gestart.";
            return;
        }

        if (worker.running) {
            statusEl.className = "status ok";
            statusEl.textContent = "Worker draait";
            const parts = [];
            if (worker.pid != null) parts.push("PID " + worker.pid);
            if (worker.restarts) parts.push(worker.restarts + " herstarts");
            if (worker.startedAt) parts.push("sinds " + worker.startedAt);
            detailEl.textContent = parts.join(" · ");
            return;
        }

        if (worker.lastError) {
            statusEl.className = "status warn";
            statusEl.textContent = "Worker fout";
            const parts = [worker.lastError];
            if (worker.restarts) parts.push(worker.restarts + " herstarts");
            detailEl.textContent = parts.join(" · ");
            return;
        }

        statusEl.className = "status warn";
        statusEl.textContent = "Worker start…";
        detailEl.textContent = worker.restarts
            ? worker.restarts + " herstarts"
            : "";
    }

    async function poll() {
        try {
            const res = await fetch("/api/status");
            const data = await res.json();
            render(data.worker);
        } catch (_) {
            /* ignore transient network errors */
        }
    }

    poll();
    setInterval(poll, 3000);
})();
