import { randomUUID } from "node:crypto";
import { branches } from "../../app/models/branches.js";
import { cashRegisters } from "../../app/models/cash-registers.js";
import { customers } from "../../app/models/customers.js";
import { inventories } from "../../app/models/inventories.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { manufacturers } from "../../app/models/manufacturers.js";
import { permissions } from "../../app/models/permissions.js";
import { productBarcodes } from "../../app/models/product-barcodes.js";
import { productCategories } from "../../app/models/product-categories.js";
import { productPrices } from "../../app/models/product-prices.js";
import { productUnits } from "../../app/models/product-units.js";
import { products } from "../../app/models/products.js";
import { rolePermissions } from "../../app/models/role-permissions.js";
import { roles } from "../../app/models/roles.js";
import { units } from "../../app/models/units.js";
import { userRoles } from "../../app/models/user-roles.js";
import { users } from "../../app/models/users.js";
import { hashPassword } from "../../app/services/auth/passwords.js";
import { PERMISSIONS, ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { CATALOG, CATEGORIES, CUSTOMERS, MANUFACTURERS, UNITS } from "./catalog.js";

const DAY_MS = 86_400_000;

const BRANCHES = {
  main: { code: "MAIN", name: "Main Branch", address: "Calapan City, Oriental Mindoro" },
  north: { code: "NORTH", name: "North Branch", address: "Naujan, Oriental Mindoro" },
};

const ACCOUNTS = [
  {
    key: "admin",
    name: "Ada Admin",
    email: "admin@pharmavault.test",
    role: "admin",
    branch: "main",
  },
  {
    key: "pharmacist",
    name: "Paolo Pharmacist",
    email: "pharmacist@pharmavault.test",
    role: "pharmacist",
    branch: "main",
  },
  {
    key: "cashierMain",
    name: "Carla Cashier",
    email: "cashier.main@pharmavault.test",
    role: "cashier",
    branch: "main",
  },
  {
    key: "accountant",
    name: "Aly Accountant",
    email: "accountant@pharmavault.test",
    role: "accountant",
    branch: "main",
  },
  {
    key: "cashierNorth",
    name: "Nico Cashier",
    email: "cashier.north@pharmavault.test",
    role: "cashier",
    branch: "north",
  },
];

const ROLE_DESCRIPTIONS = {
  admin: "Full access to every module",
  pharmacist: "Sells and reviews sales of the assigned branch",
  cashier: "Rings up sales and manages their own register",
  accountant: "Read-only view of sales across all branches",
};

const PERMISSION_DESCRIPTIONS = {
  [PERMISSIONS.DASHBOARD_VIEW]: "See the dashboard",
  [PERMISSIONS.SALES_VIEW_OWN]: "See sales you rang up",
  [PERMISSIONS.SALES_VIEW_BRANCH]: "See every sale of your branch",
  [PERMISSIONS.SALES_VIEW_ALL]: "See sales of every branch",
  [PERMISSIONS.SALES_CREATE]: "Ring up sales at the POS",
  [PERMISSIONS.REGISTER_MANAGE]: "Open and close your cash register",
  [PERMISSIONS.USERS_MANAGE]: "See and manage user accounts",
  [PERMISSIONS.PRODUCTS_MANAGE]: "Create and edit products",
  [PERMISSIONS.INVENTORY_VIEW]: "See stock levels and batches",
  [PERMISSIONS.INVENTORY_MANAGE]: "Quarantine, recall and write off batches",
};

// DATE columns are written as UTC midnight of the day `offset` days from `now`.
function dayFromNow(now, offset) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
}

function pad(value, length) {
  return String(value).padStart(length, "0");
}

