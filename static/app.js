(() => {
    const state = {
        categories: [],
        shortcutMap: new Map(),
        currentImage: null,
        reservationToken: null,
    };

    const FALLBACK_SHORTCUTS = [
        "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
        "q", "w", "e", "r", "t", "y", "u", "i", "o", "p",
        "a", "s", "d", "f", "g", "h", "j", "k", "l",
        "z", "x", "c", "v", "b", "n", "m",
    ];

    const statusEl = document.getElementById("status");
    const imageEl = document.getElementById("current-image");
    const filenameEl = document.getElementById("filename");
    const categoriesContainer = document.getElementById("categories");
    const submitButton = document.getElementById("submit-button");
    const skipButton = document.getElementById("skip-button");
    const clearButton = document.getElementById("clear-button");
    const categoryTemplate = document.getElementById("category-template");
    const labelTemplate = document.getElementById("label-template");

    async function init() {
        try {
            await loadConfig();
            renderCategories();
            attachEventListeners();
            await fetchNextImage();
        } catch (error) {
            console.error(error);
            showStatus("Failed to initialise: " + error.message, "error");
        }
    }

    async function loadConfig() {
        const response = await fetch("/config");
        if (!response.ok) {
            throw new Error("Unable to load configuration from server.");
        }
        const data = await response.json();
        const categories = Array.isArray(data.categories) ? data.categories : [];
        state.categories = categories.map((category) => ({
            id: category.id,
            name: category.name || category.id || "Category",
            labels: Array.isArray(category.labels)
                ? category.labels.map((label, index) => ({
                      id: label.id || `${category.id}_${index}`,
                      name: label.name || label.id || "Label",
                      shortcut: label.shortcut || null,
                  }))
                : [],
        }));
        assignShortcuts(state.categories);
    }

    function assignShortcuts(categories) {
        const used = new Set();

        categories.forEach((category) => {
            category.labels.forEach((label) => {
                if (label.shortcut) {
                    const normalized = String(label.shortcut).trim().toLowerCase();
                    if (normalized && !used.has(normalized)) {
                        label._shortcut = normalized;
                        used.add(normalized);
                        return;
                    }
                }
                label._shortcut = null;
            });
        });

        const available = FALLBACK_SHORTCUTS.filter((key) => !used.has(key));

        categories.forEach((category) => {
            category.labels.forEach((label) => {
                if (!label._shortcut && available.length) {
                    const key = available.shift();
                    label._shortcut = key;
                    used.add(key);
                }
            });
        });
    }

    function renderCategories() {
        categoriesContainer.innerHTML = "";
        state.shortcutMap.clear();

        state.categories.forEach((category) => {
            const categoryNode = categoryTemplate.content
                .firstElementChild.cloneNode(true);
            const titleEl = categoryNode.querySelector(".category__title");
            const labelsContainer = categoryNode.querySelector(".category__labels");

            titleEl.textContent = category.name;

            category.labels.forEach((label) => {
                const labelNode = labelTemplate.content.firstElementChild.cloneNode(true);
                const checkbox = labelNode.querySelector("input[type='checkbox']");
                const nameEl = labelNode.querySelector(".label__name");
                const shortcutEl = labelNode.querySelector(".label__shortcut");

                const checkboxId = `${category.id}__${label.id}`;
                checkbox.id = checkboxId;
                checkbox.dataset.categoryId = category.id;
                checkbox.dataset.labelId = label.id;

                nameEl.textContent = label.name;

                if (label._shortcut) {
                    const key = label._shortcut.toLowerCase();
                    shortcutEl.textContent = key.length === 1 ? key.toUpperCase() : key;
                    registerShortcut(key, checkbox, labelNode);
                } else {
                    shortcutEl.textContent = "";
                    shortcutEl.classList.add("label__shortcut--hidden");
                }

                checkbox.addEventListener("change", () => {
                    labelNode.classList.toggle("label--active", checkbox.checked);
                });

                labelsContainer.appendChild(labelNode);
            });

            categoriesContainer.appendChild(categoryNode);
        });
    }

    function registerShortcut(shortcut, checkbox, labelNode) {
        const key = shortcut.toLowerCase();
        if (!state.shortcutMap.has(key)) {
            state.shortcutMap.set(key, []);
        }
        state.shortcutMap.get(key).push({ checkbox, labelNode });
    }

    function attachEventListeners() {
        submitButton.addEventListener("click", async () => {
            await submitLabels();
        });

        skipButton.addEventListener("click", async () => {
            await skipImage();
        });

        clearButton.addEventListener("click", () => {
            clearSelections();
        });

        document.addEventListener("keydown", async (event) => {
            const activeElement = document.activeElement;
            const tag = activeElement ? activeElement.tagName : "";

            if (tag === "INPUT" || tag === "TEXTAREA") {
                return;
            }

            const key = event.key.toLowerCase();

            if (event.key === "Enter") {
                event.preventDefault();
                await submitLabels();
                return;
            }

            if (key === "s") {
                event.preventDefault();
                await skipImage();
                return;
            }

            if (key === "c") {
                event.preventDefault();
                clearSelections();
                return;
            }

            if (state.shortcutMap.has(key)) {
                event.preventDefault();
                toggleShortcut(key);
            }
        });
    }

    function toggleShortcut(key) {
        const entries = state.shortcutMap.get(key);
        if (!entries) {
            return;
        }
        entries.forEach(({ checkbox, labelNode }) => {
            checkbox.checked = !checkbox.checked;
            labelNode.classList.toggle("label--active", checkbox.checked);
        });
    }

    function clearSelections() {
        categoriesContainer
            .querySelectorAll("input[type='checkbox']")
            .forEach((checkbox) => {
                checkbox.checked = false;
                const labelNode = checkbox.closest(".label");
                if (labelNode) {
                    labelNode.classList.remove("label--active");
                }
            });
    }

    async function fetchNextImage() {
        showStatus("Fetching next image…", "info");
        const response = await fetch("/api/image");
        if (!response.ok) {
            showStatus("Failed to fetch image from server.", "error");
            return;
        }
        const payload = await response.json();
        if (payload.status === "empty") {
            state.currentImage = null;
            state.reservationToken = null;
            imageEl.src = "";
            imageEl.alt = "No more images to label.";
            filenameEl.textContent = "";
            showStatus("All images are labelled. 🎉", "success");
            submitButton.disabled = true;
            skipButton.disabled = true;
            return;
        }

        submitButton.disabled = false;
        skipButton.disabled = false;

        const { image, reservation_token: reservationToken } = payload;
        state.currentImage = image;
        state.reservationToken = reservationToken;
        clearSelections();

        if (image && image.url) {
            imageEl.src = `${image.url}?t=${Date.now()}`;
            imageEl.alt = `Image ${image.filename}`;
            filenameEl.textContent = image.filename;
        }

        showStatus("Image reserved. Apply labels and submit.", "info");
    }

    async function submitLabels() {
        if (!state.currentImage || !state.reservationToken) {
            showStatus("No image reserved. Refresh to continue.", "error");
            return;
        }

        const labelsPayload = {};
        let totalSelected = 0;

        state.categories.forEach((category) => {
            const selected = Array.from(
                categoriesContainer.querySelectorAll(
                    `input[data-category-id="${category.id}"]:checked`
                )
            ).map((input) => input.dataset.labelId);

            if (selected.length) {
                labelsPayload[category.id] = selected;
                totalSelected += selected.length;
            }
        });

        if (totalSelected === 0) {
            showStatus("Select at least one label or press Skip.", "error");
            return;
        }

        const response = await fetch("/api/label", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                image_id: state.currentImage.id,
                reservation_token: state.reservationToken,
                labels: labelsPayload,
            }),
        });

        if (response.ok) {
            showStatus("Labels saved.", "success");
            await fetchNextImage();
            return;
        }

        const errorText = await response.text();
        showStatus(parseErrorMessage(errorText), "error");
        if (response.status === 409) {
            await fetchNextImage();
        }
    }

    async function skipImage() {
        if (!state.currentImage || !state.reservationToken) {
            showStatus("No image reserved. Refresh to continue.", "error");
            return;
        }

        const response = await fetch("/api/skip", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                image_id: state.currentImage.id,
                reservation_token: state.reservationToken,
            }),
        });

        if (response.ok) {
            showStatus("Image skipped.", "info");
            await fetchNextImage();
            return;
        }

        const errorText = await response.text();
        showStatus(parseErrorMessage(errorText), "error");
        if (response.status === 409) {
            await fetchNextImage();
        }
    }

    function showStatus(message, type = "info") {
        statusEl.textContent = message;
        statusEl.classList.remove("status--hidden", "status--info", "status--success", "status--error");
        const classMap = {
            info: "status--info",
            success: "status--success",
            error: "status--error",
        };
        statusEl.classList.add(classMap[type] || classMap.info);
    }

    function parseErrorMessage(text) {
        try {
            const parsed = JSON.parse(text);
            if (parsed && parsed.message) {
                return parsed.message;
            }
        } catch (err) {
            // Ignore parse errors and fall through.
        }
        return text || "Unexpected error from server.";
    }

    window.addEventListener("load", init);
})();
