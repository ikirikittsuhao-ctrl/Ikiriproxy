const PROXY_PREFIX = '/proxy/';

function encodeUrl(url) {
    return btoa(url).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeUrl(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return atob(str);
}

self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (url.origin === self.location.origin && !url.pathname.startsWith(PROXY_PREFIX)) {
        if (e.request.referrer && e.request.referrer.includes(PROXY_PREFIX)) {
            const refPath = new URL(e.request.referrer).pathname;
            const encodedPart = refPath.substring(PROXY_PREFIX.length);
            const decodedRef = decodeUrl(encodedPart);
            const targetAbsolute = new URL(url.pathname + url.search, decodedRef).href;
            e.respondWith(fetch(`${PROXY_PREFIX}${encodeUrl(targetAbsolute)}`));
            return;
        }
    }
    e.respondWith(fetch(e.request));
});

function initHooks() {
    if (typeof window === 'undefined') return;

    const originalFetch = window.fetch;
    const originalXHR = window.XMLHttpRequest.prototype.open;
    const originalWS = window.WebSocket;
    const originalEventSource = window.EventSource;
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;

    const currentProxyUrl = window.location.pathname.substring(PROXY_PREFIX.length);
    const targetOriginUrl = currentProxyUrl ? decodeUrl(currentProxyUrl) : window.location.origin;
    const targetOrigin = new URL(targetOriginUrl);

    function resolveUrl(url) {
        if (url.startsWith('data:') || url.startsWith('blob:')) return url;
        return new URL(url, targetOrigin.href).href;
    }

    window.fetch = function(input, init) {
        if (typeof input === 'string') {
            input = `${PROXY_PREFIX}${encodeUrl(resolveUrl(input))}`;
        } else if (input instanceof Request) {
            input = new Request(`${PROXY_PREFIX}${encodeUrl(resolveUrl(input.url))}`, input);
        }
        return originalFetch.call(this, input, init);
    };

    window.XMLHttpRequest.prototype.open = function(method, url, ...args) {
        url = `${PROXY_PREFIX}${encodeUrl(resolveUrl(url))}`;
        return originalXHR.call(this, method, url, ...args);
    };

    window.WebSocket = function(url, protocols) {
        const absolute = resolveUrl(url).replace(/^http/, 'ws');
        const proxyWsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/${encodeUrl(absolute)}`;
        return new originalWS(proxyWsUrl, protocols);
    };
    window.WebSocket.prototype = originalWS.prototype;

    window.EventSource = function(url, config) {
        url = `${PROXY_PREFIX}${encodeUrl(resolveUrl(url))}`;
        return new originalEventSource(url, config);
    };
    window.EventSource.prototype = originalEventSource.prototype;

    const cookiesMap = new Map();
    Object.defineProperty(document, '__proxy_cookie', {
        get() {
            return Array.from(cookiesMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
        },
        set(val) {
            const parts = val.split(';');
            const [cookieName, cookieValue] = parts[0].split('=');
            if (cookieName) cookiesMap.set(cookieName.trim(), (cookieValue || '').trim());
        }
    });

    const createStorageVirtualizer = (type) => {
        const store = new Map();
        return {
            getItem: (key) => store.has(key) ? store.get(key) : null,
            setItem: (key, value) => store.set(key, String(value)),
            removeItem: (key) => store.delete(key),
            clear: () => store.clear(),
            key: (index) => Array.from(store.keys())[index] || null,
            get length() { return store.size; }
        };
    };
    window.__proxy_localStorage = createStorageVirtualizer('local');
    window.__proxy_sessionStorage = createStorageVirtualizer('session');

    const locationMock = {};
    const locProps = ['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'];
    locProps.forEach(prop => {
        Object.defineProperty(locationMock, prop, {
            get() { return targetOrigin[prop]; },
            set(val) {
                if (prop === 'href' || prop === 'pathname') {
                    const next = new URL(val, targetOrigin.href).href;
                    window.location.href = `${PROXY_PREFIX}${encodeUrl(next)}`;
                }
            }
        });
    });
    locationMock.assign = (url) => { window.location.href = `${PROXY_PREFIX}${encodeUrl(resolveUrl(url))}`; };
    locationMock.replace = (url) => { window.location.replace(`${PROXY_PREFIX}${encodeUrl(resolveUrl(url))}`); };
    locationMock.reload = () => { window.location.reload(); };
    window.__proxy_location = locationMock;

    window.history.pushState = function(state, title, url) {
        if (url) url = `${PROXY_PREFIX}${encodeUrl(resolveUrl(url))}`;
        return originalPushState.call(this, state, title, url);
    };
    window.history.replaceState = function(state, title, url) {
        if (url) url = `${PROXY_PREFIX}${encodeUrl(resolveUrl(url))}`;
        return originalReplaceState.call(this, state, title, url);
    };

    const originalCreateObjectURL = window.URL.createObjectURL;
    window.URL.createObjectURL = function(obj) {
        const url = originalCreateObjectURL.call(this, obj);
        return url;
    };
}

if (typeof window !== 'undefined') {
    initHooks();
} else {
    initHooks();
}
