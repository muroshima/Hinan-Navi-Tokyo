// Marp CLI 設定（発表スライド docs/slides.md 用）。
// - themeSet: カスタムテーマを登録（slides.md の `theme: hinan` で選択）
// - allowLocalFiles: ローカル画像（shot-triage.jpg / shot-breakdown.jpg / qr-*.png 等）の埋め込みを許可
// - html: スライド内の <div>/<b>/<br> を有効化
// - options.emoji.{unicode,shortcode}:false: 絵文字を Twemoji 画像(CDN)へ変換せずネイティブ表示に。
//   unicode:false で直書き絵文字(🎬等)がCDN非依存になる。shortcode:false は `:smile:` 記法も
//   変換しない設定で、将来ショートコードが混入しても外部CDN依存が入らないことを保証する(オフライン徹底)。
// 使い方(Marp CLIは依存に含めずnpxで実行):
//   npx -y @marp-team/marp-cli@4.3.1 docs/slides.md -c marp.config.mjs -o docs/slides.html
export default {
  allowLocalFiles: true,
  html: true,
  themeSet: ["docs/slides-theme.css"],
  options: {
    emoji: { shortcode: false, unicode: false },
  },
};
