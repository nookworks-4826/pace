# Pace 2.0.0の更新

この版は旧データを暗号化する保管庫を追加します。URLを変えずに更新してください。既存データがある場合は、更新前に設定からバックアップを保存します。

## 公開する側

`Pace-update-2.0.0` は、**1.3.0の更新を反映済みのリポジトリ**に使います。まだ1.2.x以前の場合は `Pace-source-2.0.0.zip` を展開し、`pace` の中身で上書きします。ファイルが100個を超える場合は `src`、`public`、`scripts`、`docs`、残りのファイルに分けてアップロードします。同じリポジトリ・URLを使い、作り直しません。

1. 配布した `Pace-update-2.0.0` を開きます。中身はリポジトリ直下に上書きする更新ファイルです。
2. [GitHubのPace](https://github.com/nookworks-4826/pace)を開き、ブランチが `main` であることを確認します。
3. `Go to file` の右側の `＋` または `Add file` → `Upload files` を選びます。
4. 更新フォルダーの**中身すべて**をアップロード領域にドラッグします。ファイル一覧のパスが `src/...`、`public/...`、`package.json` などになっていることを確認します。
5. ページ下部の `Commit changes` を押します。メッセージは `Update Pace to 2.0.0` で構いません。
6. `Actions` → 最新の `Test and deploy Pace` を開き、緑のチェックになるまで待ちます。失敗した場合はその画面のエラーを確認してください。旧公開版は新しい配信の成功まで利用できます。
7. [公開アプリ](https://nookworks-4826.github.io/pace/)を開き、設定のバージョンが `2.0.0` になることを確認します。

GitHub PagesのSourceは引き続き `GitHub Actions` です。`.github/workflows/deploy.yml` はテスト・ビルド・プライバシー監査後に配信する設定です。アップロード一覧でこのファイルが表示されない場合は、GitHub上で同じパスのファイルを開き、更新フォルダーにある内容で編集・保存します。

## 使っている人

1. Paceの設定 → 更新を確認 → 更新を適用。
2. 旧ロックがあれば解除し、**12文字以上の保管庫のパスフレーズ**を設定します。確認した旧記録を消さず、暗号化して引き継ぎます。
3. 設定 → お金の置き場所で口座管理を始め、銀行・現金・ウォレット・カードの実残高を確認します。旧合計を個別口座へ分けたら旧合計を集計から外し、重複しないようにします。

友人は同じ公開URLからホーム画面に追加できます。記録は各自の端末に分かれて保存されます。既存の利用者のデータを配布ファイルに入れる処理はありません。

## 自動連携の状態

この配布設定ではMoneytreeの本番連携は未設定です。正式契約、Public Client、redirect URI、公開originのCORS確認後にのみ有効にします。銀行やカードのID・パスワード・client secretをGitHubへ入れません。

正式確認後の公開クライアント設定はGitHubリポジトリの `Settings` → `Secrets and variables` → `Actions` → `Variables` に登録し、再ビルドします。対象は `VITE_MONEYTREE_CLIENT_ID`、`VITE_MONEYTREE_REDIRECT_URI`、`VITE_MONEYTREE_ENVIRONMENT`、`VITE_MONEYTREE_BROWSER_ACCESS_CONFIRMED` です。確認フラグを有効にする条件と公式資料は[金融連携](FINANCIAL-PROVIDERS.md)を参照してください。

## 開発・再検証

```powershell
npm install
npm run test
npm run build
npm run privacy:audit
npm run test:ui
```

ブラウザーQAにはPlaywrightのChromiumが必要です。未導入なら `npx playwright install chromium` を実行します。既存Chromeを指定する場合は `PLAYWRIGHT_CHROMIUM_EXECUTABLE` に実行ファイルを設定できます。UI試験は専用Viteサーバーと使い捨てブラウザーを起動し、実データの保存領域を使いません。

更新試験は旧1.3.0のビルドを保管し、`PACE_QA_PREVIOUS_DIST` にそのフォルダーを指定して `npm run test:update` を実行します。旧ビルドは配布ソースに含めません。OCR試験はビルド後に `npm run test:receipts` を実行すると専用の本番サーバーを自動起動します。Service Workerを含める場合は `PACE_QA_RECEIPTS_SW=1` を設定します。エクスポートの隔離試験は `npm run test:exports` です。金融QAは開発サーバーを起動し `PACE_QA_BASE_URL` を設定して `npm run test:financial` を実行します。オフライン試験はビルド後にpreviewを起動し `PACE_QA_BASE_URL` を設定して `npm run test:offline` を実行します。

内容・検証範囲・本番利用前の確認は[21項目の完成報告](FINANCIAL-AUTOMATION.md)にまとめています。