// Two normal batches per branch (40 / 60 split) plus, in MAIN only, the product's special batch.
function batchPlan(product, branchKey) {
  const total = Math.round(product.stock * (branchKey === "main" ? 1 : 0.6));
  const first = Math.floor(total * 0.4);
  const noExpiry = product.special === "no-expiry";
  const plan = [
    {
      suffix: "A",
      quantity: first,
      expiryDays: noExpiry ? null : 300,
      status: "ACTIVE",
      receivedDaysAgo: 60,
    },
    {
      suffix: "B",
      quantity: total - first,
      expiryDays: noExpiry ? null : 540,
      status: "ACTIVE",
      receivedDaysAgo: 50,
    },
  ];

  if (branchKey !== "main") {
    return plan;
  }

  const extras = {
    expired: { suffix: "X", quantity: 300, expiryDays: -20, status: "ACTIVE" },
    quarantined: { suffix: "Q", quantity: 100, expiryDays: 400, status: "QUARANTINED" },
    recalled: { suffix: "R", quantity: 80, expiryDays: 400, status: "RECALLED" },
    "near-expiry": { suffix: "N", quantity: 150, expiryDays: 25, status: "ACTIVE" },
  };

  if (extras[product.special]) {
    plan.push({ ...extras[product.special], receivedDaysAgo: 55 });
  }

  return plan;
}

/**
 * Inserts the base demo data in one transaction: branches, permissions, roles, users, registers,
 * the catalog with units, barcodes and prices, stock batches per branch, and customers.
 * Everything is derived from `now`, so the data is deterministic for a given clock.
 * Returns the inserted rows the history seed needs.
 */
