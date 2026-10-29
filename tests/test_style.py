"""Static checks of src/style.css: both dark palettes match and every token has
a light and a dark value; text meets 4.5:1 and control borders and the focus
ring 3:1 on every surface, in both themes (WCAG 2.2 SC 1.4.3 and 1.4.11)."""
import os
import re
import unittest

CSS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "style.css")
TOKEN = r"--([\w-]+):\s*(#[0-9a-f]{6})"


def palettes(css):
    blocks = {"light": re.search(r":root \{(.*?)\}", css, re.S).group(1),
              "dark": re.search(r':root\[data-theme="dark"\] \{(.*?)\}', css, re.S).group(1)}
    return {k: dict(re.findall(TOKEN, v)) for k, v in blocks.items()}


def ratio(a, b):
    def lum(h):
        c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    hi, lo = sorted((lum(a), lum(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


class StyleTest(unittest.TestCase):
    def setUp(self):
        with open(CSS, encoding="utf-8") as f:
            self.css = f.read()

    def test_dark_palettes_match_and_define_every_token(self):
        media = re.search(r'@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{(.*?)\}', self.css, re.S).group(1)
        pal = palettes(self.css)
        self.assertEqual(dict(re.findall(TOKEN, media)), pal["dark"])
        self.assertEqual(set(pal["light"]), set(pal["dark"]))
        used = set(re.findall(r"var\(--([\w-]+)\)", self.css)) - {"font-ui", "font-data", "r"}
        self.assertLessEqual(used, set(pal["light"]), "every colour used is a token")

    def test_contrast(self):
        for theme, t in palettes(self.css).items():
            grounds = ("bg", "surface", "sunken", "info-bg")
            for fg in ("fg", "muted", "accent", "s-done", "s-review", "s-progress", "s-blocked", "s-not", "s-removed", "bad-fg"):
                for g in grounds:
                    self.assertGreaterEqual(ratio(t[fg], t[g]), 4.5, f"{theme} {fg} on {g}")
            for fg, g in (("warn-fg", "warn-bg"), ("bad-fg", "bad-bg"), ("info-fg", "info-bg"), ("accent-fg", "accent")):
                self.assertGreaterEqual(ratio(t[fg], t[g]), 4.5, f"{theme} {fg} on {g}")
            for fg in ("control", "focus"):
                for g in grounds:
                    self.assertGreaterEqual(ratio(t[fg], t[g]), 3, f"{theme} {fg} on {g}")

    def test_status_pills_keep_contrast_on_their_tint(self):
        # A pill is its status colour on a 9% tint of that colour over the surface.
        def mix(fg, bg, share):
            f, g = ([int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in (fg, bg))
            return "#" + "".join("%02x" % round(a * share + b * (1 - share)) for a, b in zip(f, g))
        self.assertIn("color-mix(in srgb, currentColor 9%, var(--surface))", self.css)
        for theme, t in palettes(self.css).items():
            for fg in ("s-done", "s-review", "s-progress", "s-blocked", "s-not", "s-removed", "bad-fg"):
                self.assertGreaterEqual(ratio(t[fg], mix(t[fg], t["surface"], 0.09)), 4.5, f"{theme} {fg} pill")

    def test_every_accent_keeps_contrast(self):
        light = dict(re.findall(r':root\[data-accent="(\w+)"\] \{ --accent: (#[0-9a-f]{6}); \}', self.css))
        dark = dict(re.findall(r':root\[data-theme="dark"\]\[data-accent="(\w+)"\] \{ --accent: (#[0-9a-f]{6}); \}', self.css))
        media = dict(re.findall(r':root\[data-accent="(\w+)"\]:not\(\[data-theme="light"\]\) \{ --accent: (#[0-9a-f]{6}); \}', self.css))
        self.assertEqual(set(light), {"teal", "violet", "rose", "amber", "graphite"})
        self.assertEqual(dark, media)
        pal = palettes(self.css)
        for theme, accents in (("light", light), ("dark", dark)):
            t = pal[theme]
            for name, acc in accents.items():
                for g in ("bg", "surface", "sunken", "info-bg"):
                    self.assertGreaterEqual(ratio(acc, t[g]), 4.5, f"{theme} {name} on {g}")
                self.assertGreaterEqual(ratio(t["accent-fg"], acc), 4.5, f"{theme} text on {name}")

    def test_focus_ring_is_three_pixels(self):
        self.assertIn(":focus-visible { outline: 3px solid var(--focus);", self.css)


if __name__ == "__main__":
    unittest.main()
