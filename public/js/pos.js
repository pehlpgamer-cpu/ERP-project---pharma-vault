// The sales screen. Everything shown is built with createElement and textContent, never markup
// strings, so product, generic and brand names from the server can never inject HTML. The server
// stays the authority: totals, change and stock are shown for convenience and recomputed on checkout.

import {
  addLine,
  cartTotals,
  changeUnit,
  emptyCart,
  normalizeAmount,
  removeLine,
  restoreCart,
  setQuantity,
  stepQuantity,
  tenderSummary,
} from "./pos-cart.js";

const root = document.getElementById("pos-root");
const config = JSON.parse(root.dataset.config);

const STORAGE_KEY = "pos-cart";
const SEARCH_DELAY_MS = 250;
const METHODS = [
  ["CASH", "Cash"],
  ["CARD", "Card"],
  ["GCASH", "GCash"],
  ["MAYA", "Maya"],
  ["BANK_TRANSFER", "Bank transfer"],
  ["OTHER", "Other"],
];

const pesos = new Intl.NumberFormat("en-PH", { style: "currency", currency: config.currency });
const counts = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 3 });

const money = (value) => {
  return pesos.format(Number(value));
};

const byId = (id) => {
  return document.getElementById(id);
};

let cart = emptyCart();
let payments = [{ method: "CASH", amount: "", reference: "" }];
let results = [];
let searched = false;
let searchTicket = 0;
let searchTimer = null;
let attempt = null; // { key, fingerprint }: one Idempotency-Key per distinct sale attempt
let busy = false;

function el(tag, { text, className, attrs = {}, on = {}, children = [] } = {}) {
  const node = document.createElement(tag);

  if (text !== undefined) {
    node.textContent = text;
  }

  if (className) {
    node.className = className;
  }

  for (const [name, value] of Object.entries(attrs)) {
    if (value !== false && value !== null && value !== undefined) {
      node.setAttribute(name, value === true ? "" : String(value));
    }
  }

  for (const [event, handler] of Object.entries(on)) {
    node.addEventListener(event, handler);
  }

  node.append(...children);

  return node;
}

function say(message) {
  byId("pos-status").textContent = message;
}

function notify(message) {
  if (window.xian) {
    window.xian.error(message);
  } else {
    window.alert(message);
  }
}

function newKey() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => {
    return byte.toString(16).padStart(2, "0");
  });

  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}

// The cart survives a reload in sessionStorage; storage may be unavailable, so every use is guarded.
function saveCart() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
  } catch {
    // storage unavailable: the cart simply lives for this page view
  }
}

function loadCart() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);

    return raw ? restoreCart(JSON.parse(raw)) : emptyCart();
  } catch {
    return emptyCart();
  }
}

// ---- search ----

function addState(product, unit) {
  if (product.requiresPrescription || product.classification !== "OTC") {
    return { ok: false, reason: "Needs a prescription: it cannot be sold at this counter" };
  }

  if (unit.price === null) {
    return { ok: false, reason: "No price is set for this unit" };
  }

  if (Number(product.availableBaseQuantity) < Number(unit.conversionFactor)) {
    return { ok: false, reason: "Not enough stock" };
  }

  return { ok: true, reason: "" };
}

function addUnit(product, unit) {
  const units = product.units.map((other) => {
    return { productUnitId: other.productUnitId, name: other.name, price: other.price };
  });

  cart = addLine(cart, {
    productUnitId: unit.productUnitId,
    productId: product.id,
    productName: product.name,
    unitName: unit.name,
    price: unit.price,
    units,
  });
  saveCart();
  renderCart();
  say(`Added ${unit.name} of ${product.name}`);
}

