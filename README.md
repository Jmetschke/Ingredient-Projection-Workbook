# Ingredient Projection Workbook App

Database-backed production planning app for the Elevated Organics planning workbook.

## Local setup

```bash
npm install
npm run import -- "/path/to/Elevated Organics Production Planning Workbook v031225.xlsx"
npm start
```

Open `http://localhost:3000`.

## Render / Turso environment

Set these environment variables in Render:

```bash
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_DATABASE_TOKEN=your-token
```

The app also supports local development with:

```bash
DATABASE_PATH=./data/planning.db
```

The schema is created automatically on startup. To seed data into Turso, run the import script in an environment with `TURSO_DATABASE_URL` and `TURSO_DATABASE_TOKEN` set:

```bash
npm run import -- "/path/to/workbook.xlsx"
```

## Health check

Use `/api/health` for a Render health check.
