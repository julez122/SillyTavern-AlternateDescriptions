import { excludeLorebookAlternatesFromScan, readLorebookAlternates, writeLorebookAlternates } from './lorebook-content-storage.js';

let initialized = false;
let managerOpen = false;
let activeManager = null;

function getContext() {
    return SillyTavern.getContext();
}

function reportError(error) {
    console.error('[Alternate Lorebook Content]', error);
    toastr.error(error.message || 'Could not save alternate lorebook content.');
}

function getTarget(textarea) {
    const element = textarea.closest('.world_entry[uid]');
    const book = element?.querySelector('.move_entry_button')?.getAttribute('data-current-world');
    const uid = element?.getAttribute('uid');
    if (!book || !/^\d+$/.test(uid ?? '')) throw new Error('Could not identify this lorebook entry.');
    return { book, uid, element, textarea };
}

function isCurrentTarget(target) {
    return target.textarea.isConnected
        && target.element.querySelector('textarea[name="content"]') === target.textarea
        && target.element.getAttribute('uid') === target.uid
        && target.element.querySelector('.move_entry_button')?.getAttribute('data-current-world') === target.book;
}

// The native editor closes over its own data object, whereas loadWorldInfo returns a clone.
// Let an unchanged native input save expose that actual object through WORLDINFO_UPDATED.
// Every later library save then shares the editor's object instead of overwriting it with a clone.
function bindEditorData(target) {
    const { eventSource, eventTypes } = getContext();
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timeout);
            eventSource.removeListener(eventTypes.WORLDINFO_UPDATED, onUpdated);
        };
        const onUpdated = (name, data) => {
            if (name !== target.book || data.entries?.[target.uid]?.content !== target.textarea.value) return;
            cleanup();
            if (isCurrentTarget(target)) resolve(data);
            else reject(new Error('The lorebook editor changed. Reopen Alt. Content for the entry you want to edit.'));
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('The lorebook editor did not finish saving. Please try Alt. Content again.'));
        }, 10000);
        eventSource.on(eventTypes.WORLDINFO_UPDATED, onUpdated);
        target.textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

