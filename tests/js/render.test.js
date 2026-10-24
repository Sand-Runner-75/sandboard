"use strict";
// The safe renderer against hostile repository text.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadSB, fakeDocument } = require("./helpers");

const SB = loadSB();
const HOSTILE = require(path.join(__dirname, "..", "fixtures", "hostile-text.json"));

function render(text) {
  const out = SB.renderText(fakeDocument(), text);
  const nodes = out.node.children;
  return { nodes, notice: out.notice,
           links: nodes.filter(n => n.type === "element"),
           text: nodes.map(n => n.type === "text" ? n.text : n.textContent).join("") };
}

test("hostile text is kept as text nodes and only safe https links are made", () => {
  for (const [name, text] of Object.entries(HOSTILE)) {
    const r = render(text);
    assert.equal(r.text, text, name);  // nothing dropped, nothing interpreted
    for (const n of r.nodes) assert.ok(n.type === "text" || n.tag === "a", name + ": only text and links");
    for (const a of r.links) {
      assert.match(a.attributes.href, /^https:[/][/][^/@]+[/]/, name);
      assert.equal(a.attributes.target, "_blank");
      assert.equal(a.attributes.rel, "noopener noreferrer");
      assert.ok(!/javascript|vbscript|data:|@/i.test(a.attributes.href), name);
      assert.deepEqual(a.children.map(c => c.type), ["text"]);
    }
  }
});

test("no link is made from script, data, file, plain http or credential addresses", () => {
  for (const name of ["html_and_script", "script_urls", "plain_http", "credentials_in_url", "entities", "control_chars"]) {
    const links = render(HOSTILE[name]).links;
    if (name === "html_and_script") {
      assert.equal(links.length, 0);  // the address sits inside quotes and markup, not as its own word
      continue;
    }
    assert.equal(links.length, 0, name);
  }
});

test("a markdown image never becomes an image, only text or a link", () => {
  const r = render(HOSTILE.markdown_image);
  assert.ok(r.nodes.every(n => n.type === "text" || n.tag === "a"));
});

test("trailing punctuation stays outside a link", () => {
  const r = render(HOSTILE.good_links);
  assert.deepEqual(r.links.map(a => a.textContent),
                   ["https://example.org/docs", "https://example.org/a?b=1#c", "https://example.org"]);
});

test("binary content is not shown", () => {
  const r = render("PK\u0003\u0004\u0000\u0000binary");
  assert.equal(r.notice, "binary content");
  assert.ok(!r.text.includes("PK"));
});

test("huge text is cut and says so", () => {
  const r = render("a".repeat(SB.MAX_CHARS + 5000));
  assert.match(r.notice, /cut to the first/);
  assert.ok(r.text.length < SB.MAX_CHARS + 100);
});

test("non-text values are refused", () => {
  for (const value of [null, undefined, 42, { toString: () => "<b>x</b>" }]) {
    assert.equal(render(value).notice, "unsupported content");
  }
});
