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
  selectedFormulaProductId: "",
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const titles = {
  dashboard: ["Dashboard", "Inventory warnings, upcoming production, and purchase timing."],
  production: ["Production Planner", "Schedule batches and calculate ingredient needs from calendar entries."],
  "rl-scheduled-batches": ["RL Scheduled Batches", "Read-only calendar from the RL scheduling database."],
  forecast: ["Ingredient Forecast", "Projected usage, receipts, ending inventory, and shortages."],
  inventory: ["Inventory", "Add new items to the master inventory list."],
  formulas: ["Formula Manager", "Batch-level BOM setup using grams and each."],
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
      return `<td class="${cellClass}">${raw ?? ""}</td>`;
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
  const filter = document.querySelector("#ingredient-filter");
  filter.innerHTML = `<option value="">All ingredients</option>${state.ingredients.map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join("")}`;
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
  const batchForm = document.querySelector("#production-batch-form");
  const batchTypeSelect = batchForm.querySelector("select[name='batch_type']");
  const productSelect = batchForm.querySelector("select[name='product_id']");
  const weekSelect = batchForm.querySelector("select[name='week_id']");
  const calendarMonthsSelect = document.querySelector("#production-calendar-months");
  const reportBatchTypeSelect = document.querySelector("#production-filter-batch-type");
  const reportStartSelect = document.querySelector("#production-filter-start");
  const reportEndSelect = document.querySelector("#production-filter-end");
  const weeks = data.weeks.map(weekMeta);
  const currentWeekStart = currentWeekStartIso();
  const schedulingWeeks = weeks.filter((week) => week.week_start >= currentWeekStart);
  const weekOptions = schedulingWeeks.length ? schedulingWeeks : weeks;
  const defaultWeeks = visibleCalendarWeeks(weeks, state.productionCalendarMonths);
  if (!state.productionStartWeek) state.productionStartWeek = defaultWeeks[0]?.week_start || weeks[0]?.week_start || "";
  if (!state.productionEndWeek) state.productionEndWeek = defaultWeeks.at(-1)?.week_start || weeks.at(-1)?.week_start || "";
  const filteredWeeks = weeks.filter((week) => (!state.productionStartWeek || week.week_start >= state.productionStartWeek)
    && (!state.productionEndWeek || week.week_start <= state.productionEndWeek));
  const filteredBatches = data.batches.filter((batch) => (!state.productionBatchType || batch.batch_type === state.productionBatchType)
    && (!state.productionStartWeek || batch.week_start >= state.productionStartWeek)
    && (!state.productionEndWeek || batch.week_start <= state.productionEndWeek));
  const ingredientReport = await api(`/api/production-ingredient-report${productionReportQuery()}`);

  batchTypeSelect.innerHTML = data.batchTypes.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("");
  weekSelect.innerHTML = weekOptions.map((week) => `<option value="${week.id}">${escapeHtml(week.label)}</option>`).join("");
  calendarMonthsSelect.value = String(state.productionCalendarMonths);
  calendarMonthsSelect.onchange = async () => {
    state.productionCalendarMonths = Number(calendarMonthsSelect.value) || 6;
    const nextDefaultWeeks = visibleCalendarWeeks(weeks, state.productionCalendarMonths);
    state.productionStartWeek = nextDefaultWeeks[0]?.week_start || state.productionStartWeek;
    state.productionEndWeek = nextDefaultWeeks.at(-1)?.week_start || state.productionEndWeek;
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
  renderProductionBatchEditor(filteredBatches, data.products, weeks, data.batchTypes);
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

function visibleCalendarWeeks(weeks, monthCount) {
  const today = new Date();
  const firstVisible = saturdayForWeek(isoDate(today));
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
            <article class="week-card">
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
}

async function renderRlScheduledBatches() {
  const data = await api("/api/rl-scheduled-batches");

  document.querySelector("#rl-calendar-status").textContent = data.source
    ? `Read only source: ${data.source.table}`
    : (data.message || "Read only source is not available.");

  const days = rlCalendarDays();
  const firstDay = days[0];
  const lastDay = days.at(-1);
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
      { label: "Quantity", numeric: true, value: (row) => row.quantity == null ? "" : qty(row.quantity) },
      { label: "Status", key: "status" },
    ], filteredRows(data.batches || [], ["scheduled_date", "batch_type", "product_name", "status"]));
  }
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
  const rows = filteredRows(ingredients.filter((ingredient) => Number(ingredient.is_master)), ["name", "purchase_uom"]);
  document.querySelector("#inventory-table").innerHTML = table([
    { label: "Ingredient", key: "name" },
    { label: "UOM", key: "purchase_uom" },
    { label: "Unit Size", numeric: true, value: (r) => qty(r.purchase_unit_size) },
    { label: "Active", value: (r) => Number(r.active) ? "Yes" : "" },
  ], rows);
}

async function renderFormulas() {
  const data = await api("/api/formulas");
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
  renderFormulaEditor(selectedFormulas);
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
        await renderFormulas();
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
        await renderFormulas();
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
    await renderFormulas();
  } catch (error) {
    setMessage("#formula-message", error.message, "error");
  }
});

loadReference().then(() => activate("dashboard")).catch((error) => {
  document.body.insertAdjacentHTML("beforeend", `<pre>${escapeHtml(error.message)}</pre>`);
});
