// Production bootstrap: the minimum a real installation needs, safe to run again after every upgrade.
//   - every permission and the four standard roles, with their links (missing ones are added, nothing
//     is ever removed or changed, so roles you adjusted by hand keep their extra grants);
//   - the branch, with one cash register when the branch is new;
//   - one admin account (an existing account of that email is promoted, its password is never touched).
// Unlike `npm run db:seed` it holds no demo data and is allowed in production.
//
//   ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" ADMIN_PASSWORD=... \
//   BRANCH_CODE=MAIN BRANCH_NAME="Main Branch" node database/seed/bootstrap.js

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { branches } from "../../app/models/branches.js";
import { cashRegisters } from "../../app/models/cash-registers.js";
import { permissions } from "../../app/models/permissions.js";
import { rolePermissions } from "../../app/models/role-permissions.js";
import { roles } from "../../app/models/roles.js";
import { userRoles } from "../../app/models/user-roles.js";
import { users } from "../../app/models/users.js";
import { hashPassword } from "../../app/services/auth/passwords.js";
import { PERMISSIONS, ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { closeDb, db } from "../client.js";

const MIN_PASSWORD = 14;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BRANCH_CODE = /^[A-Z0-9-]{2,20}$/;

const ROLE_DESCRIPTIONS = {
  admin: "Full access to every module",
  pharmacist: "Sells, receives stock, counts and reviews prescriptions in the assigned branch",
  cashier: "Rings up sales and manages their own register",
  accountant: "Read-only view of sales and stock across all branches",
};

function checkOptions(options) {
  const email = String(options.adminEmail ?? "").trim();
  const name = String(options.adminName ?? "").trim();
  const password = String(options.adminPassword ?? "");
  const branchCode = String(options.branchCode ?? "")
    .trim()
    .toUpperCase();
  const branchName = String(options.branchName ?? "").trim();

  if (!EMAIL.test(email) || email.length > 255) {
    throw new Error("ADMIN_EMAIL must be a valid email address");
  }

  if (name === "" || name.length > 255) {
    throw new Error("ADMIN_NAME is required (up to 255 characters)");
  }

  if (password.length < MIN_PASSWORD) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters`);
  }

  if (!BRANCH_CODE.test(branchCode)) {
    throw new Error("BRANCH_CODE must be 2 to 20 letters, digits or dashes");
  }

  if (branchName === "" || branchName.length > 255) {
    throw new Error("BRANCH_NAME is required (up to 255 characters)");
  }

  return { email, name, password, branchCode, branchName };
}

/**
 * Creates what is missing (see the header). Options: adminEmail, adminName, adminPassword, branchCode,
 * branchName, log. Throws before writing anything when an option is invalid.
 */
export async function runBootstrap(options) {
  const { email, name, password, branchCode, branchName } = checkOptions(options);
  const log = options.log ?? console.log;
  const passwordHash = await hashPassword(password);

  await db.transaction(async (tx) => {
    // permissions and roles
    const havePermissions = new Map(
      (await tx.select().from(permissions)).map((row) => {
        return [row.name, row.id];
      }),
    );

    for (const permission of Object.values(PERMISSIONS)) {
      if (!havePermissions.has(permission)) {
        const id = randomUUID();

        await tx.insert(permissions).values({ id, name: permission, description: permission });
        havePermissions.set(permission, id);
      }
    }

    const haveRoles = new Map(
      (await tx.select().from(roles)).map((row) => {
        return [row.name, row.id];
      }),
    );

    for (const role of Object.keys(ROLE_PERMISSIONS)) {
      if (!haveRoles.has(role)) {
        const id = randomUUID();

        await tx.insert(roles).values({ id, name: role, description: ROLE_DESCRIPTIONS[role] });
        haveRoles.set(role, id);
      }
    }

    const links = new Set(
      (await tx.select().from(rolePermissions)).map((row) => {
        return `${row.roleId}:${row.permissionId}`;
      }),
    );
    const missing = [];

    for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
      for (const permission of granted) {
        const link = { roleId: haveRoles.get(role), permissionId: havePermissions.get(permission) };

        if (!links.has(`${link.roleId}:${link.permissionId}`)) {
          missing.push(link);
        }
      }
    }

    if (missing.length > 0) {
      await tx.insert(rolePermissions).values(missing);
    }

    // the branch and its register
    let [branch] = await tx.select().from(branches).where(eq(branches.code, branchCode));

    if (!branch) {
      branch = { id: randomUUID(), code: branchCode, name: branchName };
      await tx.insert(branches).values(branch);
      await tx.insert(cashRegisters).values({
        id: randomUUID(),
        branchId: branch.id,
        name: "Counter 1",
        registerCode: "R1",
      });
      log(`Created branch ${branchCode}`);
    }

    // the admin account
    let [admin] = await tx.select().from(users).where(eq(users.email, email));

    if (!admin) {
      admin = { id: randomUUID(), branchId: branch.id, name, email, password: passwordHash };
      await tx.insert(users).values(admin);
      log(`Created admin ${email}`);
    } else if (admin.branchId === null) {
      await tx.update(users).set({ branchId: branch.id }).where(eq(users.id, admin.id));
    }

    const adminRoleId = haveRoles.get("admin");
    const [granted] = await tx
      .select()
      .from(userRoles)
      .where(eq(userRoles.userId, admin.id))
      .then((rows) => {
        return rows.filter((row) => {
          return row.roleId === adminRoleId;
        });
      });

    if (!granted) {
      await tx.insert(userRoles).values({ userId: admin.id, roleId: adminRoleId });
      log(`Granted the admin role to ${email}`);
    }
  });

  log("Bootstrap complete: permissions and roles are up to date.");
}

// `node database/seed/bootstrap.js` runs it from the environment; importing this file does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runBootstrap({
      adminEmail: process.env.ADMIN_EMAIL,
      adminName: process.env.ADMIN_NAME,
      adminPassword: process.env.ADMIN_PASSWORD,
      branchCode: process.env.BRANCH_CODE || "MAIN",
      branchName: process.env.BRANCH_NAME || "Main Branch",
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
