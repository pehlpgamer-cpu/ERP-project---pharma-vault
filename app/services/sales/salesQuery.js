import { and, asc, count, desc, eq, exists, gte, inArray, like, lt, sql } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { HttpError, ValidationError } from "../../http/errors.js";
import { branches } from "../../models/branches.js";
import { cashRegisterSessions } from "../../models/cash-register-sessions.js";
import { cashRegisters } from "../../models/cash-registers.js";
import { customers } from "../../models/customers.js";
import { refunds } from "../../models/refunds.js";
import { saleItems } from "../../models/sale-items.js";
import { salePayments } from "../../models/sale-payments.js";
import { sales } from "../../models/sales.js";
import { salesReturns } from "../../models/sales-returns.js";
import { users } from "../../models/users.js";
import { cmp, div, sub, toScale } from "../support/decimal.js";
import {
  addDays,
  businessDate,
  businessOffsetMinutes,
  businessTimeZone,
  eachDay,
  startOfBusinessDay,
  startOfNextBusinessDay,
  toDateString,
} from "../support/time.js";
import { salesScope } from "./scope.js";

// Statuses of sales that happened. VOIDED is counted separately and PENDING not at all.
const HAPPENED = ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"];

// The summary lists every day of its range, so the range has to be bounded.
const MAX_SUMMARY_DAYS = 366;
const DAY_MS = 86_400_000;

const SORT_COLUMNS = {
  transactionDate: sales.transactionDate,
  totalAmount: sales.totalAmount,
  invoiceNumber: sales.invoiceNumber,
};

function forbidden() {
  return new HttpError(403, "forbidden", "You do not have access to that data");
}

// Escapes LIKE wildcards so a search for "%" or "_" matches those characters literally.
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (character) => {
    return `\\${character}`;
  });
}

/**
 * Conditions on `sales` that confine a query to what the scope allows, honoring the optional
 * branch and cashier filters. Throws 403 for a filter outside the scope.
 */
function visibility(scope, filters) {
  const conditions = [];

  if (scope.level === "none") {
    throw forbidden();
  }

  if (scope.level === "all") {
    if (filters.branchId) {
      conditions.push(eq(sales.branchId, filters.branchId));
    }

    if (filters.cashierId) {
      conditions.push(eq(sales.cashierId, filters.cashierId));
    }

    return conditions;
  }

  if (filters.branchId && filters.branchId !== scope.branchId) {
    throw forbidden();
  }

  if (scope.level === "branch") {
    conditions.push(eq(sales.branchId, scope.branchId));

    if (filters.cashierId) {
      conditions.push(eq(sales.cashierId, filters.cashierId));
    }

    return conditions;
  }

  if (filters.cashierId && filters.cashierId !== scope.userId) {
    throw forbidden();
  }

  conditions.push(eq(sales.cashierId, scope.userId));

  return conditions;
}

// `from` and `to` are business-zone dates, both inclusive.
function dateRange(column, from, to) {
  const conditions = [];

  if (from) {
    conditions.push(gte(column, startOfBusinessDay(from)));
  }

  if (to) {
    conditions.push(lt(column, startOfNextBusinessDay(to)));
  }

  return conditions;
}

function customerOf(customer) {
  if (!customer) {
    return null;
  }

  return {
    id: customer.id,
    customerNumber: customer.customerNumber,
    name: `${customer.firstName} ${customer.lastName}`,
  };
}

function totalsOf(sale) {
  return {
    subtotal: toScale(sale.subtotal, 2),
    discount: toScale(sale.discountAmount, 2),
    tax: toScale(sale.taxAmount, 2),
    total: toScale(sale.totalAmount, 2),
    paid: toScale(sale.amountPaid, 2),
    change: toScale(sale.changeAmount, 2),
  };
}

/**
 * Pages of sales visible to the user, newest first by default.
 * Filters: page, perPage, sort, status[], branchId, cashierId, from, to, paymentMethod, q.
 */