function makeButton(className, icon, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button menu_button_icon ${className}`;
    const symbol = document.createElement('i');
    symbol.className = `fa-solid ${icon} ${className}-icon`;
    symbol.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = `${className}-text`;
    text.textContent = label;
    button.append(symbol, text);
    return button;
}

function createManager(target, data) {
    const context = getContext();
    const entry = data.entries[target.uid];
    const versions = readLorebookAlternates(entry);
    const originalSaved = versions.length === 0 && Boolean(entry.content.trim());
    if (originalSaved) versions.push({ title: 'Content #1', content: entry.content });

    const container = document.createElement('div');
    container.className = 'alt-lorebook-popup flex-container flexFlowColumn';
    container.innerHTML = `
        <div class="alt-lorebook-heading-row flex-container justifySpaceBetween alignItemsCenter">
            <h3 class="alt-lorebook-heading margin0">Alternate Content for <span class="alt-lorebook-entry-name"></span></h3>
        </div>
        <hr class="alt-lorebook-heading-divider">
        <div class="alt-lorebook-instructions justifyLeft">
            <small class="alt-lorebook-description">Save different versions of this lorebook entry's content. Click "Use" to switch the active content in the editor. Other entry settings stay unchanged.</small>
            <small class="alt-lorebook-original-notice" hidden>Your original lorebook content has been automatically saved!</small>
        </div>
        <hr class="alt-lorebook-instructions-divider">
        <div class="alt-lorebook-status" hidden>
            <i class="alt-lorebook-status-icon fa-solid" aria-hidden="true"></i>
            <span class="alt-lorebook-status-text"></span>
        </div>
        <div class="alt-lorebook-list"></div>`;
    container.querySelector('.alt-lorebook-entry-name').textContent = `${entry.comment || `Entry ${target.uid}`} (${target.book})`;
    container.querySelector('.alt-lorebook-original-notice').hidden = !originalSaved;
    const addButton = makeButton('alt-lorebook-add-button', 'fa-plus', 'Add New');
    container.querySelector('.alt-lorebook-heading-row').append(addButton);
    const status = container.querySelector('.alt-lorebook-status');
    const statusText = container.querySelector('.alt-lorebook-status-text');
    const statusIcon = container.querySelector('.alt-lorebook-status-icon');
    const saveCurrent = makeButton('alt-lorebook-save-current-button', 'fa-save', 'Save Current');
    status.append(saveCurrent);
    const list = container.querySelector('.alt-lorebook-list');
    const tokenTimers = new Map();
    let saveTimer;
    let saveQueue = Promise.resolve();
    let dirty = originalSaved;
    let disposed = false;
    let actionPending = false;

    function verifyTarget() {
        if (isCurrentTarget(target) && data.entries[target.uid] === entry) return true;
        clearTimeout(saveTimer);
        status.hidden = false;
        status.dataset.state = 'modified';
        statusText.textContent = 'The lorebook editor changed. Close this manager and reopen Alt. Content for the entry you want to edit.';
        saveCurrent.hidden = true;
        container.querySelectorAll('button, input, textarea').forEach(control => { control.disabled = true; });
        return false;
    }

    function persist() {
        clearTimeout(saveTimer);
        // Serialize writes and flush pending native debounces with the same live editor data.
        const pending = saveQueue.catch(() => {}).then(async () => {
            if (!dirty || !verifyTarget()) return;
            writeLorebookAlternates(entry, versions);
            dirty = false;
            try {
                await context.saveWorldInfo(target.book, data, true);
            } catch (error) {
                dirty = true;
                throw error;
            }
        });
        saveQueue = pending;
        return pending;
    }

    function changed({ immediate = false } = {}) {
        if (!verifyTarget()) return;
        // Update the shared object now, so native saves cannot drop pending alternate edits.
        writeLorebookAlternates(entry, versions);
        dirty = true;
        clearTimeout(saveTimer);
        if (immediate) void persist().catch(reportError);
        else saveTimer = setTimeout(() => { void persist().catch(reportError); }, 500);
        updateStatus();
    }

    function updateStatus() {
        if (!verifyTarget()) return;
        const current = target.textarea.value;
        const matches = versions.some(version => version.content.trim() === current.trim());
        status.hidden = !current.trim() && !matches;
        status.dataset.state = matches ? 'active' : 'modified';
        statusText.textContent = matches
            ? 'Current lorebook content matches a saved version.'
            : "Current lorebook content has been modified and doesn't match any saved version.";
        statusIcon.className = `alt-lorebook-status-icon fa-solid ${matches ? 'fa-check-circle' : 'fa-exclamation-triangle'}`;
        saveCurrent.hidden = matches || !current.trim();
        list.querySelectorAll('.alt-lorebook-version').forEach((item, index) => {
            // A deletion updates saved state immediately before the list is rebuilt.
            const version = versions[index];
            if (!version) return;
            const active = version.content.trim() === current.trim();
            item.classList.toggle('alt-lorebook-version-active', active);
            const use = item.querySelector('.alt-lorebook-use-button');
            use.classList.toggle('alt-lorebook-use-active', active);
            use.title = active ? 'Already active' : 'Use this saved lorebook content';
            item.querySelector('.alt-lorebook-active-indicator').hidden = !active;
        });
    }

    async function countTokens(version, output) {
        const content = version.content;
        try {
            const count = await context.getTokenCountAsync(content);
            if (!disposed && container.contains(output) && version.content === content) output.textContent = String(count);
        } catch {
            if (!disposed && container.contains(output) && version.content === content) output.textContent = 'unavailable';
        }
    }

    function renderList() {
        for (const timer of tokenTimers.values()) clearTimeout(timer);
        tokenTimers.clear();
        list.replaceChildren();
        if (!versions.length) {
            const empty = document.createElement('strong');
            empty.className = 'alt-lorebook-empty';
            empty.textContent = 'Click Add New to save the current lorebook content.';
            list.append(empty);
        }
        versions.forEach(version => {
            const item = document.createElement('div');
            item.className = 'alt-lorebook-version';
            item.innerHTML = `
                <div class="alt-lorebook-version-header flex-container justifySpaceBetween">
                    <div class="alt-lorebook-title-group flex-container">
                        <input class="alt-lorebook-version-title text_pole textarea_compact margin0" placeholder="Content title" aria-label="Alternate content title" maxlength="50">
                        <i class="alt-lorebook-active-indicator fa-solid fa-check-circle" title="Active content" aria-label="Active content" hidden></i>
                    </div>
                    <div class="alt-lorebook-version-actions flex-container"></div>
                </div>
                <textarea class="alt-lorebook-version-content text_pole textarea_compact" rows="8" placeholder="Lorebook entry content..." aria-label="Alternate lorebook entry content"></textarea>
                <div class="alt-lorebook-token-counter extension_token_counter"><span class="alt-lorebook-token-label">Tokens:</span> <span class="alt-lorebook-token-value">calculating...</span></div>`;
            const title = item.querySelector('.alt-lorebook-version-title');
            const content = item.querySelector('.alt-lorebook-version-content');
            const tokenValue = item.querySelector('.alt-lorebook-token-value');
            title.value = version.title;
            content.value = version.content;
            title.addEventListener('input', () => {
                if (!verifyTarget()) return;
                version.title = title.value;
                changed();
            });
            content.addEventListener('input', () => {
                if (!verifyTarget()) return;
                version.content = content.value;
                changed();
                clearTimeout(tokenTimers.get(version));
                tokenTimers.set(version, setTimeout(() => { void countTokens(version, tokenValue); }, 500));
            });
            const use = makeButton('alt-lorebook-use-button', 'fa-arrow-up', 'Use');
            use.addEventListener('click', async () => {
                if (actionPending) return;
                actionPending = true;
                try {
                    if (!verifyTarget()) return;
                    const current = target.textarea.value;
                    if (current.trim() && !versions.some(value => value.content.trim() === current.trim())) {
                        const confirmed = await context.Popup.show.confirm('Switch lorebook content?', 'Your current lorebook content has unsaved changes. Switch to this saved version anyway?');
                        if (!confirmed || !verifyTarget() || !versions.includes(version)) return;
                    }
                    // Keep macros literal in both saved versions and the native editor.
                    // The core expands them later on its request-local lorebook scan copies.
                    target.textarea.value = version.content;
                    target.textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    dirty = true;
                    updateStatus();
                    await persist();
                } catch (error) { reportError(error); }
                finally { actionPending = false; }
            });
            const remove = makeButton('alt-lorebook-delete-button', 'fa-trash', 'Delete');
            remove.addEventListener('click', async () => {
                if (actionPending) return;
                actionPending = true;
                try {
                    if (!verifyTarget()) return;
                    const warning = document.createElement('span');
                    warning.className = 'alt-lorebook-delete-warning';
                    warning.textContent = `Delete the saved lorebook content "${version.title}"? This cannot be undone. The entry's current content will stay unchanged.`;
                    const confirmed = await context.Popup.show.confirm('Delete alternate content?', warning.outerHTML);
                    if (!confirmed || !verifyTarget() || !versions.includes(version)) return;
                    versions.splice(versions.indexOf(version), 1);
                    changed({ immediate: true });
                    renderList();
                } catch (error) { reportError(error); }
                finally { actionPending = false; }
            });
            item.querySelector('.alt-lorebook-version-actions').append(use, remove);
            list.append(item);
            void countTokens(version, tokenValue);
        });
        updateStatus();
    }

    function addCurrent() {
        if (!verifyTarget()) return;
        versions.push({ title: `Content #${versions.length + 1}`, content: target.textarea.value });
        changed({ immediate: true });
        renderList();
    }
    addButton.addEventListener('click', addCurrent);
    saveCurrent.addEventListener('click', addCurrent);
    target.textarea.addEventListener('input', updateStatus);
    renderList();

    return {
        container,
        verifyTarget,
        persist,
        async dispose() {
            clearTimeout(saveTimer);
            for (const timer of tokenTimers.values()) clearTimeout(timer);
            try { await persist(); }
            finally {
                disposed = true;
                target.textarea.removeEventListener('input', updateStatus);
            }
        },
    };
}

