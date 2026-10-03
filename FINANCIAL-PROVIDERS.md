# 金融データ連携の実装と利用条件

確認日: 2026-10-03。対応候補の掲載は、Paceが利用者の口座と接続済みであることを意味しません。契約・Public Client登録・本番の動作確認を終えるまで、自動取得は利用可能と表示しません。

## 連携の構成

`FinancialDataProvider` は接続、同意取消、金融機関一覧、口座、残高、明細、更新要求、実際の更新時刻、再認証の必要性を共通の契約で公開します。Moneytree、手動、明示的なテスト専用mockを分離しています。mockデータを通常の家計簿へ自動投入しません。

口座の残高は取得時点のスナップショットです。明細の符号は銀行・カードとも、支出が負、入金・返金が正です。Moneytreeのカード残高は負債を負数で返すため、Paceのカード負債DTOでは正の金額へ変換します。負債の口座を利用可能な現金に足しません。JPY以外の通貨を無断で円と見なしません。

Moneytreeの公開明細スキーマには未確定/確定の状態フィールドがありません。Moneytree adapterは `pendingStatus: "unknown"` とし、存在しないフィールドを仮定しません。外部IDが同じ明細の訂正は同じ記録の更新として処理する必要があります。mockでは未確定→確定・金額訂正を再現できます。

## Moneytreeを有効にする条件

