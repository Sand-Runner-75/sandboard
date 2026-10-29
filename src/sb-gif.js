"use strict";
// A small animated GIF encoder for the Atlas pictures: one shared 256-colour palette, LZW-compressed
// frames, played in a loop. Made for flat pictures such as the branch graph and the code tree, not for
// photos. Adapted from the owner's own earlier app (the same author's encoder), reused with the owner's
// permission and changed to write each frame as it comes, so a long recording never holds every frame's
// pixels at once. It only turns pixels into bytes: nothing is fetched, stored or sent.

(function (root) {
  const SB = root.SB;

  // The 256 most common colours of one frame (after trimming each channel to 5 bits), then the nearest
  // of them for every other colour.
  function gifPalette(rgba) {
    const counts = new Map();
    for (let j = 0; j < rgba.length; j += 4) { const k = (rgba[j] >> 3) << 10 | (rgba[j + 1] >> 3) << 5 | rgba[j + 2] >> 3; counts.set(k, (counts.get(k) || 0) + 1); }
    const keys = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([k]) => k);
    const colors = keys.map(k => [((k >> 10) & 31) << 3 | 4, ((k >> 5) & 31) << 3 | 4, (k & 31) << 3 | 4]);
    const memo = new Map();
    return {
      colors,
      index(r, g, b) {
        const k = (r >> 3) << 10 | (g >> 3) << 5 | b >> 3;
        let i = memo.get(k);
        if (i === undefined) {
          let best = Infinity; i = 0;
          for (let n = 0; n < colors.length; n++) { const c = colors[n], e = (c[0] - r) ** 2 * 3 + (c[1] - g) ** 2 * 4 + (c[2] - b) ** 2 * 2; if (e < best) { best = e; i = n; } }
          memo.set(k, i);
        }
        return i;
      },
    };
  }

  // Bytes written in growing chunks, joined once at the end.
  function sink() {
    const parts = [];
    let buf = new Uint8Array(1 << 16), n = 0;
    const flush = () => { if (n) parts.push(buf.slice(0, n)); n = 0; };
    return {
      b(x) { if (n === buf.length) { flush(); buf = new Uint8Array(1 << 16); } buf[n++] = x & 255; },
      done() {
        flush();
        const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
        let at = 0;
        for (const p of parts) { out.set(p, at); at += p.length; }
        return out;
      },
    };
  }

  // Variable-width LZW as GIF wants it, written in sub-blocks of up to 255 bytes.
  function lzw(px, minSize, out) {
    out.b(minSize);
    const clear = 1 << minSize, eoi = clear + 1;
    let size = minSize + 1, next = eoi + 1, dict = new Map();
    const buf = [];
    let acc = 0, nbits = 0;
    const emit = code => { acc |= code << nbits; nbits += size; while (nbits >= 8) { buf.push(acc & 255); acc >>>= 8; nbits -= 8; } };
    emit(clear);
    let prefix = px[0];
    for (let i = 1; i < px.length; i++) {
      const k = px[i], key = prefix << 8 | k, hit = dict.get(key);
      if (hit !== undefined) { prefix = hit; continue; }
      emit(prefix);
      if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
      else { emit(clear); dict = new Map(); size = minSize + 1; next = eoi + 1; }
      prefix = k;
    }
    emit(prefix); emit(eoi);
    if (nbits > 0) buf.push(acc & 255);
    for (let i = 0; i < buf.length; i += 255) { const n = Math.min(255, buf.length - i); out.b(n); for (let j = 0; j < n; j++) out.b(buf[i + j]); }
    out.b(0);
  }

  // A GIF of width × height with the palette given (from gifPalette): add frames of RGBA pixels with
  // their delay in milliseconds, then finish for the file's bytes.
  function gifWriter(width, height, pal) {
    const out = sink(), w16 = x => { out.b(x); out.b(x >> 8); }, str = s => { for (const c of s) out.b(c.charCodeAt(0)); };
    str("GIF89a"); w16(width); w16(height);
    out.b(0xf7); out.b(0); out.b(0);  // a global colour table of 256 entries
    for (let i = 0; i < 256; i++) { const c = pal.colors[i] || [0, 0, 0]; out.b(c[0]); out.b(c[1]); out.b(c[2]); }
    out.b(0x21); out.b(0xff); out.b(11); str("NETSCAPE2.0"); out.b(3); out.b(1); w16(0); out.b(0);  // loop forever
    let frames = 0;
    return {
      add(rgba, delay) {
        out.b(0x21); out.b(0xf9); out.b(4); out.b(0); w16(Math.round((delay || 100) / 10)); out.b(0); out.b(0);
        out.b(0x2c); w16(0); w16(0); w16(width); w16(height); out.b(0);
        const px = new Uint8Array(width * height);
        for (let i = 0, j = 0; i < px.length; i++, j += 4) px[i] = pal.index(rgba[j], rgba[j + 1], rgba[j + 2]);
        lzw(px, 8, out);
        frames++;
      },
      get frames() { return frames; },
      finish() { out.b(0x3b); return out.done(); },
    };
  }

  Object.assign(SB, { gifPalette, gifWriter });
})(typeof window !== "undefined" ? window : globalThis);
