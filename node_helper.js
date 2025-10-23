const NodeHelper = require("node_helper");
const Log = require("logger");
const https = require("node:https");
const http = require("node:http");
const { URL } = require("node:url");

const getLib = (isHttps) => { if (isHttps) return https; return http; };

const defaultPort = ({ parsed, isHttps }) => {
  let { port } = parsed;
  if (!port) { if (isHttps) port = 443; else port = 80; }
  return port;
};

const collectBody = (res) => new Promise((resolve) => {
  let body = ""; res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => { resolve(body); });
});

const handleRedirect = ({ currentUrl, redirectsLeft, res, visited }) => {
  const output = { nextUrl: null, error: null };
  const hasLocation = Boolean(res && res.headers && res.headers.location);
  if (!hasLocation) return output;
  if (redirectsLeft <= 0) { output.error = new Error(`Too many redirects. Last: ${currentUrl}`); return output; }
  const nextUrl = new URL(res.headers.location, currentUrl).toString();
  if (Array.isArray(visited)) visited.push(currentUrl);
  output.nextUrl = nextUrl; return output;
};

const makeRequestOptions = ({ parsed, isHttpsFlag, headers, tlsInsecure }) => {
  const options = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: defaultPort({ parsed, isHttps: isHttpsFlag }),
    path: parsed.pathname + (parsed.search || ""),
    method: "GET",
    headers: headers || {}
  };
  if (isHttpsFlag && tlsInsecure) options.rejectUnauthorized = false;
  return options;
};

const parseJsonOrError = (body) => {
  try { return { ok: true, data: JSON.parse(body) }; }
  catch (err) {
    let msg = ""; if (err && err.message) msg = err.message; else msg = String(err);
    return { ok: false, error: new Error(`Failed to parse JSON: ${msg}`) };
  }
};

const failWithStatus = async ({ res, statusCode, reject }) => {
  const body = await collectBody(res);
  let snippet = ""; if (body) snippet = body.slice(0, 300); else snippet = "";
  reject(new Error(`HTTP ${statusCode}: ${snippet}`));
};

const handle2xx = async ({ res, resolve, reject }) => {
  const body = await collectBody(res);
  const parsed = parseJsonOrError(body);
  if (parsed.ok) resolve(parsed.data); else reject(parsed.error);
};

const handle3xxOrContinue = ({ currentUrl, redirectsLeft, res, visited, requestFn, resolve, reject }) => {
  const { nextUrl, error } = handleRedirect({ currentUrl, redirectsLeft, res, visited });
  if (error) { res.resume(); reject(error); return true; }
  if (nextUrl) { res.resume(); requestFn({ currentUrl: nextUrl, redirectsLeft: redirectsLeft - 1, visited, resolve, reject }); return true; }
  return false;
};

const handleResponse = async ({ res, currentUrl, redirectsLeft, visited, requestFn, resolve, reject }) => {
  const { statusCode = 0 } = res;
  if (statusCode >= 300 && statusCode < 400) { const redirected = handle3xxOrContinue({ currentUrl, redirectsLeft, res, visited, requestFn, resolve, reject }); if (redirected) return; }
  if (statusCode < 200 || statusCode >= 300) { await failWithStatus({ res, statusCode, reject }); return; }
  await handle2xx({ res, resolve, reject });
};

const buildResponseHandler = (args) => (res) => handleResponse({ ...args, res });

const tryParseUrl = (currentUrl) => { try { return { ok: true, parsed: new URL(currentUrl) }; } catch { return { ok: false, error: new Error(`Invalid URL: ${currentUrl}`) }; } };

const doRequest = ({ lib, requestOptions, timeout, onResponse, reject }) => {
  const req = lib.request(requestOptions, onResponse);
  req.on("error", (err) => { reject(err); });
  req.setTimeout(timeout, () => { req.destroy(new Error(`Request timeout after ${timeout}ms`)); });
  req.end();
};

const requestOnce = ({ currentUrl, redirectsLeft, timeout, headers, tlsInsecure, visited, resolve, reject }) => {
  const parsedResult = tryParseUrl(currentUrl);
  if (!parsedResult.ok) { reject(parsedResult.error); return; }
  const parsed = parsedResult.parsed;
  const isHttpsFlag = parsed.protocol === "https:";
  const lib = getLib(isHttpsFlag);
  const requestOptions = makeRequestOptions({ parsed, isHttpsFlag, headers, tlsInsecure });
  const onResponse = buildResponseHandler({
    currentUrl, redirectsLeft, visited,
    requestFn: (args) => requestOnce({ currentUrl: args.currentUrl, redirectsLeft: args.redirectsLeft, timeout, headers, tlsInsecure, visited, resolve, reject }),
    resolve, reject
  });
  doRequest({ lib, requestOptions, timeout, onResponse, reject });
};

const normalizeOptions = (payload) => {
  const dataIn = payload || {};
  const { id, url, options = {} } = dataIn;
  const { timeout: timeoutRaw = 15000, headers = {}, tlsInsecure: tlsInsecureRaw = false, maxRedirects: maxRedirectsRaw = 3 } = options;
  let timeout = 15000; if (typeof timeoutRaw === "number") timeout = timeoutRaw;
  const tlsInsecure = Boolean(tlsInsecureRaw);
  let maxRedirects = 3; if (typeof maxRedirectsRaw === "number") maxRedirects = maxRedirectsRaw;
  return { id, url, timeout, headers, tlsInsecure, maxRedirects };
};

module.exports = NodeHelper.create({
  start() { Log.log("MMM-JsonTable helper started…"); },

  socketNotificationReceived(notification, payload) {
    if (notification === "MMM-JsonTable_GET_JSON") this.getJson(payload);
  },

  async getJson(payload) {
    const { id, url, timeout, headers, tlsInsecure, maxRedirects } = normalizeOptions(payload);
    if (!url) { Log.error("[MMM-JsonTable] getJson: missing url"); this.sendSocketNotification("MMM-JsonTable_JSON_ERROR", { id, url, error: "Missing URL" }); return; }
    Log.log(`[MMM-JsonTable] Fetching: ${url}`);
    try {
      const data = await this.httpGetJson(url, { timeout, headers, tlsInsecure, maxRedirects });
      this.sendSocketNotification("MMM-JsonTable_JSON_RESULT", { id, url, data });
      Log.log(`[MMM-JsonTable] OK: ${url}`);
    } catch (err) {
      let msg = ""; if (err && err.message) msg = err.message; else msg = String(err);
      Log.error(`[MMM-JsonTable] ERROR fetching ${url}: ${msg}`);
      this.sendSocketNotification("MMM-JsonTable_JSON_ERROR", { id, url, error: msg });
    }
  },

  httpGetJson(targetUrl, { timeout, headers, tlsInsecure, maxRedirects }) {
    return new Promise((resolve, reject) => {
      const visited = [];
      let startRedirects = 3; if (typeof maxRedirects === "number") startRedirects = maxRedirects;
      requestOnce({ currentUrl: targetUrl, redirectsLeft: startRedirects, timeout, headers, tlsInsecure, visited, resolve, reject });
    });
  }
});
