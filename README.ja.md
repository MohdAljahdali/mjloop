# mjloop

> Claude Code のための検証済み開発サイクル。

[![Claude Code プラグイン](https://img.shields.io/badge/Claude_Code-plugin-6B5CE7?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](README.md) · [العربية](README.ar.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · **日本語** · [한국어](README.ko.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md)

**コーディングエージェントに、完了したことを証明させます。**

`mjloop` は、エージェントの作業を制限付きの証拠ベースのサイクルへ変える
Claude Code プラグインです。リーダーがタスクに適したエージェントを選び、
隔離されたコンテキストで実行し、エンジンがプロジェクト固有の検証コマンドの
結果を記録した後にだけ成功を受け入れます。

`依頼 → トラック → 隔離エージェント → エンジン検証 → 証拠付き結果`

> [!IMPORTANT]
> 現在 `mjloop` が対応しているのは Claude Code です。他のコーディング
> エージェント用アダプターは、まだ公開版プラグインに含まれていません。

## なぜ mjloop なのか？

- **自信ではなく証拠** — 成功という主張で、失敗または欠落したエンジンの
  証跡を上書きできません。
- **エージェントが書き換えられない状態** — 実行状態と派生マニフェストは
  MCP サーバーが管理します。
- **制限された自律性** — サイクル上限、停滞、同一エラーの繰り返しを検知して
  進まない作業を停止します。
- **仕事に合うワークフロー** — 短い編集、複数サイクルの実装、再現を先に行う
  修正、レビュー付き計画を選べます。

## クイックスタート

Claude Code、Node.js 20 以降、Git が必要です。

```bash
git clone https://github.com/MohdAljahdali/mjloop.git
cd mjloop/engine
npm install
npm run build
cd ..
claude plugin marketplace add "$PWD"
claude plugin install mjloop@mjloop
```

次に、対象プロジェクトで Claude Code を開き、実行します。

```text
/mjloop:init
/mjloop:edit 登録フォームに入力検証を追加する
```

> [!NOTE]
> MCP サーバーとフック CLI は `engine/dist/` から実行されるため、新しい
> クローンは一度ビルドする必要があります。詳細は[インストールガイド](docs/install.md)を参照してください。

## 適切なトラックを選ぶ

| コマンド | 最適な用途 | 組み込みルール |
|---|---|---|
| `/mjloop:edit <依頼>` | 小さく明確な変更 | 1 サイクル。範囲が広がればエスカレーション |
| `/mjloop:build <目標>` | 機能や大きな実装 | 完了または停止まで検証済みサイクルを反復 |
| `/mjloop:fix <問題>` | 不具合やリグレッション | 修正を受け入れる前に障害を再現 |
| `/mjloop:plan <アイデア>` | アイデアを実装可能なストーリーにする | ストーリー作成前に適合確認と承認 |

`/mjloop:status` で実行を確認し、`/mjloop:resume` で再開、`/mjloop:stop` で停止、
`/mjloop:web` でブラウザーのコックピットを開きます。

## サイクルでは何が起きる？

1. リーダーがトラックからチームを構成し、任意の専門家を含めた理由または省いた理由を記録します。
2. 契約で制約されたエージェントが、隔離コンテキストで明確な責務を担います。
3. エンジンが開始時に固定した検証コマンドを実行し、完全なログをエージェントの説明とは別に保存します。
4. 検証失敗は次のサイクルへの入力となり、有効な合格証跡で実行を終了できます。
5. 上限到達、停滞、同じ失敗の繰り返しを安全機構が停止します。

## 実行だけではありません

- **機能ディスカバリー** — `mjloop-feature-discovery` は一度に一つの判断を尋ね、
  人が承認できるブリーフで停止します。
- **プロジェクト対応ルーティング** — 承認済みのコンポーネントマップとスキルが、
  進行中の実行を変えずに固定ロールを導きます。
- **ブラウザーコックピット** — `/mjloop:web` で実行、計画、ストーリー、証拠、
  設定、メモリを確認できます。
- **拡張可能なトラック** — `/mjloop:add` でエージェント、スキル、トラックを追加できます。

> [!TIP]
> 実際の小さな変更に `/mjloop:edit` を使うところから始めてください。複数
> サイクルのコストなしに検証契約を確認できる最短ルートです。

## 次に読むもの

- [mjloop が存在する理由](docs/about.md)
- [インストールとトラブルシューティング](docs/install.md)
- [コマンド、設定、ワークフロー](docs/usage.md)
- [アラビア語ドキュメント](docs/about.ar.md)

`mjloop` が身近な問題を解決するなら、他の開発者にも見つけてもらえるよう
リポジトリへのスターを検討してください。
