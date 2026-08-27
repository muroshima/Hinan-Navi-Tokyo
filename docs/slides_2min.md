---
marp: true
theme: hinan
paginate: true
size: 16:9
lang: ja
header: "だれでも避難ナビ TOKYO"
footer: "都知事杯オープンデータ・ハッカソン"
---

<!--
**2分版**（本戦の持ち時間が2分になったため、16枚から4枚に絞ったもの）。
10分版は docs/slides.md。
Marp スライド（HTML/PDF出力）。テーマ・ローカル画像許可・絵文字ネイティブ表示は marp.config.mjs に集約。
ビルド(Marp CLIは依存に含めずnpxで実行):
  npx -y @marp-team/marp-cli@4.3.1 docs/slides.md -c marp.config.mjs -o docs/slides.html
  npx -y @marp-team/marp-cli@4.3.1 docs/slides.md -c marp.config.mjs -o docs/slides.pdf --pdf
-->

<!-- _class: title -->
<!-- _paginate: false -->
<!-- _header: "" -->
<!-- _footer: "" -->

# だれでも避難ナビ TOKYO

### ことばで状況を伝えると、要配慮者が「**本当に行ける**」避難所を提案する防災ナビ

東京都オープンデータ活用 ／ 都知事杯オープンデータ・ハッカソン

<span class="muted">🌐 ライブデモ・GitHub・1分デモ動画あり</span>

---

## ソリューション：ことばで相談 →「行ける順」

<div class="cols">
<div>

![検索前の画面。地図を出さず、現在地の指定と相談欄だけが中央に置かれている w:500](shot-consult.jpg)

<span class="muted">**最初に地図は出さない。** 点が散らばった地図は判断材料にならないため、まず<b>ことばで伝える</b>ことに集中させる。地図とフィルタ条件は<b>相談したあとに現れる</b>。</span>

</div>
<div>

<div class="steps">
<div class="step"><b>① ことばで相談</b><br>「雨の日、車椅子の母と避難したい。介助は私がします」</div>
<div class="step"><b>② 配慮属性を抽出</b><br>車椅子・介助者あり・雨/荒天・想定災害を構造化</div>
<div class="step"><b>③「行ける順」に<br>再ランキング</b><br>バリアフリー × 災害種別適否 × 距離 × 当事者要件</div>
</div>

さらに **なぜ1位か／より近いのに見送った理由** を根拠付きで提示し、
**マイ・タイムライン**まで返す（気象災害は警戒レベル、**地震は発災起点**で組み替える）。

</div>
</div>

---

## 地震では、判断が水害と**逆になる**

<div class="cols">
<div>

<b>地震は予報が出ない。</b>警戒レベルという時間軸が、そもそも存在しない。

- 🔥 **延焼が迫るとき、屋内の避難所は正解ではない**
  → 屋外の**広域避難場所**へ向かうのが原則（水害と逆）
- 💧 **液状化した路面は、車輪も担架も通さない**
  → 同じ危険度でも、車椅子・要介護・乳幼児連れには**重み付けを変える**
- 🏢 **帰宅困難者が向かうべきは避難所ではない**
  → 指定避難所は自宅を失った人の受け皿。**一時滞在施設**で待機する

</div>
<div>

**使ったデータ（東京都・CC BY 4.0）**

- 地震に関する**地域危険度**測定調査（第9回）
  町丁目 **5,192件** ／ 建物倒壊・火災・総合のランク1〜5
- **首都直下地震**の被害想定（令和4年度）
  計測震度 **50mメッシュ 約69万件** ／ 液状化 PL値

> どちらも「危険な場所」を示すデータ。
> **「その人がどこへ逃げられるか」には、まだ誰も答えていない。**

</div>
</div>

---

<!-- _class: title -->
<!-- _paginate: false -->
<!-- _header: "" -->
<!-- _footer: "" -->

# だれも取り残さない避難へ

東京都と国のオープンデータ、その**掛け合わせ**だけで、
要配慮者に「**本当に行ける順**」と**その根拠**を届ける。

<span class="muted">避難所/避難場所・車椅子対応トイレ・地域危険度・首都直下地震の被害想定（東京都）／ハザードマップ・PLATEAU・国勢調査（国）</span>

<div class="qrs">
<div><img src="qr-demo.png" alt="ライブデモを開くQRコード">ライブデモ<br><span class="qr-url">hinan-navi-sceyw5h4sq-an.a.run.app</span></div>
<div><img src="qr-github.png" alt="GitHubリポジトリを開くQRコード">GitHub<br><span class="qr-url">github.com/muroshima/Hinan-Navi-Tokyo</span></div>
</div>

<span class="muted">だれでも避難ナビ TOKYO ／ 1分デモ動画は README に同梱</span>
