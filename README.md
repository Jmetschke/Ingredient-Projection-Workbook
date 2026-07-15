# Ingredient Projection App

Database-backed production planning app for creating production schedules, BOMs, and ingredient projections.

## Local setup

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Render / Turso environment

Set these environment variables in Render:

```bash
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_DATABASE_TOKEN=your-token
TURSO_CALENDAR_URL=libsql://your-readonly-calendar-database.turso.io
TURSO_CALENDAR_TOKEN=your-calendar-token
```

The app also supports local development with:

```bash
DATABASE_PATH=./data/planning.db
```

`TURSO_CALENDAR_URL` and `TURSO_CALENDAR_TOKEN` power the read-only RL Scheduled Batches tab. If the source table cannot be auto-detected, set `TURSO_CALENDAR_TABLE` to the table or view name.

The schema is created automatically on startup. Production schedules, BOMs, and ingredient projections are driven by app data entered through the planner, formula manager, and inventory screens.

## Manual inventory audit entries

The Ingredient Forecast tab includes a manual inventory form with mutually exclusive **Add to Current QTY** and **Update / Override QTY** fields. Add increases the ingredient's current balance. Update replaces the existing balance, including uploaded inventory data for that ingredient, and the result becomes the beginning quantity used by future forecast deductions. Every manual entry records its previous and resulting quantities in `manual_inventory_adjustments`.

## Transferring a BOM between services

Each Render service can export the selected Formula Manager BOM as a versioned `.bom.json` file. Import that file from the Formula Manager in the other service. Database IDs are never transferred; production batches and ingredients are matched case-insensitively by name.

Import behavior:

- creates the production batch if it is missing;
- transfers the product category and Batch QTY;
- creates missing master ingredients and transfers their BOM UOM/type;
- replaces only the imported production batch's existing BOM;
- leaves schedules, inventory quantities, costs, and unrelated BOMs unchanged.

Transfer files use this structure:

```json
{
  "format": "ingredient-projection-bom",
  "version": 1,
  "exported_at": "2026-07-15T12:00:00.000Z",
  "source": "https://ingredient-projection-workbook.onrender.com",
  "bom": {
    "product": {
      "name": "Alpha Chunk - 1pk",
      "sku": null,
      "category": "Hijnx",
      "batch_size": 7500
    },
    "ingredients": [
      {
        "name": "Green Apple Pucks",
        "purchase_uom": "grams",
        "ingredient_type": "Hijnx",
        "quantity_per_unit": 250,
        "quantity_uom": "grams",
        "notes": null
      }
    ]
  }
}
```

## Health check

Use `/api/health` for a Render health check.
