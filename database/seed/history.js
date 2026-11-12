// Demo history: every business day, each cashier opens a register, rings up a few sales and closes
// the drawer. All of it goes through the real services (openSession, createSale, closeSession) with
// the clock injected, so the stock, ledger and numbering are exactly what the application would
// have produced. Only the choice of what to sell comes from a seeded random generator, so the same
// seed on the same clock gives the same history.

import { randomUUID } from "node:crypto";
import { and, eq, gte, isNull, or } from "drizzle-orm";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { loadAuthUser } from "../../app/services/auth/users.js";
import { loadEffectivePrices } from "../../app/services/catalog/pricing.js";
import {
  closeSession,
  openSession,
  sessionSummary,
} from "../../app/services/register/registerSessions.js";
import { createSale } from "../../app/services/sales/checkout.js";
import { mul, sum, toScale } from "../../app/services/support/decimal.js";
import {
  addDays,
  businessDate,
  eachDay,
  startOfBusinessDay,
} from "../../app/services/support/time.js";

const HOUR_MS = 3_600_000;
const OPENING_CASH = "1000.00";
const MAX_VARIANCE_CENTS = 3000;
const CASHIERS = [
  { key: "cashierMain", branch: "main", keepsTodayOpen: true },
  { key: "cashierNorth", branch: "north", keepsTodayOpen: false },
];

// mulberry32: a small seeded generator returning numbers in [0, 1).
function createRandom(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (random, min, max) => {
  return min + Math.floor(random() * (max - min + 1));
};

const pick = (random, items) => {
  return items[Math.floor(random() * items.length)];
};

// Money as whole cents, so the payment maths never touches a float.
const toCents = (money) => {
  return BigInt(money.replace(".", ""));
};

const fromCents = (cents) => {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
};

const roundUpTo = (cents, step) => {
  return ((cents + step - 1n) / step) * step;
};

// What each branch can sell today, in base units: stock that is active and not expired. Sales stay
// inside it, so the history never asks for stock that is not there.
async function loadBudgets(db, now) {
  const today = new Date(`${businessDate(now)}T00:00:00Z`);
  const batches = await db
    .select({
      branchId: inventoryBatches.branchId,
      productId: inventoryBatches.productId,
      quantity: inventoryBatches.quantityAvailable,
    })
    .from(inventoryBatches)
    .where(
      and(
        eq(inventoryBatches.status, "ACTIVE"),
        or(isNull(inventoryBatches.expirationDate), gte(inventoryBatches.expirationDate, today)),
      ),
    );
  const budgets = new Map();

  for (const batch of batches) {
    const key = `${batch.branchId}:${batch.productId}`;

    budgets.set(key, (budgets.get(key) ?? 0) + Number(batch.quantity));
  }

  return budgets;
}

// One to four distinct units of over-the-counter products, within what the branch has left.
function chooseLines(random, products, branchId, budgets) {
  const lines = [];

  for (let attempt = 0; attempt < between(random, 1, 4); attempt += 1) {
    const product = pick(random, products);
    const unit = pick(random, product.units);
    const quantity = unit.factor === "1" ? between(random, 1, 5) : between(random, 1, 2);
    const key = `${branchId}:${product.id}`;
    const needed = Number(unit.factor) * quantity;
    const taken = lines.some((line) => {
      return line.productUnitId === unit.id;
    });

    if (!taken && (budgets.get(key) ?? 0) >= needed) {
      budgets.set(key, budgets.get(key) - needed);
      lines.push({ productUnitId: unit.id, quantity: toScale(String(quantity), 3) });
    }
  }

  return lines;
}

// Cash rounded up to the next 50, or cash plus GCash, or one electronic payment.
function choosePayments(random, total, counter) {
  const cents = toCents(total);
  const style = random();

  if (style < 0.55) {
    return [{ method: "CASH", amount: fromCents(roundUpTo(cents, 5000n)), reference: null }];
  }

  const electronic = (cents / 200n) * 100n;

  if (style < 0.8 && electronic > 0n) {
    return [
      { method: "CASH", amount: fromCents(roundUpTo(cents - electronic, 1000n)), reference: null },
      { method: "GCASH", amount: fromCents(electronic), reference: `GC-${counter}` },
    ];
  }

  return [
    { method: pick(random, ["GCASH", "CARD", "MAYA"]), amount: total, reference: `REF-${counter}` },
  ];
}

async function ringUpSale({
  random,
  db,
  user,
  branchId,
  products,
  customers,
  budgets,
  at,
  counter,
}) {
  const lines = chooseLines(random, products, branchId, budgets);

  if (lines.length === 0) {
    return false;
  }

  const prices = await loadEffectivePrices(
    db,
    lines.map((line) => {
      return line.productUnitId;
    }),
    branchId,
    at,
  );
  const total = toScale(
    sum(
      lines.map((line) => {
        return toScale(mul(line.quantity, prices.get(line.productUnitId)), 2);
      }),
    ),
    2,
  );

  await createSale(
    user,
    {
      items: lines,
      payments: choosePayments(random, total, counter),
      customerId: random() < 0.3 ? pick(random, customers).id : null,
    },
    randomUUID(),
    { now: at },
  );

  return true;
}

/**
 * Seeds `days` business days of history ending today: each cashier opens a register at 08:00, rings
 * up 3 to 8 sales, and closes at 18:00 with a count within 30.00 of the expected cash. The MAIN
 * cashier keeps today's register open. Needs the refs returned by seedBase. Returns the sale count.
 */
export async function seedHistory(db, refs, { now = new Date(), days = 30, seed = 1 } = {}) {
  const random = createRandom(seed);
  const budgets = await loadBudgets(db, now);
  const products = refs.products.filter((product) => {
    return product.classification === "OTC" && !product.requiresPrescription;
  });
  const today = businessDate(now);
  const users = new Map();
  let sales = 0;
  let counter = 0;

  for (const { key } of CASHIERS) {
    users.set(key, await loadAuthUser(refs.users[key].id));
  }

  for (const day of eachDay(addDays(today, 1 - days), today)) {
    const dayStart = startOfBusinessDay(day).getTime();
    const lastSaleAt = Math.min(dayStart + 17.5 * HOUR_MS, now.getTime());
    const openAt = Math.min(dayStart + 8 * HOUR_MS, lastSaleAt - HOUR_MS);
    const closeAt = Math.min(dayStart + 18 * HOUR_MS, now.getTime());

    for (const cashier of CASHIERS) {
      const user = users.get(cashier.key);
      const branch = refs.branches[cashier.branch];
      const { id: sessionId } = await openSession(
        { user, registerId: refs.registers[cashier.branch].id, openingCash: OPENING_CASH },
        { now: new Date(openAt) },
      );
      const planned = between(random, 3, 8);

      for (let index = 0; index < planned; index += 1) {
        const at = new Date(
          Math.round((openAt + ((lastSaleAt - openAt) * (index + 1)) / (planned + 1)) / 1000) *
            1000,
        );

        counter += 1;

        if (
          await ringUpSale({
            random,
            db,
            user,
            branchId: branch.id,
            products,
            customers: refs.customers,
            budgets,
            at,
            counter,
          })
        ) {
          sales += 1;
        }
      }

      if (day === today && cashier.keepsTodayOpen) {
        continue;
      }

      const { expectedCash } = await sessionSummary(sessionId);
      const counted =
        toCents(expectedCash) + BigInt(between(random, -MAX_VARIANCE_CENTS, MAX_VARIANCE_CENTS));

      await closeSession(
        { user, sessionId, countedCash: fromCents(counted) },
        { now: new Date(closeAt) },
      );
    }
  }

  return { sales };
}
