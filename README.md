# QR Transfer

QR Transferは、2台の端末間でファイルを送るためのブラウザベースの転送ツールです。受信側が転送用ルームを開き、送信側がQRコードまたは一時的な共有リンクから参加します。ファイルはWebRTC DataChannelで送信します。

アカウント、サーバー上のファイル保存、クラウドストレージ連携は前提にしていません。

## 設計

- 受信側はランダムなPeer IDと32バイトのセッション秘密鍵を生成します。
- 共有URLは、Peer IDをクエリ文字列に、セッション秘密鍵をURLフラグメントに含めます。
- 送信側は、ファイル転送前にセッション秘密鍵を持っていることをHMACで証明します。
- ファイルメタデータとファイルチャンクは、WebRTCへ渡す前にAES-GCMで暗号化します。
- QRコードは初期状態では非表示です。再発行するとPeer IDとセッション秘密鍵の両方を作り直します。
- 受信側には、認証済みの送信側接続数を表示します。

## セキュリティモデル

Peer ID（画面上のRoom IDはその一部を表示したもの）は接続先を示す識別子であり、秘密情報ではありません。QR Transferは、セッション秘密鍵を接続認証とアプリ層暗号化に使います。

セッション秘密鍵からWeb Crypto APIで用途別の鍵を導出します。

- HMAC-SHA-256: 接続認証
- AES-GCM: ファイルメタデータとチャンクの暗号化

この設計により、シグナリングサーバーや通常のネットワーク観測者からファイル内容を読みにくくします。一方で、次のケースは防御範囲外です。

- QRコードや共有リンクが漏洩した場合。QRコードにはPeer IDとセッション秘密鍵の両方が含まれます。
- 送信側または受信側の端末が侵害されている場合。復号後のデータは端末上で扱われます。
- 強い権限を持つブラウザ拡張が動作している場合。ページ内容やURLにアクセスされ得ます。
- ブラウザ、WebRTC、Web Crypto API、PeerJS、QRCodeなど使用しているソフトウェアやプラットフォームに脆弱性がある場合。これらの実装を信頼して動作します。
- GitHubなどの配信基盤やCI権限が侵害された場合。SBOMやArtifact Attestationsは検出補助であり、侵害そのものは防ぎません。

## サプライチェーン

実行時に使う外部JavaScriptはCDNから読み込まず、`vendor/`配下に固定して同一オリジンから配信します。

- `vendor/checksums.sha256`にvendored fileのSHA-256を記録します。
- `npm run verify:vendor`でハッシュを検証します。
- GitHub Actionsでは、Pages配信用の`_site/`を生成し、`site.sha256`、SPDX JSON SBOM、GitHub Artifact Attestationsを作成します。

## 検証

```sh
npm run check
npm test
npm run build:pages
npm run release:metadata
```

`npm run check`はJavaScriptの構文チェックとvendorハッシュ検証を実行します。`npm run release:metadata`はPages配信用ファイルのチェックサムとSBOMを生成します。
