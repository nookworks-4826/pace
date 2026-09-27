# 公開済みPaceの更新

## 利用する人の操作

1. いつものPaceを開き、入力途中なら保存します。
2. 通信できる状態で「設定 → アプリの更新 → 更新を確認」を押します。
3. 新しい版があれば「更新を適用」を押します。更新後にPINなどを求められたら解除します。
4. 設定の現在のバージョンと、いつもの残高・履歴を確認します。

v1.1.0から初めて更新する場合は、通信中に一度アプリを開き直し、「Paceの更新があります」の「更新する」を押します。手動確認ボタンはv1.1.1で追加した機能です。すぐ表示されない場合は、少し時間を置いて開き直してください。

同じ公開URL・同じDB名での通常更新は、端末内の記録を保持する設計です。更新のためにアプリの削除、ブラウザのデータ消去、全データ削除を行う必要はありません。重大な保存仕様変更前にはバックアップを用意します。記録がまだない場合のバックアップは不要です。

「更新を確認」はアプリの配信ファイルを確認する処理です。家計情報を送信しません。オフラインでも家計の入力・閲覧は続けられます。

## 開発する人の操作

1. 現在公開しているmainと、今回変更したソースを比較します。履歴を整理した後は整理済みmainから始め、整理前のGit履歴を再びpushしません。
2. `src/types/index.ts` のAPP_VERSION、`package.json`、`package-lock.json`のアプリバージョンを合わせます。
3. `npm run test` と `npm run build` を実行します。更新処理を変えた場合は `npm run test:update` も実行します。
4. 公開するファイルを確認し、mainへ通常のコミットを追加します。初回用の `git init` や履歴の強制上書きを繰り返しません。
5. GitHub Actionsの「Test and deploy Pace」の成功を確認します。
6. いつもの公開URLを開き、更新後のバージョン・既存記録を確認します。

GitHubのブラウザから更新する場合は、リポジトリのCode画面でmainを選び、「Add file → Upload files」から変更ファイルを元の相対パスでアップロードします。変更ファイルをまとめたフォルダーは、外側のフォルダーごとではなく中身を選びます。確認画面で `src/...`、`package.json`、`README.md` などがリポジトリ直下から始まることを確認します。削除・移動したファイルがある場合、単純なアップロードだけでは削除できないため別途対応が必要です。

GitHubのSettings → Emailsで公開メールの設定を確認します。「Keep my email addresses private」はWebでの操作にnoreplyアドレスを使う設定です。Gitでの更新時も作者名を公開用の表示名にし、メールにはそのアカウントの設定画面にあるnoreplyアドレスを使います。変更前のコミット作者情報は設定変更だけでは変わりません。

アップロードするのはアプリのソースだけです。家計のJSON・CSV・Excel・暗号化バックアップ、サポートへの問い合わせ文、端末のスクリーンショット、`test-results`、`node_modules`、`.git` は入れません。`.gitignore`はGitの補助であり、Webのアップロード画面で選んだファイルを除外する機能ではありません。

## データの互換性

- v1.2.0でもDB名 `pace`、Dexie v2、バックアップschemaVersion 1を維持しています。家計データの構造は変更していません。
- v1.2.0はパスキー登録を追加します。既存のPINとデバイス認証の保存形式を保ち、自動的に新しいロックへ変更しません。設定手順は[パスキー](PASSKEYS.md)を参照してください。
- 後からDB構造を変える場合は、新しいDexie versionと移行処理を追加して、旧版の記録で試験します。過去のversionの定義を消したり、更新時にDBを削除して作り直したりしません。
- 公開ホスト名やブラウザを変える場合は通常更新と異なります。[URL変更手順](CHANGE-PUBLIC-URL.md)を確認してください。
- コードの配信は各端末で共通ですが、家計情報は各自の端末内です。開発者から友人の記録は見えず、自動同期もしません。

## 更新試験

```powershell
npm run test
npm run build
npm run test:update
```

初回は `npx playwright install chromium` が必要です。既存のChromeをテスト用の一時プロファイルで使う場合は `PLAYWRIGHT_CHROMIUM_EXECUTABLE` に実行ファイルのパスを指定できます。

```powershell
$env:PACE_QA_PREVIOUS_DIST = 'C:\作業フォルダー\旧版のdist'
npm run test:update
Remove-Item Env:PACE_QA_PREVIOUS_DIST
```

試験は `/pace/` 配下でPWAを起動し、架空の現金支出・カード支出・残高・PIN・下書きを保存してから更新します。更新前後の全テーブルとロック設定を照合し、オフライン再起動、更新サーバーエラー、延期、入力中の更新、複数タブ、画面幅も確認します。実機のOS・ブラウザ保存領域の消去や障害まで保証する試験ではありません。

参考：[PWAの更新通知](https://vite-pwa-org.netlify.app/frameworks/react.html)、[GitHubのコミット用メール](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address)
