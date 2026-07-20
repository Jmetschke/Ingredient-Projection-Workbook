const state = {
  products: [],
  ingredients: [],
  weeks: [],
  filter: "",
  productionCalendarMonths: 6,
  productionBatchType: "",
  productionStartWeek: "",
  productionEndWeek: "",
  rlCalendarMonths: 6,
  forecastWeeks: 26,
  forecastStart: "",
  forecastEnd: "",
  forecastFilter: "",
  forecastIngredientType: "",
  forecastRows: [],
  forecastInventoryRows: [],
  forecastUnmatchedInventoryRows: [],
  velocityWeeks: 4,
  velocityRows: [],
  velocityInstructions: [],
  velocityProducts: [],
  velocityPlannedBatches: new Map(),
  velocitySchedulePreview: null,
  selectedFormulaProductId: "",
  selectedProductionWeekId: "",
};
let filterRenderTimer;

const APP_VERSION = "20260720-production-drag-drop-v18";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SUITE_LOCATION_STORAGE_KEY = "operations-suite-location";

function setSuiteLocation(location) {
  const selectedLocation = location === "NY" ? "NY" : "IL";
  document.querySelectorAll("[data-suite-location]").forEach((button) => {
    const isSelected = button.dataset.suiteLocation === selectedLocation;
    button.classList.toggle("active", isSelected);
    button.setAttribute("aria-selected", String(isSelected));
  });
  document.querySelectorAll("[data-suite-links]").forEach((links) => {
    links.hidden = links.dataset.suiteLinks !== selectedLocation;
  });
  try {
    window.localStorage.setItem(SUITE_LOCATION_STORAGE_KEY, selectedLocation);
  } catch {
    // Location persistence is optional when storage is unavailable.
  }
}

document.querySelectorAll("[data-suite-location]").forEach((button) => {
  button.addEventListener("click", () => setSuiteLocation(button.dataset.suiteLocation));
});
try {
  setSuiteLocation(window.localStorage.getItem(SUITE_LOCATION_STORAGE_KEY) || "IL");
} catch {
  setSuiteLocation("IL");
}

