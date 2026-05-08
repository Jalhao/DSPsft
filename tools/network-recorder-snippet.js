(() => {
  if (window.__dspReportRecorder?.stop) {
    window.__dspReportRecorder.stop();
  }

  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const records = [];

  const MAX_BODY = 8000;
  const SENSITIVE_HEADER = /cookie|authorization|token|secret|password|x-csrf/i;
  const SENSITIVE_FIELD = /token|secret|password|authorization|cookie|session/i;

  const truncate = (value, max = MAX_BODY) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
  };

  const redactText = (value) =>
    String(value || "")
      .replace(
        /(["']?(?:token|secret|password|passwd|authorization|cookie|session|csrf)["']?\s*[:=]\s*)["']?[^"',&\s}]+["']?/gi,
        "$1[REDACTED]"
      )
      .replace(
        /([?&](?:token|secret|password|passwd|authorization|cookie|session|csrf)=)[^&#\s"']+/gi,
        "$1[REDACTED]"
      )
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");

  const redactHeaders = (headers) => {
    const output = {};
    try {
      const entries =
        headers instanceof Headers
          ? [...headers.entries()]
          : Array.isArray(headers)
            ? headers
            : Object.entries(headers || {});
      for (const [key, value] of entries) {
        output[key] = SENSITIVE_HEADER.test(key)
          ? "[REDACTED]"
          : redactText(String(value));
      }
    } catch (error) {
      output.__error = String(error);
    }
    return output;
  };

  const tryParseJson = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const redactObject = (value) => {
    if (Array.isArray(value)) return value.map(redactObject);
    if (typeof value === "string") return redactText(value);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_FIELD.test(key) ? "[REDACTED]" : redactObject(item),
      ])
    );
  };

  const sanitizeBody = (body) => {
    if (body == null) return null;
    if (body instanceof FormData) {
      return {
        type: "FormData",
        fields: [...body.entries()].map(([key, value]) => [
          key,
          SENSITIVE_FIELD.test(key)
            ? "[REDACTED]"
            : value instanceof File
              ? `[File ${value.name}]`
              : truncate(redactText(String(value))),
        ]),
      };
    }
    if (body instanceof URLSearchParams) {
      return {
        type: "URLSearchParams",
        fields: [...body.entries()].map(([key, value]) => [
          key,
          SENSITIVE_FIELD.test(key) ? "[REDACTED]" : truncate(redactText(value)),
        ]),
      };
    }
    if (typeof body === "string") {
      const parsed = tryParseJson(body);
      if (parsed) return { type: "json", value: redactObject(parsed) };
      try {
        const params = new URLSearchParams(body);
        if ([...params.keys()].length) {
          return {
            type: "URLSearchParams",
            fields: [...params.entries()].map(([key, value]) => [
              key,
              SENSITIVE_FIELD.test(key) ? "[REDACTED]" : truncate(redactText(value)),
            ]),
          };
        }
      } catch {
        // Keep the plain preview below.
      }
      return { type: "text", value: truncate(redactText(body)) };
    }
    return {
      type: Object.prototype.toString.call(body),
      value: truncate(redactText(String(body))),
    };
  };

  const responsePreview = async (response) => {
    const contentType = response.headers.get("content-type") || "";
    if (!/json|text|javascript|xml|html|plain/i.test(contentType)) {
      return { skipped: `content-type ${contentType || "unknown"}` };
    }
    try {
      const text = await response.clone().text();
      const parsed = tryParseJson(text);
      return parsed
        ? { type: "json", value: redactObject(parsed) }
        : { type: "text", value: truncate(redactText(text)) };
    } catch (error) {
      return { error: String(error) };
    }
  };

  window.fetch = async (...args) => {
    const startedAt = Date.now();
    const [input, init = {}] = args;
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const method = init.method || request?.method || "GET";
    const headers = redactHeaders(init.headers || request?.headers);
    const body = sanitizeBody(init.body);
    const record = {
      type: "fetch",
      startedAt: new Date(startedAt).toISOString(),
      method,
      url,
      request: { headers, body },
    };
    records.push(record);
    try {
      const response = await originalFetch.apply(this, args);
      record.status = response.status;
      record.ok = response.ok;
      record.durationMs = Date.now() - startedAt;
      record.responseHeaders = redactHeaders(response.headers);
      record.response = await responsePreview(response);
      return response;
    } catch (error) {
      record.error = String(error);
      record.durationMs = Date.now() - startedAt;
      throw error;
    }
  };

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__dspReportRecord = {
      type: "xhr",
      startedAt: null,
      method,
      url: String(url),
      request: { headers: {}, body: null },
    };
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(
    key,
    value
  ) {
    if (this.__dspReportRecord) {
      this.__dspReportRecord.request.headers[key] = SENSITIVE_HEADER.test(key)
        ? "[REDACTED]"
        : String(value);
    }
    return originalSetRequestHeader.call(this, key, value);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    const record = this.__dspReportRecord || {
      type: "xhr",
      method: "UNKNOWN",
      url: "",
      request: { headers: {}, body: null },
    };
    const startedAt = Date.now();
    record.startedAt = new Date(startedAt).toISOString();
    record.request.body = sanitizeBody(body);
    records.push(record);

    this.addEventListener("loadend", () => {
      record.status = this.status;
      record.durationMs = Date.now() - startedAt;
      const contentType = this.getResponseHeader("content-type") || "";
      if (/json|text|javascript|xml|html|plain/i.test(contentType)) {
        const text = String(this.responseText || "");
        const parsed = tryParseJson(text);
        record.response = parsed
          ? { type: "json", value: redactObject(parsed) }
          : { type: "text", value: truncate(redactText(text)) };
      } else {
        record.response = { skipped: `content-type ${contentType || "unknown"}` };
      }
    });

    return originalSend.call(this, body);
  };

  window.__dspReportRecorder = {
    records,
    stop() {
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.open = originalOpen;
      XMLHttpRequest.prototype.send = originalSend;
      XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader;
      console.log("DSP report recorder stopped.");
    },
    download() {
      const payload = {
        capturedAt: new Date().toISOString(),
        page: { url: location.href, title: document.title },
        records,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `dsp-report-network-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      console.log("DSP report network records downloaded:", payload);
    },
  };

  console.log(
    "DSP report recorder started. Operate the page, then run window.__dspReportRecorder.download()"
  );
})();
