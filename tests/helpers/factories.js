import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { branches } from "../../app/models/branches.js";
import { cashRegisterSessions } from "../../app/models/cash-register-sessions.js";
import { cashRegisters } from "../../app/models/cash-registers.js";
import { cashTransactions } from "../../app/models/cash-transactions.js";
import { customers } from "../../app/models/customers.js";
import { inventories } from "../../app/models/inventories.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { permissions } from "../../app/models/permissions.js";
import { productBarcodes } from "../../app/models/product-barcodes.js";
import { productPrices } from "../../app/models/product-prices.js";
import { productUnits } from "../../app/models/product-units.js";
import { products } from "../../app/models/products.js";
import { rolePermissions } from "../../app/models/role-permissions.js";
import { roles } from "../../app/models/roles.js";
import { saleItemBatches } from "../../app/models/sale-item-batches.js";
import { saleItems } from "../../app/models/sale-items.js";
import { salePayments } from "../../app/models/sale-payments.js";
import { sales } from "../../app/models/sales.js";
import { units } from "../../app/models/units.js";
import { userRoles } from "../../app/models/user-roles.js";
import { users } from "../../app/models/users.js";
import { hashPassword } from "../../app/services/auth/passwords.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { loadAuthUser } from "../../app/services/auth/users.js";
import { mul, sum, toScale } from "../../app/services/support/decimal.js";

let counter = 0;
const passwordHashes = new Map();

function nextNumber() {
  counter += 1;

  return counter;
}

const DEFAULT_TIME = new Date("2026-01-01T00:00:00Z");

// Hashing is the slow part of making a user; one hash per distinct plain password is enough.
async function hashOnce(password) {
  if (!passwordHashes.has(password)) {
    passwordHashes.set(password, await hashPassword(password));
  }

  return passwordHashes.get(password);
}

async function findOrCreatePermission(name) {
  const [existing] = await db.select().from(permissions).where(eq(permissions.name, name)).limit(1);

  if (existing) {
    return existing.id;
  }

  const id = randomUUID();
  await db.insert(permissions).values({ id, name });

  return id;
}

async function findOrCreateRole(name, permissionNames) {
  const [existing] = await db.select().from(roles).where(eq(roles.name, name)).limit(1);

  if (existing) {
    return existing.id;
  }

  const roleId = randomUUID();
  await db.insert(roles).values({ id: roleId, name });

  for (const permissionName of permissionNames) {
    await db
      .insert(rolePermissions)
      .values({ roleId, permissionId: await findOrCreatePermission(permissionName) });
  }

  return roleId;
}

async function findOrCreateUnit(name) {
  const [existing] = await db.select().from(units).where(eq(units.name, name)).limit(1);

  if (existing) {
    return existing.id;
  }

  const id = randomUUID();
  await db.insert(units).values({ id, name, abbreviation: name.slice(0, 8).toLowerCase() });

  return id;
}

export async function makeBranch({ code, name } = {}) {
  const number = nextNumber();
  const branchCode = code ?? `B${number}`;
  const branch = { id: randomUUID(), code: branchCode, name: name ?? `Branch ${branchCode}` };

  await db.insert(branches).values(branch);

  return branch;
}

/** Gives a user a role (created with exactly these permissions when it does not exist yet). */
export async function assignRole(userId, roleName, permissionNames = []) {
  const roleId = await findOrCreateRole(roleName, permissionNames);

  await db.insert(userRoles).values({ userId, roleId });
}

/**
 * Creates a user with one role holding exactly `permissions`. `password` is the plain value, also
 * returned so tests can sign in.
 */
export async function makeUser({
  branchId = null,
  permissions: permissionNames = [],
  roleName,
  email,
  password = "correct horse battery",
  name,
  isActive = true,
} = {}) {
  const number = nextNumber();
  const user = {
    id: randomUUID(),
    email: email ?? `user${number}@pharmavault.test`,
    name: name ?? `User ${number}`,
    branchId,
  };

  await db.insert(users).values({ ...user, password: await hashOnce(password), isActive });
  await assignRole(user.id, roleName ?? `role-${number}`, permissionNames);

  return { ...user, password };
}

/** makeUser, returned as the AuthUser the services take (branch, role names, permissions). */
export async function makeAuthUser(options = {}) {
  const user = await makeUser(options);

  return loadAuthUser(user.id);
}

/**
 * A product with its sale units, prices, barcodes and (when `branchId` is given) stock batches.
 * Each unit: { name, factor = "1", base, price, canBeSold = true, isActive = true, barcodes = [] };
 * a unit with a price gets a global product_prices row effective since 2000.
 * Each batch: { quantity, expirationDate = "2030-01-31" | null, status = "ACTIVE", receivedAt,
 * unitCost = "1.0000", batchNumber }.
 */
