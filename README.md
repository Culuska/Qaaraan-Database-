# Qaaraan Database — Vercel Deployment

## Faylasha
- `index.html` — app-ka oo dhan (frontend)
- `api/data.js` — serverless function (Upstash Redis storage)
- `package.json` — dependencies

## Tallaabooyinka (GitHub → Vercel)

### 1. Samee GitHub repo
1. Tag github.com → **New repository**
2. Magac u geli (tusaale `qaaraan-database`)
3. Dooro **Private** (talo: private, maadaama uu leeyahay xog lacageed)
4. **Create repository**

### 2. Ku shub faylasha
Habka ugu fudud — GitHub web UI:
1. Gudaha repo-ga cusub, riix **"uploading an existing file"**
2. Jiid (drag) saddexda fayl: `index.html`, `package.json`, iyo folder-ka `api` (oo leh `data.js` gudihiisa)
3. **Commit changes**

### 3. Ku xidh Vercel
1. Tag vercel.com → **Add New → Project**
2. **Import** repo-gaaga GitHub ah (`qaaraan-database`)
3. Iska daa settings-ka default-ka ah → **Deploy**
4. Sug ilaa uu dhammaado (~1 daqiiqo)

### 4. Ku dar Storage (Neon — Postgres dhab ah)
1. Gudaha **Project-kaaga** Vercel → tab **"Storage"**
2. **Browse Marketplace** → raadi **"Neon"**
3. **Add Integration** → **Create** (dooro region kuu dhow)
4. Waxay si otomaatig ah u dartaa environment variable **DATABASE_URL**
5. Tables-ka (members, transactions, disbursements, iwm) si otomaatig ah ayaa loo abuuraa marka app-ku markii ugu horreysa la furo

### 5. Dib u deploy garee
1. Gudaha Vercel Project → tab **"Deployments"**
2. Dooro deployment-kii ugu dambeeyay → **"..." → Redeploy**
   (Kani waa lama huraan si environment variables-ka cusub ay u shaqeeyaan)

### 6. Xidh domain-kaaga
1. Project Settings → **Domains**
2. Ku dar `xalane.vercel.app` (ama domain-kaaga gaarka ah)

## Dhammaystiran!
Marka la dhammeeyo, app-kaagu wuxuu ku shaqeyn doonaa `https://[domain-kaaga]`, isaga oo kaydinta xogtu ay ku jirto Upstash Redis (ma aha Claude.ai).

**Fiiro:** Marka ugu horreysa la furo, waxaad samayn doontaa account-ka admin-ka ugu horreeya (Osman) sida caadiga ahayd.
