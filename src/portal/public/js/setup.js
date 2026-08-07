(function () {
    const form = document.getElementById("manual-setup");
    const formError = document.getElementById("form-error");

    setInterval(async () => {
        try {
            const res = await fetch("/api/status");
            const data = await res.json();
            if (data.state === "paired") location.reload();
            const wait = document.getElementById("wait");
            if (wait && data.cloud && data.cloud.lastError) {
                wait.textContent =
                    "Wacht op koppeling… (" + data.cloud.lastError + ")";
            }
        } catch (_) {
            /* ignore transient network errors */
        }
    }, 3000);

    if (!form) return;

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (formError) {
            formError.hidden = true;
            formError.textContent = "";
        }

        const data = Object.fromEntries(new FormData(form).entries());
        const button = form.querySelector('button[type="submit"]');
        if (button) button.disabled = true;

        try {
            const res = await fetch("/api/manual-setup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data),
            });
            const payload = await res.json();
            if (!res.ok || !payload.ok) {
                const message = (
                    payload.errors || [payload.error || "Setup mislukt"]
                ).join("; ");
                if (formError) {
                    formError.textContent = message;
                    formError.hidden = false;
                }
                return;
            }
            location.reload();
        } catch (err) {
            if (formError) {
                formError.textContent = err.message || "Netwerkfout";
                formError.hidden = false;
            }
        } finally {
            if (button) button.disabled = false;
        }
    });
})();