const titles = {
  dashboard: ["Dashboard", "Inventory warnings, upcoming production, and purchase timing."],
  production: ["Production Planner", "Schedule batches and calculate ingredient needs from calendar entries."],
  "rl-scheduled-batches": ["RL Scheduled Batches", "Read-only calendar from the RL scheduling database."],
  velocity: ["Velocity Calculator", "Project production batch quantities from units sold per day."],
  forecast: ["Ingredient Forecast", "Scheduled BOM usage totals from Production Planner batches."],
  inventory: ["Inventory", "Add new items to the master inventory list."],
  formulas: ["Formula Manager", "Batch-level BOM setup using grams and each."],
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    cache: "no-store",
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

function forecastInventoryValue(row) {
  if (row.starting_inventory_value != null) return Number(row.starting_inventory_value);
  if (row.current_inventory_value != null) return Number(row.current_inventory_value);
  const uom = String(row.quantity_uom || "").toLowerCase();
  if (uom === "each") return row.current_inventory == null ? null : Number(row.current_inventory);
  if (uom === "grams" || uom === "gram") return row.current_inventory_grams == null ? null : Number(row.current_inventory_grams);
  return row.current_inventory_grams == null
    ? row.current_inventory == null ? null : Number(row.current_inventory)
    : Number(row.current_inventory_grams);
}

function forecastInventoryDisplay(row) {
  const value = forecastInventoryValue(row);
  return value == null ? "" : qty(value);
}

function forecastRemainingValue(row) {
  const inventory = forecastInventoryValue(row);
  if (inventory == null) return null;
  return inventory - Number(row.required_qty || 0);
}

function forecastRemainingDisplay(row) {
  const value = forecastRemainingValue(row);
  return value == null ? "" : qty(value);
}

function forecastNeededToOrderValue(row) {
  if (row.needed_to_order_qty != null) return Number(row.needed_to_order_qty);
  const remaining = forecastRemainingValue(row);
  return remaining == null ? null : Math.max(0, -remaining);
}

function forecastNeededToOrderDisplay(row) {
  const value = forecastNeededToOrderValue(row);
  return value == null ? "Inventory needed" : qty(value);
}

function forecastOrderUnitsDisplay(row) {
  const needed = forecastNeededToOrderValue(row);
  if (needed == null) return "";
  if (needed <= 0) return "0";
  if (row.order_units_needed == null) return "";
  return `${qty(row.order_units_needed)} × ${escapeHtml(row.order_unit_uom || "units")}`;
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

function parseIsoDate(value) {
  const [year, month, day] = String(value || "").slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function saturdayForWeek(weekStart) {
  const date = parseIsoDate(weekStart);
  if (!date) return null;
  const daysSinceSaturday = (date.getDay() + 1) % 7;
  return addDays(date, -daysSinceSaturday);
}

function weekMeta(week) {
  const blockStart = parseIsoDate(week.week_start);
  const blockEnd = addDays(blockStart, 6);
  const yearStart = new Date(blockStart.getFullYear(), 0, 1);
  const firstMonday = addDays(yearStart, (1 - yearStart.getDay() + 7) % 7);
  const weekNumber = blockStart < firstMonday
    ? 1
    : Math.floor((blockStart - firstMonday) / (7 * MS_PER_DAY)) + 1;
  const payPeriod = Math.max(1, Math.floor((weekNumber - 1) / 2) + 1);
  const formatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const yearFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  return {
    ...week,
    blockStart,
    blockEnd,
    monthKey: `${blockStart.getFullYear()}-${String(blockStart.getMonth() + 1).padStart(2, "0")}`,
    monthLabel: new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(blockStart),
    weekNumber,
    payPeriod,
    label: `Week ${weekNumber} (${formatter.format(blockStart)} - ${yearFormatter.format(blockEnd)})`,
  };
}

function filteredRows(rows, fields) {
  if (!state.filter) return rows;
  const needle = state.filter.toLowerCase();
  return rows.filter((row) => fields.some((field) => String(row[field] ?? "").toLowerCase().includes(needle)));
}

function forecastReportQuery() {
  const params = new URLSearchParams({ weeks: String(state.forecastWeeks || 26) });
  if (state.forecastStart) params.set("start", state.forecastStart);
  if (state.forecastEnd) params.set("end", state.forecastEnd);
  if (state.forecastFilter) params.set("search", state.forecastFilter);
  if (state.forecastIngredientType) params.set("ingredient_type", state.forecastIngredientType);
  return `?${params.toString()}`;
}

function table(headers, rows, options = {}) {
  const body = rows.length ? rows.map((row) => {
    const klass = options.rowClass?.(row) || "";
    return `<tr class="${klass}">${headers.map((header) => {
      const raw = typeof header.value === "function" ? header.value(row) : row[header.key];
      const cellClass = [header.numeric ? "numeric" : "", header.className?.(row) || ""].filter(Boolean).join(" ");
      return `<td class="${cellClass}" data-label="${escapeHtml(header.label)}">${raw ?? ""}</td>`;
    }).join("")}</tr>`;
  }).join("") : `<tr><td colspan="${headers.length}">No rows</td></tr>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th class="${h.numeric ? "numeric" : ""}">${h.label}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function setMessage(selector, text, kind = "") {
  const el = document.querySelector(selector);
  if (!el) return;
  el.textContent = text || "";
  el.className = `form-message ${kind}`.trim();
}

function optionList(items, selected, labelFn = (item) => item.name, valueFn = (item) => item.id) {
  return items.map((item) => {
    const value = String(valueFn(item));
    return `<option value="${escapeHtml(value)}" ${String(selected) === value ? "selected" : ""}>${escapeHtml(labelFn(item))}</option>`;
  }).join("");
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
  const masterIngredients = state.ingredients.filter((ingredient) => Number(ingredient.is_master));
  const ingredientOptions = masterIngredients.map((i) => `<option value="${i.id}" data-uom="${escapeHtml(i.bom_uom || "grams")}">${escapeHtml(i.name)}</option>`).join("");
  document.querySelectorAll("select[name='product_id']").forEach((el) => { el.innerHTML = productOptions; });
  document.querySelectorAll("select[name='ingredient_id']").forEach((el) => { el.innerHTML = ingredientOptions; });
}

async function renderDashboard() {
  const data = await api("/api/summary");
  const kpiLabels = {
    products: "Products",
    ingredients: "Ingredients",
    scheduled_batches: "Scheduled Batches",
  };
  document.querySelector("#kpis").innerHTML = Object.entries(data.counts).map(([key, value]) => `
    <div class="kpi"><strong>${value}</strong><span>${kpiLabels[key] || key}</span></div>
  `).join("");
  document.querySelector("#dashboard-ingredient-usage").innerHTML = table([
    { label: "Ingredient", key: "ingredient_name" },
    { label: "Scheduled Usage", numeric: true, value: (r) => qty(r.required_qty) },
    { label: "Current Inventory", numeric: true, value: (r) => forecastInventoryDisplay(r) },
    { label: "UOM", key: "quantity_uom" },
    { label: "Batches", numeric: true, key: "scheduled_batches" },
    { label: "Products", key: "products" },
    { label: "First Week", key: "first_week" },
    { label: "Last Week", key: "last_week" },
  ], filteredRows(data.ingredientUsage?.rows || [], ["ingredient_name", "quantity_uom", "products"]));
  renderDashboardProductionCalendar(data.productionBatches || [], (data.productionWeeks || []).map(weekMeta));
}

function renderDashboardProductionCalendar(batches, weeks) {
  const batchesByWeek = new Map();
  batches.forEach((batch) => {
    const key = String(batch.week_id);
    if (!batchesByWeek.has(key)) batchesByWeek.set(key, []);
    batchesByWeek.get(key).push(batch);
  });
  const groups = [];
  for (let index = 0; index < weeks.length; index += 4) {
    groups.push(weeks.slice(index, index + 4));
  }
  const html = groups.map((group) => {
    const first = group[0];
    const last = group.at(-1);
    const label = first && last ? `${dateLabel(first.blockStart)} - ${dateLabel(last.blockEnd, true)}` : "";
    return `
      <div class="dashboard-month-block">
        <h3>${escapeHtml(label)}</h3>
        <div class="dashboard-week-grid">
          ${group.map((week) => {
            const scheduled = batchesByWeek.get(String(week.id)) || [];
            return `
              <article class="week-card dashboard-week-card">
                <div class="week-card-head">
                  <strong>Week ${week.weekNumber}</strong>
                  <span>${escapeHtml(week.week_start)}</span>
                </div>
                <div class="week-range">${escapeHtml(week.label.replace(/^Week \d+ \((.*)\)$/, "$1"))}</div>
                <div class="week-batches">
                  ${scheduled.length ? scheduled.map((batch) => `
                    <div class="batch-chip">
                      <span>${escapeHtml(batch.batch_type)}</span>
                      <strong>${escapeHtml(batch.product_name)}</strong>
                      <em>${qty(batch.quantity)}</em>
                    </div>
                  `).join("") : `<span class="empty-week">No batches</span>`}
                </div>
              </article>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }).join("");
  document.querySelector("#dashboard-production-calendar").innerHTML = html || `<div class="empty-calendar">No production weeks found.</div>`;
}

async function renderProduction() {
  const data = await api("/api/production-plan");
  const batchForm = document.querySelector("#production-batch-form");
  const batchTypeSelect = batchForm.querySelector("select[name='batch_type']");
  const productSelect = batchForm.querySelector("select[name='product_id']");
  const weekSelect = batchForm.querySelector("select[name='week_id']");
  const calendarMonthsSelect = document.querySelector("#production-calendar-months");
  const reportBatchTypeSelect = document.querySelector("#production-filter-batch-type");
  const reportStartSelect = document.querySelector("#production-filter-start");
  const reportEndSelect = document.querySelector("#production-filter-end");
  const weeks = data.weeks.map(weekMeta);
  const rollingStartWeek = currentWeekStartIso();
  const schedulingWeeks = weeks.filter((week) => week.week_start >= rollingStartWeek);
  const weekOptions = schedulingWeeks.length ? schedulingWeeks : weeks;
  const defaultWeeks = visibleCalendarWeeks(weeks, state.productionCalendarMonths);
  const defaultStartWeek = defaultWeeks[0]?.week_start || rollingStartWeek;
  const defaultEndWeek = defaultWeeks.at(-1)?.week_start || defaultStartWeek;
  if (!state.productionStartWeek || state.productionStartWeek < rollingStartWeek) state.productionStartWeek = defaultStartWeek;
  if (!state.productionEndWeek || state.productionEndWeek < state.productionStartWeek) state.productionEndWeek = defaultEndWeek;
  const filteredWeeks = weeks.filter((week) => (!state.productionStartWeek || week.week_start >= state.productionStartWeek)
    && (!state.productionEndWeek || week.week_start <= state.productionEndWeek));
  const filteredBatches = data.batches.filter((batch) => (!state.productionBatchType || batch.batch_type === state.productionBatchType)
    && (!state.productionStartWeek || batch.week_start >= state.productionStartWeek)
    && (!state.productionEndWeek || batch.week_start <= state.productionEndWeek));
  if (state.selectedProductionWeekId && !filteredWeeks.some((week) => String(week.id) === String(state.selectedProductionWeekId))) {
    state.selectedProductionWeekId = "";
  }
  const ingredientReport = await api(`/api/production-ingredient-report${productionReportQuery()}`);

  batchTypeSelect.innerHTML = data.batchTypes.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("");
  weekSelect.innerHTML = weekOptions.map((week) => `<option value="${week.id}">${escapeHtml(week.label)}</option>`).join("");
  calendarMonthsSelect.value = String(state.productionCalendarMonths);
  calendarMonthsSelect.onchange = async () => {
    state.productionCalendarMonths = Number(calendarMonthsSelect.value) || 6;
    const nextDefaultWeeks = visibleCalendarWeeks(weeks, state.productionCalendarMonths);
    state.productionStartWeek = nextDefaultWeeks[0]?.week_start || rollingStartWeek;
    state.productionEndWeek = nextDefaultWeeks.at(-1)?.week_start || state.productionStartWeek;
    await renderProduction();
  };
  reportBatchTypeSelect.value = state.productionBatchType;
  reportStartSelect.innerHTML = weeks.map((week) => `<option value="${week.week_start}">${escapeHtml(week.label)}</option>`).join("");
  reportEndSelect.innerHTML = reportStartSelect.innerHTML;
  reportStartSelect.value = state.productionStartWeek;
  reportEndSelect.value = state.productionEndWeek;
  reportBatchTypeSelect.onchange = async () => {
    state.productionBatchType = reportBatchTypeSelect.value;
    await renderProduction();
  };
  reportStartSelect.onchange = async () => {
    state.productionStartWeek = reportStartSelect.value;
    await renderProduction();
  };
  reportEndSelect.onchange = async () => {
    state.productionEndWeek = reportEndSelect.value;
    await renderProduction();
  };
  document.querySelector("#production-ingredient-export").href = `/api/export/production-ingredients${productionReportQuery()}`;
  document.querySelector("#production-print-calendar").onclick = () => {
    printProductionCalendarReport(filteredBatches, filteredWeeks);
  };

  fillProductsForBatchType(batchTypeSelect, productSelect, data.products, data.batchTypes, batchForm.querySelector("input[name='quantity']"));
  batchTypeSelect.onchange = () => fillProductsForBatchType(batchTypeSelect, productSelect, data.products, data.batchTypes, batchForm.querySelector("input[name='quantity']"));
  productSelect.onchange = () => suggestBatchQuantity(productSelect, data.products, batchForm.querySelector("input[name='quantity']"));
  batchForm.onsubmit = async (event) => {
    event.preventDefault();
    setMessage("#production-message", "Adding batch...");
    try {
      const form = new FormData(batchForm);
      await api("/api/production-batches", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(form.entries())),
      });
      batchForm.querySelector("input[name='quantity']").value = "";
      setMessage("#production-message", "Batch added.", "success");
      await renderProduction();
    } catch (error) {
      setMessage("#production-message", error.message, "error");
    }
  };

  renderProductionCalendar(filteredBatches, filteredWeeks);
  document.querySelector("#production-ingredient-report").innerHTML = table([
    { label: "Ingredient", key: "ingredient_name" },
    { label: "Needed Qty", numeric: true, value: (r) => qty(r.required_qty) },
    { label: "UOM", key: "quantity_uom" },
    { label: "Products", numeric: true, key: "product_count" },
  ], filteredRows(ingredientReport.rows || [], ["ingredient_name", "quantity_uom"]));

  renderProductionTotals(filteredBatches, filteredWeeks);
  renderProductionWeekFocus(data.batches, filteredWeeks, data.products, data.batchTypes);
  renderProductionBatchEditor(filteredBatches, data.products, weeks, data.batchTypes);
}

function fillProductsForBatchType(batchTypeSelect, productSelect, products, batchTypes, quantityInput = null) {
  const selectedType = batchTypeSelect.value || batchTypes[0];
  productSelect.innerHTML = products
    .filter((product) => product.category === selectedType)
    .map((product) => `<option value="${product.id}">${escapeHtml(product.name)}</option>`)
    .join("");
  suggestBatchQuantity(productSelect, products, quantityInput);
}

function suggestBatchQuantity(productSelect, products, quantityInput) {
  if (!quantityInput) return;
  const product = products.find((item) => String(item.id) === String(productSelect.value));
  const batchSize = Number(product?.batch_size || 0);
  quantityInput.value = batchSize > 0 ? String(batchSize) : "";
}

function productionReportQuery() {
  const params = new URLSearchParams();
  if (state.productionBatchType) params.set("batch_type", state.productionBatchType);
  if (state.productionStartWeek) params.set("start", state.productionStartWeek);
  if (state.productionEndWeek) params.set("end", state.productionEndWeek);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function renderProductionTotals(batches, weeks) {
  const rows = weeks.map((week) => {
    const scheduled = batches.filter((batch) => String(batch.week_id) === String(week.id));
    const hijnx = scheduled.filter((batch) => batch.batch_type === "Hijnx").reduce((sum, batch) => sum + Number(batch.quantity || 0), 0);
    const snackbar = scheduled.filter((batch) => batch.batch_type === "Snackbar").reduce((sum, batch) => sum + Number(batch.quantity || 0), 0);
    return {
      week: `W${week.weekNumber}`,
      date_range: week.label.replace(/^Week \d+ \((.*)\)$/, "$1"),
      batch_count: scheduled.length,
      hijnx,
      snackbar,
      total: hijnx + snackbar,
    };
  }).filter((row) => row.batch_count || row.total);
  document.querySelector("#production-table").innerHTML = table([
    { label: "Week", key: "week" },
    { label: "Date Range", key: "date_range" },
    { label: "Batches", numeric: true, key: "batch_count" },
    { label: "Hijnx", numeric: true, value: (row) => qty(row.hijnx) },
    { label: "SB", numeric: true, value: (row) => qty(row.snackbar) },
    { label: "Total", numeric: true, value: (row) => qty(row.total) },
  ], rows);
}

function productionBatchEditorRow(batch, products, weeks, batchTypes) {
  const matchingProducts = products.filter((product) => product.category === batch.batch_type);
  return `
    <div class="batch-editor-card" data-batch-id="${batch.id}">
      <div class="batch-editor-summary">
        <strong>${escapeHtml(batch.product_name)}</strong>
        <span>${escapeHtml(batch.batch_type)} · ${qty(batch.quantity)}</span>
      </div>
      <label class="batch-editor-field batch-editor-product">
        <span>Product</span>
        <select class="batch-edit-product" aria-label="Product">
          ${optionList(matchingProducts, batch.product_id)}
        </select>
      </label>
      <div class="batch-editor-controls">
        <label class="batch-editor-field">
          <span>Type</span>
          <select class="batch-edit-type" aria-label="Batch type">
            ${optionList(batchTypes.map((type) => ({ id: type, name: type })), batch.batch_type)}
          </select>
        </label>
        <label class="batch-editor-field">
          <span>Week</span>
        <select class="batch-edit-week" aria-label="Production week">
          ${optionList(weeks, batch.week_id, (week) => week.label)}
        </select>
        </label>
        <label class="batch-editor-field">
          <span>Qty</span>
          <input class="batch-edit-quantity" aria-label="Quantity" type="number" min="1" step="1" value="${escapeHtml(batch.quantity)}">
        </label>
        <div class="batch-editor-actions">
          <button class="small secondary save-batch" type="button">Save</button>
          <button class="small danger delete-batch" type="button">Delete</button>
        </div>
      </div>
    </div>
  `;
}

function renderProductionBatchEditor(batches, products, weeks, batchTypes) {
  const rows = filteredRows(batches, ["week_start", "batch_type", "product_name"]);
  const html = rows.length ? `
    <div class="batch-editor-list">
      ${rows.map((batch) => productionBatchEditorRow(batch, products, weeks, batchTypes)).join("")}
    </div>
  ` : `<div class="empty-calendar">No scheduled batches in this filter.</div>`;
  document.querySelector("#production-batches").innerHTML = html;
  document.querySelectorAll(".batch-edit-type").forEach((select) => {
    select.addEventListener("change", () => {
      const row = select.closest(".batch-editor-card");
      const productSelect = row.querySelector(".batch-edit-product");
      const matchingProducts = products.filter((product) => product.category === select.value);
      productSelect.innerHTML = optionList(matchingProducts, matchingProducts[0]?.id);
    });
  });
  document.querySelectorAll(".save-batch").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest(".batch-editor-card");
      setMessage("#production-message", "Saving batch...");
      try {
        await api(`/api/production-batches/${row.dataset.batchId}`, {
          method: "PATCH",
          body: JSON.stringify({
            batch_type: row.querySelector(".batch-edit-type").value,
            product_id: row.querySelector(".batch-edit-product").value,
            week_id: row.querySelector(".batch-edit-week").value,
            quantity: row.querySelector(".batch-edit-quantity").value,
          }),
        });
        setMessage("#production-message", "Batch saved.", "success");
        await renderProduction();
      } catch (error) {
        setMessage("#production-message", error.message, "error");
      }
    });
  });
  document.querySelectorAll(".delete-batch").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest(".batch-editor-card");
      if (!confirm("Delete this scheduled batch?")) return;
      setMessage("#production-message", "Deleting batch...");
      try {
        await api(`/api/production-batches/${row.dataset.batchId}`, { method: "DELETE" });
        setMessage("#production-message", "Batch deleted.", "success");
        await renderProduction();
      } catch (error) {
        setMessage("#production-message", error.message, "error");
      }
    });
  });
}

function renderProductionWeekFocus(batches, weeks, products, batchTypes) {
  const selectedWeek = weeks.find((week) => String(week.id) === String(state.selectedProductionWeekId));
  const container = document.querySelector("#production-week-focus");
  if (!selectedWeek) {
    container.innerHTML = "";
    return;
  }
  const scheduled = batches.filter((batch) => String(batch.week_id) === String(selectedWeek.id));
  container.innerHTML = `
    <div class="focus-backdrop" role="presentation" data-close-week-focus>
      <div class="focus-panel production-week-focus" role="dialog" aria-modal="true" aria-labelledby="production-week-focus-title">
      <div class="section-head">
        <div>
          <h2 id="production-week-focus-title">Week ${selectedWeek.weekNumber}</h2>
          <span>${escapeHtml(selectedWeek.label.replace(/^Week \d+ \((.*)\)$/, "$1"))}</span>
        </div>
        <button class="small ghost" type="button" data-close-week-focus>Close</button>
      </div>
      <form id="production-week-add-form" class="inline-form production-week-add-form">
        <input name="week_id" type="hidden" value="${escapeHtml(selectedWeek.id)}">
        <label class="form-field">
          <span>Batch Type</span>
          <select name="batch_type" required>
            ${batchTypes.map((type) => `<option value="${escapeHtml(type)}" ${state.productionBatchType === type ? "selected" : ""}>${escapeHtml(type)}</option>`).join("")}
          </select>
        </label>
        <label class="form-field">
          <span>Product</span>
          <select name="product_id" required></select>
        </label>
        <label class="form-field">
          <span>Quantity</span>
          <input name="quantity" type="number" min="1" step="1" required>
        </label>
        <button type="submit">Add To Week</button>
      </form>
      <div class="week-focus-list">
        ${scheduled.length ? scheduled.map((batch) => `
          <div class="week-focus-item" data-batch-id="${batch.id}">
            <div>
              <span>${escapeHtml(batch.batch_type)}</span>
              <strong>${escapeHtml(batch.product_name)}</strong>
              <em>${qty(batch.quantity)}</em>
            </div>
            <button class="small danger delete-week-batch" type="button">Delete</button>
          </div>
        `).join("") : `<div class="empty-calendar">No batches scheduled for this week.</div>`}
      </div>
      </div>
    </div>
  `;
  const closeFocus = async () => {
    state.selectedProductionWeekId = "";
    await renderProduction();
  };
  container.querySelectorAll("[data-close-week-focus]").forEach((element) => {
    element.addEventListener("click", async (event) => {
      if (event.target !== element) return;
      await closeFocus();
    });
  });

  const form = container.querySelector("#production-week-add-form");
  const batchTypeSelect = form.querySelector("select[name='batch_type']");
  const productSelect = form.querySelector("select[name='product_id']");
  const quantityInput = form.querySelector("input[name='quantity']");
  fillProductsForBatchType(batchTypeSelect, productSelect, products, batchTypes, quantityInput);
  batchTypeSelect.addEventListener("change", () => fillProductsForBatchType(batchTypeSelect, productSelect, products, batchTypes, quantityInput));
  productSelect.addEventListener("change", () => suggestBatchQuantity(productSelect, products, quantityInput));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("#production-message", `Adding batch to Week ${selectedWeek.weekNumber}...`);
    try {
      await api("/api/production-batches", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
      });
      setMessage("#production-message", "Batch added to selected week.", "success");
      await renderProduction();
    } catch (error) {
      setMessage("#production-message", error.message, "error");
    }
  });
  container.querySelectorAll(".delete-week-batch").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest(".week-focus-item");
      if (!confirm("Delete this scheduled batch?")) return;
      setMessage("#production-message", "Deleting batch...");
      try {
        await api(`/api/production-batches/${row.dataset.batchId}`, { method: "DELETE" });
        setMessage("#production-message", "Batch deleted.", "success");
        await renderProduction();
      } catch (error) {
        setMessage("#production-message", error.message, "error");
      }
    });
  });
}

function visibleCalendarWeeks(weeks, monthCount) {
  const firstVisible = parseIsoDate(currentWeekStartIso());
  const lastVisible = addMonths(firstVisible, monthCount);
  return weeks.filter((week) => week.blockEnd >= firstVisible && week.blockStart < lastVisible);
}

function sundayForDate(date = new Date()) {
  return addDays(date, -date.getDay());
}

function dateLabel(date, includeYear = false) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: includeYear ? "numeric" : undefined }).format(date);
}

function rlCategory(batch) {
  const raw = String(batch.category || batch.batch_type || batch.type || "").toLowerCase();
  const text = `${raw} ${String(batch.product_name || "")}`.toLowerCase();
  if (text.includes("pickup")) return "pickup";
  if (text.includes("event")) return "event";
  if (text.includes("task")) return "task";
  if (text.includes("snackbar") || raw === "sb") return "sb";
  if (text.includes("hijnx") || text.includes("hijinx")) return "hijnx";
  return "task";
}

function rlCategoryLabel(category) {
  return ({ hijnx: "Hijnx", sb: "SB", pickup: "Pickup", event: "Event", task: "Task" })[category] || "Task";
}

function rlCalendarDays() {
  const start = sundayForDate(new Date());
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

function rlEntryTitle(batch, category) {
  const name = batch.product_name || batch.title || "Scheduled item";
  return `${rlCategoryLabel(category)}: ${name}`;
}

function currentWeekStartIso() {
  const today = new Date();
  const daysSinceMonday = (today.getDay() + 6) % 7;
  return isoDate(addDays(today, -daysSinceMonday));
}

function nextProductionWeekStartIso() {
  return isoDate(addDays(parseIsoDate(currentWeekStartIso()), 7));
}

function productionCalendarMarkup(batches, weeks, options = {}) {
  const batchesByWeek = new Map();
  [...batches]
    .sort((a, b) => String(a.week_start || "").localeCompare(String(b.week_start || ""))
      || String(a.batch_type || "").localeCompare(String(b.batch_type || ""))
      || String(a.product_name || "").localeCompare(String(b.product_name || "")))
    .forEach((batch) => {
    const key = String(batch.week_id);
    if (!batchesByWeek.has(key)) batchesByWeek.set(key, []);
    batchesByWeek.get(key).push(batch);
  });
  const monthGroups = weeks.reduce((groups, week) => {
    if (!groups.has(week.monthKey)) groups.set(week.monthKey, { label: week.monthLabel, weeks: [] });
    groups.get(week.monthKey).weeks.push(week);
    return groups;
  }, new Map());
  return Array.from(monthGroups.values()).map((group) => `
    <div class="calendar-month">
      <h3>${escapeHtml(group.label)}</h3>
      <div class="week-grid">
        ${group.weeks.map((week) => {
          const scheduled = batchesByWeek.get(String(week.id)) || [];
          return `
            <article class="week-card ${!options.printable && String(week.id) === String(state.selectedProductionWeekId) ? "selected" : ""}" ${options.printable ? "" : `role="button" tabindex="0" data-week-id="${week.id}" data-week-label="${escapeHtml(week.label)}"`}>
              <div class="week-card-head">
                <strong>Week ${week.weekNumber}</strong>
                <span>PP ${week.payPeriod}</span>
              </div>
              <div class="week-range">${escapeHtml(week.label.replace(/^Week \d+ \((.*)\)$/, "$1"))}</div>
              <div class="week-batches">
                ${scheduled.length ? scheduled.map((batch) => `
                  <div class="batch-chip" ${options.printable ? "" : `draggable="true" data-batch-id="${batch.id}" data-source-week-id="${batch.week_id}" title="Drag to another week" aria-label="${escapeHtml(`${batch.product_name}, ${qty(batch.quantity)}. Drag to another week.`)}"`}>
                    <span>${escapeHtml(batch.batch_type)}</span>
                    <strong>${escapeHtml(batch.product_name)}</strong>
                    <em>${qty(batch.quantity)}</em>
                  </div>
                `).join("") : `<span class="empty-week">No batches</span>`}
              </div>
            </article>
          `;
        }).join("")}
      </div>
    </div>
  `).join("");
}

function renderProductionCalendar(batches, weeks) {
  const html = productionCalendarMarkup(batches, weeks);
  const calendar = document.querySelector("#production-calendar");
  calendar.innerHTML = html || `<div class="empty-calendar">No weeks found for this calendar window.</div>`;
  let draggedBatchId = "";
  let sourceWeekId = "";
  calendar.querySelectorAll(".batch-chip[draggable='true']").forEach((chip) => {
    chip.addEventListener("click", (event) => event.stopPropagation());
    chip.addEventListener("dragstart", (event) => {
      draggedBatchId = chip.dataset.batchId;
      sourceWeekId = chip.dataset.sourceWeekId;
      chip.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedBatchId);
    });
    chip.addEventListener("dragend", () => {
      chip.classList.remove("dragging");
      calendar.querySelectorAll(".week-card.drag-target").forEach((card) => card.classList.remove("drag-target"));
      draggedBatchId = "";
      sourceWeekId = "";
    });
  });
  calendar.querySelectorAll(".week-card[data-week-id]").forEach((card) => {
    const selectWeek = async () => {
      state.selectedProductionWeekId = card.dataset.weekId;
      await renderProduction();
    };
    card.addEventListener("click", selectWeek);
    card.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      await selectWeek();
    });
    card.addEventListener("dragover", (event) => {
      if (!draggedBatchId || String(card.dataset.weekId) === String(sourceWeekId)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      card.classList.add("drag-target");
    });
    card.addEventListener("dragleave", (event) => {
      if (!card.contains(event.relatedTarget)) card.classList.remove("drag-target");
    });
    card.addEventListener("drop", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      card.classList.remove("drag-target");
      const batchId = draggedBatchId || event.dataTransfer.getData("text/plain");
      if (!batchId || String(card.dataset.weekId) === String(sourceWeekId)) return;
      setMessage("#production-message", `Moving batch to ${card.dataset.weekLabel}...`);
      try {
        await api(`/api/production-batches/${batchId}`, {
          method: "PATCH",
          body: JSON.stringify({ week_id: card.dataset.weekId }),
        });
        state.selectedProductionWeekId = "";
        await renderProduction();
        setMessage("#production-message", `Batch moved to ${card.dataset.weekLabel}.`, "success");
      } catch (error) {
        setMessage("#production-message", error.message, "error");
      }
    });
  });
}

function printProductionCalendarReport(batches, weeks) {
  const printWindow = window.open("", "_blank", "width=1200,height=900");
  if (!printWindow) {
    setMessage("#production-message", "Allow pop-ups to print the schedule report.", "error");
    return;
  }
  const typeLabel = state.productionBatchType || "Both";
  const startLabel = weeks[0]?.label || state.productionStartWeek || "";
  const endLabel = weeks.at(-1)?.label || state.productionEndWeek || "";
  const totalBatches = batches.length;
  const html = productionCalendarMarkup(batches, weeks, { printable: true });
  printWindow.document.write(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Production Schedule Report</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 24px; color: #172026; font-family: Arial, sans-serif; background: #fff; }
          header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; border-bottom: 2px solid #172026; padding-bottom: 12px; margin-bottom: 18px; }
          h1 { margin: 0 0 6px; font-size: 22px; }
          h2, h3 { break-after: avoid; }
          .meta { color: #5f6c72; font-size: 12px; line-height: 1.5; text-align: right; }
          .calendar-month { display: grid; gap: 10px; margin-bottom: 18px; break-inside: avoid; page-break-inside: avoid; }
          .calendar-month h3 { margin: 0; font-size: 15px; }
          .week-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
          .week-card { border: 1px solid #cfd8dc; border-radius: 6px; min-height: 132px; padding: 10px; display: grid; grid-template-rows: auto auto 1fr; gap: 7px; break-inside: avoid; page-break-inside: avoid; }
          .week-card-head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
          .week-card-head strong { font-size: 13px; }
          .week-card-head span, .week-range, .empty-week { color: #5f6c72; font-size: 11px; }
          .week-batches { display: grid; gap: 5px; align-content: start; }
          .batch-chip { border: 1px solid #d9e2e5; border-radius: 5px; padding: 5px 6px; display: grid; grid-template-columns: auto 1fr auto; gap: 6px; align-items: center; font-size: 11px; }
          .batch-chip span { color: #216b62; font-weight: 700; }
          .batch-chip strong { font-size: 11px; }
          .batch-chip em { color: #172026; font-style: normal; font-weight: 700; text-align: right; }
          .empty-calendar { color: #5f6c72; border: 1px dashed #cfd8dc; padding: 14px; }
          @page { margin: 0.45in; }
          @media print {
            body { padding: 0; }
            .calendar-month { break-inside: avoid; }
          }
        </style>
      </head>
      <body>
        <header>
          <div>
            <h1>Production Schedule Report</h1>
            <div>${escapeHtml(startLabel)} to ${escapeHtml(endLabel)}</div>
          </div>
          <div class="meta">
            <div>Batch Type: ${escapeHtml(typeLabel)}</div>
            <div>Total Scheduled Batches: ${totalBatches}</div>
            <div>Generated: ${escapeHtml(new Date().toLocaleString())}</div>
          </div>
        </header>
        <main>${html || `<div class="empty-calendar">No weeks found for this calendar window.</div>`}</main>
        <script>
          window.addEventListener("load", () => {
            window.print();
          });
        </script>
      </body>
    </html>
  `);
  printWindow.document.close();
}

async function renderRlScheduledBatches() {
  const days = rlCalendarDays();
  const firstDay = days[0];
  const lastDay = days.at(-1);
  const data = await api(`/api/rl-scheduled-batches?start=${isoDate(firstDay)}&end=${isoDate(lastDay)}`);

  document.querySelector("#rl-calendar-status").textContent = data.source
    ? `Read only source: ${data.source.table}`
    : (data.message || "Read only source is not available.");

  const batchesByDay = new Map();
  (data.batches || []).forEach((batch) => {
    const date = parseIsoDate(batch.scheduled_date);
    if (!date || date < firstDay || date > lastDay) return;
    const key = isoDate(date);
    if (!batchesByDay.has(key)) batchesByDay.set(key, []);
    batchesByDay.get(key).push(batch);
  });
  const counts = { hijnx: 0, sb: 0, pickup: 0, event: 0, task: 0 };
  Array.from(batchesByDay.values()).flat().forEach((batch) => {
    counts[rlCategory(batch)] += 1;
  });
  document.querySelector("#rl-summary-cards").innerHTML = ["hijnx", "sb", "pickup", "event", "task"].map((category) => `
    <div class="rl-stat ${category}">
      <span>${rlCategoryLabel(category)}</span>
      <strong>${counts[category]}</strong>
    </div>
  `).join("");

  const header = `
    <div class="rl-calendar-head">
      <div class="rl-calendar-title">${dateLabel(firstDay)} - ${dateLabel(lastDay, true)}</div>
      <div class="rl-legend">
        ${["hijnx", "sb", "pickup", "event", "task"].map((category) => `<span><i class="${category}"></i>${rlCategoryLabel(category)}</span>`).join("")}
      </div>
    </div>
  `;
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => `<div class="rl-day-name">${day}</div>`).join("");
  const cells = days.map((day) => {
    const key = isoDate(day);
    const scheduled = batchesByDay.get(key) || [];
    const isWeekend = day.getDay() === 0 || day.getDay() === 6;
    const isToday = key === isoDate(new Date());
    return `
      <div class="rl-day ${isWeekend ? "weekend" : ""} ${isToday ? "today" : ""}">
        <div class="rl-date">${dateLabel(day)}</div>
        <div class="rl-day-items">
          ${scheduled.map((batch) => {
            const category = rlCategory(batch);
            const completion = Math.max(0, Math.min(100, Number(batch.completion ?? 0) || 0));
            const title = rlEntryTitle(batch, category);
            const quantity = batch.quantity == null ? "" : ` - ${qty(batch.quantity)}${batch.quantity_uom ? ` ${escapeHtml(batch.quantity_uom)}` : ""}`;
            return `
              <div class="rl-event ${category}" title="${escapeHtml(`${title}${quantity}`)}">
                <strong>${escapeHtml(title)}</strong>
                ${quantity ? `<span class="rl-event-quantity">${escapeHtml(quantity.replace(/^ - /, ""))}</span>` : ""}
                ${category === "hijnx" || category === "sb" ? `
                  <div class="rl-completion">
                    <span>Completion</span>
                    <em>${completion}%</em>
                  </div>
                  <div class="rl-progress"><span style="width: ${completion}%"></span></div>
                ` : ""}
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }).join("");
  document.querySelector("#rl-scheduled-calendar").innerHTML = `
    <div class="rl-calendar-panel">
      ${header}
      <div class="rl-calendar-grid">${dayNames}${cells}</div>
    </div>
  `;

  if (data.message && data.schema?.length) {
    document.querySelector("#rl-scheduled-table").innerHTML = table([
      { label: "Table / View", key: "name" },
      { label: "Columns", value: (row) => escapeHtml(row.columns.join(", ")) },
    ], data.schema);
  } else {
    document.querySelector("#rl-scheduled-table").innerHTML = table([
      { label: "Scheduled Date", key: "scheduled_date" },
      { label: "Batch Type", key: "batch_type" },
      { label: "Product", key: "product_name" },
      { label: "Quantity", numeric: true, value: (row) => row.quantity == null ? "" : `${qty(row.quantity)} ${escapeHtml(row.quantity_uom || "")}` },
      { label: "Completion", numeric: true, value: (row) => row.completion == null ? "" : `${qty(row.completion)}%` },
      { label: "Status", key: "status" },
    ], filteredRows(data.batches || [], ["scheduled_date", "batch_type", "product_name", "status"]));
  }
}

async function renderForecast() {
  const weeksInput = document.querySelector("#forecast-weeks");
  const startInput = document.querySelector("#forecast-start");
  const endInput = document.querySelector("#forecast-end");
  const applyRangeButton = document.querySelector("#forecast-apply-range");
  const filterInput = document.querySelector("#forecast-filter");
  const typeSelect = document.querySelector("#forecast-ingredient-type");
  const uploadInput = document.querySelector("#forecast-inventory-upload");
  const manualInventoryForm = document.querySelector("#manual-inventory-form");
  const manualIngredientSelect = manualInventoryForm.querySelector("select[name='ingredient_id']");
  const manualAddInput = manualInventoryForm.querySelector("input[name='add_qty']");
  const manualUpdateInput = manualInventoryForm.querySelector("input[name='update_qty']");
  const updateManualInventoryUom = () => {
    document.querySelector("#manual-inventory-uom").value = manualIngredientSelect.selectedOptions[0]?.dataset.uom || "grams";
  };
  manualIngredientSelect.onchange = updateManualInventoryUom;
  manualAddInput.oninput = () => {
    if (manualAddInput.value !== "") manualUpdateInput.value = "";
  };
  manualUpdateInput.oninput = () => {
    if (manualUpdateInput.value !== "") manualAddInput.value = "";
  };
  manualInventoryForm.onsubmit = async (event) => {
    event.preventDefault();
    const addQty = manualAddInput.value;
    const updateQty = manualUpdateInput.value;
    if ((addQty === "") === (updateQty === "")) {
      setMessage("#manual-inventory-message", "Enter either an Add quantity or an Update quantity, but not both.", "error");
      return;
    }
    const ingredientName = manualIngredientSelect.selectedOptions[0]?.textContent || "ingredient";
    const actionLabel = addQty !== "" ? "Adding to" : "Updating";
    setMessage("#manual-inventory-message", `${actionLabel} ${ingredientName}...`);
    try {
      const adjustment = await api("/api/inventory-adjustments", {
        method: "POST",
        body: JSON.stringify({
          ingredient_id: manualIngredientSelect.value,
          add_qty: addQty,
          update_qty: updateQty,
        }),
      });
      manualAddInput.value = "";
      manualUpdateInput.value = "";
      await renderForecast();
      setMessage(
        "#manual-inventory-message",
        `${adjustment.ingredient_name} updated from ${qty(adjustment.previous_qty)} to ${qty(adjustment.resulting_qty)} ${adjustment.quantity_uom}.`,
        "success",
      );
    } catch (error) {
      setMessage("#manual-inventory-message", error.message, "error");
    }
  };
  updateManualInventoryUom();
  if (!state.forecastStart || !state.forecastEnd) {
    const start = parseIsoDate(nextProductionWeekStartIso());
    state.forecastStart = isoDate(start);
    state.forecastEnd = isoDate(addDays(start, state.forecastWeeks * 7 - 1));
  }
  weeksInput.value = String(state.forecastWeeks);
  startInput.value = state.forecastStart;
  endInput.value = state.forecastEnd;
  weeksInput.onchange = async () => {
    state.forecastWeeks = Math.max(1, Math.round(Number(weeksInput.value) || 26));
    weeksInput.value = String(state.forecastWeeks);
    const start = parseIsoDate(state.forecastStart) || parseIsoDate(nextProductionWeekStartIso());
    state.forecastStart = isoDate(start);
    state.forecastEnd = isoDate(addDays(start, state.forecastWeeks * 7 - 1));
    await renderForecast();
  };
  const updateForecastDateRange = async () => {
    const start = parseIsoDate(startInput.value);
    const end = parseIsoDate(endInput.value);
    if (!start || !end || end < start) {
      setMessage("#forecast-window", "Choose an end date on or after the start date.", "error");
      return;
    }
    state.forecastStart = isoDate(start);
    state.forecastEnd = isoDate(end);
    state.forecastWeeks = Math.max(1, Math.ceil(((end - start) / MS_PER_DAY + 1) / 7));
    await renderForecast();
  };
  startInput.oninput = () => setMessage("#forecast-window", "Press Apply Date Range to refresh the forecast for this range.");
  endInput.oninput = () => setMessage("#forecast-window", "Press Apply Date Range to refresh the forecast for this range.");
  applyRangeButton.onclick = updateForecastDateRange;
  filterInput.value = state.forecastFilter;
  filterInput.oninput = () => {
    state.forecastFilter = filterInput.value.trim();
    renderForecastTable(state.forecastRows);
  };
  typeSelect.value = state.forecastIngredientType;
  typeSelect.onchange = () => {
    state.forecastIngredientType = typeSelect.value;
    renderForecastTable(state.forecastRows);
  };
  document.querySelector("#forecast-print-report").onclick = () => {
    printForecastReport(forecastFilteredRows(state.forecastRows));
  };
  document.querySelector("#forecast-export-pdf").onclick = () => {
    window.location.href = `/api/export/forecast.pdf${forecastReportQuery()}`;
  };
  uploadInput.onchange = () => uploadForecastInventoryPdf(uploadInput);
  document.querySelector("#forecast-inventory-clear").onclick = async () => {
    try {
      setMessage("#forecast-inventory-message", "Clearing current inventory upload...");
      await api("/api/inventory-upload", { method: "DELETE" });
      await renderForecast();
      setMessage("#forecast-inventory-message", "Current inventory upload cleared.", "success");
    } catch (error) {
      setMessage("#forecast-inventory-message", error.message, "error");
    }
  };
  const [data, manualAdjustments] = await Promise.all([
    api(`/api/forecast${forecastReportQuery()}`),
    api("/api/inventory-adjustments?limit=25"),
  ]);
  const forecastWindow = document.querySelector("#forecast-window");
  state.forecastWeeks = data.filters.weeks || state.forecastWeeks;
  state.forecastStart = data.filters.start || state.forecastStart;
  state.forecastEnd = data.filters.end || state.forecastEnd;
  weeksInput.value = String(state.forecastWeeks);
  startInput.value = state.forecastStart;
  endInput.value = state.forecastEnd;
  forecastWindow.textContent = `${state.forecastStart} through ${state.forecastEnd}, inclusive. Usage is totaled from scheduled Production Planner batches. Inventory at start is current inventory less earlier scheduled usage.`;
  forecastWindow.className = "source-note";
  state.forecastRows = data.rows || [];
  state.forecastInventoryRows = data.inventoryRows || [];
  state.forecastUnmatchedInventoryRows = data.unmatchedInventoryRows || [];
  document.querySelector("#forecast-ingredient-options").innerHTML = [...new Set(state.forecastRows.map((row) => row.ingredient_name).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `<option value="${escapeHtml(name)}"></option>`)
    .join("");
  renderForecastUnmatchedInventory();
  renderManualInventoryHistory(manualAdjustments.rows || []);
  renderForecastTable(state.forecastRows);
}

function renderManualInventoryHistory(rows) {
  const host = document.querySelector("#manual-inventory-history");
  if (!rows.length) {
    host.innerHTML = `<div class="empty small-empty">No manual inventory entries have been recorded.</div>`;
    return;
  }
  host.innerHTML = `
    <h4>Recent Manual Entries</h4>
    ${table([
      { label: "Ingredient", key: "ingredient_name" },
      { label: "Action", value: (row) => row.adjustment_type === "add" ? "Add" : "Update" },
      { label: "Entered QTY", numeric: true, value: (row) => `${row.adjustment_type === "add" ? "+" : ""}${qty(row.entered_qty)}` },
      { label: "Previous QTY", numeric: true, value: (row) => qty(row.previous_qty) },
      { label: "Resulting QTY", numeric: true, value: (row) => qty(row.resulting_qty) },
      { label: "UOM", key: "quantity_uom" },
      {
        label: "Recorded",
        value: (row) => {
          const timestamp = String(row.created_at || "").replace(" ", "T");
          const date = timestamp ? new Date(`${timestamp}Z`) : null;
          return date && !Number.isNaN(date.getTime()) ? escapeHtml(date.toLocaleString()) : escapeHtml(row.created_at || "");
        },
      },
    ], rows)}
  `;
}

function forecastFilteredRows(rows) {
  const keyword = state.forecastFilter.toLowerCase();
  const ingredientType = state.forecastIngredientType;
  const typeOrder = { Hijnx: 1, SB: 2, "SB/Hijnx": 3 };
  const filtered = rows.filter((row) => {
    const matchesKeyword = !keyword || ["ingredient_name", "quantity_uom", "products"].some((field) => String(row[field] ?? "").toLowerCase().includes(keyword));
    const matchesType = !ingredientType || row.ingredient_type === ingredientType;
    return matchesKeyword && matchesType;
  }).sort((a, b) => (typeOrder[a.ingredient_type] || 9) - (typeOrder[b.ingredient_type] || 9)
    || String(a.ingredient_name || "").localeCompare(String(b.ingredient_name || "")));
  return filteredRows(filtered, ["ingredient_name", "ingredient_type", "quantity_uom", "products"]);
}

function renderForecastTable(rows) {
  const filtered = forecastFilteredRows(rows);
  renderForecastSummary(filtered);
  document.querySelector("#forecast-table").innerHTML = table([
    { label: "Ingredient", key: "ingredient_name" },
    { label: "Type", key: "ingredient_type" },
    { label: "Usage in Date Range", numeric: true, value: (r) => qty(r.required_qty) },
    { label: "Inventory At Start", numeric: true, value: (r) => forecastInventoryDisplay(r) },
    {
      label: "Remaining",
      numeric: true,
      value: (r) => forecastRemainingDisplay(r),
      className: (r) => forecastRemainingValue(r) < 0 ? "shortage" : "",
    },
    {
      label: "Need to Order",
      numeric: true,
      value: (r) => forecastNeededToOrderDisplay(r),
      className: (r) => forecastNeededToOrderValue(r) > 0 ? "shortage order-needed" : "",
    },
    { label: "Purchase Units", value: (r) => forecastOrderUnitsDisplay(r) },
    { label: "UOM", key: "quantity_uom" },
    { label: "Batches", numeric: true, key: "scheduled_batches" },
    { label: "Products", key: "products" },
    { label: "First Week", key: "first_week" },
    { label: "Last Week", key: "last_week" },
  ], filtered);
}

function renderForecastSummary(rows) {
  const host = document.querySelector("#forecast-summary");
  if (!host) return;
  const totals = rows.reduce((map, row) => {
    const uom = row.quantity_uom || "units";
    const current = map.get(uom) || { usage: 0, order: 0 };
    current.usage += Number(row.required_qty || 0);
    current.order += Number(forecastNeededToOrderValue(row) || 0);
    map.set(uom, current);
    return map;
  }, new Map());
  const shortages = rows.filter((row) => forecastNeededToOrderValue(row) > 0).length;
  const missingInventory = rows.filter((row) => forecastNeededToOrderValue(row) == null && Number(row.required_qty || 0) > 0).length;
  const totalsHtml = [...totals.entries()].map(([uom, values]) => `
    <div class="forecast-summary-card">
      <span>${escapeHtml(uom)}</span>
      <strong>${qty(values.usage)} usage</strong>
      <em class="${values.order > 0 ? "shortage-text" : ""}">${qty(values.order)} to order</em>
    </div>
  `).join("");
  host.innerHTML = `
    <div class="forecast-summary-card ${shortages ? "warning-card" : ""}">
      <span>Shortage Summary</span>
      <strong>${shortages} ingredient${shortages === 1 ? "" : "s"} need ordering</strong>
      <em>${missingInventory ? `${missingInventory} missing inventory values` : "Inventory calculations complete"}</em>
    </div>
    ${totalsHtml}
  `;
}

function renderForecastUnmatchedInventory() {
  const host = document.querySelector("#forecast-unmatched-inventory");
  const rows = state.forecastUnmatchedInventoryRows || [];
  const uploadedCount = state.forecastInventoryRows.length;
  if (!uploadedCount) {
    host.innerHTML = `<div class="empty small-empty">No inventory valuation PDF has been uploaded yet.</div>`;
    return;
  }
  if (!rows.length) {
    host.innerHTML = `<div class="source-note success">Current inventory loaded. All ${uploadedCount} uploaded rows matched the master ingredient list.</div>`;
    return;
  }
  host.innerHTML = `
    <div class="unmatched-panel">
      <div>
        <h3>Unmatched Inventory Items</h3>
        <p>${rows.length} uploaded item${rows.length === 1 ? "" : "s"} did not match the master ingredient list.</p>
      </div>
      ${table([
        { label: "Uploaded Item", key: "uploaded_name" },
        { label: "Uploaded Qty", numeric: true, value: (row) => qty(row.current_qty) },
        { label: "Inventory UOM", key: "inventory_uom" },
        { label: "Gram Conversion", numeric: true, value: (row) => row.grams_per_inventory_unit == null ? "" : qty(row.grams_per_inventory_unit) },
        { label: "Action", value: (row) => `<button class="forecast-add-ingredient" type="button" data-uploaded-name="${escapeHtml(row.uploaded_name)}" data-uom="${escapeHtml(row.quantity_uom || suggestedIngredientUom(row.uploaded_name))}">Add To Inventory</button>` },
      ], rows)}
    </div>
  `;
  host.querySelectorAll(".forecast-add-ingredient").forEach((button) => {
    button.onclick = () => addForecastIngredientFromUpload(button);
  });
}

function suggestedIngredientUom(name) {
  return /\b(bottle|cap|pouch|container|vape|tube|paper|glove|net|band)\b/i.test(name) ? "each" : "grams";
}

async function uploadForecastInventoryPdf(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    setMessage("#forecast-inventory-message", "Reading inventory valuation PDF...");
    const res = await fetch("/api/inventory-upload", {
      method: "POST",
      headers: { "Content-Type": file.type || "application/pdf" },
      body: file,
    });
    const payload = await res.json();
    if (!payload.ok) throw new Error(payload.error);
    await renderForecast();
    setMessage(
      "#forecast-inventory-message",
      `Loaded ${payload.data.rows.length} inventory rows. ${payload.data.matched} matched, ${payload.data.unmatched} unmatched.`,
      payload.data.unmatched ? "warning" : "success",
    );
  } catch (error) {
    setMessage("#forecast-inventory-message", error.message, "error");
  } finally {
    input.value = "";
  }
}

async function addForecastIngredientFromUpload(button) {
  const name = button.dataset.uploadedName || "";
  const purchase_uom = button.dataset.uom || suggestedIngredientUom(name);
  try {
    button.disabled = true;
    button.textContent = "Adding...";
    await api("/api/ingredients", {
      method: "POST",
      body: JSON.stringify({ name, purchase_uom, ingredient_type: "SB/Hijnx" }),
    });
    await api("/api/inventory-upload/rematch", { method: "POST" });
    await loadReference();
    await renderForecast();
    setMessage("#forecast-inventory-message", `${name} added to the master ingredient list.`, "success");
  } catch (error) {
    button.disabled = false;
    button.textContent = "Add To Inventory";
    setMessage("#forecast-inventory-message", error.message, "error");
  }
}

function printForecastReport(rows) {
  const printWindow = window.open("", "_blank", "width=1100,height=850");
  if (!printWindow) {
    setMessage("#forecast-window", "Allow pop-ups to print the forecast report.", "error");
    return;
  }
  const windowLabel = document.querySelector("#forecast-window").textContent || "";
  const typeLabel = state.forecastIngredientType || "All types";
  const searchLabel = state.forecastFilter || "None";
  const totalQtyByUom = rows.reduce((totals, row) => {
    const uom = row.quantity_uom || "units";
    const current = totals.get(uom) || { usage: 0, order: 0 };
    current.usage += Number(row.required_qty || 0);
    current.order += Number(forecastNeededToOrderValue(row) || 0);
    totals.set(uom, current);
    return totals;
  }, new Map());
  const totalsHtml = Array.from(totalQtyByUom.entries()).map(([uom, values]) => (
    `<div><strong>${qty(values.usage)} ${escapeHtml(uom)}</strong><span>Usage · ${qty(values.order)} to order</span></div>`
  )).join("");
  const rowsHtml = rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.ingredient_name)}</td>
      <td>${escapeHtml(row.ingredient_type)}</td>
      <td class="numeric">${qty(row.required_qty)}</td>
      <td class="numeric">${forecastInventoryDisplay(row)}</td>
      <td class="numeric ${forecastRemainingValue(row) < 0 ? "shortage" : ""}">${forecastRemainingDisplay(row)}</td>
      <td class="numeric ${forecastNeededToOrderValue(row) > 0 ? "shortage" : ""}">${forecastNeededToOrderDisplay(row)}</td>
      <td>${forecastOrderUnitsDisplay(row)}</td>
      <td>${escapeHtml(row.quantity_uom)}</td>
      <td class="numeric">${escapeHtml(row.scheduled_batches)}</td>
      <td>${escapeHtml(row.products || "")}</td>
      <td>${escapeHtml(row.first_week || "")}</td>
      <td>${escapeHtml(row.last_week || "")}</td>
    </tr>
  `).join("");
  printWindow.document.write(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Ingredient Forecast Report</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 24px; color: #172026; font-family: Arial, sans-serif; background: #fff; }
          header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; border-bottom: 2px solid #172026; padding-bottom: 12px; margin-bottom: 16px; }
          h1 { margin: 0 0 6px; font-size: 22px; }
          .meta { color: #5f6c72; font-size: 12px; line-height: 1.5; text-align: right; }
          .totals { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 14px; }
          .totals div { border: 1px solid #d9e2e5; border-radius: 6px; padding: 8px 10px; min-width: 120px; display: grid; gap: 2px; }
          .totals strong { font-size: 16px; }
          .totals span { color: #5f6c72; font-size: 11px; }
          table { width: 100%; border-collapse: collapse; font-size: 11px; }
          th, td { border: 1px solid #d9e2e5; padding: 6px 7px; vertical-align: top; text-align: left; }
          th { background: #eef3f2; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
          .numeric { text-align: right; white-space: nowrap; }
          .shortage { background: #fde8e8; color: #b42318; font-weight: 700; }
          .empty { color: #5f6c72; border: 1px dashed #cfd8dc; padding: 14px; }
          tr { break-inside: avoid; page-break-inside: avoid; }
          @page { margin: 0.45in; }
          @media print { body { padding: 0; } }
        </style>
      </head>
      <body>
        <header>
          <div>
            <h1>Ingredient Forecast Report</h1>
            <div>${escapeHtml(windowLabel)}</div>
          </div>
          <div class="meta">
            <div>Time Period: ${state.forecastWeeks} week${state.forecastWeeks === 1 ? "" : "s"}</div>
            <div>Search: ${escapeHtml(searchLabel)}</div>
            <div>Item Type: ${escapeHtml(typeLabel)}</div>
            <div>Rows: ${rows.length}</div>
            <div>Generated: ${escapeHtml(new Date().toLocaleString())}</div>
          </div>
        </header>
        ${totalsHtml ? `<section class="totals">${totalsHtml}</section>` : ""}
        ${rows.length ? `
          <table>
            <thead>
              <tr><th>Ingredient</th><th>Type</th><th class="numeric">Usage in Date Range</th><th class="numeric">Inventory At Start</th><th class="numeric">Remaining</th><th class="numeric">Need to Order</th><th>Purchase Units</th><th>UOM</th><th class="numeric">Batches</th><th>Products</th><th>First Week</th><th>Last Week</th></tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        ` : `<div class="empty">No forecast rows match the current filters.</div>`}
        <script>
          window.addEventListener("load", () => {
            window.print();
          });
        </script>
      </body>
    </html>
  `);
  printWindow.document.close();
}

function velocityRowForProduct(product) {
  return state.velocityRows.find((row) => String(row.product_id) === String(product.id));
}

function velocityProjection(product) {
  const weeks = Math.max(1, Number(state.velocityWeeks) || 1);
  const imported = velocityRowForProduct(product);
  const velocity = Number(imported?.velocity_per_day || 0);
  const projectedUnits = Number(imported?.projected_units || 0);
  const batchSize = Number(product.velocity_units_per_batch || product.batch_size || 0);
  const daysToOut = imported && velocity > 0 && projectedUnits >= 0 ? projectedUnits / velocity : null;
  const totalUnitsNeeded = imported ? velocity * weeks * 7 : null;
  const unitDeficit = imported ? Math.max(0, totalUnitsNeeded - projectedUnits) : null;
  return {
    projected_units: imported && Number.isFinite(projectedUnits) ? projectedUnits : null,
    velocity_per_day: imported ? velocity : null,
    days_to_out: daysToOut,
    total_units_needed: totalUnitsNeeded,
    unit_deficit: unitDeficit,
    velocity_units_per_batch: batchSize > 0 ? batchSize : null,
    batches_needed: imported && batchSize > 0 ? unitDeficit / batchSize : null,
  };
}

function roundedVelocityBatchCount(product) {
  const projection = velocityProjection(product);
  return projection.batches_needed == null ? null : Math.ceil(projection.batches_needed);
}

function velocityProjectionWindow() {
  const weeks = velocityScheduleWeekOptions();
  const startWeek = weeks[0]?.week_start || nextProductionWeekStartIso();
  const endIndex = Math.min(weeks.length - 1, Math.max(1, state.velocityWeeks) - 1);
  return {
    startWeek,
    endWeek: weeks[endIndex]?.week_start || startWeek,
  };
}

async function refreshVelocityPlannedBatches() {
  const production = await api("/api/production-plan");
  const { startWeek, endWeek } = velocityProjectionWindow();
  const counts = new Map();
  (production.batches || []).forEach((batch) => {
    if (batch.week_start < startWeek || batch.week_start > endWeek) return;
    const key = String(batch.product_id);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  state.velocityPlannedBatches = counts;
  return counts;
}

async function renderVelocity() {
  const data = await api("/api/velocity-products");
  state.velocityProducts = data.products || [];
  state.velocityRows = data.rows || [];
  await refreshVelocityPlannedBatches();
  const weeksInput = document.querySelector("#velocity-weeks");
  weeksInput.value = String(state.velocityWeeks);
  weeksInput.oninput = async () => {
    state.velocityWeeks = Math.max(1, Number(weeksInput.value) || 1);
    await refreshVelocityPlannedBatches();
    renderVelocityTable(state.velocityProducts);
    renderVelocityScheduler(state.velocityProducts);
    const form = document.querySelector("#velocity-schedule-form");
    const product = state.velocityProducts.find((item) => String(item.id) === String(form.querySelector("select[name='product_id']").value));
    const roundedBatchCount = product ? roundedVelocityBatchCount(product) : null;
    form.querySelector("input[name='batch_count']").value = roundedBatchCount == null ? "" : String(roundedBatchCount);
  };
  document.querySelector("#velocity-instructions").innerHTML = state.velocityInstructions.length
    ? `<ul>${state.velocityInstructions.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
    : `<ul>
        <li>Upload a Production Needs Report PDF.</li>
        <li>The importer reads SKU names, Projected units, and Vel/Day values, then matches them to active production batches.</li>
        <li>Total units needed is Vel/Day x projection weeks x 7. The unit deficit subtracts projected units, and total batches rounds the deficit up to whole batches.</li>
      </ul>`;
  const sizeProductSelect = document.querySelector("#velocity-size-form select[name='product_id']");
  sizeProductSelect.innerHTML = state.velocityProducts
    .map((product) => `<option value="${product.id}">${escapeHtml(product.category)} - ${escapeHtml(product.name)}</option>`)
    .join("");
  renderVelocityTable(state.velocityProducts);
  renderVelocityScheduler(state.velocityProducts);
  renderVelocitySizeEditor(state.velocityProducts);
}

function renderVelocityTable(products) {
  const rows = products.map((product) => {
    const projection = velocityProjection(product);
    return {
      product_id: product.id,
      product_name: product.name,
      batch_type: product.category,
      projected_units: projection.projected_units,
      velocity_per_day: projection.velocity_per_day,
      days_to_out: projection.days_to_out,
      total_units_needed: projection.total_units_needed,
      unit_deficit: projection.unit_deficit,
      velocity_units_per_batch: projection.velocity_units_per_batch,
      batches_needed: projection.batches_needed,
      planned_batches: state.velocityPlannedBatches.get(String(product.id)) || 0,
    };
  });
  document.querySelector("#velocity-table").innerHTML = table([
    { label: "Production Batch", value: (row) => escapeHtml(row.product_name) },
    { label: "Type", value: (row) => escapeHtml(row.batch_type) },
    { label: "Projected Units", numeric: true, value: (row) => row.projected_units == null ? "" : qty(row.projected_units) },
    { label: "Vel / Day", numeric: true, value: (row) => row.velocity_per_day == null ? "" : qty(row.velocity_per_day) },
    { label: "Days To Out", numeric: true, value: (row) => row.days_to_out == null ? "" : qty(row.days_to_out) },
    { label: "Total Units Needed", numeric: true, value: (row) => row.total_units_needed == null ? "" : qty(row.total_units_needed) },
    { label: "Unit Deficit", numeric: true, value: (row) => row.unit_deficit == null ? "" : qty(row.unit_deficit) },
    { label: "Units / Batch", numeric: true, value: (row) => row.velocity_units_per_batch == null ? "" : qty(row.velocity_units_per_batch) },
    { label: "Batches Needed", numeric: true, value: (row) => row.batches_needed == null ? "" : qty(row.batches_needed) },
    { label: "Total Batches Needed", numeric: true, value: (row) => row.batches_needed == null ? "" : Math.ceil(row.batches_needed) },
    { label: "Planned Batches", numeric: true, key: "planned_batches" },
    { label: "Actions", value: (row) => `<button class="small secondary velocity-use-schedule" type="button" data-product-id="${row.product_id}">Preview Schedule</button>` },
  ], filteredRows(rows, ["product_name", "batch_type"]));
  document.querySelectorAll(".velocity-use-schedule").forEach((button) => {
    button.addEventListener("click", async () => {
      const product = products.find((item) => String(item.id) === String(button.dataset.productId));
      if (!product) return;
      const roundedBatchCount = roundedVelocityBatchCount(product);
      const form = document.querySelector("#velocity-schedule-form");
      form.querySelector("select[name='product_id']").value = String(product.id);
      form.querySelector("input[name='batch_count']").value = roundedBatchCount == null ? "" : String(roundedBatchCount);
      form.querySelector("input[name='quantity']").value = Number(product.batch_size || 0) > 0 ? String(product.batch_size) : "";
      state.velocitySchedulePreview = null;
      document.querySelector("#velocity-schedule-preview").innerHTML = "";
      setMessage("#velocity-schedule-message", "Building schedule preview...");
      try {
        state.velocitySchedulePreview = await velocitySchedulePlan(form);
        renderVelocitySchedulePreview(state.velocitySchedulePreview);
        setMessage("#velocity-schedule-message", "Preview ready. Confirm to add these batches to Production Planner.", "success");
        document.querySelector("#velocity-schedule-preview").scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (error) {
        setMessage("#velocity-schedule-message", error.message, "error");
      }
    });
  });
}

function velocityScheduleWeekOptions() {
  const weeks = state.weeks.map(weekMeta);
  const rollingStart = nextProductionWeekStartIso();
  return weeks.filter((week) => week.week_start >= rollingStart);
}

function evenlySpacedWeeks(weeks, count) {
  if (!weeks.length || count <= 0) return [];
  if (count === 1) return [weeks[0]];
  if (count <= weeks.length) {
    return Array.from({ length: count }, (_, index) => {
      const weekIndex = Math.round((index * (weeks.length - 1)) / (count - 1));
      return weeks[weekIndex];
    });
  }
  return Array.from({ length: count }, (_, index) => {
    const weekIndex = Math.min(weeks.length - 1, Math.floor((index * weeks.length) / count));
    return weeks[weekIndex];
  });
}

function weekContainingDate(weeks, date) {
  const targetIso = isoDate(date);
  return weeks.find((week) => targetIso >= week.week_start && targetIso <= isoDate(week.blockEnd));
}

function velocityFirstScheduleWeek(product, weeks) {
  const projection = velocityProjection(product);
  if (!weeks.length || projection.days_to_out == null || !Number.isFinite(projection.days_to_out)) return null;
  const targetDate = addDays(new Date(), Math.ceil(projection.days_to_out) - 10);
  const containing = weekContainingDate(weeks, targetDate);
  if (containing) return containing;
  const targetIso = isoDate(targetDate);
  if (targetIso < weeks[0].week_start) return weeks[0];
  return weeks[weeks.length - 1];
}

async function velocitySchedulePlan(form) {
  const productId = form.querySelector("select[name='product_id']").value;
  const product = state.velocityProducts.find((item) => String(item.id) === String(productId));
  const targetCount = Math.max(0, Math.ceil(Number(form.querySelector("input[name='batch_count']").value) || 0));
  const quantity = Number(form.querySelector("input[name='quantity']").value) || 0;
  const startWeek = form.querySelector("select[name='start_week']").value;
  const endWeek = form.querySelector("select[name='end_week']").value;
  if (!product) throw new Error("Select a production batch.");
  if (targetCount < 1) throw new Error("Batches needed must be at least 1.");
  if (quantity <= 0) throw new Error("Qty per batch must be greater than zero.");
  if (!startWeek || !endWeek || endWeek < startWeek) throw new Error("Select a valid schedule window.");

  const production = await api("/api/production-plan");
  const selectedWeeks = production.weeks.map(weekMeta).filter((week) => week.week_start >= startWeek && week.week_start <= endWeek);
  if (!selectedWeeks.length) throw new Error("No production weeks found in that schedule window.");
  const firstScheduleWeek = velocityFirstScheduleWeek(product, selectedWeeks) || selectedWeeks[0];
  const weeks = selectedWeeks.filter((week) => week.week_start >= firstScheduleWeek.week_start);
  if (!weeks.length) throw new Error("No production weeks found after the velocity stock-out target.");
  const targetWeeks = evenlySpacedWeeks(weeks, targetCount);
  const targetSlotsByWeek = targetWeeks.reduce((slots, week) => {
    const key = String(week.id);
    slots.set(key, (slots.get(key) || 0) + 1);
    return slots;
  }, new Map());
  const weeksById = new Map(weeks.map((week) => [String(week.id), week]));
  const existing = production.batches.filter((batch) => String(batch.product_id) === String(product.id)
    && batch.week_start >= startWeek
    && batch.week_start <= endWeek);
  const proposed = [];
  for (const [weekId, slotCount] of targetSlotsByWeek.entries()) {
    const week = weeksById.get(weekId);
    for (let index = 0; index < slotCount; index += 1) {
      proposed.push({
        week_id: week.id,
        week_start: week.week_start,
        label: week.label,
        batch_type: product.category,
        product_id: product.id,
        product_name: product.name,
        quantity,
      });
    }
  }
  const selectedTotal = existing.length + proposed.length;
  const overCount = Math.max(0, selectedTotal - targetCount);
  const projection = velocityProjection(product);
  const stockOutDate = projection.days_to_out == null ? "" : isoDate(addDays(new Date(), Math.ceil(projection.days_to_out)));
  const firstBatchTargetDate = projection.days_to_out == null ? "" : isoDate(addDays(new Date(), Math.ceil(projection.days_to_out) - 10));
  return {
    product,
    targetCount,
    quantity,
    startWeek,
    endWeek,
    weeks,
    targetWeeks,
    existing,
    overCount,
    proposed,
    selectedTotal,
    projectedUnits: projection.projected_units,
    velocityPerDay: projection.velocity_per_day,
    daysToOut: projection.days_to_out,
    stockOutDate,
    firstBatchTargetDate,
    firstScheduleWeek,
  };
}

function renderVelocitySchedulePreview(plan) {
  if (!plan.selectedProposedIndexes) {
    plan.selectedProposedIndexes = new Set(plan.proposed.map((_, index) => index));
  }
  const selectedProposedIndexes = plan.selectedProposedIndexes instanceof Set
    ? plan.selectedProposedIndexes
    : new Set(plan.selectedProposedIndexes || []);
  [...selectedProposedIndexes].forEach((index) => {
    if (index < 0 || index >= plan.proposed.length) selectedProposedIndexes.delete(index);
  });
  plan.selectedProposedIndexes = selectedProposedIndexes;
  const initialSelectedCount = selectedProposedIndexes.size;
  const initialSelectedTotal = plan.existing.length + initialSelectedCount;
  const initialOverCount = Math.max(0, initialSelectedTotal - plan.targetCount);
  const warning = initialOverCount > 0
    ? `<div id="velocity-preview-alert" class="form-message error">There are too many entries selected. Existing plus selected recommended batches total ${initialSelectedTotal}, which is ${initialOverCount} over the velocity target of ${plan.targetCount}. Clear recommended batches or delete existing planner entries until this alert clears.</div>`
    : `<div id="velocity-preview-alert" class="form-message success">Existing plus selected recommended batches total ${initialSelectedTotal} against a velocity target of ${plan.targetCount}.</div>`;
  const existingRows = plan.existing.map((batch) => `
    <tr data-batch-id="${batch.id}">
      <td>${escapeHtml(batch.week_start)}</td>
      <td>${escapeHtml(batch.product_name)}</td>
      <td class="numeric">${qty(batch.quantity)}</td>
      <td><button class="small danger delete-velocity-existing" type="button">Delete</button></td>
    </tr>
  `).join("");
  const proposedRows = plan.proposed.map((batch, index) => `
    <tr data-proposed-index="${index}">
      <td><input class="velocity-proposed-select" type="checkbox" ${selectedProposedIndexes.has(index) ? "checked" : ""} aria-label="Select proposed batch"></td>
      <td>${escapeHtml(batch.label)}</td>
      <td>${escapeHtml(batch.product_name)}</td>
      <td class="numeric">${qty(batch.quantity)}</td>
    </tr>
  `).join("");
  document.querySelector("#velocity-schedule-preview").innerHTML = `
    ${warning}
    <div class="velocity-schedule-summary">
      <div><strong>${plan.targetCount}</strong><span>Target Entries</span></div>
      <div><strong>${plan.existing.length}</strong><span>Scheduled Existing</span></div>
      <div><strong id="velocity-selected-count">${initialSelectedCount}</strong><span>Selected Recommended</span></div>
      <div><strong id="velocity-selected-total">${initialSelectedTotal}</strong><span>Total After Add</span></div>
      <div><strong id="velocity-over-count">${initialOverCount}</strong><span>Over Target</span></div>
      <div><strong>${plan.firstScheduleWeek ? escapeHtml(plan.firstScheduleWeek.week_start) : ""}</strong><span>Target First Week</span></div>
    </div>
    ${plan.stockOutDate ? `<div class="source-note">Projected units ${qty(plan.projectedUnits)} at ${qty(plan.velocityPerDay)} units/day estimates an out date of ${escapeHtml(plan.stockOutDate)}. Scheduling begins in the week containing ${escapeHtml(plan.firstBatchTargetDate)}.</div>` : ""}
    <div class="grid two">
      <div>
        <h3>Existing Planner Entries</h3>
        <div class="table-wrap velocity-schedule-table">
          <table><thead><tr><th>Week</th><th>Batch</th><th class="numeric">Qty</th><th>Actions</th></tr></thead><tbody>${existingRows || `<tr><td colspan="4">No existing entries</td></tr>`}</tbody></table>
        </div>
      </div>
      <div>
        <h3>Proposed New Entries</h3>
        <div class="table-wrap velocity-schedule-table">
          <table><thead><tr><th>Select</th><th>Week</th><th>Batch</th><th class="numeric">Qty</th></tr></thead><tbody>${proposedRows || `<tr><td colspan="4">No new entries needed</td></tr>`}</tbody></table>
        </div>
        ${plan.proposed.length ? `
          <div class="velocity-preview-actions">
            <button id="velocity-select-all-proposed" class="small secondary" type="button">Select All</button>
            <button id="velocity-clear-proposed" class="small ghost" type="button">Clear</button>
            <button id="velocity-add-selected" type="button">Add Selected To Planner</button>
          </div>
        ` : ""}
      </div>
    </div>
  `;
  const selectedIndexes = () => Array.from(document.querySelectorAll(".velocity-proposed-select:checked"))
    .map((input) => Number(input.closest("tr").dataset.proposedIndex))
    .filter((index) => Number.isInteger(index));
  const syncSelectedIndexes = () => {
    plan.selectedProposedIndexes = new Set(selectedIndexes());
    state.velocitySchedulePreview = plan;
    return plan.selectedProposedIndexes;
  };
  const refreshSelectionState = () => {
    const selectedCount = syncSelectedIndexes().size;
    const selectedTotal = plan.existing.length + selectedCount;
    const overCount = Math.max(0, selectedTotal - plan.targetCount);
    const alert = document.querySelector("#velocity-preview-alert");
    document.querySelector("#velocity-selected-count").textContent = String(selectedCount);
    document.querySelector("#velocity-selected-total").textContent = String(selectedTotal);
    document.querySelector("#velocity-over-count").textContent = String(overCount);
    if (alert) {
      alert.className = `form-message ${overCount > 0 ? "error" : "success"}`;
      alert.textContent = overCount > 0
        ? `There are too many entries selected. Existing plus selected recommended batches total ${selectedTotal}, which is ${overCount} over the velocity target of ${plan.targetCount}.`
        : `Existing plus selected recommended batches total ${selectedTotal} against a velocity target of ${plan.targetCount}.`;
    }
    const addButton = document.querySelector("#velocity-add-selected");
    if (addButton) addButton.disabled = overCount > 0;
    return { selectedCount, selectedTotal, overCount };
  };
  document.querySelector("#velocity-select-all-proposed")?.addEventListener("click", () => {
    document.querySelectorAll(".velocity-proposed-select").forEach((input) => { input.checked = true; });
    plan.selectedProposedIndexes = new Set(plan.proposed.map((_, index) => index));
    state.velocitySchedulePreview = plan;
    refreshSelectionState();
  });
  document.querySelector("#velocity-clear-proposed")?.addEventListener("click", () => {
    document.querySelectorAll(".velocity-proposed-select").forEach((input) => { input.checked = false; });
    plan.selectedProposedIndexes = new Set();
    state.velocitySchedulePreview = plan;
    refreshSelectionState();
  });
  document.querySelectorAll(".velocity-proposed-select").forEach((input) => {
    input.addEventListener("change", refreshSelectionState);
  });
  document.querySelector("#velocity-add-selected")?.addEventListener("click", async () => {
    const selectionState = refreshSelectionState();
    if (selectionState.overCount > 0) {
      setMessage("#velocity-schedule-message", "There are too many batches selected for this velocity target. Clear recommended batches or delete existing entries first.", "error");
      return;
    }
    const indexes = selectedIndexes();
    if (!indexes.length) {
      setMessage("#velocity-schedule-message", "Select at least one proposed batch to add.", "error");
      return;
    }
    setMessage("#velocity-schedule-message", "Adding selected scheduled batches...");
    try {
      for (const index of indexes) {
        const batch = plan.proposed[index];
        await api("/api/production-batches", {
          method: "POST",
          body: JSON.stringify({
            batch_type: batch.batch_type,
            product_id: batch.product_id,
            week_id: batch.week_id,
            quantity: batch.quantity,
            notes: `Auto scheduled from velocity target of ${plan.targetCount} batches between ${plan.startWeek} and ${plan.endWeek}.`,
          }),
        });
      }
      state.velocitySchedulePreview = await velocitySchedulePlan(document.querySelector("#velocity-schedule-form"));
      await refreshVelocityPlannedBatches();
      renderVelocityTable(state.velocityProducts);
      renderVelocitySchedulePreview(state.velocitySchedulePreview);
      const totalAfterAdd = state.velocitySchedulePreview.existing.length;
      const overMessage = totalAfterAdd > state.velocitySchedulePreview.targetCount
        ? ` This window is now over target by ${totalAfterAdd - state.velocitySchedulePreview.targetCount}.`
        : "";
      setMessage("#velocity-schedule-message", `Added ${indexes.length} selected batch entr${indexes.length === 1 ? "y" : "ies"}.${overMessage}`, "success");
    } catch (error) {
      setMessage("#velocity-schedule-message", error.message, "error");
    }
  });
  refreshSelectionState();
  document.querySelectorAll(".delete-velocity-existing").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest("tr");
      if (!confirm("Delete this scheduled batch entry?")) return;
      setMessage("#velocity-schedule-message", "Deleting scheduled batch...");
      try {
        const preservedSelectedIndexes = new Set(selectedIndexes());
        await api(`/api/production-batches/${row.dataset.batchId}`, { method: "DELETE" });
        setMessage("#velocity-schedule-message", "Scheduled batch deleted. Rebuilding preview...", "success");
        state.velocitySchedulePreview = await velocitySchedulePlan(document.querySelector("#velocity-schedule-form"));
        state.velocitySchedulePreview.selectedProposedIndexes = preservedSelectedIndexes;
        await refreshVelocityPlannedBatches();
        renderVelocityTable(state.velocityProducts);
        renderVelocitySchedulePreview(state.velocitySchedulePreview);
      } catch (error) {
        setMessage("#velocity-schedule-message", error.message, "error");
      }
    });
  });
}

function renderVelocityScheduler(products) {
  const form = document.querySelector("#velocity-schedule-form");
  const productSelect = form.querySelector("select[name='product_id']");
  const startSelect = form.querySelector("select[name='start_week']");
  const endSelect = form.querySelector("select[name='end_week']");
  const quantityInput = form.querySelector("input[name='quantity']");
  const weeks = velocityScheduleWeekOptions();
  const previousProduct = productSelect.value;
  const previousStart = startSelect.value;
  productSelect.innerHTML = products.map((product) => `<option value="${product.id}">${escapeHtml(product.category)} - ${escapeHtml(product.name)}</option>`).join("");
  const weekOptions = weeks.map((week) => `<option value="${week.week_start}">${escapeHtml(week.label)}</option>`).join("");
  startSelect.innerHTML = weekOptions;
  endSelect.innerHTML = weekOptions;
  if (previousProduct && products.some((product) => String(product.id) === String(previousProduct))) productSelect.value = previousProduct;
  if (previousStart && weeks.some((week) => week.week_start === previousStart)) startSelect.value = previousStart;
  const selectedStartIndex = Math.max(0, weeks.findIndex((week) => week.week_start === startSelect.value));
  if (weeks.length) {
    const projectedEndIndex = Math.min(weeks.length - 1, selectedStartIndex + Math.max(1, state.velocityWeeks) - 1);
    endSelect.value = weeks[projectedEndIndex].week_start;
  }
  const updateProductDefaults = () => {
    const product = products.find((item) => String(item.id) === String(productSelect.value));
    if (!product) return;
    const roundedBatchCount = roundedVelocityBatchCount(product);
    form.querySelector("input[name='batch_count']").value = roundedBatchCount == null ? "" : String(roundedBatchCount);
    quantityInput.value = Number(product.batch_size || 0) > 0 ? String(product.batch_size) : "";
    state.velocitySchedulePreview = null;
    document.querySelector("#velocity-schedule-preview").innerHTML = "";
  };
  const updateEndWeekFromStart = () => {
    const startIndex = Math.max(0, weeks.findIndex((week) => week.week_start === startSelect.value));
    if (!weeks.length) return;
    const endIndex = Math.min(weeks.length - 1, startIndex + Math.max(1, state.velocityWeeks) - 1);
    endSelect.value = weeks[endIndex].week_start;
    state.velocitySchedulePreview = null;
    document.querySelector("#velocity-schedule-preview").innerHTML = "";
  };
  productSelect.onchange = updateProductDefaults;
  startSelect.onchange = updateEndWeekFromStart;
  if (!quantityInput.value) updateProductDefaults();
  form.onsubmit = async (event) => {
    event.preventDefault();
    setMessage("#velocity-schedule-message", "Building schedule preview...");
    try {
      state.velocitySchedulePreview = await velocitySchedulePlan(form);
      renderVelocitySchedulePreview(state.velocitySchedulePreview);
      setMessage("#velocity-schedule-message", "Preview ready.", "success");
    } catch (error) {
      state.velocitySchedulePreview = null;
      document.querySelector("#velocity-schedule-preview").innerHTML = "";
      setMessage("#velocity-schedule-message", error.message, "error");
    }
  };
}

function renderVelocitySizeEditor(products) {
  const rows = filteredRows(products, ["name", "category"]);
  document.querySelector("#velocity-size-editor").innerHTML = rows.length ? `
    <div class="table-wrap velocity-size-table-wrap">
      <table class="editor-table">
        <thead><tr><th>Production Batch</th><th>Type</th><th class="numeric">Standard Batch Size</th><th>Actions</th></tr></thead>
        <tbody>${rows.map((product) => `
          <tr data-product-id="${product.id}">
            <td>${escapeHtml(product.name)}</td>
            <td>${escapeHtml(product.category)}</td>
            <td><input class="velocity-size-input" aria-label="Standard batch size" type="number" min="0.000001" step="0.000001" value="${escapeHtml(product.batch_size ?? "")}"></td>
            <td class="row-actions">
              <button class="small secondary save-velocity-size" type="button">Save</button>
              <button class="small danger delete-velocity-size" type="button">Delete</button>
            </td>
          </tr>
        `).join("")}</tbody>
      </table>
    </div>
  ` : `<div class="empty-calendar">No production batches found.</div>`;
  document.querySelectorAll(".save-velocity-size").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest("tr");
      try {
        await api(`/api/velocity-batch-sizes/${row.dataset.productId}`, {
          method: "PATCH",
          body: JSON.stringify({ batch_size: row.querySelector(".velocity-size-input").value }),
        });
        setMessage("#velocity-size-message", "Standard batch size saved.", "success");
        await renderVelocity();
      } catch (error) {
        setMessage("#velocity-size-message", error.message, "error");
      }
    });
  });
  document.querySelectorAll(".delete-velocity-size").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest("tr");
      if (!confirm("Delete this standard batch size?")) return;
      try {
        await api(`/api/velocity-batch-sizes/${row.dataset.productId}`, { method: "DELETE" });
        setMessage("#velocity-size-message", "Standard batch size deleted.", "success");
        await renderVelocity();
      } catch (error) {
        setMessage("#velocity-size-message", error.message, "error");
      }
    });
  });
}

async function renderInventory() {
  const ingredients = await api("/api/ingredients");
  const rows = filteredRows(ingredients.filter((ingredient) => Number(ingredient.is_master)), ["name", "purchase_uom", "ingredient_type"]);
  document.querySelector("#inventory-table").innerHTML = rows.length ? `
    <div class="table-wrap editor-table-wrap">
      <table class="editor-table inventory-table">
        <thead><tr><th>Name</th><th>UOM</th><th>Ingredient Type</th><th>Actions</th></tr></thead>
        <tbody>${rows.map((ingredient) => `
          <tr data-ingredient-id="${ingredient.id}">
            <td><input class="inventory-edit-name" aria-label="Ingredient name" value="${escapeHtml(ingredient.name)}"></td>
            <td>
              <select class="inventory-edit-uom" aria-label="UOM">
                <option value="grams" ${ingredient.purchase_uom === "grams" ? "selected" : ""}>Gram</option>
                <option value="each" ${ingredient.purchase_uom === "each" ? "selected" : ""}>Each</option>
              </select>
            </td>
            <td>
              <select class="inventory-edit-type" aria-label="Ingredient type">
                ${optionList(["SB/Hijnx", "SB", "Hijnx"].map((type) => ({ id: type, name: type })), ingredient.ingredient_type || "SB/Hijnx")}
              </select>
            </td>
            <td class="row-actions">
              <button class="small secondary save-inventory" type="button">Save</button>
              <button class="small danger delete-inventory" type="button">Delete</button>
            </td>
          </tr>
        `).join("")}</tbody>
      </table>
    </div>
  ` : `<div class="empty-calendar">No inventory items found.</div>`;
  document.querySelectorAll(".save-inventory").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest("tr");
      const message = document.querySelector("#inventory-message");
      try {
        const updated = await api(`/api/ingredients/${row.dataset.ingredientId}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: row.querySelector(".inventory-edit-name").value,
            purchase_uom: row.querySelector(".inventory-edit-uom").value,
            ingredient_type: row.querySelector(".inventory-edit-type").value,
          }),
        });
        message.textContent = `Saved ${updated.name}.`;
        await loadReference();
        await renderInventory();
      } catch (error) {
        message.textContent = error.message;
      }
    });
  });
  document.querySelectorAll(".delete-inventory").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest("tr");
      const name = row.querySelector(".inventory-edit-name").value;
      const message = document.querySelector("#inventory-message");
      if (!confirm(`Delete ${name}? This will also remove it from any product BOMs.`)) return;
      try {
        await api(`/api/ingredients/${row.dataset.ingredientId}`, { method: "DELETE" });
        message.textContent = `Deleted ${name}.`;
        await loadReference();
        await renderInventory();
      } catch (error) {
        message.textContent = error.message;
      }
    });
  });
}

