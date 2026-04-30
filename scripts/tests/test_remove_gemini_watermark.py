import math
import os
import pathlib
import sys
import tempfile
import unittest

from PIL import Image


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.remove_gemini_watermark import (  # type: ignore
    calculate_watermark_position,
    detect_watermark_config,
    remove_watermark_file,
)


ASSETS_DIR = REPO_ROOT / "scripts" / "assets"
BG_48 = ASSETS_DIR / "bg_48.png"
BG_96 = ASSETS_DIR / "bg_96.png"


def load_alpha_map(asset_path: pathlib.Path):
    image = Image.open(asset_path).convert("RGBA")
    width, height = image.size
    pixels = list(image.getdata())
    alpha = []
    for r, g, b, _a in pixels:
      alpha.append(max(r, g, b) / 255.0)
    return width, height, alpha


def build_test_image(width: int, height: int) -> Image.Image:
    image = Image.new("RGBA", (width, height))
    pixels = []
    for y in range(height):
        for x in range(width):
            r = (x * 13 + y * 7) % 256
            g = (x * 5 + y * 11) % 256
            b = (x * 17 + y * 3) % 256
            pixels.append((r, g, b, 255))
    image.putdata(pixels)
    return image


def apply_synthetic_watermark(original: Image.Image) -> Image.Image:
    width, height = original.size
    cfg = detect_watermark_config(width, height)
    pos = calculate_watermark_position(width, height, cfg)
    bg_path = BG_48 if cfg["logo_size"] == 48 else BG_96
    alpha_w, alpha_h, alpha_map = load_alpha_map(bg_path)
    assert alpha_w == pos["width"]
    assert alpha_h == pos["height"]

    output = original.copy()
    original_pixels = original.load()
    output_pixels = output.load()

    for row in range(pos["height"]):
        for col in range(pos["width"]):
            alpha = alpha_map[row * pos["width"] + col]
            x = pos["x"] + col
            y = pos["y"] + row
            r, g, b, a = original_pixels[x, y]
            nr = round(alpha * 255 + (1 - alpha) * r)
            ng = round(alpha * 255 + (1 - alpha) * g)
            nb = round(alpha * 255 + (1 - alpha) * b)
            output_pixels[x, y] = (nr, ng, nb, a)

    return output


class RemoveGeminiWatermarkTests(unittest.TestCase):
    def test_detects_48px_watermark_for_small_images(self):
        cfg = detect_watermark_config(1024, 1024)
        self.assertEqual(cfg, {"logo_size": 48, "margin_right": 32, "margin_bottom": 32})

    def test_detects_96px_watermark_for_large_images(self):
        cfg = detect_watermark_config(1600, 1200)
        self.assertEqual(cfg, {"logo_size": 96, "margin_right": 64, "margin_bottom": 64})

    def test_calculates_bottom_right_watermark_position(self):
        cfg = detect_watermark_config(1200, 1200)
        pos = calculate_watermark_position(1200, 1200, cfg)
        self.assertEqual(pos, {"x": 1040, "y": 1040, "width": 96, "height": 96})

    def test_recovers_pixels_in_watermark_region(self):
        original = build_test_image(800, 800)
        watermarked = apply_synthetic_watermark(original)

        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = pathlib.Path(temp_dir) / "input.png"
            output_path = pathlib.Path(temp_dir) / "output.png"
            watermarked.save(input_path)

            result_path = remove_watermark_file(input_path, output_path)
            self.assertEqual(pathlib.Path(result_path), output_path)

            restored = Image.open(output_path).convert("RGBA")
            cfg = detect_watermark_config(*original.size)
            pos = calculate_watermark_position(original.width, original.height, cfg)

            original_pixels = original.load()
            restored_pixels = restored.load()
            for row in range(pos["height"]):
                for col in range(pos["width"]):
                    x = pos["x"] + col
                    y = pos["y"] + row
                    expected = original_pixels[x, y]
                    actual = restored_pixels[x, y]
                    for idx in range(3):
                        self.assertLessEqual(abs(expected[idx] - actual[idx]), 2)

    def test_can_replace_source_file_in_place(self):
        original = build_test_image(800, 800)
        watermarked = apply_synthetic_watermark(original)

        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = pathlib.Path(temp_dir) / "input.png"
            watermarked.save(input_path)

            result_path = remove_watermark_file(input_path, None)
            self.assertEqual(pathlib.Path(result_path), input_path)

            restored = Image.open(input_path).convert("RGBA")
            cfg = detect_watermark_config(*original.size)
            pos = calculate_watermark_position(original.width, original.height, cfg)
            original_pixels = original.load()
            restored_pixels = restored.load()

            sample_points = [
                (pos["x"], pos["y"]),
                (pos["x"] + pos["width"] // 2, pos["y"] + pos["height"] // 2),
                (pos["x"] + pos["width"] - 1, pos["y"] + pos["height"] - 1),
            ]
            for x, y in sample_points:
                expected = original_pixels[x, y]
                actual = restored_pixels[x, y]
                for idx in range(3):
                    self.assertLessEqual(abs(expected[idx] - actual[idx]), 2)


if __name__ == "__main__":
    unittest.main()