async function openManager(textarea, button) {
    if (managerOpen) return;
    managerOpen = true;
    button.disabled = true;
    try {
        const target = getTarget(textarea);
        const data = await bindEditorData(target);
        activeManager = createManager(target, data);
        await activeManager.persist();
        // Use the same native popup shell and dimensions as the character-field manager.
        const popup = getContext().callPopup(activeManager.container, 'text', '', { wide: true, large: true });
        // The shared native shell retains scroll position between unrelated popups.
        activeManager.container.parentElement.scrollTop = 0;
        await popup;
    } catch (error) { reportError(error); }
    finally {
        try { await activeManager?.dispose(); }
        catch (error) { reportError(error); }
        activeManager = null;
        managerOpen = false;
        button.disabled = false;
    }
}

function injectButtons(root) {
    root.querySelectorAll('.world_entry[uid] textarea[name="content"]').forEach(textarea => {
        const body = textarea.closest('.wi-entry-content-body');
        if (!body || body.querySelector('.alt-lorebook-button')) return;
        const toolbar = document.createElement('div');
        toolbar.className = 'alt-lorebook-toolbar';
        const button = makeButton('alt-lorebook-button', 'fa-bars-staggered', 'Alt. Content');
        button.title = 'Manage alternate lorebook entry content';
        button.addEventListener('click', event => {
            event.stopPropagation();
            void openManager(textarea, button);
        });
        toolbar.append(button);
        body.classList.add('alt-lorebook-content-body');
        body.insertBefore(toolbar, textarea);
    });
}

function initializeLorebookContent() {
    if (initialized) return;
    const root = document.getElementById('world_popup_entries_list');
    if (!root) return;
    initialized = true;
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.className = 'alt-lorebook-stylesheet';
    style.href = new URL('./lorebook-content.css', import.meta.url).href;
    document.head.append(style);
    const { eventSource, eventTypes } = getContext();
    eventSource.makeFirst(eventTypes.WORLDINFO_ENTRIES_LOADED, excludeLorebookAlternatesFromScan);
    const observer = new MutationObserver(records => {
        // Token-counter text changes do not require another scan of every visible entry.
        if (records.some(record => Array.from(record.addedNodes).some(node => node.nodeType === 1
            && (node.matches('textarea[name="content"]') || node.querySelector('textarea[name="content"]'))))) {
            injectButtons(root);
        }
        activeManager?.verifyTarget();
    });
    observer.observe(root, { childList: true, subtree: true });
    injectButtons(root);
}

getContext().eventSource.on(getContext().eventTypes.APP_READY, initializeLorebookContent);
initializeLorebookContent();