async function renderFormulas() {
  await refreshFormulaManager();
}

async function refreshFormulaManager() {
  const data = await api(`/api/formulas?_=${Date.now()}`);
  const batches = data.products;
  if (!state.selectedFormulaProductId && batches.length) {
    state.selectedFormulaProductId = String(batches[0].id);
  }
  const selectedProduct = batches.find((product) => String(product.id) === String(state.selectedFormulaProductId));
  document.querySelector("#formula-batch-list").innerHTML = batches.map((product) => {
    const count = data.formulas.filter((formula) => String(formula.product_id) === String(product.id)).length;
    const active = String(product.id) === String(state.selectedFormulaProductId) ? "active" : "";
    return `
      <button class="batch-list-item ${active}" data-product="${product.id}">
        <strong>${escapeHtml(product.name)}</strong>
        <span>${escapeHtml(product.category || "")} · Batch QTY ${product.batch_size == null ? "Not set" : qty(product.batch_size)} · ${count} ingredients</span>
      </button>
    `;
  }).join("") || `<div class="empty-calendar">No production batches found.</div>`;
  document.querySelectorAll(".batch-list-item").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedFormulaProductId = button.dataset.product;
      await renderFormulas();
    });
  });

  const form = document.querySelector("#formula-form");
  form.querySelector("input[name='product_id']").value = selectedProduct?.id || "";
  document.querySelector("#formula-focus-title").textContent = selectedProduct ? selectedProduct.name : "Select a batch";
  document.querySelector("#formula-focus-meta").textContent = selectedProduct ? `${selectedProduct.category || ""} BOM` : "";
  const batchSizeForm = document.querySelector("#formula-batch-size-form");
  const batchSizeInput = batchSizeForm.querySelector("input[name='batch_size']");
  batchSizeForm.querySelector("input[name='product_id']").value = selectedProduct?.id || "";
  batchSizeInput.value = selectedProduct?.batch_size ?? "";
  batchSizeInput.disabled = !selectedProduct;
  batchSizeForm.querySelector("button").disabled = !selectedProduct;
  updateFormulaUomDisplay();

  const selectedFormulas = data.formulas.filter((formula) => String(formula.product_id) === String(state.selectedFormulaProductId));
  const exportButton = document.querySelector("#formula-export-bom");
  exportButton.dataset.productId = selectedProduct?.id || "";
  exportButton.disabled = !selectedProduct || !selectedFormulas.length || !(Number(selectedProduct.batch_size) > 0);
  updateFormulaCopyForm(batches, data.formulas, selectedFormulas);
  renderFormulaEditor(selectedFormulas);
}

