# Fichário de Receitas — instalação passo a passo

O app é hospedado pelo Gabriel (GitHub dele). **As receitas, as fotos e o acesso ao Google Drive são da dona do app** e ficam na conta Google dela. Tudo é gratuito e não pede cartão de crédito.

**Como funciona, em uma frase:** as receitas e fotos ficam guardadas no celular e uma cópia vai para o Google Drive da própria dona. Não existe servidor nem mensalidade. O GitHub do Gabriel só entrega os arquivos do app, sem ver nenhuma receita.

## O que você precisa ter em mãos

- O e-mail Gmail e a senha da dona do app.
- Um computador (os passos 2 e 3 são mais fáceis no computador) e o celular.
- Cerca de 30 minutos na primeira vez, com o Gabriel ao lado (ou em chamada de vídeo).
- Um caderno ou bloco de notas seguro para anotar o nome do projeto no Google Cloud.

> Importante: os passos 1 a 4 só precisam ser feitos **uma vez**. Depois, o dia a dia é só abrir o app no celular.

---

## Passo 1 — Publicar o app (feito pelo Gabriel)

O Gabriel publica o app no GitHub dele. O endereço do app é:

`https://gabrielgneder.github.io/fichario/`

Teste: abra o endereço no navegador. O app deve aparecer (ainda sem o Drive conectado).

---

## Passo 2 — Criar o acesso ao Google Drive

Aqui você autoriza o app a guardar a cópia das receitas no seu Drive.

1. Acesse <https://console.cloud.google.com/> com o Gmail da dona. Se pedir para aceitar os termos, aceite (não precisa cadastrar cartão).
2. No topo, clique no seletor de projetos → **Novo projeto**.
   - **Nome:** `Fichario Receitas`
   - Clique em **Criar** e depois selecione o projeto criado.
3. No menu (☰) → **APIs e serviços** → **Biblioteca**. Procure **Google Drive API** → **Ativar**.
4. No menu (☰) → **Google Auth Platform** (ou **APIs e serviços → Tela de permissão OAuth**). Se aparecer **Primeiros passos**, clique e preencha:
   - **Nome do app:** `Fichário de Receitas`
   - **E-mail de suporte:** o Gmail da dona
   - **Público:** **Externo**
   - **E-mail de contato:** o Gmail da dona
   - Aceite os termos e clique em **Criar**.
5. Em **Público (Audience)** → **Usuários de teste** → **Add users** → escreva o **Gmail da dona** → **Salvar**.
   *(Sem isso o Google bloqueia o login.)*
6. Em **Acesso a dados (Data access)** → **Adicionar ou remover escopos**. Marque ou cole estes três e salve:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/drive.file`
7. Em **Clientes (Clients)** → **Criar cliente**:
   - **Tipo de aplicativo:** Aplicativo da Web
   - **Nome:** `Fichario web`
   - **Origens JavaScript autorizadas** → Adicionar URI: `https://gabrielgneder.github.io`
     *(sem barra no final e sem `/fichario`)*
   - **URIs de redirecionamento autorizados** → Adicionar URI: `https://gabrielgneder.github.io/fichario/`
     *(com a barra no final)*
   - **Criar**.
8. O Google mostra o **ID do cliente**, um texto longo que termina em `.apps.googleusercontent.com`. **Copie** (botão de copiar ao lado).

> Os dois endereços precisam estar **idênticos** aos de cima, senão o login dá erro.

---

## Passo 3 — Colocar o ID no app

Envie o **ID do cliente** para o Gabriel (pode ser por mensagem; esse ID não é senha). Ele coloca o ID no app e publica a atualização. Espere a confirmação dele, que leva poucos minutos.

---

## Passo 4 — Acesso do Gabriel ao Google Cloud (opcional)

Só é necessário se o Gabriel for ajustar o login do Google no futuro. Você continua sendo a dona; ele só ajuda. Você pode remover o acesso quando quiser.

- Menu (☰) → **IAM e administrador → IAM → Conceder acesso** → e-mail do Gabriel → papel **Editor**.

---

## Passo 5 — Instalar no celular e conectar o Drive