export async function listSales(filters, user) {
  const scope = salesScope(user);
  const conditions = [
    ...visibility(scope, filters),
    ...dateRange(sales.transactionDate, filters.from, filters.to),
  ];

  if (filters.status?.length) {
    conditions.push(inArray(sales.status, filters.status));
  }

  if (filters.paymentMethod) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(salePayments)
          .where(
            and(
              eq(salePayments.saleId, sales.id),
              eq(salePayments.paymentMethod, filters.paymentMethod),
            ),
          ),
      ),
    );
  }

  if (filters.q) {
    conditions.push(like(sales.invoiceNumber, `%${escapeLike(filters.q)}%`));
  }

  const where = and(...conditions);
  const sort = filters.sort ?? "-transactionDate";
  const descending = sort.startsWith("-");
  const column = SORT_COLUMNS[descending ? sort.slice(1) : sort] ?? sales.transactionDate;
  const direction = descending ? desc : asc;

  const [{ total }] = await db.select({ total: count() }).from(sales).where(where);
  const rows = await db
    .select({
      id: sales.id,
      invoiceNumber: sales.invoiceNumber,
      status: sales.status,
      transactionDate: sales.transactionDate,
      subtotal: sales.subtotal,
      discountAmount: sales.discountAmount,
      taxAmount: sales.taxAmount,
      totalAmount: sales.totalAmount,
      amountPaid: sales.amountPaid,
      changeAmount: sales.changeAmount,
      branchId: branches.id,
      branchCode: branches.code,
      branchName: branches.name,
      cashierId: users.id,
      cashierName: users.name,
      customerId: customers.id,
      customerNumber: customers.customerNumber,
      customerFirstName: customers.firstName,
      customerLastName: customers.lastName,
      registerId: cashRegisters.id,
      registerCode: cashRegisters.registerCode,
      registerName: cashRegisters.name,
    })
    .from(sales)
    .innerJoin(branches, eq(branches.id, sales.branchId))
    .innerJoin(users, eq(users.id, sales.cashierId))
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .innerJoin(cashRegisterSessions, eq(cashRegisterSessions.id, sales.cashRegisterSessionId))
    .innerJoin(cashRegisters, eq(cashRegisters.id, cashRegisterSessions.cashRegisterId))
    .where(where)
    .orderBy(direction(column), asc(sales.id))
    .limit(filters.perPage)
    .offset((filters.page - 1) * filters.perPage);

  const ids = rows.map((row) => {
    return row.id;
  });
  const itemCounts = new Map();
  const methods = new Map();

  if (ids.length > 0) {
    const countRows = await db
      .select({ saleId: saleItems.saleId, n: count() })
      .from(saleItems)
      .where(inArray(saleItems.saleId, ids))
      .groupBy(saleItems.saleId);
    const methodRows = await db
      .selectDistinct({ saleId: salePayments.saleId, method: salePayments.paymentMethod })
      .from(salePayments)
      .where(inArray(salePayments.saleId, ids));

    for (const row of countRows) {
      itemCounts.set(row.saleId, Number(row.n));
    }

    for (const row of methodRows) {
      methods.set(row.saleId, [...(methods.get(row.saleId) ?? []), row.method]);
    }
  }

  return {
    total: Number(total),
    rows: rows.map((row) => {
      return {
        id: row.id,
        invoiceNumber: row.invoiceNumber,
        status: row.status,
        transactionDate: row.transactionDate,
        branch: { id: row.branchId, code: row.branchCode, name: row.branchName },
        cashier: { id: row.cashierId, name: row.cashierName },
        customer: customerOf(
          row.customerId
            ? {
                id: row.customerId,
                customerNumber: row.customerNumber,
                firstName: row.customerFirstName,
                lastName: row.customerLastName,
              }
            : null,
        ),
        register: { id: row.registerId, code: row.registerCode, name: row.registerName },
        itemCount: itemCounts.get(row.id) ?? 0,
        paymentMethods: (methods.get(row.id) ?? []).sort(),
        totals: totalsOf(row),
      };
    }),
  };
}

// Receipt order is not stored, so lines are listed by product name (then unit) to stay stable.
function compareLines(a, b) {
  return (
    a.productName.toLowerCase().localeCompare(b.productName.toLowerCase()) ||
    a.unit.name.localeCompare(b.unit.name) ||
    a.id.localeCompare(b.id)
  );
}