function updateFormulaCopyForm(products, formulas, selectedFormulas) {
  const form = document.querySelector("#formula-copy-form");
  const select = form.querySelector("select[name='source_product_id']");
  const target = form.querySelector("input[name='target_product_id']");
  target.value = state.selectedFormulaProductId || "";
  form.dataset.hasBom = selectedFormulas.length ? "1" : "";
  const options = products
    .map((product) => {
      const count = formulas.filter((formula) => String(formula.product_id) === String(product.id)).length;
      return { ...product, count };
    })
    .filter((product) => product.count > 0 && String(product.id) !== String(state.selectedFormulaProductId));
  select.innerHTML = options.length
    ? options.map((product) => (
      `<option value="${product.id}">${escapeHtml(product.name)} (${product.count})</option>`
    )).join("")
    : `<option value="">No BOMs available to copy</option>`;
  select.disabled = !options.length || !state.selectedFormulaProductId;
  form.querySelector("button").disabled = select.disabled;
}

function updateFormulaUomDisplay() {
  const select = document.querySelector("#formula-form select[name='ingredient_id']");
  const display = document.querySelector("#formula-uom-display");
  if (!select || !display) return;
  display.value = select.selectedOptions[0]?.dataset.uom || "grams";
}

function renderFormulaEditor(formulas) {
  const rows = filteredRows(formulas, ["ingredient_name", "quantity_uom"]);
  const masterIngredients = state.ingredients.filter((ingredient) => Number(ingredient.is_master));
  const html = rows.length ? `
    <div class="formula-editor-toolbar">
      <button id="save-formula-changes" type="button">Save Formula Changes</button>
    </div>
    <div class="table-wrap editor-table-wrap">
      <table class="editor-table">
        <thead><tr><th>Ingredient</th><th class="numeric">Qty / Unit</th><th>UOM</th><th>Actions</th></tr></thead>
        <tbody>${rows.map((formula) => `
          <tr data-formula-id="${formula.id}">
            <td>
              <select class="formula-edit-ingredient" aria-label="Ingredient">
                ${optionList(masterIngredients, formula.ingredient_id)}
              </select>
            </td>
            <td><input class="formula-edit-quantity" aria-label="Quantity per unit" type="number" min="0.000001" step="0.000001" value="${escapeHtml(formula.quantity_per_unit)}"></td>
            <td class="formula-row-uom">${escapeHtml(formula.quantity_uom || "grams")}</td>
            <td class="row-actions">
              <button class="small secondary save-formula" type="button">Save</button>
              <button class="small danger delete-formula" type="button">Delete</button>
            </td>
          </tr>
        `).join("")}</tbody>
      </table>
    </div>
  ` : `<div class="empty-calendar">No BOM ingredients for this batch.</div>`;
  document.querySelector("#formula-table").innerHTML = html;
  document.querySelectorAll(".formula-edit-ingredient").forEach((select) => {
    select.addEventListener("change", () => {
      const ingredient = state.ingredients.find((item) => String(item.id) === String(select.value));
      select.closest("tr").querySelector(".formula-row-uom").textContent = ingredient?.bom_uom || "grams";
    });
  });
  document.querySelector("#save-formula-changes")?.addEventListener("click", async () => {
    const formulaRows = [...document.querySelectorAll("#formula-table tr[data-formula-id]")];
    if (!formulaRows.length) return;
    setMessage("#formula-message", `Saving ${formulaRows.length} BOM ingredient${formulaRows.length === 1 ? "" : "s"}...`);
    try {
      for (const row of formulaRows) {
        await api(`/api/formulas/${row.dataset.formulaId}`, {
          method: "PATCH",
          body: JSON.stringify({
            ingredient_id: row.querySelector(".formula-edit-ingredient").value,
            quantity_per_unit: row.querySelector(".formula-edit-quantity").value,
          }),
        });
      }
      setMessage("#formula-message", "Formula changes saved.", "success");
      await refreshFormulaManager();
    } catch (error) {
      setMessage("#formula-message", error.message, "error");
    }
  });
  document.querySelectorAll(".save-formula").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest("tr");
      setMessage("#formula-message", "Saving BOM ingredient...");
      try {
        await api(`/api/formulas/${row.dataset.formulaId}`, {
          method: "PATCH",
          body: JSON.stringify({
            ingredient_id: row.querySelector(".formula-edit-ingredient").value,
            quantity_per_unit: row.querySelector(".formula-edit-quantity").value,
          }),
        });
        setMessage("#formula-message", "BOM ingredient saved.", "success");
        await refreshFormulaManager();
      } catch (error) {
        setMessage("#formula-message", error.message, "error");
      }
    });
  });
  document.querySelectorAll(".delete-formula").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest("tr");
      if (!confirm("Delete this BOM ingredient?")) return;
      setMessage("#formula-message", "Deleting BOM ingredient...");
      try {
        await api(`/api/formulas/${row.dataset.formulaId}`, { method: "DELETE" });
        setMessage("#formula-message", "BOM ingredient deleted.", "success");
        await refreshFormulaManager();
      } catch (error) {
        setMessage("#formula-message", error.message, "error");
      }
    });
  });
}