export async function makeProduct({
  branchId = null,
  sku,
  name,
  genericName = "Generic",
  brandName = null,
  classification = "OTC",
  requiresPrescription = false,
  isActive = true,
  units: unitSpecs = [{ name: "Tablet", factor: "1", base: true, price: "10.0000" }],
  batches: batchSpecs = [],
} = {}) {
  const number = nextNumber();
  const productId = randomUUID();
  const productSku = sku ?? `SKU-${number}`;
  const productName = name ?? `Product ${number}`;

  await db.insert(products).values({
    id: productId,
    sku: productSku,
    genericName,
    brandName,
    productName,
    prescriptionClassification: classification,
    requiresPrescription,
    isActive,
  });

  const unitRows = [];

  for (const spec of unitSpecs) {
    const id = randomUUID();
    const factor = spec.factor ?? "1";

    await db.insert(productUnits).values({
      id,
      productId,
      unitId: await findOrCreateUnit(spec.name),
      conversionFactor: factor,
      isBaseUnit: spec.base ?? false,
      canBeSold: spec.canBeSold ?? true,
      isActive: spec.isActive ?? true,
    });

    if (spec.price !== undefined) {
      await db.insert(productPrices).values({
        productUnitId: id,
        unitPrice: spec.price,
        effectiveFrom: new Date("2000-01-01T00:00:00Z"),
      });
    }

    for (const barcode of spec.barcodes ?? []) {
      await db.insert(productBarcodes).values({ productUnitId: id, barcode, isPrimary: false });
    }

    unitRows.push({ id, name: spec.name, factor, isBase: spec.base ?? false });
  }

  const batchRows = [];
  let inventoryId = null;

  if (batchSpecs.length > 0) {
    if (branchId === null) {
      throw new Error("makeProduct needs a branchId to create batches");
    }

    inventoryId = randomUUID();
    await db.insert(inventories).values({
      id: inventoryId,
      branchId,
      productId,
      quantityOnHand: sum(
        batchSpecs.map((batch) => {
          return batch.quantity;
        }),
      ),
    });

    for (const spec of batchSpecs) {
      const id = randomUUID();
      const expiry = spec.expirationDate === undefined ? "2030-01-31" : spec.expirationDate;
      const row = {
        id,
        inventoryId,
        productId,
        branchId,
        batchNumber: spec.batchNumber ?? `BATCH-${nextNumber()}`,
        expirationDate: expiry === null ? null : new Date(`${expiry}T00:00:00Z`),
        quantityReceived: spec.quantity,
        quantityAvailable: spec.quantity,
        unitCost: spec.unitCost ?? "1.0000",
        receivedAt: spec.receivedAt ?? DEFAULT_TIME,
        status: spec.status ?? "ACTIVE",
      };

      await db.insert(inventoryBatches).values(row);
      batchRows.push({ ...row, expirationDate: expiry });
    }
  }

  return {
    product: { id: productId, sku: productSku, name: productName },
    units: unitRows,
    batches: batchRows,
    inventoryId,
  };
}

export async function makeRegister({ branchId, code, name, isActive = true } = {}) {
  const number = nextNumber();
  const register = {
    id: randomUUID(),
    branchId,
    registerCode: code ?? `R${number}`,
    name: name ?? `Counter ${number}`,
    isActive,
  };

  await db.insert(cashRegisters).values(register);

  return register;
}

export async function makeOpenSession({
  registerId,
  cashierId,
  openingCash = "1000.00",
  openedAt = DEFAULT_TIME,
  status = "OPEN",
} = {}) {
  const session = {
    id: randomUUID(),
    cashRegisterId: registerId,
    cashierId,
    openingCash,
    openedAt,
    status,
  };

  await db.insert(cashRegisterSessions).values(session);

  return session;
}

export async function makeCashTransaction({ sessionId, type, amount, performedBy, reason = null }) {
  const row = {
    id: randomUUID(),
    cashRegisterSessionId: sessionId,
    transactionType: type,
    amount,
    performedBy,
    reason,
  };

  await db.insert(cashTransactions).values(row);

  return row;
}

export async function makeCustomer({ firstName = "Ana", lastName = "Reyes" } = {}) {
  const number = nextNumber();
  const customer = { id: randomUUID(), customerNumber: `C-${number}`, firstName, lastName };

  await db.insert(customers).values(customer);

  return customer;
}

