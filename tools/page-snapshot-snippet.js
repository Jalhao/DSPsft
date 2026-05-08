(() => {
  const MAX_TEXT = 180;
  const MAX_ROWS_PER_TABLE = 50;
  const MAX_VISIBLE_TEXT = 300;

  const normalize = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim();

  const truncate = (value, max = MAX_TEXT) => {
    const text = normalize(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
  };

  const isVisible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const cssPath = (el) => {
    if (!el || !(el instanceof Element)) return "";
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      let part = node.nodeName.toLowerCase();
      if (node.id) {
        part += `#${CSS.escape(node.id)}`;
        parts.unshift(part);
        break;
      }
      const classes = [...node.classList].slice(0, 3);
      if (classes.length) part += `.${classes.map((c) => CSS.escape(c)).join(".")}`;
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter(
          (child) => child.nodeName === node.nodeName
        );
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };

  const nearbyLabel = (el) => {
    if (!el) return "";
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText)
        .filter(Boolean)
        .join(" ");
      if (label) return truncate(label);
    }
    const id = el.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) return truncate(label.innerText);
    }
    const wrappingLabel = el.closest("label");
    if (wrappingLabel) return truncate(wrappingLabel.innerText);
    return "";
  };

  const elementInfo = (el) => ({
    tag: el.tagName.toLowerCase(),
    selector: cssPath(el),
    text: truncate(el.innerText || el.textContent || ""),
    label: nearbyLabel(el),
    name: el.getAttribute("name") || "",
    type: el.getAttribute("type") || "",
    role: el.getAttribute("role") || "",
    placeholder: truncate(el.getAttribute("placeholder") || ""),
    ariaLabel: truncate(el.getAttribute("aria-label") || ""),
    title: truncate(el.getAttribute("title") || ""),
    valuePreview:
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? truncate(el.value)
        : "",
    disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
  });

  const tables = [...document.querySelectorAll("table")]
    .filter(isVisible)
    .map((table, index) => {
      const headers = [...table.querySelectorAll("thead th")]
        .map((cell) => truncate(cell.innerText))
        .filter(Boolean);
      const fallbackHeaders = [...table.querySelectorAll("tr:first-child th, tr:first-child td")]
        .map((cell) => truncate(cell.innerText))
        .filter(Boolean);
      const rows = [...table.querySelectorAll("tbody tr, tr")]
        .slice(0, MAX_ROWS_PER_TABLE)
        .map((row) =>
          [...row.querySelectorAll("th,td")]
            .map((cell) => truncate(cell.innerText))
            .filter((cell) => cell !== "")
        )
        .filter((row) => row.length);
      return {
        index,
        selector: cssPath(table),
        headers: headers.length ? headers : fallbackHeaders,
        rowCountInDom: table.querySelectorAll("tbody tr, tr").length,
        rows,
      };
    });

  const controls = [
    ...document.querySelectorAll(
      "input, textarea, select, button, [role='button'], [role='combobox'], [role='switch'], [role='checkbox'], a[href]"
    ),
  ]
    .filter(isVisible)
    .map(elementInfo);

  const visibleText = [...document.body.querySelectorAll("body *")]
    .filter(isVisible)
    .map((el) => truncate(el.innerText || el.textContent || "", 120))
    .filter(Boolean)
    .filter((text, index, arr) => arr.indexOf(text) === index)
    .slice(0, MAX_VISIBLE_TEXT);

  const resources = performance
    .getEntriesByType("resource")
    .map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      durationMs: Math.round(entry.duration),
      transferSize: entry.transferSize,
    }))
    .filter((entry) =>
      /\/api\/|\/report\/|\/dsp|\/admin|\/adm|\.json|graphql|ajax/i.test(entry.name)
    )
    .slice(-200);

  const storageKeys = {
    localStorage: Object.keys(window.localStorage || {}),
    sessionStorage: Object.keys(window.sessionStorage || {}),
  };

  const snapshot = {
    capturedAt: new Date().toISOString(),
    page: {
      url: location.href,
      title: document.title,
      userAgent: navigator.userAgent,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
    },
    storageKeys,
    tables,
    controls,
    visibleText,
    resources,
  };

  const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `dsp-report-page-snapshot-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  console.log("DSP report page snapshot captured:", snapshot);
})();