function resultItem(product) {
  const blocked = product.requiresPrescription || product.classification !== "OTC";
  const details = [product.genericName, product.strength, product.dosageForm, product.sku]
    .filter(Boolean)
    .join(" · ");
  const side = el("div", {
    className: "text-right text-xs text-gray-600",
    children: [
      el("p", { text: `In stock: ${counts.format(Number(product.availableBaseQuantity))}` }),
    ],
  });

  if (blocked) {
    side.append(
      el("span", {
        className: "mt-1 inline-block rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-800",
        text: "Prescription",
      }),
    );
  }

  const buttons = product.units.map((unit) => {
    const state = addState(product, unit);
    const label =
      unit.price === null ? `${unit.name} · no price` : `${unit.name} · ${money(unit.price)}`;

    return el("button", {
      className:
        "btn text-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100 disabled:hover:bg-red-300 disabled:hover:text-inherit",
      text: label,
      attrs: { type: "button", disabled: !state.ok, title: state.reason || `Add one ${unit.name}` },
      on: {
        click: () => {
          addUnit(product, unit);
        },
      },
    });
  });

  return el("li", {
    className: "border border-gray-200 bg-white p-3",
    children: [
      el("div", {
        className: "flex flex-wrap items-start justify-between gap-2",
        children: [
          el("div", {
            children: [
              el("p", { className: "font-medium", text: product.name }),
              el("p", { className: "text-xs text-gray-600", text: details }),
            ],
          }),
          side,
        ],
      }),
      el("div", { className: "mt-2 flex flex-wrap gap-2", children: buttons }),
      blocked
        ? el("p", {
            className: "mt-2 text-xs text-amber-800",
            text: "Needs a prescription: it cannot be sold at this counter.",
          })
        : el("span"),
    ],
  });
}

function renderResults() {
  const list = byId("pos-results");

  list.replaceChildren();

  if (results.length === 0) {
    const hint = searched ? "No products found" : "Search by name or SKU, or scan a barcode";

    list.append(el("li", { className: "p-3 text-sm text-gray-500", text: hint }));

    return;
  }

  list.append(...results.map(resultItem));
}

async function runSearch(query) {
  const text = query.trim();
  const ticket = (searchTicket += 1);

  if (text === "") {
    results = [];
    searched = false;
    renderResults();

    return results;
  }

  try {
    const response = await fetch(`${config.productsUrl}?q=${encodeURIComponent(text)}&limit=20`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });

    if (ticket !== searchTicket) {
      return null;
    }

    if (response.status === 401) {
      notify("Session expired, sign in again");

      return null;
    }

    if (!response.ok) {
      say("The search failed. Try again.");

      return null;
    }

    results = (await response.json()).data;
    searched = true;
    renderResults();

    return results;
  } catch {
    say("The search failed. Check the connection and try again.");

    return null;
  }
}

// ---- cart ----

function cartRow(line, subtotal) {
  const unitControl =
    line.units.length > 1
      ? el("select", {
          className: "mt-1 w-full rounded border border-gray-300 bg-white p-1 text-xs",
          attrs: { "aria-label": `Unit for ${line.productName}` },
          on: {
            change: (event) => {
              const chosen = line.units.find((unit) => {
                return unit.productUnitId === event.target.value;
              });

              cart = changeUnit(cart, line.productUnitId, {
                productUnitId: chosen.productUnitId,
                unitName: chosen.name,
                price: chosen.price,
              });
              saveCart();
              renderCart();
            },
          },
          children: line.units.map((unit) => {
            return el("option", {
              text:
                unit.price === null
                  ? `${unit.name} (no price)`
                  : `${unit.name} · ${money(unit.price)}`,
              attrs: {
                value: unit.productUnitId,
                selected: unit.productUnitId === line.productUnitId,
                disabled: unit.price === null,
              },
            });
          }),
        })
      : el("p", {
          className: "text-xs text-gray-600",
          text: `${line.unitName} · ${money(line.price)}`,
        });

  const step = (delta, label, symbol) => {
    return el("button", {
      className: "btn px-2 py-0",
      text: symbol,
      attrs: { type: "button", "aria-label": `${label} ${line.productName}` },
      on: {
        click: () => {
          cart = stepQuantity(cart, line.productUnitId, delta);
          saveCart();
          renderCart();
        },
      },
    });
  };
  const quantity = el("input", {
    className: "w-16 rounded border border-gray-300 p-1 text-center text-sm",
    attrs: {
      type: "text",
      inputmode: "decimal",
      value: line.quantity,
      "aria-label": `Quantity of ${line.productName}`,
    },
    on: {
      change: (event) => {
        cart = setQuantity(cart, line.productUnitId, event.target.value);
        saveCart();
        renderCart();
      },
    },
  });

  return el("tr", {
    className: "border-t border-gray-200 align-top",
    children: [
      el("td", {
        className: "py-2 pr-2",
        children: [
          el("p", { className: "text-sm font-medium", text: line.productName }),
          unitControl,
        ],
      }),
      el("td", {
        className: "py-2 pr-2",
        children: [
          el("div", {
            className: "flex items-center gap-1",
            children: [step("-1", "Fewer", "−"), quantity, step("1", "More", "+")],
          }),
        ],
      }),
      el("td", { className: "py-2 pr-2 text-right text-sm", text: money(subtotal) }),
      el("td", {
        className: "py-2 text-right",
        children: [
          el("button", {
            className: "btn px-2 py-0",
            text: "×",
            attrs: { type: "button", "aria-label": `Remove ${line.productName}` },
            on: {
              click: () => {
                cart = removeLine(cart, line.productUnitId);
                saveCart();
                renderCart();
              },
            },
          }),
        ],
      }),
    ],
  });
}

