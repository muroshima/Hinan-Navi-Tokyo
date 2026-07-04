#!/usr/bin/env python3
"""動画サムネイルのタイトル合成。

  python3 scripts/thumbnail/overlay_title.py

scripts/thumbnail/base.png（生成AIで作成した16:9のベース絵・文字なし）の上部の
暗い空エリアに、タイトル（白）＋サブタイトル（琥珀色）を濃紺(#0f2740)の縁取り付きで合成し、
- docs/video-thumb.png（合成後の原寸マスター）
- docs/video-thumb.jpg（README/ポスター用の軽量版・幅 JPG_WIDTH）
を出力する。ベース絵の生成プロンプトの骨子は scripts/thumbnail/README.md を参照。

生成AIは日本語テキスト描画が苦手なため、テキストは常にこの後段で乗せる方針。
フォントは macOS 同梱のヒラギノ角ゴ（W8/W6）。他環境では FONT_TITLE / FONT_SUB のパスを変更する。
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# README/ポスター用JPGの横幅。原寸(2752)から縮小して軽量化する
JPG_WIDTH = 1600

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
BASE = HERE / "base.png"
OUT_PNG = ROOT / "docs" / "video-thumb.png"
OUT_JPG = ROOT / "docs" / "video-thumb.jpg"

TITLE = "だれでも避難ナビ TOKYO"
SUBTITLE = "要配慮者が「本当に行ける」避難所へ"
FONT_TITLE = "/System/Library/Fonts/ヒラギノ角ゴシック W8.ttc"
FONT_SUB = "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"


def main() -> None:
    if not BASE.exists():
        sys.exit(f"ベース画像がありません: {BASE}")
    for f in (FONT_TITLE, FONT_SUB):
        if not Path(f).exists():
            sys.exit(f"フォントが見つかりません: {f}（macOS以外は環境のフォントに変更してください）")

    img = Image.open(BASE).convert("RGB")
    W, H = img.size
    draw = ImageDraw.Draw(img)
    f_title = ImageFont.truetype(FONT_TITLE, int(H * 0.105))
    f_sub = ImageFont.truetype(FONT_SUB, int(H * 0.050))

    def draw_center(y: int, text: str, font, fill, stroke_fill=(15, 39, 64), stroke=6) -> int:  # 縁取り=#0f2740
        bb = draw.textbbox((0, 0), text, font=font, stroke_width=stroke)
        x = (W - (bb[2] - bb[0])) // 2 - bb[0]
        draw.text((x, y), text, font=font, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)
        return bb[3] - bb[1]

    y = int(H * 0.055)
    h1 = draw_center(y, TITLE, f_title, (255, 255, 255))
    draw_center(y + h1 + int(H * 0.03), SUBTITLE, f_sub, (253, 230, 138))  # amber系

    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT_PNG)
    # README/ポスター用に幅JPG_WIDTHへ縮小した軽量JPG。Pillowのみで完結しOS非依存
    # （macOSのsips依存を避ける）。RGBなのでそのままJPEG保存可。
    h2 = round(H * JPG_WIDTH / W)
    img.resize((JPG_WIDTH, h2), Image.LANCZOS).save(OUT_JPG, quality=88)
    print(f"✅ {OUT_PNG}  ({OUT_PNG.stat().st_size / 1e6:.1f} MB)")
    print(f"✅ {OUT_JPG}  ({OUT_JPG.stat().st_size / 1e3:.0f} KB)")


if __name__ == "__main__":
    main()
