from __future__ import annotations

import argparse
import pathlib
import tempfile
from typing import Iterable

from PIL import Image


ALPHA_THRESHOLD = 0.002
MAX_ALPHA = 0.99
LOGO_VALUE = 255.0

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
ASSETS_DIR = SCRIPT_DIR / "assets"
BG_48_PATH = ASSETS_DIR / "bg_48.png"
BG_96_PATH = ASSETS_DIR / "bg_96.png"


def detect_watermark_config(image_width: int, image_height: int) -> dict[str, int]:
    if image_width > 1024 and image_height > 1024:
        return {
            "logo_size": 96,
            "margin_right": 64,
            "margin_bottom": 64,
        }
    return {
        "logo_size": 48,
        "margin_right": 32,
        "margin_bottom": 32,
    }


def calculate_watermark_position(
    image_width: int,
    image_height: int,
    config: dict[str, int],
) -> dict[str, int]:
    logo_size = config["logo_size"]
    margin_right = config["margin_right"]
    margin_bottom = config["margin_bottom"]
    return {
        "x": image_width - margin_right - logo_size,
        "y": image_height - margin_bottom - logo_size,
        "width": logo_size,
        "height": logo_size,
    }


def calculate_alpha_map(bg_capture: Image.Image) -> list[float]:
    rgba = bg_capture.convert("RGBA")
    alpha_map: list[float] = []
    for r, g, b, _a in rgba.getdata():
        alpha_map.append(max(r, g, b) / 255.0)
    return alpha_map


def load_alpha_map_for_size(size: int) -> list[float]:
    asset_path = BG_48_PATH if size == 48 else BG_96_PATH
    if not asset_path.exists():
        raise FileNotFoundError(f"Missing watermark asset: {asset_path}")
    return calculate_alpha_map(Image.open(asset_path))


def remove_watermark_image(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    width, height = rgba.size
    config = detect_watermark_config(width, height)
    position = calculate_watermark_position(width, height, config)
    alpha_map = load_alpha_map_for_size(config["logo_size"])

    pixels = rgba.load()
    watermark_width = position["width"]
    watermark_height = position["height"]
    base_x = position["x"]
    base_y = position["y"]

    for row in range(watermark_height):
        for col in range(watermark_width):
            alpha = alpha_map[row * watermark_width + col]
            if alpha < ALPHA_THRESHOLD:
                continue
            alpha = min(alpha, MAX_ALPHA)
            one_minus_alpha = 1.0 - alpha
            x = base_x + col
            y = base_y + row
            r, g, b, a = pixels[x, y]
            nr = max(0, min(255, round((r - alpha * LOGO_VALUE) / one_minus_alpha)))
            ng = max(0, min(255, round((g - alpha * LOGO_VALUE) / one_minus_alpha)))
            nb = max(0, min(255, round((b - alpha * LOGO_VALUE) / one_minus_alpha)))
            pixels[x, y] = (nr, ng, nb, a)

    return rgba


def _infer_save_format(path: pathlib.Path, original_format: str | None) -> str:
    ext = path.suffix.lower()
    if ext == ".png":
        return "PNG"
    if ext in {".jpg", ".jpeg"}:
        return "JPEG"
    if ext == ".webp":
        return "WEBP"
    if original_format:
        return original_format
    return "PNG"


def remove_watermark_file(
    input_path: str | pathlib.Path,
    output_path: str | pathlib.Path | None = None,
) -> str:
    source_path = pathlib.Path(input_path).resolve()
    if not source_path.exists():
        raise FileNotFoundError(f"Image not found: {source_path}")

    target_path = pathlib.Path(output_path).resolve() if output_path else source_path
    with Image.open(source_path) as source:
        original_format = source.format
        cleaned = remove_watermark_image(source)

    save_format = _infer_save_format(target_path, original_format)
    if save_format == "JPEG":
        cleaned = cleaned.convert("RGB")

    target_path.parent.mkdir(parents=True, exist_ok=True)
    if target_path == source_path:
        with tempfile.NamedTemporaryFile(
            suffix=target_path.suffix or ".png",
            dir=str(target_path.parent),
            delete=False,
        ) as temp_file:
            temp_path = pathlib.Path(temp_file.name)
        try:
            cleaned.save(temp_path, format=save_format)
            temp_path.replace(target_path)
        finally:
            if temp_path.exists():
                temp_path.unlink()
    else:
        cleaned.save(target_path, format=save_format)

    return str(target_path)


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Remove Gemini watermark from a local image and overwrite or write to output path.",
    )
    parser.add_argument("input_path", help="Input image path")
    parser.add_argument("--output", dest="output_path", help="Optional output image path")
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    result = remove_watermark_file(args.input_path, args.output_path)
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
