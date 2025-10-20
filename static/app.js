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
        "a", "d", "f", "g", "h", "j", "k", "l",
        "z", "x", "v", "b", "n", "m",
    ];
    const RESERVED_SHORTCUTS = new Set(["x", "c"]);

    const statusEl = document.getElementById("status");
    const imageFrameEl = document.getElementById("image-frame");
    const imagePlaceholderEl = document.getElementById("image-placeholder");
    const imageEl = document.getElementById("current-image");
    const filenameEl = document.getElementById("filename");
    const categoriesContainer = document.getElementById("categories");
    const submitButton = document.getElementById("submit-button");
    const skipButton = document.getElementById("skip-button");
    const clearButton = document.getElementById("clear-button");
    const categoryTemplate = document.getElementById("category-template");
    const labelTemplate = document.getElementById("label-template");

    const NON_EDITABLE_INPUT_TYPES = new Set([
        "button",
        "checkbox",
        "color",
        "file",
        "radio",
        "range",
        "reset",
        "submit",
    ]);

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
                    if (normalized) {
                        if (RESERVED_SHORTCUTS.has(normalized)) {
                            console.warn(`Shortcut "${label.shortcut}" is reserved. It will be reassigned automatically.`);
                        } else if (!used.has(normalized)) {
                            label._shortcut = normalized;
                            used.add(normalized);
                            return;
                        }
                    }
                }
                label._shortcut = null;
            });
        });

        const available = FALLBACK_SHORTCUTS.filter(
            (key) => !used.has(key) && !RESERVED_SHORTCUTS.has(key)
        );

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
                    const shortcutKey = label._shortcut;
                    const display = shortcutKey.length === 1 ? shortcutKey.toUpperCase() : shortcutKey;
                    shortcutEl.textContent = display;
                    registerShortcut(shortcutKey, checkbox, labelNode);
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
        if (!shortcut) {
            return;
        }
        const normalized = shortcut.toLowerCase();
        const identifiers = new Set([normalized]);

        if (normalized.length === 1) {
            if (/[a-z]/.test(normalized)) {
                identifiers.add(`key${normalized}`);
            }
            if (/[0-9]/.test(normalized)) {
                identifiers.add(`digit${normalized}`);
            }
        }

        identifiers.forEach((identifier) => {
            if (!state.shortcutMap.has(identifier)) {
                state.shortcutMap.set(identifier, []);
            }
            state.shortcutMap.get(identifier).push({ checkbox, labelNode });
        });
    }

    function isEditableTarget(element) {
        if (!element) {
            return false;
        }
        if (element.closest("[contenteditable='true']")) {
            return true;
        }
        const tag = element.tagName;
        if (tag === "TEXTAREA") {
            return true;
        }
        if (tag === "INPUT") {
            const type = (element.getAttribute("type") || "text").toLowerCase();
            return !NON_EDITABLE_INPUT_TYPES.has(type);
        }
        return false;
    }

    function setActionButtonsDisabled(disabled) {
        submitButton.disabled = disabled;
        skipButton.disabled = disabled;
        clearButton.disabled = disabled;
    }

    function setImagePlaceholder(message) {
        imageFrameEl.classList.add("image-panel__frame--empty");
        imagePlaceholderEl.textContent = message;
        imageEl.src = "";
        imageEl.alt = message || "";
        filenameEl.textContent = "";
        state.currentImage = null;
        state.reservationToken = null;
    }

    function showImage(image) {
        if (!image) {
            setImagePlaceholder("No image available.");
            return;
        }
        imageFrameEl.classList.remove("image-panel__frame--empty");
        imagePlaceholderEl.textContent = "";
        imageEl.src = `${image.url}?t=${Date.now()}`;
        imageEl.alt = `Image ${image.filename}`;
        filenameEl.textContent = image.filename;
    }

    function stashCurrentImageState() {
        return {
            src: imageEl.getAttribute("src"),
            alt: imageEl.getAttribute("alt"),
            filename: filenameEl.textContent,
            frameEmpty: imageFrameEl.classList.contains("image-panel__frame--empty"),
            placeholder: imagePlaceholderEl.textContent,
            image: state.currentImage,
            reservationToken: state.reservationToken,
        };
    }

    function restoreImageState(snapshot) {
        if (!snapshot) {
            return;
        }
        if (snapshot.frameEmpty) {
            imageFrameEl.classList.add("image-panel__frame--empty");
            imagePlaceholderEl.textContent = snapshot.placeholder || "";
            imageEl.src = "";
            imageEl.alt = snapshot.alt || "";
        } else {
            imageFrameEl.classList.remove("image-panel__frame--empty");
            imagePlaceholderEl.textContent = "";
            imageEl.src = snapshot.src || "";
            imageEl.alt = snapshot.alt || "";
        }
        filenameEl.textContent = snapshot.filename || "";
        state.currentImage = snapshot.image || null;
        state.reservationToken = snapshot.reservationToken || null;
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
            if (isEditableTarget(activeElement)) {
                return;
            }

            const rawKey = event.key || "";
            const key = rawKey.toLowerCase();
            const code = (event.code || "").toLowerCase();

            if (key === "enter") {
                event.preventDefault();
                await submitLabels();
                return;
            }

            if (key === "x" || code === "keyx") {
                event.preventDefault();
                await skipImage();
                return;
            }

            if (key === "c" || code === "keyc") {
                event.preventDefault();
                clearSelections();
                return;
            }

            if (toggleShortcut(key)) {
                event.preventDefault();
                return;
            }

            if (code && toggleShortcut(code)) {
                event.preventDefault();
            }
        });
    }

    function toggleShortcut(identifier) {
        if (!state.currentImage) {
            return false;
        }
        const entries = state.shortcutMap.get(identifier);
        if (!entries) {
            return false;
        }
        entries.forEach(({ checkbox, labelNode }) => {
            checkbox.checked = !checkbox.checked;
            labelNode.classList.toggle("label--active", checkbox.checked);
        });
        return true;
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
        setActionButtonsDisabled(true);
        setImagePlaceholder("Loading next image…");
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
            setImagePlaceholder("All images are labelled. 🎉");
            showStatus("All images are labelled. 🎉", "success");
            setActionButtonsDisabled(true);
            return;
        }

        const { image, reservation_token: reservationToken } = payload;
        state.currentImage = image;
        state.reservationToken = reservationToken;
        clearSelections();

        showImage(image);
        setActionButtonsDisabled(false);

        showStatus("Image reserved. Apply labels and submit.", "info");
    }

    async function submitLabels() {
        if (!state.currentImage || !state.reservationToken) {
            showStatus("No image reserved. Refresh to continue.", "error");
            return;
        }

        setActionButtonsDisabled(true);

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
            setActionButtonsDisabled(false);
            return;
        }

        const snapshot = stashCurrentImageState();
        const imageId = state.currentImage.id;
        const reservationToken = state.reservationToken;
        setImagePlaceholder("Saving labels…");
        showStatus("Saving labels…", "info");

        const response = await fetch("/api/label", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                image_id: imageId,
                reservation_token: reservationToken,
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
        restoreImageState(snapshot);
        setActionButtonsDisabled(false);
        if (response.status === 409) {
            await fetchNextImage();
        }
    }

    async function skipImage() {
        if (!state.currentImage || !state.reservationToken) {
            showStatus("No image reserved. Refresh to continue.", "error");
            return;
        }

        const snapshot = stashCurrentImageState();
        const imageId = state.currentImage.id;
        const reservationToken = state.reservationToken;
        setActionButtonsDisabled(true);
        setImagePlaceholder("Skipping image…");
        showStatus("Skipping image…", "info");

        const response = await fetch("/api/skip", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                image_id: imageId,
                reservation_token: reservationToken,
            }),
        });

        if (response.ok) {
            clearSelections();
            showStatus("Image skipped.", "info");
            await fetchNextImage();
            return;
        }

        const errorText = await response.text();
        showStatus(parseErrorMessage(errorText), "error");
        if (response.status === 409) {
            await fetchNextImage();
            return;
        }
        restoreImageState(snapshot);
        setActionButtonsDisabled(false);
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