const renderers = {
  dashboard: renderDashboard,
  production: renderProduction,
  "rl-scheduled-batches": renderRlScheduledBatches,
  velocity: renderVelocity,
  forecast: renderForecast,
  inventory: renderInventory,
  formulas: renderFormulas,
};

async function activate(tab) {
  document.querySelectorAll("#tabs button").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === tab));
  document.querySelector("#page-title").textContent = titles[tab][0];
  document.querySelector("#page-subtitle").textContent = titles[tab][1];
  await renderers[tab]();
  window.scrollTo({ top: 0, behavior: "auto" });
}

document.querySelector("#tabs").addEventListener("click", async (event) => {
  if (event.target.matches("button[data-tab]")) await activate(event.target.dataset.tab);
});

document.querySelector("#refresh").addEventListener("click", async () => {
  await loadReference();
  await activate(document.querySelector("#tabs button.active").dataset.tab);
});

document.querySelector("#global-filter").addEventListener("input", (event) => {
  state.filter = event.target.value;
  clearTimeout(filterRenderTimer);
  filterRenderTimer = setTimeout(() => {
    activate(document.querySelector("#tabs button.active").dataset.tab);
  }, 250);
});

document.querySelector("#velocity-upload").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  setMessage("#velocity-message", "Reading production needs PDF...");
  try {
    const res = await fetch("/api/velocity/import", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: await file.arrayBuffer(),
    });
    const payload = await res.json();
    if (!payload.ok) throw new Error(payload.error);
    state.velocityRows = payload.data.rows || [];
    state.velocityInstructions = payload.data.instructions || [];
    setMessage(
      "#velocity-message",
      `Imported ${payload.data.parsed_count} velocity rows, matched ${payload.data.matched_count}.`,
      "success",
    );
    await renderVelocity();
  } catch (error) {
    setMessage("#velocity-message", error.message, "error");
  }
});

