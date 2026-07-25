/**
 * @google/genai is ESM-only — never require() it from CommonJS.
 * Dynamic import() works from CJS on Node 18+.
 */
let GoogleGenAI = null;
let loadError = null;
let loadPromise = null;

async function loadGoogleGenAI() {
    if (GoogleGenAI) return GoogleGenAI;
    if (loadError) return null;
    if (loadPromise) return loadPromise;
    loadPromise = import('@google/genai')
        .then(function(mod) {
            GoogleGenAI = mod.GoogleGenAI || (mod.default && mod.default.GoogleGenAI) || null;
            if (!GoogleGenAI) {
                loadError = new Error('@google/genai loaded but GoogleGenAI export missing');
                return null;
            }
            console.log('@google/genai loaded via dynamic import');
            return GoogleGenAI;
        })
        .catch(function(err) {
            loadError = err;
            console.warn('@google/genai unavailable:', err.message);
            return null;
        });
    return loadPromise;
}

async function createGoogleGenAI(apiKey) {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) return null;
    const GenAI = await loadGoogleGenAI();
    if (!GenAI) return null;
    return new GenAI({ apiKey: key });
}

function getLoadError() {
    return loadError;
}

module.exports = {
    loadGoogleGenAI,
    createGoogleGenAI,
    getLoadError
};
