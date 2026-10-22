# Fichário de Receitas — contexto para agentes e desenvolvedores

PWA estático (HTML + CSS + JS puro, sem build, sem framework, sem backend). Livro de receitas para uma cliente, instalado no celular dela, com cópia no Google Drive dela.

## Regras que não podem ser quebradas

1. **Sem build e sem dependências.** Os arquivos são servidos como estão. Não introduzir npm, bundler ou framework.
2. **Toda release precisa aumentar `VERSION` em `sw.js`** (`fichario-vN` → `fichario-vN+1`). Sem isso o celular continua com os arquivos antigos em cache.
3. **`config.js` é o único arquivo de configuração** (`GOOGLE_CLIENT_ID`). Com o ID vazio o app funciona só local, sem Drive.
4. **O `redirect_uri` do OAuth é a URL base do app, com barra final** (`new URL(".", location.href).href`). Precisa ser idêntico ao cadastrado no Google Cloud, senão dá `redirect_uri_mismatch`.
5. **Escopo do Google: apenas `openid email https://www.googleapis.com/auth/drive.file`.** Não pedir escopos mais amplos (exigem verificação restrita e deixam de ser seguros para a cliente).
6. **Local primeiro.** Tudo grava no IndexedDB (banco `fichario`, stores `kv` e `photos`) antes de ir ao Drive. O Drive é cópia, não banco principal (o token implícito dura ~1 h e não renova).
7. **Não apagar registros de verdade ao sincronizar.** Receitas apagadas viram tombstone (`{id, deleted:true, updatedAt}`); fotos removidas vão para a lixeira do Drive.
8. **O endereço do app não pode mudar.** Hospedado no GitHub Pages da conta do Gabriel (repositório `fichario`); o Google Cloud e o Drive são da conta da dona. Renomear a conta ou o repositório muda a origem: o app instalado quebra, o IndexedDB fica preso na origem antiga e o OAuth dá `redirect_uri_mismatch`.

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html` | Estrutura e ícones SVG (trecho entre `<!--APP-->` e `<!--/APP-->`) |
| `styles.css` | Design tokens, modo escuro, faixas coloridas por categoria, folhas inferiores, álbum e lightbox |
| `app.js` | Toda a lógica: Store (IndexedDB), modelo de dados, merge, OAuth, Drive, fotos, UI |
| `config.js` | ID do cliente Google e nome do arquivo no Drive |
| `sw.js` | Service worker (cache, funciona offline) |
| `manifest.webmanifest`, `icons/` | Instalação como app |
| `LEIAME.md` | Guia de publicação e configuração do Google Cloud |

## Modelo de dados

`{ v:1, recipes:{ [id]: recipe }, cats:{ list:[...], updatedAt } }`

Receita: `id, title, category, icon, cover{id,w,h,addedAt,driveId}|null, ingredients[], steps[], videoUrl, timeMin, servings, calories, tags[], notes, fav, photos[{id,w,h,caption,addedAt,driveId}], createdAt, updatedAt`

Categoria: `{id, name, color:k1..k8, icon}`. Ícones disponíveis em `ICON_NAMES` (`app.js`), desenhados como `<symbol id="c-…">` no `index.html`. Receita sem `icon` usa o da categoria; sem `cover`, o cartão mostra o ícone. A capa vai para o Drive junto com as fotos do álbum.

Merge: vence o `updatedAt` mais recente por receita; categorias por `cats.updatedAt`.

## Testar localmente

```
python3 -m http.server 8080
```

Abrir `http://localhost:8080/`. O service worker funciona em `localhost`. Para testar o login do Google localmente, cadastrar também `http://localhost:8080` (origem) e `http://localhost:8080/` (redirecionamento) no cliente OAuth. Remover depois, se não for mais usado.

## Publicar

Commit e push para o repositório; o GitHub Pages publica sozinho. Lembrar de aumentar `VERSION` em `sw.js`.

## Limitações conhecidas

- Login do Google expira em ~1 h (selo amarelo "Toque para salvar no Drive"); dados seguem salvos no celular.
- iOS pode apagar dados do site se o app ficar muito tempo sem uso; o backup no Drive é o que protege.
- Limite de 30 fotos por receita, redimensionadas para 1600 px.
