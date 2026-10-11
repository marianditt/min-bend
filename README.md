# min-bend

A minimal **React + TypeScript** hello-world app built with [Vite](https://vite.dev/), deployed to **GitHub Pages**.

## Local development

```bash
npm install      # install dependencies
npm run dev      # start dev server at http://localhost:5173/
npm run build    # type-check + production build into dist/
npm run preview  # preview the production build
npm run lint     # run oxlint
```

## Project structure

```
.github/workflows/deploy.yml   # CI: build + deploy to GitHub Pages
public/                        # static assets copied as-is (.nojekyll, favicon)
src/main.tsx                   # React entry point
src/App.tsx                    # the hello world component
src/index.css                  # global styles
index.html                     # HTML shell
vite.config.ts                 # Vite config (base path for GitHub Pages)
```

## How deployment works

On every push to `main`, `.github/workflows/deploy.yml`:

1. Installs dependencies (`npm ci`)
2. Builds the site (`npm run build` → `dist/`)
3. Uploads `dist/` as a Pages artifact
4. Publishes it via `actions/deploy-pages`

The site is served at **https://marianditt.github.io/min-bend/**

Because it is a *project* page (not a user page), all asset URLs are prefixed
with `/min-bend/`. This is configured via `base` in `vite.config.ts`.

## One-time GitHub setup

1. **Settings → Pages → Build and deployment → Source = "GitHub Actions"**
2. Push to `main` (or run the workflow manually from the **Actions** tab)
3. The first successful run publishes the site
