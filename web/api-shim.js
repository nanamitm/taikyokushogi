// Static (GitHub Pages) build: route the GUI's fetch('/api/...') calls to the
// WebAssembly engine running in a Web Worker instead of the Python server.
// The worker keeps the whole game state, so long AI searches never block the UI.
(() => {
    const worker = new Worker('engine-worker.js', {type: 'module'});
    const pending = new Map();
    let nextId = 1;

    worker.onmessage = (e) => {
        const {id, status, body, contentType} = e.data;
        const resolve = pending.get(id);
        pending.delete(id);
        resolve(new Response(body, {status, headers: {'Content-Type': contentType}}));
    };
    worker.onerror = (e) => {
        document.getElementById('status').textContent = 'Engine failed to load: ' + (e.message || e);
    };

    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        const isApi = typeof input === 'string' && input.startsWith('/api/');
        if (!isApi) return realFetch(input, init);
        return new Promise((resolve) => {
            const id = nextId++;
            pending.set(id, resolve);
            worker.postMessage({
                id,
                method: init.method || 'GET',
                path: url.pathname,
                query: Object.fromEntries(url.searchParams),
                body: init.body ? JSON.parse(init.body) : {},
            });
        });
    };
})();