Moneytree LINKは公式APIの利用申請、クライアント登録、契約が必要です。本番の情報は契約後に提供され、stagingとproductionは別のクライアント登録です。[APIドメイン](https://docs.link.getmoneytree.com/docs/api-domain)、[公式の仕様書請求](https://getmoneytree.com/submission/request-api-documentation)。

公式資料はJavaScript Public ClientのPKCEと公式JavaScript SDKを公開しています。ただし、Paceの公開originで認可コード交換・更新・API取得がCORS許可されることは、一般公開資料だけでは確定できません。MoneytreeへPublic Client、登録redirect URI、公開origin、必要scopeの利用許可を確認し、本番端末で動作を検証してください。確認前にCORS確認フラグを有効にしません。[認可エンドポイント](https://docs.link.getmoneytree.com/reference/post-oauth-authorize)、[公式JavaScript SDK](https://github.com/moneytree/mt-link-javascript-sdk)。

Paceの設定値は以下のみです。すべて公開情報であり、クライアントシークレットは設定しません。

```dotenv
VITE_MONEYTREE_CLIENT_ID=registered-public-client-id
VITE_MONEYTREE_REDIRECT_URI=https://your-published-origin.example/pace/
VITE_MONEYTREE_ENVIRONMENT=staging
VITE_MONEYTREE_BROWSER_ACCESS_CONFIRMED=false
```

`VITE_MONEYTREE_BROWSER_ACCESS_CONFIRMED=true` はMoneytreeから利用条件を確認し、登録originからの通信を確認した場合だけ設定します。設定不足や不正な設定では接続できません。redirect URIは登録済みの固定URLで、query/hashを含めません。productionはHTTPS必須です。stagingのローカル開発だけloopback HTTPを許可します。代理CORSサービス、クライアントシークレット、銀行ID/パスワードをPaceへ入力する方法は用意しません。

公式エンドポイントは以下に固定します。応答に任意のresource serverが含まれても、無関係なhostへトークンを送信しません。

| 用途 | staging | production |
| --- | --- | --- |
| 認可・トークン | `https://myaccount-staging.getmoneytree.com` | `https://myaccount.getmoneytree.com` |
| 日本のデータAPI | `https://jp-api-staging.getmoneytree.com` | `https://jp-api.getmoneytree.com` |

## 認証と保存

OAuth Authorization Code + PKCE S256を使用します。state、verifierは毎回暗号学的乱数で作り、暗号化された端末内vaultに保存します。redirectのorigin/path、state、client ID、有効期限10分を検証し、verifierを一度だけ消費してからコードを交換します。implicit flowやfragmentのトークンを受け入れません。[認可仕様](https://docs.link.getmoneytree.com/reference/post-oauth-authorize)。

`consumeOAuthCallback(location.href, replaceUrl)` は起動直後にcode/state等のqueryをURLから取り除き、結果をメモリに保持します。その後vaultのロックを解除して `completeAuthorization(callback)` を呼びます。HashRouter用のroute queryに認証情報を埋め込まない構成です。callback、access token、refresh token、verifierをlocalStorage、ログ、バックアップ、Service Worker cacheへ保存しません。API fetchは `cache: "no-store"`、`credentials: "omit"`、`redirect: "error"`、`referrerPolicy: "no-referrer"` としています。

`ProviderCredentialStore` の `read/write/delete` は暗号化DBへ接続する契約です。資格情報や未処理PKCEを平文の一般テーブルへ置かないでください。トークンの有効期限は応答の `expires_in` を使います。refresh tokenの固定寿命は仮定せず、応答に含まれる新しいaccess/refresh tokenをまとめて保存します。同時更新は一つにまとめます。[トークンエンドポイント](https://docs.link.getmoneytree.com/reference/post-oauth-token)。

実連携ではWeb Locks対応のブラウザが必要です。トークンの更新、認可callbackの消費、更新要求の回数予約、資格情報のread/modify/writeを同じoriginのタブ間で直列化します。非対応ブラウザでは手動管理を利用します。保管庫の状態変更時には口座のメモリcacheを消し、残高を返す直前にも保管庫へのアクセスを確認します。

データの復元・全消去は、資格情報の書込みと同じstate lockを取得して処理します。保管庫の状態変更と金融リセットでは、進行中の通信を中止し、開始時の処理世代が変わった結果を拒否します。接続ごとのランダムな `sessionNonce` を暗号化資格情報に保存し、別タブで消去・再接続された場合にも、古いOAuth応答やトークン更新が新しい接続を上書きしないことを確認します。資格情報の削除後は再認可が必要です。

最小scopeは `guest_read accounts_read transactions_read request_refresh` です。guest_readは同意取消に必要です。投資・個人プロフィール・メール等の不要scopeを要求しません。[scope一覧](https://docs.link.getmoneytree.com/docs/api-scopes)、[同意取消](https://docs.link.getmoneytree.com/reference/post-link-profile-revoke)。

## データ取得と更新

金融機関一覧は `GET /link/institutions.json`、口座は `GET /link/accounts.json`、明細は `GET /link/accounts/{account_id}/transactions.json` を使います。ID、日付、金額、通貨、更新時刻を検証してからDTOへ変換します。ページ数上限に達した不完全な取得を成功としません。明細 `since` は利用日ではなく更新に対する条件なので、同期側では重複IDを再取得して訂正を取り込めるようにします。[金融機関一覧](https://docs.link.getmoneytree.com/reference/get-institutions)、[口座](https://docs.link.getmoneytree.com/reference/get-link-accounts)、[明細](https://docs.link.getmoneytree.com/reference/get-link-accounts-transactions)。

更新要求は `POST /link/profile/refresh.json` に `background_refreshable_only: true` を送ります。公式上限は利用者ごとに日本時間の一日4回です。Paceはさらに15分の間隔を設け、日付と利用回数を暗号化storeへ保持します。通信結果を失っても要求が受理済みの場合があるため、送信前に回数を消費します。202 Acceptedは処理開始の受付であり、残高更新の完了ではありません。最終更新は口座の `last_aggregated_success` を表示し、要求ボタンを押した時刻で置き換えません。再認証が必要な口座やメンテナンス状態は成功扱いしません。[更新要求の公式制限](https://docs.link.getmoneytree.com/reference/post-link-profile-refresh)。

401は再認証、403はscope不足、429は制限、503はメンテナンスとして扱います。ネットワーク失敗とCORS拒否をFetchで正確に区別できない場合は「通信または接続設定の確認が必要」とし、サーバーの生のエラー内容や金融情報を表示しません。取得失敗時に保存済みのデータを消しません。

ローカル接続解除 `disconnect()` と、Moneytreeでの同意撤回 `revokeAuthorization()` は区別します。後者は公式 `POST /link/profile/revoke.json` の202を確認した後に端末の資格情報を削除します。同意撤回に失敗した場合は再試行できるよう資格情報を残し、成功と表示しません。単なる `/oauth/revoke` は同意全体の撤回と同じ扱いにしません。[profile revoke](https://docs.link.getmoneytree.com/reference/post-link-profile-revoke)、[token revokeの注意](https://docs.link.getmoneytree.com/reference/post-oauth-revoke)。

## 金融機関の確認結果

公式の金融機関一覧の公開データで下記の候補を確認しました。実際の連携可否は、契約、対象の商品、利用者の認証、提供元の最新ステータスによります。Paceは取得した一覧のstatus/status_reasonを優先します。[Moneytreeの金融機関ディレクトリ](https://institutions.moneytree.jp/)。

| 候補 | entity key | 確認結果 |
| --- | --- | --- |
| 横浜銀行 | `yokohama_bank` | active |
| 三菱UFJ銀行 | `mufg_bank` | active |
| 三井住友カード | `smbc_card` | active |
| MUFGカード系 | `mufg_card` / `mufg_visa_card` | active。カードの商品名を確認して選択 |
| モバイルSuica | `mobile_suica` | active |

Apple Payは決済の経路です。独立した口座残高を作らず、元のカード/Suicaの明細を使います。

## PayPayとSuicaのチャージ

現時点のPayPayはLevel Cです。Paceで消費者の残高・支払履歴を自動取得できると確認できていません。MoneytreeもPayPayウォレット履歴の非対応を案内しています。PayPay銀行やPayPayカードの対応はPayPayウォレットそのものの対応と混同しません。[Moneytreeの公式FAQ](https://help.getmoneytree.com/ja/articles/3728396-paypay%E3%82%84%E6%A5%BD%E5%A4%A9%E3%83%9A%E3%82%A4%E3%81%AA%E3%81%A9%E3%81%AB%E5%AF%BE%E5%BF%9C%E3%81%97%E3%81%A6%E3%81%84%E3%81%BE%E3%81%99%E3%81%8B)。

PayPayのMerchantTopUpは加盟店が利用者へPayPay残高を付与するための契約付きAPIです。利用者が自分の銀行口座からチャージする一般PWA向けAPIとして使いません。PayPay Mini Appの `getBalance` / `topup` もPayPayのMini App環境の機能であり、Safari/Chrome上のPaceから使えることを意味しません。[MerchantTopUp](https://www.paypay.ne.jp/opa/doc/jp/v1.0/merchant_topup)、[Mini App機能](https://developer.paypay.ne.jp/miniapp/docs/apireference/functionalities)。

PayPay公式ヘルプに掲載されている `paypay://passbook` と `paypay://user/transactionhistory` は、それぞれウォレット・取引履歴を開くリンクとして使えます。ボタンは「PayPayのウォレットを開く」とし、「チャージ完了」とは表示しません。存在しない金額指定のチャージURIは作りません。アプリがない端末では公式ヘルプから通常の操作へ誘導します。[公式ウォレット案内](https://paypay.ne.jp/help/c0140/)。

SuicaはMoneytreeの取得候補ですが、Paceから直接チャージする公開API・汎用deep linkは確認できません。WalletまたはモバイルSuicaで本人が操作します。Apple公式の手順はWalletの対象カード→チャージ→金額選択→カードの認証です。Paceからは「Walletでチャージする方法」を開き、完了後に振替を記録・照合します。[Apple公式Suicaの利用・チャージ](https://support.apple.com/ja-jp/HT207154)。

## オフライン、通知、レシート

金融APIの取得はオンライン時のみです。オフラインでは保存済み残高と取得時刻を表示し、未取得の情報を最新と表示しません。

iOS/iPadOS 16.4以降のホーム画面WebアプリはWeb Pushを利用できますが、操作による通知許可、Service Worker、購読、Pushを送るサーバーが必要です。Paceが閉じている間、端末内JavaScriptのタイマーだけで予定時刻に通知できるとは約束しません。サーバーを設けない構成では、アプリ内のリマインダーとカレンダー登録を使います。[WebKitのSafari 16.4仕様](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)。

レシートOCRはTesseract.jsのWorker、WASM core、日本語/英語モデルを同一originに配置し、外部のOCR APIやCDNへ画像・本文を送信しません。Workerの `cacheMethod: "none"` を使い、画像はメモリ内で処理します。静的なOCRモデルだけをオフライン用cacheへ入れ、画像/金融明細/資格情報はcacheしません。初回はモデル取得が必要なので、オフライン利用可能となるまで状態を示します。認識した店名・合計・日時等は候補として編集・確認してから支出入力へ反映します。[Tesseract.js公式API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md)。

## 検証と限界

providerテストは架空のデータで、PKCE、state/redirect検証、URLの認証情報除去、トークン更新の排他制御、resource serverの拒否、金額符号/通貨、更新要求と取得時刻の区別、制限、同意取消の失敗・成功、オフライン、同じ明細IDの未確定→確定を検証します。

別タブの全消去・再接続中に遅れて届いたOAuth応答、トークン更新、口座情報を拒否し、資格情報を再生成しない回帰テストを含みます。レシートは実ブラウザ上の日本語・英語OCR、候補の編集、キャンセル、1分のタイムアウト、外部通信なし、初回取得後のオフライン読取り、画像保存の明示選択を検証します。旧1.3.0から2.0.0への更新は既存の全テーブルを独立したAES-GCM復号で照合し、PIN・入力途中の支出・オフライン復号・更新時の入力保護を確認します。

実際のMoneytree契約・クライアント・利用者の認証情報は未設定です。実口座の取得、本番CORS、取消後の提供元処理、PayPayの契約付きデータ取得は未検証です。公開一覧と公式仕様の確認を、実口座の接続テストと見なしていません。
