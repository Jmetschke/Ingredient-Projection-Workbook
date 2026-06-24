const state = {
  products: [],
  ingredients: [],
  weeks: [],
  filter: "",
};

const titles = {
  dashboard: ["Dashboard", "Inventory warnings, upcoming production, and purchase timing."],
  production: ["Production Planner", "Editable weekly planned production by SKU."],
  forecast: ["Ingredient Forecast", "Projected usage, receipts, ending inventory, and shortages."],
  inventory: ["Inventory", "Current ingredient setup, cost, lead time, and reorder settings."],
  formulas: ["Formula Manager", "Product-to-ingredient BOM and formula-tab source lines."],
  reports: ["Reports", "Weekly usage, monthly ingredient cost, and product cost summary."],
  import: ["Import / Export", "Load workbook data into the database and export app tables."],
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await res.json();
  if (!payload.ok) throw new Error(payload.error);
  return payload.data;
}

function money(value) {
  return Number(value || 0).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function qty(value) {
  const n = Number(value || 0);
  return Math.abs(n) >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function filteredRows(rows, fields) {
  if (!state.filter) return rows;
  const needle = state.filter.toLowerCase();
  return rows.filter((row) => fields.some((field) => String(row[field] ?? "").toLowerCase().includes(needle)));
}

function table(headers, rows, options = {}) {
  const body = rows.length ? rows.map((row) => {
    const klass = options.rowClass?.(row) || "";
    return `<tr class="${klass}">${headers.map((header) => {
      const raw = typeof header.value === "function" ? header.value(row) : row[header.key];
      const cellClass = [header.numeric ? "numeric" : "", header.className?.(row) || ""].filter(Boolean).join(" ");
      return `<td class="${cellClass}">${raw ?? ""}</td>`;
    }).join("")}</tr>`;
  }).join("") : `<tr><td colspan="${headers.length}">No rows</td></tr>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th class="${h.numeric ? "numeric" : ""}">${h.label}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

async function loadReference() {
  [state.products, state.ingredients, state.weeks] = await Promise.all([
    api("/api/products"),
    api("/api/ingredients"),
    api("/api/weeks"),
  ]);
  fillSelects();
}

function fillSelects() {
  const productOptions = state.products.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  const ingredientOptions = state.ingredients.map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join("");
  document.querySelectorAll("select[name='product_id']").forEach((el) => { el.innerHTML = productOptions; });
  document.querySelectorAll("select[name='ingredient_id']").forEach((el) => { el.innerHTML = ingredientOptions; });
  const filter = document.querySelector("#ingredient-filter");
  filter.innerHTML = `<option value="">All ingredients</option>${ingredientOptions}`;
}

async function renderDashboard() {
  const data = await api("/api/summary");
  document.querySelector("#kpis").innerHTML = Object.entries(data.counts).map(([key, value]) => `
    <div class="kpi"><strong>${value}</strong><span>${key.replace(/^\w/, (c) => c.toUpperCase())}</span></div>
  `).join("");
  document.querySelector("#next-orders").innerHTML = table([
    { label: "Order Week", key: "order_week" },
    { label: "Ingredient", key: "ingredient_name" },
    { label: "Qty", key: "recommended_qty", numeric: true, value: (r) => qty(r.recommended_qty) },
    { label: "Cost", key: "estimated_cost", numeric: true, value: (r) => money(r.estimated_cost) },
  ], filteredRows(data.nextOrders, ["ingredient_name", "order_week"]));
  document.querySelector("#shortages").innerHTML = table([
    { label: "Week", key: "week_start" },
    { label: "Ingredient", key: "ingredient_name" },
    { label: "Ending", key: "ending_qty", numeric: true, value: (r) => qty(r.ending_qty), className: () => "shortage" },
  ], filteredRows(data.shortages, ["ingredient_name", "week_start"]));
  document.querySelector("#upcoming-production").innerHTML = table([
    { label: "Week", key: "week_start" },
    { label: "Product", key: "product_name" },
    { label: "Planned Qty", key: "planned_qty", numeric: true, value: (r) => qty(r.planned_qty) },
  ], filteredRows(data.upcomingProduction, ["product_name", "week_start"]));
}

async function renderProduction() {
  const data = await api("/api/production-plan");
  const plan = new Map(data.plan.map((p) => [`${p.product_id}:${p.week_id}`, p]));
  const rows = filteredRows(data.products, ["name"]);
  const batchForm = document.querySelector("#production-batch-form");
  const batchTypeSelect = batchForm.querySelector("select[name='batch_type']");
  const productSelect = batchForm.querySelector("select[name='product_id']");
  const weekSelect = batchForm.querySelector("select[name='week_id']");

  batchTypeSelect.innerHTML = data.batchTypes.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("");
  weekSelect.innerHTML = data.weeks.map((week) => `<option value="${week.id}">${week.week_start}</option>`).join("");

  function fillProductionProducts() {
    const selectedType = batchTypeSelect.value || data.batchTypes[0];
    productSelect.innerHTML = data.products
      .filter((product) => product.category === selectedType)
      .map((product) => `<option value="${product.id}">${escapeHtml(product.name)}</option>`)
      .join("");
  }

  fillProductionProducts();
  batchTypeSelect.onchange = fillProductionProducts;
  batchForm.onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(batchForm);
    await api("/api/production-batches", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    batchForm.querySelector("input[name='quantity']").value = "";
    await renderProduction();
  };

  const html = `<div class="table-wrap"><table><thead><tr><th>Batch Type</th><th>Product</th>${data.weeks.map((w) => `<th class="numeric">${w.week_start}</th>`).join("")}</tr></thead><tbody>${
    rows.map((product) => `<tr><td>${escapeHtml(product.category || "")}</td><td>${escapeHtml(product.name)}</td>${data.weeks.map((week) => {
      const entry = plan.get(`${product.id}:${week.id}`);
      return `<td class="numeric"><input class="editable plan-input" data-product="${product.id}" data-week="${week.id}" type="number" step="1" value="${entry?.planned_qty || 0}"></td>`;
    }).join("")}</tr>`).join("")
  }</tbody></table></div>`;
  document.querySelector("#production-table").innerHTML = html;
  document.querySelector("#production-batches").innerHTML = table([
    { label: "Created", key: "created_at" },
    { label: "Week", key: "week_start" },
    { label: "Batch Type", key: "batch_type" },
    { label: "Product", key: "product_name" },
    { label: "Quantity", numeric: true, value: (r) => qty(r.quantity) },
  ], filteredRows(data.batches, ["week_start", "batch_type", "product_name"]));
  document.querySelectorAll(".plan-input").forEach((input) => {
    input.addEventListener("change", async () => {
      await api("/api/production-plan", {
        method: "POST",
        body: JSON.stringify({ product_id: input.dataset.product, week_id: input.dataset.week, planned_qty: input.value }),
      });
    });
  });
}

async function renderForecast() {
  const selected = document.querySelector("#ingredient-filter").value;
  const data = await api(`/api/forecast${selected ? `?ingredient=${selected}` : ""}`);
  document.querySelector("#forecast-table").innerHTML = table([
    { label: "Week", key: "week_start" },
    { label: "Ingredient", key: "ingredient_name" },
    { label: "Beginning", numeric: true, value: (r) => qty(r.beginning_qty) },
    { label: "Received", numeric: true, value: (r) => qty(r.received_qty) },
    { label: "Usage", numeric: true, value: (r) => qty(r.required_usage) },
    { label: "Ending", numeric: true, value: (r) => qty(r.ending_qty), className: (r) => r.shortage ? "shortage" : "" },
    { label: "Threshold", numeric: true, value: (r) => qty(r.reorder_threshold) },
  ], filteredRows(data.rows, ["ingredient_name", "week_start"]), { rowClass: (r) => r.shortage ? "warning" : "" });
}

async function renderInventory() {
  const ingredients = await api("/api/ingredients");
  const rows = filteredRows(ingredients, ["name", "purchase_uom"]);
  document.querySelector("#inventory-table").innerHTML = table([
    { label: "Ingredient", key: "name" },
    { label: "UOM", key: "purchase_uom" },
    { label: "Unit Size", numeric: true, value: (r) => inputCell(r, "purchase_unit_size") },
    { label: "Cost/Unit", numeric: true, value: (r) => inputCell(r, "cost_per_unit", "0.000001") },
    { label: "Lead Days", numeric: true, value: (r) => inputCell(r, "lead_time_days", "1") },
    { label: "Reorder Threshold", numeric: true, value: (r) => inputCell(r, "reorder_threshold") },
  ], rows);
  document.querySelectorAll(".ingredient-input").forEach((input) => {
    input.addEventListener("change", async () => {
      await api(`/api/ingredients/${input.dataset.id}`, {
        method: "PATCH",
        body: JSON.stringify({ [input.dataset.field]: Number(input.value) || 0 }),
      });
    });
  });
}

function inputCell(row, field, step = "0.0001") {
  return `<input class="editable ingredient-input" data-id="${row.id}" data-field="${field}" type="number" step="${step}" value="${row[field] ?? 0}">`;
}

async function renderFormulas() {
  const data = await api("/api/formulas");
  document.querySelector("#formula-table").innerHTML = table([
    { label: "Product", key: "product_name" },
    { label: "Ingredient", key: "ingredient_name" },
    { label: "Qty / Unit", numeric: true, value: (r) => qty(r.quantity_per_unit) },
    { label: "UOM", key: "quantity_uom" },
    { label: "Source", value: (r) => escapeHtml([r.source_sheet, r.source_cell].filter(Boolean).join(" ")) },
  ], filteredRows(data.formulas, ["product_name", "ingredient_name", "source_sheet"]));
  document.querySelector("#formula-lines").innerHTML = table([
    { label: "Sheet", key: "sheet_name" },
    { label: "Row", key: "row_number", numeric: true },
    { label: "Product", key: "product_name" },
    { label: "Ingredient", key: "ingredient_name" },
    { label: "Formula Qty", numeric: true, value: (r) => qty(r.formula_qty) },
    { label: "Batch Qty", numeric: true, value: (r) => qty(r.batch_qty) },
  ], filteredRows(data.sourceLines, ["sheet_name", "product_name", "ingredient_name"]));
}

async function renderReports() {
  const data = await api("/api/reports");
  document.querySelector("#monthly-cost").innerHTML = table([
    { label: "Month", key: "month" },
    { label: "Projected Cost", numeric: true, value: (r) => money(r.projected_cost) },
  ], data.monthlyCost);
  document.querySelector("#product-cost").innerHTML = table([
    { label: "Product", key: "product_name" },
    { label: "Cost / Unit", numeric: true, value: (r) => money(r.ingredient_cost_per_unit) },
    { label: "Ingredients", numeric: true, key: "ingredient_count" },
  ], filteredRows(data.productCost, ["product_name"]));
  document.querySelector("#weekly-usage").innerHTML = table([
    { label: "Week", key: "week_start" },
    { label: "Ingredient", key: "ingredient_name" },
    { label: "Usage", numeric: true, value: (r) => qty(r.required_usage) },
    { label: "Cost", numeric: true, value: (r) => money(r.projected_cost) },
  ], filteredRows(data.weeklyUsage, ["week_start", "ingredient_name"]));
}

const renderers = {
  dashboard: renderDashboard,
  production: renderProduction,
  forecast: renderForecast,
  inventory: renderInventory,
  formulas: renderFormulas,
  reports: renderReports,
  import: async () => {},
};

async function activate(tab) {
  document.querySelectorAll("#tabs button").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === tab));
  document.querySelector("#page-title").textContent = titles[tab][0];
  document.querySelector("#page-subtitle").textContent = titles[tab][1];
  await renderers[tab]();
}

document.querySelector("#tabs").addEventListener("click", async (event) => {
  if (event.target.matches("button[data-tab]")) await activate(event.target.dataset.tab);
});

document.querySelector("#refresh").addEventListener("click", async () => {
  await loadReference();
  await activate(document.querySelector("#tabs button.active").dataset.tab);
});

document.querySelector("#global-filter").addEventListener("input", async (event) => {
  state.filter = event.target.value;
  await activate(document.querySelector("#tabs button.active").dataset.tab);
});

document.querySelector("#ingredient-filter").addEventListener("change", renderForecast);

document.querySelector("#formula-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api("/api/formulas", {
    method: "POST",
    body: JSON.stringify(Object.fromEntries(form.entries())),
  });
  await renderFormulas();
});

document.querySelector("#path-import").addEventListener("submit", async (event) => {
  event.preventDefault();
  const path = new FormData(event.currentTarget).get("path");
  const result = await api("/api/import/path", { method: "POST", body: JSON.stringify({ path }) });
  document.querySelector("#import-result").textContent = JSON.stringify(result, null, 2);
  await loadReference();
});

document.querySelector("#upload-import").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await api("/api/import/upload", { method: "POST", body: new FormData(event.currentTarget) });
  document.querySelector("#import-result").textContent = JSON.stringify(result, null, 2);
  await loadReference();
});

loadReference().then(() => activate("dashboard")).catch((error) => {
  document.body.insertAdjacentHTML("beforeend", `<pre>${escapeHtml(error.message)}</pre>`);
});
