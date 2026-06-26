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
  forecastMonths: 6,
  forecastFilter: "",
  forecastIngredientType: "",
  forecastRows: [],
  velocityWeeks: 4,
  velocityRows: [],
  velocityInstructions: [],
  velocityProducts: [],
  velocitySchedulePreview: null,
  selectedFormulaProductId: "",
  selectedProductionWeekId: "",
};
let filterRenderTimer;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
  const rollingStartWeek = nextProductionWeekStartIso();
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
    <tr data-batch-id="${batch.id}">
      <td>
        <select class="batch-edit-type" aria-label="Batch type">
          ${optionList(batchTypes.map((type) => ({ id: type, name: type })), batch.batch_type)}
        </select>
      </td>
      <td>
        <select class="batch-edit-product" aria-label="Product">
          ${optionList(matchingProducts, batch.product_id)}
        </select>
      </td>
      <td>
        <select class="batch-edit-week" aria-label="Production week">
          ${optionList(weeks, batch.week_id, (week) => week.label)}
        </select>
      </td>
      <td><input class="batch-edit-quantity" aria-label="Quantity" type="number" min="1" step="1" value="${escapeHtml(batch.quantity)}"></td>
      <td class="row-actions">
        <button class="small secondary save-batch" type="button">Save</button>
        <button class="small danger delete-batch" type="button">Delete</button>
      </td>
    </tr>
  `;
}

function renderProductionBatchEditor(batches, products, weeks, batchTypes) {
  const rows = filteredRows(batches, ["week_start", "batch_type", "product_name"]);
  const html = rows.length ? `
    <div class="table-wrap editor-table-wrap">
      <table class="editor-table">
        <thead><tr><th>Type</th><th>Product</th><th>Week</th><th class="numeric">Qty</th><th>Actions</th></tr></thead>
        <tbody>${rows.map((batch) => productionBatchEditorRow(batch, products, weeks, batchTypes)).join("")}</tbody>
      </table>
    </div>
  ` : `<div class="empty-calendar">No scheduled batches in this filter.</div>`;
  document.querySelector("#production-batches").innerHTML = html;
  document.querySelectorAll(".batch-edit-type").forEach((select) => {
    select.addEventListener("change", () => {
      const row = select.closest("tr");
      const productSelect = row.querySelector(".batch-edit-product");
      const matchingProducts = products.filter((product) => product.category === select.value);
      productSelect.innerHTML = optionList(matchingProducts, matchingProducts[0]?.id);
    });
  });
  document.querySelectorAll(".save-batch").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest("tr");
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
      const row = button.closest("tr");
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
  const firstVisible = parseIsoDate(nextProductionWeekStartIso());
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

function renderProductionCalendar(batches, weeks) {
  const batchesByWeek = new Map();
  batches.forEach((batch) => {
    const key = String(batch.week_id);
    if (!batchesByWeek.has(key)) batchesByWeek.set(key, []);
    batchesByWeek.get(key).push(batch);
  });
  const monthGroups = weeks.reduce((groups, week) => {
    if (!groups.has(week.monthKey)) groups.set(week.monthKey, { label: week.monthLabel, weeks: [] });
    groups.get(week.monthKey).weeks.push(week);
    return groups;
  }, new Map());
  const html = Array.from(monthGroups.values()).map((group) => `
    <div class="calendar-month">
      <h3>${escapeHtml(group.label)}</h3>
      <div class="week-grid">
        ${group.weeks.map((week) => {
          const scheduled = batchesByWeek.get(String(week.id)) || [];
          return `
            <article class="week-card ${String(week.id) === String(state.selectedProductionWeekId) ? "selected" : ""}" role="button" tabindex="0" data-week-id="${week.id}">
              <div class="week-card-head">
                <strong>Week ${week.weekNumber}</strong>
                <span>PP ${week.payPeriod}</span>
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
  `).join("");
  document.querySelector("#production-calendar").innerHTML = html || `<div class="empty-calendar">No weeks found for this calendar window.</div>`;
  document.querySelectorAll("#production-calendar .week-card[data-week-id]").forEach((card) => {
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
  });
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
  const monthsSelect = document.querySelector("#forecast-months");
  const filterInput = document.querySelector("#forecast-filter");
  const typeSelect = document.querySelector("#forecast-ingredient-type");
  monthsSelect.value = String(state.forecastMonths);
  monthsSelect.onchange = async () => {
    state.forecastMonths = Number(monthsSelect.value) || 6;
    await renderForecast();
  };
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
  const data = await api(`/api/forecast?months=${state.forecastMonths}`);
  document.querySelector("#forecast-window").textContent = `${data.filters.start} through ${data.filters.end}`;
  state.forecastRows = data.rows || [];
  document.querySelector("#forecast-ingredient-options").innerHTML = [...new Set(state.forecastRows.map((row) => row.ingredient_name).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `<option value="${escapeHtml(name)}"></option>`)
    .join("");
  renderForecastTable(state.forecastRows);
}

function renderForecastTable(rows) {
  const keyword = state.forecastFilter.toLowerCase();
  const ingredientType = state.forecastIngredientType;
  const typeOrder = { Hijnx: 1, SB: 2, "SB/Hijnx": 3 };
  const filtered = rows.filter((row) => {
    const matchesKeyword = !keyword || ["ingredient_name", "quantity_uom", "products"].some((field) => String(row[field] ?? "").toLowerCase().includes(keyword));
    const matchesType = !ingredientType || row.ingredient_type === ingredientType;
    return matchesKeyword && matchesType;
  }).sort((a, b) => (typeOrder[a.ingredient_type] || 9) - (typeOrder[b.ingredient_type] || 9)
    || String(a.ingredient_name || "").localeCompare(String(b.ingredient_name || "")));
  document.querySelector("#forecast-table").innerHTML = table([
    { label: "Ingredient", key: "ingredient_name" },
    { label: "Type", key: "ingredient_type" },
    { label: "Scheduled Usage", numeric: true, value: (r) => qty(r.required_qty) },
    { label: "UOM", key: "quantity_uom" },
    { label: "Batches", numeric: true, key: "scheduled_batches" },
    { label: "Products", key: "products" },
    { label: "First Week", key: "first_week" },
    { label: "Last Week", key: "last_week" },
  ], filteredRows(filtered, ["ingredient_name", "ingredient_type", "quantity_uom", "products"]));
}

function velocityRowForProduct(product) {
  return state.velocityRows.find((row) => String(row.product_id) === String(product.id));
}

function velocityProjection(product) {
  const weeks = Math.max(1, Number(state.velocityWeeks) || 1);
  const imported = velocityRowForProduct(product);
  const velocity = Number(imported?.velocity_per_day || 0);
  const batchSize = Number(product.batch_size || 0);
  return {
    velocity_per_day: imported ? velocity : null,
    batches_needed: imported && batchSize > 0 ? (velocity * weeks * 7) / batchSize : null,
  };
}

async function renderVelocity() {
  const data = await api("/api/velocity-products");
  state.velocityProducts = data.products || [];
  const weeksInput = document.querySelector("#velocity-weeks");
  weeksInput.value = String(state.velocityWeeks);
  weeksInput.oninput = () => {
    state.velocityWeeks = Math.max(1, Number(weeksInput.value) || 1);
    renderVelocityTable(state.velocityProducts);
    renderVelocityScheduler(state.velocityProducts);
    const form = document.querySelector("#velocity-schedule-form");
    const product = state.velocityProducts.find((item) => String(item.id) === String(form.querySelector("select[name='product_id']").value));
    const projection = product ? velocityProjection(product) : null;
    form.querySelector("input[name='batch_count']").value = projection?.batches_needed == null ? "" : String(Math.ceil(projection.batches_needed));
  };
  document.querySelector("#velocity-instructions").innerHTML = state.velocityInstructions.length
    ? `<ul>${state.velocityInstructions.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
    : `<ul>
        <li>Upload a Production Needs Report PDF.</li>
        <li>The importer reads SKU names and Vel/Day values, then matches them to active production batches.</li>
        <li>Projected batch quantity is Vel/Day x projection weeks x 7.</li>
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
      velocity_per_day: projection.velocity_per_day,
      batches_needed: projection.batches_needed,
    };
  });
  document.querySelector("#velocity-table").innerHTML = table([
    { label: "Production Batch", value: (row) => escapeHtml(row.product_name) },
    { label: "Type", value: (row) => escapeHtml(row.batch_type) },
    { label: "Vel / Day", numeric: true, value: (row) => row.velocity_per_day == null ? "" : qty(row.velocity_per_day) },
    { label: "Batches Needed", numeric: true, value: (row) => row.batches_needed == null ? "" : qty(row.batches_needed) },
    { label: "Actions", value: (row) => `<button class="small secondary velocity-use-schedule" type="button" data-product-id="${row.product_id}">Schedule</button>` },
  ], filteredRows(rows, ["product_name", "batch_type"]));
  document.querySelectorAll(".velocity-use-schedule").forEach((button) => {
    button.addEventListener("click", () => {
      const product = products.find((item) => String(item.id) === String(button.dataset.productId));
      if (!product) return;
      const projection = velocityProjection(product);
      const form = document.querySelector("#velocity-schedule-form");
      form.querySelector("select[name='product_id']").value = String(product.id);
      form.querySelector("input[name='batch_count']").value = projection.batches_needed == null ? "" : String(Math.ceil(projection.batches_needed));
      form.querySelector("input[name='quantity']").value = Number(product.batch_size || 0) > 0 ? String(product.batch_size) : "";
      state.velocitySchedulePreview = null;
      setMessage("#velocity-schedule-message", "Review the schedule window, then preview.", "success");
      document.querySelector("#velocity-schedule-confirm").disabled = true;
      document.querySelector("#velocity-schedule-preview").innerHTML = "";
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

async function velocitySchedulePlan(form) {
  const productId = form.querySelector("select[name='product_id']").value;
  const product = state.velocityProducts.find((item) => String(item.id) === String(productId));
  const targetCount = Math.max(0, Math.round(Number(form.querySelector("input[name='batch_count']").value) || 0));
  const quantity = Number(form.querySelector("input[name='quantity']").value) || 0;
  const startWeek = form.querySelector("select[name='start_week']").value;
  const endWeek = form.querySelector("select[name='end_week']").value;
  if (!product) throw new Error("Select a production batch.");
  if (targetCount < 1) throw new Error("Batches needed must be at least 1.");
  if (quantity <= 0) throw new Error("Qty per batch must be greater than zero.");
  if (!startWeek || !endWeek || endWeek < startWeek) throw new Error("Select a valid schedule window.");

  const production = await api("/api/production-plan");
  const weeks = production.weeks.map(weekMeta).filter((week) => week.week_start >= startWeek && week.week_start <= endWeek);
  if (!weeks.length) throw new Error("No production weeks found in that schedule window.");
  const existing = production.batches.filter((batch) => String(batch.product_id) === String(product.id)
    && batch.week_start >= startWeek
    && batch.week_start <= endWeek);
  const missingCount = Math.max(0, targetCount - existing.length);
  const overCount = Math.max(0, existing.length - targetCount);
  const proposed = evenlySpacedWeeks(weeks, missingCount).map((week) => ({
    week_id: week.id,
    week_start: week.week_start,
    label: week.label,
    batch_type: product.category,
    product_id: product.id,
    product_name: product.name,
    quantity,
  }));
  return { product, targetCount, quantity, startWeek, endWeek, weeks, existing, missingCount, overCount, proposed };
}

function renderVelocitySchedulePreview(plan) {
  const canSchedule = plan.proposed.length > 0 && plan.overCount === 0;
  document.querySelector("#velocity-schedule-confirm").disabled = !canSchedule;
  const warning = plan.overCount > 0
    ? `<div class="form-message error">This window is over the velocity target by ${plan.overCount} batch entr${plan.overCount === 1 ? "y" : "ies"}. Delete ${plan.overCount} entr${plan.overCount === 1 ? "y" : "ies"} before adding more.</div>`
    : plan.missingCount === 0
      ? `<div class="form-message success">This window already matches the velocity target.</div>`
      : `<div class="form-message success">${plan.proposed.length} batch entr${plan.proposed.length === 1 ? "y" : "ies"} ready to add.</div>`;
  const existingRows = plan.existing.map((batch) => `
    <tr data-batch-id="${batch.id}">
      <td>${escapeHtml(batch.week_start)}</td>
      <td>${escapeHtml(batch.product_name)}</td>
      <td class="numeric">${qty(batch.quantity)}</td>
      <td>${plan.overCount > 0 ? `<button class="small danger delete-velocity-existing" type="button">Delete</button>` : ""}</td>
    </tr>
  `).join("");
  const proposedRows = plan.proposed.map((batch) => `
    <tr>
      <td>${escapeHtml(batch.label)}</td>
      <td>${escapeHtml(batch.product_name)}</td>
      <td class="numeric">${qty(batch.quantity)}</td>
    </tr>
  `).join("");
  document.querySelector("#velocity-schedule-preview").innerHTML = `
    ${warning}
    <div class="velocity-schedule-summary">
      <div><strong>${plan.targetCount}</strong><span>Target Entries</span></div>
      <div><strong>${plan.existing.length}</strong><span>Already Scheduled</span></div>
      <div><strong>${plan.proposed.length}</strong><span>Will Add</span></div>
      <div><strong>${plan.overCount}</strong><span>Over Target</span></div>
    </div>
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
          <table><thead><tr><th>Week</th><th>Batch</th><th class="numeric">Qty</th></tr></thead><tbody>${proposedRows || `<tr><td colspan="3">No new entries needed</td></tr>`}</tbody></table>
        </div>
      </div>
    </div>
  `;
  document.querySelectorAll(".delete-velocity-existing").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest("tr");
      if (!confirm("Delete this scheduled batch entry?")) return;
      setMessage("#velocity-schedule-message", "Deleting scheduled batch...");
      try {
        await api(`/api/production-batches/${row.dataset.batchId}`, { method: "DELETE" });
        setMessage("#velocity-schedule-message", "Scheduled batch deleted. Rebuilding preview...", "success");
        state.velocitySchedulePreview = await velocitySchedulePlan(document.querySelector("#velocity-schedule-form"));
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
  const previousEnd = endSelect.value;
  productSelect.innerHTML = products.map((product) => `<option value="${product.id}">${escapeHtml(product.category)} - ${escapeHtml(product.name)}</option>`).join("");
  const weekOptions = weeks.map((week) => `<option value="${week.week_start}">${escapeHtml(week.label)}</option>`).join("");
  startSelect.innerHTML = weekOptions;
  endSelect.innerHTML = weekOptions;
  if (previousProduct && products.some((product) => String(product.id) === String(previousProduct))) productSelect.value = previousProduct;
  if (previousStart && weeks.some((week) => week.week_start === previousStart)) startSelect.value = previousStart;
  if (previousEnd && weeks.some((week) => week.week_start === previousEnd)) {
    endSelect.value = previousEnd;
  } else if (weeks.length) {
    endSelect.value = weeks[Math.min(weeks.length - 1, Math.max(0, state.velocityWeeks - 1))].week_start;
  }
  const updateProductDefaults = () => {
    const product = products.find((item) => String(item.id) === String(productSelect.value));
    if (!product) return;
    const projection = velocityProjection(product);
    form.querySelector("input[name='batch_count']").value = projection.batches_needed == null ? "" : String(Math.ceil(projection.batches_needed));
    quantityInput.value = Number(product.batch_size || 0) > 0 ? String(product.batch_size) : "";
    state.velocitySchedulePreview = null;
    document.querySelector("#velocity-schedule-confirm").disabled = true;
    document.querySelector("#velocity-schedule-preview").innerHTML = "";
  };
  productSelect.onchange = updateProductDefaults;
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
      document.querySelector("#velocity-schedule-confirm").disabled = true;
      document.querySelector("#velocity-schedule-preview").innerHTML = "";
      setMessage("#velocity-schedule-message", error.message, "error");
    }
  };
  document.querySelector("#velocity-schedule-confirm").onclick = async () => {
    const plan = state.velocitySchedulePreview;
    if (!plan?.proposed?.length) return;
    setMessage("#velocity-schedule-message", "Adding scheduled batches...");
    try {
      for (const batch of plan.proposed) {
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
      state.velocitySchedulePreview = await velocitySchedulePlan(form);
      renderVelocitySchedulePreview(state.velocitySchedulePreview);
      const overMessage = state.velocitySchedulePreview.overCount > 0
        ? ` Added entries, but this window is now over target by ${state.velocitySchedulePreview.overCount}.`
        : "";
      setMessage("#velocity-schedule-message", `Added ${plan.proposed.length} scheduled batch entr${plan.proposed.length === 1 ? "y" : "ies"}.${overMessage}`, "success");
    } catch (error) {
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
        <span>${escapeHtml(product.category || "")} · ${count} ingredients</span>
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
  updateFormulaUomDisplay();

  const selectedFormulas = data.formulas.filter((formula) => String(formula.product_id) === String(state.selectedFormulaProductId));
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
  state.velocityRows = [];
  state.velocityInstructions = [];
  document.querySelector("#velocity-upload").value = "";
  setMessage("#velocity-message", "Velocity upload cleared.", "success");
  await renderVelocity();
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

loadReference().then(() => activate("dashboard")).catch((error) => {
  document.body.insertAdjacentHTML("beforeend", `<pre>${escapeHtml(error.message)}</pre>`);
});