function toDetail(sale) {
  const items = sale.items
    .map((item) => {
      return {
        id: item.id,
        productId: item.productId,
        productName: item.productNameSnapshot,
        genericName: item.genericNameSnapshot,
        unit: {
          id: item.productUnit.unit.id,
          name: item.productUnit.unit.name,
          abbreviation: item.productUnit.unit.abbreviation,
        },
        quantity: toScale(item.quantity, 3),
        baseQuantity: toScale(item.baseQuantity, 3),
        unitPrice: toScale(item.unitPrice, 4),
        discount: toScale(item.discountAmount, 2),
        tax: toScale(item.taxAmount, 2),
        subtotal: toScale(item.subtotal, 2),
        total: toScale(item.totalAmount, 2),
        batches: item.batches
          .map((link) => {
            return {
              batchId: link.inventoryBatchId,
              batchNumber: link.batch.batchNumber,
              expirationDate: toDateString(link.batch.expirationDate),
              quantity: toScale(link.quantity, 3),
            };
          })
          .sort((a, b) => {
            return (
              (a.expirationDate ?? "9999").localeCompare(b.expirationDate ?? "9999") ||
              a.batchNumber.localeCompare(b.batchNumber)
            );
          }),
      };
    })
    .sort(compareLines);

  const payments = sale.payments
    .map((payment) => {
      return {
        id: payment.id,
        method: payment.paymentMethod,
        amount: toScale(payment.amount, 2),
        reference: payment.referenceNumber,
        status: payment.paymentStatus,
        paidAt: payment.paidAt,
      };
    })
    .sort((a, b) => {
      return a.method.localeCompare(b.method) || a.id.localeCompare(b.id);
    });

  return {
    id: sale.id,
    invoiceNumber: sale.invoiceNumber,
    status: sale.status,
    transactionDate: sale.transactionDate,
    branch: { id: sale.branch.id, code: sale.branch.code, name: sale.branch.name },
    cashier: { id: sale.cashier.id, name: sale.cashier.name },
    customer: customerOf(sale.customer),
    register: {
      id: sale.session.register.id,
      code: sale.session.register.registerCode,
      name: sale.session.register.name,
    },
    itemCount: items.length,
    paymentMethods: [
      ...new Set(
        payments.map((payment) => {
          return payment.method;
        }),
      ),
    ],
    totals: totalsOf(sale),
    items,
    payments,
  };
}

/** One sale with items, batch allocations and payments, without any scope check. */
export async function loadSaleDetail(id) {
  const sale = await db.query.sales.findFirst({
    where: { id },
    with: {
      branch: true,
      cashier: true,
      customer: true,
      session: { with: { register: true } },
      items: {
        with: { productUnit: { with: { unit: true } }, batches: { with: { batch: true } } },
      },
      payments: true,
    },
  });

  return sale ? toDetail(sale) : null;
}

/** Like loadSaleDetail, but null for a sale the user is not allowed to see. */
export async function getSale(id, user) {
  const scope = salesScope(user);

  if (scope.level === "none") {
    throw forbidden();
  }

  const detail = await loadSaleDetail(id);

  if (detail === null) {
    return null;
  }

  const visible =
    scope.level === "all" ||
    (scope.level === "branch" && detail.branch.id === scope.branchId) ||
    (scope.level === "own" && detail.cashier.id === scope.userId);

  return visible ? detail : null;
}

/**
 * Totals, daily gross, payment mix and top products over a business-date range (default: the last
 * 30 days). Cash is reported net of the change given back.
 */
