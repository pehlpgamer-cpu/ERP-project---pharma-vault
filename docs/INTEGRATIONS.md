# Integrating other systems

Pharma Vault exposes one read-only endpoint for other systems. It tells a caller which medicines the
pharmacy carries. It never returns prices, costs or stock, and it cannot change anything.

## Medicine search

```
GET /api/v1/integrations/medicines?q=<text>&limit=<1-50, default 20>
Authorization: Bearer <INTEGRATION_API_TOKEN>      (or:  X-API-Key: <INTEGRATION_API_TOKEN>)
```

`q` matches the product name, generic name or brand name by contains, ignoring case. Only active
products with a sellable unit are returned.

```json
{
  "data": [
    {
      "sku": "SKU-1",
      "name": "Biogesic 500 mg",
      "genericName": "Paracetamol",
      "brandNames": ["Biogesic"],
      "strength": "500 mg",
      "dosageForm": "Tablet",
      "requiresPrescription": false,
      "status": "ACTIVE"
    }
  ]
}
```

| Status | Meaning |
| --- | --- |
| 200 | `data` is the list (empty when nothing matches) |
| 401 | token missing or wrong |
| 422 | `q` missing or `limit` out of range |
| 503 | `INTEGRATION_API_TOKEN` is not set on the ERP: the endpoint is off |

The token opens this endpoint only; every other `/api/v1` route still needs a signed-in user.

## Turn it on

1. Generate a token: `openssl rand -hex 32` (32 or more visible characters, no spaces).
2. Put it in the ERP's environment as `INTEGRATION_API_TOKEN` (`.env.production` for the Docker
   stack, then `pvc up -d`). The ERP refuses to start with a short or malformed token.
3. Rotate it by changing both sides. Keep the token out of git, tickets and chat.

## Pharmacy queue (QUE)

Add to the queue app's `.env` (field names follow its `docs/erp-inventory-integration.md`):

```dotenv
ERP_API_BASE_URL=https://erp.example.com
ERP_MEDICINE_SEARCH_PATH=/api/v1/integrations/medicines?q={query}
ERP_API_TOKEN=<the same token>
ERP_MEDICINE_ITEMS_PATH=data
ERP_MEDICINE_NAME_PATH=name
ERP_MEDICINE_ALIAS_PATHS=genericName,brandNames
ERP_MEDICINE_ACTIVE_PATH=status
ERP_MEDICINE_ACTIVE_VALUE=ACTIVE
```

The queue sends `Authorization: Bearer <token>` by default, which this endpoint accepts. If the
queue runs on the same Docker host, use the ERP's internal address instead of the public one: with
both `compose.prod.yaml` stacks on the `pharmacy-shared` network that is `http://pharma-vault:3000`,
and the queue's `compose.prod.yaml` already sets it and the field mapping above, so its
`.env.production` only needs `ERP_API_TOKEN`. Test it from the queue's project root with the
command in its guide; a match prints the ERP name, no match prints `null`.