document.querySelector("#velocity-clear").addEventListener("click", async () => {
  try {
    await api("/api/velocity/import", { method: "DELETE" });
    state.velocityRows = [];
    state.velocityInstructions = [];
    document.querySelector("#velocity-upload").value = "";
    setMessage("#velocity-message", "Shared velocity upload cleared.", "success");
    await renderVelocity();
  } catch (error) {
    setMessage("#velocity-message", error.message, "error");
  }
});

document.querySelector("#velocity-size-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("/api/velocity-batch-sizes", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
    });
    form.querySelector("input[name='batch_size']").value = "";
    setMessage("#velocity-size-message", "Standard batch size saved.", "success");
    await renderVelocity();
  } catch (error) {
    setMessage("#velocity-size-message", error.message, "error");
  }
});

document.querySelector("#formula-form select[name='ingredient_id']").addEventListener("change", updateFormulaUomDisplay);

document.querySelector("#formula-export-bom").addEventListener("click", (event) => {
  const productId = event.currentTarget.dataset.productId;
  if (!productId) return;
  window.location.href = `/api/formulas/export/${productId}`;
});

document.querySelector("#formula-import-bom").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const preview = JSON.parse(await file.text());
    const productName = String(preview?.bom?.product?.name || "").trim();
    if (preview?.format !== "ingredient-projection-bom" || Number(preview?.version) !== 1 || !productName) {
      throw new Error("Select a valid Ingredient Projection BOM transfer file.");
    }
    if (!confirm(`Import ${productName}? If this production batch already exists, its current BOM will be replaced.`)) {
      input.value = "";
      return;
    }
    setMessage("#formula-transfer-message", `Importing ${productName}...`);
    const response = await fetch("/api/formulas/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: await file.arrayBuffer(),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error);
    const imported = payload.data;
    state.selectedFormulaProductId = String(imported.product_id);
    input.value = "";
    await loadReference();
    await refreshFormulaManager();
    const createdSummary = [
      imported.created_product ? "created the production batch" : "updated the production batch",
      imported.created_ingredients ? `created ${imported.created_ingredients} missing ingredient${imported.created_ingredients === 1 ? "" : "s"}` : "matched all ingredients",
    ].join(" and ");
    setMessage(
      "#formula-transfer-message",
      `Imported ${imported.product_name}: ${imported.imported_ingredients} BOM ingredients, Batch QTY ${qty(imported.batch_size)}; ${createdSummary}.`,
      "success",
    );
  } catch (error) {
    input.value = "";
    setMessage("#formula-transfer-message", error.message, "error");
  }
});

