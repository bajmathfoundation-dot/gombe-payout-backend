# Gombe Football Payout Backend

Node.js backend that talks to Paystack Transfers API and receives webhooks.

## Endpoints

- `GET /` — Health check
- `GET /api/balance` — Check Paystack balance (admin key required)
- `POST /api/pay-withdrawal` — Send money to a user (admin key required)
- `POST /webhook/paystack` — Receive Paystack webhooks

## Environment Variables

| Variable | Description |
|---|---|
| `PAYSTACK_SECRET` | Your Paystack secret key (`sk_test_` or `sk_live_`) |
| `ADMIN_API_KEY` | Random string protecting admin endpoints |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase service account JSON (as string) |
| `PORT` | Server port (Render sets this automatically) |

## Deployment (Render)

See SETUP_RENDER.md