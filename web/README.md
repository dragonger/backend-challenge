# Painel web (opcional)

Painel de demonstração da API de wagering: Vite + React + TypeScript, gerenciado com Bun. É um extra, fora do escopo avaliado.

## Como rodar

1. Suba a infraestrutura e a API (ver o [README da raiz](../README.md)): `docker compose up -d` e, em `api/`, `bun run migration:up` e `bun run start`.
2. Em `web/`:

```bash
bun install
bun run dev        # http://localhost:5173
```

O Vite encaminha `/api/*` para a API removendo o prefixo (`/api/health/ready` vira `/health/ready`), então não há CORS. Para apontar para outra API: `VITE_API_URL=http://localhost:3001 bun run dev` (ou um arquivo `web/.env`, ver `.env.example`).

## Scripts

| Script | O que faz |
|---|---|
| `bun run dev` | Servidor de desenvolvimento na porta 5173 |
| `bun run build` | Typecheck e build de produção em `dist/` |
| `bun run preview` | Serve o build (com o mesmo proxy) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | `tsc --noEmit` e `oxlint` |

## Notas

- Valores monetários são sempre strings; o painel só formata o texto, nunca converte para número.
- Carteiras e transações enviadas ficam no `localStorage` do navegador (só ids e resumos), para sobreviver a um refresh.
