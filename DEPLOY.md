# 🍦 シャトレーゼ アイス総選挙 2026

## 🚀 オンライン公開（デプロイ）手順

このアプリは外部ライブラリ不要（Pure Node.js + SSEリアルタイム配信）で動くため、無料クラウドサービスに簡単にデプロイできます。

最も手軽でずっと無料で動かせる **Render** または **Glitch** での手順をご紹介します。

---

### 方法 1: Render.com（おすすめ・無料）

GitHub経由で無料公開できます（HTTPS対応・ずっと公開可能）。

1. **GitHubにリポジトリを作成**
   ```bash
   cd /Users/nishimuranaoki/Downloads/Miacis/ice-election
   git init
   git add .
   git commit -m "feat: initial ice election app"
   # GitHubで新しいリポジトリを作成後、以下を実行
   git remote add origin https://github.com/<あなたのユーザー名>/ice-election.git
   git branch -M main
   git push -u origin main
   ```

2. **Render にログイン・連携**
   - [Render.com](https://render.com/) にアクセスし、GitHubアカウントでログイン
   - **「New +」** -> **「Web Service」** を選択
   - 作成した `ice-election` リポジトリを選択

3. **設定を入力してデプロイ**
   - **Name**: `chateraise-ice-election`（好きな名前）
   - **Language**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
   - **Environment Variables**:
     - `SUPABASE_URL`: SupabaseのProject URL
     - `SUPABASE_KEY`: Supabaseのanon public key
     ※設定方法は [SUPABASE_SETUP.md](file:///Users/nishimuranaoki/Downloads/Miacis/ice-election/SUPABASE_SETUP.md) を参照
   - **「Deploy Web Service」** をクリック！

数分で `https://chateraise-ice-election.onrender.com` のような専用公開URLが発行されます！🎉
（Supabaseを設定することで、サーバーがスリープ・再起動してもデータが消えなくなります）

---

### 方法 2: Glitch（GitHub不要・ブラウザだけで即公開）

1. [Glitch.com](https://glitch.com/) にアクセス
2. **「New Project」** -> **「glitch-hello-node」** を作成
3. 左サイドバーのファイル一覧から `index.html` と `server.js` の中身をコピー＆ペーストするだけで即座に公開URLが発行されます！

---

### 💻 ローカルでの起動コマンド

```bash
cd /Users/nishimuranaoki/Downloads/Miacis/ice-election
npm start
```
