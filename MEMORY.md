# MEMORY — backend

Always-remember facts for working in this package. Full context: `backend/CLAUDE.md` (indexed by point number — see root `AGENTS.md`).

- **Single process, two roles.** `server.ts` starts Express AND `startDianWorker()` (BullMQ). No separate worker process needed. `/health` covers both.
- **TypeScript config is non-default.** `module` and `moduleResolution` must both be `"node16"` (TS5110 if mismatched). No `baseUrl` — `paths` are relative to `tsconfig.json`.
- **Flat `package.json` is intentional.** `@types/*`, `typescript`, `ts-node`, `nodemon` live in `dependencies` (not `devDependencies`) because Render runs `npm install` in production mode and skips devDeps. Moving them back breaks the build with TS7016 floods.
- **Dual auth scheme.** Admin/manager = JWT (`admin_token` cookie or `Authorization`). Cashier = session-cookie PIN (`cashier_token`). Tokens are httpOnly — never `localStorage`. See `backend/CLAUDE.md` points 6 and 13.
- **Timezone is `America/Bogota` everywhere.** `backend/src/utils/dateRange.ts` uses explicit `-05:00` for day boundaries. Do not switch to UTC.
- **All async route handlers must be wrapped in `asyncHandler`.** An unwrapped throw leaves the request hanging (point 1).
- **DIAN service is mocked by design.** `backend/src/services/dianService.ts` has 5% random failure and fake CUFE/QR. Don't "fix" it — it's intentional for testing backoff. Real providers live in `services/dian/providers/`, selected via `ELECTRONIC_INVOICE_PROVIDER`.
- **Path alias:** `@/foo` → `src/foo`. No `baseUrl`, just relative paths in `tsconfig.json`.
- **Test runner:** `node --test test/*.test.cjs` (plain CommonJS, no transpilation, no Jest/Vitest). `test:*` scripts are manual integration helpers, not tests.
- **Env vars:** documented in `docker-compose.yml` and root `CLAUDE.md` — `backend/.env.example` does NOT exist.
- **Cron / queues:** DIAN queue reconciliation runs every `RECONCILE_INTERVAL_MINUTES` (5 default). Sheets sync is a separate worker (`npm run worker:sheets`) needing `GOOGLE_SHEETS_WEBHOOK_URL`.
- **Stock writes from POS are gated by branch.** Stock deductions on sales validate the cashier's branch — see `posController.createSale`.