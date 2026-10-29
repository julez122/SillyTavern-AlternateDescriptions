// This namespace belongs to lorebook entry metadata, independently of character fields.
export const LOREBOOK_CONTENT_KEY = 'alternate_lorebook_content';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readLorebookAlternates(entry) {
    const library = entry.extensions?.[LOREBOOK_CONTENT_KEY];
    if (library === undefined) return [];
    if (!isObject(library) || !Array.isArray(library.versions)
        || library.versions.some(version => !isObject(version)
            || typeof version.title !== 'string' || typeof version.content !== 'string')) {
        throw new Error('This lorebook entry has invalid alternate content data. Its saved data was left unchanged.');
    }
    return structuredClone(library.versions);
}

export function writeLorebookAlternates(entry, versions) {
    if (entry.extensions !== undefined && !isObject(entry.extensions)) {
        throw new Error('This lorebook entry has invalid extension metadata. Its saved data was left unchanged.');
    }
    // Validate existing data before updating our namespace; preserve every sibling and unknown key.
    readLorebookAlternates(entry);
    const createdExtensions = entry.extensions === undefined;
    entry.extensions ??= {};
    entry.extensions[LOREBOOK_CONTENT_KEY] = {
        createdExtensions,
        ...entry.extensions[LOREBOOK_CONTENT_KEY],
        versions: structuredClone(versions),
    };
}

// WORLDINFO_ENTRIES_LOADED runs before native entry hashing. Change only the scan copies,
// so editing an unused alternate cannot invalidate sticky/cooldown state or the stored book.
export function excludeLorebookAlternatesFromScan(lore) {
    for (const entries of [lore.globalLore, lore.characterLore, lore.chatLore, lore.personaLore]) {
        for (const entry of entries ?? []) {
            if (!Object.hasOwn(entry.extensions ?? {}, LOREBOOK_CONTENT_KEY)) continue;
            const { [LOREBOOK_CONTENT_KEY]: library, ...extensions } = entry.extensions;
            if (library?.createdExtensions === true && Object.keys(extensions).length === 0) {
                delete entry.extensions;
            } else {
                entry.extensions = extensions;
            }
        }
    }
}