/**
 * Inserts a finished sale directly (no stock side effects) so query tests control every field.
 * lines: [{ productId, productUnitId, productName, quantity, baseQuantity, unitPrice, batches: [{ batchId, quantity }] }]
 * payments: [{ method, amount, reference, status }]. Totals are computed with the decimal helpers.
 */
export async function makeSale({
  branchId,
  cashierId,
  sessionId,
  transactionDate = new Date(),
  status = "COMPLETED",
  invoiceNumber,
  customerId = null,
  lines,
  payments,
  changeAmount = "0.00",
}) {
  const saleId = randomUUID();
  const invoice = invoiceNumber ?? `INV-${String(nextNumber()).padStart(6, "0")}`;
  const lineRows = lines.map((line) => {
    const quantity = line.quantity ?? "1";
    const unitPrice = line.unitPrice ?? "10.00";
    const subtotal = toScale(mul(quantity, unitPrice), 2);

    return { line, quantity, unitPrice, subtotal };
  });
  const subtotal = sum(
    lineRows.map((row) => {
      return row.subtotal;
    }),
  );
  const paid = sum(
    payments
      .filter((payment) => {
        return (payment.status ?? "PAID") === "PAID";
      })
      .map((payment) => {
        return payment.amount;
      }),
  );

  await db.insert(sales).values({
    id: saleId,
    branchId,
    customerId,
    cashierId,
    cashRegisterSessionId: sessionId,
    invoiceNumber: invoice,
    transactionDate,
    subtotal: toScale(subtotal, 2),
    totalAmount: toScale(subtotal, 2),
    amountPaid: toScale(paid, 2),
    changeAmount,
    status,
  });

  for (const { line, quantity, unitPrice, subtotal: lineSubtotal } of lineRows) {
    const itemId = randomUUID();

    await db.insert(saleItems).values({
      id: itemId,
      saleId,
      productId: line.productId,
      productUnitId: line.productUnitId,
      productNameSnapshot: line.productName ?? "Test product",
      genericNameSnapshot: line.genericName ?? null,
      quantity,
      baseQuantity: line.baseQuantity ?? quantity,
      unitPrice,
      unitCost: "1.0000",
      subtotal: lineSubtotal,
      totalAmount: lineSubtotal,
    });

    for (const batch of line.batches ?? []) {
      await db.insert(saleItemBatches).values({
        saleItemId: itemId,
        inventoryBatchId: batch.batchId,
        quantity: batch.quantity,
        unitCost: batch.unitCost ?? "1.0000",
      });
    }
  }

  for (const payment of payments) {
    await db.insert(salePayments).values({
      saleId,
      paymentMethod: payment.method ?? "CASH",
      amount: payment.amount,
      referenceNumber: payment.reference ?? null,
      paymentStatus: payment.status ?? "PAID",
      paidAt: transactionDate,
    });
  }

  return { id: saleId, invoiceNumber: invoice };
}

/**
 * A branch with a cashier (cashier role), a register with an open session, and one product with a
 * large stock batch: everything makeSaleIn needs.
 */
export async function makeWorld({
  branchCode = "MAIN",
  branchName = "Main Branch",
  cashierName = "Ana Reyes",
} = {}) {
  const branch = await makeBranch({ code: branchCode, name: branchName });
  const cashier = await makeUser({
    branchId: branch.id,
    roleName: `cashier-${branchCode}`,
    permissions: ROLE_PERMISSIONS.cashier,
    name: cashierName,
  });
  const register = await makeRegister({ branchId: branch.id });
  const session = await makeOpenSession({ registerId: register.id, cashierId: cashier.id });
  const stock = await makeProduct({
    branchId: branch.id,
    name: "Paracetamol 500 mg Tablet",
    units: [{ name: "Tablet", factor: "1", base: true, price: "10.0000" }],
    batches: [{ quantity: "100000", batchNumber: `PARA-${branchCode}` }],
  });

  return {
    branch,
    cashier,
    register,
    session,
    product: stock.product,
    unit: stock.units[0],
    batch: stock.batches[0],
  };
}

/**
 * makeSale inside a world: one 10.00 line of the world's product paid in cash (change-free) unless
 * overridden. `overrides` are makeSale options.
 */
export function makeSaleIn(world, overrides = {}) {
  return makeSale({
    branchId: world.branch.id,
    cashierId: world.cashier.id,
    sessionId: world.session.id,
    lines: [
      {
        productId: world.product.id,
        productUnitId: world.unit.id,
        quantity: "1",
        unitPrice: "10.00",
        batches: [{ batchId: world.batch.id, quantity: "1" }],
      },
    ],
    payments: [{ method: "CASH", amount: "10.00" }],
    ...overrides,
  });
}
