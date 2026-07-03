// Marp CLI 設定（発表スライド docs/slides.md 用）。
// - themeSet: カスタムテーマを登録（slides.md の `theme: hinan` で選択）
// - allowLocalFiles: ローカル画像（demo-thumb.jpg / shot-triage.jpg / architecture 等）の埋め込みを許可
// - html: スライド内の <div>/<b>/<br> を有効化
// - options.emoji.unicode:false: 絵文字を Twemoji 画像(CDN)に変換せずネイティブ表示にし、
//   HTML を外部CDN非依存(オフラインでも絵文字が出る)にする
// 使い方: marp docs/slides.md -c marp.config.mjs -o docs/slides.html
export default {
  allowLocalFiles: true,
  html: true,
  themeSet: ["docs/slides-theme.css"],
  options: {
    emoji: { shortcode: true, unicode: false },
  },
};