1. Abra o endereço do app no celular:
   - **iPhone:** no **Safari** (precisa ser o Safari). Toque em **Compartilhar → Adicionar à Tela de Início**.
   - **Android:** no **Chrome**. Toque em **⋮ → Instalar app** (ou **Adicionar à tela inicial**).
2. Abra o app pelo **ícone novo** na tela inicial.
3. Toque na engrenagem (**Ajustes**) → **Conectar Google Drive**.
4. Escolha o Gmail da dona.
5. Vai aparecer **"O Google não verificou este app"**. É esperado, porque o app é seu e está em modo de teste. Toque em **Avançado → Acessar Fichário de Receitas (não seguro)** e depois em **Continuar/Permitir**.
6. No topo do app deve aparecer o selo **"No Drive"** com a hora. Pronto.

### Teste final (não pule)

1. Cadastre uma receita de teste com **2 fotos**.
2. Aguarde o selo mostrar "No Drive".
3. Abra o Google Drive da dona: devem existir o arquivo `Fichário de Receitas (dados).json` e a pasta `Fichário de Receitas — fotos`.
4. Apague a receita de teste.

---

## Uso no dia a dia

- **+** (botão do meio) ou **+ Adicionar** dentro de uma faixa cadastra receita.
- Ingredientes e passos: um por linha. Dá para colar listas prontas de sites.
- **Álbum de fotos** dentro da receita: para fotos do ponto da massa, do passo a passo etc. Até 30 por receita.
- **Buscar:** *Tudo* procura em nome, ingredientes e etiquetas. *Tenho em casa* aceita vários ingredientes separados por vírgula e mostra o que dá para fazer com eles.
- **Selo amarelo "Toque para salvar no Drive":** o login do Google expira (em cerca de 1 hora). As receitas estão salvas no celular; um toque reconecta e envia a cópia.

## Se algo der errado

| O que aparece | Causa provável | O que fazer |
|---|---|---|
| `redirect_uri_mismatch` | O endereço de redirecionamento no Google Cloud não é idêntico ao do app | Passo 2, item 7: conferir `https://gabrielgneder.github.io/fichario/` com a barra final |
| `access_denied` ou "app em teste" | O Gmail não está como usuário de teste | Passo 2, item 5 |
| `origin_mismatch` | Origem JavaScript errada | Passo 2, item 7: deve ser só `https://gabrielgneder.github.io` |
| O botão "Conectar Google Drive" não aparece | O ID ainda não foi colocado no app, ou a atualização ainda está sendo publicada | Passo 3; esperar 2 minutos e fechar e abrir o app |
| Mudanças feitas não aparecem no celular | O celular guardou a versão antiga | Fechar e abrir o app duas vezes, com internet |
| O Google pede permissão de novo depois de alguns dias | Normal em modo de teste | Repetir o passo 5, itens 4 e 5 |

Se travar, tire um print da tela de erro e mande para o Gabriel.

## Cuidados importantes

- **Anote** o nome do projeto no Google Cloud.
- **Não apague** o projeto `Fichario Receitas` no Google Cloud. Se apagar, o app deixa de salvar no Drive.
- **Não apague** o arquivo `Fichário de Receitas (dados).json` nem a pasta de fotos no Drive. É a cópia de segurança.
- **No iPhone**, se o app ficar semanas sem ser aberto, o iOS pode apagar os dados do celular. A cópia no Drive protege, mas só se o Drive estiver conectado desde o começo.
- **Espaço:** as fotos usam espaço do Drive (15 GB grátis). Fotos de 100 receitas com 30 fotos cada podem passar de 1 GB.

---

## Para o Gabriel (manutenção)

Detalhes técnicos, regras e como atualizar estão em `AGENTS.md`. Resumo:

1. Altere os arquivos no Antigravity.
2. Em `sw.js`, aumente `VERSION` (`fichario-v4` → `fichario-v5`).
3. Commit e push para o repositório `fichario` no seu GitHub. O GitHub Pages publica sozinho em 1 a 2 minutos.
4. **Nunca renomeie a conta nem o repositório, e nunca apague o repositório.** O endereço do app mudaria, o app instalado no celular dela pararia de abrir e os dados guardados no celular ficariam presos no endereço antigo (só a cópia do Drive seria recuperável).
