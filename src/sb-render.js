"use strict";
// Safe rendering of repository text. Text is only ever placed in text nodes;
// it is never parsed as HTML. A web address becomes a link only if it is a
// plain https address, and the link opens in a new tab without the opener or
// a referrer. Nothing from a repository is ever loaded (no images, frames or
// scripts).

(function (root) {
  const SB = root.SB;
  const MAX_CHARS = 100000;
  const LEADING = /^[(\['"<]+/;
  const TRAILING = /[).,;:!?'">\]]+$/;

  // The address a link may point to, or null.
  function linkTarget(raw) {
    let url;
    try { url = new URL(raw); } catch (e) { return null; }
    if (url.protocol.slice(0, -1) !== "https" || !url.hostname || url.username || url.password) return null;
    return url.href;
  }

  function link(doc, href, label) {
    const a = doc.createElement("a");
    a.setAttribute("href", href);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
    a.textContent = label;
    return a;
  }

  // A fragment of text nodes and safe links. Returns {node, notice}; notice is
  // set when the content was cut short or cannot be shown as text.
  function renderText(doc, text) {
    const frag = doc.createDocumentFragment();
    if (typeof text !== "string") {
      frag.appendChild(doc.createTextNode("(unsupported content)"));
      return { node: frag, notice: "unsupported content" };
    }
    if (text.includes("\u0000")) {
      frag.appendChild(doc.createTextNode("(binary content not shown)"));
      return { node: frag, notice: "binary content" };
    }
    let notice = null;
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS);
      notice = "cut to the first " + MAX_CHARS + " characters";
    }
    let plain = "";
    for (const token of text.split(/(\s+)/)) {
      const head = (LEADING.exec(token) || [""])[0];
      const tail = (TRAILING.exec(token.slice(head.length)) || [""])[0];
      const core = token.slice(head.length, token.length - tail.length);
      const href = core.includes(":") ? linkTarget(core) : null;
      if (!href) { plain += token; continue; }
      plain += head;
      if (plain) frag.appendChild(doc.createTextNode(plain));
      frag.appendChild(link(doc, href, core));
      plain = tail;
    }
    if (plain) frag.appendChild(doc.createTextNode(plain));
    if (notice) frag.appendChild(doc.createTextNode(" [" + notice + "]"));
    return { node: frag, notice };
  }

  Object.assign(SB, { MAX_CHARS, linkTarget, renderText });
})(typeof window !== "undefined" ? window : globalThis);
