const express = require('express');
const http = require('http');
const { parse } = require('url');
const { Pool } = require('undici');
const { WebSocketServer } = require('ws');
const parse5 = require('parse5');
const postcss = require('postcss');
const acorn = require('acorn');
const MagicString = require('magic-string');
const zlib = require('zlib');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 8080;
const clientPools = new Map();

function getPool(origin) {
    if (!clientPools.has(origin)) {
        clientPools.set(origin, new Pool(origin, { connections: 20, pipelining: 1 }));
    }
    return clientPools.get(origin);
}

function encodeUrl(url) {
    return Buffer.from(url).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeUrl(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    try {
        return Buffer.from(str, 'base64').toString('utf-8');
    } catch {
        return null;
    }
}

function rewriteHtml(html, targetUrl) {
    const document = parse5.parse(html);
    const parsedUrl = new URL(targetUrl);

    function walk(node) {
        if (node.attrs) {
            for (const attr of node.attrs) {
                if (['src', 'href', 'action', 'data'].includes(attr.name)) {
                    if (attr.value.startsWith('javascript:') || attr.value.startsWith('data:')) continue;
                    try {
                        const absolute = new URL(attr.value, targetUrl).href;
                        attr.value = `/proxy/${encodeUrl(absolute)}`;
                    } catch {}
                }
            }
        }
        if (node.tagName === 'script' && node.childNodes && node.childNodes.length > 0) {
            for (const child of node.childNodes) {
                if (child.nodeName === '#text') {
                    child.value = rewriteJs(child.value);
                }
            }
        }
        if (node.tagName === 'style' && node.childNodes && node.childNodes.length > 0) {
            for (const child of node.childNodes) {
                if (child.nodeName === '#text') {
                    child.value = rewriteCss(child.value, targetUrl);
                }
            }
        }
        if (node.childNodes) {
            for (const child of node.childNodes) {
                walk(child);
            }
        }
    }
    walk(document);
    return parse5.serialize(document);
}

function rewriteCss(css, targetUrl) {
    try {
        const root = postcss.parse(css);
        root.walkDecls(decl => {
            if (decl.value.includes('url(')) {
                decl.value = decl.value.replace(/url\((['"]?)(.*?)\1\)/g, (match, quote, url) => {
                    if (url.startsWith('data:')) return match;
                    try {
                        const absolute = new URL(url, targetUrl).href;
                        return `url(${quote}/proxy/${encodeUrl(absolute)}${quote})`;
                    } catch {
                        return match;
                    }
                });
            }
        });
        return root.toString();
    } catch {
        return css;
    }
}

function rewriteJs(js) {
    try {
        const ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
        const s = new MagicString(js);

        acorn.walk.simple(ast, {
            MemberExpression(node) {
                if (node.object.name === 'window' || node.object.name === 'document') {
                    if (node.property.name === 'location') {
                        s.overwrite(node.start, node.end, `${node.object.name}.__proxy_location`);
                    } else if (node.property.name === 'cookie' && node.object.name === 'document') {
                        s.overwrite(node.start, node.end, `document.__proxy_cookie`);
                    } else if (node.property.name === 'localStorage') {
                        s.overwrite(node.start, node.end, `window.__proxy_localStorage`);
                    } else if (node.property.name === 'sessionStorage') {
                        s.overwrite(node.start, node.end, `window.__proxy_sessionStorage`);
                    }
                } else if (node.object.name === 'location') {
                    s.overwrite(node.start, node.end, `window.__proxy_location`);
                }
            },
            Identifier(node) {
                if (node.name === 'location' && (!node.parent || (node.parent.type !== 'MemberExpression' || node.parent.object === node))) {
                    s.overwrite(node.start, node.end, `window.__proxy_location`);
                }
            }
        });
        return s.toString();
    } catch {
        return js;
    }
}

const plugins = [
    {
        beforeRequest: (options) => options,
        afterResponse: (body, contentType, url) => {
            if (!contentType) return body;
            if (contentType.includes('text/html')) return rewriteHtml(body.toString(), url);
            if (contentType.includes('text/css')) return rewriteCss(body.toString(), url);
            if (contentType.includes('application/javascript') || contentType.includes('text/javascript')) return rewriteJs(body.toString());
            return body;
        }
    }
];

app.use(express.static(__dirname + '/public'));

app.all('/proxy/:encodedUrl*', async (req, res) => {
    const rawParam = req.params.encodedUrl + (req.params[0] || '');
    const targetUrlStr = decodeUrl(rawParam);
    if (!targetUrlStr) return res.status(400).send('Invalid Target URL');

    const targetUrl = new URL(targetUrlStr);
    const origin = targetUrl.origin;
    const pool = getPool(origin);

    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers.origin;
    delete headers.referer;
    headers['host'] = targetUrl.host;

    let options = {
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req
    };

    for (const plugin of plugins) {
        if (plugin.beforeRequest) options = plugin.beforeRequest(options);
    }

    try {
        const data = await pool.request(options);
        
        let resHeaders = { ...data.headers };
        delete resHeaders['content-security-policy'];
        delete resHeaders['content-security-policy-report-only'];
        delete resHeaders['x-frame-options'];
        
        resHeaders['access-control-allow-origin'] = '*';
        resHeaders['access-control-allow-methods'] = '*';
        resHeaders['access-control-allow-headers'] = '*';

        let bodyBuffers = [];
        data.body.on('data', (chunk) => bodyBuffers.push(chunk));
        data.body.on('end', () => {
            let buffer = Buffer.concat(bodyBuffers);
            const contentEncoding = resHeaders['content-encoding'];

            if (contentEncoding === 'gzip') {
                buffer = zlib.gunzipSync(buffer);
                delete resHeaders['content-encoding'];
            } else if (contentEncoding === 'br') {
                buffer = zlib.brotliDecompressSync(buffer);
                delete resHeaders['content-encoding'];
            }

            let contentType = resHeaders['content-type'] || '';
            for (const plugin of plugins) {
                if (plugin.afterResponse) {
                    buffer = plugin.afterResponse(buffer, contentType, targetUrlStr);
                }
            }

            resHeaders['content-length'] = Buffer.byteLength(buffer);
            res.writeHead(data.statusCode, resHeaders);
            res.end(buffer);
        });

    } catch (err) {
        res.status(500).send(err.message);
    }
});

server.on('upgrade', (request, socket, head) => {
    const { pathname } = parse(request.url);
    if (pathname.startsWith('/ws/')) {
        const encoded = pathname.substring(4);
        const target = decodeUrl(encoded);
        if (!target) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            const targetWs = new WebSocket(target);
            ws.on('message', (msg) => { if (targetWs.readyState === WebSocket.OPEN) targetWs.send(msg); });
            targetWs.on('message', (msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
            ws.on('close', () => targetWs.close());
            targetWs.on('close', () => ws.close());
            ws.on('error', () => targetWs.close());
            targetWs.on('error', () => ws.close());
        });
    } else {
        socket.destroy();
    }
});

server.listen(PORT, () => {});