export async function getSummary(filters, user, { now = new Date() } = {}) {
  const scope = salesScope(user);
  const base = visibility(scope, filters);
  const to = filters.to ?? businessDate(now);
  const from = filters.from ?? addDays(to, -29);
  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;

  if (spanDays > MAX_SUMMARY_DAYS) {
    throw new ValidationError([
      { path: "from", message: `The range can span at most ${MAX_SUMMARY_DAYS} days` },
    ]);
  }

  const happened = and(
    ...base,
    ...dateRange(sales.transactionDate, from, to),
    inArray(sales.status, HAPPENED),
  );

  const [totals] = await db
    .select({
      salesCount: count(),
      gross: sql`COALESCE(SUM(${sales.totalAmount}), 0)`,
      discounts: sql`COALESCE(SUM(${sales.discountAmount}), 0)`,
      tax: sql`COALESCE(SUM(${sales.taxAmount}), 0)`,
      change: sql`COALESCE(SUM(${sales.changeAmount}), 0)`,
    })
    .from(sales)
    .where(happened);

  const [voided] = await db
    .select({ n: count(), total: sql`COALESCE(SUM(${sales.totalAmount}), 0)` })
    .from(sales)
    .where(and(...base, ...dateRange(sales.transactionDate, from, to), eq(sales.status, "VOIDED")));

  const dayRows = await db
    .select({
      day: sql`DATE(DATE_ADD(${sales.transactionDate}, INTERVAL ${sql.raw(String(businessOffsetMinutes()))} MINUTE))`.as(
        "business_day",
      ),
      n: count(),
      gross: sql`COALESCE(SUM(${sales.totalAmount}), 0)`,
    })
    .from(sales)
    .where(happened)
    .groupBy(sql`business_day`);

  const paymentRows = await db
    .select({
      method: salePayments.paymentMethod,
      n: count(),
      amount: sql`COALESCE(SUM(${salePayments.amount}), 0)`,
    })
    .from(salePayments)
    .innerJoin(sales, eq(sales.id, salePayments.saleId))
    .where(and(happened, eq(salePayments.paymentStatus, "PAID")))
    .groupBy(salePayments.paymentMethod);

  const productRows = await db
    .select({
      productId: saleItems.productId,
      productName: sql`MAX(${saleItems.productNameSnapshot})`,
      baseQuantity: sql`SUM(${saleItems.baseQuantity})`,
      revenue: sql`SUM(${saleItems.totalAmount})`,
    })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .where(happened)
    .groupBy(saleItems.productId)
    .orderBy(desc(sql`SUM(${saleItems.totalAmount})`), asc(saleItems.productId))
    .limit(10);

  const [refunded] = await db
    .select({ total: sql`COALESCE(SUM(${refunds.amount}), 0)` })
    .from(refunds)
    .innerJoin(salesReturns, eq(salesReturns.id, refunds.salesReturnId))
    .innerJoin(sales, eq(sales.id, salesReturns.saleId))
    .where(
      and(...base, ...dateRange(refunds.processedAt, from, to), eq(refunds.status, "PROCESSED")),
    );

  const days = new Map(
    dayRows.map((row) => {
      return [toDateString(row.day), row];
    }),
  );
  const salesCount = Number(totals.salesCount);
  const grossSales = toScale(totals.gross, 2);
  const refundTotal = toScale(refunded.total, 2);

  return {
    period: { from, to, timezone: businessTimeZone() },
    totals: {
      salesCount,
      grossSales,
      discounts: toScale(totals.discounts, 2),
      tax: toScale(totals.tax, 2),
      refunds: refundTotal,
      netSales: toScale(sub(grossSales, refundTotal), 2),
      averageSale: salesCount === 0 ? "0.00" : div(grossSales, String(salesCount), 2),
      voidedCount: Number(voided.n),
      voidedTotal: toScale(voided.total, 2),
    },
    byDay: eachDay(from, to).map((date) => {
      const row = days.get(date);

      return {
        date,
        salesCount: row ? Number(row.n) : 0,
        grossSales: toScale(row ? row.gross : "0", 2),
      };
    }),
    byPaymentMethod: paymentRows
      .map((row) => {
        const tendered = toScale(row.amount, 2);

        return {
          method: row.method,
          paymentsCount: Number(row.n),
          amount: row.method === "CASH" ? sub(tendered, toScale(totals.change, 2)) : tendered,
        };
      })
      .sort((a, b) => {
        return cmp(b.amount, a.amount) || a.method.localeCompare(b.method);
      }),
    topProducts: productRows.map((row) => {
      return {
        productId: row.productId,
        productName: row.productName,
        baseQuantity: toScale(row.baseQuantity, 3),
        revenue: toScale(row.revenue, 2),
      };
    }),
  };
}