document.querySelector("#formula-batch-size-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const productId = form.querySelector("input[name='product_id']").value;
  const batchSize = form.querySelector("input[name='batch_size']").value;
  if (!productId) return;
  setMessage("#formula-message", "Saving Batch QTY...");
  try {
    await api(`/api/velocity-batch-sizes/${productId}`, {
      method: "PATCH",
      body: JSON.stringify({ batch_size: batchSize }),
    });
    setMessage("#formula-message", "Batch QTY saved.", "success");
    await refreshFormulaManager();
  } catch (error) {
    setMessage("#formula-message", error.message, "error");
  }
});

document.querySelector("#formula-product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setMessage("#formula-product-message", "Adding production batch...");
  try {
    const created = await api("/api/products", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
    });
    form.reset();
    state.selectedFormulaProductId = String(created.id);
    setMessage("#formula-product-message", `Added ${created.name}.`, "success");
    await loadReference();
    await renderFormulas();
  } catch (error) {
    setMessage("#formula-product-message", error.message, "error");
  }
});

document.querySelector("#inventory-item-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector("#inventory-message");
  try {
    const created = await api("/api/ingredients", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
    });
    form.reset();
    message.textContent = `Added ${created.name} to the master inventory list.`;
    await loadReference();
    await renderInventory();
  } catch (error) {
    message.textContent = error.message;
  }
});

