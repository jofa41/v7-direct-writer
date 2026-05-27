# PDF Direct Writer Web v7 - Render Ready

## Render設定

Build Command:

```text
pip install -r requirements.txt
```

Start Command:

```text
gunicorn app:app
```

## GitHubにアップロードする主なファイル

リポジトリ直下に以下が見えるようにしてください。

```text
app.py
requirements.txt
Procfile
templates/
static/
uploads/
output/
README.md
README_RENDER.md
```

## 注意

uploads/ と output/ は、まず世界公開・動作確認を優先するための一時保存領域です。
