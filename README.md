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

## Health check

Use `/api/health` for a Render health check.