document.querySelector("#formula-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formEl = event.currentTarget;
  const form = new FormData(formEl);
  if (!form.get("product_id")) return;
  setMessage("#formula-message", "Saving BOM ingredient...");
  try {
    await api("/api/formulas", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    formEl.querySelector("input[name='quantity_per_unit']").value = "";
    setMessage("#formula-message", "BOM ingredient saved.", "success");
    await refreshFormulaManager();
  } catch (error) {
    setMessage("#formula-message", error.message, "error");
  }
});

document.querySelector("#formula-copy-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formEl = event.currentTarget;
  const form = new FormData(formEl);
  if (!form.get("source_product_id") || !form.get("target_product_id")) return;
  if (formEl.dataset.hasBom && !confirm("Replace this product BOM with the copied BOM?")) return;
  setMessage("#formula-message", "Copying BOM...");
  try {
    const copied = await api("/api/formulas/copy", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    setMessage("#formula-message", `Copied ${copied.copied} BOM ingredients.`, "success");
    await refreshFormulaManager();
  } catch (error) {
    setMessage("#formula-message", error.message, "error");
  }
});

// PWA: store the deferred browser install prompt so the internal install button can trigger it.
let deferredInstallPrompt = null;

function isRunningStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function updateInstallButton() {
  const button = document.querySelector("#install-app");
  if (!button) return;
  if (isRunningStandalone()) {
    button.textContent = "App Installed";
    button.disabled = true;
    return;
  }
  button.textContent = deferredInstallPrompt ? "Install App" : "How To Install";
  button.disabled = false;
}

function openInstallDialog() {
  const dialog = document.querySelector("#install-dialog");
  const nativeActions = document.querySelector("#install-native-actions");
  const summary = document.querySelector("#install-summary");
  if (!dialog || !nativeActions || !summary) return;
  nativeActions.hidden = !deferredInstallPrompt;
  summary.textContent = deferredInstallPrompt
    ? "Use Install Now for the browser prompt, or follow the manual steps for your device."
    : "Use the steps below to add this internal app to your home screen.";
  dialog.hidden = false;
}

function closeInstallDialog() {
  const dialog = document.querySelector("#install-dialog");
  if (dialog) dialog.hidden = true;
}

async function runNativeInstallPrompt() {
  if (!deferredInstallPrompt) {
    openInstallDialog();
    return;
  }
  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;
  promptEvent.prompt();
  await promptEvent.userChoice.catch(() => null);
  updateInstallButton();
  closeInstallDialog();
}

// PWA: Chrome/Edge/Android fire beforeinstallprompt when manifest and service worker are installable.
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallButton();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  updateInstallButton();
  closeInstallDialog();
});

document.querySelector("#install-app").addEventListener("click", () => {
  if (deferredInstallPrompt) {
    runNativeInstallPrompt();
  } else {
    openInstallDialog();
  }
});

document.querySelector("#install-native").addEventListener("click", runNativeInstallPrompt);
document.querySelector("#install-close").addEventListener("click", closeInstallDialog);
document.querySelector("#install-dialog").addEventListener("click", (event) => {
  if (event.target.id === "install-dialog") closeInstallDialog();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeInstallDialog();
});
updateInstallButton();

// PWA: register the online-first service worker without blocking the live app startup.
if ("serviceWorker" in navigator) {
  let refreshingForServiceWorker = false;
  const refreshInstalledApp = async () => {
    if (refreshingForServiceWorker) return;
    refreshingForServiceWorker = true;
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    const url = new URL(window.location.href);
    url.searchParams.set("appVersion", APP_VERSION);
    window.location.replace(url.toString());
  };
  const checkAppVersion = async () => {
    try {
      const response = await fetch(`/app-version.json?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      if (data.version && data.version !== APP_VERSION) await refreshInstalledApp();
    } catch {
      // Version checks should never block normal app use.
    }
  };
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    refreshInstalledApp();
  });
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "APP_VERSION_UPDATED") refreshInstalledApp();
  });

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/service-worker.js");
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            worker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
      await registration.update();
      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }
      await checkAppVersion();
    } catch (error) {
      console.warn("Service worker registration failed", error);
    }
  });
  window.addEventListener("focus", checkAppVersion);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkAppVersion();
  });
}

loadReference().then(() => activate("dashboard")).catch((error) => {
  document.body.insertAdjacentHTML("beforeend", `<pre>${escapeHtml(error.message)}</pre>`);
});
