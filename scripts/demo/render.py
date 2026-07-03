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
DOCS = HERE.parent.parent / "docs"
NAME = sys.argv[1] if len(sys.argv) > 1 else "demo"


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
        mp3 = OUT / f"cue_{i}.mp3"
        run_checked(
            ["uvx", "edge-tts", "--voice", voice, "--rate", rate,
             "--text", c["text"], "--write-media", str(mp3)]
        )
        cue_files.append((mp3, float(c["at"])))
        print(f"  cue{i}: at={c['at']:>5}  {dur(mp3):.2f}s")

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

    # docs/ にも正本を配置（README / 提出物用）
    DOCS.mkdir(parents=True, exist_ok=True)
    dest = DOCS / f"{NAME}.mp4"
    shutil.copyfile(out_mp4, dest)  # ストリーミングコピー（全体をメモリに載せない）
    print(f"\n✅ {out_mp4}  ({out_mp4.stat().st_size / 1e6:.1f} MB)")
    print(f"✅ {dest}")


if __name__ == "__main__":
    main()