export async function seedBase(db, { password, now = new Date() }) {
  const passwordHash = await hashPassword(password);

  return db.transaction(async (tx) => {
    // Branches and registers
    const branchRows = {};

    for (const [key, branch] of Object.entries(BRANCHES)) {
      branchRows[key] = { id: randomUUID(), ...branch };
    }

    await tx.insert(branches).values(Object.values(branchRows));

    const registerRows = {};

    for (const key of Object.keys(BRANCHES)) {
      registerRows[key] = {
        id: randomUUID(),
        branchId: branchRows[key].id,
        name: "Counter 1",
        registerCode: "R1",
      };
    }

    await tx.insert(cashRegisters).values(Object.values(registerRows));

    // Permissions, roles and their links
    const permissionRows = Object.values(PERMISSIONS).map((name) => {
      return { id: randomUUID(), name, description: PERMISSION_DESCRIPTIONS[name] };
    });
    const roleRows = Object.keys(ROLE_PERMISSIONS).map((name) => {
      return { id: randomUUID(), name, description: ROLE_DESCRIPTIONS[name] };
    });

    await tx.insert(permissions).values(permissionRows);
    await tx.insert(roles).values(roleRows);
    await tx.insert(rolePermissions).values(
      roleRows.flatMap((role) => {
        return ROLE_PERMISSIONS[role.name].map((permissionName) => {
          return {
            roleId: role.id,
            permissionId: permissionRows.find((permission) => {
              return permission.name === permissionName;
            }).id,
          };
        });
      }),
    );

    // Users
    const userRefs = {};
    const userRows = ACCOUNTS.map((account, index) => {
      const row = {
        id: randomUUID(),
        branchId: branchRows[account.branch].id,
        name: account.name,
        email: account.email,
        employeeNumber: `EMP-${pad(index + 1, 3)}`,
        password: passwordHash,
      };
      userRefs[account.key] = { id: row.id, name: row.name, email: row.email, role: account.role };

      return row;
    });

    await tx.insert(users).values(userRows);
    await tx.insert(userRoles).values(
      ACCOUNTS.map((account) => {
        return {
          userId: userRefs[account.key].id,
          roleId: roleRows.find((role) => {
            return role.name === account.role;
          }).id,
        };
      }),
    );

    // Reference data for the catalog
    const unitRows = Object.fromEntries(
      UNITS.map((unit) => {
        return [unit.key, { id: randomUUID(), name: unit.name, abbreviation: unit.abbreviation }];
      }),
    );
    const categoryRows = Object.fromEntries(
      CATEGORIES.map((name) => {
        return [name, { id: randomUUID(), name }];
      }),
    );
    const manufacturerRows = Object.fromEntries(
      MANUFACTURERS.map((manufacturer) => {
        return [manufacturer.name, { id: randomUUID(), ...manufacturer }];
      }),
    );

    await tx.insert(units).values(Object.values(unitRows));
    await tx.insert(productCategories).values(Object.values(categoryRows));
    await tx.insert(manufacturers).values(Object.values(manufacturerRows));

    // Products, units, barcodes, prices, inventories and batches
    const productRefs = [];
    const productRows = [];
    const productUnitRows = [];
    const barcodeRows = [];
    const priceRows = [];
    const inventoryRows = [];
    const batchRows = [];
    const priceStart = new Date(now.getTime() - 60 * DAY_MS);

    CATALOG.forEach((entry, productIndex) => {
      const productId = randomUUID();
      const ref = {
        id: productId,
        sku: entry.sku,
        name: entry.productName,
        classification: entry.classification,
        requiresPrescription: entry.requiresPrescription,
        units: [],
      };

      productRows.push({
        id: productId,
        categoryId: categoryRows[entry.category].id,
        manufacturerId: manufacturerRows[entry.manufacturer].id,
        sku: entry.sku,
        genericName: entry.genericName,
        productName: entry.productName,
        strength: entry.strength,
        dosageForm: entry.dosageForm,
        prescriptionClassification: entry.classification,
        requiresPrescription: entry.requiresPrescription,
        reorderLevel: entry.reorderLevel,
      });

      entry.units.forEach((unit, unitIndex) => {
        const productUnitId = randomUUID();

        productUnitRows.push({
          id: productUnitId,
          productId,
          unitId: unitRows[unit.unit].id,
          conversionFactor: unit.factor,
          isBaseUnit: unitIndex === 0,
        });
        barcodeRows.push({
          productUnitId,
          barcode: `4800100${pad(productIndex + 1, 3)}${pad(unitIndex, 2)}0`,
          isPrimary: true,
        });
        priceRows.push({
          productUnitId,
          branchId: null,
          unitPrice: unit.price,
          effectiveFrom: priceStart,
        });

        if (entry.northPrices?.[unit.unit]) {
          priceRows.push({
            productUnitId,
            branchId: branchRows.north.id,
            unitPrice: entry.northPrices[unit.unit],
            effectiveFrom: priceStart,
          });
        }

        ref.units.push({
          id: productUnitId,
          name: unitRows[unit.unit].name,
          factor: unit.factor,
          isBase: unitIndex === 0,
        });
      });

      for (const branchKey of Object.keys(BRANCHES)) {
        const inventoryId = randomUUID();
        const plan = batchPlan(entry, branchKey);

        inventoryRows.push({
          id: inventoryId,
          branchId: branchRows[branchKey].id,
          productId,
          quantityOnHand: String(
            plan.reduce((total, batch) => {
              return total + batch.quantity;
            }, 0),
          ),
        });

        for (const batch of plan) {
          batchRows.push({
            inventoryId,
            productId,
            branchId: branchRows[branchKey].id,
            batchNumber: `${entry.sku}-${batch.suffix}`,
            expirationDate: batch.expiryDays === null ? null : dayFromNow(now, batch.expiryDays),
            manufacturingDate:
              batch.expiryDays === null ? null : dayFromNow(now, batch.expiryDays - 730),
            quantityReceived: String(batch.quantity),
            quantityAvailable: String(batch.quantity),
            unitCost: entry.cost,
            receivedAt: new Date(now.getTime() - batch.receivedDaysAgo * DAY_MS),
            status: batch.status,
          });
        }
      }

      productRefs.push(ref);
    });

    await tx.insert(products).values(productRows);
    await tx.insert(productUnits).values(productUnitRows);
    await tx.insert(productBarcodes).values(barcodeRows);
    await tx.insert(productPrices).values(priceRows);
    await tx.insert(inventories).values(inventoryRows);
    await tx.insert(inventoryBatches).values(batchRows);

    // Customers
    const customerRows = CUSTOMERS.map((customer, index) => {
      return {
        id: randomUUID(),
        customerNumber: `C-${pad(index + 1, 4)}`,
        firstName: customer.firstName,
        lastName: customer.lastName,
        birthDate: new Date(`${customer.birthDate}T00:00:00Z`),
        contactNumber: customer.contactNumber,
      };
    });

    await tx.insert(customers).values(customerRows);

    return {
      branches: { main: branchRows.main, north: branchRows.north },
      users: userRefs,
      registers: { main: registerRows.main, north: registerRows.north },
      products: productRefs,
      customers: customerRows,
    };
  });
}