function renderCart() {
  const body = byId("pos-cart-body");
  const totals = cartTotals(cart);
  const subtotals = new Map(
    totals.lines.map((line) => {
      return [line.productUnitId, line.subtotal];
    }),
  );

  body.replaceChildren();

  if (cart.lines.length === 0) {
    body.append(
      el("tr", {
        children: [
          el("td", {
            className: "py-4 text-center text-sm text-gray-500",
            text: "The cart is empty",
            attrs: { colspan: 4 },
          }),
        ],
      }),
    );
  }

  body.append(
    ...cart.lines.map((line) => {
      return cartRow(line, subtotals.get(line.productUnitId));
    }),
  );
  byId("pos-total").textContent = money(totals.total);
  updateTender();
}

// ---- payments ----

// Rows with an amount; blank rows are ignored.
function activePayments() {
  return payments
    .map((payment) => {
      return { ...payment, amount: normalizeAmount(payment.amount) };
    })
    .filter((payment) => {
      return payment.amount !== null && payment.amount !== "0.00";
    });
}

function canComplete(summary) {
  const active = activePayments();

  return (
    cart.lines.length > 0 &&
    active.length > 0 &&
    summary.valid &&
    active.every((payment) => {
      return payment.method === "CASH" || payment.reference.trim() !== "";
    })
  );
}

function updateTender() {
  const total = cartTotals(cart).total;
  const summary = tenderSummary(total, activePayments());

  byId("pos-tendered").textContent = money(summary.tendered);
  byId("pos-change").textContent = money(summary.change);
  byId("pos-remaining").textContent = money(summary.remaining);
  byId("pos-complete").disabled = busy || !canComplete(summary);
  byId("pos-complete").textContent = busy ? "Saving…" : "Complete sale";
}

function paymentRow(payment, index) {
  const reference = el("input", {
    className: "field col-span-3 mt-0",
    attrs: {
      type: "text",
      maxlength: 150,
      placeholder: "Reference",
      "aria-label": "Payment reference",
      value: payment.reference,
      hidden: payment.method === "CASH",
    },
    on: {
      input: (event) => {
        payment.reference = event.target.value;
        updateTender();
      },
    },
  });

  return el("div", {
    className: "grid grid-cols-[1fr_1fr_auto] gap-2",
    children: [
      el("select", {
        className: "field mt-0",
        attrs: { "aria-label": "Payment method" },
        on: {
          change: (event) => {
            payment.method = event.target.value;
            renderPayments();
          },
        },
        children: METHODS.map(([value, label]) => {
          return el("option", {
            text: label,
            attrs: { value, selected: value === payment.method },
          });
        }),
      }),
      el("input", {
        className: "field mt-0 text-right",
        attrs: {
          type: "text",
          inputmode: "decimal",
          placeholder: "0.00",
          "aria-label": "Payment amount",
          value: payment.amount,
        },
        on: {
          input: (event) => {
            payment.amount = event.target.value;
            updateTender();
          },
        },
      }),
      payments.length > 1
        ? el("button", {
            className: "btn px-2 py-0",
            text: "×",
            attrs: { type: "button", "aria-label": "Remove payment" },
            on: {
              click: () => {
                payments = payments.filter((_, position) => {
                  return position !== index;
                });
                renderPayments();
              },
            },
          })
        : el("span"),
      reference,
    ],
  });
}

