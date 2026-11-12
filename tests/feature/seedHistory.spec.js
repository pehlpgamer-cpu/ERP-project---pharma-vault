import { test } from "@japa/runner";
import { db, pool } from "../../database/client.js";
import { seedBase } from "../../database/seed/base.js";
import { seedHistory } from "../../database/seed/history.js";
import { resetDatabase } from "../helpers/db.js";

const NOW = new Date("2026-11-12T10:30:00Z"); // 18:30 on Nov 12 in Asia/Manila
const DAYS = ["2026-11-10", "2026-11-11", "2026-11-12"];

async function rows(query) {
  const [result] = await pool.query(query);

  return result;
}

test.group("seed history (three days through the real services)", (group) => {
  let outcome;

  group.setup(async () => {
    await resetDatabase();
    const refs = await seedBase(db, { password: "PharmaVault-demo-2026", now: NOW });

    outcome = await seedHistory(db, refs, { now: NOW, days: 3, seed: 1 });
  });

  test("every day has sales for both cashiers and the count is reported", async ({ expect }) => {
    const perDay = await rows(`
      SELECT DATE(CONVERT_TZ(s.transaction_date, '+00:00', '+08:00')) AS day, u.email AS cashier, COUNT(*) AS sales
      FROM sales s JOIN users u ON u.id = s.cashier_id
      GROUP BY day, cashier ORDER BY day, cashier`);
    const total = await rows("SELECT COUNT(*) AS n FROM sales");

    expect(perDay).toHaveLength(6);

    for (const row of perDay) {
      expect(Number(row.sales)).toBeGreaterThanOrEqual(3);
      expect(Number(row.sales)).toBeLessThanOrEqual(8);
    }

    expect(
      [
        ...new Set(
          perDay.map((row) => {
            return new Date(row.day).toISOString().slice(0, 10);
          }),
        ),
      ].sort(),
    ).toEqual(DAYS);
    expect(outcome.sales).toBe(Number(total[0].n));
  });

  test("today's MAIN cashier keeps an open session; every other session is closed", async ({
    expect,
  }) => {
    const sessions = await rows(`
      SELECT s.status, u.email AS cashier, s.opened_at
      FROM cash_register_sessions s JOIN users u ON u.id = s.cashier_id ORDER BY s.opened_at`);
    const open = sessions.filter((session) => {
      return session.status === "OPEN";
    });

    expect(sessions).toHaveLength(6);
    expect(open).toHaveLength(1);
    expect(open[0].cashier).toBe("cashier.main@pharmavault.test");
    expect(open[0].opened_at.toISOString().slice(0, 10)).toBe("2026-11-12");
    expect(
      sessions
        .filter((session) => {
          return session.status !== "OPEN";
        })
        .map((session) => {
          return session.status;
        }),
    ).toEqual(["CLOSED", "CLOSED", "CLOSED", "CLOSED", "CLOSED"]);
  });

  test("each sale item's batch allocations add up to its base quantity", async ({ expect }) => {
    const items = await rows("SELECT COUNT(*) AS n FROM sale_items");
    const off = await rows(`
      SELECT si.id FROM sale_items si LEFT JOIN sale_item_batches b ON b.sale_item_id = si.id
      GROUP BY si.id, si.base_quantity
      HAVING COALESCE(SUM(b.quantity), 0) <> si.base_quantity`);

    expect(Number(items[0].n)).toBeGreaterThan(0);
    expect(off).toEqual([]);
  });

  test("each sale adds up: total, discount, tax, amount paid and change", async ({ expect }) => {
    const off = await rows(`
      SELECT id FROM sales
      WHERE total_amount <> subtotal - discount_amount + tax_amount
         OR amount_paid - change_amount <> total_amount
         OR status <> 'COMPLETED'`);

    expect(off).toEqual([]);
  });

  test("each closed session reconciles with its cash ledger and variance", async ({ expect }) => {
    const closed = await rows(
      "SELECT COUNT(*) AS n FROM cash_register_sessions WHERE status = 'CLOSED'",
    );
    const off = await rows(`
      SELECT s.id FROM cash_register_sessions s
      LEFT JOIN cash_transactions t ON t.cash_register_session_id = s.id AND t.transaction_type = 'CASH_SALE'
      WHERE s.status = 'CLOSED'
      GROUP BY s.id, s.opening_cash, s.expected_cash, s.actual_cash, s.variance
      HAVING s.expected_cash <> s.opening_cash + COALESCE(SUM(t.amount), 0)
          OR s.variance <> s.actual_cash - s.expected_cash
          OR ABS(s.variance) > 30`);

    expect(Number(closed[0].n)).toBe(5);
    expect(off).toEqual([]);
  });

  test("batch stock is received minus sold, and inventories match their batches", async ({
    expect,
  }) => {
    const batches = await rows(`
      SELECT b.id FROM inventory_batches b LEFT JOIN sale_item_batches sb ON sb.inventory_batch_id = b.id
      GROUP BY b.id, b.quantity_received, b.quantity_available
      HAVING b.quantity_received - COALESCE(SUM(sb.quantity), 0) <> b.quantity_available`);
    const inventories = await rows(`
      SELECT i.id FROM inventories i
      JOIN (SELECT inventory_id, SUM(quantity_available) AS total FROM inventory_batches GROUP BY inventory_id) b
        ON b.inventory_id = i.id
      WHERE i.quantity_on_hand <> b.total`);
    const negative = await rows(
      "SELECT id FROM inventory_batches WHERE quantity_available < 0 UNION ALL SELECT id FROM inventories WHERE quantity_on_hand < 0",
    );

    expect(batches).toEqual([]);
    expect(inventories).toEqual([]);
    expect(negative).toEqual([]);
  });

  test("only OTC products were sold, and quarantined or recalled batches were never touched", async ({
    expect,
  }) => {
    const restricted = await rows(`
      SELECT si.id FROM sale_items si JOIN products p ON p.id = si.product_id
      WHERE p.requires_prescription = 1 OR p.prescription_classification <> 'OTC'`);
    const touched = await rows(`
      SELECT b.id FROM inventory_batches b
      WHERE b.status IN ('QUARANTINED', 'RECALLED') AND b.quantity_available <> b.quantity_received`);

    expect(restricted).toEqual([]);
    expect(touched).toEqual([]);
  });

  test("invoice numbers run 1, 2, 3... for each branch and business day", async ({ expect }) => {
    const numbers = await rows(`
      SELECT invoice_number FROM sales ORDER BY invoice_number`);
    const byDay = new Map();

    for (const { invoice_number: invoice } of numbers) {
      const [, branch, day, sequence] = /^(\w+)-(\d{8})-(\d{4})$/.exec(invoice);
      const key = `${branch}-${day}`;

      byDay.set(key, [...(byDay.get(key) ?? []), Number(sequence)]);
    }

    expect(byDay.size).toBe(6);

    for (const [key, sequence] of byDay) {
      expect([
        key,
        sequence.sort((a, b) => {
          return a - b;
        }),
      ]).toEqual([
        key,
        Array.from({ length: sequence.length }, (_, index) => {
          return index + 1;
        }),
      ]);
    }
  });
});
