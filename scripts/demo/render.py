#!/usr/bin/env python3
"""だれでも避難ナビ TOKYO デモ動画の一発エンコード。

  python3 scripts/demo/render.py   # narration/demo.ja.json + output/raw/**/video.webm → output/demo.mp4
  （__file__ 基準で動くのでどのディレクトリから実行してもよい）

処理:
  1. narration の各 cue を edge-tts で MP3 生成（無料・APIキー不要・uvx経由）
  2. cue を adelay で `at` オフセットに配置し amix で合成（normalize=0 で音量維持）
     ※ -itsoffset は amix と併用不可。adelay を使う（skill既知の罠）
  3. Playwright 録画 webm（複数あれば concat）に音声を mux し h264/AAC の mp4 出力
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE / "output" / "raw"
OUT = HERE / "output"
CARDS = HERE / "cards"  # タイトル/エンドカード(1280x720 PNG)。両方あれば前後に合成
DOCS = HERE.parent.parent / "docs"
TITLE_SEC = 2.0  # タイトルカード表示秒
END_SEC = 2.5  # エンドカード(QR)表示秒。QR読み取りの余裕を持たせ少し長め
NAME = sys.argv[1] if len(sys.argv) > 1 else "demo"
# NAME はファイル名成分のみ許可（../ や / で output/・docs/ の外へ書き出す事故を防ぐ）
if NAME in ("", ".", "..") or NAME != Path(NAME).name:
    sys.exit(f"不正な NAME です（ディレクトリ成分は使えません）: {NAME!r}")


def dur(path: Path) -> float:
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)]
    )
    return float(out.decode().strip())


def run_checked(cmd: list) -> None:
    """capture しつつ、失敗時は stderr を表示してから raise する
    （check=True + capture_output=True だとエラーログが握り潰されるため）。"""
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr.decode(errors="replace"))
        raise subprocess.CalledProcessError(r.returncode, cmd)


def ff_concat_escape(p: Path) -> str:
    """ffmpeg concat demuxer 用のパスエスケープ。
    concat demuxer はシェルのクォート規則ではなく **ffmpeg独自のバックスラッシュ
    エスケープ**（`\\'`・`\\\\`・空白）を解釈する。よってシングルクォート囲みは使わず、
    バックスラッシュ→シングルクォート→空白の順にエスケープする（順序重要）。"""
    s = str(p)
    for ch in ("\\", "'", " "):
        s = s.replace(ch, "\\" + ch)
    return s


def main() -> None:
    cfg_path = HERE / "narration" / f"{NAME}.ja.json"
    if not cfg_path.exists():
        sys.exit(f"narration が見つかりません: {cfg_path}")
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.exit(f"narration の JSON が不正です: {cfg_path}（{e}）")
    try:
        voice, rate, cues = cfg["voice"], cfg["rate"], cfg["cues"]
    except KeyError as e:
        sys.exit(f"narration に必須キーがありません: {e}（voice/rate/cues が必要）")
    if not cues:
        sys.exit(f"narration に cue がありません: {cfg_path.name}（amix の入力が0になります）")

    # 録画 webm を収集（Playwright出力の video.webm のみに限定・ファイル名ソートで順序安定）。
    # *.webm だと output/raw に別用途の webm が残った場合に誤って連結対象になるため。
    webms = sorted(RAW.rglob("video.webm"))
    if not webms:
        sys.exit(f"録画 video.webm が見つかりません: {RAW}（先に収録を実行してください）")

    OUT.mkdir(parents=True, exist_ok=True)

    # 複数 webm は concat（同コーデックなので copy）
    if len(webms) == 1:
        video = webms[0]
    else:
        listfile = OUT / "concat.txt"
        # webm のディレクトリ名に日本語やシングルクォート・空白が入り得るため
        # UTF-8 明示＋ffmpeg concat 独自のバックスラッシュエスケープを行う
        listfile.write_text(
            "".join(f"file {ff_concat_escape(w)}\n" for w in webms), encoding="utf-8"
        )
        video = OUT / "video.webm"
        run_checked(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(listfile),
             "-c", "copy", str(video)]
        )

    vlen = dur(video)
    print(f"video: {video.name}  duration={vlen:.2f}s  cues={len(cues)}")

    # 各 cue を TTS 生成
    cue_files = []
    for i, c in enumerate(cues):
        # cue 単位の入力検証（どの cue が壊れているか分かるメッセージで早期終了）
        if not isinstance(c, dict) or "text" not in c or "at" not in c:
            sys.exit(f"cue[{i}] が不正です（text/at が必要）: {c!r}")
        try:
            at = float(c["at"])
        except (TypeError, ValueError):
            sys.exit(f"cue[{i}] の at が数値ではありません: {c.get('at')!r}")
        mp3 = OUT / f"cue_{i}.mp3"
        run_checked(
            ["uvx", "edge-tts", "--voice", voice, "--rate", rate,
             "--text", str(c["text"]), "--write-media", str(mp3)]
        )
        cue_files.append((mp3, at))
        print(f"  cue{i}: at={at:>5}  {dur(mp3):.2f}s")

    # ffmpeg 入力: [0]=video, [1..]=cue mp3
    inputs = ["-i", str(video)]
    for mp3, _ in cue_files:
        inputs += ["-i", str(mp3)]

    # 各 cue を adelay で配置 → amix（normalize=0 で音量維持）→ apad
    parts, labels = [], []
    for k, (_, at) in enumerate(cue_files):
        ms = int(at * 1000)
        # all=1 で全チャンネルに同一遅延を適用（mono/stereo どちらでもチャンネル数非依存）
        parts.append(f"[{k + 1}:a]adelay={ms}:all=1[a{k}]")
        labels.append(f"[a{k}]")
    fc = ";".join(parts)
    fc += f";{''.join(labels)}amix=inputs={len(cue_files)}:normalize=0:dropout_transition=0[mix];[mix]apad[aout]"

    out_mp4 = OUT / f"{NAME}.mp4"
    subprocess.run(
        ["ffmpeg", "-y", *inputs,
         "-filter_complex", fc,
         "-map", "0:v", "-map", "[aout]",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "23",
         "-c:a", "aac", "-b:a", "160k",
         "-movflags", "+faststart", "-shortest", str(out_mp4)],
        check=True,
    )

    # タイトル/エンドカードを前後に合成（cards/title.png・end.png が両方ある場合のみ）。
    # 本編とはコーデック条件が揃わないため concat filter で全体を再エンコードする。
    title_png, end_png = CARDS / "title.png", CARDS / "end.png"
    if title_png.exists() and end_png.exists():
        final = OUT / f"{NAME}_final.mp4"
        # concat filter は全入力の v(fps/解像度/SAR/pix_fmt)・a(sample_rate/channels)が
        # 揃っていないと失敗する。カード画像だけでなく**本編[1]も同条件に正規化**してから連結する
        # （本編の fps/SAR/音声レートは録画環境や将来の変更で変わり得るため、揃える前提に頼らない）。
        # 音声は sample_rate/channels に加え **sample_fmt(fltp)** まで揃える。
        # 本編AACは fltp・anullsrc は既定で別fmtになり得るため、本編/無音を含む全音声を正規化。
        vnorm = "fps=25,scale=1280:720,setsar=1,format=yuv420p"
        anorm = "aformat=sample_rates=24000:channel_layouts=mono:sample_fmts=fltp"
        fc2 = (
            f"[0:v]{vnorm}[v0];[1:v]{vnorm}[v1];[2:v]{vnorm}[v2];"
            f"[1:a]{anorm}[a1];[3:a]{anorm}[a3];[4:a]{anorm}[a4];"
            f"[v0][a3][v1][a1][v2][a4]concat=n=3:v=1:a=1[v][a]"
        )
        run_checked(
            ["ffmpeg", "-y",
             "-loop", "1", "-t", str(TITLE_SEC), "-i", str(title_png),  # [0] タイトル
             "-i", str(out_mp4),                                        # [1] 本編
             "-loop", "1", "-t", str(END_SEC), "-i", str(end_png),      # [2] エンド
             "-f", "lavfi", "-t", str(TITLE_SEC), "-i", "anullsrc=r=24000:cl=mono",  # [3] 無音
             "-f", "lavfi", "-t", str(END_SEC), "-i", "anullsrc=r=24000:cl=mono",    # [4] 無音
             "-filter_complex", fc2,
             "-map", "[v]", "-map", "[a]",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "23",
             "-c:a", "aac", "-b:a", "160k",
             "-movflags", "+faststart", str(final)]
        )
        out_mp4 = final
        print(f"cards: title {TITLE_SEC}s + 本編 + end {END_SEC}s を合成")
    else:
        print("cards/title.png・end.png が無いためカード合成はスキップ")

    # docs/ にも正本を配置（README / 提出物用）
    DOCS.mkdir(parents=True, exist_ok=True)
    dest = DOCS / f"{NAME}.mp4"
    shutil.copyfile(out_mp4, dest)  # ストリーミングコピー（全体をメモリに載せない）
    print(f"\n✅ {out_mp4}  ({out_mp4.stat().st_size / 1e6:.1f} MB, {dur(out_mp4):.1f}s)")
    print(f"✅ {dest}")


if __name__ == "__main__":
    main()