function renderPayments() {
  byId("pos-payments").replaceChildren(
    ...payments.map((payment, index) => {
      return paymentRow(payment, index);
    }),
  );
  updateTender();
}

// Fills the last payment row so the payments exactly cover the total.
function fillExact() {
  const total = cartTotals(cart).total;
  const last = payments[payments.length - 1];
  const others = payments.slice(0, -1).map((payment) => {
    return { ...payment, amount: normalizeAmount(payment.amount) ?? "0.00" };
  });
  const missing = tenderSummary(total, others).remaining;

  last.amount = missing;
  renderPayments();
}

// ---- checkout ----

function stockMessage(details) {
  return details
    .map((detail) => {
      const line = cart.lines.find((entry) => {
        return entry.productId === detail.productId;
      });
      const name = line ? line.productName : "A product";

      return `${name}: ${counts.format(Number(detail.requested))} requested, ${counts.format(Number(detail.available))} in stock`;
    })
    .join("\n");
}

function failureMessage(error, status) {
  if (status === 401) {
    return "Session expired, sign in again";
  }

  if (error?.code === "insufficient_stock" && Array.isArray(error.details)) {
    return `Not enough stock.\n${stockMessage(error.details)}`;
  }

  return error?.message ?? `The sale could not be saved (error ${status}).`;
}

async function completeSale() {
  const summary = tenderSummary(cartTotals(cart).total, activePayments());

  if (busy || !canComplete(summary)) {
    return;
  }

  const body = {
    items: cart.lines.map((line) => {
      return { productUnitId: line.productUnitId, quantity: line.quantity };
    }),
    payments: activePayments().map((payment) => {
      return {
        method: payment.method,
        amount: payment.amount,
        reference: payment.method === "CASH" ? null : payment.reference.trim(),
      };
    }),
    customerId: null,
  };
  const fingerprint = JSON.stringify(body);

  // A retry of the same sale reuses its key, so a timeout can never charge the customer twice.
  if (attempt === null || attempt.fingerprint !== fingerprint) {
    attempt = { key: newKey(), fingerprint };
  }

  busy = true;
  updateTender();

  try {
    const response = await fetch(config.salesUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": attempt.key,
      },
      body: fingerprint,
    });
    const payload = await response.json().catch(() => {
      return null;
    });

    if (response.ok && payload?.data?.id) {
      cart = emptyCart();
      saveCart();
      attempt = null;
      window.location.assign(`/sales/${encodeURIComponent(payload.data.id)}?print=1`);

      return;
    }

    notify(failureMessage(payload?.error, response.status));
  } catch {
    notify(
      "The server could not be reached. Check the connection and press Complete again: the sale is not charged twice.",
    );
  } finally {
    busy = false;
    updateTender();
  }
}

// ---- wiring ----

const search = byId("pos-search");

search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    runSearch(search.value);
  }, SEARCH_DELAY_MS);
});

// Enter adds the unit a scanned barcode belongs to.
search.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  clearTimeout(searchTimer);

  const found = await runSearch(search.value);
  const first = found?.[0];
  const unit = first?.units.find((candidate) => {
    return candidate.productUnitId === first.matchedUnitId;
  });

  if (unit && addState(first, unit).ok) {
    addUnit(first, unit);
    search.value = "";
    results = [];
    searched = false;
    renderResults();
  }
});

byId("pos-add-payment").addEventListener("click", () => {
  payments = [...payments, { method: "CASH", amount: "", reference: "" }];
  renderPayments();
});
byId("pos-exact").addEventListener("click", fillExact);
byId("pos-complete").addEventListener("click", completeSale);
byId("pos-clear").addEventListener("click", () => {
  cart = emptyCart();
  attempt = null;
  saveCart();
  renderCart();
  search.focus();
});

document.addEventListener("keydown", (event) => {
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);

  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    completeSale();
  } else if (event.key === "/" && !typing) {
    event.preventDefault();
    search.focus();
  }
});

cart = loadCart();
renderResults();
renderCart();
renderPayments();
search.focus();
